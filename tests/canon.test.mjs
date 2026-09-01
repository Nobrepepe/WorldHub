import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestLibrary } from './helpers.mjs';
import {
  createEntity, getEntity, updateEntity, listEntities, entityUsage, archiveEntity, restoreEntity,
  ensureTag, setSubjectTags, tagsFor, listTags,
} from '../electron/services/entity-service.js';
import {
  createConnection, updateConnection, listConnections, connectionsForEntity,
} from '../electron/services/connection-service.js';
import { searchLibrary, rebuildSearchIndex } from '../electron/services/search-service.js';

test('entity UUID stays stable through rename and slug stays editable', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const world = createEntity(library, { type: 'world', name: 'Aster Reach' });
  assert.equal(world.slug, 'aster-reach');
  assert.equal(world.revision, 1);

  const renamed = updateEntity(library, world.id, { name: 'Aster Expanse' });
  assert.equal(renamed.id, world.id);
  assert.equal(renamed.name, 'Aster Expanse');
  assert.equal(renamed.slug, 'aster-reach', 'slug does not change on rename');
  assert.ok(renamed.revision > world.revision);

  const reslugged = updateEntity(library, world.id, { slug: 'aster' });
  assert.equal(reslugged.slug, 'aster');

  const other = createEntity(library, { type: 'world', name: 'Aster' });
  assert.equal(other.slug, 'aster-2', 'slug collision resolved within namespace');
  assert.throws(() => updateEntity(library, other.id, { slug: 'aster' }), /already uses the slug/);
});

test('worlds and characters associate; profiles persist', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const world = createEntity(library, { type: 'world', name: 'Vel' });
  const nao = createEntity(library, { type: 'character', name: 'Nao', worldId: world.id });
  assert.equal(nao.world.id, world.id);

  updateEntity(library, nao.id, {
    aliases: ['The Listener', 'Nao of the Vale'],
    profile: { role: 'Wandering archivist', ageText: 'Appears twenty-six', appearance: 'Slight, silver-eyed.' },
  });
  const loaded = getEntity(library, nao.id);
  assert.deepEqual(loaded.aliases, ['The Listener', 'Nao of the Vale']);
  assert.equal(loaded.profile.role, 'Wandering archivist');
  assert.equal(loaded.profile.age_text, 'Appears twenty-six');

  updateEntity(library, world.id, { profile: { tagline: 'A drowned frontier', genre: 'Mythic fantasy' } });
  assert.equal(getEntity(library, world.id).profile.tagline, 'A drowned frontier');

  assert.throws(
    () => createEntity(library, { type: 'character', name: 'Lost', worldId: nao.id }),
    /world no longer exists/,
    'a character cannot use a non-world as its world',
  );

  const chars = listEntities(library, { type: 'character', worldId: world.id });
  assert.deepEqual(chars.map((c) => c.name), ['Nao']);
});

test('a connection takes its labels and its direction from its kind', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const a = createEntity(library, { type: 'character', name: 'Ari' });
  const b = createEntity(library, { type: 'character', name: 'Bram' });
  const connection = createConnection(library, {
    kindId: 'mentor_of', entityId: a.id, counterpartId: b.id,
    description: 'Since the flood year.',
  });
  assert.equal(connection.sourceId, a.id);
  assert.equal(connection.targetId, b.id);
  assert.equal(connection.label, 'Mentor');
  assert.equal(connection.inverseLabel, 'Student');
  assert.equal(connection.sentence, 'Ari is the mentor of Bram.');

  const updated = updateConnection(library, connection.id, { description: 'Since the flood year, uneasily.' });
  assert.match(updated.description, /uneasily/);

  const forA = listConnections(library, { entityId: a.id });
  assert.equal(forA.length, 1);
  assert.equal(forA[0].sourceName, 'Ari');
  assert.equal(forA[0].targetName, 'Bram');

  /* Each side reads the same fact in its own words, under its own heading. */
  const [ariSection] = connectionsForEntity(library, a.id);
  assert.equal(ariSection.items[0].label, 'Mentor');
  assert.equal(ariSection.items[0].otherName, 'Bram');
  const [bramSection] = connectionsForEntity(library, b.id);
  assert.equal(bramSection.items[0].label, 'Student');
  assert.equal(bramSection.items[0].otherName, 'Ari');

  assert.throws(() => createConnection(library, { kindId: 'mentor_of', entityId: a.id, counterpartId: a.id }),
    /cannot connect to itself/);
});

test('a kind decides which records it can join, and the same fact files once', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const world = createEntity(library, { type: 'world', name: 'Vel' });
  const nao = createEntity(library, { type: 'character', name: 'Nao', worldId: world.id });
  const wardens = createEntity(library, { type: 'group', name: 'Kozuki Wardens', worldId: world.id });
  const relic = createEntity(library, { type: 'object', name: 'The Star Cage', worldId: world.id });

  /* Membership of an object is not a fact this vocabulary can state. */
  assert.throws(
    () => createConnection(library, { kindId: 'member_of', entityId: nao.id, counterpartId: relic.id }),
    /does not join a character to an object/);

  createConnection(library, { kindId: 'member_of', entityId: nao.id, counterpartId: wardens.id });

  /* Filed again from the group's page: the same canonical row, not a second. */
  assert.throws(
    () => createConnection(library, { kindId: 'member_of', entityId: wardens.id, counterpartId: nao.id }),
    /already connected that way/);
  assert.equal(listConnections(library, { kindId: 'member_of' }).length, 1);

  const [naoSection] = connectionsForEntity(library, nao.id);
  assert.equal(naoSection.name, 'Affiliations');
  const [groupSection] = connectionsForEntity(library, wardens.id);
  assert.equal(groupSection.name, 'Members');
  assert.equal(groupSection.items[0].otherName, 'Nao');
});

test('tags apply to entities and are reusable', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const a = createEntity(library, { type: 'character', name: 'Ari' });
  const b = createEntity(library, { type: 'character', name: 'Bram' });
  setSubjectTags(library, 'entity', a.id, ['protagonist', 'sky court']);
  setSubjectTags(library, 'entity', b.id, ['sky court']);

  assert.deepEqual(tagsFor(library, 'entity', a.id).map((x) => x.name).sort(), ['protagonist', 'sky court']);
  const all = listTags(library);
  const skyCourt = all.find((x) => x.name === 'sky court');
  assert.equal(skyCourt.uses, 2, 'the same tag row is reused');

  const tagged = listEntities(library, { type: 'character', tagId: skyCourt.id });
  assert.equal(tagged.length, 2);

  const again = ensureTag(library, 'sky court');
  assert.equal(again.id, skyCourt.id);
});

test('archive shows usage first and archived entities can be restored', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const world = createEntity(library, { type: 'world', name: 'Vel' });
  const nao = createEntity(library, { type: 'character', name: 'Nao', worldId: world.id });
  const lore = createEntity(library, { type: 'lore', name: 'The Vel Accord', worldId: world.id });
  createConnection(library, { kindId: 'concerns', entityId: lore.id, counterpartId: nao.id });

  const usage = entityUsage(library, world.id);
  assert.equal(usage.children.length, 2);
  assert.equal(entityUsage(library, nao.id).connections.length, 1);

  archiveEntity(library, world.id);
  assert.equal(getEntity(library, world.id).status, 'archived');
  assert.equal(listEntities(library, { type: 'world' }).length, 0, 'archived hidden from default lists');
  assert.equal(listEntities(library, { type: 'world', status: 'archived' }).length, 1);

  restoreEntity(library, world.id);
  assert.equal(getEntity(library, world.id).status, 'draft');
});

test('full-text search finds names, aliases, profiles, and explains matches', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const world = createEntity(library, { type: 'world', name: 'Aster Reach' });
  const nao = createEntity(library, { type: 'character', name: 'Nao', worldId: world.id });
  updateEntity(library, nao.id, {
    aliases: ['The Listener'],
    profile: { personality: 'Quietly relentless, keeps every promise.' },
  });

  let result = searchLibrary(library, { query: 'listener' });
  assert.equal(result.groups[0].group, 'character');
  assert.equal(result.groups[0].items[0].title, 'Nao');

  result = searchLibrary(library, { query: 'relentless' });
  assert.equal(result.groups[0].items[0].facet, 'profile');
  assert.match(result.groups[0].items[0].snippet, /\[relentless\]/i, 'snippet marks why it matched');

  result = searchLibrary(library, { query: 'aster' });
  assert.equal(result.groups[0].group, 'world');

  // Prefix search as the user types.
  result = searchLibrary(library, { query: 'listen' });
  assert.equal(result.groups[0].items[0].title, 'Nao');

  // Archived entities drop out of the index.
  archiveEntity(library, nao.id);
  result = searchLibrary(library, { query: 'listener' });
  assert.equal(result.groups.length, 0);
});

test('tag changes are meaningful: entity revision bumps and every subject reindexes', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const nao = createEntity(library, { type: 'character', name: 'Nao' });
  const before = getEntity(library, nao.id).revision;
  setSubjectTags(library, 'entity', nao.id, ['sky court']);
  assert.ok(getEntity(library, nao.id).revision > before, 'entity tags are published, so tagging bumps the revision');
  setSubjectTags(library, 'entity', nao.id, ['sky court']);
  assert.equal(getEntity(library, nao.id).revision, before + 1, 'an unchanged tag set does not bump again');

  // Document and asset tag changes keep the search index fresh.
  const { createDocument } = await import('../electron/services/document-service.js');
  const doc = createDocument(library, { title: 'Plain notes', content: 'nothing special here' });
  setSubjectTags(library, 'document', doc.id, ['moonlore']);
  let found = searchLibrary(library, { query: 'moonlore' });
  assert.equal(found.groups[0]?.items[0]?.title, 'Plain notes', 'document searchable by its new tag');

  const sharp = (await import('sharp')).default;
  const { importAsset } = await import('../electron/services/asset-service.js');
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
  const asset = await importAsset(library, { buffer: png, filename: 'plain.png', title: 'Plain art' });
  setSubjectTags(library, 'asset', asset.id, ['starfall']);
  found = searchLibrary(library, { query: 'starfall' });
  assert.equal(found.groups[0]?.items[0]?.title, 'Plain art', 'asset searchable by its new tag');
});

test('search filters: world excludes unrelated results; tag, status, role, and date narrow correctly', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const sharp = (await import('sharp')).default;
  const { importAsset, setAssetLinks } = await import('../electron/services/asset-service.js');
  const { createDocument } = await import('../electron/services/document-service.js');

  const vel = createEntity(library, { type: 'world', name: 'Vel' });
  const aster = createEntity(library, { type: 'world', name: 'Aster' });
  const nao = createEntity(library, { type: 'character', name: 'Moonlit Nao', worldId: vel.id });
  const bram = createEntity(library, { type: 'character', name: 'Moonlit Bram', worldId: aster.id });
  updateEntity(library, bram.id, { status: 'canonical' });
  createDocument(library, { title: 'Moonlit notes', entityIds: [nao.id], content: 'moonlit prose' });
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 9, g: 9, b: 9 } } }).png().toBuffer();
  const art = await importAsset(library, { buffer: png, filename: 'moonlit.png', title: 'Moonlit art' });
  setAssetLinks(library, art.id, [{ entityId: bram.id, role: 'character.portrait' }]);

  /* world filter: linked documents/assets resolve their world; others drop out */
  const inVel = searchLibrary(library, { query: 'moonlit', worldId: vel.id });
  const velTitles = inVel.groups.flatMap((g) => g.items.map((i) => i.title));
  assert.ok(velTitles.includes('Moonlit Nao') && velTitles.includes('Moonlit notes'));
  assert.ok(!velTitles.includes('Moonlit Bram') && !velTitles.includes('Moonlit art'), 'other-world results are excluded, not passed through');

  /* status filter */
  const canonical = searchLibrary(library, { query: 'moonlit', status: 'canonical' });
  assert.deepEqual(canonical.groups.flatMap((g) => g.items.map((i) => i.title)), ['Moonlit Bram']);

  /* role filter narrows to assets holding that role */
  const portraits = searchLibrary(library, { query: 'moonlit', role: 'character.portrait' });
  assert.deepEqual(portraits.groups.flatMap((g) => g.items.map((i) => i.title)), ['Moonlit art']);

  /* tag filter */
  setSubjectTags(library, 'entity', nao.id, ['chosen']);
  const tag = listTags(library).find((entry) => entry.name === 'chosen');
  const tagged = searchLibrary(library, { query: 'moonlit', tagId: tag.id });
  assert.deepEqual(tagged.groups.flatMap((g) => g.items.map((i) => i.title)), ['Moonlit Nao']);

  /* modified date */
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(searchLibrary(library, { query: 'moonlit', modifiedAfter: future }).groups.length, 0);
});

test('rebuild search index restores drifted state', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const world = createEntity(library, { type: 'world', name: 'Vel Marches' });
  createEntity(library, { type: 'character', name: 'Bram', worldId: world.id });

  // Simulate drift: wipe the index behind the service's back.
  library.db.prepare('DELETE FROM search_index').run();
  assert.equal(searchLibrary(library, { query: 'bram' }).groups.length, 0);

  const counts = rebuildSearchIndex(library);
  assert.equal(counts.entities, 2);
  assert.equal(searchLibrary(library, { query: 'bram' }).groups[0].items[0].title, 'Bram');
});
