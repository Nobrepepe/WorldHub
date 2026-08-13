#!/usr/bin/env node
/**
 * End-to-end smoke: creates a temporary library, imports fixture
 * Markdown and images, creates a world and character, files the
 * imports, creates a Production with the example contract, publishes
 * it, verifies it, closes the database, and reopens the library.
 * Exits non-zero on any failure. Never touches real user data.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { createLibrary, openLibrary, closeLibrary } from '../electron/services/library-service.js';
import { createEntity, setSubjectTags } from '../electron/services/entity-service.js';
import { importIntoInbox, listInbox, fileItemAsAsset, fileItemAsDocument } from '../electron/services/inbox-service.js';
import { setAssetLinks } from '../electron/services/asset-service.js';
import { installExampleContract } from '../electron/services/contract-service.js';
import {
  createProduction, setProductionValue, setSelection, setAssetSetItems, setProductionStatus,
} from '../electron/services/production-service.js';
import { publishProduction, verifyPublication, readCurrentPointer } from '../electron/services/publication-service.js';
import { runIntegrityChecks } from '../electron/services/integrity-service.js';
import { searchLibrary } from '../electron/services/search-service.js';

const step = (label) => process.stdout.write(`  • ${label}\n`);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'worldhub-smoke-'));
const ctx = { library: null, userDataDir: path.join(scratch, 'userdata'), sendEvent() {} };

try {
  step('create a temporary library');
  await createLibrary(ctx, scratch, 'Smoke Library');
  const library = ctx.library;
  const root = library.root;

  step('write fixture files');
  const fixtures = path.join(scratch, 'fixtures', 'Nao');
  fs.mkdirSync(fixtures, { recursive: true });
  const raw = Buffer.alloc(300 * 400 * 3);
  for (let i = 0; i < raw.length; i += 3) { raw[i] = (i / 3) % 251; raw[i + 1] = 90; raw[i + 2] = 170; }
  const png = await sharp(raw, { raw: { width: 300, height: 400, channels: 3 } }).png().toBuffer();
  fs.writeFileSync(path.join(fixtures, 'nao-portrait.png'), png);
  fs.writeFileSync(path.join(fixtures, 'biography.md'), '# Nao\n\nA smoke-test biography under a drowned moon.');

  step('create a world and a character');
  const world = createEntity(library, { type: 'world', name: 'Smoke Reach' });
  const nao = createEntity(library, { type: 'character', name: 'Nao', worldId: world.id });
  setSubjectTags(library, 'entity', nao.id, ['smoke', 'protagonist']);

  step('bulk import into the Inbox without touching the source');
  const before = fs.readdirSync(fixtures).sort();
  const imported = importIntoInbox(library, [path.join(scratch, 'fixtures')]);
  assert.equal(imported.imported, 2, 'two fixture files imported');
  assert.deepEqual(fs.readdirSync(fixtures).sort(), before, 'source untouched');

  step('file the imports as an asset and a document');
  const items = listInbox(library, {});
  const portraitItem = items.find((item) => item.filename === 'nao-portrait.png');
  const bioItem = items.find((item) => item.filename === 'biography.md');
  const filedAsset = await fileItemAsAsset(library, portraitItem.id, { entityId: nao.id, role: 'character.portrait' });
  fileItemAsDocument(library, bioItem.id, { entityIds: [nao.id] });
  setAssetLinks(library, filedAsset.asset.id, [{ entityId: nao.id, role: 'character.portrait' }]);

  step('search finds the filed material');
  assert.ok(searchLibrary(library, { query: 'drowned' }).groups.length > 0, 'document text searchable');

  step('create and complete a production from the example contract');
  const contract = installExampleContract(library);
  const production = createProduction(library, { name: 'Smoke Gallery', contractId: contract.contractId, worldId: world.id });
  setProductionValue(library, production.id, { scope: 'production', field: 'gallery_title', value: 'Smoke Cast' });
  setSelection(library, production.id, 'world', [world.id]);
  setSelection(library, production.id, 'cast', [nao.id]);
  setAssetSetItems(library, production.id, { slot: 'portrait', entityId: nao.id, items: [{ assetId: filedAsset.asset.id }] });
  setProductionStatus(library, production.id, 'ready');

  step('publish and verify the snapshot');
  const publication = await publishProduction(library, production.id);
  const verification = verifyPublication(library, publication.id);
  assert.deepEqual(verification, { ok: true, problems: [] }, 'every packaged file matches its checksum');
  const pointer = readCurrentPointer(library, publication.productionSlug);
  assert.equal(pointer.publicationId, publication.id, 'current.json points at the new snapshot');

  step('integrity checks pass');
  const summary = await runIntegrityChecks(library);
  assert.equal(summary.problems, 0, JSON.stringify(summary.findings, null, 2));

  step('close and reopen the library with data intact');
  await closeLibrary(ctx);
  await openLibrary(ctx, root, {});
  assert.equal(ctx.library.db.prepare(`SELECT COUNT(*) n FROM entities WHERE name = 'Nao'`).get().n, 1);
  assert.equal(ctx.library.db.prepare('SELECT COUNT(*) n FROM publications').get().n, 1);
  const reverify = verifyPublication(ctx.library, publication.id);
  assert.deepEqual(reverify, { ok: true, problems: [] }, 'publication still valid after reopen');
  await closeLibrary(ctx);

  process.stdout.write('Smoke test passed: import → canon → filing → production → publication → verification → reopen.\n');
} catch (err) {
  process.stderr.write(`\nSmoke test FAILED: ${err.stack ?? err}\n`);
  process.exitCode = 1;
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
