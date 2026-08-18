import { el, clear, debounce } from './dom.js';
import { call } from '../ipc.js';
import { openOverlay } from './overlay.js';
import { artImg } from './art.js';

/** Overlay picker for managed assets, filterable by kind/role/entity. */
export function pickAsset(options = {}) {
  return openAssetPicker({ ...options, multiple: false });
}

/**
 * Same picker in bulk mode: several assets are ticked and returned in the
 * order they were ticked. Resolves with an empty array when dismissed.
 */
export function pickAssets(options = {}) {
  return openAssetPicker({ title: 'Choose assets', ...options, multiple: true });
}

function openAssetPicker({
  title = 'Choose an asset', kinds = null, roles = null, entityId = null,
  multiple = false, max = null, alreadyChosenIds = [],
} = {}) {
  const { promise } = openOverlay((close) => {
    const results = el('ul', { class: 'row-list' });
    /** Ticked assets survive changes to the search box, keyed by id. */
    const chosen = new Map();
    const already = new Set(alreadyChosenIds);
    const limit = multiple ? 200 : 40;
    let shown = [];

    const remaining = () => (max === null ? Infinity : max - chosen.size);
    const countLine = el('p', { class: 'quiet' });
    const addButton = multiple
      ? el('button', { class: 'btn btn-primary', disabled: true, onclick: () => close([...chosen.values()]) }, 'Add')
      : null;
    const selectAllButton = multiple
      ? el('button', {
        class: 'btn', type: 'button',
        onclick: () => {
          // Assets already in the set are skipped here: bulk filling should
          // never quietly duplicate what is chosen, though a single tick
          // still may when a set deliberately repeats one.
          for (const asset of shown) {
            if (remaining() <= 0) break;
            if (!chosen.has(asset.id) && !already.has(asset.id)) chosen.set(asset.id, asset);
          }
          syncTicks();
        },
      }, 'Tick everything shown')
      : null;
    const clearButton = multiple
      ? el('button', { class: 'btn', type: 'button', onclick: () => { chosen.clear(); syncTicks(); } }, 'Clear ticks')
      : null;

    /** Reflect the selection in the rows, the counter and the buttons. */
    const syncTicks = () => {
      for (const row of results.children) {
        const assetId = row.dataset?.assetId;
        if (!assetId) continue;
        const ticked = chosen.has(assetId);
        const box = row.querySelector('input[type="checkbox"]');
        if (box) {
          box.checked = ticked;
          box.disabled = !ticked && remaining() <= 0;
        }
        row.classList.toggle('selected', ticked);
      }
      if (!multiple) return;
      clear(countLine);
      const full = remaining() <= 0;
      countLine.append(
        chosen.size === 0 ? 'Nothing ticked yet.' : `${chosen.size} ticked.`,
        max === null ? '' : ` This set takes ${Math.max(0, max - chosen.size)} more.`,
      );
      countLine.classList.toggle('state-bad', full && max !== null);
      addButton.disabled = chosen.size === 0;
      addButton.textContent = chosen.size === 0 ? 'Add' : `Add ${chosen.size} asset(s) →`;
      selectAllButton.disabled = shown.length === 0 || full;
      clearButton.disabled = chosen.size === 0;
    };

    const load = async (query) => {
      const assets = await call('asset.list', {
        text: query || undefined,
        kind: kinds && kinds.length === 1 ? kinds[0] : undefined,
        role: roles && roles.length === 1 ? roles[0] : undefined,
        entityId: entityId ?? undefined,
        limit,
      });
      const visible = kinds ? assets.filter((a) => kinds.includes(a.kind)) : assets;
      shown = visible;
      clear(results);
      if (visible.length === 0) {
        results.append(el('li', { class: 'empty-state', style: { padding: '0.5rem 0' } }, 'No assets match.'));
        syncTicks();
        return;
      }
      for (const asset of visible) {
        const subtitle = [asset.kind, ...(asset.roles ?? []), already.has(asset.id) ? 'already in this set' : null]
          .filter(Boolean).join(' · ');
        const thumb = asset.kind === 'image'
          ? artImg(asset.thumbUrl, { alt: asset.title, className: 'row-thumb', noArtClass: 'row-thumb no-art' })
          : el('div', { class: 'row-thumb no-art' }, asset.kind.slice(0, 3).toUpperCase());
        const main = el('div', { class: 'row-main' },
          el('div', { class: 'row-title' }, asset.title),
          el('div', { class: 'row-sub' }, subtitle),
        );
        if (!multiple) {
          results.append(el('li', { class: 'row', onclick: () => close(asset) }, thumb, main));
          continue;
        }
        const toggle = () => {
          if (chosen.has(asset.id)) chosen.delete(asset.id);
          else if (remaining() > 0) chosen.set(asset.id, asset);
          syncTicks();
        };
        const box = el('input', {
          type: 'checkbox', 'aria-label': `Choose ${asset.title}`,
          onclick: (e) => { e.stopPropagation(); toggle(); },
        });
        results.append(el('li', {
          class: 'row', dataset: { assetId: asset.id }, tabindex: '0',
          onclick: toggle,
          onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } },
        }, box, thumb, main));
      }
      if (visible.length === limit) {
        results.append(el('li', { class: 'quiet', style: { padding: '0.5rem 0' } },
          `Showing the first ${limit}. Narrow the search to reach the rest.`));
      }
      syncTicks();
    };
    const debounced = debounce(load, 150);
    const input = el('input', {
      type: 'search', placeholder: 'Type a title or filename…', 'aria-label': 'Search assets',
      oninput: (e) => debounced(e.target.value),
    });
    load('');
    return el('div', {},
      el('h2', {}, title),
      roles && roles.length > 0 ? el('p', { class: 'quiet' }, `Preferred roles: ${roles.join(', ')}.`) : null,
      multiple ? el('p', { class: 'section-note' }, 'Tick as many as you need — they are added in the order you tick them.') : null,
      el('div', { class: 'field' }, input),
      multiple ? el('div', { style: { display: 'flex', gap: '1rem', margin: '0 0 0.4rem' } }, selectAllButton, clearButton) : null,
      multiple ? countLine : null,
      // Bulk picking wants as many rows on screen at once as fit above the
      // Add button, which must stay in view while ticking.
      el('div', { style: { maxHeight: multiple ? 'min(46vh, 28rem)' : '20rem', overflowY: 'auto' } }, results),
      el('div', { class: 'overlay-actions' },
        addButton,
        el('button', { class: 'btn', onclick: () => close(multiple ? [] : undefined) }, 'Cancel'),
      ),
    );
  }, { label: title, wide: true });
  return multiple ? promise.then((result) => result ?? []) : promise;
}
