import crypto from 'node:crypto';
import { domainError } from './errors.js';
import { nowIso, inTransaction } from './database-service.js';
import { recordActivity } from './activity-service.js';
import { getContract, contractDrift, validateContractAgainstLibrary } from './contract-service.js';
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

/* ---------------- moving to another contract version ---------------- */

/** The parts of a contract a production's stored rows are keyed by. */
function contractShape(contractJson) {
  const productionFields = new Set((contractJson.productionFields ?? []).map((def) => def.id));
  const selections = new Map();
  const entityFieldOwner = new Map();
  const assetSets = new Map();
  for (const selection of contractJson.entitySelections ?? []) {
    selections.set(selection.id, selection);
    for (const def of selection.fields ?? []) entityFieldOwner.set(def.id, selection.id);
    for (const set of selection.assetSets ?? []) assetSets.set(set.id, { scope: 'entity', owner: selection.id, def: set });
  }
  for (const set of contractJson.assetSets ?? []) {
    assetSets.set(set.id, { scope: 'production', owner: null, def: set });
  }
  return {
    productionFields,
    selections,
    entityFieldOwner,
    assetSets,
    documentsSelected: contractJson.documents?.mode === 'selected',
  };
}

/**
 * Work out exactly what moving a production onto another contract
 * version would keep and what it would let go. The same function
 * computes the preview and drives the change, so what the author is
 * shown and what happens cannot drift apart.
 */
function buildRebindPlan(db, row, target) {
  const id = row.id;
  const shape = contractShape(target.contract);
  const plan = {
    deleteEntities: [], deleteSetIds: [], deleteValueIds: [], itemValueUpdates: [],
    losses: [], additions: [],
  };

  /* selected records */
  const entityRows = db.prepare(`
    SELECT pe.slot, pe.entity_id AS entityId, e.name, e.type
    FROM production_entities pe JOIN entities e ON e.id = pe.entity_id
    WHERE pe.production_id = ? ORDER BY pe.slot, pe.position
  `).all(id);
  const surviving = new Set();
  const droppedBySlot = new Map();
  for (const entity of entityRows) {
    const selection = shape.selections.get(entity.slot);
    if (selection && selection.entityTypes.includes(entity.type)) {
      surviving.add(`${entity.slot}:${entity.entityId}`);
      continue;
    }
    plan.deleteEntities.push(entity);
    if (!droppedBySlot.has(entity.slot)) {
      droppedBySlot.set(entity.slot, {
        label: selection ? selection.label : entity.slot,
        reason: selection ? `no longer accepts ${entity.type} records` : 'is not in the new version',
        names: [],
      });
    }
    droppedBySlot.get(entity.slot).names.push(entity.name);
  }
  for (const { label, reason, names } of droppedBySlot.values()) {
    plan.losses.push(`“${label}” ${reason}: ${names.length} chosen record(s) are released (${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''}).`);
  }

  /* asset sets, and the item values inside the ones that survive */
  for (const setRow of db.prepare('SELECT * FROM production_asset_sets WHERE production_id = ?').all(id)) {
    const known = shape.assetSets.get(setRow.slot);
    const scopeMatches = known && (setRow.entity_id === ''
      ? known.scope === 'production'
      : known.scope === 'entity' && surviving.has(`${known.owner}:${setRow.entity_id}`));
    const items = db.prepare('SELECT id, asset_id, value_json FROM production_asset_items WHERE set_id = ?').all(setRow.id);
    if (!scopeMatches) {
      plan.deleteSetIds.push(setRow.id);
      if (items.length > 0) {
        plan.losses.push(`The asset set “${setRow.slot}”${setRow.entity_id ? ' for one record' : ''} is gone from the new version: ${items.length} chosen asset(s) are released.`);
      }
      continue;
    }
    const allowed = new Set((known.def.itemFields ?? []).map((def) => def.id));
    for (const item of items) {
      const values = JSON.parse(item.value_json);
      const stale = Object.keys(values).filter((key) => !allowed.has(key));
      if (stale.length === 0) continue;
      const kept = Object.fromEntries(Object.entries(values).filter(([key]) => allowed.has(key)));
      plan.itemValueUpdates.push({ id: item.id, valueJson: JSON.stringify(kept) });
      plan.losses.push(`“${setRow.slot}” no longer has the per-asset field(s) ${stale.join(', ')}; those entries are cleared.`);
    }
  }

  /* stored values */
  for (const valueRow of db.prepare('SELECT * FROM production_values WHERE production_id = ?').all(id)) {
    const kept = valueRow.scope === 'production'
      ? shape.productionFields.has(valueRow.field) || (valueRow.field === '__documents__' && shape.documentsSelected)
      : (() => {
        const owner = shape.entityFieldOwner.get(valueRow.field);
        return Boolean(owner) && surviving.has(`${owner}:${valueRow.entity_id}`);
      })();
    if (kept) continue;
    plan.deleteValueIds.push(valueRow.id);
    if (JSON.parse(valueRow.value_json) === null) continue;
    plan.losses.push(valueRow.scope === 'production'
      ? `The production field “${valueRow.field}” is gone from the new version; its value is cleared.`
      : `The per-record field “${valueRow.field}” no longer applies to one selected record; its value is cleared.`);
  }

  /* what the new version asks for that the old one never did */
  const before = contractShape(JSON.parse(db.prepare('SELECT json FROM application_contracts WHERE contract_id = ? AND version = ?')
    .get(row.contract_id, row.contract_version)?.json ?? '{}'));
  for (const fieldId of shape.productionFields) {
    if (!before.productionFields.has(fieldId)) plan.additions.push(`New production field “${fieldId}”.`);
  }
  for (const [slotId, selection] of shape.selections) {
    if (!before.selections.has(slotId)) plan.additions.push(`New record selection “${selection.label}”.`);
  }
  for (const [setId, set] of shape.assetSets) {
    if (!before.assetSets.has(setId)) plan.additions.push(`New asset set “${set.def.label}”.`);
  }

  return plan;
}

/** Candidate contracts and versions this production could be moved onto. */
export function rebindTargets(library, id) {
  const db = library.db;
  const row = db.prepare('SELECT * FROM productions WHERE id = ?').get(id);
  if (!row) throw domainError('production.missing', 'That production no longer exists.');
  const rows = db.prepare(`
    SELECT contract_id, version, name, app_type, status FROM application_contracts
    ORDER BY name COLLATE NOCASE, version DESC
  `).all();
  const contracts = new Map();
  for (const contract of rows) {
    if (!contracts.has(contract.contract_id)) {
      contracts.set(contract.contract_id, {
        contractId: contract.contract_id, name: contract.name, appType: contract.app_type,
        status: contract.status, versions: [],
      });
    }
    contracts.get(contract.contract_id).versions.push(contract.version);
  }
  const list = [...contracts.values()];
  const own = list.find((contract) => contract.contractId === row.contract_id);
  return {
    current: { contractId: row.contract_id, version: row.contract_version },
    latestOwnVersion: own?.versions[0] ?? row.contract_version,
    contracts: list,
  };
}

/** Preview only: what a move would keep, release, and newly ask for. */
export function planProductionRebind(library, id, { contractId = null, contractVersion = null }) {
  const db = library.db;
  const row = db.prepare('SELECT * FROM productions WHERE id = ?').get(id);
  if (!row) throw domainError('production.missing', 'That production no longer exists.');
  const target = getContract(library, contractId ?? row.contract_id, contractVersion);
  const plan = buildRebindPlan(db, row, target);
  const from = getContract(library, row.contract_id, row.contract_version);
  return {
    from: { contractId: row.contract_id, version: row.contract_version, name: from.name },
    to: { contractId: target.contractId, version: target.version, name: target.name },
    unchanged: row.contract_id === target.contractId && row.contract_version === target.version,
    differentContract: row.contract_id !== target.contractId,
    losses: plan.losses,
    additions: plan.additions,
    publications: db.prepare('SELECT COUNT(*) n FROM publications WHERE production_id = ?').get(id).n,
  };
}

/**
 * Move a production onto another contract version, or another contract
 * entirely. Everything the new version still recognises is kept in
 * place; nothing is re-minted. Published snapshots are untouched — they
 * record the contract version they shipped with.
 */
export function rebindProduction(library, id, { contractId = null, contractVersion = null }) {
  const db = library.db;
  const row = db.prepare('SELECT * FROM productions WHERE id = ?').get(id);
  if (!row) throw domainError('production.missing', 'That production no longer exists.');
  const target = getContract(library, contractId ?? row.contract_id, contractVersion);
  if (row.contract_id === target.contractId && row.contract_version === target.version) {
    throw domainError('production.rebind_same', 'This production is already on that contract version.');
  }
  const plan = buildRebindPlan(db, row, target);

  inTransaction(db, () => {
    const dropEntity = db.prepare('DELETE FROM production_entities WHERE production_id = ? AND slot = ? AND entity_id = ?');
    for (const entity of plan.deleteEntities) dropEntity.run(id, entity.slot, entity.entityId);
    const dropSet = db.prepare('DELETE FROM production_asset_sets WHERE id = ?');
    for (const setId of plan.deleteSetIds) dropSet.run(setId);
    const dropValue = db.prepare('DELETE FROM production_values WHERE id = ?');
    for (const valueId of plan.deleteValueIds) dropValue.run(valueId);
    const setItemValues = db.prepare('UPDATE production_asset_items SET value_json = ? WHERE id = ?');
    for (const update of plan.itemValueUpdates) setItemValues.run(update.valueJson, update.id);
    db.prepare('UPDATE productions SET contract_id = ?, contract_version = ? WHERE id = ?')
      .run(target.contractId, target.version, id);
    touch(db, library, id);
  });

  recordActivity(db, 'production.rebound', 'production', id,
    `${target.name} v${target.version}`);
  validateProduction(library, id);
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
      push('error', problem.code, problem.message, { kind: 'productionField', field: def.id }, `fields:${def.id}`);
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
          { kind: 'selection', slot: selection.id, entityId: entity.id }, `selection:${selection.id}:${entity.id}`);
      }
      if (entity.status === 'archived') {
        push('error', 'production.selection_archived', `“${entity.name}” is archived and cannot be selected.`,
          { kind: 'selection', slot: selection.id, entityId: entity.id }, `selection:${selection.id}:${entity.id}`);
      } else if (entity.status === 'draft') {
        push('warning', 'production.selection_draft', `“${entity.name}” is still a draft.`,
          { kind: 'selection', slot: selection.id, entityId: entity.id }, `selection:${selection.id}:${entity.id}`);
      }

      /* per-entity fields */
      for (const def of selection.fields ?? []) {
        const value = production.entityValues[entity.id]?.[def.id];
        for (const problem of validateFieldValue(def, value, refs)) {
          push('error', problem.code, `${entity.name}: ${problem.message}`,
            { kind: 'entityField', slot: selection.id, entityId: entity.id, field: def.id }, `selection:${selection.id}:${entity.id}`);
        }
      }

      /* per-entity asset sets */
      for (const set of selection.assetSets ?? []) {
        validateAssetSet(set, production.assetSets[setKey(set.id, entity.id)] ?? [], {
          db, refs, push, entity, selection,
          destination: `assetset:${set.id}:${entity.id}`,
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

  /* canonical connections this application consumes */
  for (const issue of validateContractAgainstLibrary(library, contract)) {
    push('error', issue.code, issue.message, { kind: 'connectionSelection' }, 'contract');
  }
  for (const connection of contract.connectionSelections ?? []) {
    validateConnectionSelection(connection, production, { db, push });
  }

  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const state = errors > 0 ? 'errors' : issues.length > 0 ? 'warnings' : 'valid';
  db.prepare('UPDATE productions SET validation_state = ? WHERE id = ?').run(state, id);
  return { issues, state, errors, warnings: issues.length - errors };
}

/**
 * Check a contract's connection selection against the canonical graph.
 *
 * The application declares which kinds it understands and how many each of
 * its source records may have; the facts themselves stay in canon, where
 * they belong. Two things are worth separating here. A source record outside
 * the declared bounds is an error, because the application cannot render
 * what it asked for. A record connected to something the author has not
 * selected is only a warning — the connection is perfectly good canon, the
 * package simply will not carry the other end — and it names that other end
 * so the production editor can offer to add it. Nothing is traversed
 * automatically: that is the whole reason choosing one character cannot pull
 * a world into a package.
 */
function validateConnectionSelection(connection, production, { db, push }) {
  const sources = production.selections[connection.sourceSelection] ?? [];
  const targets = production.selections[connection.targetSelection] ?? [];
  if (sources.length === 0) return;
  const selectedTargets = new Set(targets.map((entity) => entity.id));
  const kinds = connection.kinds ?? [];
  if (kinds.length === 0) return;
  const placeholders = kinds.map(() => '?').join(',');
  const destination = `selection:${connection.targetSelection}`;

  const held = db.prepare(`
    SELECT c.source_id, c.target_id, t.name AS target_name, k.forward_label
    FROM connections c
    JOIN connection_kinds k ON k.id = c.kind_id
    JOIN entities t ON t.id = c.target_id
    WHERE c.kind_id IN (${placeholders}) AND c.status != 'archived'
  `).all(...kinds);

  const min = connection.minPerSource ?? 0;
  const max = connection.maxPerSource ?? Infinity;

  for (const source of sources) {
    const mine = held.filter((row) => row.source_id === source.id);
    const included = mine.filter((row) => selectedTargets.has(row.target_id));
    const target = { kind: 'connectionSelection', slot: connection.id, entityId: source.id };

    if (included.length < min) {
      push('error', 'production.connection_short',
        `“${connection.label}” needs at least ${min} for ${source.name}; ${included.length} of the ${source.name} connection(s) point at a record selected under “${connection.targetSelection}”.`,
        target, destination);
    }
    if (included.length > max) {
      push('error', 'production.connection_long',
        `“${connection.label}” allows at most ${max} for ${source.name}; ${included.length} are selected. That is this application's rule, not a canonical one — deselect the extra, or widen the contract.`,
        target, destination);
    }
    for (const row of mine) {
      if (selectedTargets.has(row.target_id)) continue;
      push('warning', 'production.connection_target_unselected',
        `${source.name} is connected to ${row.target_name}, but ${row.target_name} is not selected under “${connection.targetSelection}”, so this publication will not carry it.`,
        { ...target, targetEntityId: row.target_id, targetSelection: connection.targetSelection, targetName: row.target_name },
        destination);
    }
  }
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
    /* A drifted contract is not a validation issue — the production may be
       perfectly valid against a document the application has since moved on
       from. Publishing that is how a package comes to ask for art under a
       role the consumer stopped using, so it is refused here rather than
       discovered at render time. */
    const drift = contractDrift(library, row.contract_id);
    if (drift.drifted) {
      throw domainError('production.contract_drifted', drift.message, { drift });
    }
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
