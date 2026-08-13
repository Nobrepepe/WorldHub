import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { domainError } from './errors.js';
import { nowIso, inTransaction } from './database-service.js';
import { writeFileAtomic } from './atomic-file.js';
import { resolveInsideNoSymlink, slugify } from './paths.js';
import { recordActivity } from './activity-service.js';
import { syncDocumentIndex, removeFromIndex } from './search-service.js';

/**
 * Markdown documents are ordinary UTF-8 .md files inside the library.
 * The file is canonical; the database keeps a text cache solely for
 * indexing and recovery diagnostics.
 */

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function countWords(text) {
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}

/** Directory by first linked entity: character/world get their UUID dir. */
function directoryFor(db, documentId, entityIds) {
  for (const entityId of entityIds) {
    const entity = db.prepare('SELECT id, type FROM entities WHERE id = ?').get(entityId);
    if (!entity) continue;
    if (entity.type === 'world') return `documents/world/${entity.id}`;
    if (entity.type === 'character') return `documents/character/${entity.id}`;
  }
  return `documents/entry/${documentId}`;
}

function uniqueFilename(library, dirRel, baseName) {
  let candidate = `${baseName}.md`;
  let counter = 2;
  for (;;) {
    const abs = resolveInsideNoSymlink(library.root, `${dirRel}/${candidate}`);
    if (!fs.existsSync(abs)) return candidate;
    candidate = `${baseName}-${counter++}.md`;
  }
}

export function createDocument(library, { title, entityIds = [], content = '' }) {
  const db = library.db;
  const trimmedTitle = title.trim();
  if (!trimmedTitle) throw domainError('document.title_required', 'A document needs a title.');
  const id = crypto.randomUUID();
  const now = nowIso();

  const dirRel = directoryFor(db, id, entityIds);
  const filename = uniqueFilename(library, dirRel, slugify(trimmedTitle, 'document'));
  const relPath = `${dirRel}/${filename}`;
  const body = content || `# ${trimmedTitle}\n\n`;

  inTransaction(db, () => {
    db.prepare(`
      INSERT INTO documents (id, title, path, checksum, word_count, content_cache, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, trimmedTitle, relPath, sha256(body), countWords(body), body, now, now);
    const link = db.prepare('INSERT OR IGNORE INTO document_links (document_id, entity_id, position) VALUES (?, ?, ?)');
    entityIds.forEach((entityId, i) => {
      if (!db.prepare('SELECT id FROM entities WHERE id = ?').get(entityId)) {
        throw domainError('entity.missing', 'A linked record no longer exists.');
      }
      link.run(id, entityId, i);
    });
    writeFileAtomic(resolveInsideNoSymlink(library.root, relPath), body);
    recordActivity(db, 'document.created', 'document', id, trimmedTitle);
    syncDocumentIndex(library, id);
  });
  return getDocument(library, id);
}

/**
 * Load a document with its file content. When the file on disk no
 * longer matches the checksum the app last wrote, the document is
 * flagged as externally changed — the caller decides what to do.
 */
export function getDocument(library, id, { withContent = true } = {}) {
  const db = library.db;
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (!row) throw domainError('document.missing', 'That document no longer exists.');
  const view = documentView(db, row);
  if (withContent) {
    const abs = resolveInsideNoSymlink(library.root, row.path);
    if (!fs.existsSync(abs)) {
      view.fileMissing = true;
      view.content = row.content_cache;
      view.externallyChanged = false;
    } else {
      const content = fs.readFileSync(abs, 'utf8');
      view.content = content;
      view.fileMissing = false;
      view.externallyChanged = sha256(content) !== row.checksum;
    }
  }
  return view;
}

function documentView(db, row) {
  const links = db.prepare(`
    SELECT e.id, e.name, e.type FROM document_links l
    JOIN entities e ON e.id = l.entity_id
    WHERE l.document_id = ? ORDER BY l.position
  `).all(row.id);
  return {
    id: row.id,
    title: row.title,
    path: row.path,
    status: row.status,
    checksum: row.checksum,
    wordCount: row.word_count,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    links,
  };
}

/**
 * Atomically save content. baseChecksum is the checksum of the content
 * the editor loaded; if the file changed externally since then, the
 * save is refused — never silently overwrite an external change.
 */
export function saveDocument(library, { id, content, baseChecksum }) {
  const db = library.db;
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (!row) throw domainError('document.missing', 'That document no longer exists.');
  const abs = resolveInsideNoSymlink(library.root, row.path);

  if (fs.existsSync(abs)) {
    const onDisk = sha256(fs.readFileSync(abs, 'utf8'));
    if (onDisk !== row.checksum && onDisk !== baseChecksum && onDisk !== sha256(content)) {
      throw domainError('document.conflict', 'This file changed outside World Hub since it was loaded. Reload it, or save your version as a recovered copy.', { path: row.path });
    }
  }

  const checksum = sha256(content);
  inTransaction(db, () => {
    writeFileAtomic(abs, content);
    db.prepare(`
      UPDATE documents SET checksum = ?, word_count = ?, content_cache = ?, revision = revision + 1, updated_at = ?
      WHERE id = ?
    `).run(checksum, countWords(content), content, nowIso(), id);
    syncDocumentIndex(library, id);
  });
  return { checksum, wordCount: countWords(content), savedAt: nowIso() };
}

/** Save conflicting editor content as a new sibling document. */
export function saveRecoveredCopy(library, { id, content }) {
  const original = getDocument(library, id, { withContent: false });
  return createDocument(library, {
    title: `${original.title} (recovered ${new Date().toISOString().slice(0, 16).replace('T', ' ')})`,
    entityIds: original.links.map((l) => l.id),
    content,
  });
}

/** Rename: title always; the file may be renamed safely too. */
export function renameDocument(library, { id, title }) {
  const db = library.db;
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (!row) throw domainError('document.missing', 'That document no longer exists.');
  const trimmed = title.trim();
  if (!trimmed) throw domainError('document.title_required', 'A document needs a title.');

  const dirRel = path.posix.dirname(row.path);
  const newFilename = uniqueFilename(library, dirRel, slugify(trimmed, 'document'));
  const newRel = `${dirRel}/${newFilename}`;
  const oldAbs = resolveInsideNoSymlink(library.root, row.path);
  const newAbs = resolveInsideNoSymlink(library.root, newRel);

  inTransaction(db, () => {
    db.prepare('UPDATE documents SET title = ?, path = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
      .run(trimmed, newRel, nowIso(), id);
    if (fs.existsSync(oldAbs)) fs.renameSync(oldAbs, newAbs);
    recordActivity(db, 'document.renamed', 'document', id, trimmed);
    syncDocumentIndex(library, id);
  });
  return getDocument(library, id, { withContent: false });
}

export function duplicateDocument(library, id) {
  const original = getDocument(library, id);
  return createDocument(library, {
    title: `${original.title} (copy)`,
    entityIds: original.links.map((l) => l.id),
    content: original.content,
  });
}

export function setDocumentStatus(library, id, status) {
  const db = library.db;
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (!row) throw domainError('document.missing', 'That document no longer exists.');
  inTransaction(db, () => {
    db.prepare('UPDATE documents SET status = ?, archived_at = ?, updated_at = ? WHERE id = ?')
      .run(status, status === 'archived' ? nowIso() : null, nowIso(), id);
    recordActivity(db, `document.${status === 'archived' ? 'archived' : 'status'}`, 'document', id, row.title);
    if (status === 'archived') removeFromIndex(library, 'document', id);
    else syncDocumentIndex(library, id);
  });
  return getDocument(library, id, { withContent: false });
}

/** Link one document to several entities without copying it. */
export function setDocumentLinks(library, id, entityIds) {
  const db = library.db;
  if (!db.prepare('SELECT id FROM documents WHERE id = ?').get(id)) {
    throw domainError('document.missing', 'That document no longer exists.');
  }
  inTransaction(db, () => {
    db.prepare('DELETE FROM document_links WHERE document_id = ?').run(id);
    const link = db.prepare('INSERT OR IGNORE INTO document_links (document_id, entity_id, position) VALUES (?, ?, ?)');
    entityIds.forEach((entityId, i) => {
      if (!db.prepare('SELECT id FROM entities WHERE id = ?').get(entityId)) {
        throw domainError('entity.missing', 'A linked record no longer exists.');
      }
      link.run(id, entityId, i);
    });
    // Links are published with the document at a claimed revision, so
    // changing them is a meaningful change.
    db.prepare('UPDATE documents SET revision = revision + 1, updated_at = ? WHERE id = ?').run(nowIso(), id);
  });
  return getDocument(library, id, { withContent: false });
}

export function listDocuments(library, { entityId, status, text, limit = 500 } = {}) {
  const db = library.db;
  const where = [];
  const args = [];
  if (entityId) {
    where.push('EXISTS (SELECT 1 FROM document_links l WHERE l.document_id = d.id AND l.entity_id = ?)');
    args.push(entityId);
  }
  if (status) { where.push('d.status = ?'); args.push(status); }
  else { where.push(`d.status != 'archived'`); }
  if (text) { where.push('d.title LIKE ?'); args.push(`%${text}%`); }
  const rows = db.prepare(`
    SELECT d.* FROM documents d
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY d.updated_at DESC
    LIMIT ?
  `).all(...args, limit);
  return rows.map((row) => documentView(db, row));
}
