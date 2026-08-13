import { el } from './dom.js';

/**
 * Overlay stack with focus trapping and Escape behavior. Each overlay
 * is a full working layer over the archive floor.
 */

const stack = [];

export function openOverlay(buildContent, { wide = false, label = 'Dialog' } = {}) {
  const host = document.getElementById('overlays');
  const previousFocus = document.activeElement;

  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    const index = stack.indexOf(entry);
    if (index >= 0) stack.splice(index, 1);
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    entry.resolve(result);
  };

  const overlay = el('div', {
    class: `overlay${wide ? ' overlay-wide' : ''}`,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': label,
    tabindex: '-1',
  });
  const backdrop = el('div', { class: 'overlay-backdrop', onclick: (e) => { if (e.target === backdrop) close(undefined); } }, overlay);

  const content = buildContent(close);
  overlay.append(content);

  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close(undefined);
    } else if (e.key === 'Tab') {
      trapFocus(overlay, e);
    }
  });

  host.append(backdrop);
  const focusable = overlay.querySelector('input, textarea, select, button, [tabindex="0"]');
  (focusable ?? overlay).focus();

  const entry = { close, resolve: () => {} };
  const promise = new Promise((resolve) => { entry.resolve = resolve; });
  stack.push(entry);
  return { promise, close };
}

export function closeTopOverlay() {
  const top = stack[stack.length - 1];
  if (top) {
    top.close(undefined);
    return true;
  }
  return false;
}

function trapFocus(overlay, event) {
  const focusables = [...overlay.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]')];
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** Confirmation overlay. States the exact effect; resolves true/false. */
export function confirmOverlay({ title, body, confirmLabel, danger = false, guarantee }) {
  const { promise } = openOverlay((close) => {
    return el('div', {},
      el('h2', {}, title),
      typeof body === 'string' ? el('p', { class: 'dim' }, body) : body,
      guarantee ? el('p', { class: 'quiet', style: { marginTop: '0.6rem' } }, guarantee) : null,
      el('div', { class: 'overlay-actions' },
        el('button', { class: danger ? 'btn btn-danger' : 'btn btn-primary', onclick: () => close(true) }, confirmLabel),
        el('button', { class: 'btn', onclick: () => close(false) }, 'Cancel'),
      ),
    );
  }, { label: title });
  return promise.then((result) => result === true);
}
