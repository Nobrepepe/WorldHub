import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestLibrary } from './helpers.mjs';
import { vocabulary, assetRoles, recipeIds } from '../electron/services/vocabulary.js';
import {
  builtinConnectionKinds, connectionCategories, connectionKindsVersion,
} from '../electron/services/connection-vocabulary.js';
import { ASSET_ROLES } from '../electron/services/asset-service.js';

/**
 * kit/vocabulary.json is shipped to consuming applications. If it ever
 * disagrees with what a library actually contains, every consumer is
 * reading a map of somewhere else — which is precisely how a renamed
 * recipe became missing art rather than a load failure.
 */

test('the roles the service enforces are the roles the kit publishes', () => {
  assert.deepEqual(ASSET_ROLES, assetRoles());
});

test('the recipes a fresh library holds are exactly the recipes the kit publishes', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const inLibrary = library.db.prepare(
    'SELECT id, name, width, height, fit FROM rendition_recipes ORDER BY id').all();
  const inKit = [...vocabulary().recipes].sort((a, b) => a.id.localeCompare(b.id));

  assert.deepEqual(inLibrary.map((r) => r.id), inKit.map((r) => r.id),
    'a recipe added or renamed in a migration must be reflected in kit/vocabulary.json');
  for (const recipe of inKit) {
    const row = inLibrary.find((r) => r.id === recipe.id);
    assert.deepEqual(
      { id: row.id, name: row.name, width: row.width, height: row.height, fit: row.fit },
      { id: recipe.id, name: recipe.name, width: recipe.width, height: recipe.height, fit: recipe.fit },
      `recipe "${recipe.id}" differs between the library and the kit`);
  }
});

test('no current name is also listed as a former name', () => {
  const { renamedFrom } = vocabulary();
  const currentRecipes = new Set(recipeIds());
  const currentRoles = new Set(assetRoles());

  for (const [current, formerNames] of Object.entries(renamedFrom.recipes)) {
    assert.ok(currentRecipes.has(current), `renamedFrom names "${current}", which is not a current recipe`);
    for (const former of formerNames) {
      assert.equal(currentRecipes.has(former), false,
        `"${former}" is listed as retired but is still a live recipe`);
    }
  }
  for (const [current, formerNames] of Object.entries(renamedFrom.roles)) {
    assert.ok(currentRoles.has(current), `renamedFrom names "${current}", which is not a current role`);
    for (const former of formerNames) {
      assert.equal(currentRoles.has(former), false,
        `"${former}" is listed as retired but is still a live role`);
    }
  }
  for (const retired of Object.keys(vocabulary().retiredRoles).filter((k) => k !== '$comment')) {
    assert.equal(currentRoles.has(retired), false, `"${retired}" is marked retired but still live`);
  }
});


/**
 * Migration 012 carries a frozen copy of the built-in connection kinds
 * rather than reading kit/connection-kinds.json, because a migration that
 * read a file that can still change would seed different rows on replay.
 * A frozen copy is only safe while something notices it has fallen behind,
 * and this is that something.
 */
test('the connection kinds a fresh library holds are exactly the kinds the kit publishes', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const inLibrary = library.db.prepare(`
    SELECT id, category, forward_label, inverse_label, forward_section, inverse_section, sentence, symmetric
    FROM connection_kinds WHERE is_builtin = 1 ORDER BY id
  `).all();
  const inKit = [...builtinConnectionKinds()].sort((a, b) => a.id.localeCompare(b.id));

  assert.deepEqual(inLibrary.map((kind) => kind.id), inKit.map((kind) => kind.id),
    'a built-in kind added in a migration must be reflected in kit/connection-kinds.json, and vice versa');

  for (const kind of inKit) {
    const row = inLibrary.find((candidate) => candidate.id === kind.id);
    assert.deepEqual({
      id: row.id,
      category: row.category,
      forwardLabel: row.forward_label,
      inverseLabel: row.inverse_label,
      forwardSection: row.forward_section,
      inverseSection: row.inverse_section,
      sentence: row.sentence,
      symmetric: !!row.symmetric,
    }, {
      id: kind.id,
      category: kind.category,
      forwardLabel: kind.forwardLabel,
      inverseLabel: kind.inverseLabel,
      forwardSection: kind.forwardSection,
      inverseSection: kind.inverseSection,
      sentence: kind.sentence,
      symmetric: kind.symmetric,
    }, `connection kind "${kind.id}" differs between the library and the kit`);

    const pairs = library.db.prepare(
      'SELECT source_type, target_type FROM connection_kind_pairs WHERE kind_id = ? ORDER BY source_type, target_type')
      .all(kind.id)
      .map((pair) => ({ sourceType: pair.source_type, targetType: pair.target_type }));
    assert.deepEqual(pairs, [...kind.pairs].sort((a, b) =>
      a.sourceType.localeCompare(b.sourceType) || a.targetType.localeCompare(b.targetType)),
    `the endpoint pairs of "${kind.id}" differ between the library and the kit`);
  }
});

test('every connection kind names a category the vocabulary defines', () => {
  const categories = new Set(connectionCategories().map((category) => category.id));
  for (const kind of builtinConnectionKinds()) {
    assert.ok(categories.has(kind.category), `"${kind.id}" names the unknown category "${kind.category}"`);
  }
  assert.ok(categories.has('legacy'),
    'the upgrade files migrated kinds under "legacy", so that category has to exist');
  assert.ok(Number.isInteger(connectionKindsVersion()) && connectionKindsVersion() >= 1);
});

test('a symmetric kind reads the same from both sides', () => {
  for (const kind of builtinConnectionKinds().filter((candidate) => candidate.symmetric)) {
    assert.equal(kind.forwardLabel, kind.inverseLabel,
      `"${kind.id}" is symmetric but its two sides are labelled differently`);
    assert.equal(kind.forwardSection, kind.inverseSection,
      `"${kind.id}" is symmetric but its two sides are filed under different headings`);
    for (const pair of kind.pairs) {
      assert.equal(pair.sourceType, pair.targetType,
        `"${kind.id}" is symmetric, so it can only join records of one type`);
    }
  }
});
