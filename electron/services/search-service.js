/**
 * Single search-index service. Domain transactions call the sync
 * functions; an explicit rebuild repopulates everything from source
 * tables. The FTS index never holds canonical data.
 */

function deleteSubject(db, subjectType, subjectId) {
  db.prepare('DELETE FROM search_index WHERE subject_type = ? AND subject_id = ?').run(subjectType, subjectId);
}

export function removeFromIndex(library, subjectType, subjectId) {
  deleteSubject(library.db, subjectType, subjectId);
}

/** Reindex one entity: name/aliases, summary and profile text, tags. */
export function syncEntityIndex(library, id) {
  const db = library.db;
  deleteSubject(db, 'entity', id);
  const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
  if (!row || row.status === 'archived') return;

  const insert = db.prepare('INSERT INTO search_index (subject_type, subject_id, facet, title, body) VALUES (?, ?, ?, ?, ?)');
  const aliases = db.prepare('SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY position').all(id).map((r) => r.alias);
  insert.run('entity', id, 'name', row.name, aliases.join(' '));

  const profileParts = [row.summary];
  if (row.type === 'world') {
    const profile = db.prepare('SELECT * FROM world_profiles WHERE entity_id = ?').get(id);
    if (profile) profileParts.push(profile.tagline, profile.genre, profile.tone, profile.setting_description, profile.visual_direction);
  } else if (row.type === 'character') {
    const profile = db.prepare('SELECT * FROM character_profiles WHERE entity_id = ?').get(id);
    if (profile) profileParts.push(profile.role, profile.age_text, profile.appearance, profile.personality, profile.biography, profile.voice);
  }
  const tags = db.prepare(`
    SELECT t.name FROM taggings g JOIN tags t ON t.id = g.tag_id
    WHERE g.subject_type = 'entity' AND g.subject_id = ?
  `).all(id).map((r) => r.name);
  profileParts.push(tags.join(' '));
  const body = profileParts.filter(Boolean).join('\n');
  if (body) insert.run('entity', id, 'profile', row.name, body);
}

/** Reindex one document's title and Markdown body. */
export function syncDocumentIndex(library, id) {
  const db = library.db;
  deleteSubject(db, 'document', id);
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (!row || row.status === 'archived') return;
  const tags = db.prepare(`
    SELECT t.name FROM taggings g JOIN tags t ON t.id = g.tag_id
    WHERE g.subject_type = 'document' AND g.subject_id = ?
  `).all(id).map((r) => r.name).join(' ');
  db.prepare('INSERT INTO search_index (subject_type, subject_id, facet, title, body) VALUES (?, ?, ?, ?, ?)')
    .run('document', id, 'document', row.title, `${row.content_cache}\n${tags}`);
}

/** Reindex one asset: title, filenames, roles, notes, tags. */
export function syncAssetIndex(library, id) {
  const db = library.db;
  deleteSubject(db, 'asset', id);
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  if (!row || row.status === 'archived') return;
  const filenames = db.prepare('SELECT original_filename FROM asset_versions WHERE asset_id = ?').all(id)
    .map((r) => r.original_filename).filter(Boolean);
  const roles = db.prepare('SELECT DISTINCT role FROM asset_links WHERE asset_id = ?').all(id).map((r) => r.role);
  const tags = db.prepare(`
    SELECT t.name FROM taggings g JOIN tags t ON t.id = g.tag_id
    WHERE g.subject_type = 'asset' AND g.subject_id = ?
  `).all(id).map((r) => r.name);
  const body = [...filenames, ...roles, row.notes, ...tags].filter(Boolean).join('\n');
  db.prepare('INSERT INTO search_index (subject_type, subject_id, facet, title, body) VALUES (?, ?, ?, ?, ?)')
    .run('asset', id, 'asset', row.title, body);
}

/** Reindex one relationship's labels and description. */
export function syncRelationshipIndex(library, id) {
  const db = library.db;
  deleteSubject(db, 'relationship', id);
  const row = db.prepare(`
    SELECT r.*, s.name AS source_name, t.name AS target_name
    FROM relationships r JOIN entities s ON s.id = r.source_id JOIN entities t ON t.id = r.target_id
    WHERE r.id = ?
  `).get(id);
  if (!row || row.status === 'archived') return;
  const title = `${row.source_name} — ${row.label || row.rel_type} — ${row.target_name}`;
  const body = [row.rel_type, row.label, row.inverse_label, row.description].filter(Boolean).join('\n');
  db.prepare('INSERT INTO search_index (subject_type, subject_id, facet, title, body) VALUES (?, ?, ?, ?, ?)')
    .run('relationship', id, 'relationship', title, body);
}

/** Drop and repopulate the whole index from source tables. */
export function rebuildSearchIndex(library) {
  const db = library.db;
  const counts = { entities: 0, documents: 0, assets: 0, relationships: 0 };
  const rebuild = db.transaction(() => {
    db.prepare('DELETE FROM search_index').run();
    for (const row of db.prepare('SELECT id FROM entities').all()) {
      syncEntityIndex(library, row.id);
      counts.entities++;
    }
    for (const row of db.prepare('SELECT id FROM documents').all()) {
      syncDocumentIndex(library, row.id);
      counts.documents++;
    }
    for (const row of db.prepare('SELECT id FROM assets').all()) {
      syncAssetIndex(library, row.id);
      counts.assets++;
    }
    for (const row of db.prepare('SELECT id FROM relationships').all()) {
      syncRelationshipIndex(library, row.id);
      counts.relationships++;
    }
  });
  rebuild();
  return counts;
}

/** Escape user text into a safe FTS5 prefix query. */
function toFtsQuery(text) {
  const tokens = text.split(/\s+/).filter(Boolean).slice(0, 8);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replaceAll('"', '')}"*`).join(' ');
}

/**
 * Universal search. Returns grouped results with the matched facet and
 * a snippet explaining why each result matched. Filters: kind (types),
 * world, tag, asset role, lifecycle status, and modified date.
 */
export function searchLibrary(library, { query, types = null, worldId = null, tagId = null, role = null, status = null, modifiedAfter = null, limit = 60 }) {
  const db = library.db;
  const fts = toFtsQuery(query);
  if (!fts) return { groups: [] };

  const rows = db.prepare(`
    SELECT subject_type, subject_id, facet,
           snippet(search_index, 4, '[', ']', '…', 12) AS snip,
           title, bm25(search_index) AS rank
    FROM search_index
    WHERE search_index MATCH ?
    ORDER BY rank
    LIMIT 200
  `).all(fts);

  // Deduplicate: keep the best facet per subject.
  const best = new Map();
  for (const row of rows) {
    const key = `${row.subject_type}:${row.subject_id}`;
    if (!best.has(key)) best.set(key, row);
  }

  const hasTag = db.prepare('SELECT 1 FROM taggings WHERE subject_type = ? AND subject_id = ? AND tag_id = ?');
  const results = [];
  for (const row of best.values()) {
    const enriched = enrich(db, row);
    if (!enriched) continue;
    if (types && !types.includes(enriched.group)) continue;
    if (worldId && enriched.worldId !== worldId && enriched.subjectId !== worldId) continue;
    if (status && enriched.status !== status) continue;
    if (role && !(enriched.group === 'asset' && enriched.roles?.includes(role))) continue;
    if (tagId) {
      const taggable = { world: 'entity', character: 'entity', entry: 'entity', document: 'document', asset: 'asset' }[enriched.group];
      if (!taggable || !hasTag.get(taggable, enriched.subjectId, tagId)) continue;
    }
    if (modifiedAfter && (!enriched.updatedAt || enriched.updatedAt < modifiedAfter)) continue;
    results.push(enriched);
    if (results.length >= limit) break;
  }

  const order = ['world', 'character', 'entry', 'document', 'asset', 'relationship'];
  const groups = [];
  for (const group of order) {
    const items = results.filter((r) => r.group === group);
    if (items.length > 0) groups.push({ group, items });
  }
  return { groups };
}

/** The world a document or asset belongs to, through its links. */
function worldOfLinks(db, links) {
  for (const link of links) {
    if (link.type === 'world') return link.id;
    if (link.world_id) return link.world_id;
  }
  return null;
}

function enrich(db, row) {
  const base = {
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    facet: row.facet,
    snippet: row.snip,
    title: row.title,
  };
  if (row.subject_type === 'entity') {
    const entity = db.prepare('SELECT type, name, status, world_id, updated_at FROM entities WHERE id = ?').get(row.subject_id);
    if (!entity) return null;
    const group = entity.type === 'world' ? 'world' : entity.type === 'character' ? 'character' : 'entry';
    return { ...base, group, title: entity.name, entityType: entity.type, status: entity.status, worldId: entity.world_id, updatedAt: entity.updated_at, href: hrefFor(entity.type, row.subject_id) };
  }
  if (row.subject_type === 'document') {
    const doc = db.prepare('SELECT title, status, updated_at FROM documents WHERE id = ?').get(row.subject_id);
    if (!doc) return null;
    const links = db.prepare(`
      SELECT e.id, e.type, e.world_id FROM document_links l JOIN entities e ON e.id = l.entity_id
      WHERE l.document_id = ? ORDER BY l.position
    `).all(row.subject_id);
    return { ...base, group: 'document', title: doc.title, status: doc.status, worldId: worldOfLinks(db, links), updatedAt: doc.updated_at, href: `/document/${row.subject_id}` };
  }
  if (row.subject_type === 'asset') {
    const asset = db.prepare('SELECT title, kind, status, updated_at FROM assets WHERE id = ?').get(row.subject_id);
    if (!asset) return null;
    const links = db.prepare(`
      SELECT e.id, e.type, e.world_id FROM asset_links l JOIN entities e ON e.id = l.entity_id
      WHERE l.asset_id = ? ORDER BY l.position
    `).all(row.subject_id);
    const roles = db.prepare('SELECT DISTINCT role FROM asset_links WHERE asset_id = ?').all(row.subject_id).map((r) => r.role);
    return { ...base, group: 'asset', title: asset.title, kind: asset.kind, status: asset.status, roles, worldId: worldOfLinks(db, links), updatedAt: asset.updated_at, href: `/asset/${row.subject_id}` };
  }
  if (row.subject_type === 'relationship') {
    const rel = db.prepare(`
      SELECT r.status, r.updated_at, s.world_id AS sw, s.type AS st, s.id AS sid, t.world_id AS tw, t.type AS tt, t.id AS tid
      FROM relationships r JOIN entities s ON s.id = r.source_id JOIN entities t ON t.id = r.target_id
      WHERE r.id = ?
    `).get(row.subject_id);
    if (!rel) return null;
    const worldId = rel.st === 'world' ? rel.sid : rel.tt === 'world' ? rel.tid : (rel.sw ?? rel.tw);
    return { ...base, group: 'relationship', status: rel.status, worldId, updatedAt: rel.updated_at, href: '/relationships' };
  }
  return null;
}

function hrefFor(entityType, id) {
  if (entityType === 'world') return `/world/${id}`;
  if (entityType === 'character') return `/character/${id}`;
  return `/entry/${id}`;
}
