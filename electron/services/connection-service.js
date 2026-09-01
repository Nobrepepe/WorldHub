import crypto from 'node:crypto';
import { domainError } from './errors.js';
import { nowIso, inTransaction } from './database-service.js';
import { recordActivity } from './activity-service.js';
import { syncConnectionIndex, removeFromIndex } from './search-service.js';
import { slugify } from './paths.js';
import {
  connectionCategories, CONNECTION_CATEGORY_IDS, sentenceFor, builtinConnectionKinds,
} from './connection-vocabulary.js';

/**
 * Canonical connections: one typed fact between two records.
 *
 * A connection names a reusable *kind*, and the kind carries everything the
 * old free-text relationship made each record carry for itself — the labels,
 * the category, the heading each side is presented under, and the entity type
 * pairs it may join. Two things follow, and they are the point of the design:
 * orientation is *read* from the kind rather than chosen, so the same fact
 * filed from either endpoint produces one identical row; and a pair the kind
 * does not allow cannot be saved at all.
 *
 * Nothing here exposes source and target outside the audit view. A caller
 * says "this record, that counterpart, this kind" and gets back the fact
 * written from its own side.
 */

export const CONNECTION_STATUSES = ['draft', 'canonical', 'archived'];

/* ---------------- kinds ---------------- */

function kindRowView(db, row) {
  const pairs = db.prepare(
    'SELECT source_type, target_type FROM connection_kind_pairs WHERE kind_id = ? ORDER BY source_type, target_type')
    .all(row.id)
    .map((pair) => ({ sourceType: pair.source_type, targetType: pair.target_type }));
  return {
    id: row.id,
    category: row.category,
    forwardLabel: row.forward_label,
    inverseLabel: row.inverse_label,
    forwardSection: row.forward_section,
    inverseSection: row.inverse_section,
    sentence: row.sentence,
    symmetric: !!row.symmetric,
    builtin: !!row.is_builtin,
    legacy: !!row.is_legacy,
    pairs,
    uses: row.uses ?? undefined,
  };
}

export function getConnectionKind(library, id) {
  const row = library.db.prepare('SELECT * FROM connection_kinds WHERE id = ?').get(id);
  if (!row) throw domainError('connection.kind_missing', 'That kind of connection no longer exists.');
  return kindRowView(library.db, row);
}

export function listConnectionKinds(library, { category = null, sourceType = null, targetType = null, includeLegacy = true } = {}) {
  const db = library.db;
  const where = [];
  const args = [];
  if (category) { where.push('k.category = ?'); args.push(category); }
  if (!includeLegacy) where.push('k.is_legacy = 0');
  if (sourceType || targetType) {
    const pairWhere = [];
    if (sourceType) { pairWhere.push('p.source_type = ?'); args.push(sourceType); }
    if (targetType) { pairWhere.push('p.target_type = ?'); args.push(targetType); }
    where.push(`EXISTS (SELECT 1 FROM connection_kind_pairs p WHERE p.kind_id = k.id AND ${pairWhere.join(' AND ')})`);
  }
  const rows = db.prepare(`
    SELECT k.*, (SELECT COUNT(*) FROM connections c WHERE c.kind_id = k.id) AS uses
    FROM connection_kinds k
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY k.is_legacy, k.category, k.forward_label COLLATE NOCASE
  `).all(...args);
  return rows.map((row) => kindRowView(db, row));
}

/**
 * The kinds usable from a record of this type, each already turned around to
 * face it. `role` says which side this type sits on, so the drawer can offer
 * "Add a member" on a group and "Add an affiliation" on a character from one
 * definition — and `counterpartTypes` is exactly what the entity picker may
 * offer, so an impossible pair is never presented in the first place.
 */
export function kindsForEndpoint(library, entityType, { category = null, includeLegacy = false } = {}) {
  const offered = [];
  for (const kind of listConnectionKinds(library, { category, includeLegacy })) {
    const forwardTargets = kind.pairs.filter((pair) => pair.sourceType === entityType).map((pair) => pair.targetType);
    const inverseSources = kind.pairs.filter((pair) => pair.targetType === entityType).map((pair) => pair.sourceType);
    if (forwardTargets.length === 0 && inverseSources.length === 0) continue;
    const role = forwardTargets.length > 0 && inverseSources.length > 0 ? 'either'
      : forwardTargets.length > 0 ? 'source' : 'target';
    offered.push({
      ...kind,
      role,
      label: role === 'target' ? kind.inverseLabel : kind.forwardLabel,
      section: role === 'target' ? kind.inverseSection : kind.forwardSection,
      counterpartTypes: [...new Set([...forwardTargets, ...inverseSources])].sort(),
    });
  }
  return offered;
}

export function createConnectionKind(library, {
  id = null, category, forwardLabel, inverseLabel,
  forwardSection = '', inverseSection = '', sentence = '', symmetric = false, pairs,
}) {
  const db = library.db;
  if (!CONNECTION_CATEGORY_IDS.includes(category)) {
    throw domainError('connection.kind_bad_category', 'That is not a known kind of connection category.');
  }
  if (!forwardLabel.trim()) throw domainError('connection.kind_label_required', 'A connection kind needs a label.');
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw domainError('connection.kind_pairs_required', 'A connection kind must say which kinds of record it can join.');
  }
  const kindId = slugify(id || forwardLabel, 'connection').replaceAll('-', '_');
  if (db.prepare('SELECT id FROM connection_kinds WHERE id = ?').get(kindId)) {
    throw domainError('connection.kind_taken', `A kind of connection called "${kindId}" already exists.`);
  }
  const fallback = connectionCategories().find((entry) => entry.id === category)?.section ?? 'Connections';
  const now = nowIso();
  inTransaction(db, () => {
    db.prepare(`
      INSERT INTO connection_kinds (id, category, forward_label, inverse_label, forward_section,
                                    inverse_section, sentence, symmetric, is_builtin, is_legacy,
                                    created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
    `).run(kindId, category, forwardLabel.trim(), (inverseLabel || forwardLabel).trim(),
      forwardSection || fallback, inverseSection || fallback, sentence, symmetric ? 1 : 0, now, now);
    const insertPair = db.prepare(
      'INSERT OR IGNORE INTO connection_kind_pairs (kind_id, source_type, target_type) VALUES (?, ?, ?)');
    for (const pair of pairs) insertPair.run(kindId, pair.sourceType, pair.targetType);
    recordActivity(db, 'connection.kind_created', 'connection_kind', kindId, forwardLabel);
  });
  return getConnectionKind(library, kindId);
}

export function updateConnectionKind(library, id, patch) {
  const db = library.db;
  const row = db.prepare('SELECT * FROM connection_kinds WHERE id = ?').get(id);
  if (!row) throw domainError('connection.kind_missing', 'That kind of connection no longer exists.');
  const fields = {
    category: patch.category,
    forward_label: patch.forwardLabel,
    inverse_label: patch.inverseLabel,
    forward_section: patch.forwardSection,
    inverse_section: patch.inverseSection,
    sentence: patch.sentence,
    symmetric: patch.symmetric === undefined ? undefined : (patch.symmetric ? 1 : 0),
  };
  if (fields.category !== undefined && !CONNECTION_CATEGORY_IDS.includes(fields.category)) {
    throw domainError('connection.kind_bad_category', 'That is not a known kind of connection category.');
  }
  const sets = [];
  const values = [];
  for (const [column, value] of Object.entries(fields)) {
    if (value !== undefined) { sets.push(`${column} = ?`); values.push(value); }
  }
  inTransaction(db, () => {
    if (sets.length > 0) {
      db.prepare(`UPDATE connection_kinds SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...values, nowIso(), id);
    }
    if (patch.pairs !== undefined) {
      /* Narrowing the allowed pairs cannot orphan a fact that is already
         filed, so the pairs still in use are refused rather than dropped. */
      const wanted = new Set(patch.pairs.map((pair) => `${pair.sourceType}:${pair.targetType}`));
      const inUse = db.prepare(`
        SELECT DISTINCT s.type AS source_type, t.type AS target_type
        FROM connections c JOIN entities s ON s.id = c.source_id JOIN entities t ON t.id = c.target_id
        WHERE c.kind_id = ?
      `).all(id);
      for (const pair of inUse) {
        if (!wanted.has(`${pair.source_type}:${pair.target_type}`)) {
          throw domainError('connection.kind_pair_in_use',
            `Connections already join ${withArticle(pair.source_type)} to ${withArticle(pair.target_type)} under this kind, so that combination cannot be removed.`);
        }
      }
      db.prepare('DELETE FROM connection_kind_pairs WHERE kind_id = ?').run(id);
      const insertPair = db.prepare(
        'INSERT OR IGNORE INTO connection_kind_pairs (kind_id, source_type, target_type) VALUES (?, ?, ?)');
      for (const pair of patch.pairs) insertPair.run(id, pair.sourceType, pair.targetType);
    }
    for (const connection of db.prepare('SELECT id FROM connections WHERE kind_id = ?').all(id)) {
      syncConnectionIndex(library, connection.id);
    }
  });
  return getConnectionKind(library, id);
}

export function deleteConnectionKind(library, id) {
  const db = library.db;
  const row = db.prepare('SELECT * FROM connection_kinds WHERE id = ?').get(id);
  if (!row) throw domainError('connection.kind_missing', 'That kind of connection no longer exists.');
  if (row.is_builtin) throw domainError('connection.kind_builtin', 'Built-in kinds of connection cannot be removed.');
  const uses = db.prepare('SELECT COUNT(*) n FROM connections WHERE kind_id = ?').get(id).n;
  if (uses > 0) {
    throw domainError('connection.kind_in_use',
      `${uses} connection(s) still use this kind. Merge it into another kind first — nothing is deleted by merging.`);
  }
  inTransaction(db, () => {
    db.prepare('DELETE FROM connection_kinds WHERE id = ?').run(id);
    recordActivity(db, 'connection.kind_deleted', 'connection_kind', id, row.forward_label);
  });
  return { deleted: true };
}

/**
 * Move every connection off one kind and onto another, then retire the kind
 * it left. This is how the legacy kinds the upgrade minted are normalised:
 * the migration would not guess that "guards" and "watches over" were the
 * same fact, so it made both, and this is where somebody who knows says so.
 *
 * A record whose own labels disagreed with its old kind keeps them, because
 * they were preserved precisely so a merge would not quietly rewrite text
 * nobody had reread.
 */
export function mergeConnectionKinds(library, fromId, toId) {
  const db = library.db;
  if (fromId === toId) throw domainError('connection.merge_same', 'That is the same kind of connection.');
  const from = db.prepare('SELECT * FROM connection_kinds WHERE id = ?').get(fromId);
  const to = db.prepare('SELECT * FROM connection_kinds WHERE id = ?').get(toId);
  if (!from || !to) throw domainError('connection.kind_missing', 'That kind of connection no longer exists.');
  if (from.is_builtin) throw domainError('connection.kind_builtin', 'A built-in kind cannot be merged away.');

  const allowed = new Set(db.prepare('SELECT source_type, target_type FROM connection_kind_pairs WHERE kind_id = ?')
    .all(toId).map((pair) => `${pair.source_type}:${pair.target_type}`));
  const moving = db.prepare(`
    SELECT c.id, c.source_id, c.target_id, s.type AS source_type, t.type AS target_type,
           s.name AS source_name, t.name AS target_name
    FROM connections c JOIN entities s ON s.id = c.source_id JOIN entities t ON t.id = c.target_id
    WHERE c.kind_id = ?
  `).all(fromId);
  for (const row of moving) {
    if (!allowed.has(`${row.source_type}:${row.target_type}`)) {
      throw domainError('connection.merge_incompatible',
        `“${to.forward_label}” does not join ${withArticle(row.source_type)} to ${withArticle(row.target_type)}, which is how ${row.source_name} and ${row.target_name} are connected. Widen that kind first.`);
    }
  }

  inTransaction(db, () => {
    db.prepare('UPDATE connections SET kind_id = ?, updated_at = ? WHERE kind_id = ?').run(toId, nowIso(), fromId);
    db.prepare('DELETE FROM connection_kinds WHERE id = ?').run(fromId);
    for (const row of moving) syncConnectionIndex(library, row.id);
    recordActivity(db, 'connection.kinds_merged', 'connection_kind', toId,
      `${from.forward_label} → ${to.forward_label} (${moving.length})`);
  });
  return { merged: moving.length, kind: getConnectionKind(library, toId) };
}

/* ---------------- orientation ---------------- */

/**
 * Which way round the kind says this fact runs.
 *
 * Returns the pair the caller's two records satisfy, and whether both orders
 * would be legal. Ambiguity is real and worth naming: two characters can be
 * either side of `parent_of`, so the drawer offers a swap. It is never a
 * reason to ask an author about a database column.
 */
export function orientConnection(kind, aType, bType) {
  const forward = kind.pairs.some((pair) => pair.sourceType === aType && pair.targetType === bType);
  const inverse = kind.pairs.some((pair) => pair.sourceType === bType && pair.targetType === aType);
  return { forward, inverse, ambiguous: forward && inverse };
}

/** "a character", "an object" — these sentences are read by people. */
function withArticle(entityType) {
  return `${'aeiou'.includes(entityType[0]) ? 'an' : 'a'} ${entityType}`;
}

function requireEntity(db, id, what) {
  const row = db.prepare('SELECT id, type, name, world_id FROM entities WHERE id = ?').get(id);
  if (!row) throw domainError('entity.missing', `${what} no longer exists.`);
  return row;
}

/* ---------------- connections ---------------- */

export function createConnection(library, {
  kindId, entityId, counterpartId, description = '', orientation = 'forward', status = 'canonical',
}) {
  const db = library.db;
  if (entityId === counterpartId) throw domainError('connection.self', 'A record cannot connect to itself.');
  const kind = getConnectionKind(library, kindId);
  const entity = requireEntity(db, entityId, 'One side of this connection');
  const counterpart = requireEntity(db, counterpartId, 'One side of this connection');

  const orient = orientConnection(kind, entity.type, counterpart.type);
  if (!orient.forward && !orient.inverse) {
    throw domainError('connection.incompatible',
      `“${kind.forwardLabel}” does not join ${withArticle(entity.type)} to ${withArticle(counterpart.type)}.`);
  }
  const useInverse = orient.ambiguous ? orientation === 'inverse' : !orient.forward;
  const sourceId = useInverse ? counterpart.id : entity.id;
  const targetId = useInverse ? entity.id : counterpart.id;

  const duplicate = kind.symmetric
    ? db.prepare(`
        SELECT id FROM connections WHERE kind_id = ?
          AND ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))
      `).get(kindId, sourceId, targetId, targetId, sourceId)
    : db.prepare('SELECT id FROM connections WHERE kind_id = ? AND source_id = ? AND target_id = ?')
      .get(kindId, sourceId, targetId);
  if (duplicate) {
    throw domainError('connection.duplicate',
      `${entity.name} and ${counterpart.name} are already connected that way.`);
  }

  const id = crypto.randomUUID();
  const now = nowIso();
  const position = (db.prepare('SELECT MAX(position) p FROM connections WHERE source_id = ?').get(sourceId)?.p ?? -1) + 1;
  inTransaction(db, () => {
    db.prepare(`
      INSERT INTO connections (id, kind_id, source_id, target_id, description, position, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, kindId, sourceId, targetId, description, position, status, now, now);
    recordActivity(db, 'connection.created', 'connection', id,
      sentenceFor(kind, sourceId === entity.id ? entity.name : counterpart.name,
        sourceId === entity.id ? counterpart.name : entity.name));
    syncConnectionIndex(library, id);
  });
  return getConnection(library, id);
}

const CONNECTION_SELECT = `
  SELECT c.*, k.category, k.forward_label, k.inverse_label, k.forward_section, k.inverse_section,
         k.sentence, k.symmetric, k.is_legacy, k.is_builtin,
         s.name AS source_name, s.type AS source_type, s.world_id AS source_world_id,
         t.name AS target_name, t.type AS target_type, t.world_id AS target_world_id
  FROM connections c
  JOIN connection_kinds k ON k.id = c.kind_id
  JOIN entities s ON s.id = c.source_id
  JOIN entities t ON t.id = c.target_id
`;

function connectionView(row) {
  return {
    id: row.id,
    kindId: row.kind_id,
    category: row.category,
    sourceId: row.source_id,
    targetId: row.target_id,
    sourceName: row.source_name,
    targetName: row.target_name,
    sourceType: row.source_type,
    targetType: row.target_type,
    label: row.label_override || row.forward_label,
    inverseLabel: row.inverse_label_override || row.inverse_label,
    labelOverride: row.label_override,
    inverseLabelOverride: row.inverse_label_override,
    description: row.description,
    position: row.position,
    status: row.status,
    symmetric: !!row.symmetric,
    legacy: !!row.is_legacy,
    sentence: sentenceFor(
      { sentence: row.sentence, forwardLabel: row.label_override || row.forward_label },
      row.source_name, row.target_name),
  };
}

/**
 * The same fact written from one record's own side: the counterpart it names,
 * the label that record wears, and the heading it belongs under. A symmetric
 * kind reads forward from both sides, which is what symmetric means.
 */
function perspectiveView(row, viewerId) {
  const isSource = row.source_id === viewerId;
  const forward = isSource || !!row.symmetric;
  return {
    id: row.id,
    kindId: row.kind_id,
    category: row.category,
    direction: isSource ? 'forward' : 'inverse',
    symmetric: !!row.symmetric,
    legacy: !!row.is_legacy,
    section: isSource ? row.forward_section : row.inverse_section,
    label: forward
      ? (row.label_override || row.forward_label)
      : (row.inverse_label_override || row.inverse_label),
    otherId: isSource ? row.target_id : row.source_id,
    otherName: isSource ? row.target_name : row.source_name,
    otherType: isSource ? row.target_type : row.source_type,
    otherWorldId: isSource ? row.target_world_id : row.source_world_id,
    description: row.description,
    position: row.position,
    status: row.status,
    sentence: sentenceFor(
      { sentence: row.sentence, forwardLabel: row.label_override || row.forward_label },
      row.source_name, row.target_name),
  };
}

export function getConnection(library, id) {
  const row = library.db.prepare(`${CONNECTION_SELECT} WHERE c.id = ?`).get(id);
  if (!row) throw domainError('connection.missing', 'That connection no longer exists.');
  return connectionView(row);
}

export function updateConnection(library, id, patch) {
  const db = library.db;
  const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(id);
  if (!row) throw domainError('connection.missing', 'That connection no longer exists.');

  let sourceId = row.source_id;
  let targetId = row.target_id;
  let kindId = row.kind_id;

  if (patch.kindId !== undefined && patch.kindId !== row.kind_id) kindId = patch.kindId;
  if (patch.counterpartId !== undefined || patch.viewerId !== undefined) {
    /* Changing who a fact points at is expressed from the side the author is
       looking at, so the caller names its own record and the new counterpart
       and never has to know which column it currently occupies. */
    const viewerId = patch.viewerId ?? (row.source_id);
    const counterpartId = patch.counterpartId ?? (viewerId === row.source_id ? row.target_id : row.source_id);
    if (viewerId === counterpartId) throw domainError('connection.self', 'A record cannot connect to itself.');
    const kind = getConnectionKind(library, kindId);
    const viewer = requireEntity(db, viewerId, 'One side of this connection');
    const counterpart = requireEntity(db, counterpartId, 'One side of this connection');
    const orient = orientConnection(kind, viewer.type, counterpart.type);
    if (!orient.forward && !orient.inverse) {
      throw domainError('connection.incompatible',
        `“${kind.forwardLabel}” does not join ${withArticle(viewer.type)} to ${withArticle(counterpart.type)}.`);
    }
    const useInverse = orient.ambiguous ? patch.orientation === 'inverse' : !orient.forward;
    sourceId = useInverse ? counterpart.id : viewer.id;
    targetId = useInverse ? viewer.id : counterpart.id;
  } else if (kindId !== row.kind_id) {
    const kind = getConnectionKind(library, kindId);
    const source = requireEntity(db, row.source_id, 'One side of this connection');
    const target = requireEntity(db, row.target_id, 'One side of this connection');
    const orient = orientConnection(kind, source.type, target.type);
    if (!orient.forward && !orient.inverse) {
      throw domainError('connection.incompatible',
        `“${kind.forwardLabel}” does not join ${withArticle(source.type)} to ${withArticle(target.type)}.`);
    }
    if (!orient.forward) { sourceId = row.target_id; targetId = row.source_id; }
  }

  if (kindId !== row.kind_id || sourceId !== row.source_id || targetId !== row.target_id) {
    const clash = db.prepare(
      'SELECT id FROM connections WHERE kind_id = ? AND source_id = ? AND target_id = ? AND id != ?')
      .get(kindId, sourceId, targetId, id);
    if (clash) throw domainError('connection.duplicate', 'Those records are already connected that way.');
  }

  const fields = {
    kind_id: kindId,
    source_id: sourceId,
    target_id: targetId,
    description: patch.description,
    label_override: patch.labelOverride,
    inverse_label_override: patch.inverseLabelOverride,
    position: patch.position,
    status: patch.status,
  };
  const sets = [];
  const values = [];
  for (const [column, value] of Object.entries(fields)) {
    if (value !== undefined) { sets.push(`${column} = ?`); values.push(value); }
  }
  if (sets.length > 0) {
    inTransaction(db, () => {
      db.prepare(`UPDATE connections SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
      syncConnectionIndex(library, id);
    });
  }
  return getConnection(library, id);
}

export function deleteConnection(library, id) {
  const db = library.db;
  inTransaction(db, () => {
    db.prepare('DELETE FROM connections WHERE id = ?').run(id);
    removeFromIndex(library, 'connection', id);
    recordActivity(db, 'connection.deleted', 'connection', id);
  });
  return { deleted: true };
}

/** The audit listing. This is the one place direction is shown. */
export function listConnections(library, {
  entityId = null, kindId = null, category = null, worldId = null,
  sourceType = null, targetType = null, nameQuery = null, status = null,
  legacyOnly = false, customOnly = false, limit = 500,
} = {}) {
  const db = library.db;
  const where = [];
  const args = [];
  if (entityId) { where.push('(c.source_id = ? OR c.target_id = ?)'); args.push(entityId, entityId); }
  if (kindId) { where.push('c.kind_id = ?'); args.push(kindId); }
  if (category) { where.push('k.category = ?'); args.push(category); }
  if (worldId) {
    where.push('(s.world_id = ? OR t.world_id = ? OR s.id = ? OR t.id = ?)');
    args.push(worldId, worldId, worldId, worldId);
  }
  if (sourceType) { where.push('s.type = ?'); args.push(sourceType); }
  if (targetType) { where.push('t.type = ?'); args.push(targetType); }
  if (status) { where.push('c.status = ?'); args.push(status); }
  if (legacyOnly) where.push('k.is_legacy = 1');
  if (customOnly) where.push('k.is_builtin = 0 AND k.is_legacy = 0');
  if (nameQuery) {
    where.push('(s.name LIKE ? ESCAPE \'\\\' OR t.name LIKE ? ESCAPE \'\\\')');
    const like = `%${String(nameQuery).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    args.push(like, like);
  }
  const rows = db.prepare(`
    ${CONNECTION_SELECT}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.position, c.created_at
    LIMIT ?
  `).all(...args, limit);
  return rows.map(connectionView);
}

/**
 * Every connection one record holds, written from its side and grouped under
 * the headings the kinds name. The section order follows the vocabulary's
 * category order, so a character's People always precede its Affiliations and
 * a group opens on its Members — without any screen holding a list of
 * headings of its own.
 */
export function connectionsForEntity(library, entityId, { includeArchived = false } = {}) {
  const db = library.db;
  const rows = db.prepare(`
    ${CONNECTION_SELECT}
    WHERE (c.source_id = ? OR c.target_id = ?) ${includeArchived ? '' : `AND c.status != 'archived'`}
    ORDER BY c.position, c.created_at
  `).all(entityId, entityId);

  const categoryOrder = new Map(connectionCategories().map((category, index) => [category.id, index]));
  const sections = new Map();
  for (const row of rows) {
    const item = perspectiveView(row, entityId);
    if (!sections.has(item.section)) {
      sections.set(item.section, {
        name: item.section,
        category: item.category,
        rank: kindRank(item.kindId),
        items: [],
      });
    }
    const section = sections.get(item.section);
    section.rank = Math.min(section.rank, kindRank(item.kindId));
    section.items.push(item);
  }
  return [...sections.values()].sort((a, b) =>
    (categoryOrder.get(a.category) ?? 99) - (categoryOrder.get(b.category) ?? 99)
    || a.rank - b.rank
    || a.name.localeCompare(b.name))
    .map(({ rank, ...section }) => section);
}

/**
 * Where a kind sits in the published vocabulary.
 *
 * Two sections can share a category — a group's Members and its Leadership
 * are both affiliations — and sorting those alphabetically would open a
 * group on whoever leads it rather than on who is in it. The vocabulary is
 * written in the order these things are worth reading, so that order is the
 * one to follow. Kinds that are not in it (custom, and everything an upgrade
 * minted) sort after, by name.
 */
const KIND_RANK = new Map(builtinConnectionKinds().map((kind, index) => [kind.id, index]));
const kindRank = (kindId) => KIND_RANK.get(kindId) ?? Number.MAX_SAFE_INTEGER;

/**
 * Singular of a section heading, for a section holding exactly one record.
 *
 * The first word carrying a plural "s" is the one that means the count —
 * "Places within", "Organizations present", "Allied groups" — so that is the
 * word to turn. Words that merely end in s do not; "Species" is not a plural
 * of "Specie" and saying so in a summary line would be worse than saying
 * nothing.
 */
const NOT_PLURAL = new Set(['species', 'lore', 'this']);
function singularise(section) {
  const words = section.split(' ');
  for (let i = 0; i < words.length; i++) {
    const word = words[i].toLowerCase();
    if (word.endsWith('s') && !word.endsWith('ss') && !NOT_PLURAL.has(word)) {
      words[i] = words[i].slice(0, -1);
      break;
    }
  }
  return words.join(' ');
}

/**
 * A one-line reading of what a record's connections amount to — "8 members ·
 * 1 leader · 2 bases". Computed on demand from the connections themselves and
 * never written into the record's summary, so it cannot go stale and cannot
 * be edited into disagreeing with the facts it counts.
 */
export function connectionSummary(library, entityId) {
  const sections = connectionsForEntity(library, entityId);
  const parts = sections.map((section) => {
    const count = section.items.length;
    const heading = count === 1 ? singularise(section.name) : section.name;
    return `${count} ${heading.toLowerCase()}`;
  });
  return { parts, line: parts.join(' · '), total: sections.reduce((sum, s) => sum + s.items.length, 0) };
}

/** Counts per kind, for the audit screen and for kind maintenance. */
export function connectionKindUsage(library) {
  return library.db.prepare(`
    SELECT k.id, k.forward_label, k.category, k.is_legacy, k.is_builtin,
           COUNT(c.id) AS uses,
           SUM(CASE WHEN c.label_override != '' OR c.inverse_label_override != '' THEN 1 ELSE 0 END) AS overrides
    FROM connection_kinds k LEFT JOIN connections c ON c.kind_id = k.id
    GROUP BY k.id
    ORDER BY k.is_legacy DESC, uses DESC, k.forward_label COLLATE NOCASE
  `).all().map((row) => ({
    id: row.id,
    label: row.forward_label,
    category: row.category,
    legacy: !!row.is_legacy,
    builtin: !!row.is_builtin,
    uses: row.uses,
    overrides: row.overrides ?? 0,
  }));
}
