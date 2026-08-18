import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { makeTestLibrary } from './helpers.mjs';
import { archiveOverview, previewPurge, purgeArchive } from '../electron/services/archive-service.js';
import { installExampleContract } from '../electron/services/contract-service.js';
import {
  createProduction, setProductionValue, setSelection, setAssetSetItems, setProductionStatus,
} from '../electron/services/production-service.js';
import { createEntity, updateEntity } from '../electron/services/entity-service.js';
import { importAsset, setAssetLinks, setAssetArchived } from '../electron/services/asset-service.js';
import { createDocument, setDocumentStatus } from '../electron/services/document-service.js';
import { publishProduction } from '../electron/services/publication-service.js';

async function fixture(library) {
  const contract = installExampleContract(library);
  const world = createEntity(library, { type: 'world', name: 'Vel' });
  const nao = createEntity(library, { type: 'character', name: 'Nao', worldId: world.id });
  const png = await sharp({ create: { width: 60, height: 80, channels: 3, background: { r: 30, g: 60, b: 90 } } }).png().toBuffer();
  const portrait = await importAsset(library, { buffer: png, filename: 'nao.png', title: 'Nao portrait' });
  setAssetLinks(library, portrait.id, [{ entityId: nao.id, role: 'character.portrait' }]);
  const production = createProduction(library, { name: 'Gallery', contractId: contract.contractId, worldId: world.id });
  setProductionValue(library, production.id, { scope: 'production', field: 'gallery_title', value: 'Gallery' });
  setSelection(library, production.id, 'world', [world.id]);
  setSelection(library, production.id, 'cast', [nao.id]);
  setAssetSetItems(library, production.id, { slot: 'portrait', entityId: nao.id, items: [{ assetId: portrait.id }] });
  return { contract, world, nao, portrait, production };
}

test('clearing the archive removes archived productions and leaves living ones alone', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const { contract, production } = await fixture(library);

  const stale = createProduction(library, { name: 'Stale attempt', contractId: contract.contractId });
  setProductionStatus(library, stale.id, 'archived');

  const overview = archiveOverview(library);
  assert.equal(overview.counts.productions, 1);

  const preview = previewPurge(library, { scopes: ['productions'] });
  assert.equal(preview.total, 1);
  assert.deepEqual(preview.names.productions, ['Stale attempt']);

  const result = purgeArchive(library, { scopes: ['productions'] });
  assert.equal(result.removed.productions, 1);
  assert.equal(library.db.prepare('SELECT COUNT(*) n FROM productions').get().n, 1, 'the living production stays');
  assert.equal(library.db.prepare('SELECT id FROM productions').get().id, production.id);
  assert.equal(archiveOverview(library).counts.productions, 0);
});

test('material still in use is refused, and said so by name', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const { nao, portrait } = await fixture(library);

  // Archived, but the living production still points at both.
  setAssetArchived(library, portrait.id, true);
  updateEntity(library, nao.id, { status: 'archived' });

  const preview = previewPurge(library, { scopes: ['assets', 'entities'] });
  assert.equal(preview.total, 0, 'nothing can go while a production holds it');
  assert.ok(preview.blocked.some((line) => line.includes('Nao portrait') && line.includes('Gallery')));
  assert.ok(preview.blocked.some((line) => line.includes('Nao') && line.includes('Gallery')));

  const result = purgeArchive(library, { scopes: ['assets', 'entities'] });
  assert.equal(result.removed.assets, 0);
  assert.equal(result.removed.entities, 0);
  assert.ok(library.db.prepare('SELECT id FROM assets WHERE id = ?').get(portrait.id), 'the asset is still there');
});

test('clearing an archived production in the same pass frees the assets and records it was holding', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const { world, nao, portrait, production } = await fixture(library);

  const blobPath = library.db.prepare(`
    SELECT b.path FROM blobs b JOIN asset_versions v ON v.blob_hash = b.hash WHERE v.asset_id = ?
  `).get(portrait.id).path;
  assert.ok(fs.existsSync(path.join(root, ...blobPath.split('/'))), 'the original is on disk to begin with');

  setProductionStatus(library, production.id, 'archived');
  setAssetArchived(library, portrait.id, true);
  updateEntity(library, nao.id, { status: 'archived' });
  updateEntity(library, world.id, { status: 'archived' });

  const preview = previewPurge(library, { scopes: ['productions', 'assets', 'entities'] });
  assert.deepEqual(preview.blocked, [], preview.blocked.join(' | '));
  assert.equal(preview.counts.productions, 1);
  assert.equal(preview.counts.assets, 1);
  assert.equal(preview.counts.entities, 2);
  assert.ok(preview.bytes > 0, 'the original counts towards what returns to the disk');

  const result = purgeArchive(library, { scopes: ['productions', 'assets', 'entities'] });
  assert.equal(result.removed.entities, 2);
  assert.equal(result.removed.originals, 1);
  assert.equal(library.db.prepare('SELECT COUNT(*) n FROM entities').get().n, 0);
  assert.equal(library.db.prepare('SELECT COUNT(*) n FROM assets').get().n, 0);
  assert.equal(library.db.prepare('SELECT COUNT(*) n FROM blobs').get().n, 0);
  assert.equal(library.db.prepare('SELECT COUNT(*) n FROM asset_links').get().n, 0);
  assert.equal(fs.existsSync(path.join(root, ...blobPath.split('/'))), false, 'the original file is gone from disk');
  assert.equal(library.db.pragma('foreign_key_check').length, 0, 'no dangling references are left behind');
});

test('a world is refused while anything that stays still lives inside it', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const world = createEntity(library, { type: 'world', name: 'Vel' });
  const child = createEntity(library, { type: 'character', name: 'Nao', worldId: world.id });
  updateEntity(library, world.id, { status: 'archived' });

  let preview = previewPurge(library, { scopes: ['entities'] });
  assert.equal(preview.total, 0);
  assert.ok(preview.blocked.some((line) => line.includes('Vel') && line.includes('sit inside it')));

  updateEntity(library, child.id, { status: 'archived' });
  preview = previewPurge(library, { scopes: ['entities'] });
  assert.equal(preview.total, 2, 'once the record inside is archived too, both can go');
  const result = purgeArchive(library, { scopes: ['entities'] });
  assert.equal(result.removed.entities, 2);
  assert.equal(library.db.pragma('foreign_key_check').length, 0);
});

test('published snapshots are kept unless they are asked for by name', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const { production } = await fixture(library);
  setProductionStatus(library, production.id, 'ready');
  const publication = await publishProduction(library, production.id);
  const packageDir = path.join(root, ...publication.directory.split('/'));
  assert.ok(fs.existsSync(packageDir));
  setProductionStatus(library, production.id, 'archived');

  const guarded = previewPurge(library, { scopes: ['productions'] });
  assert.equal(guarded.total, 0);
  assert.ok(guarded.blocked.some((line) => line.includes('published snapshot')));

  const asked = previewPurge(library, { scopes: ['productions'], includePublications: true });
  assert.equal(asked.total, 1);
  assert.equal(asked.publications, 1);

  const result = purgeArchive(library, { scopes: ['productions'], includePublications: true });
  assert.equal(result.removed.publications, 1);
  assert.equal(library.db.prepare('SELECT COUNT(*) n FROM publications').get().n, 0);
  assert.equal(library.db.prepare('SELECT COUNT(*) n FROM publication_files').get().n, 0);
  assert.equal(fs.existsSync(packageDir), false, 'the package folder leaves the disk');
});

test('only the ticked scopes are touched', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const entity = createEntity(library, { type: 'character', name: 'Forgotten' });
  updateEntity(library, entity.id, { status: 'archived' });
  const doc = createDocument(library, { title: 'Old notes', content: '# Old' });
  setDocumentStatus(library, doc.id, 'archived');

  const result = purgeArchive(library, { scopes: ['documents'] });
  assert.equal(result.removed.documents, 1);
  assert.equal(result.removed.entities, 0);
  assert.equal(library.db.prepare('SELECT COUNT(*) n FROM documents').get().n, 0);
  assert.equal(library.db.prepare('SELECT COUNT(*) n FROM entities').get().n, 1, 'the archived record was not ticked');
  assert.equal(archiveOverview(library).counts.entities, 1);
});
