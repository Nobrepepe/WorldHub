import { el, clear, debounce } from './dom.js';
import { call } from '../ipc.js';
import { openOverlay } from './overlay.js';

/**
 * Overlay picker for canonical entities. Resolves with the chosen
 * entity summary or undefined when dismissed.
 */
export function pickEntity({ title = 'Choose a record', types = null, worldId = null, excludeIds = [] } = {}) {
  const { promise } = openOverlay((close) => {
    const results = el('ul', { class: 'row-list', role: 'listbox', 'aria-label': 'Matching records' });
    let items = [];
    let active = -1;

    const renderResults = (list) => {
      items = list.filter((item) => !excludeIds.includes(item.id));
      active = items.length > 0 ? 0 : -1;
      clear(results);
      if (items.length === 0) {
        results.append(el('li', { class: 'empty-state', style: { padding: '0.6rem 0.3rem' } }, 'Nothing matches yet.'));
        return;
      }
      items.forEach((item, index) => {
        results.append(el('li', {
          class: `row${index === active ? ' selected' : ''}`,
          role: 'option',
          'aria-selected': index === active ? 'true' : 'false',
          onclick: () => close(item),
        },
          el('div', { class: 'row-main' },
            el('div', { class: 'row-title' }, item.name),
            el('div', { class: 'row-sub' }, item.type, item.worldName ? ` · ${item.worldName}` : '', item.status === 'archived' ? ' · archived' : ''),
          ),
        ));
      });
    };

    const highlight = () => {
      [...results.children].forEach((node, index) => {
        node.classList.toggle('selected', index === active);
        if (node.getAttribute('role') === 'option') node.setAttribute('aria-selected', index === active ? 'true' : 'false');
      });
      results.children[active]?.scrollIntoView({ block: 'nearest' });
    };

    const load = async (query) => {
      const list = await call('entity.list', {
        types: types ?? undefined,
        worldId: worldId ?? undefined,
        limit: 30,
      });
      const q = query.trim().toLowerCase();
      renderResults(q ? list.filter((item) => item.name.toLowerCase().includes(q) || item.slug.includes(q)) : list);
    };
    const debouncedLoad = debounce(load, 150);

    const input = el('input', {
      type: 'search',
      placeholder: 'Type a name…',
      'aria-label': 'Search records',
      oninput: (e) => debouncedLoad(e.target.value),
      onkeydown: (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); highlight(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); highlight(); }
        else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); close(items[active]); }
      },
    });

    load('');
    return el('div', {},
      el('h2', {}, title),
      el('div', { class: 'field' }, input),
      el('div', { style: { maxHeight: '18rem', overflowY: 'auto' } }, results),
      el('div', { class: 'overlay-actions' },
        el('button', { class: 'btn', onclick: () => close(undefined) }, 'Cancel'),
      ),
    );
  }, { label: title });
  return promise;
}
