import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestLibrary } from './helpers.mjs';
import { createEntity } from '../electron/services/entity-service.js';
import {
  createConnection, updateConnection, deleteConnection, listConnections,
  connectionsForEntity, connectionSummary, connectionKindUsage,
  listConnectionKinds, kindsForEndpoint, createConnectionKind, updateConnectionKind,
  deleteConnectionKind, mergeConnectionKinds, orientConnection, getConnectionKind,
} from '../electron/services/connection-service.js';
import { searchLibrary } from '../electron/services/search-service.js';

/** A world with one of everything worth connecting. */
function smallWorld(library) {
  const world = createEntity(library, { type: 'world', name: 'Emberfall' });
  const make = (type, name) => createEntity(library, { type, name, worldId: world.id });
  return {
    world,
    nao: make('character', 'Nao'),
    bram: make('character', 'Bram'),
    ari: make('character', 'Ari'),
    wardens: make('group', 'Kozuki Wardens'),
    watch: make('group', 'Night Watch'),
    shrine: make('location', 'North Shrine'),
    lantern: make('object', 'The Lantern'),
  };
}

test('the kind decides the direction, so either endpoint files the same fact', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const w = smallWorld(library);

  /* Filed from the group's page, where the author is looking at the target. */
  const connection = createConnection(library, {
    kindId: 'member_of', entityId: w.wardens.id, counterpartId: w.nao.id,
  });
  assert.equal(connection.sourceId, w.nao.id, 'orientation comes from the kind, not from who filed it');
  assert.equal(connection.targetId, w.wardens.id);
  assert.equal(connection.sentence, 'Nao is a member of Kozuki Wardens.');
});

test('an endpoint pair the kind does not list cannot be saved', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const w = smallWorld(library);

  assert.throws(() => createConnection(library, {
    kindId: 'member_of', entityId: w.nao.id, counterpartId: w.lantern.id,
  }), /does not join a character to an object/);

  /* And the picker is never offered the impossible option in the first place. */
  const forCharacter = kindsForEndpoint(library, 'character');
  const memberOf = forCharacter.find((kind) => kind.id === 'member_of');
  assert.deepEqual(memberOf.counterpartTypes, ['group']);
  assert.equal(memberOf.section, 'Affiliations', 'a character files this under its own heading');

  const forGroup = kindsForEndpoint(library, 'group');
  assert.equal(forGroup.find((kind) => kind.id === 'member_of').section, 'Members',
    'the same kind is presented to the group as its Members');
});

test('the same fact cannot be filed twice, from either side, symmetric or not', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const w = smallWorld(library);

  createConnection(library, { kindId: 'member_of', entityId: w.nao.id, counterpartId: w.wardens.id });
  assert.throws(() => createConnection(library, {
    kindId: 'member_of', entityId: w.wardens.id, counterpartId: w.nao.id,
  }), /already connected that way/);

  /* A symmetric kind has no far side to file from, so both orders collide. */
  createConnection(library, { kindId: 'friend_of', entityId: w.nao.id, counterpartId: w.bram.id });
  assert.throws(() => createConnection(library, {
    kindId: 'friend_of', entityId: w.bram.id, counterpartId: w.nao.id,
  }), /already connected that way/);

  /* An asymmetric kind between two records of one type is two different
     facts, and contradictory rather than duplicate — that is the author's. */
  createConnection(library, { kindId: 'mentor_of', entityId: w.nao.id, counterpartId: w.bram.id });
  createConnection(library, { kindId: 'mentor_of', entityId: w.bram.id, counterpartId: w.nao.id });
  assert.equal(listConnections(library, { kindId: 'mentor_of' }).length, 2);
});

test('a symmetric kind reads forward from both sides; an asymmetric one turns around', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const w = smallWorld(library);

  createConnection(library, { kindId: 'friend_of', entityId: w.nao.id, counterpartId: w.bram.id });
  createConnection(library, { kindId: 'parent_of', entityId: w.nao.id, counterpartId: w.ari.id });

  const naoItems = connectionsForEntity(library, w.nao.id).flatMap((section) => section.items);
  assert.equal(naoItems.find((item) => item.otherName === 'Bram').label, 'Friend');
  assert.equal(naoItems.find((item) => item.otherName === 'Ari').label, 'Parent');

  const bramItems = connectionsForEntity(library, w.bram.id).flatMap((section) => section.items);
  assert.equal(bramItems[0].label, 'Friend', 'symmetric means the same word on both sides');

  const ariItems = connectionsForEntity(library, w.ari.id).flatMap((section) => section.items);
  assert.equal(ariItems[0].label, 'Child', 'the far side of a parent is a child');
  assert.equal(ariItems[0].otherName, 'Nao');
});

test('both orders can be legal, and then the author says which — never the database', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const w = smallWorld(library);

  const kind = getConnectionKind(library, 'parent_of');
  assert.deepEqual(orientConnection(kind, 'character', 'character'),
    { forward: true, inverse: true, ambiguous: true });
  assert.equal(orientConnection(getConnectionKind(library, 'member_of'), 'group', 'character').ambiguous, false);

  const swapped = createConnection(library, {
    kindId: 'parent_of', entityId: w.nao.id, counterpartId: w.ari.id, orientation: 'inverse',
  });
  assert.equal(swapped.sourceId, w.ari.id, 'Ari is the parent when the author says so');
  assert.equal(swapped.sentence, 'Ari is the parent of Nao.');
});

test('connections cross worlds, because canon does', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const here = smallWorld(library);
  const elsewhere = createEntity(library, { type: 'world', name: 'Aster Reach' });
  const visitor = createEntity(library, { type: 'character', name: 'Kel', worldId: elsewhere.id });

  const connection = createConnection(library, {
    kindId: 'member_of', entityId: visitor.id, counterpartId: here.wardens.id,
  });
  assert.equal(connection.sourceName, 'Kel');

  /* Filtering by world keeps a connection that touches it from either end. */
  assert.equal(listConnections(library, { worldId: here.world.id }).length, 1);
  assert.equal(listConnections(library, { worldId: elsewhere.id }).length, 1);
});

test('a setting-specific kind is defined once and then behaves like any other', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const w = smallWorld(library);

  const kind = createConnectionKind(library, {
    category: 'affiliation',
    forwardLabel: 'Sworn to',
    inverseLabel: 'Sworn sword',
    inverseSection: 'Sworn swords',
    sentence: '{source} is sworn to {target}.',
    pairs: [{ sourceType: 'character', targetType: 'group' }],
  });
  assert.equal(kind.id, 'sworn_to');
  assert.equal(kind.builtin, false);
  assert.equal(kind.legacy, false);

  const connection = createConnection(library, {
    kindId: kind.id, entityId: w.nao.id, counterpartId: w.wardens.id,
  });
  assert.equal(connection.sentence, 'Nao is sworn to Kozuki Wardens.');
  assert.throws(() => createConnection(library, {
    kindId: kind.id, entityId: w.nao.id, counterpartId: w.shrine.id,
  }), /does not join a character to a location/);

  const [groupSection] = connectionsForEntity(library, w.wardens.id);
  assert.equal(groupSection.name, 'Sworn swords');
  assert.equal(groupSection.items[0].label, 'Sworn sword');

  /* Reusing it costs nothing: no labels are retyped on the second one. */
  const second = createConnection(library, {
    kindId: kind.id, entityId: w.bram.id, counterpartId: w.wardens.id,
  });
  assert.equal(second.label, 'Sworn to');

  assert.throws(() => deleteConnectionKind(library, kind.id), /still use this kind/);
  assert.throws(() => deleteConnectionKind(library, 'member_of'), /Built-in kinds/);
});

test('a kind cannot be narrowed out from under the facts already filed', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const w = smallWorld(library);

  createConnection(library, { kindId: 'based_at', entityId: w.wardens.id, counterpartId: w.shrine.id });
  assert.throws(() => updateConnectionKind(library, 'based_at', {
    pairs: [{ sourceType: 'character', targetType: 'location' }],
  }), /already join a group to a location/);

  /* Widening is always safe, and reaches the connections that already exist. */
  const widened = updateConnectionKind(library, 'based_at', { forwardLabel: 'Headquarters' });
  assert.equal(widened.forwardLabel, 'Headquarters');
  assert.equal(listConnections(library, { kindId: 'based_at' })[0].label, 'Headquarters',
    'renaming a kind reaches every connection that uses it, rather than only the next one');
});

test('synonymous kinds are merged deliberately, and the merge keeps every record', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const w = smallWorld(library);

  const watchers = createConnectionKind(library, {
    category: 'place', forwardLabel: 'Watches over', inverseLabel: 'Watched by',
    pairs: [{ sourceType: 'character', targetType: 'location' }],
  });
  createConnection(library, { kindId: watchers.id, entityId: w.nao.id, counterpartId: w.shrine.id });
  createConnection(library, { kindId: watchers.id, entityId: w.bram.id, counterpartId: w.shrine.id });

  const result = mergeConnectionKinds(library, watchers.id, 'based_at');
  assert.equal(result.merged, 2);
  assert.equal(listConnections(library, { kindId: 'based_at' }).length, 2, 'nothing was dropped in the move');
  assert.throws(() => getConnectionKind(library, watchers.id), /no longer exists/);

  /* A merge into a kind that cannot hold the fact is refused, not forced. */
  const objectKind = createConnectionKind(library, {
    category: 'ownership', forwardLabel: 'Guards', pairs: [{ sourceType: 'character', targetType: 'object' }],
  });
  createConnection(library, { kindId: objectKind.id, entityId: w.nao.id, counterpartId: w.lantern.id });
  assert.throws(() => mergeConnectionKinds(library, objectKind.id, 'based_at'), /does not join a character to an object/);
});

test('a record summarises its connections by counting them, not by restating them', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const w = smallWorld(library);

  createConnection(library, { kindId: 'member_of', entityId: w.nao.id, counterpartId: w.wardens.id });
  createConnection(library, { kindId: 'member_of', entityId: w.bram.id, counterpartId: w.wardens.id });
  createConnection(library, { kindId: 'leads', entityId: w.ari.id, counterpartId: w.wardens.id });
  createConnection(library, { kindId: 'based_at', entityId: w.wardens.id, counterpartId: w.shrine.id });

  assert.equal(connectionSummary(library, w.wardens.id).line, '2 members · 1 leadership · 1 place');
  assert.equal(connectionSummary(library, w.nao.id).line, '1 affiliation');
  assert.equal(connectionSummary(library, w.lantern.id).total, 0, 'a record with nothing to say says nothing');
});

test('a connection is searchable through its kind, and stops being so when removed', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const w = smallWorld(library);

  const connection = createConnection(library, {
    kindId: 'member_of', entityId: w.nao.id, counterpartId: w.wardens.id,
    description: 'Sworn in after the flood year.',
  });
  const found = searchLibrary(library, { query: 'flood' });
  const group = found.groups.find((entry) => entry.group === 'connection');
  assert.ok(group, 'the note is searchable');
  assert.equal(group.items[0].href, '/connections');

  deleteConnection(library, connection.id);
  assert.equal(searchLibrary(library, { query: 'flood' }).groups.length, 0);
});

test('a connection can be moved to another kind or another counterpart, and stays valid', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const w = smallWorld(library);

  const connection = createConnection(library, {
    kindId: 'member_of', entityId: w.nao.id, counterpartId: w.wardens.id,
  });

  const moved = updateConnection(library, connection.id, { viewerId: w.nao.id, counterpartId: w.watch.id });
  assert.equal(moved.targetName, 'Night Watch');
  assert.equal(moved.sourceId, w.nao.id);

  const retyped = updateConnection(library, connection.id, { kindId: 'leads' });
  assert.equal(retyped.label, 'Leader');

  assert.throws(() => updateConnection(library, connection.id, { kindId: 'lives_in' }),
    /does not join a character to a group/);

  const usage = connectionKindUsage(library);
  assert.equal(usage.find((row) => row.id === 'leads').uses, 1);
  assert.equal(usage.find((row) => row.id === 'member_of').uses, 0);
});

test('the library opens with the published vocabulary already in it', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const kinds = listConnectionKinds(library, {});
  assert.ok(kinds.length >= 25, 'a fresh library can state a fact without anyone defining a kind first');
  assert.equal(kinds.every((kind) => kind.builtin), true, 'and nothing legacy exists until an upgrade makes it');
  assert.deepEqual(listConnectionKinds(library, { sourceType: 'character', targetType: 'group' })
    .map((kind) => kind.id).sort(), ['founded', 'leads', 'member_of']);
});
