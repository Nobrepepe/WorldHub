import { el } from './dom.js';

/**
 * Managed art display. Never a broken-image icon: missing art renders
 * a deliberate masked hatch with a readable caption.
 */
export function artImg(url, { alt = '', className = 'art', noArtClass = 'no-art', caption = 'NO ART' } = {}) {
  if (!url) {
    return el('div', { class: noArtClass, role: 'img', 'aria-label': `${alt || 'Art'} — none yet` }, caption);
  }
  const img = el('img', { class: className, src: url, alt, loading: 'lazy' });
  img.addEventListener('error', () => {
    img.replaceWith(el('div', { class: noArtClass, role: 'img', 'aria-label': `${alt || 'Art'} — missing file` }, caption));
  });
  return img;
}
