import test from 'node:test';
import assert from 'node:assert/strict';

test('installRouter reattaches rendering while installing one hashchange listener', async () => {
  const listeners = [];
  globalThis.window = {
    addEventListener(name, listener) { listeners.push({ name, listener }); },
  };
  globalThis.location = { hash: '#/router-reattach-test' };

  const makeHost = () => ({
    children: [],
    parentElement: { scrollTo() {} },
    replaceChildren(...children) { this.children = children; },
  });
  globalThis.document = {
    createElement() {
      return {
        className: '', children: [],
        append(...children) { this.children.push(...children); },
        querySelector() { return null; },
      };
    },
  };

  const router = await import(`../src/router.js?reattach=${Date.now()}`);
  const { update } = await import('../src/store.js');
  update({ library: { name: 'Test library' } });
  router.registerRoute('/router-reattach-test', async () => ({ marker: 'rendered' }));

  const detached = makeHost();
  const visible = makeHost();
  let firstCallbacks = 0;
  let currentCallbacks = 0;
  router.installRouter(detached, () => { firstCallbacks++; });
  router.installRouter(visible, () => { currentCallbacks++; });
  router.installRouter(visible, () => { currentCallbacks++; });
  await router.renderCurrent();

  assert.equal(listeners.filter(({ name }) => name === 'hashchange').length, 1);
  assert.equal(detached.children.length, 0, 'detached chooser placeholder is no longer the render host');
  assert.equal(visible.children.length, 1, 'the visible shell receives the route');
  assert.equal(firstCallbacks, 0, 'the stale callback is replaced');
  assert.equal(currentCallbacks, 1, 'the latest callback runs once');
});

test('re-rendering the screen you are already on keeps the scroll position', async () => {
  globalThis.window = { addEventListener() {} };
  globalThis.location = { hash: '#/router-scroll-test' };

  const scroller = { scrollTop: 0, scrollTo(x, y) { this.scrollTop = y; } };
  const host = {
    children: [], parentElement: scroller,
    replaceChildren(...children) { this.children = children; },
  };
  globalThis.document = {
    createElement() {
      return {
        className: '', children: [],
        append(...children) { this.children.push(...children); },
        querySelector() { return null; },
      };
    },
  };

  const router = await import(`../src/router.js?scroll=${Date.now()}`);
  const { update } = await import(`../src/store.js?scroll=${Date.now()}`);
  update({ library: { name: 'Test library' } });
  router.registerRoute('/router-scroll-test', async () => ({ marker: 'a' }));
  router.registerRoute('/router-other-test', async () => ({ marker: 'b' }));
  router.installRouter(host, () => {});

  await router.renderCurrent();
  assert.equal(scroller.scrollTop, 0, 'arriving on a screen starts at the top');

  // The author scrolls down, then an editor commits and redraws.
  scroller.scrollTop = 640;
  await router.renderCurrent();
  assert.equal(scroller.scrollTop, 640, 'a redraw of the same screen does not throw the author to the top');

  globalThis.location.hash = '#/router-other-test';
  await router.renderCurrent();
  assert.equal(scroller.scrollTop, 0, 'a real move to another screen still starts at the top');
});

test('a detail screen names the screen it was reached from, and walking back retires it', async () => {
  globalThis.window = { addEventListener() {} };
  // Like the real thing: assigning a bare path grows the leading hash.
  globalThis.location = {
    value: '#/worlds',
    get hash() { return this.value; },
    set hash(next) { this.value = next.startsWith('#') ? next : `#${next}`; },
  };

  const node = (tagName = 'DIV', textContent = '') => ({
    tagName, textContent, className: '', children: [],
    append(...children) { this.children.push(...children); },
    setAttribute() {}, focus() {},
    querySelector(selector) {
      const wanted = selector.toUpperCase();
      for (const child of this.children) {
        if (child?.tagName === wanted) return child;
        const found = child?.querySelector?.(wanted);
        if (found) return found;
      }
      return null;
    },
  });
  globalThis.document = { createElement: (tag) => node(tag.toUpperCase()) };

  const host = {
    children: [], parentElement: { scrollTop: 0, scrollTo() {} },
    replaceChildren(...children) { this.children = children; },
  };

  const stamp = Date.now();
  const router = await import(`../src/router.js?trail=${stamp}`);
  const { update } = await import(`../src/store.js?trail=${stamp}`);
  update({ library: { name: 'Test library' } });
  const screen = (title) => async () => node('H1', title);
  router.registerRoute('/worlds', screen('Worlds'));
  router.registerRoute('/world/:id', screen('Aetheria'));
  router.registerRoute('/character/:id', screen('Vela'));
  router.installRouter(host, () => {});

  await router.renderCurrent();
  globalThis.location.hash = '#/world/w1';
  await router.renderCurrent();
  assert.deepEqual(router.backDestination('/world/w1'), { path: '/worlds', title: 'Worlds' },
    'a world reached from the worlds screen goes back there');

  globalThis.location.hash = '#/character/c1';
  await router.renderCurrent();
  assert.deepEqual(router.backDestination('/character/c1'), { path: '/world/w1', title: 'Aetheria' },
    'a character opened inside a world names that world, not the character list');

  await router.goBack('/character/c1');
  assert.equal(globalThis.location.hash, '#/world/w1');
  await router.renderCurrent();
  assert.deepEqual(router.backDestination('/world/w1'), { path: '/worlds', title: 'Worlds' },
    'returning retires the step instead of stacking a way back to where you just were');
});

test('a detail opened cold falls back to the screen its record belongs to', async () => {
  globalThis.window = { addEventListener() {} };
  globalThis.location = { hash: '#/asset/a1' };
  globalThis.document = {
    createElement: () => ({
      className: '', children: [],
      append(...children) { this.children.push(...children); },
      querySelector() { return null; },
    }),
  };

  const stamp = `cold-${Date.now()}`;
  const router = await import(`../src/router.js?${stamp}`);
  const { update } = await import(`../src/store.js?${stamp}`);
  update({ library: { name: 'Test library' } });
  router.registerRoute('/asset/:id', async () => ({ marker: 'asset' }));
  router.installRouter({
    children: [], parentElement: { scrollTo() {} },
    replaceChildren(...children) { this.children = children; },
  }, () => {});

  await router.renderCurrent();
  assert.deepEqual(router.backDestination('/asset/a1'), { path: '/assets', title: 'Assets' });
});

test('a screen whose title is an editable field still names itself for the trail', async () => {
  globalThis.window = { addEventListener() {} };
  globalThis.location = { hash: '#/document/d1' };

  // A document header carries no headline: its title is an input, so the
  // header states the name through data-screen-name instead.
  const header = {
    tagName: 'HEADER', children: [], attributes: { 'data-screen-name': 'The Salt Accord' },
    append() {}, getAttribute(name) { return this.attributes[name] ?? null; },
    querySelector() { return null; },
  };
  globalThis.document = {
    createElement: () => ({
      className: '', children: [],
      append(...children) { this.children.push(...children); },
      querySelector(selector) {
        return selector === '[data-screen-name]' ? header : null;
      },
    }),
  };

  const stamp = `named-${Date.now()}`;
  const router = await import(`../src/router.js?${stamp}`);
  const { update } = await import(`../src/store.js?${stamp}`);
  update({ library: { name: 'Test library' } });
  router.registerRoute('/document/:id', async () => header);
  router.registerRoute('/character/:id', async () => header);
  router.installRouter({
    children: [], parentElement: { scrollTo() {} },
    replaceChildren(...children) { this.children = children; },
  }, () => {});

  await router.renderCurrent();
  globalThis.location.hash = '#/character/c1';
  await router.renderCurrent();
  assert.deepEqual(router.backDestination('/character/c1'),
    { path: '/document/d1', title: 'The Salt Accord' },
    'the way back carries the document\'s title, not the word "Document"');
});
