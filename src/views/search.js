import { el } from '../ui/dom.js';
import { openOverlay } from '../ui/overlay.js';

/** Interim palette; the full universal search arrives with canon. */
export function openSearchPalette() {
  openOverlay((close) => el('div', {},
    el('h2', {}, 'Search'),
    el('p', { class: 'dim' }, 'Search opens once the library holds canon content.'),
    el('div', { class: 'overlay-actions' },
      el('button', { class: 'btn', onclick: () => close() }, 'Close'),
    ),
  ), { label: 'Search' });
}
