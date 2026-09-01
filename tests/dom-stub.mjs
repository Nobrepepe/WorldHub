/**
 * A DOM small enough to read in one sitting.
 *
 * Renderer code is worth testing — a drawer that offers an impossible pair,
 * or a picker that silently drops a tick, is a real bug — but it is not worth
 * a headless browser. This is the stub the picker test grew, lifted out so
 * the next screen that needs one does not grow a third slightly different
 * copy of it.
 */

export class StubNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.parent = null;
    this.className = '';
    this._text = '';
    this.classList = {
      toggle: (name, on) => {
        const names = new Set(this.className.split(' ').filter(Boolean));
        if (on) names.add(name); else names.delete(name);
        this.className = [...names].join(' ');
      },
      contains: (name) => this.className.split(' ').includes(name),
    };
  }

  /* Reading it walks the subtree and writing it replaces the subtree, which
     is what the real property does — and the difference matters: a screen
     that sets textContent over existing children would otherwise appear to
     append to them here and pass a test it should fail. */
  get textContent() { return this._text + this.children.map(renderedText).join(''); }
  set textContent(value) {
    for (const child of this.children) if (child instanceof StubNode) child.parent = null;
    this.children = [];
    this._text = value ?? '';
  }

  get firstChild() { return this.children[0] ?? null; }

  adopt(nodes) {
    for (const node of nodes) if (node instanceof StubNode) node.parent = this;
    return nodes;
  }

  removeChild(child) {
    if (child instanceof StubNode) child.parent = null;
    this.children = this.children.filter((item) => item !== child);
  }

  append(...nodes) { this.children.push(...this.adopt(nodes)); }
  replaceChildren(...nodes) {
    for (const child of this.children) if (child instanceof StubNode) child.parent = null;
    this.children = this.adopt(nodes);
  }

  replaceWith() {}
  remove() { this.parent?.removeChild(this); }

  setAttribute(name, value) {
    this.attributes[name] = value;
    /* data-* attributes and the dataset are two views of one thing. */
    if (name.startsWith('data-')) {
      this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    }
  }

  getAttribute(name) { return this.attributes[name]; }
  focus() {}
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  fire(name, event = {}) {
    this.listeners.get(name)?.({
      stopPropagation() {}, preventDefault() {}, target: this, currentTarget: this, ...event,
    });
  }

  descendants() {
    return this.children.flatMap((child) => (child instanceof StubNode ? [child, ...child.descendants()] : []));
  }

  querySelector(selector) {
    if (selector === 'input[type="checkbox"]') {
      return this.descendants().find((node) => node.tagName === 'INPUT' && node.type === 'checkbox') ?? null;
    }
    const tags = selector.split(',').map((part) => part.trim().split(/[[:]/)[0].toUpperCase());
    return this.descendants().find((node) => tags.includes(node.tagName)) ?? null;
  }

  querySelectorAll(selector) {
    const tags = selector.split(',').map((part) => part.trim().split(/[[:]/)[0].toUpperCase());
    return this.descendants().filter((node) => tags.includes(node.tagName));
  }

  /* Test-side helpers. */
  findAll(predicate) { return this.descendants().filter(predicate); }
  find(predicate) { return this.descendants().find(predicate); }
  findButton(text) {
    return this.descendants().find((node) => node.tagName === 'BUTTON' && node.textContent.includes(text));
  }
  findButtons(text) {
    return this.descendants().filter((node) => node.tagName === 'BUTTON' && node.textContent.includes(text));
  }
  text() { return this.textContent; }
}

export function renderedText(node) {
  if (typeof node === 'string') return node;
  if (!(node instanceof StubNode)) return '';
  return node.textContent;
}

/** Install the stub globally and hand back the overlay host. */
export function installDom() {
  const overlays = new StubNode('div');
  globalThis.Node = StubNode;
  globalThis.document = {
    createElement: (tag) => new StubNode(tag),
    createTextNode: (text) => text,
    createDocumentFragment: () => new StubNode('fragment'),
    getElementById: (id) => (id === 'overlays' ? overlays : null),
    activeElement: null,
    body: new StubNode('body'),
    addEventListener() {},
  };
  return overlays;
}

/**
 * Answer IPC from a table of commands, recording every call.
 *
 * An unlisted command throws rather than returning undefined: a screen that
 * quietly asked for something nobody stubbed would otherwise pass its test
 * while doing nothing.
 */
export function installIpc(handlers) {
  const calls = [];
  globalThis.window = {
    worldhub: {
      invoke: async (command, payload) => {
        calls.push({ command, payload });
        if (!(command in handlers)) throw new Error(`unexpected command ${command}`);
        const handler = handlers[command];
        const value = typeof handler === 'function' ? await handler(payload) : handler;
        return { ok: true, value, notices: [] };
      },
    },
  };
  return calls;
}

/** Let queued microtasks and zero-delay timers run. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
