import crypto from 'node:crypto';
import { domainError } from './errors.js';
import { nowIso, inTransaction } from './database-service.js';
import { recordActivity } from './activity-service.js';
import { syncEntityIndex, syncDocumentIndex, syncAssetIndex, removeFromIndex, syncRelationshipIndex } from './search-service.js';
import { slugify } from './paths.js';
import { assetDisplayUrl } from './asset-service.js';

export const ENTITY_TYPES = ['world', 'character', 'location', 'group', 'species', 'object', 'event', 'lore'];
export const ENTRY_TYPES = ['location', 'group', 'species', 'object', 'event', 'lore'];

const WORLD_PROFILE_FIELDS = ['tagline', 'genre', 'tone', 'setting_description', 'visual_direction', 'cover_asset_id', 'background_asset_id'];
const CHARACTER_PROFILE_FIELDS = ['role', 'age_text', 'appearance', 'personality', 'biography', 'voice', 'portrait_asset_id', 'full_body_asset_id'];

/** Generate a slug unique within the entity type namespace. */
function uniqueSlug(db, type, name, excludeId = null) {
  const base = slugify(name, type);
  let candidate = base;
  let counter = 2;
  const query = db.prepare('SELECT id FROM entities WHERE type = ? AND slug = ?');
  for (;;) {
    const existing = query.get(type, candidate);
    if (!existing || existing.id === excludeId) return candidate;
    candidate = `${base}-${counter++}`;
  }
}

export function createEntity(library, { type, name, worldId = null, summary = '' }) {
  const db = library.db;
  if (!ENTITY_TYPES.includes(type)) {
    throw domainError('entity.bad_type', 'Unknown entity type.');
  }
  if (type === 'world' && worldId) {
    throw domainError('entity.world_in_world', 'A world cannot belong to another world.');
  }
  if (worldId) {
    const world = db.prepare(`SELECT id FROM entities WHERE id = ? AND type = 'world'`).get(worldId);
    if (!world) throw domainError('entity.world_missing', 'The chosen world no longer exists.');
  }
  const id = crypto.randomUUID();
  const now = nowIso();
  inTransaction(db, () => {
    db.prepare(`
      INSERT INTO entities (id, type, world_id, name, slug, summary, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)
    `).run(id, type, worldId, name, uniqueSlug(db, type, name), summary, now, now);
    if (type === 'world') {
      db.prepare('INSERT INTO world_profiles (entity_id) VALUES (?)').run(id);
    } else if (type === 'character') {
      db.prepare('INSERT INTO character_profiles (entity_id) VALUES (?)').run(id);
    }
    recordActivity(db, 'entity.created', type, id, name);
    syncEntityIndex(library, id);
  });
  return getEntity(library, id);
}

export function getEntity(library, id) {
  const db = library.db;
  const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
  if (!row) throw domainError('entity.missing', 'That record no longer exists.');
  const entity = baseView(row);

  if (row.type === 'world') {
    entity.profile = db.prepare('SELECT * FROM world_profiles WHERE entity_id = ?').get(id) ?? {};
    delete entity.profile.entity_id;
  } else if (row.type === 'character') {
    entity.profile = db.prepare('SELECT * FROM character_profiles WHERE entity_id = ?').get(id) ?? {};
    delete entity.profile.entity_id;
  } else {
    entity.profile = {};
  }
  entity.aliases = db.prepare('SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY position').all(id).map((r) => r.alias);
  entity.tags = tagsFor(library, 'entity', id);
  entity.artUrl = preferredArtUrl(db, row.type, id);
  if (row.world_id) {
    const world = db.prepare('SELECT id, name, slug FROM entities WHERE id = ?').get(row.world_id);
    entity.world = world ?? null;
  }
  return entity;
}

function baseView(row) {
  return {
    id: row.id,
    type: row.type,
    worldId: row.world_id,
    name: row.name,
    slug: row.slug,
    summary: row.summary,
    status: row.status,
    sortOrder: row.sort_order,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

/**
 * Update base fields, profile fields, and aliases. Renames never change
 * identity. Meaningful changes increment the revision.
 */
export function updateEntity(library, id, patch) {
  const db = library.db;
  const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
  if (!row) throw domainError('entity.missing', 'That record no longer exists.');
  const now = nowIso();

  inTransaction(db, () => {
    let meaningful = false;

    if (patch.name !== undefined && patch.name !== row.name) {
      const name = patch.name.trim();
      if (!name) throw domainError('entity.name_required', 'A name is required.');
      db.prepare('UPDATE entities SET name = ? WHERE id = ?').run(name, id);
      meaningful = true;
    }
    if (patch.slug !== undefined && patch.slug !== row.slug) {
      const slug = slugify(patch.slug, '');
      if (!slug) throw domainError('entity.bad_slug', 'The slug must contain letters or numbers.');
      const clash = db.prepare('SELECT id FROM entities WHERE type = ? AND slug = ? AND id != ?').get(row.type, slug, id);
      if (clash) throw domainError('entity.slug_taken', `Another ${row.type} already uses the slug "${slug}".`);
      db.prepare('UPDATE entities SET slug = ? WHERE id = ?').run(slug, id);
      meaningful = true;
    }
    if (patch.summary !== undefined && patch.summary !== row.summary) {
      db.prepare('UPDATE entities SET summary = ? WHERE id = ?').run(patch.summary, id);
      meaningful = true;
    }
    if (patch.status !== undefined && patch.status !== row.status) {
      if (!['draft', 'canonical', 'archived'].includes(patch.status)) {
        throw domainError('entity.bad_status', 'Unknown lifecycle status.');
      }
      db.prepare('UPDATE entities SET status = ?, archived_at = ? WHERE id = ?')
        .run(patch.status, patch.status === 'archived' ? now : null, id);
      meaningful = true;
    }
    if (patch.worldId !== undefined && patch.worldId !== row.world_id) {
      if (row.type === 'world') throw domainError('entity.world_in_world', 'A world cannot belong to another world.');
      if (patch.worldId) {
        const world = db.prepare(`SELECT id FROM entities WHERE id = ? AND type = 'world'`).get(patch.worldId);
        if (!world) throw domainError('entity.world_missing', 'The chosen world no longer exists.');
      }
      db.prepare('UPDATE entities SET world_id = ? WHERE id = ?').run(patch.worldId, id);
      meaningful = true;
    }
    if (patch.sortOrder !== undefined && patch.sortOrder !== row.sort_order) {
      db.prepare('UPDATE entities SET sort_order = ? WHERE id = ?').run(patch.sortOrder, id);
    }

    if (patch.profile && row.type === 'world') {
      meaningful = applyProfile(db, 'world_profiles', WORLD_PROFILE_FIELDS, id, patch.profile) || meaningful;
    } else if (patch.profile && row.type === 'character') {
      meaningful = applyProfile(db, 'character_profiles', CHARACTER_PROFILE_FIELDS, id, patch.profile) || meaningful;
    }

    if (patch.aliases !== undefined) {
      db.prepare('DELETE FROM entity_aliases WHERE entity_id = ?').run(id);
      const insert = db.prepare('INSERT INTO entity_aliases (entity_id, alias, position) VALUES (?, ?, ?)');
      patch.aliases.forEach((alias, i) => {
        const trimmed = alias.trim();
        if (trimmed) insert.run(id, trimmed, i);
      });
      meaningful = true;
    }

    if (meaningful) {
      db.prepare('UPDATE entities SET revision = revision + 1, updated_at = ? WHERE id = ?').run(now, id);
      recordActivity(db, 'entity.updated', row.type, id, patch.name ?? row.name);
    }
    syncEntityIndex(library, id);
  });
  return getEntity(library, id);
}

function applyProfile(db, table, fields, id, profile) {
  const sets = [];
  const values = [];
  for (const field of fields) {
    const jsKey = field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (profile[jsKey] !== undefined) {
      sets.push(`${field} = ?`);
      values.push(profile[jsKey] === '' && field.endsWith('_asset_id') ? null : profile[jsKey]);
    }
  }
  if (sets.length === 0) return false;
  db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE entity_id = ?`).run(...values, id);
  return true;
}

export function listEntities(library, { type, types, worldId, status, tagId, limit = 500, offset = 0 } = {}) {
  const db = library.db;
  const where = [];
  const args = [];
  if (type) { where.push('e.type = ?'); args.push(type); }
  if (types) { where.push(`e.type IN (${types.map(() => '?').join(',')})`); args.push(...types); }
  if (worldId) { where.push('e.world_id = ?'); args.push(worldId); }
  if (status) { where.push('e.status = ?'); args.push(status); }
  else { where.push(`e.status != 'archived'`); }
  if (tagId) {
    where.push(`EXISTS (SELECT 1 FROM taggings t WHERE t.subject_type = 'entity' AND t.subject_id = e.id AND t.tag_id = ?)`);
    args.push(tagId);
  }
  const rows = db.prepare(`
    SELECT e.*, w.name AS world_name
    FROM entities e LEFT JOIN entities w ON w.id = e.world_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY e.sort_order, e.name COLLATE NOCASE
    LIMIT ? OFFSET ?
  `).all(...args, limit, offset);
  return rows.map((row) => ({
    ...baseView(row),
    worldName: row.world_name ?? null,
    artUrl: preferredArtUrl(db, row.type, row.id),
  }));
}

/** Preferred art for browsing: world cover or character portrait. */
function preferredArtUrl(db, type, id) {
  if (type === 'world') {
    const profile = db.prepare('SELECT cover_asset_id, background_asset_id FROM world_profiles WHERE entity_id = ?').get(id);
    return assetDisplayUrl(db, profile?.cover_asset_id) ?? assetDisplayUrl(db, profile?.background_asset_id);
  }
  if (type === 'character') {
    const profile = db.prepare('SELECT portrait_asset_id, full_body_asset_id FROM character_profiles WHERE entity_id = ?').get(id);
    return assetDisplayUrl(db, profile?.portrait_asset_id) ?? assetDisplayUrl(db, profile?.full_body_asset_id);
  }
  const linked = db.prepare(`
    SELECT l.asset_id FROM asset_links l
    JOIN assets a ON a.id = l.asset_id
    WHERE l.entity_id = ? AND a.kind = 'image' AND a.status = 'active'
    ORDER BY l.position LIMIT 1
  `).get(id);
  return assetDisplayUrl(db, linked?.asset_id);
}

/** Everything that references this entity, for Usage views and archive confirmations. */
export function entityUsage(library, id) {
  const db = library.db;
  const documents = db.prepare(`
    SELECT d.id, d.title, d.status FROM documents d
    JOIN document_links l ON l.document_id = d.id
    WHERE l.entity_id = ? ORDER BY d.title COLLATE NOCASE
  `).all(id);
  const relationships = db.prepare(`
    SELECT r.id, r.label, r.rel_type, r.source_id, r.target_id,
           s.name AS source_name, t.name AS target_name
    FROM relationships r
    JOIN entities s ON s.id = r.source_id
    JOIN entities t ON t.id = r.target_id
    WHERE r.source_id = ? OR r.target_id = ?
    ORDER BY r.position
  `).all(id, id);
  const assets = db.prepare(`
    SELECT a.id, a.title, a.kind, l.role FROM assets a
    JOIN asset_links l ON l.asset_id = a.id
    WHERE l.entity_id = ? ORDER BY a.title COLLATE NOCASE
  `).all(id);
  const productions = db.prepare(`
    SELECT DISTINCT p.id, p.name, p.status FROM productions p
    JOIN production_entities pe ON pe.production_id = p.id
    WHERE pe.entity_id = ? OR p.world_id = ?
    ORDER BY p.name COLLATE NOCASE
  `).all(id, id);
  const children = db.prepare(`
    SELECT id, type, name, status FROM entities WHERE world_id = ? ORDER BY name COLLATE NOCASE
  `).all(id);
  return { documents, relationships, assets, productions, children };
}

/** Archive an entity. The caller must show entityUsage() first. */
export function archiveEntity(library, id) {
  return updateEntity(library, id, { status: 'archived' });
}

export function restoreEntity(library, id) {
  const db = library.db;
  const row = db.prepare('SELECT status FROM entities WHERE id = ?').get(id);
  if (!row) throw domainError('entity.missing', 'That record no longer exists.');
  return updateEntity(library, id, { status: 'draft' });
}

/* ---------------- relationships ---------------- */

export function createRelationship(library, { sourceId, targetId, relType, label = '', description = '', inverseLabel = '' }) {
  const db = library.db;
  if (sourceId === targetId) throw domainError('relationship.self', 'A record cannot relate to itself.');
  for (const endpoint of [sourceId, targetId]) {
    if (!db.prepare('SELECT id FROM entities WHERE id = ?').get(endpoint)) {
      throw domainError('entity.missing', 'One side of the relationship no longer exists.');
    }
  }
  const id = crypto.randomUUID();
  const now = nowIso();
  const position = (db.prepare('SELECT MAX(position) p FROM relationships WHERE source_id = ?').get(sourceId)?.p ?? -1) + 1;
  inTransaction(db, () => {
    db.prepare(`
      INSERT INTO relationships (id, source_id, target_id, rel_type, label, description, inverse_label, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, sourceId, targetId, relType, label, description, inverseLabel, position, now, now);
    recordActivity(db, 'relationship.created', 'relationship', id, relType);
    syncRelationshipIndex(library, id);
  });
  return getRelationship(library, id);
}

export function getRelationship(library, id) {
  const row = library.db.prepare(`
    SELECT r.*, s.name AS source_name, s.type AS source_type, t.name AS target_name, t.type AS target_type
    FROM relationships r
    JOIN entities s ON s.id = r.source_id
    JOIN entities t ON t.id = r.target_id
    WHERE r.id = ?
  `).get(id);
  if (!row) throw domainError('relationship.missing', 'That relationship no longer exists.');
  return relationshipView(row);
}

function relationshipView(row) {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    sourceName: row.source_name,
    targetName: row.target_name,
    sourceType: row.source_type,
    targetType: row.target_type,
    relType: row.rel_type,
    label: row.label,
    description: row.description,
    inverseLabel: row.inverse_label,
    position: row.position,
    status: row.status,
  };
}

export function updateRelationship(library, id, patch) {
  const db = library.db;
  const row = db.prepare('SELECT * FROM relationships WHERE id = ?').get(id);
  if (!row) throw domainError('relationship.missing', 'That relationship no longer exists.');
  const fields = { rel_type: patch.relType, label: patch.label, description: patch.description, inverse_label: patch.inverseLabel, position: patch.position, status: patch.status };
  const sets = [];
  const values = [];
  for (const [column, value] of Object.entries(fields)) {
    if (value !== undefined) { sets.push(`${column} = ?`); values.push(value); }
  }
  if (sets.length > 0) {
    inTransaction(db, () => {
      db.prepare(`UPDATE relationships SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
      syncRelationshipIndex(library, id);
    });
  }
  return getRelationship(library, id);
}

export function deleteRelationship(library, id) {
  const db = library.db;
  inTransaction(db, () => {
    db.prepare('DELETE FROM relationships WHERE id = ?').run(id);
    removeFromIndex(library, 'relationship', id);
    recordActivity(db, 'relationship.deleted', 'relationship', id);
  });
  return { deleted: true };
}

export function listRelationships(library, { entityId, relType, worldId, limit = 500 } = {}) {
  const db = library.db;
  const where = [];
  const args = [];
  if (entityId) { where.push('(r.source_id = ? OR r.target_id = ?)'); args.push(entityId, entityId); }
  if (relType) { where.push('r.rel_type = ?'); args.push(relType); }
  if (worldId) { where.push('(s.world_id = ? OR t.world_id = ? OR s.id = ? OR t.id = ?)'); args.push(worldId, worldId, worldId, worldId); }
  const rows = db.prepare(`
    SELECT r.*, s.name AS source_name, s.type AS source_type, t.name AS target_name, t.type AS target_type
    FROM relationships r
    JOIN entities s ON s.id = r.source_id
    JOIN entities t ON t.id = r.target_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY r.position, r.created_at
    LIMIT ?
  `).all(...args, limit);
  return rows.map(relationshipView);
}

export function listRelationshipTypes(library) {
  return library.db.prepare('SELECT DISTINCT rel_type FROM relationships ORDER BY rel_type').all().map((r) => r.rel_type);
}

/* ---------------- tags ---------------- */

export function ensureTag(library, name, groupName = '') {
  const db = library.db;
  const trimmed = name.trim();
  if (!trimmed) throw domainError('tag.name_required', 'A tag needs a name.');
  const existing = db.prepare('SELECT * FROM tags WHERE name = ?').get(trimmed);
  if (existing) return { id: existing.id, name: existing.name, groupName: existing.group_name };
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO tags (id, name, group_name, created_at) VALUES (?, ?, ?, ?)').run(id, trimmed, groupName, nowIso());
  return { id, name: trimmed, groupName };
}

export function listTags(library) {
  return library.db.prepare(`
    SELECT t.id, t.name, t.group_name AS groupName, COUNT(g.id) AS uses
    FROM tags t LEFT JOIN taggings g ON g.tag_id = t.id
    GROUP BY t.id ORDER BY t.group_name, t.name COLLATE NOCASE
  `).all();
}

export function setSubjectTags(library, subjectType, subjectId, tagNames) {
  const db = library.db;
  inTransaction(db, () => {
    const before = tagsFor(library, subjectType, subjectId).map((tag) => tag.name).sort().join('\n');
    db.prepare('DELETE FROM taggings WHERE subject_type = ? AND subject_id = ?').run(subjectType, subjectId);
    const insert = db.prepare('INSERT OR IGNORE INTO taggings (tag_id, subject_type, subject_id) VALUES (?, ?, ?)');
    for (const name of tagNames) {
      const tag = ensureTag(library, name);
      insert.run(tag.id, subjectType, subjectId);
    }
    const after = tagsFor(library, subjectType, subjectId).map((tag) => tag.name).sort().join('\n');
    const changed = before !== after;

    if (subjectType === 'entity') {
      if (changed) {
        // Entity tags are published at a claimed revision, so a tag
        // change is a meaningful canonical change.
        db.prepare('UPDATE entities SET revision = revision + 1, updated_at = ? WHERE id = ?').run(nowIso(), subjectId);
      }
      syncEntityIndex(library, subjectId);
    } else if (subjectType === 'document') {
      if (changed) db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').run(nowIso(), subjectId);
      syncDocumentIndex(library, subjectId);
    } else if (subjectType === 'asset') {
      if (changed) db.prepare('UPDATE assets SET updated_at = ? WHERE id = ?').run(nowIso(), subjectId);
      syncAssetIndex(library, subjectId);
    }
  });
  return tagsFor(library, subjectType, subjectId);
}

export function tagsFor(library, subjectType, subjectId) {
  return library.db.prepare(`
    SELECT t.id, t.name, t.group_name AS groupName
    FROM taggings g JOIN tags t ON t.id = g.tag_id
    WHERE g.subject_type = ? AND g.subject_id = ?
    ORDER BY t.name COLLATE NOCASE
  `).all(subjectType, subjectId);
}
