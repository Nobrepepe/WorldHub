import { el } from './dom.js';

let container = null;

function ensureContainer() {
  if (!container) {
    container = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(container);
  }
  return container;
}

/** kind: 'info' | 'error' | 'good' */
export function showToast(message, kind = 'info', { timeoutMs = 5000 } = {}) {
  const host = ensureContainer();
  const toast = el('div', { class: `toast${kind === 'error' ? ' toast-error' : kind === 'good' ? ' toast-good' : ''}` }, message);
  host.append(toast);
  const remove = () => toast.remove();
  toast.addEventListener('click', remove);
  setTimeout(remove, kind === 'error' ? Math.max(timeoutMs, 8000) : timeoutMs);
}
