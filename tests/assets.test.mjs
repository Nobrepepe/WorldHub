import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { makeTestLibrary, tinyWav } from './helpers.mjs';
import { createEntity, getEntity, updateEntity, preferredArtAsset, preferredRendition } from '../electron/services/entity-service.js';
import {
  storeBlob, importAsset, addAssetVersion, getAsset, setAssetLinks, listAssets,
  setCrop, generateRendition, setAssetArchived, auditUnreferencedBlobs, trashUnreferencedBlobs,
  updateRecipe, listRecipes,
} from '../electron/services/asset-service.js';
import { classifyFile } from '../electron/services/file-signatures.js';

async function makePng({ width = 64, height = 48, alpha = false } = {}) {
  // A gradient, not a flat color, so crops produce different pixels.
  const channels = alpha ? 4 : 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      raw[i] = Math.floor((x / width) * 255);
      raw[i + 1] = Math.floor((y / height) * 255);
      raw[i + 2] = 120;
      if (alpha) raw[i + 3] = 128;
    }
  }
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
}

test('file signatures decide the kind; lying extensions are rejected', async () => {
  const png = await makePng();
  assert.equal(classifyFile('art.png', png).kind, 'image');
  assert.equal(classifyFile('art.jpg', png).ext, 'png', 'bytes beat the extension');
  assert.equal(classifyFile('song.wav', tinyWav()).kind, 'audio');
  assert.equal(classifyFile('notes.md', Buffer.from('# hello')).kind, 'markdown');
  assert.equal(classifyFile('data.zip', Buffer.from('PK...random')).kind, 'attachment');
  assert.equal(classifyFile('fake.png', Buffer.from('this is not an image')), null);
  assert.equal(classifyFile('empty.png', Buffer.alloc(0)), null);
});

test('identical bytes deduplicate into one blob shared by separate assets', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const png = await makePng();

  const first = await importAsset(library, { buffer: png, filename: 'nao-portrait.png', title: 'Nao portrait' });
  const second = await importAsset(library, { buffer: png, filename: 'same-bytes.png', title: 'Duplicate art' });

  assert.equal(first.versions[0].blobHash, second.versions[0].blobHash);
  assert.notEqual(first.id, second.id);

  const hash = first.versions[0].blobHash;
  const blobAbs = path.join(root, 'assets', 'originals', hash.slice(0, 2), `${hash}.png`);
  assert.ok(fs.existsSync(blobAbs), 'content-addressed blob exists');
  assert.equal(library.db.prepare('SELECT COUNT(*) n FROM blobs').get().n, 1, 'one blob row');
});

test('replacement creates an immutable new version; old bytes stay resolvable', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const v1png = await makePng({ width: 32, height: 32 });
  const v2png = await makePng({ width: 128, height: 96 });
  const asset = await importAsset(library, { buffer: v1png, filename: 'art-v1.png', title: 'Key art' });
  const updated = await addAssetVersion(library, asset.id, { buffer: v2png, filename: 'art-v2.png', note: 'cleaner lines' });

  assert.equal(updated.versions.length, 2);
  assert.equal(updated.versions[0].versionNumber, 2, 'newest first');
  assert.equal(updated.currentVersionId, updated.versions[0].id);

  const oldVersion = updated.versions[1];
  const oldAbs = path.join(root, ...oldVersion.url.replace('worldhub://media/blob/', 'assets/originals/').replace(/^(..)/, '$1/').split('/'));
  void oldAbs;
  const oldBlobPath = path.join(root, 'assets', 'originals', oldVersion.blobHash.slice(0, 2), `${oldVersion.blobHash}.png`);
  assert.ok(fs.existsSync(oldBlobPath), 'previous version bytes are never deleted');
  assert.equal(oldVersion.width, 32);

  await assert.rejects(
    () => addAssetVersion(library, asset.id, { buffer: tinyWav(), filename: 'not-art.wav' }),
    /holds image content/,
  );
});

test('roles link assets to entities; lists filter by role and entity', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const world = createEntity(library, { type: 'world', name: 'Vel' });
  const nao = createEntity(library, { type: 'character', name: 'Nao', worldId: world.id });
  const asset = await importAsset(library, { buffer: await makePng(), filename: 'nao.png', title: 'Nao art' });

  setAssetLinks(library, asset.id, [
    { entityId: nao.id, role: 'character.portrait' },
    { entityId: world.id, role: 'world.cover' },
  ]);

  assert.equal(listAssets(library, { entityId: nao.id }).length, 1);
  assert.equal(listAssets(library, { role: 'world.cover' }).length, 1);
  assert.equal(listAssets(library, { role: 'character.stamp' }).length, 0);
  assert.equal(listAssets(library, { worldId: world.id }).length, 1, 'world filter follows links');
});

test('character art roles are accepted and filterable', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const world = createEntity(library, { type: 'world', name: 'Role World' });
  const character = createEntity(library, { type: 'character', name: 'Role Character', worldId: world.id });
  const stamp = await importAsset(library, {
    buffer: await makePng(), filename: 'stamp.png', title: 'Stamp art',
    entityId: character.id, role: 'character.stamp',
  });
  const collectible = await importAsset(library, {
    buffer: await makePng(), filename: 'collectible.png', title: 'Collectible art',
    entityId: character.id, role: 'character.collectible',
  });

  assert.deepEqual(listAssets(library, { role: 'character.stamp' }).map((asset) => asset.id), [stamp.id]);
  assert.deepEqual(listAssets(library, { role: 'character.collectible' }).map((asset) => asset.id), [collectible.id]);
});

test('a record and a role together name one link, and each asset reports its roles for that record', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const world = createEntity(library, { type: 'world', name: 'Shared World' });
  const nao = createEntity(library, { type: 'character', name: 'Nao', worldId: world.id });
  const bram = createEntity(library, { type: 'character', name: 'Bram', worldId: world.id });

  // One picture serving two records under two different roles.
  const shared = await importAsset(library, { buffer: await makePng(), filename: 'shared.png', title: 'Shared art' });
  setAssetLinks(library, shared.id, [
    { entityId: nao.id, role: 'character.portrait' },
    { entityId: bram.id, role: 'character.tile' },
  ]);
  const naoTile = await importAsset(library, {
    buffer: await makePng({ width: 80, height: 45 }), filename: 'nao-tile.png', title: 'Nao tile',
    entityId: nao.id, role: 'character.tile',
  });

  assert.deepEqual(
    listAssets(library, { entityId: nao.id, role: 'character.tile' }).map((a) => a.id),
    [naoTile.id],
    "Bram's tile role must not put the shared art in Nao's tile folder",
  );
  assert.deepEqual(
    listAssets(library, { entityId: nao.id, role: 'character.portrait' }).map((a) => a.id),
    [shared.id],
  );

  const forNao = listAssets(library, { entityId: nao.id }).find((a) => a.id === shared.id);
  assert.deepEqual(forNao.entityRoles, ['character.portrait'], 'roles are reported for the record being browsed');
  assert.deepEqual(forNao.roles.sort(), ['character.portrait', 'character.tile'], 'every role the asset holds is still reported');
  assert.deepEqual(listAssets(library, {})[0].entityRoles, [], 'no record named, no per-record roles');
});

test('list previews prefer the rendition of the recipe the caller asked for', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const world = createEntity(library, { type: 'world', name: 'Preview World' });
  const character = createEntity(library, { type: 'character', name: 'Preview Character', worldId: world.id });
  const asset = await importAsset(library, {
    buffer: await makePng({ width: 300, height: 400 }), filename: 'portrait.png', title: 'Portrait art',
    entityId: character.id, role: 'character.portrait',
  });

  const blobUrl = listAssets(library, { entityId: character.id, recipeId: 'portrait_3x4' })[0].thumbUrl;
  assert.match(blobUrl, /^worldhub:\/\/media\/blob\//, 'until one is generated, the original stands in');

  const rendition = await generateRendition(library, asset.currentVersionId, 'portrait_3x4');
  const listed = listAssets(library, { entityId: character.id, recipeId: 'portrait_3x4' })[0];
  assert.equal(listed.thumbUrl, `worldhub://media/rendition/${rendition.id}`);
  assert.match(
    listAssets(library, { entityId: character.id })[0].thumbUrl,
    /^worldhub:\/\/media\/blob\//,
    'the default recipe has no rendition yet, so it does not borrow the portrait one',
  );
});

test('display art supports automatic selection, explicit replacement, clearing, fallback and rendition regeneration', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const world = createEntity(library, { type: 'world', name: 'Display World' });
  const first = await importAsset(library, {
    buffer: await makePng({ width: 1200, height: 800 }), filename: 'first.png', title: 'First cover',
    entityId: world.id, role: 'world.cover',
  });
  assert.equal(getEntity(library, world.id).profile.cover_asset_id, first.id, 'the first role filing fills an empty slot');

  const second = await importAsset(library, {
    buffer: await makePng({ width: 1000, height: 700 }), filename: 'second.png', title: 'Second cover',
    entityId: world.id, role: 'world.cover',
  });
  assert.equal(getEntity(library, world.id).profile.cover_asset_id, first.id, 'another association never replaces a preference');
  updateEntity(library, world.id, { profile: { coverAssetId: second.id } });
  assert.equal(preferredArtAsset(library.db, 'world', world.id), second.id, 'explicit replacement wins');

  updateEntity(library, world.id, { profile: { coverAssetId: null } });
  assert.equal(preferredArtAsset(library.db, 'world', world.id), first.id, 'clearing uses the first compatible role fallback');
  updateEntity(library, world.id, { profile: { coverAssetId: second.id } });
  setAssetArchived(library, second.id, true);
  assert.equal(preferredArtAsset(library.db, 'world', world.id), first.id, 'an archived preference falls back safely');
  setAssetArchived(library, second.id, false);
  setAssetLinks(library, second.id, []);
  assert.equal(getEntity(library, world.id).profile.cover_asset_id, second.id, 'disassociation preserves the preference so the UI can explain it');
  assert.equal(preferredArtAsset(library.db, 'world', world.id), first.id, 'a disassociated preference is not displayed');

  const beforeVersion = await preferredRendition(library, 'world', world.id, 'tile_16x9');
  const replaced = await addAssetVersion(library, first.id, {
    buffer: await makePng({ width: 1400, height: 900 }), filename: 'first-v2.png',
  });
  const afterVersion = await preferredRendition(library, 'world', world.id, 'tile_16x9');
  assert.equal(afterVersion.versionId, replaced.currentVersionId, 'presentation resolves the current asset version');
  assert.notEqual(afterVersion.url, beforeVersion.url, 'a new version receives a new rendition');
  setCrop(library, {
    versionId: replaced.currentVersionId, recipeId: 'tile_16x9', focalX: 0.8, focalY: 0.3,
    zoom: 1.3, panX: 0, panY: 0, rotation: 0, background: '',
  });
  const afterCrop = await preferredRendition(library, 'world', world.id, 'tile_16x9');
  assert.notEqual(afterCrop.url, afterVersion.url, 'a crop change regenerates the rendition immediately');

  const background = await importAsset(library, {
    buffer: await makePng({ width: 1500, height: 900 }), filename: 'background.png', title: 'World background',
    entityId: world.id, role: 'world.background',
  });
  assert.equal(preferredArtAsset(library.db, 'world', world.id, 'background'), background.id, 'world headers resolve background art independently');
  assert.equal(preferredArtAsset(library.db, 'world', world.id, 'cover'), first.id, 'world galleries continue resolving cover art');

  const character = createEntity(library, { type: 'character', name: 'Tile Hero', worldId: world.id });
  const portrait = await importAsset(library, {
    buffer: await makePng(), filename: 'portrait.png', title: 'Portrait',
    entityId: character.id, role: 'character.portrait',
  });
  const tile = await importAsset(library, {
    buffer: await makePng({ width: 900, height: 500 }), filename: 'tile.png', title: 'Tile',
    entityId: character.id, role: 'character.tile',
  });
  const characterProfile = getEntity(library, character.id).profile;
  assert.equal(characterProfile.portrait_asset_id, portrait.id);
  assert.equal(characterProfile.tile_asset_id, tile.id);
  assert.equal(preferredArtAsset(library.db, 'character', character.id, 'portrait'), portrait.id, 'character galleries resolve portraits');
  assert.equal(preferredArtAsset(library.db, 'character', character.id, 'tile'), tile.id, 'character headers resolve tiles');

});

test('renditions are deterministic, cached, and invalidated by crop changes', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const png = await makePng({ width: 1400, height: 1100 });
  const asset = await importAsset(library, { buffer: png, filename: 'scene.png', title: 'Scene' });
  const versionId = asset.currentVersionId;

  const first = await generateRendition(library, versionId, 'square');
  assert.equal(first.width, 1024);
  assert.equal(first.height, 1024);
  const firstBytes = fs.readFileSync(path.join(root, ...first.path.split('/')));

  const cachedAgain = await generateRendition(library, versionId, 'square');
  assert.equal(cachedAgain.id, first.id, 'same fingerprint returns the cached rendition');

  // Regeneration after deleting the file is byte-identical.
  fs.rmSync(path.join(root, ...first.path.split('/')));
  const regenerated = await generateRendition(library, versionId, 'square');
  const regeneratedBytes = fs.readFileSync(path.join(root, ...regenerated.path.split('/')));
  assert.deepEqual(regeneratedBytes, firstBytes, 'deterministic output');

  // A crop change invalidates the cache and removes stale output.
  setCrop(library, { versionId, recipeId: 'square', focalX: 0.2, focalY: 0.3, zoom: 2, panX: 0, panY: 0, rotation: 0, background: '' });
  const cropped = await generateRendition(library, versionId, 'square');
  assert.notEqual(cropped.fingerprint, first.fingerprint);
  assert.ok(!fs.existsSync(path.join(root, ...regenerated.path.split('/'))), 'stale rendition removed');
  const croppedBytes = fs.readFileSync(path.join(root, ...cropped.path.split('/')));
  assert.notDeepEqual(croppedBytes, firstBytes, 'crop actually changes pixels');

  // The original is untouched throughout.
  const blobPath = path.join(root, 'assets', 'originals', asset.versions[0].blobHash.slice(0, 2), `${asset.versions[0].blobHash}.png`);
  assert.deepEqual(fs.readFileSync(blobPath), png, 'crop is never baked into the original');
});

test('every built-in recipe carries transparency through, edges included', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  // A silhouette: opaque in the middle, fully transparent at the edges.
  const width = 300;
  const height = 200;
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      raw[i] = 220; raw[i + 1] = 120; raw[i + 2] = 60;
      raw[i + 3] = Math.hypot(x - width / 2, y - height / 2) < 60 ? 255 : 0;
    }
  }
  const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const asset = await importAsset(library, { buffer: png, filename: 'sprite.png', title: 'Sprite' });

  const recipes = listRecipes(library).filter((recipe) => recipe.format === 'webp');
  assert.ok(recipes.length >= 6, 'the built-in recipes are present');
  for (const recipe of recipes) {
    const rendition = await generateRendition(library, asset.currentVersionId, recipe.id);
    const file = path.join(root, ...rendition.path.split('/'));
    const meta = await sharp(file).metadata();
    assert.equal(meta.hasAlpha, true, `${recipe.id} keeps an alpha channel`);
    const corner = await sharp(file).ensureAlpha().extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    assert.equal(corner[3], 0, `${recipe.id} leaves the transparent corner transparent, not matted`);
  }

  // A recipe deliberately set to matte still mattes, onto its background.
  updateRecipe(library, 'square', { preserveAlpha: false, background: '#ffffff' });
  const matted = await generateRendition(library, asset.currentVersionId, 'square');
  const mattedFile = path.join(root, ...matted.path.split('/'));
  assert.equal((await sharp(mattedFile).metadata()).hasAlpha, false, 'the matting path still works');
  const mattedCorner = await sharp(mattedFile).ensureAlpha().extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
  assert.deepEqual([...mattedCorner].slice(0, 3), [255, 255, 255], 'matted onto the requested background');
});

test('archiving hides assets without touching bytes; audit finds unreferenced blobs', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const asset = await importAsset(library, { buffer: await makePng(), filename: 'old.png', title: 'Old art' });
  setAssetArchived(library, asset.id, true);
  assert.equal(listAssets(library, {}).length, 0);
  assert.equal(listAssets(library, { status: 'archived' }).length, 1);
  const hash = asset.versions[0].blobHash;
  assert.ok(fs.existsSync(path.join(root, 'assets', 'originals', hash.slice(0, 2), `${hash}.png`)), 'archive never deletes bytes');

  // A directly stored blob with no version is the audit's target.
  const stray = await storeBlob(library, await makePng({ width: 10, height: 10 }), 'stray.png');
  const audit = auditUnreferencedBlobs(library);
  assert.deepEqual(audit.map((b) => b.hash), [stray.hash]);
  assert.match(audit[0].reason, /No asset version/);

  const moved = trashUnreferencedBlobs(library, [stray.hash, hash]);
  assert.deepEqual(moved.map((m) => m.hash), [stray.hash], 'referenced blob is refused even when asked');
  assert.ok(fs.existsSync(path.join(root, 'trash', 'blobs', `${stray.hash}.png`)), 'recoverable trash');
});

test('upscaling is refused for every fit unless the recipe allows it', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const small = await makePng({ width: 200, height: 150 });
  const asset = await importAsset(library, { buffer: small, filename: 'small.png', title: 'Small art' });

  // cover recipe, allow_upscale off: the output stays at source scale.
  const capped = await generateRendition(library, asset.currentVersionId, 'square');
  assert.ok(capped.width <= 200 && capped.height <= 200, `not enlarged: ${capped.width}×${capped.height}`);

  // allow upscaling: the full canvas is produced.
  updateRecipe(library, 'square', { allowUpscale: true });
  const upscaled = await generateRendition(library, asset.currentVersionId, 'square');
  assert.equal(upscaled.width, 1024);
  assert.equal(upscaled.height, 1024);
});

test('unknown semantic roles are refused everywhere links are made', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const nao = createEntity(library, { type: 'character', name: 'Nao' });
  const asset = await importAsset(library, { buffer: await makePng(), filename: 'art.png', title: 'Art' });

  assert.throws(
    () => setAssetLinks(library, asset.id, [{ entityId: nao.id, role: 'character.portait' }]),
    /not a World Hub semantic role/,
    'typo roles never become data',
  );
  assert.throws(
    () => setAssetLinks(library, asset.id, [{ entityId: nao.id, role: 'character.sprite' }]),
    /not a World Hub semantic role/,
    'retired roles are refused like any other unknown role',
  );
  const tinyPng = await makePng({ width: 12, height: 12 });
  await assert.rejects(
    () => importAsset(library, { buffer: tinyPng, filename: 'x.png', title: 'X', entityId: nao.id, role: 'made.up' }),
    /not a World Hub semantic role/,
  );
  setAssetLinks(library, asset.id, [{ entityId: nao.id, role: 'character.portrait' }]);
});

test('missing blob is reported when generating a rendition', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const asset = await importAsset(library, { buffer: await makePng(), filename: 'gone.png', title: 'Gone' });
  const hash = asset.versions[0].blobHash;
  fs.rmSync(path.join(root, 'assets', 'originals', hash.slice(0, 2), `${hash}.png`));
  await assert.rejects(() => generateRendition(library, asset.currentVersionId, 'square'), /original file .* missing|integrity/i);
});
