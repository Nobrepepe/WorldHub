import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { domainError } from './errors.js';
import { nowIso, inTransaction } from './database-service.js';
import { resolveInsideNoSymlink } from './paths.js';
import { recordActivity } from './activity-service.js';
import { stableJson } from './stable-json.js';
import { getProduction, validateProduction, setKey } from './production-service.js';
import { generateRendition } from './asset-service.js';
import { writeFileAtomic } from './atomic-file.js';
import { PACKAGE_FORMAT, PROTOCOL_VERSION } from './versions.js';
import { vocabularyVersion, renamedFrom } from './vocabulary.js';
import { logError, logInfo } from './log-service.js';

/**
 * One publication engine implementing World Hub Package Protocol 1.
 * A publication is an immutable, self-contained directory snapshot.
 * Failure never changes the active pointer.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_SCHEMA_PATH = path.join(__dirname, '..', '..', 'schemas', 'package-manifest.schema.json');

let manifestValidator = null;
function getManifestValidator() {
  if (!manifestValidator) {
    const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false });
    manifestValidator = ajv.compile(JSON.parse(fs.readFileSync(MANIFEST_SCHEMA_PATH, 'utf8')));
  }
  return manifestValidator;
}

function sha256File(absPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

/* ---------------- snapshot resolution ---------------- */

/**
 * Walk contract-defined values and collect every entityRef and assetRef
 * they hold, recursing through list fields. Generic: works for any
 * contract, so packages stay self-contained without app-specific code.
 */
export function collectValueReferences(defs, values, found = { entityIds: [], assetRefs: [] }) {
  for (const def of defs ?? []) {
    collectFromValue(def, values?.[def.id], found);
  }
  return found;
}

function collectFromValue(def, value, found) {
  if (value === undefined || value === null) return;
  if (def.type === 'entityRef' && typeof value === 'string') {
    found.entityIds.push(value);
  } else if (def.type === 'assetRef' && typeof value === 'string') {
    found.assetRefs.push({ assetId: value, recipes: (def.recipes && def.recipes.length > 0) ? def.recipes : ['original'] });
  } else if (def.type === 'list' && Array.isArray(value)) {
    for (const entry of value) {
      if (def.fields) {
        for (const sub of def.fields) collectFromValue(sub, entry?.[sub.id], found);
      } else if (def.item) {
        collectFromValue(def.item, entry, found);
      }
    }
  }
}

/**
 * Resolve everything a publication will contain, at exact revisions
 * and exact asset versions. Pure read; used by preview and publish.
 */
export function resolveSnapshot(library, productionId) {
  const db = library.db;
  const production = getProduction(library, productionId);
  const contract = production.contract;

  /* entities: selections + production world + parent worlds */
  const entityIds = new Set();
  if (production.world) entityIds.add(production.world.id);
  for (const selection of contract.entitySelections ?? []) {
    for (const entity of production.selections[selection.id] ?? []) entityIds.add(entity.id);
  }

  /* references held in contract-defined values also ship in the package */
  const valueRefs = { entityIds: [], assetRefs: [] };
  collectValueReferences(contract.productionFields, production.values, valueRefs);
  for (const selection of contract.entitySelections ?? []) {
    for (const entity of production.selections[selection.id] ?? []) {
      collectValueReferences(selection.fields, production.entityValues[entity.id], valueRefs);
    }
    for (const set of selection.assetSets ?? []) {
      for (const entity of production.selections[selection.id] ?? []) {
        for (const item of production.assetSets[setKey(set.id, entity.id)] ?? []) {
          collectValueReferences(set.itemFields, item.values, valueRefs);
        }
      }
    }
  }
  for (const set of contract.assetSets ?? []) {
    for (const item of production.assetSets[setKey(set.id)] ?? []) {
      collectValueReferences(set.itemFields, item.values, valueRefs);
    }
  }
  for (const refId of valueRefs.entityIds) {
    if (db.prepare('SELECT id FROM entities WHERE id = ?').get(refId)) entityIds.add(refId);
  }

  for (const id of [...entityIds]) {
    const row = db.prepare('SELECT world_id FROM entities WHERE id = ?').get(id);
    if (row?.world_id) entityIds.add(row.world_id);
  }

  const entities = [...entityIds].map((id) => {
    const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
    if (!row) throw domainError('publish.entity_missing', 'A selected record no longer exists.');
    const aliases = db.prepare('SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY position').all(id).map((r) => r.alias);
    const tags = db.prepare(`
      SELECT t.name FROM taggings g JOIN tags t ON t.id = g.tag_id
      WHERE g.subject_type = 'entity' AND g.subject_id = ?
      ORDER BY t.name
    `).all(id).map((r) => r.name);
    return { row, aliases, tags };
  }).sort((a, b) => a.row.id.localeCompare(b.row.id));

  /* non-archived connections fully inside the included set */
  const connections = db.prepare(`
    SELECT c.*, k.category, k.forward_label, k.inverse_label
    FROM connections c JOIN connection_kinds k ON k.id = c.kind_id
    WHERE c.status != 'archived' ORDER BY c.id
  `).all().filter((row) => entityIds.has(row.source_id) && entityIds.has(row.target_id));

  /* The definitions of every kind the package uses, plus any the contract
     names but nothing in this snapshot happens to use — a consumer reading
     a contract that mentions `member_of` should find out what `member_of`
     means from the package rather than from its own source code. A custom
     kind travels the same way as a built-in one, so a setting-specific fact
     needs no consumer change at all. */
  const usedKindIds = new Set(connections.map((connection) => connection.kind_id));
  for (const selection of contract.connectionSelections ?? []) {
    for (const kindId of selection.kinds ?? []) usedKindIds.add(kindId);
  }
  const connectionKinds = [...usedKindIds].sort().map((kindId) => {
    const kind = db.prepare('SELECT * FROM connection_kinds WHERE id = ?').get(kindId);
    if (!kind) return null;
    return {
      id: kind.id,
      category: kind.category,
      forwardLabel: kind.forward_label,
      inverseLabel: kind.inverse_label,
      forwardSection: kind.forward_section,
      inverseSection: kind.inverse_section,
      symmetric: !!kind.symmetric,
      builtin: !!kind.is_builtin,
      pairs: db.prepare(
        'SELECT source_type, target_type FROM connection_kind_pairs WHERE kind_id = ? ORDER BY source_type, target_type')
        .all(kindId)
        .map((pair) => [pair.source_type, pair.target_type]),
    };
  }).filter(Boolean);

  /* documents by contract mode */
  const documentsMode = contract.documents?.mode ?? 'linked';
  let documents = [];
  if (documentsMode === 'linked') {
    documents = db.prepare(`
      SELECT DISTINCT d.* FROM documents d
      JOIN document_links l ON l.document_id = d.id
      WHERE d.status != 'archived'
      ORDER BY d.id
    `).all().filter((doc) => {
      const links = db.prepare('SELECT entity_id FROM document_links WHERE document_id = ?').all(doc.id);
      return links.some((link) => entityIds.has(link.entity_id));
    });
  } else if (documentsMode === 'selected') {
    const chosen = production.values.__documents__;
    if (Array.isArray(chosen)) {
      documents = chosen
        .map((docId) => db.prepare('SELECT * FROM documents WHERE id = ?').get(docId))
        .filter((doc) => doc && doc.status !== 'archived')
        .sort((a, b) => a.id.localeCompare(b.id));
    }
  }

  /* asset items from every asset set, with exact versions */
  const assetItems = [];
  const addSet = (set, entityId, ownerEntity) => {
    const items = production.assetSets[setKey(set.id, entityId)] ?? [];
    items.forEach((item, index) => {
      const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(item.assetId);
      if (!asset || !asset.current_version_id) {
        throw domainError('publish.asset_missing', 'A chosen asset no longer exists or has no version.');
      }
      const version = db.prepare(`
        SELECT v.*, b.hash, b.mime, b.size, b.width, b.height, b.path AS blob_path, b.ext
        FROM asset_versions v JOIN blobs b ON b.hash = v.blob_hash
        WHERE v.id = ?
      `).get(asset.current_version_id);
      // Export the roles the asset actually holds — never the
      // contract's allowed list. Entity-scoped sets read the roles of
      // that specific link; production-level sets read all links.
      const actualRoles = ownerEntity
        ? db.prepare('SELECT role FROM asset_links WHERE asset_id = ? AND entity_id = ? ORDER BY role').all(item.assetId, ownerEntity).map((r) => r.role)
        : db.prepare('SELECT DISTINCT role FROM asset_links WHERE asset_id = ? ORDER BY role').all(item.assetId).map((r) => r.role);
      const roles = (set.roles && set.roles.length > 0)
        ? actualRoles.filter((role) => set.roles.includes(role))
        : actualRoles;
      assetItems.push({
        setId: set.id,
        roles,
        recipes: (set.recipes && set.recipes.length > 0) ? set.recipes : ['original'],
        entityId: ownerEntity ?? null,
        position: index,
        values: item.values ?? {},
        asset,
        version,
      });
    });
  };
  for (const selection of contract.entitySelections ?? []) {
    for (const set of selection.assetSets ?? []) {
      for (const entity of production.selections[selection.id] ?? []) {
        addSet(set, entity.id, entity.id);
      }
    }
  }
  for (const set of contract.assetSets ?? []) addSet(set, '', null);

  /* assets referenced by contract-defined values (packs, relic art, …) */
  const coveredPairs = new Set(assetItems.flatMap((item) => item.recipes.map((recipeId) => `${item.asset.id}:${recipeId}`)));
  const fieldAssetRecipes = new Map();
  for (const ref of valueRefs.assetRefs) {
    for (const recipeId of ref.recipes) {
      const pairKey = `${ref.assetId}:${recipeId}`;
      if (coveredPairs.has(pairKey)) continue;
      coveredPairs.add(pairKey);
      if (!fieldAssetRecipes.has(ref.assetId)) fieldAssetRecipes.set(ref.assetId, new Set());
      fieldAssetRecipes.get(ref.assetId).add(recipeId);
    }
  }
  for (const [assetId, recipeSet] of fieldAssetRecipes) {
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
    if (!asset || !asset.current_version_id) {
      throw domainError('publish.asset_missing', 'A value-referenced asset no longer exists or has no version.');
    }
    const version = db.prepare(`
      SELECT v.*, b.hash, b.mime, b.size, b.width, b.height, b.path AS blob_path, b.ext
      FROM asset_versions v JOIN blobs b ON b.hash = v.blob_hash
      WHERE v.id = ?
    `).get(asset.current_version_id);
    const roles = db.prepare('SELECT DISTINCT role FROM asset_links WHERE asset_id = ? ORDER BY role').all(assetId).map((r) => r.role);
    assetItems.push({
      setId: 'fields',
      roles,
      recipes: [...recipeSet].sort(),
      entityId: null,
      position: 0,
      values: {},
      asset,
      version,
    });
  }

  assetItems.sort((a, b) =>
    a.setId.localeCompare(b.setId) || String(a.entityId).localeCompare(String(b.entityId)) || a.position - b.position);

  /* tags used anywhere in the snapshot */
  const tagNames = new Set();
  for (const entity of entities) for (const tag of entity.tags) tagNames.add(tag);
  const tags = [...tagNames].sort().map((name) => {
    const row = db.prepare('SELECT * FROM tags WHERE name = ?').get(name);
    return { id: row.id, name: row.name, group: row.group_name };
  });

  return { production, contract, entities, connections, connectionKinds, documents, assetItems, tags, documentsMode };
}

/* ---------------- preview ---------------- */

export async function previewPublication(library, productionId) {
  const validation = validateProduction(library, productionId);
  let snapshot = null;
  let error = null;
  try {
    snapshot = resolveSnapshot(library, productionId);
  } catch (err) {
    error = err.message;
  }
  if (!snapshot) {
    return { validation, error, records: null, diff: null, estimatedBytes: 0, renditionsToGenerate: 0 };
  }
  const db = library.db;

  /* renditions still to generate */
  let renditionsToGenerate = 0;
  let estimatedBytes = 0;
  const files = [];
  for (const item of snapshot.assetItems) {
    for (const recipeId of item.recipes) {
      if (recipeId === 'original') {
        estimatedBytes += item.version.size;
        files.push(`${item.asset.id}/${recipeId}`);
        continue;
      }
      const existing = db.prepare(`
        SELECT g.* FROM generated_renditions g WHERE g.version_id = ? AND g.recipe_id = ?
      `).get(item.version.id, recipeId);
      if (existing && fs.existsSync(resolveInsideNoSymlink(library.root, existing.path))) {
        estimatedBytes += existing.size;
      } else {
        renditionsToGenerate++;
        estimatedBytes += Math.round(item.version.size / 3); // rough guess, stated as such in the UI
      }
      files.push(`${item.asset.id}/${recipeId}`);
    }
  }
  for (const doc of snapshot.documents) {
    estimatedBytes += Buffer.byteLength(doc.content_cache ?? '', 'utf8');
  }

  /* diff against the current publication: records, documents, exact
     asset versions, and the contract itself */
  const current = readCurrentPointer(library, snapshot.production.slug);
  let diff = null;
  if (current) {
    try {
      const packageDir = `productions/${snapshot.production.slug}/publications/${current.publicationId}`;
      const readSection = (rel) => JSON.parse(fs.readFileSync(resolveInsideNoSymlink(library.root, `${packageDir}/${rel}`), 'utf8'));
      const manifest = readSection('manifest.json');

      const oldEntities = new Map(manifest.entities.map((entry) => [entry.id, entry.revision]));
      const added = [];
      const changed = [];
      for (const entity of snapshot.entities) {
        if (!oldEntities.has(entity.row.id)) added.push(entity.row.name);
        else if (oldEntities.get(entity.row.id) !== entity.row.revision) changed.push(entity.row.name);
        oldEntities.delete(entity.row.id);
      }
      const removed = [...oldEntities.keys()].map((entityId) =>
        db.prepare('SELECT name FROM entities WHERE id = ?').get(entityId)?.name ?? entityId);

      /* documents by id + revision */
      const oldDocs = new Map(readSection('catalog/documents.json').map((doc) => [doc.id, doc]));
      const docDiff = { added: [], changed: [], removed: [] };
      for (const doc of snapshot.documents) {
        if (!oldDocs.has(doc.id)) docDiff.added.push(doc.title);
        else if (oldDocs.get(doc.id).revision !== doc.revision) docDiff.changed.push(doc.title);
        oldDocs.delete(doc.id);
      }
      docDiff.removed = [...oldDocs.values()].map((doc) => doc.title);

      /* assets by id → exact version */
      const oldAssets = new Map();
      for (const entry of readSection('assets/index.json')) {
        if (!oldAssets.has(entry.assetId)) oldAssets.set(entry.assetId, { title: entry.assetTitle, versions: new Set() });
        oldAssets.get(entry.assetId).versions.add(entry.versionId);
      }
      const newAssets = new Map();
      for (const item of snapshot.assetItems) {
        if (!newAssets.has(item.asset.id)) newAssets.set(item.asset.id, { title: item.asset.title, versions: new Set() });
        newAssets.get(item.asset.id).versions.add(item.version.id);
      }
      const assetDiff = { added: [], changed: [], removed: [] };
      for (const [assetId, next] of newAssets) {
        const previous = oldAssets.get(assetId);
        if (!previous) assetDiff.added.push(next.title);
        else if ([...next.versions].some((versionId) => !previous.versions.has(versionId))) assetDiff.changed.push(`${next.title} (new version)`);
        oldAssets.delete(assetId);
      }
      assetDiff.removed = [...oldAssets.values()].map((asset) => asset.title);

      diff = {
        added,
        changed,
        removed,
        documents: docDiff,
        assets: assetDiff,
        contractChanged: manifest.contract.version !== snapshot.production.contractVersion,
        productionRevisionChanged: manifest.production.revision !== snapshot.production.revision,
        previousPublishedAt: manifest.publishedAt,
      };
    } catch (err) {
      diff = { error: `The current publication could not be read: ${err.message}` };
    }
  }

  return {
    validation,
    error: null,
    records: {
      entities: snapshot.entities.map((entity) => ({ id: entity.row.id, name: entity.row.name, type: entity.row.type, revision: entity.row.revision, status: entity.row.status })),
      documents: snapshot.documents.map((doc) => ({ id: doc.id, title: doc.title, revision: doc.revision })),
      assets: snapshot.assetItems.map((item) => ({
        assetId: item.asset.id, title: item.asset.title, versionId: item.version.id,
        setId: item.setId, recipes: item.recipes,
      })),
      connections: snapshot.connections.length,
      documentsMode: snapshot.documentsMode,
      fileCount: files.length + snapshot.documents.length + 10,
    },
    renditionsToGenerate,
    estimatedBytes,
    diff,
  };
}

/* ---------------- publish ---------------- */

export async function publishProduction(library, productionId) {
  const db = library.db;

  /* 1. flush pending edits */
  for (const hook of library.flushHooks) {
    await hook();
  }

  /* 2. validate */
  const validation = validateProduction(library, productionId);
  if (validation.errors > 0) {
    throw domainError('publish.invalid', `The production has ${validation.errors} validation error(s). The current publication stays active.`, { issues: validation.issues });
  }

  /* 3. resolve exact revisions and versions */
  const snapshot = resolveSnapshot(library, productionId);

  /* A contract states the package protocols its application can read. That
     declaration was never checked, so nothing stopped a package going out in
     a format the app on the other side would refuse. It is checked here,
     where the author can still do something about it. */
  const readable = snapshot.contract.supportedProtocolVersions ?? [1];
  if (!readable.includes(PROTOCOL_VERSION)) {
    throw domainError('publish.protocol_unsupported',
      `${snapshot.contract.name} declares it can read World Hub package protocol ${readable.join(', ')}, but this library publishes protocol ${PROTOCOL_VERSION}. Update the application and its contract before publishing.`,
      { supportedProtocolVersions: readable, protocolVersion: PROTOCOL_VERSION });
  }
  const publicationId = crypto.randomUUID();
  const slug = snapshot.production.slug;
  const publishedAt = nowIso();

  const tmpRel = `tmp/publish-${publicationId}`;
  const tmpAbs = resolveInsideNoSymlink(library.root, tmpRel);

  const finalRel = `productions/${slug}/publications/${publicationId}`;
  const finalAbs = resolveInsideNoSymlink(library.root, finalRel);
  let movedToFinal = false;

  try {
    /* 4-5. generate renditions and assemble in tmp */
    const assembly = await assemblePackage(library, snapshot, publicationId, publishedAt, tmpAbs);

    /* 6. verify the assembled copy */
    verifyAssembledPackage(tmpAbs, assembly);

    /* 7. move into the immutable publication directory */
    fs.mkdirSync(path.dirname(finalAbs), { recursive: true });
    fs.renameSync(tmpAbs, finalAbs);
    movedToFinal = true;

    /* 8. record rows — before the pointer moves, so the database and
       the pointer can never disagree about what is active. */
    const previousCurrentId = db.prepare('SELECT id FROM publications WHERE production_id = ? AND is_current = 1')
      .get(productionId)?.id ?? null;
    inTransaction(db, () => {
      db.prepare('UPDATE publications SET is_current = 0 WHERE production_id = ?').run(productionId);
      db.prepare(`
        INSERT INTO publications (id, production_id, production_revision, contract_id, contract_version, manifest_path, package_size, file_count, entity_count, is_current, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(publicationId, productionId, snapshot.production.revision, snapshot.production.contractId,
        snapshot.production.contractVersion, `${finalRel}/manifest.json`, assembly.totalBytes,
        assembly.files.length, snapshot.entities.length, publishedAt);
      const insertFile = db.prepare('INSERT INTO publication_files (publication_id, path, size, checksum) VALUES (?, ?, ?, ?)');
      for (const file of assembly.files) {
        insertFile.run(publicationId, file.path, file.size, file.checksum);
      }
      recordActivity(db, 'publication.created', 'publication', publicationId, `${snapshot.production.name} → ${assembly.files.length} files`);
    });

    /* 9. atomically replace current.json — the last step, so the
       pointer only ever names a fully recorded publication. If this
       write fails, the database rows are compensated away. */
    try {
      const pointerAbs = resolveInsideNoSymlink(library.root, `productions/${slug}/current.json`);
      writeFileAtomic(pointerAbs, stableJson({
        format: 'world-hub-current-publication',
        publicationId,
        manifestPath: `publications/${publicationId}/manifest.json`,
        updatedAt: publishedAt,
      }));
    } catch (pointerErr) {
      inTransaction(db, () => {
        db.prepare('DELETE FROM publication_files WHERE publication_id = ?').run(publicationId);
        db.prepare('DELETE FROM publications WHERE id = ?').run(publicationId);
        if (previousCurrentId) db.prepare('UPDATE publications SET is_current = 1 WHERE id = ?').run(previousCurrentId);
      });
      throw pointerErr;
    }

    logInfo('publish', `Published ${slug}/${publicationId} (${assembly.files.length} files)`);
    return getPublication(library, publicationId);
  } catch (err) {
    /* failure: current.json untouched; remove the unreferenced package
       directory or the incomplete work area */
    try {
      fs.rmSync(movedToFinal ? finalAbs : tmpAbs, { recursive: true, force: true });
    } catch (cleanupErr) {
      logError('publish.cleanup', cleanupErr);
    }
    logError('publish', err);
    throw err;
  }
}

/** Build every package file inside workAbs. Returns the file table. */
async function assemblePackage(library, snapshot, publicationId, publishedAt, workAbs) {
  const db = library.db;
  fs.rmSync(workAbs, { recursive: true, force: true });
  fs.mkdirSync(workAbs, { recursive: true });

  const files = [];
  const writePackageFile = (relPath, data) => {
    const abs = path.join(workAbs, ...relPath.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    files.push({
      path: relPath,
      size: Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data, 'utf8'),
      checksum: crypto.createHash('sha256').update(data).digest('hex'),
    });
  };

  /* catalog */
  const entitiesJson = snapshot.entities.map(({ row, aliases, tags }) => ({
    id: row.id,
    type: row.type,
    worldId: row.world_id,
    name: row.name,
    slug: row.slug,
    summary: row.summary,
    status: row.status,
    sortOrder: row.sort_order,
    revision: row.revision,
    aliases,
    tags,
  }));
  writePackageFile('catalog/entities.json', stableJson(entitiesJson));

  /* A package must be self-contained: profile art references are kept
     only when that asset ships in this package, and document links are
     kept only for entities the package includes. */
  const includedEntityIds = new Set(snapshot.entities.map(({ row }) => row.id));
  const includedAssetIds = new Set(snapshot.assetItems.map((item) => item.asset.id));
  const packagedAssetId = (assetId) => (assetId && includedAssetIds.has(assetId) ? assetId : null);

  const worldsJson = snapshot.entities
    .filter(({ row }) => row.type === 'world')
    .map(({ row }) => {
      const profile = db.prepare('SELECT * FROM world_profiles WHERE entity_id = ?').get(row.id) ?? {};
      return {
        id: row.id,
        tagline: profile.tagline ?? '',
        genre: profile.genre ?? '',
        tone: profile.tone ?? '',
        settingDescription: profile.setting_description ?? '',
        visualDirection: profile.visual_direction ?? '',
        coverAssetId: packagedAssetId(profile.cover_asset_id),
        backgroundAssetId: packagedAssetId(profile.background_asset_id),
      };
    });
  writePackageFile('catalog/worlds.json', stableJson(worldsJson));

  const charactersJson = snapshot.entities
    .filter(({ row }) => row.type === 'character')
    .map(({ row }) => {
      const profile = db.prepare('SELECT * FROM character_profiles WHERE entity_id = ?').get(row.id) ?? {};
      return {
        id: row.id,
        role: profile.role ?? '',
        age: profile.age_text ?? '',
        appearance: profile.appearance ?? '',
        personality: profile.personality ?? '',
        biography: profile.biography ?? '',
        voice: profile.voice ?? '',
        portraitAssetId: packagedAssetId(profile.portrait_asset_id),
        tileAssetId: packagedAssetId(profile.tile_asset_id),
      };
    });
  writePackageFile('catalog/characters.json', stableJson(charactersJson));

  /* The published file keeps its Protocol 1 name and every field a consumer
     already reads. `type`, `label` and `inverseLabel` are still populated —
     resolved from the kind now rather than retyped per record — so a reader
     vendored before connections existed sees exactly what it saw before. */
  writePackageFile('catalog/relationships.json', stableJson(snapshot.connections.map((connection) => ({
    id: connection.id,
    sourceId: connection.source_id,
    targetId: connection.target_id,
    type: connection.kind_id,
    label: connection.label_override || connection.forward_label,
    inverseLabel: connection.inverse_label_override || connection.inverse_label,
    description: connection.description,
    position: connection.position,
    /* Added, never substituted. `kindId` is the stable machine name and
       `type` carries the same string, so a reader vendored before any of
       this existed reads exactly what it read before. */
    kindId: connection.kind_id,
    category: connection.category,
  }))));

  writePackageFile('catalog/connection-kinds.json', stableJson(snapshot.connectionKinds));

  writePackageFile('catalog/tags.json', stableJson(snapshot.tags));

  /* documents */
  const documentsJson = [];
  for (const doc of snapshot.documents) {
    const sourceAbs = resolveInsideNoSymlink(library.root, doc.path);
    const content = fs.existsSync(sourceAbs) ? fs.readFileSync(sourceAbs) : Buffer.from(doc.content_cache, 'utf8');
    const packagePath = `documents/${doc.id}.md`;
    writePackageFile(packagePath, content);
    const links = db.prepare('SELECT entity_id FROM document_links WHERE document_id = ? ORDER BY position').all(doc.id)
      .map((link) => link.entity_id)
      .filter((entityId) => includedEntityIds.has(entityId));
    documentsJson.push({
      id: doc.id,
      title: doc.title,
      path: packagePath,
      status: doc.status,
      revision: doc.revision,
      wordCount: doc.word_count,
      checksum: crypto.createHash('sha256').update(content).digest('hex'),
      entityIds: links,
    });
  }
  writePackageFile('catalog/documents.json', stableJson(documentsJson));

  /* assets: generate renditions, copy bytes, build the index */
  const assetIndex = [];
  const writtenFiles = new Set();
  for (const item of snapshot.assetItems) {
    for (const recipeId of item.recipes) {
      let sourceAbs;
      let mime;
      let width = null;
      let height = null;
      let ext;
      if (recipeId === 'original') {
        sourceAbs = resolveInsideNoSymlink(library.root, item.version.blob_path);
        mime = item.version.mime;
        width = item.version.width;
        height = item.version.height;
        ext = item.version.ext;
      } else {
        const rendition = await generateRendition(library, item.version.id, recipeId);
        sourceAbs = resolveInsideNoSymlink(library.root, rendition.path);
        mime = rendition.mime;
        width = rendition.width;
        height = rendition.height;
        ext = 'webp';
      }
      const packagePath = `assets/files/${item.asset.id}/${item.version.id}-${recipeId}.${ext}`;
      if (!writtenFiles.has(packagePath)) {
        writePackageFile(packagePath, fs.readFileSync(sourceAbs));
        writtenFiles.add(packagePath);
      }
      assetIndex.push({
        assetId: item.asset.id,
        assetTitle: item.asset.title,
        versionId: item.version.id,
        blobChecksum: item.version.hash,
        setId: item.setId,
        entityId: item.entityId,
        roles: item.roles,
        recipeId,
        mime,
        width,
        height,
        position: item.position,
        path: packagePath,
      });
    }
  }
  writePackageFile('assets/index.json', stableJson(assetIndex));

  /* production content */
  const production = snapshot.production;
  writePackageFile('production/contract.json', stableJson(snapshot.contract));
  /* Export only live production data: per-entity values and asset sets
     belonging to entities that are still selected. Rows kept in the
     database for deselected entities (so re-adding restores them) must
     not leak into the package, where their targets are not included. */
  const selectedIds = new Set(Object.values(production.selections).flat().map((entity) => entity.id));
  const productionSetIds = new Set((snapshot.contract.assetSets ?? []).map((set) => set.id));
  const liveEntityValues = Object.fromEntries(
    Object.entries(production.entityValues).filter(([entityId]) => selectedIds.has(entityId)));
  const liveAssetSets = Object.fromEntries(
    Object.entries(production.assetSets).filter(([key]) => {
      const colon = key.indexOf(':');
      if (colon === -1) return productionSetIds.has(key);
      return selectedIds.has(key.slice(colon + 1));
    }));

  writePackageFile('production/content.json', stableJson({
    id: production.id,
    name: production.name,
    slug: production.slug,
    revision: production.revision,
    worldId: production.world?.id ?? null,
    values: production.values,
    entityValues: liveEntityValues,
    selections: Object.fromEntries(Object.entries(production.selections).map(([slot, list]) => [
      slot, list.map((entity) => entity.id),
    ])),
    assetSets: Object.fromEntries(Object.entries(liveAssetSets).map(([key, list]) => [
      key, list.map((item) => ({ assetId: item.assetId, values: item.values })),
    ])),
  }));

  /* manifest */
  const manifest = {
    format: PACKAGE_FORMAT,
    protocolVersion: PROTOCOL_VERSION,
    publicationId,
    production: {
      id: production.id,
      name: production.name,
      slug: production.slug,
      revision: production.revision,
    },
    applicationType: snapshot.contract.appType,
    /* `revision` counts edits to the contract record in this library. It is a
       receipt, not a compatibility signal — a consumer records it and gates on
       the embedded contract's `contractFormatVersion` instead. */
    contract: { id: production.contractId, revision: production.contractVersion },
    /* The role and recipe vocabulary these files were named under. A consumer
       built against an older vocabulary refuses the package outright rather
       than resolving art by a name that has since moved. */
    vocabularyVersion: vocabularyVersion(),
    renamedFrom: renamedFrom(),
    sourceLibraryId: library.descriptor.libraryId,
    publishedAt,
    entities: snapshot.entities.map(({ row }) => ({ id: row.id, type: row.type, revision: row.revision })),
    sections: {
      catalog: 'catalog',
      production: 'production',
      documents: 'documents',
      assets: 'assets',
      checksums: 'checksums.json',
    },
    counts: {
      entities: snapshot.entities.length,
      documents: snapshot.documents.length,
      assets: new Set(snapshot.assetItems.map((item) => item.asset.id)).size,
      connections: snapshot.connections.length,
      connectionKinds: snapshot.connectionKinds.length,
      files: files.length + 2, // + manifest + checksums
    },
    complete: true,
  };
  writePackageFile('manifest.json', stableJson(manifest));

  /* checksums cover every other file */
  const checksums = {};
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    checksums[file.path] = file.checksum;
  }
  writePackageFile('checksums.json', stableJson(checksums));

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  return { files, totalBytes, manifest };
}

/** The connection kinds the packaged contract's selections name. */
function packagedContractKinds(workAbs) {
  const contract = JSON.parse(fs.readFileSync(path.join(workAbs, 'production', 'contract.json'), 'utf8'));
  return (contract.connectionSelections ?? []).flatMap((selection) => selection.kinds ?? []);
}

/** Verify schemas, references, existence, sizes, and checksums from the assembled copy. */
function verifyAssembledPackage(workAbs, assembly) {
  const manifestAbs = path.join(workAbs, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestAbs, 'utf8'));
  const validate = getManifestValidator();
  if (!validate(manifest)) {
    throw domainError('publish.manifest_invalid', 'The assembled manifest failed schema validation.', { errors: validate.errors });
  }

  const checksums = JSON.parse(fs.readFileSync(path.join(workAbs, 'checksums.json'), 'utf8'));
  for (const [relPath, expected] of Object.entries(checksums)) {
    const abs = path.join(workAbs, ...relPath.split('/'));
    if (!fs.existsSync(abs)) {
      throw domainError('publish.file_missing', `The assembled package is missing ${relPath}.`);
    }
    const actual = sha256File(abs);
    if (actual !== expected) {
      throw domainError('publish.checksum_mismatch', `Checksum mismatch in the assembled package: ${relPath}.`);
    }
  }

  /* every file in the tree is accounted for */
  const walk = (dir, prefix = '') => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
      else out.push(rel);
    }
    return out;
  };
  const allFiles = walk(workAbs);
  for (const rel of allFiles) {
    if (rel === 'checksums.json') continue;
    if (!(rel in checksums)) {
      throw domainError('publish.unlisted_file', `The assembled package contains an unlisted file: ${rel}.`);
    }
  }

  /* asset index references resolve to package files */
  const assetIndex = JSON.parse(fs.readFileSync(path.join(workAbs, 'assets', 'index.json'), 'utf8'));
  for (const entry of assetIndex) {
    if (!fs.existsSync(path.join(workAbs, ...entry.path.split('/')))) {
      throw domainError('publish.asset_file_missing', `assets/index.json points at a missing file: ${entry.path}.`);
    }
  }

  /* catalog references resolve */
  const entities = JSON.parse(fs.readFileSync(path.join(workAbs, 'catalog', 'entities.json'), 'utf8'));
  const entityIds = new Set(entities.map((entity) => entity.id));
  const relationships = JSON.parse(fs.readFileSync(path.join(workAbs, 'catalog', 'relationships.json'), 'utf8'));
  const connectionKinds = JSON.parse(fs.readFileSync(path.join(workAbs, 'catalog', 'connection-kinds.json'), 'utf8'));
  const kindIds = new Set(connectionKinds.map((kind) => kind.id));
  for (const rel of relationships) {
    if (!entityIds.has(rel.sourceId) || !entityIds.has(rel.targetId)) {
      throw domainError('publish.relationship_dangling', 'A packaged relationship references a record outside the package.');
    }
    /* A connection whose kind did not ship would reach the consumer as a
       label it has no way to read — self-containment applies to meaning as
       much as to bytes. */
    if (!kindIds.has(rel.kindId)) {
      throw domainError('publish.connection_kind_missing',
        'A packaged connection names a kind whose definition is not in the package.');
    }
  }
  /* Every kind a contract's connection selections name has to be there too,
     or the application would be reading a contract clause about nothing. */
  for (const selection of packagedContractKinds(workAbs)) {
    if (!kindIds.has(selection)) {
      throw domainError('publish.connection_kind_missing',
        `The contract asks for the connection kind "${selection}", which is not in the package.`);
    }
  }

  /* profile art references resolve within the packaged assets */
  const packagedAssetIds = new Set(assetIndex.map((entry) => entry.assetId));
  const worlds = JSON.parse(fs.readFileSync(path.join(workAbs, 'catalog', 'worlds.json'), 'utf8'));
  for (const world of worlds) {
    for (const ref of [world.coverAssetId, world.backgroundAssetId]) {
      if (ref && !packagedAssetIds.has(ref)) {
        throw domainError('publish.profile_asset_dangling', 'A world profile references an asset outside the package.');
      }
    }
  }
  const characters = JSON.parse(fs.readFileSync(path.join(workAbs, 'catalog', 'characters.json'), 'utf8'));
  for (const character of characters) {
    for (const ref of [character.portraitAssetId, character.tileAssetId]) {
      if (ref && !packagedAssetIds.has(ref)) {
        throw domainError('publish.profile_asset_dangling', 'A character profile references an asset outside the package.');
      }
    }
  }

  /* reference-typed production values resolve within the package */
  const packagedContract = JSON.parse(fs.readFileSync(path.join(workAbs, 'production', 'contract.json'), 'utf8'));
  const packagedContent = JSON.parse(fs.readFileSync(path.join(workAbs, 'production', 'content.json'), 'utf8'));
  const contentRefs = { entityIds: [], assetRefs: [] };
  collectValueReferences(packagedContract.productionFields, packagedContent.values, contentRefs);
  for (const selection of packagedContract.entitySelections ?? []) {
    for (const selectedId of packagedContent.selections?.[selection.id] ?? []) {
      collectValueReferences(selection.fields, packagedContent.entityValues?.[selectedId], contentRefs);
      for (const set of selection.assetSets ?? []) {
        for (const item of packagedContent.assetSets?.[`${set.id}:${selectedId}`] ?? []) {
          collectValueReferences(set.itemFields, item.values, contentRefs);
        }
      }
    }
  }
  for (const set of packagedContract.assetSets ?? []) {
    for (const item of packagedContent.assetSets?.[set.id] ?? []) {
      collectValueReferences(set.itemFields, item.values, contentRefs);
    }
  }
  for (const refId of contentRefs.entityIds) {
    if (!entityIds.has(refId)) {
      throw domainError('publish.value_entity_dangling', 'A production value references a record outside the package.');
    }
  }
  for (const ref of contentRefs.assetRefs) {
    if (!packagedAssetIds.has(ref.assetId)) {
      throw domainError('publish.value_asset_dangling', 'A production value references an asset outside the package.');
    }
  }
  for (const itemsList of Object.values(packagedContent.assetSets ?? {})) {
    for (const item of itemsList) {
      if (!packagedAssetIds.has(item.assetId)) {
        throw domainError('publish.set_asset_dangling', 'A packaged asset set references an asset outside the package.');
      }
    }
  }
  for (const entityId of Object.keys(packagedContent.entityValues ?? {})) {
    if (!entityIds.has(entityId)) {
      throw domainError('publish.entity_values_dangling', 'Packaged per-record values reference a record outside the package.');
    }
  }

  /* document links resolve within the packaged entities */
  const documents = JSON.parse(fs.readFileSync(path.join(workAbs, 'catalog', 'documents.json'), 'utf8'));
  for (const doc of documents) {
    for (const entityId of doc.entityIds ?? []) {
      if (!entityIds.has(entityId)) {
        throw domainError('publish.document_link_dangling', 'A packaged document references a record outside the package.');
      }
    }
    if (!fs.existsSync(path.join(workAbs, ...doc.path.split('/')))) {
      throw domainError('publish.document_file_missing', `catalog/documents.json points at a missing file: ${doc.path}.`);
    }
  }
  void assembly;
}

/* ---------------- reading publications ---------------- */

export function readCurrentPointer(library, slug) {
  try {
    const abs = resolveInsideNoSymlink(library.root, `productions/${slug}/current.json`);
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}

export function readPublicationManifest(library, slug, publicationId) {
  const abs = resolveInsideNoSymlink(library.root, `productions/${slug}/publications/${publicationId}/manifest.json`);
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

/** Read-only publication view resolving recorded names and checksums. */
export function getPublication(library, publicationId) {
  const db = library.db;
  const row = db.prepare('SELECT * FROM publications WHERE id = ?').get(publicationId);
  if (!row) throw domainError('publication.missing', 'That publication no longer exists.');
  const production = db.prepare('SELECT name, slug FROM productions WHERE id = ?').get(row.production_id);
  let manifest = null;
  let manifestProblem = null;
  try {
    manifest = readPublicationManifest(library, production.slug, publicationId);
  } catch (err) {
    manifestProblem = err.message;
  }
  const files = db.prepare('SELECT path, size, checksum FROM publication_files WHERE publication_id = ? ORDER BY path').all(publicationId);
  return {
    id: row.id,
    productionId: row.production_id,
    productionName: production.name,
    productionSlug: production.slug,
    productionRevision: row.production_revision,
    contractId: row.contract_id,
    contractVersion: row.contract_version,
    createdAt: row.created_at,
    packageSize: row.package_size,
    fileCount: row.file_count,
    entityCount: row.entity_count,
    isCurrent: !!row.is_current,
    directory: `productions/${production.slug}/publications/${publicationId}`,
    manifest,
    manifestProblem,
    files,
  };
}

/** Verify a stored publication's files against recorded checksums. */
export function verifyPublication(library, publicationId) {
  const publication = getPublication(library, publicationId);
  const problems = [];
  for (const file of publication.files) {
    const abs = resolveInsideNoSymlink(library.root, `${publication.directory}/${file.path}`);
    if (!fs.existsSync(abs)) {
      problems.push({ path: file.path, problem: 'missing' });
      continue;
    }
    if (sha256File(abs) !== file.checksum) {
      problems.push({ path: file.path, problem: 'checksum mismatch' });
    }
  }
  return { ok: problems.length === 0, problems };
}

/* ---------------- ZIP export ---------------- */

/**
 * Export the exact same internal package structure and bytes as the
 * folder snapshot. Entries are sorted and timestamps fixed, so the
 * archive itself is deterministic.
 */
export async function exportPublicationZip(library, publicationId, targetAbs) {
  const yazl = await import('yazl');
  const publication = getPublication(library, publicationId);
  const rootAbs = resolveInsideNoSymlink(library.root, publication.directory);

  const collect = (dir, prefix = '') => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...collect(path.join(dir, entry.name), rel));
      else out.push(rel);
    }
    return out;
  };
  const entries = collect(rootAbs);
  const fixedDate = new Date(Date.UTC(2000, 0, 1));

  await new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const rel of entries) {
      zip.addFile(path.join(rootAbs, ...rel.split('/')), rel, { mtime: fixedDate, mode: 0o100644 });
    }
    zip.end();
    const out = fs.createWriteStream(targetAbs);
    zip.outputStream.pipe(out);
    out.on('close', resolve);
    out.on('error', reject);
    zip.outputStream.on('error', reject);
  });
  recordActivity(library.db, 'publication.exported_zip', 'publication', publicationId, path.basename(targetAbs));
  return { path: targetAbs, entries: entries.length };
}
