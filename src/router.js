import { getState, update, flushDirty } from './store.js';

/**
 * Hash routing without a framework. Routes are registered as patterns
 * like '/world/:id'. Navigation flushes any unsaved editor first.
 */

const routes = [];

export function registerRoute(pattern, view) {
  const segments = pattern.split('/').filter(Boolean);
  routes.push({ pattern, segments, view });
}

export function matchRoute(hashPath) {
  const parts = hashPath.split('/').filter(Boolean);
  for (const route of routes) {
    if (route.segments.length !== parts.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < parts.length; i++) {
      const seg = route.segments[i];
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
      else if (seg !== parts[i]) { matched = false; break; }
    }
    if (matched) return { route, params };
  }
  return null;
}

export function currentPath() {
  const hash = location.hash.replace(/^#/, '');
  return hash || '/home';
}

export async function navigate(path) {
  await flushDirty();
  if (`#${path}` === location.hash) {
    await renderCurrent();
  } else {
    location.hash = path;
  }
}

let renderHost = null;
let onAfterRender = null;
let listenerInstalled = false;

/**
 * Where the reader walked in from. A detail screen names its own way
 * out, and a named exit has to be honest, so the trail remembers the
 * screen actually left rather than guessing one from the URL.
 */
const trail = [];
const TRAIL_LIMIT = 24;
let currentScreen = null;
let returning = false;

/* The screen a record belongs to, when nothing was walked through to
   reach it — a detail opened from search, or from a cold start. */
const SECTION_SCREENS = {
  world: { path: '/worlds', title: 'Worlds' },
  character: { path: '/characters', title: 'Characters' },
  entry: { path: '/entries', title: 'Entries' },
  document: { path: '/documents', title: 'Documents' },
  asset: { path: '/assets', title: 'Assets' },
  connection: { path: '/connections', title: 'Connections' },
  contract: { path: '/contracts', title: 'Contracts' },
  production: { path: '/productions', title: 'Productions' },
  publication: { path: '/productions', title: 'Productions' },
};

/** The screen a way back leads to, and what that screen is called. */
export function backDestination(path = currentPath()) {
  const previous = trail[trail.length - 1];
  if (previous && previous.path !== path) return previous;
  const first = path.split('/').filter(Boolean)[0] ?? '';
  return SECTION_SCREENS[first] ?? { path: '/home', title: 'Home' };
}

/** Walk back out to that screen, saving anything half-written first. */
export async function goBack(path = currentPath()) {
  returning = true;
  await navigate(backDestination(path).path);
}

function screenTitle(path) {
  const first = path.split('/').filter(Boolean)[0] ?? 'home';
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function onHashChange() {
  renderCurrent().catch(console.error);
}

export function installRouter(host, afterRender) {
  renderHost = host;
  onAfterRender = afterRender;
  if (!listenerInstalled) {
    window.addEventListener('hashchange', onHashChange);
    listenerInstalled = true;
  }
}

export async function renderCurrent() {
  if (!renderHost) return;
  const path = currentPath();
  const match = matchRoute(path);
  const state = getState();

  if (!state.library) {
    update({ route: { name: 'chooser', params: {} } });
    onAfterRender?.();
    return;
  }

  const target = match ?? matchRoute('/home');

  /* Re-rendering the screen you are already on is a refresh, not a
     journey: an editor that commits and redraws must leave the author
     looking at the same place on the page. */
  const scroller = renderHost.parentElement;
  const sameScreen = state.route?.path === path;
  const keptScroll = sameScreen ? scroller?.scrollTop ?? 0 : null;

  /* Walking out of a screen retires it from the trail; walking into a
     new one files the screen being left behind. A redraw is neither. */
  const wasReturning = returning;
  returning = false;
  if (!sameScreen) {
    if (wasReturning) trail.pop();
    else if (currentScreen && currentScreen.path !== path) {
      trail.push(currentScreen);
      if (trail.length > TRAIL_LIMIT) trail.shift();
    }
  }

  update({ route: { name: target.route.pattern, params: target.params, path } });

  const view = document.createElement('div');
  view.className = 'view';
  try {
    const content = await target.route.view(target.params);
    view.append(content);
  } catch (err) {
    console.error(err);
    const fail = document.createElement('p');
    fail.className = 'state-bad';
    fail.textContent = err?.message ?? 'This screen could not be loaded.';
    view.append(fail);
  }
  renderHost.replaceChildren(view);
  if (keptScroll === null) scroller?.scrollTo?.(0, 0);
  else if (scroller) scroller.scrollTop = keptScroll;
  onAfterRender?.();

  // Restore keyboard focus to the main document for accessibility.
  const heading = view.querySelector('h1');
  if (heading) {
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }

  // What this screen is called is the name the next screen's way back
  // will carry. Usually that is the headline; a screen whose title is
  // an editable field instead says so with data-screen-name.
  const named = view.querySelector('[data-screen-name]');
  currentScreen = {
    path,
    title: named?.getAttribute('data-screen-name')?.trim()
      || heading?.textContent?.trim()
      || screenTitle(path),
  };
}
