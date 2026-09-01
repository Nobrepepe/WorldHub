import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, installIpc, settle } from './dom-stub.mjs';

/**
 * The drawer is where the whole design either holds or does not.
 *
 * Its job is to let an author state a fact — "Nao is a member of the Kozuki
 * Wardens" — without meeting a direction, a label, or a record the fact
 * cannot be about. So these tests check what it *offers*, not only what it
 * saves: an impossible pair that is merely refused on save is a worse
 * interface than one that was never presented.
 */

const KINDS_FOR_CHARACTER = [
  {
    id: 'friend_of', category: 'social', label: 'Friend', section: 'People',
    forwardLabel: 'Friend', inverseLabel: 'Friend', symmetric: true,
    sentence: '{source} and {target} are friends.',
    counterpartTypes: ['character'], role: 'either',
    pairs: [{ sourceType: 'character', targetType: 'character' }],
  },
  {
    id: 'mentor_of', category: 'social', label: 'Mentor', section: 'People',
    forwardLabel: 'Mentor', inverseLabel: 'Student', symmetric: false,
    sentence: '{source} is the mentor of {target}.',
    counterpartTypes: ['character'], role: 'either',
    pairs: [{ sourceType: 'character', targetType: 'character' }],
  },
  {
    id: 'member_of', category: 'affiliation', label: 'Member', section: 'Affiliations',
    forwardLabel: 'Member', inverseLabel: 'Member', symmetric: false,
    sentence: '{source} is a member of {target}.',
    counterpartTypes: ['group'], role: 'source',
    pairs: [{ sourceType: 'character', targetType: 'group' }],
  },
];

const KINDS_FOR_GROUP = [
  {
    id: 'member_of', category: 'affiliation', label: 'Member', section: 'Members',
    forwardLabel: 'Member', inverseLabel: 'Member', symmetric: false,
    sentence: '{source} is a member of {target}.',
    counterpartTypes: ['character'], role: 'target',
    pairs: [{ sourceType: 'character', targetType: 'group' }],
  },
];

const CATEGORIES = [
  { id: 'social', label: 'People', section: 'People' },
  { id: 'affiliation', label: 'Affiliations', section: 'Affiliations' },
  { id: 'place', label: 'Places', section: 'Places' },
];

const RECORDS = [
  { id: 'g1', name: 'Kozuki Wardens', type: 'group', worldId: 'w1', slug: 'kozuki-wardens' },
  { id: 'c2', name: 'Bram', type: 'character', worldId: 'w1', slug: 'bram' },
  { id: 'c3', name: 'Kel', type: 'character', worldId: 'w2', slug: 'kel' },
];

const NAO = { id: 'c1', name: 'Nao', type: 'character', worldId: 'w1' };

function stubs(overrides = {}) {
  return {
    'connection.categories': CATEGORIES,
    'connection.kindsForType': ({ entityType }) => (entityType === 'group' ? KINDS_FOR_GROUP : KINDS_FOR_CHARACTER),
    'entity.list': ({ types }) => RECORDS.filter((record) => !types || types.includes(record.type)),
    'connection.create': (payload) => ({ id: 'new', ...payload }),
    'connection.update': (payload) => ({ id: payload.id }),
    ...overrides,
  };
}

/** Open the drawer and hand back its root once its kinds have loaded. */
async function openDrawerFor(entity, options = {}, handlers = {}) {
  const overlays = installDom();
  const calls = installIpc(stubs(handlers));
  const { openConnectionDrawer } = await import('../src/views/connections.js');
  const promise = openConnectionDrawer({ entity, ...options });
  await settle();
  /* overlays holds backdrops; the drawer itself is the backdrop's only child. */
  return { promise, root: overlays.children[0].children[0], overlays, calls };
}

const factLine = (root) => root.find((node) => node.className?.includes('fact-line'));
/** The drawer's form is what carries the save; firing the div would do nothing. */
const submit = (root) => root.find((node) => node.tagName === 'FORM').fire('submit');
const kindButtons = (root) => root.findAll((node) => node.dataset?.kindId);

test('the drawer offers only the categories and kinds this record can hold', async () => {
  const { root, promise } = await openDrawerFor(NAO);

  const categories = root.findAll((node) => node.className === 'kind-choice' && !node.dataset.kindId);
  assert.deepEqual(categories.map((node) => node.text()), ['People', 'Affiliations'],
    'Places is not offered, because no kind joins a character to a place in this vocabulary');

  categories[1].fire('click');
  assert.deepEqual(kindButtons(root).map((node) => node.dataset.kindId), ['member_of']);

  root.findButton('Cancel').fire('click');
  await promise;
});

test('the drawer states the fact before it is saved, and will not save until it reads', async () => {
  const { root, promise } = await openDrawerFor(NAO);

  assert.match(factLine(root).textContent, /Choose what kind of fact/);
  assert.equal(root.findButton('Save the connection').disabled, true);

  root.findAll((node) => node.className === 'kind-choice' && !node.dataset.kindId)[1].fire('click');
  assert.match(factLine(root).textContent, /Choose which record Nao is connected to/);
  assert.equal(root.findButton('Save the connection').disabled, true);

  root.findButton('Choose a group').fire('click');
  await settle();
  root.findButton('Cancel').fire('click');
  await promise;
});

test('the picker is restricted to records the chosen kind accepts', async () => {
  const { root, overlays, promise, calls } = await openDrawerFor(NAO);

  root.findAll((node) => node.className === 'kind-choice' && !node.dataset.kindId)[1].fire('click');
  root.findButton('Choose a group').fire('click');
  await settle();

  const listed = calls.filter((entry) => entry.command === 'entity.list').at(-1);
  assert.deepEqual(listed.payload.types, ['group'],
    'a membership can only point at a group, so only groups are offered');

  const picker = overlays.children.at(-1);
  const rows = picker.findAll((node) => node.tagName === 'LI' && node.className?.includes('row'));
  assert.deepEqual(rows.map((row) => row.text().split('group')[0].trim()), ['Kozuki Wardens']);

  rows[0].fire('click');
  await settle();
  assert.equal(factLine(root).textContent, 'Nao is a member of Kozuki Wardens.');
  assert.equal(root.findButton('Save the connection').disabled, false);

  root.findButton('Cancel').fire('click');
  await promise;
});

test('saving names the kind and the two records, and never a direction', async () => {
  const { root, overlays, promise, calls } = await openDrawerFor(NAO);

  root.findAll((node) => node.className === 'kind-choice' && !node.dataset.kindId)[1].fire('click');
  root.findButton('Choose a group').fire('click');
  await settle();
  overlays.children.at(-1).findAll((node) => node.tagName === 'LI' && node.className?.includes('row'))[0].fire('click');
  await settle();

  submit(root);
  await promise;

  const created = calls.find((entry) => entry.command === 'connection.create');
  assert.deepEqual(created.payload, {
    kindId: 'member_of', entityId: 'c1', counterpartId: 'g1', description: '', orientation: 'forward',
  });
  assert.equal('sourceId' in created.payload, false, 'the author never chose which end is the source');
});

test('the same kind is offered to the group as its Members', async () => {
  const wardens = { id: 'g1', name: 'Kozuki Wardens', type: 'group', worldId: 'w1' };
  const { root, promise } = await openDrawerFor(wardens);

  /* One category, so it opens on it; one kind, so it is already chosen. */
  assert.equal(kindButtons(root).length, 1);
  assert.equal(root.findButton('Choose a character').disabled, false,
    'from this side the fact points the other way, and the drawer knows it');

  root.findButton('Cancel').fire('click');
  await promise;
});

test('a kind two records of one type can share offers a swap, and a symmetric one does not', async () => {
  const { root, overlays, promise, calls } = await openDrawerFor(NAO);
  const categories = root.findAll((node) => node.className === 'kind-choice' && !node.dataset.kindId);

  categories[0].fire('click');
  kindButtons(root).find((node) => node.dataset.kindId === 'mentor_of').fire('click');
  root.findButton('Choose a character').fire('click');
  await settle();
  overlays.children.at(-1).findAll((node) => node.tagName === 'LI' && node.className?.includes('row'))[0].fire('click');
  await settle();

  assert.equal(factLine(root).textContent, 'Nao is the mentor of Bram.');
  const swap = root.findButton('The other way round');
  assert.equal(swap.hidden, false, 'either character could be the mentor, so the author says which');
  swap.fire('click');
  assert.equal(factLine(root).textContent, 'Bram is the mentor of Nao.');

  /* A symmetric kind has no other way round to offer. */
  kindButtons(root).find((node) => node.dataset.kindId === 'friend_of').fire('click');
  assert.equal(root.findButton('The other way round').hidden, true);

  submit(root);
  await promise;
  const created = calls.find((entry) => entry.command === 'connection.create');
  assert.equal(created.payload.kindId, 'friend_of');
  assert.equal(created.payload.orientation, 'forward');
});

test('choosing a kind that cannot hold the record already picked clears it', async () => {
  const { root, overlays, promise } = await openDrawerFor(NAO);
  const categories = root.findAll((node) => node.className === 'kind-choice' && !node.dataset.kindId);

  categories[0].fire('click');
  kindButtons(root).find((node) => node.dataset.kindId === 'friend_of').fire('click');
  root.findButton('Choose a character').fire('click');
  await settle();
  overlays.children.at(-1).findAll((node) => node.tagName === 'LI' && node.className?.includes('row'))[0].fire('click');
  await settle();
  assert.equal(factLine(root).textContent, 'Nao and Bram are friends.');

  categories[1].fire('click');
  assert.match(factLine(root).textContent, /Choose which record/,
    'Bram cannot be a group, so the drawer lets him go rather than saving something impossible');
  assert.equal(root.findButton('Save the connection').disabled, true);

  root.findButton('Cancel').fire('click');
  await promise;
});

test('editing opens on the connection as it stands and updates it in place', async () => {
  const existing = {
    id: 'x1', kindId: 'member_of', otherId: 'g1', otherName: 'Kozuki Wardens',
    otherType: 'group', description: 'Sworn in after the flood year.',
  };
  const { root, promise, calls } = await openDrawerFor(NAO, { existing });

  assert.equal(factLine(root).textContent, 'Nao is a member of Kozuki Wardens.');
  assert.equal(root.findButton('Kozuki Wardens').disabled, false);

  submit(root);
  await promise;
  const updated = calls.find((entry) => entry.command === 'connection.update');
  assert.equal(updated.payload.id, 'x1');
  assert.equal(updated.payload.viewerId, 'c1');
  assert.equal(updated.payload.counterpartId, 'g1');
});

test('a section opens the drawer already narrowed to its own kinds', async () => {
  const { root, promise } = await openDrawerFor(NAO, { presetKinds: ['member_of'] });

  const categories = root.findAll((node) => node.className === 'kind-choice' && !node.dataset.kindId);
  assert.deepEqual(categories.map((node) => node.text()), ['Affiliations'],
    'reached from Affiliations, there is nothing else to choose');
  assert.deepEqual(kindButtons(root).map((node) => node.dataset.kindId), ['member_of'],
    'and the one kind is already chosen');

  root.findButton('Cancel').fire('click');
  await promise;
});

test('the drawer is a drawer, and the same layer everything else uses', async () => {
  const { root, overlays, promise } = await openDrawerFor(NAO);

  assert.ok(root.className.includes('overlay-drawer'), 'it is anchored to the side, not the middle');
  assert.equal(root.getAttribute('role'), 'dialog');
  assert.equal(root.getAttribute('aria-modal'), 'true');
  assert.equal(root.getAttribute('aria-label'), 'Connect Nao');

  /* Escape closes the top layer, because it is the ordinary overlay stack. */
  const { closeTopOverlay } = await import('../src/ui/overlay.js');
  assert.equal(closeTopOverlay(), true);
  assert.equal(await promise, undefined);
  assert.equal(overlays.children.length, 0);
});
