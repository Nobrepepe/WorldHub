import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { makeTempDir, makeTestLibrary } from './helpers.mjs';
import {
  importIntoInbox, listInbox, listBatches, fileItemAsAsset, fileItemAsDocument,
  setItemStatus, undoLastFiling, clearFiledStaging, suggestMatches,
} from '../electron/services/inbox-service.js';
import { createEntity } from '../electron/services/entity-service.js';
import { getAsset, addAssetVersion } from '../electron/services/asset-service.js';
import { getDocument } from '../electron/services/document-service.js';

async function fixtureTree() {
  const dir = makeTempDir('worldhub-fixture-');
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 9, g: 120, b: 30 } } }).png().toBuffer();
  fs.mkdirSync(path.join(dir, 'Nao', 'art'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Nao', 'art', 'nao-portrait.png'), png);
  fs.writeFileSync(path.join(dir, 'Nao', 'art', 'duplicate.png'), png);
  fs.writeFileSync(path.join(dir, 'notes', 'lore.md'), '# Old lore\n\nSalvaged notes.');
  fs.writeFileSync(path.join(dir, 'notes', '.DS_Store'), 'junk');
  fs.writeFileSync(path.join(dir, 'broken.png'), 'not a real image');
  return { dir, png };
}

test('recursive import stages copies, keeps provenance, and never touches the source', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const { dir } = await fixtureTree();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const before = snapshotTree(dir);
  const result = importIntoInbox(library, [dir]);
  assert.equal(result.imported, 2, 'portrait + markdown');
  assert.equal(result.duplicates, 1, 'identical bytes recognized');
  assert.equal(result.errors, 1, 'lying png recorded as error');
  assert.deepEqual(snapshotTree(dir), before, 'source is unchanged');

  const items = listInbox(library, {});
  const portrait = items.find((i) => i.filename === 'nao-portrait.png');
  assert.equal(portrait.sourceRelPath, 'Nao/art/nao-portrait.png', 'relative provenance preserved');
  assert.ok(!items.some((i) => i.filename === '.DS_Store'), 'system files skipped');

  const failed = items.find((i) => i.filename === 'broken.png');
  assert.equal(failed.status, 'error');
  assert.match(failed.errorMessage, /do not match a supported format/);

  assert.equal(listBatches(library).length, 1);
});

test('symlinked directories and files are refused', async (t) => {
  if (process.platform === 'win32') return t.skip('symlinks need privileges on Windows');
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const { dir } = await fixtureTree();
  const outside = makeTempDir('worldhub-outside-');
  fs.writeFileSync(path.join(outside, 'secret.md'), '# secret');
  fs.symlinkSync(outside, path.join(dir, 'sneaky-dir'));
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(dir, 'sneaky.md'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });

  importIntoInbox(library, [dir]);
  const items = listInbox(library, {});
  assert.ok(!items.some((i) => i.filename.includes('secret') || i.filename.includes('sneaky')), 'symlinks not followed');
});

test('filing media and Markdown creates canonical records; undo reverses the last filing', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const { dir } = await fixtureTree();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const nao = createEntity(library, { type: 'character', name: 'Nao' });
  importIntoInbox(library, [dir]);
  const items = listInbox(library, {});
  const portraitItem = items.find((i) => i.filename === 'nao-portrait.png');
  const loreItem = items.find((i) => i.filename === 'lore.md');

  const suggestions = suggestMatches(library, portraitItem.id);
  assert.ok(suggestions.some((s) => s.entityId === nao.id), 'filename token suggests Nao');

  const filedAsset = await fileItemAsAsset(library, portraitItem.id, { entityId: nao.id, role: 'character.portrait' });
  const asset = getAsset(library, filedAsset.asset.id);
  assert.equal(asset.links[0].role, 'character.portrait');
  assert.equal(asset.versions[0].importedFrom, 'Nao/art/nao-portrait.png');

  const filedDoc = fileItemAsDocument(library, loreItem.id, { entityIds: [nao.id] });
  assert.match(getDocument(library, filedDoc.document.id).content, /Salvaged notes/);

  // Undo removes the document (the most recent filing).
  undoLastFiling(library);
  assert.throws(() => getDocument(library, filedDoc.document.id), /no longer exists/);
  assert.equal(listInbox(library, {}).find((i) => i.id === loreItem.id).status, 'unreviewed');

  // Undo again removes the asset.
  undoLastFiling(library);
  assert.throws(() => getAsset(library, filedAsset.asset.id), /no longer exists/);

  // Nothing filed remains.
  assert.throws(() => undoLastFiling(library), /No filing to undo/);
});

test('undo is blocked when the filed asset gained a later dependency', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const { dir } = await fixtureTree();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  importIntoInbox(library, [dir]);
  const portraitItem = listInbox(library, {}).find((i) => i.filename === 'nao-portrait.png');
  const filed = await fileItemAsAsset(library, portraitItem.id, {});
  const newer = await sharp({ create: { width: 30, height: 30, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
  await addAssetVersion(library, filed.asset.id, { buffer: newer, filename: 'v2.png' });

  assert.throws(() => undoLastFiling(library), /cannot be undone/);
  assert.ok(getAsset(library, filed.asset.id), 'asset survives the refused undo');
});

test('duplicate and ignore statuses; clearing staged copies verifies resolution first', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const { dir } = await fixtureTree();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  importIntoInbox(library, [dir]);
  const items = listInbox(library, {});
  const identical = items.filter((i) => ['duplicate.png', 'nao-portrait.png'].includes(i.filename));
  assert.deepEqual(identical.map((i) => i.status).sort(), ['duplicate', 'unreviewed'],
    'exactly one of two identical files is auto-marked duplicate');

  const lore = items.find((i) => i.filename === 'lore.md');
  setItemStatus(library, lore.id, 'ignored');
  assert.equal(listInbox(library, { status: 'ignored' }).length, 1);
  setItemStatus(library, lore.id, 'unreviewed');

  const portrait = items.find((i) => i.filename === 'nao-portrait.png');
  await fileItemAsAsset(library, portrait.id, {});
  const stagingRel = library.db.prepare('SELECT staging_path FROM inbox_items WHERE id = ?').get(portrait.id).staging_path;
  assert.ok(fs.existsSync(path.join(root, ...stagingRel.split('/'))));

  const cleared = clearFiledStaging(library);
  assert.equal(cleared.cleared, 1);
  assert.ok(!fs.existsSync(path.join(root, ...stagingRel.split('/'))), 'staging copy removed after verification');
});

function snapshotTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(`${path.relative(dir, abs)}:${fs.statSync(abs).size}`);
    }
  };
  walk(dir);
  return out;
}
