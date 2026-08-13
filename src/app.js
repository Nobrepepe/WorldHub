import { el, clear } from './ui/dom.js';
import { getState, subscribe, update, flushDirty } from './store.js';
import { call, callSafe, onEvent } from './ipc.js';
import { installRouter, renderCurrent, currentPath } from './router.js';
import { registerAllViews } from './views/index.js';
import { renderLibraryChooser } from './views/library-chooser.js';
import { closeTopOverlay } from './ui/overlay.js';
import { openSearchPalette } from './views/search.js';
import { showToast } from './ui/toast.js';

const appRoot = document.getElementById('app');

const NAV_GROUPS = [
  {
    label: 'Library',
    links: [
      { path: '/home', label: 'Home' },
      { path: '/search', label: 'Search' },
      { path: '/inbox', label: 'Inbox', countKey: 'inboxUnreviewed', attention: true },
    ],
  },
  {
    label: 'Canon',
    links: [
      { path: '/worlds', label: 'Worlds', countKey: 'worlds' },
      { path: '/characters', label: 'Characters', countKey: 'characters' },
      { path: '/entries', label: 'Entries', countKey: 'entries' },
      { path: '/documents', label: 'Documents', countKey: 'documents' },
      { path: '/assets', label: 'Assets', countKey: 'assets' },
      { path: '/relationships', label: 'Relationships' },
    ],
  },
  {
    label: 'Distribution',
    links: [
      { path: '/contracts', label: 'Contracts' },
      { path: '/productions', label: 'Productions', countKey: 'draftProductions' },
    ],
  },
  {
    label: 'Care',
    links: [
      { path: '/integrity', label: 'Integrity' },
      { path: '/settings', label: 'Settings' },
    ],
  },
];

let mainHost = null;

async function boot() {
  registerAllViews();
  const status = await callSafe('library.status');
  if (status?.open) {
    update({ library: status.library });
    applyLibrarySettings(status.settings);
  }
  renderShell();
  installRouter(mainHost, syncNav);
  if (getState().library) await renderCurrent();

  onEvent((name, data) => {
    if (name === 'counts.changed') {
      update({ counts: { ...getState().counts, ...data } });
      syncNav();
    } else if (name === 'library.closed') {
      update({ library: null });
      renderShell();
    }
  });

  document.addEventListener('keydown', onGlobalKeydown);
  refreshCounts();
}

function renderShell() {
  clear(appRoot);
  const state = getState();
  if (!state.library) {
    appRoot.className = 'app chooser-mode';
    appRoot.append(renderLibraryChooser({
      onOpened: (library, settings) => {
        update({ library });
        applyLibrarySettings(settings);
        renderShell();
        if (!location.hash || location.hash === '#') location.hash = '/home';
        renderCurrent();
        refreshCounts();
      },
    }));
    mainHost = document.createElement('div');
    return;
  }

  appRoot.className = 'app';
  const rail = buildNavRail(state);
  const main = el('main', { class: 'main' });
  const inner = el('div', { class: 'main-inner', id: 'main-inner' });
  main.append(inner);
  mainHost = inner;

  const toggle = el('button', {
    class: 'nav-toggle',
    'aria-label': 'Open navigation',
    onclick: () => rail.classList.toggle('open'),
  }, 'Menu');

  appRoot.append(rail, main, toggle);
  main.addEventListener('click', () => rail.classList.remove('open'));
}

function buildNavRail(state) {
  const rail = el('nav', { class: 'nav-rail', 'aria-label': 'Main navigation' });
  rail.append(
    el('div', { class: 'nav-brand' }, 'World Hub'),
    el('div', { class: 'nav-library' },
      state.library.name,
      state.library.readOnly ? el('span', { class: 'state-bad' }, ' — read-only') : null,
    ),
  );
  for (const group of NAV_GROUPS) {
    const groupEl = el('div', { class: 'nav-group' }, el('span', { class: 'eyebrow' }, group.label));
    for (const link of group.links) {
      groupEl.append(el('a', {
        class: 'nav-link',
        href: `#${link.path}`,
        dataset: { path: link.path, countKey: link.countKey ?? '', attention: link.attention ? '1' : '' },
      }, link.label));
    }
    rail.append(groupEl);
  }
  rail.append(el('div', { class: 'nav-foot' }, 'A living archive.'));
  return rail;
}

function syncNav() {
  const state = getState();
  const path = currentPath();
  for (const link of document.querySelectorAll('.nav-link')) {
    const linkPath = link.dataset.path;
    const active = path === linkPath ||
      (linkPath !== '/home' && sectionOf(path) === linkPath);
    link.classList.toggle('active', active);
    link.setAttribute('aria-current', active ? 'page' : 'false');

    const countKey = link.dataset.countKey;
    let countEl = link.querySelector('.nav-count');
    if (countKey && state.counts[countKey] > 0) {
      if (!countEl) {
        countEl = el('span', { class: 'nav-count' });
        link.append(countEl);
      }
      countEl.textContent = String(state.counts[countKey]);
      link.classList.toggle('attention', link.dataset.attention === '1');
    } else if (countEl) {
      countEl.remove();
    }
  }
}

function sectionOf(path) {
  const map = {
    '/world': '/worlds', '/character': '/characters', '/entry': '/entries',
    '/document': '/documents', '/asset': '/assets', '/contract': '/contracts',
    '/production': '/productions', '/publication': '/productions',
  };
  const first = '/' + (path.split('/').filter(Boolean)[0] ?? '');
  return map[first] ?? first;
}

async function refreshCounts() {
  if (!getState().library) return;
  const counts = await callSafe('library.counts');
  if (counts) {
    update({ counts });
    syncNav();
  }
}

function applyLibrarySettings(settings) {
  if (!settings) return;
  const root = document.documentElement;
  root.style.setProperty('--text-scale', String(settings.textScale ?? 1));
  root.dataset.reducedMotion = settings.reducedMotion ? 'true' : 'false';
  update({ textScale: settings.textScale ?? 1, reducedMotion: !!settings.reducedMotion });
}

function onGlobalKeydown(event) {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (getState().library) openSearchPalette();
  } else if (mod && event.key.toLowerCase() === 's') {
    event.preventDefault();
    flushDirty().catch((err) => showToast(err.message, 'error'));
  } else if (mod && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    contextSensitiveNew();
  } else if (event.key === 'Escape') {
    if (closeTopOverlay()) event.preventDefault();
  }
}

function contextSensitiveNew() {
  if (!getState().library) return;
  // Views listen for this event and open their own "new item" flow.
  const section = sectionOf(currentPath());
  document.dispatchEvent(new CustomEvent('worldhub:new-item', { detail: { section } }));
}

export { refreshCounts, applyLibrarySettings };

boot().catch((err) => {
  console.error(err);
  showToast('World Hub could not start. The details were logged to the console.', 'error');
});
