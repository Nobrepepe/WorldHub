import fs from 'node:fs';
import path from 'node:path';
import { domainError } from './errors.js';
import { inTransaction } from './database-service.js';
import { recordActivity } from './activity-service.js';
import { removeFromIndex } from './search-service.js';
import { resolveInside } from './paths.js';

/**
 * Clearing the archive for good.
 *
 * Everything in World Hub is archived rather than deleted, which is
 * right until an archive of abandoned attempts is all that is left.
 * This is the one place that truly removes material, and it does so
 * under three rules: the author sees the exact count before agreeing,
 * nothing still in use by living material is touched, and the database
 * commits before a single file leaves the disk.
 */

export const PURGE_SCOPES = ['productions', 'documents', 'assets', 'entities', 'contracts'];

/* ---------------- planning ---------------- */

/**
 * Work out what a purge of the chosen scopes would remove, what it
 * would refuse to touch, and why. Scopes are resolved in dependency
 * order, so clearing archived productions in the same pass is what
 * frees the records and assets they were holding.
 */
export function planPurge(db, { scopes = [], includePublications = false } = {}) {
  const wants = new Set(scopes);
  for (const scope of wants) {
    if (!PURGE_SCOPES.includes(scope)) {
      throw domainError('archive.unknown_scope', `“${scope}” is not something that can be cleared.`);
    }
  }

  const plan = {
    productions: [], documents: [], assets: [], entities: [], contracts: [],
    blocked: [], consequences: [], publications: [], blobs: [], files: [], bytes: 0,
  };

  /* productions */
  const goingProductions = new Set();
  if (wants.has('productions')) {
    for (const production of db.prepare(`SELECT id, name, slug FROM productions WHERE status = 'archived' ORDER BY name COLLATE NOCASE`).all()) {
      const publications = db.prepare('SELECT id, package_size FROM publications WHERE production_id = ?').all(production.id);
      if (publications.length > 0 && !includePublications) {
        plan.blocked.push(`“${production.name}” keeps ${publications.length} published snapshot(s). Tick the snapshots box to clear it too.`);
        continue;
      }
      plan.productions.push(production);
      goingProductions.add(production.id);
      for (const publication of publications) {
        plan.publications.push({ ...publication, productionSlug: production.slug });
        plan.bytes += publication.package_size ?? 0;
      }
      plan.files.push(`productions/${production.slug}`);
    }
  }

  /* documents */
  if (wants.has('documents')) {
    for (const doc of db.prepare(`SELECT id, title, path FROM documents WHERE status = 'archived' ORDER BY title COLLATE NOCASE`).all()) {
      plan.documents.push(doc);
      plan.files.push(doc.path);
    }
  }
  const goingDocuments = new Set(plan.documents.map((doc) => doc.id));

  /* assets — refused while any surviving production still points at one */
  const goingAssets = new Set();
  if (wants.has('assets')) {
    for (const asset of db.prepare(`SELECT id, title FROM assets WHERE status = 'archived' ORDER BY title COLLATE NOCASE`).all()) {
      const live = db.prepare(`
        SELECT DISTINCT s.production_id AS id, p.name FROM production_asset_items i
        JOIN production_asset_sets s ON s.id = i.set_id
        JOIN productions p ON p.id = s.production_id
        WHERE i.asset_id = ?
      `).all(asset.id).filter((row) => !goingProductions.has(row.id));
      if (live.length > 0) {
        plan.blocked.push(`“${asset.title}” is still chosen by the production “${live[0].name}”.`);
        continue;
      }
      plan.assets.push(asset);
      goingAssets.add(asset.id);
    }
  }

  /* entities — refused while living material still stands on them */
  const goingEntities = new Set();
  if (wants.has('entities')) {
    const archived = db.prepare(`SELECT id, type, name FROM entities WHERE status = 'archived' ORDER BY name COLLATE NOCASE`).all();
    const candidates = new Map(archived.map((entity) => [entity.id, entity]));
    const refusals = new Map();
    const refuse = (entity, why) => { refusals.set(entity.id, why); candidates.delete(entity.id); };

    for (const entity of archived) {
      const inProductions = db.prepare(`
        SELECT DISTINCT p.id, p.name FROM productions p
        LEFT JOIN production_entities pe ON pe.production_id = p.id
        WHERE pe.entity_id = ? OR p.world_id = ?
      `).all(entity.id, entity.id).filter((row) => !goingProductions.has(row.id));
      if (inProductions.length > 0) refuse(entity, `the production “${inProductions[0].name}” uses it`);
    }
    /* A world cannot go while anything that stays still lives inside it,
       and refusing one world can strand the next: settle it by rounds. */
    for (let settled = false; !settled;) {
      settled = true;
      for (const entity of [...candidates.values()]) {
        const staying = db.prepare('SELECT id FROM entities WHERE world_id = ?').all(entity.id)
          .filter((child) => !candidates.has(child.id));
        if (staying.length > 0) {
          refuse(entity, `${staying.length} record(s) still sit inside it`);
          settled = false;
        }
      }
    }
    for (const entity of archived) {
      if (candidates.has(entity.id)) {
        plan.entities.push(entity);
        goingEntities.add(entity.id);
      } else {
        plan.blocked.push(`“${entity.name}” cannot go yet: ${refusals.get(entity.id)}.`);
      }
    }
    /* Links held by material that survives are cut, not blocked: an
       archived record that leaves takes its own references with it. */
    let cutLinks = 0;
    let cutConnections = 0;
    let cutDocumentLinks = 0;
    for (const entityId of goingEntities) {
      cutLinks += db.prepare('SELECT COUNT(*) n FROM asset_links WHERE entity_id = ?').get(entityId).n;
      cutConnections += db.prepare('SELECT COUNT(*) n FROM connections WHERE source_id = ? OR target_id = ?').get(entityId, entityId).n;
      cutDocumentLinks += db.prepare('SELECT COUNT(*) n FROM document_links WHERE entity_id = ?').get(entityId).n;
    }
    if (cutLinks > 0) plan.consequences.push(`${cutLinks} asset link(s) to those records are cut.`);
    if (cutConnections > 0) plan.consequences.push(`${cutConnections} connection(s) touching those records are removed.`);
    if (cutDocumentLinks > 0) plan.consequences.push(`${cutDocumentLinks} document link(s) to those records are cut.`);
  }

  /* contracts — only once nothing is built on them */
  if (wants.has('contracts')) {
    const seen = new Set();
    for (const contract of db.prepare(`SELECT DISTINCT contract_id, name FROM application_contracts WHERE status = 'archived' ORDER BY name COLLATE NOCASE`).all()) {
      if (seen.has(contract.contract_id)) continue;
      seen.add(contract.contract_id);
      const users = db.prepare('SELECT id, name FROM productions WHERE contract_id = ?').all(contract.contract_id)
        .filter((row) => !goingProductions.has(row.id));
      const published = db.prepare('SELECT COUNT(*) n FROM publications WHERE contract_id = ?').get(contract.contract_id).n;
      if (users.length > 0) {
        plan.blocked.push(`The contract “${contract.name}” is still used by the production “${users[0].name}”.`);
        continue;
      }
      if (published > 0 && !includePublications) {
        plan.blocked.push(`The contract “${contract.name}” is recorded in ${published} published snapshot(s).`);
        continue;
      }
      plan.contracts.push(contract);
    }
  }

  /* originals that no surviving version would still need */
  if (goingAssets.size > 0) {
    const placeholders = [...goingAssets].map(() => '?').join(',');
    for (const blob of db.prepare(`
      SELECT b.hash, b.path, b.size FROM blobs b
      WHERE NOT EXISTS (
        SELECT 1 FROM asset_versions v WHERE v.blob_hash = b.hash AND v.asset_id NOT IN (${placeholders})
      ) AND EXISTS (
        SELECT 1 FROM asset_versions v WHERE v.blob_hash = b.hash AND v.asset_id IN (${placeholders})
      )
    `).all(...goingAssets, ...goingAssets)) {
      plan.blobs.push(blob);
      plan.files.push(blob.path);
      plan.bytes += blob.size ?? 0;
    }
    for (const rendition of db.prepare(`
      SELECT r.path, r.size FROM generated_renditions r
      JOIN asset_versions v ON v.id = r.version_id
      WHERE v.asset_id IN (${placeholders})
    `).all(...goingAssets)) {
      plan.files.push(rendition.path);
      plan.bytes += rendition.size ?? 0;
    }
  }
  plan.total = plan.productions.length + plan.documents.length + plan.assets.length
    + plan.entities.length + plan.contracts.length;
  return plan;
}

/** The same plan, in the shape the archive panel reads. */
export function previewPurge(library, { scopes = [], includePublications = false } = {}) {
  const plan = planPurge(library.db, { scopes, includePublications });
  return {
    total: plan.total,
    counts: {
      productions: plan.productions.length,
      documents: plan.documents.length,
      assets: plan.assets.length,
      entities: plan.entities.length,
      contracts: plan.contracts.length,
    },
    publications: plan.publications.length,
    originals: plan.blobs.length,
    bytes: plan.bytes,
    blocked: plan.blocked,
    consequences: plan.consequences,
    names: {
      productions: plan.productions.map((row) => row.name),
      documents: plan.documents.map((row) => row.title),
      assets: plan.assets.map((row) => row.title),
      entities: plan.entities.map((row) => row.name),
      contracts: plan.contracts.map((row) => row.name),
    },
  };
}

/** What is sitting in the archive right now, scope by scope. */
export function archiveOverview(library) {
  const db = library.db;
  const one = (sql, ...args) => db.prepare(sql).get(...args).n;
  const full = planPurge(db, { scopes: PURGE_SCOPES, includePublications: true });
  return {
    counts: {
      productions: one(`SELECT COUNT(*) n FROM productions WHERE status = 'archived'`),
      documents: one(`SELECT COUNT(*) n FROM documents WHERE status = 'archived'`),
      assets: one(`SELECT COUNT(*) n FROM assets WHERE status = 'archived'`),
      entities: one(`SELECT COUNT(*) n FROM entities WHERE status = 'archived'`),
      contracts: db.prepare(`SELECT COUNT(DISTINCT contract_id) n FROM application_contracts WHERE status = 'archived'`).get().n,
    },
    publications: one(`
      SELECT COUNT(*) n FROM publications pub
      JOIN productions p ON p.id = pub.production_id WHERE p.status = 'archived'`),
    reclaimableBytes: full.bytes,
  };
}

/* ---------------- the purge itself ---------------- */

/**
 * Remove the planned material for good. The database commits first;
 * files are unlinked only afterwards, so a failure can leave an unused
 * file on disk — which the Integrity centre reports — but never a row
 * pointing at a file that is gone.
 */
export function purgeArchive(library, { scopes = [], includePublications = false } = {}) {
  const db = library.db;
  const plan = planPurge(db, { scopes, includePublications });
  const report = () => ({
    removed: {
      productions: plan.productions.length,
      documents: plan.documents.length,
      assets: plan.assets.length,
      entities: plan.entities.length,
      contracts: plan.contracts.length,
      publications: plan.publications.length,
      originals: plan.blobs.length,
    },
    blocked: plan.blocked,
    bytes: plan.bytes,
  });
  if (plan.total === 0) {
    return { ...report(), deletedFiles: 0, failedFiles: [], bytes: 0 };
  }

  inTransaction(db, () => {
    /* productions and their published snapshots */
    for (const publication of plan.publications) {
      db.prepare('DELETE FROM publication_files WHERE publication_id = ?').run(publication.id);
      db.prepare('DELETE FROM publications WHERE id = ?').run(publication.id);
    }
    for (const production of plan.productions) {
      db.prepare('DELETE FROM production_asset_sets WHERE production_id = ?').run(production.id);
      db.prepare('DELETE FROM production_entities WHERE production_id = ?').run(production.id);
      db.prepare('DELETE FROM production_values WHERE production_id = ?').run(production.id);
      db.prepare(`DELETE FROM taggings WHERE subject_type = 'production' AND subject_id = ?`).run(production.id);
      db.prepare('DELETE FROM productions WHERE id = ?').run(production.id);
    }

    /* documents */
    for (const doc of plan.documents) {
      db.prepare('DELETE FROM document_links WHERE document_id = ?').run(doc.id);
      db.prepare(`DELETE FROM taggings WHERE subject_type = 'document' AND subject_id = ?`).run(doc.id);
      db.prepare(`UPDATE inbox_items SET filed_document_id = NULL WHERE filed_document_id = ?`).run(doc.id);
      db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
      removeFromIndex(library, 'document', doc.id);
    }

    /* assets: renditions and crops go with their versions */
    for (const asset of plan.assets) {
      for (const version of db.prepare('SELECT id FROM asset_versions WHERE asset_id = ?').all(asset.id)) {
        db.prepare('DELETE FROM generated_renditions WHERE version_id = ?').run(version.id);
        db.prepare('DELETE FROM asset_crops WHERE version_id = ?').run(version.id);
      }
      db.prepare('UPDATE assets SET current_version_id = NULL WHERE id = ?').run(asset.id);
      db.prepare('DELETE FROM asset_versions WHERE asset_id = ?').run(asset.id);
      db.prepare('DELETE FROM asset_links WHERE asset_id = ?').run(asset.id);
      db.prepare(`DELETE FROM taggings WHERE subject_type = 'asset' AND subject_id = ?`).run(asset.id);
      db.prepare(`UPDATE character_profiles SET portrait_asset_id = NULL WHERE portrait_asset_id = ?`).run(asset.id);
      db.prepare(`UPDATE character_profiles SET tile_asset_id = NULL WHERE tile_asset_id = ?`).run(asset.id);
      db.prepare(`UPDATE world_profiles SET cover_asset_id = NULL WHERE cover_asset_id = ?`).run(asset.id);
      db.prepare(`UPDATE world_profiles SET background_asset_id = NULL WHERE background_asset_id = ?`).run(asset.id);
      db.prepare(`UPDATE inbox_items SET filed_asset_id = NULL, filed_asset_version_id = NULL WHERE filed_asset_id = ?`).run(asset.id);
      db.prepare('DELETE FROM assets WHERE id = ?').run(asset.id);
      removeFromIndex(library, 'asset', asset.id);
    }
    for (const blob of plan.blobs) {
      db.prepare('DELETE FROM blobs WHERE hash = ?').run(blob.hash);
    }

    /* entities last: by now nothing that survives is standing on them */
    for (const entity of plan.entities) {
      db.prepare('DELETE FROM connections WHERE source_id = ? OR target_id = ?').run(entity.id, entity.id);
      db.prepare('DELETE FROM document_links WHERE entity_id = ?').run(entity.id);
      db.prepare('DELETE FROM asset_links WHERE entity_id = ?').run(entity.id);
      db.prepare('DELETE FROM entity_aliases WHERE entity_id = ?').run(entity.id);
      db.prepare('DELETE FROM world_profiles WHERE entity_id = ?').run(entity.id);
      db.prepare('DELETE FROM character_profiles WHERE entity_id = ?').run(entity.id);
      db.prepare(`DELETE FROM taggings WHERE subject_type = 'entity' AND subject_id = ?`).run(entity.id);
      db.prepare(`UPDATE entities SET world_id = NULL WHERE world_id = ?`).run(entity.id);
      db.prepare(`UPDATE inbox_items SET filed_entity_id = NULL WHERE filed_entity_id = ?`).run(entity.id);
      db.prepare('DELETE FROM entities WHERE id = ?').run(entity.id);
      removeFromIndex(library, 'entity', entity.id);
    }

    for (const contract of plan.contracts) {
      db.prepare('DELETE FROM application_contracts WHERE contract_id = ?').run(contract.contract_id);
    }

    recordActivity(db, 'archive.purged', 'library', '',
      `${plan.total} item(s): ${plan.productions.length} production(s), ${plan.documents.length} document(s), ${plan.assets.length} asset(s), ${plan.entities.length} record(s), ${plan.contracts.length} contract(s)`);
  });

  /* files only once the database has committed */
  let deletedFiles = 0;
  const failedFiles = [];
  for (const relPath of plan.files) {
    try {
      const abs = resolveInside(library.root, relPath);
      if (!fs.existsSync(abs)) continue;
      fs.rmSync(abs, { recursive: true, force: true });
      deletedFiles++;
    } catch (err) {
      failedFiles.push(`${relPath}: ${err.message}`);
    }
  }
  /* a production folder left standing with nothing in it is just litter */
  const productionsRoot = path.join(library.root, 'productions');
  if (fs.existsSync(productionsRoot)) {
    for (const name of fs.readdirSync(productionsRoot)) {
      const dir = path.join(productionsRoot, name);
      try {
        if (fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch { /* leave anything that resists */ }
    }
  }

  return { ...report(), deletedFiles, failedFiles };
}
