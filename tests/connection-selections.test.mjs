import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestLibrary } from './helpers.mjs';
import { createEntity, updateEntity } from '../electron/services/entity-service.js';
import { createConnection, createConnectionKind } from '../electron/services/connection-service.js';
import {
  createContract, validateContractJson, validateContractAgainstLibrary,
} from '../electron/services/contract-service.js';
import { createProduction, setSelection, validateProduction } from '../electron/services/production-service.js';

/**
 * An application declares which canonical connection kinds it consumes, and
 * how many each of its source records may have. The facts stay in canon.
 *
 * The distinction these tests exist to hold: a cardinality an application
 * cannot render is an error, while a connection pointing at a record the
 * author has not selected is only a warning — the canon is fine, the package
 * simply will not carry the other end. Turning the second into a silent
 * traversal is how choosing one character comes to export half a world.
 */

const BASE = {
  format: 'world-hub-application-contract',
  contractFormatVersion: 1,
  appType: 'test.connections',
  name: 'Connection test app',
  supportedProtocolVersions: [1, 2],
  entitySelections: [
    { id: 'cast', label: 'Cast', entityTypes: ['character'], min: 0 },
    { id: 'factions', label: 'Factions', entityTypes: ['group'], min: 0 },
  ],
  documents: { mode: 'none' },
};

const withConnections = (connectionSelections) => ({ ...BASE, connectionSelections });

const membership = (over = {}) => ({
  id: 'memberships',
  label: 'Faction memberships',
  kinds: ['member_of'],
  sourceSelection: 'cast',
  targetSelection: 'factions',
  ...over,
});

async function scene(t, contractJson) {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const contract = createContract(library, contractJson);
  const world = createEntity(library, { type: 'world', name: 'Emberfall' });
  /* Canonical, so the only warnings these tests see are the ones they are
     about rather than "this record is still a draft". */
  const make = (type, name) => updateEntity(
    library, createEntity(library, { type, name, worldId: world.id }).id, { status: 'canonical' });
  const scene = {
    library,
    contract,
    world,
    nao: make('character', 'Nao'),
    bram: make('character', 'Bram'),
    wardens: make('group', 'Kozuki Wardens'),
    watch: make('group', 'Night Watch'),
  };
  scene.production = createProduction(library, {
    name: 'Pack', contractId: contract.contractId, worldId: world.id,
  });
  scene.select = (slot, ids) => setSelection(library, scene.production.id, slot, ids);
  scene.check = () => validateProduction(library, scene.production.id);
  return scene;
}

const codes = (result) => result.issues.map((issue) => issue.code);

test('a contract without connection selections is exactly as valid as it was', async () => {
  assert.deepEqual(validateContractJson(BASE), []);
  assert.deepEqual(validateContractJson({ ...BASE, connectionSelections: [] }), []);
});

test('a connection selection must name selections this contract actually has', () => {
  const issues = validateContractJson(withConnections([membership({ targetSelection: 'guilds' })]));
  assert.deepEqual(issues.map((issue) => issue.code), ['contract.connection_selection_missing']);
  assert.match(issues[0].message, /runs to "guilds", which is not one of this contract's record selections/);

  const conflicting = validateContractJson(withConnections([membership({ minPerSource: 2, maxPerSource: 1 })]));
  assert.deepEqual(conflicting.map((issue) => issue.code), ['contract.count_conflict']);

  const duplicated = validateContractJson(withConnections([membership(), membership()]));
  assert.ok(duplicated.some((issue) => issue.code === 'contract.duplicate_id'));
});

test('whether the kinds exist, and can join those record types, is asked of the library', async (t) => {
  const s = await scene(t, BASE);

  /* Pure validation cannot answer this and does not pretend to. */
  const unknown = withConnections([membership({ kinds: ['sworn_to'] })]);
  assert.deepEqual(validateContractJson(unknown), []);
  const missing = validateContractAgainstLibrary(s.library, unknown);
  assert.deepEqual(missing.map((issue) => issue.code), ['contract.connection_kind_missing']);
  assert.match(missing[0].message, /which this library does not have/);

  /* Defined here, it validates — the same document, a different library. */
  createConnectionKind(s.library, {
    category: 'affiliation', forwardLabel: 'Sworn to', inverseLabel: 'Sworn sword',
    pairs: [{ sourceType: 'character', targetType: 'group' }],
  });
  assert.deepEqual(validateContractAgainstLibrary(s.library, unknown), []);

  /* A kind that cannot run between those two selections is refused. */
  const wrongWay = withConnections([membership({ sourceSelection: 'factions', targetSelection: 'cast' })]);
  const incompatible = validateContractAgainstLibrary(s.library, wrongWay);
  assert.deepEqual(incompatible.map((issue) => issue.code), ['contract.connection_kind_incompatible']);
  assert.match(incompatible[0].message, /cannot run from “Factions”/);
});

test('a required connection missing from the selected set is an error', async (t) => {
  const s = await scene(t, withConnections([membership({ minPerSource: 1, maxPerSource: 1 })]));
  s.select('cast', [s.nao.id, s.bram.id]);
  s.select('factions', [s.wardens.id]);

  let result = s.check();
  assert.equal(result.issues.filter((issue) => issue.code === 'production.connection_short').length, 2,
    'neither hero belongs to anything yet');

  createConnection(s.library, { kindId: 'member_of', entityId: s.nao.id, counterpartId: s.wardens.id });
  createConnection(s.library, { kindId: 'member_of', entityId: s.bram.id, counterpartId: s.wardens.id });
  result = s.check();
  assert.deepEqual(codes(result), [], 'canon now says what the contract asked for');
  assert.equal(result.state, 'valid');
});

test('an application may allow fewer memberships than canon does, and says so as its own rule', async (t) => {
  const s = await scene(t, withConnections([membership({ maxPerSource: 1 })]));
  s.select('cast', [s.nao.id]);
  s.select('factions', [s.wardens.id, s.watch.id]);

  /* World Hub is content for Nao to belong to both. */
  createConnection(s.library, { kindId: 'member_of', entityId: s.nao.id, counterpartId: s.wardens.id });
  createConnection(s.library, { kindId: 'member_of', entityId: s.nao.id, counterpartId: s.watch.id });

  const result = s.check();
  const tooMany = result.issues.find((issue) => issue.code === 'production.connection_long');
  assert.ok(tooMany, 'the application cannot show two, and says so');
  assert.equal(tooMany.severity, 'error');
  assert.match(tooMany.message, /That is this application's rule, not a canonical one/);

  /* Deselecting one faction resolves it without touching canon. */
  s.select('factions', [s.wardens.id]);
  const after = s.check();
  assert.equal(after.errors, 0);
  assert.equal(
    s.library.db.prepare(`SELECT COUNT(*) n FROM connections WHERE source_id = ?`).get(s.nao.id).n, 2,
    'both memberships are still canon; only what this pack carries changed');
});

test('a connection pointing outside the selection is an actionable warning, never a traversal', async (t) => {
  const s = await scene(t, withConnections([membership()]));
  s.select('cast', [s.nao.id]);
  s.select('factions', []);
  createConnection(s.library, { kindId: 'member_of', entityId: s.nao.id, counterpartId: s.wardens.id });

  const result = s.check();
  const warning = result.issues.find((issue) => issue.code === 'production.connection_target_unselected');
  assert.ok(warning);
  assert.equal(warning.severity, 'warning', 'the canon is fine; only this package is incomplete');
  assert.equal(result.errors, 0, 'and it does not block readiness');
  assert.match(warning.message,
    /Nao is connected to Kozuki Wardens, but Kozuki Wardens is not selected under “factions”/);

  /* It names the record and where it belongs, which is what lets the
     production editor offer to add it rather than adding it silently. */
  assert.equal(warning.target.targetEntityId, s.wardens.id);
  assert.equal(warning.target.targetSelection, 'factions');
  assert.equal(warning.target.targetName, 'Kozuki Wardens');
  assert.equal(warning.destination, 'selection:factions');

  /* Taking the offer resolves it, and nothing else came along. */
  s.select('factions', [s.wardens.id]);
  assert.deepEqual(codes(s.check()), []);
  assert.deepEqual(
    s.library.db.prepare('SELECT COUNT(*) n FROM production_entities WHERE production_id = ?')
      .get(s.production.id).n, 2, 'one character and one group — not the whole graph');
});

test('a contract naming a kind the library lost fails the production, not the document', async (t) => {
  const s = await scene(t, withConnections([membership({ kinds: ['member_of'] })]));
  s.select('cast', [s.nao.id]);
  s.select('factions', [s.wardens.id]);
  assert.deepEqual(codes(s.check()), []);

  s.library.db.prepare('DELETE FROM connection_kind_pairs WHERE kind_id = ?').run('member_of');
  s.library.db.prepare('DELETE FROM connection_kinds WHERE id = ?').run('member_of');

  const result = s.check();
  assert.ok(result.issues.some((issue) => issue.code === 'contract.connection_kind_missing'));
  assert.ok(result.errors > 0, 'publishing against a vocabulary that has moved is refused');
});
