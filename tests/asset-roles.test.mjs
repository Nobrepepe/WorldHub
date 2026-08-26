import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSET_ROLES } from '../electron/services/asset-service.js';
import {
  ROLE_ORDER, RECIPE_BY_ROLE, DEFAULT_PREVIEW_RECIPE,
  previewRecipeForRole, roleLabel, groupAssetsByRole, aspectForRecipe, ratioLabel, tileColumnRem,
} from '../src/ui/asset-roles.js';

/**
 * The role folders in a record's Assets tab. This is pure renderer logic
 * with no DOM in it, so it is tested directly.
 */

test('every semantic role has a folder position, and no folder invents a role', () => {
  assert.deepEqual([...ROLE_ORDER].sort(), [...ASSET_ROLES].sort());
  for (const role of Object.keys(RECIPE_BY_ROLE)) {
    assert.ok(ASSET_ROLES.includes(role), `${role} is not in the vocabulary`);
  }
});

test('character roles preview at their conventional shape', () => {
  assert.equal(previewRecipeForRole('character.portrait'), 'portrait_3x4');
  assert.equal(previewRecipeForRole('character.tile'), 'tile_16x9');
  assert.equal(previewRecipeForRole('character.stamp'), 'stamp_4x3');
  assert.equal(previewRecipeForRole('character.collectible'), 'square');
  assert.equal(previewRecipeForRole('character.full_body'), 'full_body_9x16');
  assert.equal(previewRecipeForRole('audio.cue'), DEFAULT_PREVIEW_RECIPE, 'a role with no shape falls back');
  assert.equal(previewRecipeForRole('something.unknown'), DEFAULT_PREVIEW_RECIPE);
});

test('folders read in vocabulary order, and art with two roles sits in both', () => {
  const folders = groupAssetsByRole([
    { id: 'stamp', entityRoles: ['character.stamp'] },
    { id: 'both', entityRoles: ['character.tile', 'character.portrait'] },
    { id: 'portrait', entityRoles: ['character.portrait'] },
    { id: 'odd', entityRoles: ['zz.unknown'] },
    { id: 'linkless', entityRoles: [] },
  ]);

  assert.deepEqual(folders.map((f) => f.role), [
    'character.portrait', 'character.tile', 'character.stamp', '', 'zz.unknown',
  ]);
  assert.deepEqual(folders[0].assets.map((a) => a.id), ['both', 'portrait']);
  assert.deepEqual(folders[1].assets.map((a) => a.id), ['both']);
  assert.equal(folders[0].recipeId, 'portrait_3x4');
  assert.equal(folders[3].label, 'Unfiled');
});

test('folder names read as words, not as identifiers', () => {
  assert.equal(roleLabel('character.full_body'), 'Full body');
  assert.equal(roleLabel('world.cover'), 'Cover');
  assert.equal(roleLabel('reference.document'), 'Document');
});

test('preview shape is read from the recipe canvas, so retuning a recipe moves its folder', () => {
  assert.equal(aspectForRecipe({ width: 900, height: 1200 }), '900 / 1200');
  assert.equal(ratioLabel({ width: 900, height: 1200 }), '3:4');
  assert.equal(ratioLabel({ width: 1600, height: 900 }), '16:9');
  assert.equal(ratioLabel({ width: 1280, height: 960 }), '4:3');
  assert.equal(ratioLabel({ width: 1024, height: 1024 }), '1:1');
  assert.equal(ratioLabel({ width: 900, height: 1600 }), '9:16');

  // A recipe with no canvas (the pass-through "original") must not break a folder.
  assert.equal(aspectForRecipe(undefined), '16 / 9');
  assert.equal(ratioLabel({ width: null, height: null }), '');
  assert.equal(tileColumnRem(undefined), 13);
});

test('columns widen for wide shapes and narrow for tall ones, within bounds', () => {
  const wide = tileColumnRem({ width: 1600, height: 900 });
  const tall = tileColumnRem({ width: 900, height: 1600 });
  assert.ok(tall < tileColumnRem({ width: 900, height: 1200 }));
  assert.ok(tileColumnRem({ width: 900, height: 1200 }) < wide);
  assert.ok(tall >= 9 && wide <= 20, 'neither shape escapes the readable range');
});
