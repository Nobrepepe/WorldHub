import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestLibrary } from './helpers.mjs';
import { installDom, settle, StubNode } from './dom-stub.mjs';
import { createEntity } from '../electron/services/entity-service.js';
import * as connections from '../electron/services/connection-service.js';
import { connectionCategories } from '../electron/services/connection-vocabulary.js';
import { listEntities } from '../electron/services/entity-service.js';

/**
 * The screens, driven against a real library.
 *
 * The service tests prove the rules and the drawer tests prove the offer,
 * but neither would notice a screen that asked for a command nobody
 * registered, or grouped its rows by a heading the service never returns.
 * Here the views run against real data through the real service functions,
 * so the two halves have to agree about the shape passing between them.
 */

function installBridge(library) {
  globalThis.window = {
    worldhub: {
      invoke: async (command, payload = {}) => {
        const handlers = {
          'entity.list': () => listEntities(library, payload),
          'connection.categories': () => connectionCategories(),
          'connection.kinds': () => connections.listConnectionKinds(library, payload),
          'connection.kindsForType': () => connections.kindsForEndpoint(library, payload.entityType, payload),
          'connection.kindUsage': () => connections.connectionKindUsage(library),
          'connection.kindMerge': () => connections.mergeConnectionKinds(library, payload.fromId, payload.toId),
          'connection.kindDelete': () => connections.deleteConnectionKind(library, payload.id),
          'connection.kindCreate': () => connections.createConnectionKind(library, payload),
          'connection.list': () => connections.listConnections(library, payload),
          'connection.forEntity': () => connections.connectionsForEntity(library, payload.id),
          'connection.summary': () => connections.connectionSummary(library, payload.id),
          'connection.create': () => connections.createConnection(library, payload),
          'connection.update': () => connections.updateConnection(library, payload.id, payload),
          'connection.delete': () => connections.deleteConnection(library, payload.id),
        };
        if (!(command in handlers)) throw new Error(`the screen asked for an unregistered command: ${command}`);
        try {
          return { ok: true, value: handlers[command](), notices: [] };
        } catch (err) {
          return { ok: false, error: { code: err.code ?? 'unknown', message: err.message }, notices: [] };
        }
      },
    },
  };
}

async function scene(t) {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  installDom();
  installBridge(library);
  const world = createEntity(library, { type: 'world', name: 'Emberfall' });
  const make = (type, name) => createEntity(library, { type, name, worldId: world.id });
  return {
    library,
    world,
    nao: make('character', 'Nao'),
    bram: make('character', 'Bram'),
    wardens: make('group', 'Kozuki Wardens'),
    shrine: make('location', 'North Shrine'),
  };
}

const headings = (node) => node.findAll((child) => child.className === 'eyebrow').map((child) => child.textContent);

test('a group with nothing but members is useful, and says so under its own heading', async (t) => {
  const s = await scene(t);
  const { connectionsSection } = await import('../src/views/detail-common.js');

  /* Before anything is connected, the empty state is about groups. */
  let section = await connectionsSection(s.wardens);
  assert.match(section.textContent, /A group is mostly its members/);

  connections.createConnection(s.library, {
    kindId: 'member_of', entityId: s.nao.id, counterpartId: s.wardens.id,
  });
  connections.createConnection(s.library, {
    kindId: 'member_of', entityId: s.bram.id, counterpartId: s.wardens.id,
  });
  connections.createConnection(s.library, {
    kindId: 'leads', entityId: s.nao.id, counterpartId: s.wardens.id,
  });
  connections.createConnection(s.library, {
    kindId: 'based_at', entityId: s.wardens.id, counterpartId: s.shrine.id,
  });

  section = await connectionsSection(s.wardens);
  assert.deepEqual(headings(section), ['Members', 'Leadership', 'Places'],
    'the headings, and their order, come from the kinds rather than from this screen');

  const rows = section.findAll((node) => node.tagName === 'LI');
  assert.deepEqual(rows.map((row) => row.find((n) => n.className === 'row-title').textContent),
    ['Nao', 'Bram', 'Nao', 'North Shrine']);

  /* The offer sits under the heading it belongs to, in that heading's words. */
  assert.ok(section.findButton('Add a member →'));
  assert.ok(section.findButton('Add to leadership →'), 'two kinds share that heading, so it names the heading');
  assert.ok(section.findButton('Connect to another record →'));
});

test('the same facts read from the character, in the character’s words', async (t) => {
  const s = await scene(t);
  const { connectionsSection, connectionSummaryLine } = await import('../src/views/detail-common.js');

  connections.createConnection(s.library, {
    kindId: 'member_of', entityId: s.nao.id, counterpartId: s.wardens.id,
  });
  connections.createConnection(s.library, {
    kindId: 'mentor_of', entityId: s.nao.id, counterpartId: s.bram.id,
  });

  const naoSection = await connectionsSection(s.nao);
  assert.deepEqual(headings(naoSection), ['People', 'Affiliations']);
  const naoRows = naoSection.findAll((node) => node.tagName === 'LI');
  assert.equal(naoRows[0].find((n) => n.className === 'row-sub').textContent, 'Mentor');
  assert.equal(naoRows[1].find((n) => n.className === 'row-title').textContent, 'Kozuki Wardens');
  assert.equal(naoRows[1].find((n) => n.className === 'row-sub').textContent, 'Member');

  const bramSection = await connectionsSection(s.bram);
  assert.equal(bramSection.findAll((node) => node.tagName === 'LI')[0].find((n) => n.className === 'row-sub').textContent,
    'Student', 'the far side of a mentor is a student, from one stored record');

  const summary = await connectionSummaryLine(s.nao);
  assert.equal(summary.textContent, '1 person · 1 affiliation');
  assert.equal(await connectionSummaryLine(s.shrine), null, 'a record with nothing to say says nothing');
});

test('connecting from the group’s page produces the fact the character already shows', async (t) => {
  const s = await scene(t);
  const overlays = installDom();
  installBridge(s.library);
  const { openConnectionDrawer } = await import('../src/views/connections.js');

  const promise = openConnectionDrawer({ entity: { ...s.wardens, worldId: s.world.id }, presetKinds: ['member_of'] });
  await settle();
  const drawer = overlays.children[0].children[0];

  drawer.findButton('Choose a character').fire('click');
  await settle();
  const picker = overlays.children.at(-1);
  picker.findAll((node) => node.tagName === 'LI' && node.className?.includes('row'))
    .find((row) => row.textContent.startsWith('Nao')).fire('click');
  await settle();

  const fact = drawer.find((node) => node.className?.includes('fact-line'));
  assert.equal(fact.textContent, 'Nao is a member of Kozuki Wardens.',
    'filed from the group, the sentence still runs the way the kind says');

  drawer.find((node) => node.tagName === 'FORM').fire('submit');
  assert.equal(await promise, true);

  const stored = connections.listConnections(s.library, { kindId: 'member_of' });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].sourceId, s.nao.id, 'one canonical row, oriented by the kind');
  assert.equal(stored[0].targetId, s.wardens.id);
});

test('the Connections screen lists, filters and tidies what an upgrade left behind', async (t) => {
  const s = await scene(t);
  const { renderConnections } = await import('../src/views/connections.js');

  /* Two kinds that mean the same thing, as an upgrade would leave them. */
  const watches = connections.createConnectionKind(s.library, {
    category: 'place', forwardLabel: 'Watches over', inverseLabel: 'Watched by',
    pairs: [{ sourceType: 'character', targetType: 'location' }],
  });
  connections.createConnection(s.library, { kindId: watches.id, entityId: s.nao.id, counterpartId: s.shrine.id });
  connections.createConnection(s.library, { kindId: 'member_of', entityId: s.bram.id, counterpartId: s.wardens.id });

  const screen = await renderConnections();
  assert.match(screen.textContent, /2 connections/);
  const rows = screen.findAll((node) => node.tagName === 'LI' && node.className === 'row');
  const sentences = rows.map((row) => row.find((n) => n.className === 'row-title').textContent);
  assert.deepEqual(sentences.sort(), ['Bram is a member of Kozuki Wardens.', 'Nao — Watches over — North Shrine']);

  /* Every filter the audit view offers is really wired to the query. */
  const selects = screen.findAll((node) => node.tagName === 'SELECT');
  const labels = selects.map((node) => node.getAttribute('aria-label'));
  assert.deepEqual(labels.slice(0, 7), [
    'World', 'Category', 'Kind', 'From', 'To', 'Lifecycle', 'Definitions',
  ]);
  const byType = selects[3];
  byType.value = 'group';
  byType.fire('change', { target: { value: 'group' } });
  await settle();
  assert.match(screen.textContent, /0 connections|Nothing matches/);

  /* And the kinds a library accumulated can be merged without losing a record. */
  assert.match(screen.textContent, /Kinds of connection/);
  assert.ok(screen.find((node) => node.getAttribute?.('aria-label') === 'Merge Watches over into another kind'));
});

test('a kind this setting needs is defined without leaving the record being connected', async (t) => {
  const s = await scene(t);
  const overlays = installDom();
  installBridge(s.library);
  const { openConnectionDrawer } = await import('../src/views/connections.js');

  const promise = openConnectionDrawer({ entity: { ...s.nao, worldId: s.world.id } });
  await settle();
  const drawer = overlays.children[0].children[0];

  drawer.findButton('Define a new kind →').fire('click');
  await settle();
  const kindDrawer = overlays.children.at(-1).children[0];

  const set = (label, value) => {
    const node = kindDrawer.find((child) => child.getAttribute?.('aria-label') === label);
    node.value = value;
    node.fire(node.tagName === 'SELECT' ? 'change' : 'input', { target: { value } });
  };
  set('Category', 'affiliation');
  set('From this kind of record', 'character');
  set('To this kind of record', 'group');
  set('Label on the first record', 'Sworn to');
  set('Label on the second record', 'Sworn sword');
  set('Heading on the second record', 'Sworn swords');
  set('Sentence', '{source} is sworn to {target}.');

  assert.equal(kindDrawer.find((node) => node.className?.includes('fact-line')).textContent,
    'A character is sworn to a group.', 'the definition is previewed as the sentence it will state');

  kindDrawer.find((node) => node.tagName === 'FORM').fire('submit');
  await settle();

  /* Back in the connection drawer, the new kind is already the chosen one. */
  const chosen = drawer.findAll((node) => node.dataset?.kindId)
    .find((node) => node.getAttribute('aria-pressed') === 'true');
  assert.equal(chosen.dataset.kindId, 'sworn_to');

  drawer.findButton('Choose a group').fire('click');
  await settle();
  overlays.children.at(-1).findAll((node) => node.tagName === 'LI' && node.className?.includes('row'))[0].fire('click');
  await settle();
  assert.equal(drawer.find((node) => node.className?.includes('fact-line')).textContent,
    'Nao is sworn to Kozuki Wardens.');

  drawer.find((node) => node.tagName === 'FORM').fire('submit');
  assert.equal(await promise, true);

  const stored = connections.listConnections(s.library, { kindId: 'sworn_to' });
  assert.equal(stored.length, 1);
  assert.equal(connections.connectionsForEntity(s.library, s.wardens.id)[0].name, 'Sworn swords');
});
