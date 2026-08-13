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

  /* relationships fully inside the included set */
  const relationships = db.prepare('SELECT * FROM relationships ORDER BY id').all()
    .filter((rel) => entityIds.has(rel.source_id) && entityIds.has(rel.target_id));

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
      assetItems.push({
        setId: set.id,
        roles: set.roles ?? [],
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
  assetItems.sort((a, b) =>
    a.setId.localeCompare(b.setId) || String(a.entityId).localeCompare(String(b.entityId)) || a.position - b.position);

  /* tags used anywhere in the snapshot */
  const tagNames = new Set();
  for (const entity of entities) for (const tag of entity.tags) tagNames.add(tag);
  const tags = [...tagNames].sort().map((name) => {
    const row = db.prepare('SELECT * FROM tags WHERE name = ?').get(name);
    return { id: row.id, name: row.name, group: row.group_name };
  });

  return { production, contract, entities, relationships, documents, assetItems, tags, documentsMode };
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

  /* diff against the current publication */
  const current = readCurrentPointer(library, snapshot.production.slug);
  let diff = null;
  if (current) {
    try {
      const manifest = readPublicationManifest(library, snapshot.production.slug, current.publicationId);
      const oldEntities = new Map(manifest.entities.map((entry) => [entry.id, entry.revision]));
      const added = [];
      const changed = [];
      for (const entity of snapshot.entities) {
        if (!oldEntities.has(entity.row.id)) added.push(entity.row.name);
        else if (oldEntities.get(entity.row.id) !== entity.row.revision) changed.push(entity.row.name);
        oldEntities.delete(entity.row.id);
      }
      const removedIds = [...oldEntities.keys()];
      const removed = removedIds.map((entityId) =>
        db.prepare('SELECT name FROM entities WHERE id = ?').get(entityId)?.name ?? entityId);
      diff = { added, changed, removed, previousPublishedAt: manifest.publishedAt };
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
      relationships: snapshot.relationships.length,
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
  const publicationId = crypto.randomUUID();
  const slug = snapshot.production.slug;
  const publishedAt = nowIso();

  const tmpRel = `tmp/publish-${publicationId}`;
  const tmpAbs = resolveInsideNoSymlink(library.root, tmpRel);

  try {
    /* 4-5. generate renditions and assemble in tmp */
    const assembly = await assemblePackage(library, snapshot, publicationId, publishedAt, tmpAbs);

    /* 6. verify the assembled copy */
    verifyAssembledPackage(tmpAbs, assembly);

    /* 7. move into the immutable publication directory */
    const finalRel = `productions/${slug}/publications/${publicationId}`;
    const finalAbs = resolveInsideNoSymlink(library.root, finalRel);
    fs.mkdirSync(path.dirname(finalAbs), { recursive: true });
    fs.renameSync(tmpAbs, finalAbs);

    /* 8. atomically replace current.json */
    const pointerAbs = resolveInsideNoSymlink(library.root, `productions/${slug}/current.json`);
    writeFileAtomic(pointerAbs, stableJson({
      format: 'world-hub-current-publication',
      publicationId,
      manifestPath: `publications/${publicationId}/manifest.json`,
      updatedAt: publishedAt,
    }));

    /* 9. record rows */
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
    logInfo('publish', `Published ${slug}/${publicationId} (${assembly.files.length} files)`);
    return getPublication(library, publicationId);
  } catch (err) {
    /* failure: current.json untouched; remove the incomplete work area */
    try {
      fs.rmSync(tmpAbs, { recursive: true, force: true });
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
        coverAssetId: profile.cover_asset_id ?? null,
        backgroundAssetId: profile.background_asset_id ?? null,
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
        portraitAssetId: profile.portrait_asset_id ?? null,
        fullBodyAssetId: profile.full_body_asset_id ?? null,
      };
    });
  writePackageFile('catalog/characters.json', stableJson(charactersJson));

  writePackageFile('catalog/relationships.json', stableJson(snapshot.relationships.map((rel) => ({
    id: rel.id,
    sourceId: rel.source_id,
    targetId: rel.target_id,
    type: rel.rel_type,
    label: rel.label,
    inverseLabel: rel.inverse_label,
    description: rel.description,
    position: rel.position,
  }))));

  writePackageFile('catalog/tags.json', stableJson(snapshot.tags));

  /* documents */
  const documentsJson = [];
  for (const doc of snapshot.documents) {
    const sourceAbs = resolveInsideNoSymlink(library.root, doc.path);
    const content = fs.existsSync(sourceAbs) ? fs.readFileSync(sourceAbs) : Buffer.from(doc.content_cache, 'utf8');
    const packagePath = `documents/${doc.id}.md`;
    writePackageFile(packagePath, content);
    const links = db.prepare('SELECT entity_id FROM document_links WHERE document_id = ? ORDER BY position').all(doc.id)
      .map((link) => link.entity_id);
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
  writePackageFile('production/content.json', stableJson({
    id: production.id,
    name: production.name,
    slug: production.slug,
    revision: production.revision,
    worldId: production.world?.id ?? null,
    values: production.values,
    entityValues: production.entityValues,
    selections: Object.fromEntries(Object.entries(production.selections).map(([slot, list]) => [
      slot, list.map((entity) => entity.id),
    ])),
    assetSets: Object.fromEntries(Object.entries(production.assetSets).map(([key, list]) => [
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
    contract: { id: production.contractId, version: production.contractVersion },
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
  for (const rel of relationships) {
    if (!entityIds.has(rel.sourceId) || !entityIds.has(rel.targetId)) {
      throw domainError('publish.relationship_dangling', 'A packaged relationship references a record outside the package.');
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
