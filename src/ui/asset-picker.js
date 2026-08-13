import { el, clear, debounce } from './dom.js';
import { call } from '../ipc.js';
import { openOverlay } from './overlay.js';
import { artImg } from './art.js';

/** Overlay picker for managed assets, filterable by kind/role/entity. */
export function pickAsset({ title = 'Choose an asset', kinds = null, roles = null, entityId = null } = {}) {
  const { promise } = openOverlay((close) => {
    const results = el('ul', { class: 'row-list' });

    const load = async (query) => {
      const assets = await call('asset.list', {
        text: query || undefined,
        kind: kinds && kinds.length === 1 ? kinds[0] : undefined,
        role: roles && roles.length === 1 ? roles[0] : undefined,
        entityId: entityId ?? undefined,
        limit: 40,
      });
      const visible = kinds ? assets.filter((a) => kinds.includes(a.kind)) : assets;
      clear(results);
      if (visible.length === 0) {
        results.append(el('li', { class: 'empty-state', style: { padding: '0.5rem 0' } }, 'No assets match.'));
        return;
      }
      for (const asset of visible) {
        results.append(el('li', { class: 'row', onclick: () => close(asset) },
          asset.kind === 'image'
            ? artImg(asset.thumbUrl, { alt: asset.title, className: 'row-thumb', noArtClass: 'row-thumb no-art' })
            : el('div', { class: 'row-thumb no-art' }, asset.kind.slice(0, 3).toUpperCase()),
          el('div', { class: 'row-main' },
            el('div', { class: 'row-title' }, asset.title),
            el('div', { class: 'row-sub' }, [asset.kind, ...(asset.roles ?? [])].join(' · ')),
          ),
        ));
      }
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
      el('div', { class: 'field' }, input),
      el('div', { style: { maxHeight: '20rem', overflowY: 'auto' } }, results),
      el('div', { class: 'overlay-actions' },
        el('button', { class: 'btn', onclick: () => close(undefined) }, 'Cancel'),
      ),
    );
  }, { label: title, wide: true });
  return promise;
}
