import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestLibrary, makeTempDir } from './helpers.mjs';
import {
  EXAMPLE_CONTRACT_PATH, importContractFile, contractDrift, createContract, getContract,
} from '../electron/services/contract-service.js';
import { createProduction, setProductionValue, setSelection, setAssetSetItems, setProductionStatus }
  from '../electron/services/production-service.js';
import { createEntity } from '../electron/services/entity-service.js';
import { importAsset, setAssetLinks } from '../electron/services/asset-service.js';
import sharp from 'sharp';

/**
 * A contract file on disk, the way a consumer repository keeps one.
 * A fresh library already holds the bundled example contract, so these
 * files declare an appType of their own unless a test wants the clash.
 */
function writeContractFile(dir, mutate = null, appType = 'example.imported-gallery') {
  const contract = JSON.parse(fs.readFileSync(EXAMPLE_CONTRACT_PATH, 'utf8'));
  contract.appType = appType;
  if (mutate) mutate(contract);
  const file = path.join(dir, 'application-contract.json');
  fs.writeFileSync(file, `${JSON.stringify(contract, null, 2)}\n`);
  return file;
}

test('importing a contract file records the file it came from', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const dir = makeTempDir('consumer-repo-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = writeContractFile(dir);
  const imported = importContractFile(library, file);

  assert.equal(imported.imported, 'created');
  assert.equal(imported.version, 1);
  assert.equal(imported.sourcePath, file);
  assert.deepEqual(contractDrift(library, imported.contractId), {
    tracked: true, drifted: false, unverifiable: false, sourcePath: file, reason: null, message: null,
  });
});

test('re-importing an unchanged file does not bump the revision', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const dir = makeTempDir('consumer-repo-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = writeContractFile(dir);
  const first = importContractFile(library, file);
  const again = importContractFile(library, file);

  assert.equal(again.imported, 'unchanged');
  assert.equal(again.version, first.version, 'the counter measures real changes, not re-reads');
  assert.equal(again.versions.length, 1);
});

test('importing a changed file becomes a new version of the same contract', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const dir = makeTempDir('consumer-repo-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = writeContractFile(dir);
  const first = importContractFile(library, file);
  writeContractFile(dir, (contract) => { contract.description = 'The application asked for something else.'; });
  const second = importContractFile(library, file);

  assert.equal(second.imported, 'updated');
  assert.equal(second.contractId, first.contractId, 'same contract, keyed by appType');
  assert.equal(second.version, 2);
  assert.equal(contractDrift(library, second.contractId).drifted, false);
});

test('drift can be asked about without changing the answer', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const dir = makeTempDir('consumer-repo-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = writeContractFile(dir);
  const imported = importContractFile(library, file);

  /* the application's repository moves on without telling the Hub */
  writeContractFile(dir, (contract) => { contract.requiredRecipes = ['tile_16x9']; });

  const first = contractDrift(library, imported.contractId);
  assert.equal(first.drifted, true);
  assert.equal(first.reason, 'changed');
  assert.match(first.message, /application-contract\.json/, 'the message names the file');

  const second = contractDrift(library, imported.contractId);
  assert.deepEqual(second, first, 'asking twice reports the same thing — checking is not a write');
  assert.equal(getContract(library, imported.contractId).version, 1, 'and the stored contract is untouched');
});

test('a source file this machine does not have is unverifiable, not drift', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const dir = makeTempDir('consumer-repo-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = writeContractFile(dir);
  const imported = importContractFile(library, file);
  fs.rmSync(file);

  /* The applications live in separate repositories precisely so that no
     machine needs all of them. Not being able to check is not the same as
     having found a difference, and must not stop the author working. */
  const drift = contractDrift(library, imported.contractId);
  assert.equal(drift.drifted, false, 'an absent file is not evidence of a change');
  assert.equal(drift.unverifiable, true);
  assert.equal(drift.reason, 'unreachable');
  assert.match(drift.message, /not on this machine/);
});

test('a production still publishes when its contract file is on another machine', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const dir = makeTempDir('consumer-repo-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = writeContractFile(dir);
  const contract = importContractFile(library, file);

  const world = createEntity(library, { type: 'world', name: 'Vel' });
  const nao = createEntity(library, { type: 'character', name: 'Nao', worldId: world.id });
  const png = await sharp({ create: { width: 60, height: 80, channels: 3, background: { r: 30, g: 60, b: 90 } } }).png().toBuffer();
  const portrait = await importAsset(library, { buffer: png, filename: 'nao.png', title: 'Nao portrait' });
  setAssetLinks(library, portrait.id, [{ entityId: nao.id, role: 'character.portrait' }]);

  const production = createProduction(library, { name: 'Gallery', contractId: contract.contractId, worldId: world.id });
  setProductionValue(library, production.id, { scope: 'production', field: 'gallery_title', value: 'Gallery' });
  setSelection(library, production.id, 'world', [world.id]);
  setSelection(library, production.id, 'cast', [nao.id]);
  setAssetSetItems(library, production.id, { slot: 'portrait', entityId: nao.id, items: [{ assetId: portrait.id }] });

  fs.rmSync(file);
  setProductionStatus(library, production.id, 'ready');
  assert.equal(library.db.prepare('SELECT status FROM productions WHERE id = ?').get(production.id).status, 'ready');
});

test('a contract authored in the app is untracked, which is not drift', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const contract = JSON.parse(fs.readFileSync(EXAMPLE_CONTRACT_PATH, 'utf8'));
  const created = createContract(library, contract);

  assert.deepEqual(contractDrift(library, created.contractId), {
    tracked: false, drifted: false, unverifiable: false, sourcePath: null, reason: null, message: null,
  });
});

test('a production on a drifted contract refuses to become ready, and says which file', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const dir = makeTempDir('consumer-repo-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const file = writeContractFile(dir);
  const contract = importContractFile(library, file);

  const world = createEntity(library, { type: 'world', name: 'Vel' });
  const nao = createEntity(library, { type: 'character', name: 'Nao', worldId: world.id });
  const png = await sharp({ create: { width: 60, height: 80, channels: 3, background: { r: 30, g: 60, b: 90 } } }).png().toBuffer();
  const portrait = await importAsset(library, { buffer: png, filename: 'nao.png', title: 'Nao portrait' });
  setAssetLinks(library, portrait.id, [{ entityId: nao.id, role: 'character.portrait' }]);

  const production = createProduction(library, { name: 'Gallery', contractId: contract.contractId, worldId: world.id });
  setProductionValue(library, production.id, { scope: 'production', field: 'gallery_title', value: 'Gallery' });
  setSelection(library, production.id, 'world', [world.id]);
  setSelection(library, production.id, 'cast', [nao.id]);
  setAssetSetItems(library, production.id, { slot: 'portrait', entityId: nao.id, items: [{ assetId: portrait.id }] });

  /* valid against what the Hub holds — until the application moves on */
  setProductionStatus(library, production.id, 'ready');
  setProductionStatus(library, production.id, 'draft');
  writeContractFile(dir, (c) => { c.description = 'Now it wants something else.'; });

  assert.throws(
    () => setProductionStatus(library, production.id, 'ready'),
    (error) => {
      assert.equal(error.code, 'production.contract_drifted');
      assert.match(error.message, /application-contract\.json/);
      return true;
    },
    'publishing against a stale contract is refused, not discovered later',
  );

  /* re-importing is the whole remedy */
  importContractFile(library, file);
  setProductionStatus(library, production.id, 'ready');
});

test('importing a file that matches an app-authored contract adopts it in place', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const dir = makeTempDir('consumer-repo-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  /* the library already holds this contract, typed in rather than imported */
  const existing = JSON.parse(fs.readFileSync(EXAMPLE_CONTRACT_PATH, 'utf8'));
  const before = getContract(library, library.db.prepare(
    'SELECT contract_id FROM application_contracts WHERE app_type = ?').get(existing.appType).contract_id);
  assert.equal(before.sourcePath, null, 'untracked to begin with');

  const file = writeContractFile(dir, null, existing.appType);
  const imported = importContractFile(library, file);

  assert.equal(imported.imported, 'unchanged');
  assert.equal(imported.contractId, before.contractId, 'adopted, not duplicated');
  assert.equal(imported.version, before.version, 'and no pointless new revision');
  assert.equal(imported.sourcePath, file, 'but it now knows where it came from');
  assert.equal(contractDrift(library, imported.contractId).drifted, false);
});
