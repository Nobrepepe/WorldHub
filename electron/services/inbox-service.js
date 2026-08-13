import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { domainError } from './errors.js';
import { nowIso, inTransaction } from './database-service.js';
import { resolveInsideNoSymlink } from './paths.js';
import { recordActivity } from './activity-service.js';
import { classifyFile } from './file-signatures.js';
import { importAsset } from './asset-service.js';
import { createDocument } from './document-service.js';

/**
 * Bulk import staging. Import copies supported material into the
 * managed Inbox; the source is never moved, renamed, altered, or
 * deleted. Folder names never become canon automatically.
 */

const IGNORED_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.directory']);

function isIgnoredName(name) {
  return name.startsWith('.') || IGNORED_NAMES.has(name.toLowerCase());
}

function stagingDirFor(kind) {
  if (kind === 'markdown') return 'inbox/documents';
  if (kind === 'image' || kind === 'audio') return 'inbox/media';
  return 'inbox/attachments';
}

/**
 * Import files and/or directories (native-dialog paths). Directories
 * are walked recursively; symlinks are refused; hidden/system files
 * are skipped; the source-relative path is preserved as provenance.
 */
export function importIntoInbox(library, sourcePaths, { label = '' } = {}) {
  const db = library.db;
  const batchId = crypto.randomUUID();
  const now = nowIso();
  const collected = [];
  const skipped = [];

  for (const sourcePath of sourcePaths) {
    const stat = fs.lstatSync(sourcePath, { throwIfNoEntry: false });
    if (!stat) { skipped.push({ path: sourcePath, reason: 'It does not exist.' }); continue; }
    if (stat.isSymbolicLink()) { skipped.push({ path: sourcePath, reason: 'Symbolic links are not followed.' }); continue; }
    if (stat.isDirectory()) {
      walkDirectory(sourcePath, sourcePath, collected, skipped);
    } else if (stat.isFile()) {
      collected.push({ abs: sourcePath, relPath: path.basename(sourcePath), root: path.dirname(sourcePath) });
    }
  }

  if (collected.length === 0) {
    return { batchId: null, imported: 0, duplicates: 0, errors: 0, skipped };
  }

  const sourceRoot = sourcePaths.length === 1 ? sourcePaths[0] : path.dirname(sourcePaths[0]);
  db.prepare('INSERT INTO inbox_batches (id, label, source_root, imported_at) VALUES (?, ?, ?, ?)')
    .run(batchId, label || path.basename(sourceRoot), sourceRoot, now);

  const insert = db.prepare(`
    INSERT INTO inbox_items (id, batch_id, source_rel_path, filename, kind, size, checksum, staging_path, status, error_message, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const checksumExists = db.prepare(`
    SELECT (SELECT COUNT(*) FROM inbox_items WHERE checksum = ? AND status != 'error') +
           (SELECT COUNT(*) FROM blobs WHERE hash = ?) AS n
  `);

  let imported = 0;
  let duplicates = 0;
  let errors = 0;
  for (const file of collected) {
    const id = crypto.randomUUID();
    const relSource = file.relPath.split(path.sep).join('/');
    let buffer;
    try {
      buffer = fs.readFileSync(file.abs);
    } catch (err) {
      insert.run(id, batchId, relSource, path.basename(file.abs), 'attachment', 0, '', '', 'error', `Could not read the file: ${err.message}`, now);
      errors++;
      continue;
    }
    const info = classifyFile(path.basename(file.abs), buffer);
    if (!info) {
      insert.run(id, batchId, relSource, path.basename(file.abs), 'attachment', buffer.length, '', '', 'error',
        buffer.length === 0 ? 'The file is empty.' : 'The bytes do not match a supported format.', now);
      errors++;
      continue;
    }
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
    const isDuplicate = checksumExists.get(checksum, checksum).n > 0;

    const stagingRel = `${stagingDirFor(info.kind)}/${id}.${info.ext}`;
    const stagingAbs = resolveInsideNoSymlink(library.root, stagingRel);
    fs.mkdirSync(path.dirname(stagingAbs), { recursive: true });
    fs.writeFileSync(stagingAbs, buffer);

    insert.run(id, batchId, relSource, path.basename(file.abs), info.kind, buffer.length, checksum, stagingRel,
      isDuplicate ? 'duplicate' : 'unreviewed', '', now);
    if (isDuplicate) duplicates++;
    else imported++;
  }

  recordActivity(db, 'inbox.imported', 'inbox_batch', batchId, `${imported + duplicates + errors} file(s)`);
  return { batchId, imported, duplicates, errors, skipped };
}

function walkDirectory(rootAbs, dirAbs, collected, skipped) {
  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch (err) {
    skipped.push({ path: dirAbs, reason: `Could not list the folder: ${err.message}` });
    return;
  }
  for (const entry of entries) {
    if (isIgnoredName(entry.name)) continue;
    const abs = path.join(dirAbs, entry.name);
    if (entry.isSymbolicLink()) {
      skipped.push({ path: abs, reason: 'Symbolic links are not followed.' });
      continue;
    }
    if (entry.isDirectory()) {
      walkDirectory(rootAbs, abs, collected, skipped);
    } else if (entry.isFile()) {
      collected.push({ abs, relPath: path.relative(rootAbs, abs), root: rootAbs });
    }
  }
}

/* ---------------- listing ---------------- */

export function listBatches(library) {
  return library.db.prepare(`
    SELECT b.*, COUNT(i.id) AS item_count,
           SUM(CASE WHEN i.status = 'unreviewed' THEN 1 ELSE 0 END) AS unreviewed_count
    FROM inbox_batches b LEFT JOIN inbox_items i ON i.batch_id = b.id
    GROUP BY b.id ORDER BY b.imported_at DESC
  `).all();
}

export function listInbox(library, { batchId, status, kind, text, folder, limit = 1000 } = {}) {
  const db = library.db;
  const where = [];
  const args = [];
  if (batchId) { where.push('i.batch_id = ?'); args.push(batchId); }
  if (status) { where.push('i.status = ?'); args.push(status); }
  if (kind) { where.push('i.kind = ?'); args.push(kind); }
  if (text) { where.push('(i.filename LIKE ? OR i.source_rel_path LIKE ?)'); args.push(`%${text}%`, `%${text}%`); }
  if (folder) { where.push('i.source_rel_path LIKE ?'); args.push(`${folder}%`); }
  const rows = db.prepare(`
    SELECT i.*, b.label AS batch_label FROM inbox_items i
    JOIN inbox_batches b ON b.id = i.batch_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY i.imported_at DESC, i.source_rel_path
    LIMIT ?
  `).all(...args, limit);
  return rows.map(itemView);
}

function itemView(row) {
  return {
    id: row.id,
    batchId: row.batch_id,
    batchLabel: row.batch_label,
    sourceRelPath: row.source_rel_path,
    filename: row.filename,
    kind: row.kind,
    size: row.size,
    checksum: row.checksum,
    status: row.status,
    errorMessage: row.error_message,
    filedDocumentId: row.filed_document_id,
    filedAssetId: row.filed_asset_id,
    filedEntityId: row.filed_entity_id,
    importedAt: row.imported_at,
    previewUrl: row.staging_path ? `worldhub://media/inbox/${row.id}` : null,
    excerptAvailable: row.kind === 'markdown' && !!row.staging_path,
  };
}

export function itemExcerpt(library, itemId, maxChars = 600) {
  const row = library.db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(itemId);
  if (!row || !row.staging_path) return '';
  try {
    const abs = resolveInsideNoSymlink(library.root, row.staging_path);
    return fs.readFileSync(abs, 'utf8').slice(0, maxChars);
  } catch {
    return '';
  }
}

/* ---------------- filing ---------------- */

function getReviewableItem(db, itemId) {
  const row = db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(itemId);
  if (!row) throw domainError('inbox.missing', 'That Inbox item no longer exists.');
  if (row.status === 'filed') throw domainError('inbox.already_filed', 'That item was already filed.');
  if (row.status === 'error') throw domainError('inbox.errored', 'That item failed to import and cannot be filed.');
  return row;
}

/** Turn a media/attachment item into a logical asset. */
export async function fileItemAsAsset(library, itemId, { title, entityId = null, role = null } = {}) {
  const db = library.db;
  const row = getReviewableItem(db, itemId);
  if (row.kind === 'markdown') {
    throw domainError('inbox.wrong_kind', 'Markdown items become documents, not assets.');
  }
  const abs = resolveInsideNoSymlink(library.root, row.staging_path);
  const buffer = fs.readFileSync(abs);
  const asset = await importAsset(library, {
    buffer,
    filename: row.filename,
    title: title || path.parse(row.filename).name,
    importedFrom: row.source_rel_path,
    entityId,
    role,
  });
  db.prepare(`
    UPDATE inbox_items SET status = 'filed', filed_asset_id = ?, filed_asset_version_id = ?, filed_entity_id = ?, filed_at = ?
    WHERE id = ?
  `).run(asset.id, asset.currentVersionId, entityId, nowIso(), itemId);
  recordActivity(db, 'inbox.filed_asset', 'asset', asset.id, row.filename);
  return { item: itemView({ ...row, status: 'filed' }), asset };
}

/** Turn a Markdown item into a linked canonical document. */
export function fileItemAsDocument(library, itemId, { title, entityIds = [] } = {}) {
  const db = library.db;
  const row = getReviewableItem(db, itemId);
  if (row.kind !== 'markdown') {
    throw domainError('inbox.wrong_kind', 'Only Markdown items become documents.');
  }
  const abs = resolveInsideNoSymlink(library.root, row.staging_path);
  const content = fs.readFileSync(abs, 'utf8');
  const document = createDocument(library, {
    title: title || path.parse(row.filename).name,
    entityIds,
    content,
  });
  db.prepare(`
    UPDATE inbox_items SET status = 'filed', filed_document_id = ?, filed_entity_id = ?, filed_at = ?
    WHERE id = ?
  `).run(document.id, entityIds[0] ?? null, nowIso(), itemId);
  recordActivity(db, 'inbox.filed_document', 'document', document.id, row.filename);
  return { item: itemView({ ...row, status: 'filed' }), document };
}

export function setItemStatus(library, itemId, status) {
  const db = library.db;
  const row = db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(itemId);
  if (!row) throw domainError('inbox.missing', 'That Inbox item no longer exists.');
  if (row.status === 'filed') throw domainError('inbox.already_filed', 'Filed items cannot change status; undo the filing first.');
  if (!['unreviewed', 'duplicate', 'ignored'].includes(status)) {
    throw domainError('inbox.bad_status', 'Unknown Inbox status.');
  }
  db.prepare('UPDATE inbox_items SET status = ? WHERE id = ?').run(status, itemId);
  return itemView({ ...row, status });
}

/**
 * Undo the most recent filing when no later dependency prevents it.
 * The staged copy still exists, so the item returns to review.
 */
export function undoLastFiling(library) {
  const db = library.db;
  const row = db.prepare(`
    SELECT * FROM inbox_items WHERE status = 'filed' AND filed_at IS NOT NULL
    ORDER BY filed_at DESC LIMIT 1
  `).get();
  if (!row) throw domainError('inbox.nothing_to_undo', 'No filing to undo.');

  inTransaction(db, () => {
    if (row.filed_asset_id) {
      const assetId = row.filed_asset_id;
      const versions = db.prepare('SELECT COUNT(*) n FROM asset_versions WHERE asset_id = ?').get(assetId).n;
      const inProductions = db.prepare('SELECT COUNT(*) n FROM production_asset_items WHERE asset_id = ?').get(assetId).n;
      const preferred = db.prepare(`
        SELECT (SELECT COUNT(*) FROM world_profiles WHERE cover_asset_id = ? OR background_asset_id = ?) +
               (SELECT COUNT(*) FROM character_profiles WHERE portrait_asset_id = ? OR full_body_asset_id = ?) AS n
      `).get(assetId, assetId, assetId, assetId).n;
      if (versions > 1 || inProductions > 0 || preferred > 0) {
        throw domainError('inbox.undo_blocked', 'This asset gained new versions or references since filing, so the filing cannot be undone.', {
          versions, inProductions, preferred,
        });
      }
      db.prepare('DELETE FROM asset_links WHERE asset_id = ?').run(assetId);
      db.prepare('DELETE FROM asset_crops WHERE version_id IN (SELECT id FROM asset_versions WHERE asset_id = ?)').run(assetId);
      db.prepare('DELETE FROM generated_renditions WHERE version_id IN (SELECT id FROM asset_versions WHERE asset_id = ?)').run(assetId);
      db.prepare('UPDATE assets SET current_version_id = NULL WHERE id = ?').run(assetId);
      db.prepare('DELETE FROM asset_versions WHERE asset_id = ?').run(assetId);
      db.prepare('DELETE FROM assets WHERE id = ?').run(assetId);
      db.prepare(`DELETE FROM search_index WHERE subject_type = 'asset' AND subject_id = ?`).run(assetId);
      // The blob stays; the unreferenced-blob audit can reclaim it later.
    }
    if (row.filed_document_id) {
      const documentId = row.filed_document_id;
      const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
      if (doc) {
        const docAbs = resolveInsideNoSymlink(library.root, doc.path);
        db.prepare('DELETE FROM document_links WHERE document_id = ?').run(documentId);
        db.prepare('DELETE FROM documents WHERE id = ?').run(documentId);
        db.prepare(`DELETE FROM search_index WHERE subject_type = 'document' AND subject_id = ?`).run(documentId);
        try { fs.rmSync(docAbs, { force: true }); } catch { /* integrity check will catch leftovers */ }
      }
    }
    db.prepare(`
      UPDATE inbox_items SET status = 'unreviewed', filed_asset_id = NULL, filed_asset_version_id = NULL,
        filed_document_id = NULL, filed_entity_id = NULL, filed_at = NULL
      WHERE id = ?
    `).run(row.id);
    recordActivity(db, 'inbox.undo_filing', 'inbox_item', row.id, row.filename);
  });
  return itemView({ ...row, status: 'unreviewed' });
}

/**
 * Clear staging copies of already-filed items, but only after
 * confirming their canonical managed records still resolve.
 */
export function clearFiledStaging(library) {
  const db = library.db;
  const rows = db.prepare(`SELECT * FROM inbox_items WHERE status = 'filed' AND staging_path != ''`).all();
  let cleared = 0;
  const keptProblems = [];
  for (const row of rows) {
    let resolves = false;
    if (row.filed_asset_id) {
      const blob = db.prepare(`
        SELECT b.path FROM assets a
        JOIN asset_versions v ON v.asset_id = a.id
        JOIN blobs b ON b.hash = v.blob_hash
        WHERE a.id = ? LIMIT 1
      `).get(row.filed_asset_id);
      resolves = !!blob && fs.existsSync(resolveInsideNoSymlink(library.root, blob.path));
    } else if (row.filed_document_id) {
      const doc = db.prepare('SELECT path FROM documents WHERE id = ?').get(row.filed_document_id);
      resolves = !!doc && fs.existsSync(resolveInsideNoSymlink(library.root, doc.path));
    }
    if (!resolves) {
      keptProblems.push({ id: row.id, filename: row.filename, reason: 'Its canonical record no longer resolves; the staging copy was kept.' });
      continue;
    }
    try {
      fs.rmSync(resolveInsideNoSymlink(library.root, row.staging_path), { force: true });
      db.prepare(`UPDATE inbox_items SET staging_path = '' WHERE id = ?`).run(row.id);
      cleared++;
    } catch (err) {
      keptProblems.push({ id: row.id, filename: row.filename, reason: err.message });
    }
  }
  recordActivity(db, 'inbox.cleared_staging', 'inbox', '', `${cleared} staging file(s)`);
  return { cleared, kept: keptProblems };
}

/* ---------------- conservative suggestions ---------------- */

/**
 * Suggest matching entities from filename and folder tokens. These are
 * suggestions only; records are never merged automatically.
 */
export function suggestMatches(library, itemId) {
  const db = library.db;
  const row = db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(itemId);
  if (!row) return [];
  const tokens = new Set(
    `${row.source_rel_path} ${row.filename}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3),
  );
  if (tokens.size === 0) return [];
  const entities = db.prepare(`SELECT id, name, type, slug FROM entities WHERE status != 'archived'`).all();
  const aliases = db.prepare('SELECT entity_id, alias FROM entity_aliases').all();
  const aliasMap = new Map();
  for (const alias of aliases) {
    if (!aliasMap.has(alias.entity_id)) aliasMap.set(alias.entity_id, []);
    aliasMap.get(alias.entity_id).push(alias.alias);
  }
  const suggestions = [];
  for (const entity of entities) {
    const names = [entity.name, entity.slug, ...(aliasMap.get(entity.id) ?? [])];
    for (const candidate of names) {
      const nameTokens = candidate.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
      if (nameTokens.length > 0 && nameTokens.every((t) => tokens.has(t))) {
        suggestions.push({ entityId: entity.id, name: entity.name, type: entity.type, why: `"${candidate}" appears in the file path` });
        break;
      }
    }
    if (suggestions.length >= 5) break;
  }
  return suggestions;
}
