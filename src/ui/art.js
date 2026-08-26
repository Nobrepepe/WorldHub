import { el } from './dom.js';
import { callSafe } from '../ipc.js';

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

/**
 * Swap a gallery tile over to its crop-aware rendition once the tile is
 * near the viewport. Until then the list keeps whatever the server
 * already had — the original bytes, or an older rendition.
 */
export function loadRenditionWhenVisible(tile, image, { versionId, recipeId }) {
  if (!versionId || !recipeId || !image || image.tagName !== 'IMG') return;
  const generate = async () => {
    const rendition = await callSafe('rendition.generate', { versionId, recipeId });
    if (rendition?.url && image.isConnected) image.src = rendition.url;
  };
  if (!('IntersectionObserver' in window)) {
    generate();
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    generate();
  }, { rootMargin: '200px' });
  observer.observe(tile);
}
