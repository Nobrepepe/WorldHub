import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import sharp from 'sharp';
import { makeTestLibrary } from './helpers.mjs';
import {
  validateContractJson, createContract, updateContract, getContract, installExampleContract,
  duplicateContract, EXAMPLE_CONTRACT_PATH,
} from '../electron/services/contract-service.js';
import {
  createProduction, getProduction, setProductionValue, setSelection, setAssetSetItems,
  validateProduction, setProductionStatus,
} from '../electron/services/production-service.js';
import { createEntity, updateEntity } from '../electron/services/entity-service.js';
import { importAsset, setAssetLinks } from '../electron/services/asset-service.js';
import { validateFieldValue } from '../electron/services/field-engine.js';

const exampleContract = () => JSON.parse(fs.readFileSync(EXAMPLE_CONTRACT_PATH, 'utf8'));

test('contract schema validation accepts the example and rejects malformed contracts', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  assert.deepEqual(validateContractJson(exampleContract()), []);

  const missingFormat = { ...exampleContract() };
  delete missingFormat.format;
  assert.ok(validateContractJson(missingFormat).some((i) => i.code === 'contract.schema'));

  const badField = exampleContract();
  badField.productionFields.push({ id: 'x', label: 'X', type: 'enum' }); // enum without options
  assert.ok(validateContractJson(badField).length > 0);

  const dupIds = exampleContract();
  dupIds.productionFields.push({ ...dupIds.productionFields[0] });
  assert.ok(validateContractJson(dupIds).some((i) => i.code === 'contract.duplicate_id'));

  // Versioning: an edit creates a new version; the old one stays.
  const created = createContract(library, exampleContract());
  const edited = { ...exampleContract(), name: 'Edited Gallery' };
  const updated = updateContract(library, created.contractId, edited);
  assert.equal(updated.version, 2);
  assert.equal(getContract(library, created.contractId, 1).contract.name, 'Example Character Gallery');
  assert.equal(getContract(library, created.contractId).contract.name, 'Edited Gallery');

  const copy = duplicateContract(library, created.contractId);
  assert.notEqual(copy.contractId, created.contractId);
  assert.match(copy.name, /copy/);
});

test('the field engine validates every supported dynamic field type', () => {
  const refs = { entityExists: () => true, assetExists: () => true };
  const ok = (def, value) => assert.deepEqual(validateFieldValue(def, value, refs), [], `${def.type} accepts ${JSON.stringify(value)}`);
  const bad = (def, value) => assert.ok(validateFieldValue(def, value, refs).length > 0, `${def.type} rejects ${JSON.stringify(value)}`);

  ok({ id: 'a', label: 'A', type: 'shortText', maxLength: 5 }, 'hi');
  bad({ id: 'a', label: 'A', type: 'shortText', maxLength: 5 }, 'much too long');
  bad({ id: 'a', label: 'A', type: 'shortText' }, 'two\nlines');
  ok({ id: 'a', label: 'A', type: 'multilineText' }, 'two\nlines');
  ok({ id: 'a', label: 'A', type: 'markdown' }, '# Title');
  ok({ id: 'a', label: 'A', type: 'integer', min: 0, max: 10 }, 5);
  bad({ id: 'a', label: 'A', type: 'integer' }, 5.5);
  bad({ id: 'a', label: 'A', type: 'integer', max: 10 }, 11);
  ok({ id: 'a', label: 'A', type: 'number', min: 0 }, 1.25);
  bad({ id: 'a', label: 'A', type: 'number', min: 0 }, -1);
  ok({ id: 'a', label: 'A', type: 'boolean' }, true);
  bad({ id: 'a', label: 'A', type: 'boolean' }, 'yes');
  ok({ id: 'a', label: 'A', type: 'enum', options: [{ value: 'x', label: 'X' }] }, 'x');
  bad({ id: 'a', label: 'A', type: 'enum', options: [{ value: 'x', label: 'X' }] }, 'y');
  ok({ id: 'a', label: 'A', type: 'color' }, '#e9a94f');
  bad({ id: 'a', label: 'A', type: 'color' }, 'amber');
  ok({ id: 'a', label: 'A', type: 'entityRef', entityTypes: ['character'] }, '11111111-1111-4111-8111-111111111111');
  bad({ id: 'a', label: 'A', type: 'entityRef', entityTypes: ['character'] }, 'not-a-uuid');
  ok({ id: 'a', label: 'A', type: 'assetRef' }, '11111111-1111-4111-8111-111111111111');
  ok({ id: 'a', label: 'A', type: 'list', item: { id: 'i', label: 'I', type: 'integer' }, minItems: 1 }, [1, 2]);
  bad({ id: 'a', label: 'A', type: 'list', item: { id: 'i', label: 'I', type: 'integer' }, minItems: 1 }, []);
  ok({ id: 'a', label: 'A', type: 'list', fields: [{ id: 'n', label: 'N', type: 'shortText', required: true }] }, [{ n: 'x' }]);
  bad({ id: 'a', label: 'A', type: 'list', fields: [{ id: 'n', label: 'N', type: 'shortText', required: true }] }, [{}]);

  // required
  bad({ id: 'a', label: 'A', type: 'shortText', required: true }, undefined);
  ok({ id: 'a', label: 'A', type: 'shortText' }, undefined);
});

async function galleryFixture(library) {
  const contract = installExampleContract(library);
  const world = createEntity(library, { type: 'world', name: 'Vel' });
  const nao = createEntity(library, { type: 'character', name: 'Nao', worldId: world.id });
  const png = await sharp({ create: { width: 90, height: 120, channels: 3, background: { r: 40, g: 80, b: 120 } } }).png().toBuffer();
  const portrait = await importAsset(library, { buffer: png, filename: 'nao.png', title: 'Nao portrait' });
  setAssetLinks(library, portrait.id, [{ entityId: nao.id, role: 'character.portrait' }]);
  const production = createProduction(library, { name: 'First Gallery', contractId: contract.contractId, worldId: world.id });
  return { contract, world, nao, portrait, production };
}

test('production validation enforces counts, types, roles, and fields with structured issues', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const { world, nao, portrait, production } = await galleryFixture(library);

  // Fresh production: missing required title, empty selections.
  let result = validateProduction(library, production.id);
  assert.equal(result.state, 'errors');
  const codes = result.issues.map((i) => i.code);
  assert.ok(codes.includes('field.required'), 'missing gallery title');
  assert.ok(codes.includes('production.selection_short'), 'missing world and cast');
  const first = result.issues[0];
  assert.ok(first.severity && first.code && first.message && first.target && first.destination, 'issues are structured');

  setProductionValue(library, production.id, { scope: 'production', field: 'gallery_title', value: 'The Vel Cast' });
  setSelection(library, production.id, 'world', [world.id]);
  setSelection(library, production.id, 'cast', [nao.id]);
  setAssetSetItems(library, production.id, { slot: 'portrait', entityId: nao.id, items: [{ assetId: portrait.id }] });

  result = validateProduction(library, production.id);
  assert.equal(result.errors, 0, JSON.stringify(result.issues, null, 2));
  assert.equal(result.state, 'warnings', 'draft entities warn but do not block');
  assert.ok(result.issues.every((i) => i.severity === 'warning'));

  // Wrong role: link the portrait only as reference art.
  const png2 = await sharp({ create: { width: 50, height: 50, channels: 3, background: { r: 1, g: 1, b: 1 } } }).png().toBuffer();
  const wrongArt = await importAsset(library, { buffer: png2, filename: 'wrong.png', title: 'Wrong role art' });
  setAssetLinks(library, wrongArt.id, [{ entityId: nao.id, role: 'reference.art' }]);
  setAssetSetItems(library, production.id, { slot: 'portrait', entityId: nao.id, items: [{ assetId: wrongArt.id }] });
  result = validateProduction(library, production.id);
  assert.ok(result.issues.some((i) => i.code === 'production.asset_role'), 'role mismatch is an error');

  // Too many portraits.
  setAssetSetItems(library, production.id, { slot: 'portrait', entityId: nao.id, items: [{ assetId: portrait.id }, { assetId: wrongArt.id }] });
  result = validateProduction(library, production.id);
  assert.ok(result.issues.some((i) => i.code === 'production.asset_set_long'));

  // A world in the cast slot is a type error.
  setSelection(library, production.id, 'cast', [world.id]);
  result = validateProduction(library, production.id);
  assert.ok(result.issues.some((i) => i.code === 'production.selection_type'));
});

test('canonical references stay references: renames flow through without touching production data', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const { world, nao, portrait, production } = await galleryFixture(library);

  setProductionValue(library, production.id, { scope: 'production', field: 'gallery_title', value: 'Gallery' });
  setSelection(library, production.id, 'world', [world.id]);
  setSelection(library, production.id, 'cast', [nao.id]);
  setAssetSetItems(library, production.id, { slot: 'portrait', entityId: nao.id, items: [{ assetId: portrait.id }] });

  updateEntity(library, nao.id, { name: 'Naoline of the Vale' });
  const loaded = getProduction(library, production.id);
  assert.equal(loaded.selections.cast[0].name, 'Naoline of the Vale', 'the production shows the current canonical name');
  assert.equal(loaded.selections.cast[0].id, nao.id, 'by reference, not by copy');

  const valueRows = library.db.prepare('SELECT value_json FROM production_values WHERE production_id = ?').all(production.id);
  for (const row of valueRows) {
    assert.ok(!row.value_json.includes('Nao'), 'no canonical name is copied into production values');
  }
});

test('readiness is blocked by errors but not by warnings', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const { world, nao, portrait, production } = await galleryFixture(library);

  assert.throws(() => setProductionStatus(library, production.id, 'ready'), /cannot be marked ready/);

  setProductionValue(library, production.id, { scope: 'production', field: 'gallery_title', value: 'Gallery' });
  setSelection(library, production.id, 'world', [world.id]);
  setSelection(library, production.id, 'cast', [nao.id]);
  setAssetSetItems(library, production.id, { slot: 'portrait', entityId: nao.id, items: [{ assetId: portrait.id }] });

  // Still warnings (draft entities), but zero errors: ready succeeds.
  const ready = setProductionStatus(library, production.id, 'ready');
  assert.equal(ready.status, 'ready');
  assert.equal(ready.validationState, 'warnings');

  // Editing content returns it to draft.
  setProductionValue(library, production.id, { scope: 'production', field: 'gallery_title', value: 'Renamed Gallery' });
  assert.equal(getProduction(library, production.id).status, 'draft');
});
