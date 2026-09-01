import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './dom-stub.mjs';

/**
 * The bulk asset picker is renderer code, so it runs here against the shared
 * DOM stub — the same approach the router test takes.
 */

function installAssets(assets) {
  globalThis.window = {
    worldhub: {
      invoke: async (command) => {
        if (command !== 'asset.list') throw new Error(`unexpected command ${command}`);
        return { ok: true, value: assets, notices: [] };
      },
    },
  };
}

const portraits = Array.from({ length: 20 }, (_, index) => ({
  id: `asset-${index}`,
  title: `Portrait ${index}`,
  kind: 'image',
  roles: ['portrait'],
  thumbUrl: null,
}));

/** Opens the picker and waits for its first result page to render. */
async function openPicker(pickAssets, options) {
  const overlays = installDom();
  const promise = pickAssets(options);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const root = overlays.children[0];
  const rows = () => root.findAll((node) => node.tagName === 'LI' && node.dataset.assetId);
  return { promise, root, rows };
}

test('bulk picking returns every ticked asset in tick order, in one result', async () => {
  installAssets(portraits);
  const { pickAssets } = await import('../src/ui/asset-picker.js');
  const { promise, root, rows } = await openPicker(pickAssets, { title: 'Add to Portraits' });

  assert.equal(rows().length, 20);
  const order = [5, 1, 9];
  for (const index of order) rows()[index].fire('click');
  assert.equal(root.findButton('Add 3 asset(s)').disabled, false);

  root.findButton('Add 3 asset(s)').fire('click');
  const picked = await promise;
  assert.deepEqual(picked.map((asset) => asset.id), order.map((index) => `asset-${index}`));
});

test('ticking everything shown fills the set in one gesture and honours the remaining room', async () => {
  installAssets(portraits);
  const { pickAssets } = await import('../src/ui/asset-picker.js');
  const { promise, root, rows } = await openPicker(pickAssets, { max: 15 });

  root.findButton('Tick everything shown').fire('click');
  const addButton = root.findButton('Add 15 asset(s)');
  assert.ok(addButton, 'stops at the 15 the set still takes');

  // Rows beyond the cap cannot be ticked while the selection is full.
  rows()[19].fire('click');
  assert.ok(root.findButton('Add 15 asset(s)'), 'a sixteenth tick is refused');

  // Untick one, and a different asset can take its place.
  rows()[0].fire('click');
  rows()[19].fire('click');
  addButton.fire('click');
  const picked = await promise;
  assert.equal(picked.length, 15);
  assert.equal(picked.at(-1).id, 'asset-19');
  assert.ok(!picked.some((asset) => asset.id === 'asset-0'));
});

test('ticking everything shown passes over what the set already holds', async () => {
  installAssets(portraits);
  const { pickAssets } = await import('../src/ui/asset-picker.js');
  const alreadyChosenIds = portraits.slice(0, 18).map((asset) => asset.id);
  const { promise, root } = await openPicker(pickAssets, { max: 2, alreadyChosenIds });

  root.findButton('Tick everything shown').fire('click');
  root.findButton('Add 2 asset(s)').fire('click');
  const picked = await promise;
  assert.deepEqual(picked.map((asset) => asset.id), ['asset-18', 'asset-19']);
});

test('dismissing the bulk picker adds nothing', async () => {
  installAssets(portraits);
  const { pickAssets } = await import('../src/ui/asset-picker.js');
  const { promise, root, rows } = await openPicker(pickAssets, {});

  rows()[2].fire('click');
  root.findButton('Cancel').fire('click');
  assert.deepEqual(await promise, []);
});

test('single picking still resolves with one asset on click', async () => {
  installAssets(portraits);
  const { pickAsset } = await import('../src/ui/asset-picker.js');
  const overlays = installDom();
  const promise = pickAsset({});
  await new Promise((resolve) => setTimeout(resolve, 0));
  const rows = overlays.children[0].findAll((node) => node.tagName === 'LI' && node.className === 'row');
  rows[3].fire('click');
  assert.equal((await promise).id, 'asset-3');
});
