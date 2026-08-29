/**
 * Build a complete, valid Production from a contract alone.
 *
 * A new consuming application has no hand-written fixture builder, and writing
 * one is exactly the step that let World Hub's copy of a contract drift from
 * the application's: the builder became a second interpretation of the same
 * document, maintained by hand. This derives everything from the contract, so
 * a sixth app can generate conformance fixtures the day it is created.
 *
 * The values are deliberately dull. This exists to satisfy a contract, not to
 * describe a world — the four established apps keep their own builders, which
 * assert app-specific facts a generic one could never know.
 */
import { createContract } from '../electron/services/contract-service.js';
import { createEntity, updateEntity } from '../electron/services/entity-service.js';
import { setAssetLinks } from '../electron/services/asset-service.js';
import { createDocument } from '../electron/services/document-service.js';
import {
  createProduction, setProductionValue, setSelection, setAssetSetItems, setProductionStatus,
} from '../electron/services/production-service.js';
import { publishProduction } from '../electron/services/publication-service.js';
import { countBounds } from '../electron/services/field-engine.js';
import { importImage, importSound } from '../tests/fixtures/consumer-fixtures.mjs';

const ENTITY_NAMES = {
  world: ['Ashfen', 'Coldwater', 'Marrow Reach'],
  character: ['Ilse', 'Bram', 'Nao', 'Vero', 'Tamsin', 'Oda'],
  location: ['The Long Stair', 'Saltmarket', 'Nettle Yard'],
  object: ['The Brass Key', 'A Folded Map'],
  faction: ['The Quiet Office', 'Lanternwrights'],
  event: ['The Thaw', 'Second Vigil'],
  scene: ['Before the Gate', 'After the Rain'],
  creature: ['Fen Heron', 'Stone Marten'],
};

/** Records default to draft, which validation warns about; make them canon. */
function makeEntity(library, fields) {
  const entity = createEntity(library, fields);
  updateEntity(library, entity.id, { status: 'canonical' });
  return entity;
}

const nameFor = (type, index) => {
  const names = ENTITY_NAMES[type] ?? [type];
  return `${names[index % names.length]}${index >= names.length ? ` ${index + 1}` : ''}`;
};

/** How many of something to make: the exact count, or the minimum plus one. */
function howMany(def, { cap = 3 } = {}) {
  const { min, max, exact } = countBounds(def);
  if (exact !== undefined) return exact;
  const wanted = Math.max(min, 1);
  return Math.min(wanted, max === Infinity ? cap : max);
}

/** A value satisfying one field definition. */
async function valueFor(def, ctx) {
  switch (def.type) {
    case 'shortText':
      return (def.label ?? def.id).slice(0, def.maxLength ?? 60) || def.id;
    case 'multilineText':
    case 'markdown':
      return `${def.label ?? def.id}.\n\nWritten to satisfy the contract.`;
    case 'integer':
    case 'number': {
      const min = def.min ?? 1;
      const max = def.max ?? min + 1;
      const value = Math.min(Math.max(min, 1), max);
      return def.type === 'integer' ? Math.round(value) : value;
    }
    case 'boolean':
      return true;
    case 'enum':
      return (def.options ?? []).map((o) => (typeof o === 'object' ? o.value : o))[0] ?? null;
    case 'color':
      return '#4a6f8a';
    case 'entityRef': {
      const types = def.entityTypes ?? ['character'];
      return ctx.anyEntityOf(types);
    }
    case 'assetRef': {
      const kinds = def.assetKinds ?? ['image'];
      const asset = kinds.includes('audio')
        ? await importSound(ctx.library, `${def.id} sound`)
        : await importImage(ctx.library, `${def.id} art`);
      const role = (def.assetRoles ?? [])[0];
      if (role && ctx.lastEntityId) setAssetLinks(ctx.library, asset.id, [{ entityId: ctx.lastEntityId, role }]);
      return asset.id;
    }
    case 'list': {
      /* minItems is a hard requirement, not a suggestion: a contract asking
         for thirty campaign nodes gets thirty. Only unbounded lists are kept
         short, to keep the fixtures small. */
      const count = def.minItems ?? 1;
      const out = [];
      for (let i = 0; i < Math.max(count, 1); i++) {
        if (def.fields) {
          const row = {};
          for (const sub of def.fields) row[sub.id] = await valueFor(sub, ctx);
          out.push(row);
        } else {
          out.push(await valueFor(def.item ?? { type: 'shortText', id: def.id }, ctx));
        }
      }
      return out;
    }
    default:
      return null;
  }
}

/** Fill one asset set with as many assets as its bounds require. */
async function fillAssetSet(library, productionId, set, entity, ctx) {
  const count = howMany(set, { cap: 2 });
  if (count === 0) return;
  const role = (set.roles ?? [])[0] ?? null;
  const audio = (set.kinds ?? ['image']).includes('audio');
  const items = [];
  for (let i = 0; i < count; i++) {
    const title = `${set.id} ${i + 1}`;
    const asset = audio
      ? await importSound(library, title, { entityId: entity?.id ?? null, role })
      : await importImage(library, title, { entityId: entity?.id ?? null, role });
    const values = {};
    for (const sub of set.itemFields ?? []) values[sub.id] = await valueFor(sub, ctx);
    items.push({ assetId: asset.id, values });
  }
  /* A production-level set has no record; the column defaults to '' and a
     null would violate its NOT NULL constraint. */
  setAssetSetItems(library, productionId, entity
    ? { slot: set.id, entityId: entity.id, items }
    : { slot: set.id, items });
}

/**
 * Create a contract, a production answering it, and publish. Returns the same
 * shape the hand-written builders do, so the fixture generator needs no
 * special case for an app that has one and an app that does not.
 */
export async function buildAutoProduction(library, contractJson, { variant = 1 } = {}) {
  const contract = createContract(library, contractJson);
  const declared = contract.contract;

  const world = makeEntity(library, { type: 'world', name: nameFor('world', variant - 1) });
  const byType = new Map([['world', [world]]]);
  const perCharacter = [];

  const ctx = {
    library,
    lastEntityId: null,
    anyEntityOf(types) {
      for (const type of types) {
        const made = byType.get(type);
        if (made?.length) return made[0].id;
      }
      const entity = makeEntity(library, {
        type: types[0], name: nameFor(types[0], 0), worldId: types[0] === 'world' ? null : world.id,
      });
      byType.set(types[0], [...(byType.get(types[0]) ?? []), entity]);
      return entity.id;
    },
  };

  /* Selections first: fields and asset sets hang off the records they pick. */
  const production = createProduction(library, {
    name: variant === 1 ? 'Conformance production' : 'Conformance production v2',
    contractId: contract.contractId,
    worldId: world.id,
  });

  for (const selection of declared.entitySelections ?? []) {
    const type = (selection.entityTypes ?? ['character'])[0];
    const count = howMany(selection, { cap: 2 }) + (variant === 2 ? 1 : 0);
    const chosen = [];
    for (let i = 0; i < count; i++) {
      const existing = (byType.get(type) ?? [])[i];
      const entity = existing ?? makeEntity(library, {
        type, name: nameFor(type, i), worldId: type === 'world' ? null : world.id,
      });
      byType.set(type, [...new Set([...(byType.get(type) ?? []), entity])]);
      chosen.push(entity);
      if (type === 'character') perCharacter.push({ hero: entity });
    }
    setSelection(library, production.id, selection.id, chosen.map((entity) => entity.id));

    for (const entity of chosen) {
      ctx.lastEntityId = entity.id;
      for (const set of selection.assetSets ?? []) {
        await fillAssetSet(library, production.id, set, entity, ctx);
      }
      for (const def of selection.fields ?? []) {
        setProductionValue(library, production.id, {
          scope: 'entity', entityId: entity.id, field: def.id, value: await valueFor(def, ctx),
        });
      }
    }
  }

  ctx.lastEntityId = world.id;
  for (const set of declared.assetSets ?? []) {
    await fillAssetSet(library, production.id, set, null, ctx);
  }
  for (const def of declared.productionFields ?? []) {
    setProductionValue(library, production.id, {
      scope: 'production', field: def.id, value: await valueFor(def, ctx),
    });
  }

  if (declared.documents?.mode !== 'none') {
    createDocument(library, { title: 'Reference note', entityIds: [world.id] });
  }

  setProductionStatus(library, production.id, 'ready');
  const publication = await publishProduction(library, production.id);
  return { contract, canon: { world, heroes: perCharacter.map((p) => p.hero) }, production, publication, perCharacter };
}
