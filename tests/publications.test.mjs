import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import yauzl from 'yauzl';
import { makeTestLibrary, makeTempDir } from './helpers.mjs';
import { installExampleContract, updateContract } from '../electron/services/contract-service.js';
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
  assert.equal(manifest.protocolVersion, 2);
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
  const naoEntry = assetIndex.find((entry) => entry.assetId === portraitA.id && entry.recipeId === 'portrait_3x4');
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

test('art with transparent edges reaches the package with its transparency intact', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const { production, nao, portraitA } = await readyGallery(library);

  // Replace Nao's portrait with a silhouette: opaque core, clear edges.
  const width = 240;
  const height = 320;
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      raw[i] = 200; raw[i + 1] = 90; raw[i + 2] = 40;
      raw[i + 3] = Math.hypot(x - width / 2, y - height / 2) < 70 ? 255 : 0;
    }
  }
  const cutout = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const { addAssetVersion } = await import('../electron/services/asset-service.js');
  await addAssetVersion(library, portraitA.id, { buffer: cutout, filename: 'nao-cutout.png' });

  const publication = await publishProduction(library, production.id);
  const packageDir = path.join(root, ...publication.directory.split('/'));
  const index = JSON.parse(fs.readFileSync(path.join(packageDir, 'assets', 'index.json'), 'utf8'));

  const exported = index.filter((entry) => entry.assetId === portraitA.id && entry.recipeId !== 'original');
  assert.ok(exported.length > 0, 'the portrait ships in at least one recipe');
  for (const entry of exported) {
    const file = path.join(packageDir, ...entry.path.split('/'));
    assert.equal(entry.mime, 'image/webp');
    const meta = await sharp(file).metadata();
    assert.equal(meta.hasAlpha, true, `${entry.recipeId} keeps an alpha channel in the package`);
    const corner = await sharp(file).ensureAlpha().extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    assert.equal(corner[3], 0, `${entry.recipeId} is not matted onto a background in the package`);
  }
  assert.ok(nao, 'gallery cast intact');
});

test('packages are self-contained: actual roles, no dangling profile or document references, no archived connections', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const { production, world, nao, bram, portraitA, doc } = await readyGallery(library);
  const { updateEntity: update } = await import('../electron/services/entity-service.js');
  const { createConnection } = await import('../electron/services/connection-service.js');
  const { setDocumentLinks } = await import('../electron/services/document-service.js');

  /* the portrait also carries a second role; only real roles export */
  setAssetLinks(library, portraitA.id, [
    { entityId: nao.id, role: 'character.portrait' },
    { entityId: nao.id, role: 'reference.art' },
  ]);

  /* preferred art: nao's is packaged, bram's points at an unpackaged asset */
  const strayPng = await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 5, g: 5, b: 5 } } }).png().toBuffer();
  const stray = await importAsset(library, { buffer: strayPng, filename: 'stray.png', title: 'Stray art' });
  update(library, nao.id, { profile: { portraitAssetId: portraitA.id } });
  update(library, bram.id, { profile: { portraitAssetId: stray.id } });

  /* the biography also links an entity outside the snapshot */
  const outsider = createEntity(library, { type: 'character', name: 'Outsider' });
  setDocumentLinks(library, doc.id, [nao.id, outsider.id]);

  /* one live and one archived connection */
  createConnection(library, { kindId: 'rival_of', entityId: nao.id, counterpartId: bram.id });
  const archived = createConnection(library, { kindId: 'mentor_of', entityId: nao.id, counterpartId: bram.id });
  library.db.prepare(`UPDATE connections SET status = 'archived' WHERE id = ?`).run(archived.id);

  const publication = await publishProduction(library, production.id);
  const packageDir = path.join(root, ...publication.directory.split('/'));
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(packageDir, ...rel.split('/')), 'utf8'));

  const index = read('assets/index.json');
  const naoPortrait = index.find((entry) => entry.assetId === portraitA.id && entry.recipeId === 'portrait_3x4');
  assert.deepEqual(naoPortrait.roles, ['character.portrait'],
    'the exported roles are the actual allowed roles of the asset, not the whole contract list');

  const characters = read('catalog/characters.json');
  assert.equal(characters.find((c) => c.id === nao.id).portraitAssetId, portraitA.id, 'packaged preferred art is kept');
  assert.equal(characters.find((c) => c.id === bram.id).portraitAssetId, null, 'unpackaged preferred art is nulled, not dangling');

  const documents = read('catalog/documents.json');
  assert.deepEqual(documents.find((d) => d.id === doc.id).entityIds, [nao.id], 'document links outside the snapshot are filtered');

  const relationships = read('catalog/relationships.json');
  assert.ok(relationships.some((rel) => rel.type === 'rival_of'), 'live connection included');
  assert.ok(!relationships.some((rel) => rel.type === 'mentor_of'), 'archived connection excluded');
});

test('assets and entities referenced by contract-defined values ship in the package', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const { createContract } = await import('../electron/services/contract-service.js');

  const world = createEntity(library, { type: 'world', name: 'Vel' });
  const nao = createEntity(library, { type: 'character', name: 'Nao', worldId: world.id });
  const patron = createEntity(library, { type: 'character', name: 'Patron', worldId: world.id });
  const png = await sharp({ create: { width: 60, height: 40, channels: 3, background: { r: 20, g: 40, b: 60 } } }).png().toBuffer();
  const packArt = await importAsset(library, { buffer: png, filename: 'pack.png', title: 'Pack art' });
  const relicPng = await sharp({ create: { width: 30, height: 30, channels: 3, background: { r: 90, g: 10, b: 10 } } }).png().toBuffer();
  const relicArt = await importAsset(library, { buffer: relicPng, filename: 'relic.png', title: 'Relic art' });

  const contract = createContract(library, {
    format: 'world-hub-application-contract',
    contractVersion: 1,
    appType: 'test.value-refs',
    name: 'Value reference test',
    supportedProtocolVersions: [1, 2],
    productionFields: [
      { id: 'cover_art', label: 'Cover art', type: 'assetRef', assetKinds: ['image'], recipes: ['thumbnail_square'] },
      { id: 'sponsor', label: 'Sponsor', type: 'entityRef', entityTypes: ['character'] },
      {
        id: 'relics', label: 'Relics', type: 'list',
        fields: [
          { id: 'relic_name', label: 'Name', type: 'shortText', required: true },
          { id: 'relic_art', label: 'Art', type: 'assetRef', assetKinds: ['image'] },
        ],
      },
    ],
    entitySelections: [
      { id: 'cast', label: 'Cast', entityTypes: ['character'], min: 1, max: 5 },
    ],
    documents: { mode: 'none' },
  });

  const production = createProduction(library, { name: 'Refs', contractId: contract.contractId });
  setSelection(library, production.id, 'cast', [nao.id]);
  setProductionValue(library, production.id, { scope: 'production', field: 'cover_art', value: packArt.id });
  setProductionValue(library, production.id, { scope: 'production', field: 'sponsor', value: patron.id });
  setProductionValue(library, production.id, {
    scope: 'production', field: 'relics',
    value: [{ relic_name: 'Ember', relic_art: relicArt.id }],
  });

  const publication = await publishProduction(library, production.id);
  const packageDir = path.join(root, ...publication.directory.split('/'));
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(packageDir, ...rel.split('/')), 'utf8'));

  const index = read('assets/index.json');
  const cover = index.find((entry) => entry.assetId === packArt.id);
  assert.ok(cover, 'assetRef value is packaged');
  assert.equal(cover.recipeId, 'thumbnail_square', 'assetRef recipes hint is honored');
  assert.ok(fs.existsSync(path.join(packageDir, ...cover.path.split('/'))));
  const relic = index.find((entry) => entry.assetId === relicArt.id);
  assert.ok(relic, 'assetRef nested inside a list group is packaged');
  assert.equal(relic.recipeId, 'original', 'default recipe for assetRef is original');

  const entities = read('catalog/entities.json');
  assert.ok(entities.some((entity) => entity.id === patron.id), 'entityRef value ships in the catalog');
  assert.deepEqual(verifyPublication(library, publication.id), { ok: true, problems: [] });
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

test('publishing is refused when the contract cannot read the protocol this library writes', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const contract = installExampleContract(library);
  /* the application says it only understands the older package format */
  const stuck = { ...contract.contract, supportedProtocolVersions: [1] };
  const updated = updateContract(library, contract.contractId, stuck);

  const world = createEntity(library, { type: 'world', name: 'Vel' });
  const nao = createEntity(library, { type: 'character', name: 'Nao', worldId: world.id });
  const png = await sharp({ create: { width: 60, height: 80, channels: 3, background: { r: 20, g: 40, b: 60 } } }).png().toBuffer();
  const portrait = await importAsset(library, { buffer: png, filename: 'nao.png', title: 'Nao portrait' });
  setAssetLinks(library, portrait.id, [{ entityId: nao.id, role: 'character.portrait' }]);

  const production = createProduction(library, {
    name: 'Stuck', contractId: updated.contractId, contractVersion: updated.version, worldId: world.id });
  setProductionValue(library, production.id, { scope: 'production', field: 'gallery_title', value: 'Stuck' });
  setSelection(library, production.id, 'world', [world.id]);
  setSelection(library, production.id, 'cast', [nao.id]);
  setAssetSetItems(library, production.id, { slot: 'portrait', entityId: nao.id, items: [{ assetId: portrait.id }] });

  await assert.rejects(
    () => publishProduction(library, production.id),
    (error) => {
      assert.equal(error.code, 'publish.protocol_unsupported');
      assert.match(error.message, /protocol 1.*publishes protocol 2/s);
      return true;
    },
    'a package the application could not read is refused before it is written',
  );
});
