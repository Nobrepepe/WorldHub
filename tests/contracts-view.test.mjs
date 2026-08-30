import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The Contracts screen is where a contract enters World Hub. When the import
 * path was built, the command and the service were wired but this screen was
 * not — so the only way in was still the JSON field, which is the habit the
 * whole change exists to replace. These check the screen offers the way in.
 *
 * Renderer code, so it runs against the same small DOM stub the picker and
 * router tests use.
 */

class StubNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.style = {};
    this.className = '';
    this.textContent = '';
    this.listeners = new Map();
    this.classList = { toggle() {}, contains: (n) => this.className.split(' ').includes(n), add() {}, remove() {} };
  }
  get firstChild() { return this.children[0] ?? null; }
  append(...nodes) { this.children.push(...nodes.filter((n) => n !== null && n !== undefined)); }
  removeChild(child) { this.children = this.children.filter((item) => item !== child); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  replaceWith() {} remove() {} focus() {}
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  querySelector() { return null; }
  descendants() {
    return this.children.flatMap((c) => (c instanceof StubNode ? [c, ...c.descendants()] : []));
  }
}

function textOf(node) {
  if (typeof node === 'string') return node;
  if (!(node instanceof StubNode)) return '';
  return (node.textContent ?? '') + node.children.map(textOf).join('');
}
const buttons = (root) => root.descendants().filter((n) => n.tagName === 'BUTTON');
const button = (root, text) => buttons(root).find((b) => textOf(b).includes(text));

function installDom() {
  globalThis.Node = StubNode;
  globalThis.location = { hash: '#/contracts', assign() {} };
  globalThis.document = {
    createElement: (tag) => new StubNode(tag),
    createTextNode: (text) => text,
    getElementById: () => new StubNode('div'),
    activeElement: null,
    body: new StubNode('body'),
    addEventListener() {},
  };
}

/** Record every command the screen issues, and answer them. */
function installIpc(answers) {
  const calls = [];
  globalThis.window = {
    worldhub: {
      invoke: async (command, payload) => {
        calls.push({ command, payload });
        if (!(command in answers)) throw new Error(`unexpected command ${command}`);
        const value = typeof answers[command] === 'function' ? answers[command](payload) : answers[command];
        return { ok: true, value, notices: [] };
      },
      onEvent() {},
    },
  };
  return calls;
}

const CONTRACT = {
  format: 'world-hub-application-contract', contractFormatVersion: 1,
  appType: 'field-guide.bestiary', name: 'Field Guide',
  supportedProtocolVersions: [1, 2], productionFields: [], entitySelections: [],
  assetSets: [], documents: { mode: 'linked' }, requiredRecipes: [],
};

test('the contracts screen offers importing a file, not only writing one here', async () => {
  installDom();
  const calls = installIpc({
    'contract.list': [],
    'contract.importFile': { contractId: 'c1', version: 1, name: 'Field Guide', imported: 'created', sourcePath: '/repo/worldhub/application-contract.json', contract: CONTRACT },
  });
  const { renderContracts } = await import('../src/views/contracts.js?v=import');
  const host = await renderContracts();

  const importButton = button(host, 'Import from file');
  assert.ok(importButton, `no import control on the screen; found: ${buttons(host).map(textOf).join(' | ')}`);

  await importButton.listeners.get('click')?.();
  assert.ok(calls.some((c) => c.command === 'contract.importFile'),
    `clicking it must import; issued: ${calls.map((c) => c.command).join(', ')}`);
});

test('writing one by hand is still possible, just no longer the primary way', async () => {
  installDom();
  installIpc({ 'contract.list': [] });
  const { renderContracts } = await import('../src/views/contracts.js?v=create');
  const host = await renderContracts();

  const write = button(host, 'Write one here');
  assert.ok(write, 'a contract with no application to own it can still be written here');
  assert.equal(write.className, 'btn', 'but it is not the primary action');
  assert.equal(button(host, 'Import from file').className, 'btn btn-primary',
    'importing is what the screen leads with');
});
