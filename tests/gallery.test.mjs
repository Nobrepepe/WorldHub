import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { makeTestLibrary } from './helpers.mjs';
import { createEntity, archiveEntity } from '../electron/services/entity-service.js';
import { importAsset, setAssetLinks, setAssetArchived, generateRendition } from '../electron/services/asset-service.js';
import { characterWall } from '../electron/services/gallery-service.js';

async function makePng(seed) {
  return sharp({ create: { width: 30 + seed, height: 40, channels: 4, background: { r: seed * 20, g: 90, b: 140, alpha: 0.5 } } }).png().toBuffer();
}

test('the wall offers living characters’ art under the character roles, named and placed in a world', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const world = createEntity(library, { type: 'world', name: 'Vel' });
  const nao = createEntity(library, { type: 'character', name: 'Nao', worldId: world.id });
  const bram = createEntity(library, { type: 'character', name: 'Bram' });
  const gone = createEntity(library, { type: 'character', name: 'Gone', worldId: world.id });

  const portrait = await importAsset(library, { buffer: await makePng(1), filename: 'nao-portrait.png', title: 'Nao portrait', entityId: nao.id, role: 'character.portrait' });
  const stamp = await importAsset(library, { buffer: await makePng(2), filename: 'bram-stamp.png', title: 'Bram stamp', entityId: bram.id, role: 'character.stamp' });
  const shared = await importAsset(library, { buffer: await makePng(3), filename: 'pair.png', title: 'Pair' });
  setAssetLinks(library, shared.id, [
    { entityId: nao.id, role: 'character.full_body' },
    { entityId: bram.id, role: 'character.full_body' },
  ]);
  const cover = await importAsset(library, { buffer: await makePng(4), filename: 'vel.png', title: 'Vel cover', entityId: world.id, role: 'world.cover' });
  const reference = await importAsset(library, { buffer: await makePng(5), filename: 'ref.png', title: 'Nao reference', entityId: nao.id, role: 'reference.art' });
  const retired = await importAsset(library, { buffer: await makePng(6), filename: 'old.png', title: 'Old portrait', entityId: nao.id, role: 'character.portrait' });
  setAssetArchived(library, retired.id, true);
  const hidden = await importAsset(library, { buffer: await makePng(7), filename: 'gone.png', title: 'Gone portrait', entityId: gone.id, role: 'character.portrait' });
  archiveEntity(library, gone.id);

  const wall = characterWall(library);
  const ids = wall.map((piece) => piece.assetId);

  assert.ok(ids.includes(portrait.id));
  assert.ok(ids.includes(stamp.id));
  assert.ok(!ids.includes(cover.id), 'world art is not character art');
  assert.ok(!ids.includes(reference.id), 'reference art is not for presentation');
  assert.ok(!ids.includes(retired.id), 'archived art stays off the wall');
  assert.ok(!ids.includes(hidden.id), 'art follows an archived character out of sight');
  assert.equal(ids.filter((id) => id === shared.id).length, 1, 'one image under one role hangs once');

  const naoPortrait = wall.find((piece) => piece.assetId === portrait.id);
  assert.equal(naoPortrait.name, 'Nao');
  assert.equal(naoPortrait.worldName, 'Vel');
  assert.equal(naoPortrait.recipeId, 'portrait_3x4');
  assert.equal(naoPortrait.isRendition, false, 'the original until a rendition exists');
  assert.equal(wall.find((piece) => piece.assetId === stamp.id).worldName, null);
  assert.equal(wall.find((piece) => piece.assetId === stamp.id).recipeId, 'stamp_4x3');
});

test('the wall prefers a piece’s rendition once it has been made', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const nao = createEntity(library, { type: 'character', name: 'Nao' });
  const tile = await importAsset(library, { buffer: await makePng(1), filename: 'nao-tile.png', title: 'Nao tile', entityId: nao.id, role: 'character.tile' });

  await generateRendition(library, tile.currentVersionId, 'tile_16x9');
  const [piece] = characterWall(library);
  assert.equal(piece.isRendition, true);
  assert.match(piece.url, /^worldhub:\/\/media\/rendition\//);
});
