import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { makeTestLibrary, makeTempDir } from './helpers.mjs';
import {
  createSafetyBackup, listSafetyBackups, createFullArchive, validateArchive,
  restoreArchiveToNewFolder, replaceCurrentFromArchive, recoverDatabaseFromBackup,
} from '../electron/services/backup-service.js';
import { runIntegrityChecks, runRepair } from '../electron/services/integrity-service.js';
import { createEntity } from '../electron/services/entity-service.js';
import { createDocument } from '../electron/services/document-service.js';
import { importAsset, generateRendition } from '../electron/services/asset-service.js';
import { openLibrary, closeLibrary } from '../electron/services/library-service.js';
import { searchLibrary } from '../electron/services/search-service.js';

async function seeded(library) {
  const world = createEntity(library, { type: 'world', name: 'Vel' });
  const nao = createEntity(library, { type: 'character', name: 'Nao', worldId: world.id });
  const doc = createDocument(library, { title: 'Notes', entityIds: [nao.id], content: '# Notes\n\nStarlight archive.' });
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 200, b: 100 } } }).png().toBuffer();
  const asset = await importAsset(library, { buffer: png, filename: 'art.png', title: 'Art' });
  return { world, nao, doc, asset };
}

test('lightweight safety backups rotate and list', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  await seeded(library);

  const backup = await createSafetyBackup(library, 'test');
  assert.ok(fs.existsSync(path.join(backup.path, 'world-hub.sqlite3')));
  assert.ok(fs.existsSync(path.join(backup.path, 'world-hub-library.json')));
  assert.ok(fs.existsSync(path.join(backup.path, 'documents')));
  const manifest = JSON.parse(fs.readFileSync(path.join(backup.path, 'backup-manifest.json'), 'utf8'));
  assert.equal(manifest.originalBlobs.length, 1, 'original checksums recorded, bytes not duplicated');
  assert.ok(!fs.existsSync(path.join(backup.path, 'assets')), 'blobs are not copied');

  const listed = listSafetyBackups(root);
  assert.ok(listed.some((entry) => entry.name === backup.name));
});

test('full archive round trip recreates the library elsewhere', async (t) => {
  const { library, cleanup } = await makeTestLibrary('Origin Library');
  t.after(cleanup);
  const { doc, asset } = await seeded(library);

  const zipDir = makeTempDir('worldhub-archive-');
  t.after(() => fs.rmSync(zipDir, { recursive: true, force: true }));
  const zipPath = path.join(zipDir, 'full.zip');
  const created = await createFullArchive(library, zipPath);
  assert.ok(created.entries > 4);

  const { manifest } = await validateArchive(zipPath, path.join(zipDir, 'scratch'));
  assert.equal(manifest.format, 'world-hub-archive');

  const restoredParent = makeTempDir('worldhub-restored-');
  t.after(() => fs.rmSync(restoredParent, { recursive: true, force: true }));
  const restored = await restoreArchiveToNewFolder(zipPath, restoredParent, path.join(zipDir, 'scratch'));
  assert.equal(restored.name, 'Origin Library');

  /* open the restored library and confirm everything is there */
  const ctx = { library: null, userDataDir: makeTempDir('worldhub-ud-'), sendEvent() {} };
  const opened = await openLibrary(ctx, restored.path, {});
  assert.equal(opened.library.name, 'Origin Library');
  const documents = ctx.library.db.prepare('SELECT * FROM documents').all();
  assert.equal(documents.length, 1);
  assert.match(fs.readFileSync(path.join(restored.path, ...documents[0].path.split('/')), 'utf8'), /Starlight archive/);
  const blob = ctx.library.db.prepare('SELECT * FROM blobs').get();
  assert.ok(fs.existsSync(path.join(restored.path, ...blob.path.split('/'))), 'original asset bytes travelled');
  assert.equal(searchLibrary(ctx.library, { query: 'nao' }).groups.length > 0, true, 'search works after restore');
  void doc; void asset;
  await closeLibrary(ctx);
});

test('invalid or tampered archives are rejected before any mutation', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  await seeded(library);
  const zipDir = makeTempDir('worldhub-archive-');
  t.after(() => fs.rmSync(zipDir, { recursive: true, force: true }));

  /* not an archive */
  const junk = path.join(zipDir, 'junk.zip');
  fs.writeFileSync(junk, 'this is not a zip');
  await assert.rejects(() => validateArchive(junk, path.join(zipDir, 's1')), /.*/);

  /* tampered archive: flip one byte inside */
  const zipPath = path.join(zipDir, 'full.zip');
  await createFullArchive(library, zipPath);
  const bytes = fs.readFileSync(zipPath);
  // Find the sqlite header inside the zip (stored data) and corrupt one byte after it.
  const marker = bytes.indexOf(Buffer.from('SQLite format 3'));
  if (marker > 0) {
    bytes[marker + 40] ^= 0xff;
    const tampered = path.join(zipDir, 'tampered.zip');
    fs.writeFileSync(tampered, bytes);
    await assert.rejects(
      () => validateArchive(tampered, path.join(zipDir, 's2')),
      /Checksum mismatch|corrupt|health check|invalid/i,
    );
  }

  /* restore of a bad archive never touches the current library */
  const before = library.db.prepare('SELECT COUNT(*) n FROM entities').get().n;
  await assert.rejects(async () => {
    const fakeCtx = { library, userDataDir: makeTempDir('worldhub-ud-'), sendEvent() {} };
    await replaceCurrentFromArchive(fakeCtx, junk);
  });
  assert.equal(library.db.prepare('SELECT COUNT(*) n FROM entities').get().n, before);
});

test('replace-current restore makes a pre-restore backup and swaps atomically', async (t) => {
  const { ctx, library, root, cleanup } = await makeTestLibrary('Replace Me');
  const { nao } = await seeded(library);

  const zipDir = makeTempDir('worldhub-archive-');
  const zipPath = path.join(zipDir, 'state-a.zip');
  await createFullArchive(library, zipPath);

  /* change canon after the archive */
  createEntity(library, { type: 'character', name: 'Later Addition' });

  const result = await replaceCurrentFromArchive(ctx, zipPath);
  t.after(async () => {
    await closeLibrary(ctx);
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
    fs.rmSync(zipDir, { recursive: true, force: true });
    if (result.retiredPath) fs.rmSync(result.retiredPath, { recursive: true, force: true });
  });
  void cleanup;

  assert.equal(result.library.name, 'Replace Me');
  const names = ctx.library.db.prepare('SELECT name FROM entities ORDER BY name').all().map((row) => row.name);
  assert.ok(!names.includes('Later Addition'), 'restored state predates the change');
  assert.ok(names.includes('Nao'));
  assert.ok(fs.existsSync(result.retiredPath), 'the previous library is kept aside');
  const preRestore = listSafetyBackups(result.retiredPath).find((entry) => entry.reason === 'pre-restore');
  assert.ok(preRestore, 'a pre-restore safety backup exists in the retired copy');
  void nao;
});

test('corrupt database recovery from a verified safety backup', async (t) => {
  const { ctx, library, root, cleanup } = await makeTestLibrary();
  await seeded(library);
  const backup = await createSafetyBackup(library, 'before-corruption');
  await closeLibrary(ctx);

  /* corrupt the main database */
  fs.writeFileSync(path.join(root, 'world-hub.sqlite3'), 'garbage bytes, not a database');
  await assert.rejects(() => openLibrary(ctx, root, {}), /health check|could not be opened/i);

  recoverDatabaseFromBackup(root, backup.name);
  const reopened = await openLibrary(ctx, root, { takeOverLock: true });
  assert.ok(reopened.library, 'library opens after recovery');
  assert.equal(ctx.library.db.prepare(`SELECT COUNT(*) n FROM entities WHERE name = 'Nao'`).get().n, 1);
  await cleanup();
});

test('integrity checks find drift and safe repairs fix it', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const { asset } = await seeded(library);

  /* healthy baseline */
  let summary = await runIntegrityChecks(library);
  assert.equal(summary.problems, 0, JSON.stringify(summary.findings));

  /* break things: search drift + missing rendition */
  const rendition = await generateRendition(library, asset.currentVersionId, 'thumbnail_square');
  fs.rmSync(path.join(root, ...rendition.path.split('/')));
  library.db.prepare('DELETE FROM search_index').run();

  summary = await runIntegrityChecks(library);
  const codes = summary.findings.map((finding) => finding.code);
  assert.ok(codes.includes('search.drift'));
  assert.ok(codes.includes('rendition.missing'));

  /* repairs */
  const searchRepair = await runRepair(library, 'rebuild-search');
  assert.ok(searchRepair.repaired);
  const renditionRepair = await runRepair(library, 'regenerate-renditions');
  assert.ok(renditionRepair.repaired);

  summary = await runIntegrityChecks(library);
  assert.equal(summary.problems, 0, JSON.stringify(summary.findings));

  /* a missing original is reported and never invented */
  const blob = library.db.prepare('SELECT * FROM blobs').get();
  fs.rmSync(path.join(root, ...blob.path.split('/')));
  summary = await runIntegrityChecks(library);
  assert.ok(summary.findings.some((finding) => finding.code === 'blob.missing'));
});
