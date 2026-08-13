import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestLibrary } from './helpers.mjs';
import { createEntity } from '../electron/services/entity-service.js';
import {
  createDocument, getDocument, saveDocument, saveRecoveredCopy, renameDocument,
  duplicateDocument, setDocumentStatus, setDocumentLinks, listDocuments,
} from '../electron/services/document-service.js';
import { searchLibrary } from '../electron/services/search-service.js';

test('documents are real Markdown files at human-comprehensible paths', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const world = createEntity(library, { type: 'world', name: 'Vel' });
  const nao = createEntity(library, { type: 'character', name: 'Nao', worldId: world.id });

  const bio = createDocument(library, { title: 'Biography', entityIds: [nao.id], content: '# Nao\n\nBorn under a drowned moon.' });
  assert.equal(bio.path, `documents/character/${nao.id}/biography.md`);
  const abs = path.join(root, ...bio.path.split('/'));
  assert.ok(fs.existsSync(abs));
  assert.match(fs.readFileSync(abs, 'utf8'), /drowned moon/);
  assert.equal(bio.wordCount, 7);

  const guide = createDocument(library, { title: 'Setting Guide', entityIds: [world.id] });
  assert.equal(guide.path, `documents/world/${world.id}/setting-guide.md`);

  const loose = createDocument(library, { title: 'Loose Notes' });
  assert.match(loose.path, new RegExp(`^documents/entry/${loose.id}/loose-notes\\.md$`));
});

test('atomic save updates checksum, revision, and search index', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const doc = createDocument(library, { title: 'Notes', content: 'first version' });
  const result = saveDocument(library, { id: doc.id, content: 'second version with starlight', baseChecksum: doc.checksum });
  assert.notEqual(result.checksum, doc.checksum);

  const loaded = getDocument(library, doc.id);
  assert.equal(loaded.content, 'second version with starlight');
  assert.equal(loaded.revision, doc.revision + 1);
  assert.equal(loaded.externallyChanged, false);

  const found = searchLibrary(library, { query: 'starlight' });
  assert.equal(found.groups[0].group, 'document');
  assert.equal(found.groups[0].items[0].title, 'Notes');

  const leftovers = fs.readdirSync(path.dirname(path.join(root, ...doc.path.split('/'))))
    .filter((name) => name.startsWith('.worldhub-tmp-'));
  assert.deepEqual(leftovers, []);
});

test('external changes are detected and never silently overwritten', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const doc = createDocument(library, { title: 'Fragile', content: 'app version' });
  const abs = path.join(root, ...doc.path.split('/'));
  fs.writeFileSync(abs, 'edited outside the app');

  const loaded = getDocument(library, doc.id);
  assert.equal(loaded.externallyChanged, true);

  assert.throws(
    () => saveDocument(library, { id: doc.id, content: 'my unsaved editor text', baseChecksum: doc.checksum }),
    /changed outside World Hub/,
  );
  assert.equal(fs.readFileSync(abs, 'utf8'), 'edited outside the app', 'external change preserved');

  const recovered = saveRecoveredCopy(library, { id: doc.id, content: 'my unsaved editor text' });
  assert.match(recovered.title, /Fragile \(recovered/);
  assert.match(getDocument(library, recovered.id).content, /unsaved editor text/);
});

test('one document links to several entities without copying', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const a = createEntity(library, { type: 'character', name: 'Ari' });
  const b = createEntity(library, { type: 'character', name: 'Bram' });
  const doc = createDocument(library, { title: 'Shared history', entityIds: [a.id] });

  setDocumentLinks(library, doc.id, [a.id, b.id]);
  const loaded = getDocument(library, doc.id, { withContent: false });
  assert.deepEqual(loaded.links.map((l) => l.name).sort(), ['Ari', 'Bram']);

  assert.equal(listDocuments(library, { entityId: b.id }).length, 1);
  assert.equal(listDocuments(library, { entityId: a.id })[0].id, doc.id);
});

test('rename keeps identity, moves the file, duplicates and archival work', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const doc = createDocument(library, { title: 'Old Name', content: 'body text here' });
  const renamed = renameDocument(library, { id: doc.id, title: 'New Name' });
  assert.equal(renamed.id, doc.id);
  assert.match(renamed.path, /new-name\.md$/);
  assert.ok(fs.existsSync(path.join(root, ...renamed.path.split('/'))));
  assert.ok(!fs.existsSync(path.join(root, ...doc.path.split('/'))), 'old file is gone');

  const copy = duplicateDocument(library, doc.id);
  assert.notEqual(copy.id, doc.id);
  assert.match(getDocument(library, copy.id).content, /body text/);

  setDocumentStatus(library, doc.id, 'archived');
  assert.equal(listDocuments(library, {}).some((d) => d.id === doc.id), false);
  assert.equal(searchLibrary(library, { query: 'body' }).groups[0]?.items.some((i) => i.subjectId === doc.id) ?? false, false);
  setDocumentStatus(library, doc.id, 'draft');
  assert.equal(listDocuments(library, {}).some((d) => d.id === doc.id), true);
});
