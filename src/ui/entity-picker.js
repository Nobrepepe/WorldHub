import { el, clear, debounce } from './dom.js';
import { call } from '../ipc.js';
import { openOverlay } from './overlay.js';

/**
 * Overlay picker for canonical entities. Resolves with the chosen
 * entity summary or undefined when dismissed.
 */
export function pickEntity({
  title = 'Choose a record', types = null, worldId = null, excludeIds = [], worldCharacterFilter = false,
} = {}) {
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
        // Filtering happens in this renderer, so the complete list must be
        // loaded or records later in the alphabet can never match a search.
        limit: 2000,
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
      worldCharacterFilter ? worldCharacterFields(close, excludeIds) : null,
      worldCharacterFilter ? el('span', { class: 'eyebrow' }, 'Or search every record') : null,
      el('div', { class: 'field' }, input),
      el('div', { style: { maxHeight: '18rem', overflowY: 'auto' } }, results),
      el('div', { class: 'overlay-actions' },
        el('button', { class: 'btn', onclick: () => close(undefined) }, 'Cancel'),
      ),
    );
  }, { label: title });
  return promise;
}

function worldCharacterFields(close, excludeIds) {
  const worldSelect = el('select', { 'aria-label': 'World' },
    el('option', { value: '' }, 'Choose a world…'));
  const characterSelect = el('select', { 'aria-label': 'Character', disabled: true },
    el('option', { value: '' }, 'Choose a world first'));
  const chooseButton = el('button', {
    class: 'btn btn-primary', type: 'button', disabled: true,
    onclick: () => {
      const option = characterSelect.selectedOptions[0];
      if (option?.value) close({
        id: option.value,
        name: option.textContent,
        type: 'character',
        worldName: worldSelect.selectedOptions[0]?.textContent,
      });
    },
  }, 'Assign to character →');
  let request = 0;

  const loadCharacters = async (selectedWorldId) => {
    const currentRequest = ++request;
    characterSelect.replaceChildren(el('option', { value: '' }, selectedWorldId ? 'Loading characters…' : 'Choose a world first'));
    characterSelect.disabled = true;
    chooseButton.disabled = true;
    if (!selectedWorldId) return;
    const characters = await call('entity.list', { type: 'character', worldId: selectedWorldId, limit: 2000 });
    if (currentRequest !== request) return;
    const available = characters.filter((character) => !excludeIds.includes(character.id));
    characterSelect.replaceChildren(
      el('option', { value: '' }, available.length ? 'Choose a character…' : 'No characters in this world'),
      ...available.map((character) => el('option', { value: character.id }, character.name)),
    );
    characterSelect.disabled = available.length === 0;
  };

  worldSelect.addEventListener('change', () => loadCharacters(worldSelect.value));
  characterSelect.addEventListener('change', () => { chooseButton.disabled = !characterSelect.value; });
  call('entity.list', { type: 'world', limit: 2000 }).then((worlds) => {
    worldSelect.append(...worlds
      .filter((world) => !excludeIds.includes(world.id))
      .map((world) => el('option', { value: world.id }, world.name)));
  });

  return el('div', { class: 'section', style: { margin: '0.8rem 0' } },
    el('span', { class: 'eyebrow' }, 'Assign to a character'),
    el('div', { class: 'form-grid', style: { marginTop: '0.5rem' } },
      el('div', { class: 'field' }, el('span', { class: 'field-hint' }, 'World'), worldSelect),
      el('div', { class: 'field' }, el('span', { class: 'field-hint' }, 'Character'), characterSelect),
    ),
    el('div', { style: { marginTop: '0.6rem' } }, chooseButton),
  );
}
