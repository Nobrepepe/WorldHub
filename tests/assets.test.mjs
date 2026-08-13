import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { makeTestLibrary, tinyWav } from './helpers.mjs';
import { createEntity } from '../electron/services/entity-service.js';
import {
  storeBlob, importAsset, addAssetVersion, getAsset, setAssetLinks, listAssets,
  setCrop, generateRendition, setAssetArchived, auditUnreferencedBlobs, trashUnreferencedBlobs,
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
  assert.equal(listAssets(library, { role: 'character.sprite' }).length, 0);
  assert.equal(listAssets(library, { worldId: world.id }).length, 1, 'world filter follows links');
});

test('renditions are deterministic, cached, and invalidated by crop changes', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const png = await makePng({ width: 640, height: 480 });
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

test('transparency is preserved by alpha-preserving recipes', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const png = await makePng({ width: 300, height: 200, alpha: true });
  const asset = await importAsset(library, { buffer: png, filename: 'sprite.png', title: 'Sprite' });

  const tile = await generateRendition(library, asset.currentVersionId, 'wide_tile_16x9');
  const meta = await sharp(path.join(root, ...tile.path.split('/'))).metadata();
  assert.equal(meta.hasAlpha, true, 'wide tile keeps alpha');

  const square = await generateRendition(library, asset.currentVersionId, 'square');
  const squareMeta = await sharp(path.join(root, ...square.path.split('/'))).metadata();
  assert.equal(squareMeta.hasAlpha, false, 'cover square flattens');
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

test('missing blob is reported when generating a rendition', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const asset = await importAsset(library, { buffer: await makePng(), filename: 'gone.png', title: 'Gone' });
  const hash = asset.versions[0].blobHash;
  fs.rmSync(path.join(root, 'assets', 'originals', hash.slice(0, 2), `${hash}.png`));
  await assert.rejects(() => generateRendition(library, asset.currentVersionId, 'square'), /original file .* missing|integrity/i);
});
