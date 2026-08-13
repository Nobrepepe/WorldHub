import { el, clear, debounce } from '../ui/dom.js';
import { call, callSafe } from '../ipc.js';
import { openOverlay } from '../ui/overlay.js';
import { navigate } from '../router.js';
import { selectInput } from '../ui/forms.js';

const GROUP_LABELS = {
  world: 'Worlds',
  character: 'Characters',
  entry: 'Other entries',
  document: 'Documents',
  asset: 'Assets',
  relationship: 'Relationships',
};

/**
 * Universal search: searches as the user types, groups results, shows
 * why each result matched, and opens on Enter.
 */

function buildSearchList({ onOpen }) {
  const listHost = el('div', { role: 'listbox', 'aria-label': 'Search results' });
  let flat = [];
  let active = -1;

  const renderResults = (groups, query) => {
    clear(listHost);
    flat = [];
    active = -1;
    if (!query.trim()) {
      listHost.append(el('p', { class: 'empty-state', style: { padding: '0.5rem 0' } }, 'Type to search names, aliases, profiles, documents, artwork, and relationships.'));
      return;
    }
    if (groups.length === 0) {
      listHost.append(el('p', { class: 'empty-state', style: { padding: '0.5rem 0' } }, `Nothing in the library matches “${query}”.`));
      return;
    }
    for (const group of groups) {
      listHost.append(el('div', { class: 'section', style: { margin: '0.9rem 0 0.2rem' } },
        el('span', { class: 'eyebrow' }, GROUP_LABELS[group.group] ?? group.group)));
      const list = el('ul', { class: 'row-list' });
      for (const item of group.items) {
        const index = flat.length;
        flat.push(item);
        list.append(el('li', {
          class: 'row',
          role: 'option',
          'aria-selected': 'false',
          dataset: { index: String(index) },
          onclick: () => onOpen(item),
        },
          el('div', { class: 'row-main' },
            el('div', { class: 'row-title' }, item.title),
            el('div', { class: 'row-sub' }, matchReason(item)),
          ),
          item.status ? el('div', { class: 'row-side' }, item.status) : null,
        ));
      }
      listHost.append(list);
    }
    if (flat.length > 0) setActive(0);
  };

  const setActive = (index) => {
    active = index;
    for (const node of listHost.querySelectorAll('.row')) {
      const isActive = Number(node.dataset.index) === index;
      node.classList.toggle('selected', isActive);
      node.setAttribute('aria-selected', isActive ? 'true' : 'false');
      if (isActive) node.scrollIntoView({ block: 'nearest' });
    }
  };

  return {
    listHost,
    renderResults,
    onKeydown: (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (flat.length) setActive(Math.min(active + 1, flat.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (flat.length) setActive(Math.max(active - 1, 0)); }
      else if (e.key === 'Enter' && active >= 0 && flat[active]) { e.preventDefault(); onOpen(flat[active]); }
    },
  };
}

function matchReason(item) {
  const facetNames = {
    name: 'matched the name or an alias',
    profile: 'matched the profile',
    document: 'matched the text',
    asset: 'matched the label, files, or tags',
    relationship: 'matched the relationship',
  };
  const why = facetNames[item.facet] ?? 'matched';
  return item.snippet ? `${why}: ${item.snippet}` : why;
}

/** Ctrl/Cmd+K palette. */
export function openSearchPalette() {
  openOverlay((close) => {
    const open = (item) => { close(); navigate(item.href); };
    const { listHost, renderResults, onKeydown } = buildSearchList({ onOpen: open });

    const run = debounce(async (query) => {
      if (!query.trim()) { renderResults([], query); return; }
      const result = await callSafe('search.query', { query });
      renderResults(result?.groups ?? [], query);
    }, 140);

    const input = el('input', {
      type: 'search',
      placeholder: 'Search the whole library…',
      'aria-label': 'Search the library',
      oninput: (e) => run(e.target.value),
      onkeydown: onKeydown,
    });

    renderResults([], '');
    return el('div', {},
      el('div', { class: 'field' }, input),
      el('div', { style: { maxHeight: '55vh', overflowY: 'auto' } }, listHost),
    );
  }, { label: 'Search', wide: true });
}

/** The /search destination with filters. */
export async function renderSearchPage() {
  const [worlds, tags, roles] = await Promise.all([
    call('entity.list', { type: 'world' }),
    call('tag.list'),
    call('asset.roles'),
  ]);
  const filters = { query: '', type: '', worldId: '', tagId: '', role: '', status: '', modifiedDays: '' };

  const host = el('div', {},
    el('header', { class: 'page-head' },
      el('span', { class: 'eyebrow' }, 'Library'),
      el('h1', {}, 'Search'),
    ),
  );

  const open = (item) => navigate(item.href);
  const { listHost, renderResults, onKeydown } = buildSearchList({ onOpen: open });

  const run = debounce(async () => {
    if (!filters.query.trim()) { renderResults([], filters.query); return; }
    const modifiedAfter = filters.modifiedDays
      ? new Date(Date.now() - Number(filters.modifiedDays) * 24 * 60 * 60 * 1000).toISOString()
      : undefined;
    const result = await callSafe('search.query', {
      query: filters.query,
      types: filters.type ? [filters.type] : undefined,
      worldId: filters.worldId || undefined,
      tagId: filters.tagId || undefined,
      role: filters.role || undefined,
      status: filters.status || undefined,
      modifiedAfter,
    });
    renderResults(result?.groups ?? [], filters.query);
  }, 140);

  const input = el('input', {
    type: 'search',
    placeholder: 'Search names, aliases, profiles, documents, artwork…',
    'aria-label': 'Search the library',
    oninput: (e) => { filters.query = e.target.value; run(); },
    onkeydown: onKeydown,
  });

  host.append(
    el('div', { class: 'toolbar' },
      el('div', { class: 'field grow' }, input),
      el('div', { class: 'field' },
        el('span', { class: 'eyebrow' }, 'Kind'),
        selectInput({
          value: '',
          options: [
            { value: '', label: 'Everything' },
            { value: 'world', label: 'Worlds' },
            { value: 'character', label: 'Characters' },
            { value: 'entry', label: 'Other entries' },
            { value: 'document', label: 'Documents' },
            { value: 'asset', label: 'Assets' },
            { value: 'relationship', label: 'Relationships' },
          ],
          onChange: (value) => { filters.type = value; run(); },
          ariaLabel: 'Filter by kind',
        }),
      ),
      el('div', { class: 'field' },
        el('span', { class: 'eyebrow' }, 'World'),
        selectInput({
          value: '',
          options: [{ value: '', label: 'All worlds' }, ...worlds.map((w) => ({ value: w.id, label: w.name }))],
          onChange: (value) => { filters.worldId = value; run(); },
          ariaLabel: 'Filter by world',
        }),
      ),
      el('div', { class: 'field' },
        el('span', { class: 'eyebrow' }, 'Tag'),
        selectInput({
          value: '',
          options: [{ value: '', label: 'Any tag' }, ...tags.map((tag) => ({ value: tag.id, label: tag.name }))],
          onChange: (value) => { filters.tagId = value; run(); },
          ariaLabel: 'Filter by tag',
        }),
      ),
      el('div', { class: 'field' },
        el('span', { class: 'eyebrow' }, 'Asset role'),
        selectInput({
          value: '',
          options: [{ value: '', label: 'Any role' }, ...roles.map((role) => ({ value: role, label: role }))],
          onChange: (value) => { filters.role = value; run(); },
          ariaLabel: 'Filter by asset role',
        }),
      ),
      el('div', { class: 'field' },
        el('span', { class: 'eyebrow' }, 'Lifecycle'),
        selectInput({
          value: '',
          options: [
            { value: '', label: 'Any status' },
            { value: 'draft', label: 'Draft' },
            { value: 'canonical', label: 'Canonical' },
            { value: 'active', label: 'Active (assets)' },
          ],
          onChange: (value) => { filters.status = value; run(); },
          ariaLabel: 'Filter by lifecycle status',
        }),
      ),
      el('div', { class: 'field' },
        el('span', { class: 'eyebrow' }, 'Modified'),
        selectInput({
          value: '',
          options: [
            { value: '', label: 'Any time' },
            { value: '7', label: 'Last 7 days' },
            { value: '30', label: 'Last 30 days' },
            { value: '90', label: 'Last 90 days' },
          ],
          onChange: (value) => { filters.modifiedDays = value; run(); },
          ariaLabel: 'Filter by modified date',
        }),
      ),
    ),
    listHost,
  );
  renderResults([], '');
  queueMicrotask(() => input.focus());
  return host;
}
