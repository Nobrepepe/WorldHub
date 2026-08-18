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
