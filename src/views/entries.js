import { el, clear } from '../ui/dom.js';
import { call } from '../ipc.js';
import { navigate } from '../router.js';
import { textInput, selectInput } from '../ui/forms.js';
import { getState } from '../store.js';
import { createEntryFlow } from './worlds.js';
import {
  detailHeader, tabbedSections, baseFieldsSection,
  documentsSection, assetsSection, connectionsSection, usageSection, archiveControls,
  connectionSummaryLine,
} from './detail-common.js';

const ENTRY_TYPES = ['location', 'group', 'species', 'object', 'event', 'lore'];

export async function renderEntries() {
  const readOnly = getState().library?.readOnly;
  const worlds = await call('entity.list', { type: 'world' });
  const host = el('div', {},
    el('header', { class: 'page-head' },
      el('span', { class: 'eyebrow' }, 'Canon'),
      el('h1', {}, 'Entries'),
      el('p', { class: 'page-lede' }, 'Locations, groups, species, objects, events, and lore — the rest of what a world is made of.'),
    ),
  );

  const filter = { text: '', type: '', worldId: '' };
  const listHost = el('div', {});

  const render = async () => {
    clear(listHost);
    const entries = await call('entity.list', {
      types: filter.type ? [filter.type] : ENTRY_TYPES,
      worldId: filter.worldId || undefined,
    });
    const q = filter.text.trim().toLowerCase();
    const visible = q ? entries.filter((entry) => entry.name.toLowerCase().includes(q)) : entries;
    if (visible.length === 0) {
      listHost.append(el('p', { class: 'empty-state' },
        entries.length === 0 ? 'No entries yet.' : 'No entries match the current filters.'));
      return;
    }
    const list = el('ul', { class: 'row-list' });
    for (const entry of visible) {
      list.append(el('li', {
        class: 'row', tabindex: '0',
        onclick: () => navigate(`/entry/${entry.id}`),
        onkeydown: (e) => { if (e.key === 'Enter') navigate(`/entry/${entry.id}`); },
      },
        el('div', { class: 'row-main' },
          el('div', { class: 'row-title' }, entry.name),
          el('div', { class: 'row-sub' }, [entry.type, entry.worldName, entry.summary].filter(Boolean).join(' · ')),
        ),
      ));
    }
    listHost.append(list);
  };

  const toolbar = el('div', { class: 'toolbar' },
    el('div', { class: 'field grow' },
      el('span', { class: 'eyebrow' }, 'Filter'),
      textInput({ ariaLabel: 'Filter entries', onInput: (value) => { filter.text = value; render(); } }),
    ),
    el('div', { class: 'field' },
      el('span', { class: 'eyebrow' }, 'Kind'),
      selectInput({
        value: '',
        options: [{ value: '', label: 'All kinds' }, ...ENTRY_TYPES.map((t) => ({ value: t, label: t }))],
        onChange: (value) => { filter.type = value; render(); },
        ariaLabel: 'Filter by kind',
      }),
    ),
    el('div', { class: 'field' },
      el('span', { class: 'eyebrow' }, 'World'),
      selectInput({
        value: '',
        options: [{ value: '', label: 'All worlds' }, ...worlds.map((w) => ({ value: w.id, label: w.name }))],
        onChange: (value) => { filter.worldId = value; render(); },
        ariaLabel: 'Filter by world',
      }),
    ),
    !readOnly ? el('button', {
      class: 'btn btn-primary',
      onclick: () => createEntryFlow(filter.worldId || null, (created) => navigate(`/entry/${created.id}`)),
    }, 'Create an entry →') : null,
  );

  document.addEventListener('worldhub:new-item', (e) => {
    if (e.detail?.section === '/entries' && !readOnly) {
      createEntryFlow(filter.worldId || null, (created) => navigate(`/entry/${created.id}`));
    }
  }, { once: true });

  host.append(toolbar, listHost);
  await render();
  return host;
}

export async function renderEntryDetail({ id }) {
  let entity = await call('entity.get', { id });
  const host = el('div', {});
  const eyebrow = [entity.type, entity.world?.name].filter(Boolean).join(' · ');
  host.append(detailHeader(entity, { eyebrow }));

  const overview = async () => {
    const container = el('div', { style: { maxWidth: '44rem' } });
    const { host: baseHost } = baseFieldsSection(entity, { onSaved: (updated) => { entity = updated; } });
    /* An entry is mostly what it is connected to, so what it is connected to
       is said at the top — counted from the connections themselves rather
       than written into the summary, where it would go stale unnoticed. */
    const summary = await connectionSummaryLine(entity);
    if (summary) container.append(summary);
    container.append(
      baseHost,
      archiveControls(entity, { onChanged: () => navigate(`/entry/${entity.id}`) }),
    );
    return container;
  };

  host.append(tabbedSections([
    { label: 'Overview', render: overview },
    { label: 'Documents', render: () => documentsSection(entity) },
    { label: 'Assets', render: () => assetsSection(entity) },
    { label: 'Connections', render: () => connectionsSection(entity) },
    { label: 'Usage', render: () => usageSection(entity) },
  ]));
  return host;
}
