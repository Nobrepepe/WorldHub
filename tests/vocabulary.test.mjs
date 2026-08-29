import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestLibrary } from './helpers.mjs';
import { vocabulary, assetRoles, recipeIds } from '../electron/services/vocabulary.js';
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
