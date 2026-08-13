import crypto from 'node:crypto';
import { domainError } from './errors.js';
import { nowIso, inTransaction } from './database-service.js';
import { recordActivity } from './activity-service.js';
import { getContract } from './contract-service.js';
import { validateFieldValue, countBounds } from './field-engine.js';
import { slugify } from './paths.js';
import { assetDisplayUrl } from './asset-service.js';

/**
 * Productions reference canonical material without redefining it.
 * Identity, selections, asset sets, and publication history live in
 * explicit tables; only contract-defined values use validated JSON.
 */

function uniqueProductionSlug(db, name) {
  const base = slugify(name, 'production');
  let candidate = base;
  let counter = 2;
  while (db.prepare('SELECT id FROM productions WHERE slug = ?').get(candidate)) {
    candidate = `${base}-${counter++}`;
  }
  return candidate;
}

export function createProduction(library, { name, contractId, contractVersion = null, worldId = null }) {
  const db = library.db;
  const contract = getContract(library, contractId, contractVersion);
  const id = crypto.randomUUID();
  const now = nowIso();
  db.prepare(`
    INSERT INTO productions (id, name, slug, contract_id, contract_version, world_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name.trim(), uniqueProductionSlug(db, name), contract.contractId, contract.version, worldId, now, now);
  recordActivity(db, 'production.created', 'production', id, name);
  return getProduction(library, id);
}

export function getProduction(library, id) {
  const db = library.db;
  const row = db.prepare('SELECT * FROM productions WHERE id = ?').get(id);
  if (!row) throw domainError('production.missing', 'That production no longer exists.');
  const contract = getContract(library, row.contract_id, row.contract_version);

  const values = {};
  for (const valueRow of db.prepare(`SELECT * FROM production_values WHERE production_id = ? AND scope = 'production'`).all(id)) {
    values[valueRow.field] = JSON.parse(valueRow.value_json);
  }
  const entityValues = {};
  for (const valueRow of db.prepare(`SELECT * FROM production_values WHERE production_id = ? AND scope = 'entity'`).all(id)) {
    if (!entityValues[valueRow.entity_id]) entityValues[valueRow.entity_id] = {};
    entityValues[valueRow.entity_id][valueRow.field] = JSON.parse(valueRow.value_json);
  }

  const selections = {};
  for (const selection of contract.contract.entitySelections ?? []) {
    selections[selection.id] = db.prepare(`
      SELECT pe.entity_id AS id, pe.position, e.name, e.type, e.status, e.revision
      FROM production_entities pe JOIN entities e ON e.id = pe.entity_id
      WHERE pe.production_id = ? AND pe.slot = ?
      ORDER BY pe.position
    `).all(id, selection.id).map((entity) => ({
      ...entity,
      artUrl: entityArt(db, entity.id, entity.type),
    }));
  }

  const assetSets = {};
  for (const setRow of db.prepare('SELECT * FROM production_asset_sets WHERE production_id = ?').all(id)) {
    const key = setKey(setRow.slot, setRow.entity_id);
    assetSets[key] = db.prepare(`
      SELECT i.id AS item_id, i.asset_id, i.position, i.value_json, a.title, a.kind, a.status
      FROM production_asset_items i JOIN assets a ON a.id = i.asset_id
      WHERE i.set_id = ? ORDER BY i.position
    `).all(setRow.id).map((item) => ({
      itemId: item.item_id,
      assetId: item.asset_id,
      position: item.position,
      values: JSON.parse(item.value_json),
      title: item.title,
      kind: item.kind,
      status: item.status,
      thumbUrl: assetDisplayUrl(db, item.asset_id),
    }));
  }

  let world = null;
  if (row.world_id) {
    world = db.prepare('SELECT id, name FROM entities WHERE id = ?').get(row.world_id) ?? null;
  }

  const publications = db.prepare(`
    SELECT id, created_at, production_revision, package_size, file_count, entity_count, is_current
    FROM publications WHERE production_id = ? ORDER BY created_at DESC
  `).all(id);

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    revision: row.revision,
    validationState: row.validation_state,
    contractId: row.contract_id,
    contractVersion: row.contract_version,
    contractName: contract.name,
    contract: contract.contract,
    world,
    values,
    entityValues,
    selections,
    assetSets,
    publications,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function entityArt(db, id, type) {
  if (type === 'character') {
    const profile = db.prepare('SELECT portrait_asset_id FROM character_profiles WHERE entity_id = ?').get(id);
    return assetDisplayUrl(db, profile?.portrait_asset_id);
  }
  if (type === 'world') {
    const profile = db.prepare('SELECT cover_asset_id FROM world_profiles WHERE entity_id = ?').get(id);
    return assetDisplayUrl(db, profile?.cover_asset_id);
  }
  return null;
}

export function setKey(slot, entityId = '') {
  return entityId ? `${slot}:${entityId}` : slot;
}

function touch(db, library, id) {
  db.prepare(`UPDATE productions SET revision = revision + 1, updated_at = ?, validation_state = 'unknown', status = CASE WHEN status = 'ready' THEN 'draft' ELSE status END WHERE id = ?`)
    .run(nowIso(), id);
}

export function updateProduction(library, id, { name, worldId }) {
  const db = library.db;
  const row = db.prepare('SELECT * FROM productions WHERE id = ?').get(id);
  if (!row) throw domainError('production.missing', 'That production no longer exists.');
  inTransaction(db, () => {
    if (name !== undefined && name.trim() && name !== row.name) {
      db.prepare('UPDATE productions SET name = ? WHERE id = ?').run(name.trim(), id);
    }
    if (worldId !== undefined) {
      db.prepare('UPDATE productions SET world_id = ? WHERE id = ?').run(worldId, id);
    }
    touch(db, library, id);
  });
  return getProduction(library, id);
}

export function setProductionValue(library, id, { scope, entityId = '', field, value }) {
  const db = library.db;
  if (!db.prepare('SELECT id FROM productions WHERE id = ?').get(id)) {
    throw domainError('production.missing', 'That production no longer exists.');
  }
  inTransaction(db, () => {
    db.prepare(`
      INSERT INTO production_values (production_id, scope, entity_id, field, value_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(production_id, scope, entity_id, field) DO UPDATE SET value_json = excluded.value_json
    `).run(id, scope, entityId, field, JSON.stringify(value ?? null));
    touch(db, library, id);
  });
  return { saved: true };
}

/** Replace the ordered entity list for one selection slot. */
export function setSelection(library, id, slot, entityIds) {
  const db = library.db;
  const production = db.prepare('SELECT * FROM productions WHERE id = ?').get(id);
  if (!production) throw domainError('production.missing', 'That production no longer exists.');
  inTransaction(db, () => {
    db.prepare('DELETE FROM production_entities WHERE production_id = ? AND slot = ?').run(id, slot);
    const insert = db.prepare('INSERT INTO production_entities (production_id, slot, entity_id, position) VALUES (?, ?, ?, ?)');
    entityIds.forEach((entityId, index) => {
      if (!db.prepare('SELECT id FROM entities WHERE id = ?').get(entityId)) {
        throw domainError('entity.missing', 'A selected record no longer exists.');
      }
      insert.run(id, slot, entityId, index);
    });
    touch(db, library, id);
  });
  return getProduction(library, id);
}

/** Replace the ordered items of one asset set (production- or entity-scoped). */
export function setAssetSetItems(library, id, { slot, entityId = '', items }) {
  const db = library.db;
  if (!db.prepare('SELECT id FROM productions WHERE id = ?').get(id)) {
    throw domainError('production.missing', 'That production no longer exists.');
  }
  inTransaction(db, () => {
    let setRow = db.prepare('SELECT * FROM production_asset_sets WHERE production_id = ? AND slot = ? AND entity_id = ?').get(id, slot, entityId);
    if (!setRow) {
      db.prepare('INSERT INTO production_asset_sets (production_id, slot, entity_id) VALUES (?, ?, ?)').run(id, slot, entityId);
      setRow = db.prepare('SELECT * FROM production_asset_sets WHERE production_id = ? AND slot = ? AND entity_id = ?').get(id, slot, entityId);
    }
    db.prepare('DELETE FROM production_asset_items WHERE set_id = ?').run(setRow.id);
    const insert = db.prepare('INSERT INTO production_asset_items (set_id, asset_id, position, value_json) VALUES (?, ?, ?, ?)');
    items.forEach((item, index) => {
      if (!db.prepare('SELECT id FROM assets WHERE id = ?').get(item.assetId)) {
        throw domainError('asset.missing', 'A chosen asset no longer exists.');
      }
      insert.run(setRow.id, item.assetId, index, JSON.stringify(item.values ?? {}));
    });
    touch(db, library, id);
  });
  return getProduction(library, id);
}

/* ---------------- validation ---------------- */

/**
 * Deterministic validation. Issues carry severity, stable code, human
 * sentence, target, and a suggested editor destination.
 */
export function validateProduction(library, id) {
  const db = library.db;
  const production = getProduction(library, id);
  const contract = production.contract;
  const issues = [];
  const push = (severity, code, message, target, destination) => {
    issues.push({ severity, code, message, target, destination });
  };

  const refs = {
    entityExists: (entityId, types) => {
      const entity = db.prepare('SELECT type, status FROM entities WHERE id = ?').get(entityId);
      if (!entity || entity.status === 'archived') return false;
      return !types || types.includes(entity.type);
    },
    assetExists: (assetId, kinds) => {
      const asset = db.prepare('SELECT kind, status FROM assets WHERE id = ?').get(assetId);
      if (!asset || asset.status === 'archived') return false;
      return !kinds || kinds.includes(asset.kind);
    },
  };

  /* production-level fields */
  for (const def of contract.productionFields ?? []) {
    for (const problem of validateFieldValue(def, production.values[def.id], refs)) {
      push('error', problem.code, problem.message, { kind: 'productionField', field: def.id }, 'fields');
    }
  }

  /* required recipes exist */
  for (const recipeId of contract.requiredRecipes ?? []) {
    if (!db.prepare('SELECT id FROM rendition_recipes WHERE id = ?').get(recipeId)) {
      push('error', 'production.recipe_missing', `The contract needs the rendition recipe "${recipeId}", which does not exist in this library.`, { kind: 'recipe', recipeId }, 'fields');
    }
  }

  /* selections */
  for (const selection of contract.entitySelections ?? []) {
    const chosen = production.selections[selection.id] ?? [];
    const bounds = countBounds(selection);
    if (chosen.length < bounds.min) {
      push('error', 'production.selection_short',
        bounds.exact !== undefined
          ? `“${selection.label}” needs exactly ${bounds.exact} record(s); ${chosen.length} chosen.`
          : `“${selection.label}” needs at least ${bounds.min} record(s); ${chosen.length} chosen.`,
        { kind: 'selection', slot: selection.id }, `selection:${selection.id}`);
    }
    if (chosen.length > bounds.max) {
      push('error', 'production.selection_long', `“${selection.label}” allows at most ${bounds.max} record(s); ${chosen.length} chosen.`,
        { kind: 'selection', slot: selection.id }, `selection:${selection.id}`);
    }
    for (const entity of chosen) {
      if (!selection.entityTypes.includes(entity.type)) {
        push('error', 'production.selection_type', `“${entity.name}” is a ${entity.type}, which “${selection.label}” does not allow.`,
          { kind: 'selection', slot: selection.id, entityId: entity.id }, `selection:${selection.id}`);
      }
      if (entity.status === 'archived') {
        push('error', 'production.selection_archived', `“${entity.name}” is archived and cannot be selected.`,
          { kind: 'selection', slot: selection.id, entityId: entity.id }, `selection:${selection.id}`);
      } else if (entity.status === 'draft') {
        push('warning', 'production.selection_draft', `“${entity.name}” is still a draft.`,
          { kind: 'selection', slot: selection.id, entityId: entity.id }, `selection:${selection.id}`);
      }

      /* per-entity fields */
      for (const def of selection.fields ?? []) {
        const value = production.entityValues[entity.id]?.[def.id];
        for (const problem of validateFieldValue(def, value, refs)) {
          push('error', problem.code, `${entity.name}: ${problem.message}`,
            { kind: 'entityField', slot: selection.id, entityId: entity.id, field: def.id }, `selection:${selection.id}`);
        }
      }

      /* per-entity asset sets */
      for (const set of selection.assetSets ?? []) {
        validateAssetSet(set, production.assetSets[setKey(set.id, entity.id)] ?? [], {
          db, refs, push, entity, selection,
          destination: `selection:${selection.id}`,
        });
      }
    }
  }

  /* production-level asset sets */
  for (const set of contract.assetSets ?? []) {
    validateAssetSet(set, production.assetSets[setKey(set.id)] ?? [], {
      db, refs, push, entity: null, selection: null, destination: `assets:${set.id}`,
    });
  }

  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const state = errors > 0 ? 'errors' : issues.length > 0 ? 'warnings' : 'valid';
  db.prepare('UPDATE productions SET validation_state = ? WHERE id = ?').run(state, id);
  return { issues, state, errors, warnings: issues.length - errors };
}

function validateAssetSet(set, items, { db, refs, push, entity, destination }) {
  const label = entity ? `${set.label} for ${entity.name}` : set.label;
  const target = { kind: 'assetSet', slot: set.id, entityId: entity?.id };
  const bounds = countBounds(set);
  if (items.length < bounds.min) {
    push('error', 'production.asset_set_short',
      bounds.exact !== undefined
        ? `“${label}” needs exactly ${bounds.exact} asset(s); ${items.length} chosen.`
        : `“${label}” needs at least ${bounds.min} asset(s); ${items.length} chosen.`,
      target, destination);
  }
  if (items.length > bounds.max) {
    push('error', 'production.asset_set_long', `“${label}” allows at most ${bounds.max} asset(s); ${items.length} chosen.`, target, destination);
  }
  for (const item of items) {
    const asset = db.prepare('SELECT kind, status, title FROM assets WHERE id = ?').get(item.assetId);
    if (!asset || asset.status === 'archived') {
      push('error', 'production.asset_missing', `An asset chosen for “${label}” no longer exists or is archived.`, { ...target, assetId: item.assetId }, destination);
      continue;
    }
    if (set.kinds && !set.kinds.includes(asset.kind)) {
      push('error', 'production.asset_kind', `“${asset.title}” is ${asset.kind}; “${label}” allows ${set.kinds.join(', ')}.`, { ...target, assetId: item.assetId }, destination);
    }
    if (set.roles && set.roles.length > 0 && entity) {
      const hasRole = db.prepare(`
        SELECT 1 FROM asset_links WHERE asset_id = ? AND entity_id = ? AND role IN (${set.roles.map(() => '?').join(',')})
      `).get(item.assetId, entity.id, ...set.roles);
      if (!hasRole) {
        push('error', 'production.asset_role', `“${asset.title}” is not linked to ${entity.name} with a role “${label}” allows (${set.roles.join(', ')}).`, { ...target, assetId: item.assetId }, destination);
      }
    }
    for (const def of set.itemFields ?? []) {
      for (const problem of validateFieldValue(def, item.values?.[def.id], refs)) {
        push('error', problem.code, `“${label}”: ${problem.message}`, { ...target, assetId: item.assetId, field: def.id }, destination);
      }
    }
  }
}

/** Ready requires zero errors; warnings do not block. */
export function setProductionStatus(library, id, status) {
  const db = library.db;
  const row = db.prepare('SELECT * FROM productions WHERE id = ?').get(id);
  if (!row) throw domainError('production.missing', 'That production no longer exists.');
  if (status === 'ready') {
    const result = validateProduction(library, id);
    if (result.errors > 0) {
      throw domainError('production.not_ready', `This production has ${result.errors} validation error(s) and cannot be marked ready.`, { issues: result.issues });
    }
  }
  db.prepare('UPDATE productions SET status = ?, archived_at = ?, updated_at = ? WHERE id = ?')
    .run(status, status === 'archived' ? nowIso() : null, nowIso(), id);
  recordActivity(db, `production.${status}`, 'production', id, row.name);
  return getProduction(library, id);
}

export function listProductions(library, { includeArchived = false } = {}) {
  const db = library.db;
  const rows = db.prepare(`
    SELECT p.*, w.name AS world_name FROM productions p
    LEFT JOIN entities w ON w.id = p.world_id
    ${includeArchived ? '' : `WHERE p.status != 'archived'`}
    ORDER BY p.updated_at DESC
  `).all();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    revision: row.revision,
    validationState: row.validation_state,
    contractId: row.contract_id,
    contractVersion: row.contract_version,
    worldName: row.world_name,
    updatedAt: row.updated_at,
    publications: db.prepare('SELECT COUNT(*) n FROM publications WHERE production_id = ?').get(row.id).n,
  }));
}
