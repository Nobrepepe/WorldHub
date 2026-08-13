import { marked } from '../vendor/marked.esm.js';
import DOMPurify from '../vendor/purify.es.mjs';
import { navigate } from '../router.js';

/**
 * Safe Markdown preview. Raw HTML is sanitized; scripts and active
 * content never execute. Internal links use stable World Hub
 * identifiers (worldhub://entity/<id>, worldhub://document/<id>) and
 * managed media resolves through the read-only worldhub:// protocol.
 */

marked.setOptions({ gfm: true, breaks: false });

// Allow the worldhub: scheme alongside the safe defaults.
const ALLOWED_URI = /^(?:(?:https?|mailto|worldhub):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

export function renderMarkdown(markdownText) {
  const html = marked.parse(markdownText ?? '');
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    FORBID_TAGS: ['style', 'form', 'input', 'button'],
    ADD_ATTR: [],
  });
  const container = document.createElement('div');
  container.className = 'md-preview';
  container.innerHTML = clean;

  // Internal identifier links navigate inside the app; external http(s)
  // links are opened by the main process in the OS browser.
  container.addEventListener('click', (event) => {
    const anchor = event.target.closest('a[href]');
    if (!anchor) return;
    const href = anchor.getAttribute('href') ?? '';
    if (href.startsWith('worldhub://entity/')) {
      event.preventDefault();
      resolveEntityRoute(href.slice('worldhub://entity/'.length));
    } else if (href.startsWith('worldhub://document/')) {
      event.preventDefault();
      navigate(`/document/${href.slice('worldhub://document/'.length)}`);
    } else if (href.startsWith('http://') || href.startsWith('https://')) {
      // Routed through the window-open handler, which opens the OS
      // browser; in-app navigation stays blocked.
      event.preventDefault();
      window.open(href);
    }
  });
  return container;
}

async function resolveEntityRoute(id) {
  const { call } = await import('../ipc.js');
  try {
    const entity = await call('entity.get', { id });
    if (entity.type === 'world') navigate(`/world/${id}`);
    else if (entity.type === 'character') navigate(`/character/${id}`);
    else navigate(`/entry/${id}`);
  } catch {
    navigate('/search');
  }
}
