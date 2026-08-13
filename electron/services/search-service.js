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
  if (!row) return;
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
 * a snippet explaining why each result matched.
 */
export function searchLibrary(library, { query, types = null, worldId = null, limit = 60 }) {
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

  const results = [];
  for (const row of best.values()) {
    const enriched = enrich(db, row);
    if (!enriched) continue;
    if (types && !types.includes(enriched.group)) continue;
    if (worldId && enriched.worldId && enriched.worldId !== worldId && enriched.subjectId !== worldId) continue;
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

function enrich(db, row) {
  const base = {
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    facet: row.facet,
    snippet: row.snip,
    title: row.title,
  };
  if (row.subject_type === 'entity') {
    const entity = db.prepare('SELECT type, name, status, world_id FROM entities WHERE id = ?').get(row.subject_id);
    if (!entity) return null;
    const group = entity.type === 'world' ? 'world' : entity.type === 'character' ? 'character' : 'entry';
    return { ...base, group, title: entity.name, entityType: entity.type, status: entity.status, worldId: entity.world_id, href: hrefFor(entity.type, row.subject_id) };
  }
  if (row.subject_type === 'document') {
    const doc = db.prepare('SELECT title, status FROM documents WHERE id = ?').get(row.subject_id);
    if (!doc) return null;
    return { ...base, group: 'document', title: doc.title, status: doc.status, worldId: null, href: `/document/${row.subject_id}` };
  }
  if (row.subject_type === 'asset') {
    const asset = db.prepare('SELECT title, kind, status FROM assets WHERE id = ?').get(row.subject_id);
    if (!asset) return null;
    return { ...base, group: 'asset', title: asset.title, kind: asset.kind, status: asset.status, worldId: null, href: `/asset/${row.subject_id}` };
  }
  if (row.subject_type === 'relationship') {
    return { ...base, group: 'relationship', worldId: null, href: '/relationships' };
  }
  return null;
}

function hrefFor(entityType, id) {
  if (entityType === 'world') return `/world/${id}`;
  if (entityType === 'character') return `/character/${id}`;
  return `/entry/${id}`;
}
