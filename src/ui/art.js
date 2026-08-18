import { el } from './dom.js';

/**
 * Managed art display. Never a broken-image icon: missing art renders
 * a deliberate masked hatch with a readable caption.
 */
export function artImg(url, { alt = '', className = 'art', noArtClass = 'no-art', caption = 'NO ART', assetId = null, recipeId = null } = {}) {
  if (!url) {
    return el('div', { class: noArtClass, role: 'img', 'aria-label': `${alt || 'Art'} — none yet` }, caption);
  }
  const img = el('img', { class: className, src: url, alt, loading: 'lazy' });
  if (assetId && recipeId) {
    const refresh = (event) => {
      if (event.detail?.assetId === assetId && event.detail?.recipeId === recipeId) {
        img.src = `${event.detail.url}?t=${Date.now()}`;
      }
    };
    document.addEventListener('worldhub:rendition-changed', refresh);
  }
  img.addEventListener('error', () => {
    img.replaceWith(el('div', { class: noArtClass, role: 'img', 'aria-label': `${alt || 'Art'} — missing file` }, caption));
  });
  return img;
}
