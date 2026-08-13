import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import yauzl from 'yauzl';
import { makeTestLibrary, makeTempDir } from './helpers.mjs';
import { installExampleContract } from '../electron/services/contract-service.js';
import {
  createProduction, setProductionValue, setSelection, setAssetSetItems,
} from '../electron/services/production-service.js';
import {
  publishProduction, previewPublication, getPublication, verifyPublication,
  exportPublicationZip, readCurrentPointer,
} from '../electron/services/publication-service.js';
import { createEntity, updateEntity } from '../electron/services/entity-service.js';
import { importAsset, setAssetLinks } from '../electron/services/asset-service.js';
import { createDocument } from '../electron/services/document-service.js';

async function readyGallery(library) {
  const contract = installExampleContract(library);
  const world = createEntity(library, { type: 'world', name: 'Vel' });
  const nao = createEntity(library, { type: 'character', name: 'Nao', worldId: world.id });
  const bram = createEntity(library, { type: 'character', name: 'Bram', worldId: world.id });

  const raw = Buffer.alloc(120 * 160 * 3);
  for (let i = 0; i < raw.length; i += 3) { raw[i] = (i / 3) % 256; raw[i + 1] = 80; raw[i + 2] = 160; }
  const pngA = await sharp(raw, { raw: { width: 120, height: 160, channels: 3 } }).png().toBuffer();
  const pngB = await sharp(raw.map((b, i) => (i % 3 === 2 ? 30 : b)), { raw: { width: 120, height: 160, channels: 3 } }).png().toBuffer();

  const portraitA = await importAsset(library, { buffer: pngA, filename: 'nao.png', title: 'Nao portrait' });
  setAssetLinks(library, portraitA.id, [{ entityId: nao.id, role: 'character.portrait' }]);
  const portraitB = await importAsset(library, { buffer: pngB, filename: 'bram.png', title: 'Bram portrait' });
  setAssetLinks(library, portraitB.id, [{ entityId: bram.id, role: 'character.portrait' }]);

  const doc = createDocument(library, { title: 'Nao biography', entityIds: [nao.id], content: '# Nao\n\nBorn in Vel.' });

  const production = createProduction(library, { name: 'Vel Gallery', contractId: contract.contractId, worldId: world.id });
  setProductionValue(library, production.id, { scope: 'production', field: 'gallery_title', value: 'The Vel Cast' });
  setSelection(library, production.id, 'world', [world.id]);
  setSelection(library, production.id, 'cast', [nao.id, bram.id]);
  setProductionValue(library, production.id, { scope: 'entity', entityId: nao.id, field: 'caption', value: 'The listener.' });
  setAssetSetItems(library, production.id, { slot: 'portrait', entityId: nao.id, items: [{ assetId: portraitA.id }] });
  setAssetSetItems(library, production.id, { slot: 'portrait', entityId: bram.id, items: [{ assetId: portraitB.id }] });
  return { contract, world, nao, bram, portraitA, portraitB, doc, production };
}

test('publishing creates a complete verified package with checksums over every file', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const { production, nao, portraitA, doc } = await readyGallery(library);

  const publication = await publishProduction(library, production.id);
  assert.ok(publication.isCurrent);
  const packageDir = path.join(root, ...publication.directory.split('/'));

  /* structure */
  for (const expected of ['manifest.json', 'checksums.json', 'catalog/entities.json', 'catalog/worlds.json',
    'catalog/characters.json', 'catalog/relationships.json', 'catalog/tags.json', 'catalog/documents.json',
    'production/contract.json', 'production/content.json', 'assets/index.json']) {
    assert.ok(fs.existsSync(path.join(packageDir, ...expected.split('/'))), `missing ${expected}`);
  }

  /* manifest content */
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'world-hub-package');
  assert.equal(manifest.protocolVersion, 1);
  assert.equal(manifest.complete, true);
  assert.ok(manifest.entities.some((entry) => entry.id === nao.id));

  /* checksums cover every file except themselves */
  const checksums = JSON.parse(fs.readFileSync(path.join(packageDir, 'checksums.json'), 'utf8'));
  const walk = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walk(path.join(dir, entry.name), rel) : [rel];
  });
  const allFiles = walk(packageDir).filter((rel) => rel !== 'checksums.json');
  assert.deepEqual(Object.keys(checksums).sort(), allFiles.sort());
  for (const [rel, expected] of Object.entries(checksums)) {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(packageDir, ...rel.split('/')))).digest('hex');
    assert.equal(digest, expected, `checksum of ${rel}`);
  }

  /* asset index maps exact versions; consumers never derive filenames */
  const assetIndex = JSON.parse(fs.readFileSync(path.join(packageDir, 'assets', 'index.json'), 'utf8'));
  const naoEntry = assetIndex.find((entry) => entry.assetId === portraitA.id && entry.recipeId === 'card_3x4');
  assert.ok(naoEntry);
  assert.equal(naoEntry.versionId, portraitA.currentVersionId, 'exact asset version recorded');
  assert.ok(fs.existsSync(path.join(packageDir, ...naoEntry.path.split('/'))));

  /* documents included via linked mode */
  const documents = JSON.parse(fs.readFileSync(path.join(packageDir, 'catalog', 'documents.json'), 'utf8'));
  assert.ok(documents.some((entry) => entry.id === doc.id));
  assert.match(fs.readFileSync(path.join(packageDir, 'documents', `${doc.id}.md`), 'utf8'), /Born in Vel/);

  /* verification passes */
  assert.deepEqual(verifyPublication(library, publication.id), { ok: true, problems: [] });

  /* pointer */
  const pointer = readCurrentPointer(library, publication.productionSlug);
  assert.equal(pointer.publicationId, publication.id);
});

test('package JSON generation is deterministic', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const { production } = await readyGallery(library);

  const first = await publishProduction(library, production.id);
  const second = await publishProduction(library, production.id);
  const read = (publication, rel) => fs.readFileSync(
    path.join(library.root, ...publication.directory.split('/'), ...rel.split('/')));

  for (const rel of ['catalog/entities.json', 'catalog/worlds.json', 'catalog/characters.json',
    'production/content.json', 'assets/index.json']) {
    assert.deepEqual(read(first, rel), read(second, rel), `${rel} identical across publishes`);
  }
});

test('failed publication leaves the current pointer and package untouched', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const { production, portraitA, nao } = await readyGallery(library);

  const good = await publishProduction(library, production.id);

  /* inject failure: delete the portrait blob so rendition generation dies */
  const version = library.db.prepare('SELECT v.*, b.path AS blob_path FROM asset_versions v JOIN blobs b ON b.hash = v.blob_hash WHERE v.id = ?')
    .get(portraitA.currentVersionId);
  const blobAbs = path.join(root, ...version.blob_path.split('/'));
  fs.rmSync(blobAbs);
  library.db.prepare('DELETE FROM generated_renditions WHERE version_id = ?').run(version.id);
  // touch the production so it is a new revision
  setProductionValue(library, production.id, { scope: 'entity', entityId: nao.id, field: 'caption', value: 'Changed caption.' });

  await assert.rejects(() => publishProduction(library, production.id), /missing|integrity/i);

  const pointer = readCurrentPointer(library, good.productionSlug);
  assert.equal(pointer.publicationId, good.id, 'pointer still names the good publication');
  assert.deepEqual(verifyPublication(library, good.id), { ok: true, problems: [] }, 'good package intact');
  const tmpEntries = fs.readdirSync(path.join(root, 'tmp')).filter((name) => name.startsWith('publish-'));
  assert.deepEqual(tmpEntries, [], 'incomplete work area removed');
});

test('historical snapshots stay valid after canon changes; diffs are reported', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const { production, nao, world } = await readyGallery(library);

  const first = await publishProduction(library, production.id);

  /* canon changes after publication */
  updateEntity(library, nao.id, { name: 'Naoline' });
  const newcomer = createEntity(library, { type: 'character', name: 'Cass', worldId: world.id });
  void newcomer;

  const oldPublication = getPublication(library, first.id);
  const entities = JSON.parse(fs.readFileSync(
    path.join(library.root, ...oldPublication.directory.split('/'), 'catalog', 'entities.json'), 'utf8'));
  const packagedNao = entities.find((entry) => entry.id === nao.id);
  assert.equal(packagedNao.name, 'Nao', 'the historical snapshot resolves its recorded name');
  assert.deepEqual(verifyPublication(library, first.id), { ok: true, problems: [] });

  /* the preview diff shows the rename */
  const preview = await previewPublication(library, production.id);
  assert.ok(preview.diff.changed.includes('Naoline'), `diff lists the renamed record: ${JSON.stringify(preview.diff)}`);
  assert.equal(preview.records.entities.find((entry) => entry.id === nao.id).name, 'Naoline');
});

test('ZIP export contains the exact same internal bytes as the folder snapshot', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const { production } = await readyGallery(library);
  const publication = await publishProduction(library, production.id);
  const packageDir = path.join(root, ...publication.directory.split('/'));

  const zipDir = makeTempDir('worldhub-zip-');
  t.after(() => fs.rmSync(zipDir, { recursive: true, force: true }));
  const zipPath = path.join(zipDir, 'export.zip');
  const result = await exportPublicationZip(library, publication.id, zipPath);
  assert.ok(result.entries > 0);

  const zipEntries = await readZip(zipPath);
  const walk = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walk(path.join(dir, entry.name), rel) : [rel];
  });
  const folderFiles = walk(packageDir).sort();
  assert.deepEqual([...zipEntries.keys()].sort(), folderFiles, 'same file list');
  for (const rel of folderFiles) {
    assert.deepEqual(zipEntries.get(rel), fs.readFileSync(path.join(packageDir, ...rel.split('/'))), `bytes of ${rel}`);
  }
});

function readZip(zipPath) {
  return new Promise((resolve, reject) => {
    const entries = new Map();
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (entry.fileName.endsWith('/')) return zipfile.readEntry();
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr);
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zipfile.readEntry();
          });
          stream.on('error', reject);
        });
      });
      zipfile.on('end', () => resolve(entries));
      zipfile.on('error', reject);
    });
  });
}
