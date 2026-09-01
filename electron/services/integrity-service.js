import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveInsideNoSymlink } from './paths.js';
import { rebuildSearchIndex } from './search-service.js';
import { generateRendition } from './asset-service.js';
import { verifyPublication } from './publication-service.js';
import { cleanStaleTemporaries } from './atomic-file.js';
import { setSetting, getSetting } from './settings-service.js';
import { recordActivity } from './activity-service.js';
import { LIBRARY_FOLDERS } from './library-service.js';
import { domainError } from './errors.js';

/**
 * Integrity center. Checks report readable findings; repairs are safe
 * and targeted — regenerate, rebuild, recreate, or clear verified
 * stale files. Missing originals are never invented and content is
 * never deleted automatically.
 */

function sha256File(absPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

export async function runIntegrityChecks(library) {
  const db = library.db;
  const findings = [];
  const add = (severity, code, message, repair = null) => findings.push({ severity, code, message, repair });

  /* database foreign keys */
  const fkViolations = db.pragma('foreign_key_check');
  for (const violation of fkViolations.slice(0, 20)) {
    add('problem', 'db.foreign_key', `Foreign key violation in table ${violation.table} (rowid ${violation.rowid}).`);
  }

  /* missing folders */
  const missingFolders = LIBRARY_FOLDERS.filter((folder) => !fs.existsSync(path.join(library.root, ...folder.split('/'))));
  if (missingFolders.length > 0) {
    add('problem', 'folders.missing', `Missing library folder(s): ${missingFolders.join(', ')}.`, 'recreate-folders');
  }

  /* documents */
  for (const doc of db.prepare('SELECT * FROM documents').all()) {
    const abs = resolveInsideNoSymlink(library.root, doc.path);
    if (!fs.existsSync(abs)) {
      add('problem', 'document.file_missing', `The Markdown file for “${doc.title}” is missing (${doc.path}). Its text cache can recreate it from the document screen.`);
    } else if (sha256File(abs) !== doc.checksum) {
      add('note', 'document.checksum_drift', `“${doc.title}” was changed outside World Hub. Open it to review the difference.`);
    }
  }

  /* blobs */
  for (const blob of db.prepare('SELECT * FROM blobs').all()) {
    const abs = resolveInsideNoSymlink(library.root, blob.path);
    if (!fs.existsSync(abs)) {
      add('problem', 'blob.missing', `An original file is missing: ${blob.path}. Restore it from a backup or archive; originals are never regenerated.`);
    } else if (sha256File(abs) !== blob.hash) {
      add('problem', 'blob.corrupt', `An original file no longer matches its checksum: ${blob.path}.`);
    }
  }

  /* generated renditions */
  let missingRenditions = 0;
  for (const rendition of db.prepare('SELECT * FROM generated_renditions').all()) {
    if (!fs.existsSync(resolveInsideNoSymlink(library.root, rendition.path))) missingRenditions++;
  }
  if (missingRenditions > 0) {
    add('problem', 'rendition.missing', `${missingRenditions} generated rendition file(s) are missing. They can be regenerated deterministically.`, 'regenerate-renditions');
  }

  /* orphaned inbox staging files */
  const stagedPaths = new Set(db.prepare(`SELECT staging_path FROM inbox_items WHERE staging_path != ''`).all().map((row) => row.staging_path));
  let orphans = 0;
  for (const sub of ['inbox/documents', 'inbox/media', 'inbox/attachments']) {
    const dir = path.join(library.root, ...sub.split('/'));
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('.worldhub-tmp-')) continue;
      if (!stagedPaths.has(`${sub}/${name}`)) orphans++;
    }
  }
  if (orphans > 0) {
    add('note', 'inbox.orphaned_staging', `${orphans} file(s) in the Inbox staging folders have no Inbox record. They are left in place; review them manually.`);
  }

  /* connections whose kind no longer describes them */
  const strayPairs = db.prepare(`
    SELECT c.id, k.forward_label, s.type AS source_type, s.name AS source_name,
           t.type AS target_type, t.name AS target_name
    FROM connections c
    JOIN connection_kinds k ON k.id = c.kind_id
    JOIN entities s ON s.id = c.source_id
    JOIN entities t ON t.id = c.target_id
    WHERE NOT EXISTS (
      SELECT 1 FROM connection_kind_pairs p
      WHERE p.kind_id = c.kind_id AND p.source_type = s.type AND p.target_type = t.type
    )
  `).all();
  for (const stray of strayPairs.slice(0, 20)) {
    add('note', 'connection.pair_unlisted',
      `“${stray.source_name}” (${stray.source_type}) and “${stray.target_name}” (${stray.target_type}) are connected as “${stray.forward_label}”, which no longer lists that combination. The fact is kept; widen the kind on the Connections screen or move the connection to another kind.`);
  }

  /* the same fact filed twice */
  const duplicateConnections = db.prepare(`
    SELECT c.kind_id, c.source_id, c.target_id, COUNT(*) n,
           s.name AS source_name, t.name AS target_name, k.forward_label
    FROM connections c
    JOIN connection_kinds k ON k.id = c.kind_id
    JOIN entities s ON s.id = c.source_id
    JOIN entities t ON t.id = c.target_id
    GROUP BY c.kind_id, c.source_id, c.target_id
    HAVING n > 1
  `).all();
  for (const duplicate of duplicateConnections.slice(0, 20)) {
    add('note', 'connection.duplicate',
      `“${duplicate.source_name}” and “${duplicate.target_name}” are connected as “${duplicate.forward_label}” ${duplicate.n} times. Upgrades keep duplicates rather than choosing one to delete; remove the extra from the Connections screen.`);
  }

  /* publications */
  for (const publication of db.prepare('SELECT id FROM publications').all()) {
    const result = verifyPublication(library, publication.id);
    if (!result.ok) {
      add('problem', 'publication.broken', `Publication ${publication.id.slice(0, 8)}… has ${result.problems.length} damaged file(s): ${result.problems.slice(0, 3).map((problem) => problem.path).join(', ')}.`);
    }
  }

  /* stale temporary files */
  const tmpDir = path.join(library.root, 'tmp');
  let staleTmp = 0;
  if (fs.existsSync(tmpDir)) {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(tmpDir)) {
      try {
        if (fs.statSync(path.join(tmpDir, name)).mtimeMs < dayAgo) staleTmp++;
      } catch { /* skip */ }
    }
  }
  if (staleTmp > 0) {
    add('note', 'tmp.stale', `${staleTmp} stale temporary file(s) or folder(s) remain from interrupted work.`, 'clear-tmp');
  }

  /* search index drift */
  const activeEntities = db.prepare(`SELECT COUNT(*) n FROM entities WHERE status != 'archived'`).get().n;
  const indexedEntities = db.prepare(`SELECT COUNT(DISTINCT subject_id) n FROM search_index WHERE subject_type = 'entity'`).get().n;
  if (activeEntities !== indexedEntities) {
    add('problem', 'search.drift', `The search index covers ${indexedEntities} of ${activeEntities} active records. Rebuild it.`, 'rebuild-search');
  }

  const summary = {
    ranAt: new Date().toISOString(),
    problems: findings.filter((finding) => finding.severity === 'problem').length,
    notes: findings.filter((finding) => finding.severity === 'note').length,
    findings,
  };
  if (!library.readOnly) {
    setSetting(db, 'lastIntegrityRun', summary);
    recordActivity(db, 'integrity.ran', 'integrity', '', `${summary.problems} problem(s), ${summary.notes} note(s)`);
  }
  return summary;
}

export function lastIntegrityRun(library) {
  return getSetting(library.db, 'lastIntegrityRun');
}

/* ---------------- safe repairs ---------------- */

export async function runRepair(library, repairId) {
  switch (repairId) {
    case 'recreate-folders': {
      const created = [];
      for (const folder of LIBRARY_FOLDERS) {
        const abs = path.join(library.root, ...folder.split('/'));
        if (!fs.existsSync(abs)) {
          fs.mkdirSync(abs, { recursive: true });
          created.push(folder);
        }
      }
      return { repaired: true, message: created.length > 0 ? `Recreated ${created.join(', ')}.` : 'Nothing to recreate.' };
    }
    case 'rebuild-search': {
      const counts = rebuildSearchIndex(library);
      return { repaired: true, message: `Rebuilt the index over ${counts.entities} records, ${counts.documents} documents, ${counts.assets} assets, and ${counts.connections} connections.` };
    }
    case 'regenerate-renditions': {
      const db = library.db;
      const rows = db.prepare('SELECT * FROM generated_renditions').all();
      let regenerated = 0;
      let failed = 0;
      for (const row of rows) {
        if (fs.existsSync(resolveInsideNoSymlink(library.root, row.path))) continue;
        try {
          db.prepare('DELETE FROM generated_renditions WHERE id = ?').run(row.id);
          await generateRendition(library, row.version_id, row.recipe_id);
          regenerated++;
        } catch {
          failed++;
        }
      }
      return {
        repaired: failed === 0,
        message: `Regenerated ${regenerated} rendition(s)${failed > 0 ? `; ${failed} failed because their originals are missing` : ''}.`,
      };
    }
    case 'clear-tmp': {
      const removedFiles = cleanStaleTemporaries(library.root, 24 * 60 * 60 * 1000);
      const tmpDir = path.join(library.root, 'tmp');
      let removedDirs = 0;
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      if (fs.existsSync(tmpDir)) {
        for (const name of fs.readdirSync(tmpDir)) {
          const abs = path.join(tmpDir, name);
          try {
            if (fs.statSync(abs).mtimeMs < dayAgo) {
              fs.rmSync(abs, { recursive: true, force: true });
              removedDirs++;
            }
          } catch { /* skip */ }
        }
      }
      return { repaired: true, message: `Cleared ${removedFiles.length + removedDirs} verified stale item(s).` };
    }
    default:
      throw domainError('integrity.unknown_repair', 'That repair does not exist.');
  }
}
