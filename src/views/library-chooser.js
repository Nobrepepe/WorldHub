import { el, clear, formatDate } from '../ui/dom.js';
import { call, callSafe } from '../ipc.js';
import { showToast } from '../ui/toast.js';
import { openOverlay } from '../ui/overlay.js';

/**
 * Library chooser: create a library, open a library, or reopen a
 * recent one. Shown whenever no library is active; the main shell is
 * never displayed without an open library.
 */
export function renderLibraryChooser({ onOpened }) {
  const host = el('div', { class: 'chooser' });
  const inner = el('div', { class: 'chooser-inner' });
  host.append(inner);

  const render = async () => {
    clear(inner);
    const recents = (await callSafe('library.recents')) ?? [];

    inner.append(
      el('span', { class: 'eyebrow' }, 'World Hub'),
      el('h1', {}, 'Enter the archive.'),
      el('p', { class: 'lede' }, 'A library holds your worlds, characters, documents, and artwork — one self-contained folder you can back up and move.'),
      el('div', { class: 'chooser-actions' },
        el('button', { class: 'btn btn-primary', onclick: () => createFlow() }, 'Create a library →'),
        el('button', { class: 'btn', onclick: () => openFlow() }, 'Open a library →'),
      ),
    );

    if (recents.length > 0) {
      const list = el('ul', { class: 'recent-list' });
      for (const recent of recents) {
        list.append(el('li', {},
          el('button', { class: 'recent-btn', onclick: () => openPath(recent.path) },
            el('div', { class: 'name' }, recent.name ?? 'Library'),
            el('div', { class: 'path' }, recent.path, recent.openedAt ? ` — opened ${formatDate(recent.openedAt)}` : ''),
          ),
        ));
      }
      inner.append(
        el('div', { class: 'section' },
          el('span', { class: 'eyebrow' }, 'Recent libraries'),
          list,
        ),
      );
    }
  };

  const createFlow = async () => {
    const target = await callSafe('library.pickCreateLocation');
    if (!target) return;
    openOverlay((close) => {
      const nameInput = el('input', { type: 'text', value: target.suggestedName ?? 'My Worlds', 'aria-label': 'Library name' });
      const form = el('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          const name = nameInput.value.trim();
          if (!name) return;
          try {
            const opened = await call('library.create', { directory: target.directory, name });
            close();
            onOpened(opened.library, opened.settings);
          } catch (err) {
            showToast(err.message, 'error');
          }
        },
      },
        el('h2', {}, 'Name this library'),
        el('p', { class: 'dim' }, `A new library folder will be created inside ${target.directory}.`),
        el('div', { class: 'field', style: { marginTop: '1rem' } },
          el('span', { class: 'eyebrow' }, 'Library name'),
          nameInput,
        ),
        el('div', { class: 'overlay-actions' },
          el('button', { class: 'btn btn-primary', type: 'submit' }, 'Create the library →'),
          el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
        ),
      );
      return form;
    }, { label: 'Name this library' });
  };

  const openFlow = async () => {
    const picked = await callSafe('library.pickOpen');
    if (!picked) return;
    await openPath(picked.directory);
  };

  const openPath = async (directory) => {
    try {
      const opened = await call('library.open', { directory });
      if (opened.locked) {
        const choice = await lockedFlow(opened.lock);
        if (choice === 'read-only') {
          const reopened = await call('library.open', { directory, readOnly: true });
          onOpened(reopened.library, reopened.settings);
        } else if (choice === 'take-over') {
          const reopened = await call('library.open', { directory, takeOverLock: true });
          onOpened(reopened.library, reopened.settings);
        }
        return;
      }
      onOpened(opened.library, opened.settings);
    } catch (err) {
      showToast(err.message, 'error');
      render();
    }
  };

  const lockedFlow = (lock) => {
    const { promise } = openOverlay((close) => el('div', {},
      el('h2', {}, 'This library is already open'),
      el('p', { class: 'dim' },
        `Another World Hub session ${lock?.sameMachine ? 'on this computer' : 'on another computer'} holds the write lock`,
        lock?.acquiredAt ? ` since ${formatDate(lock.acquiredAt)}.` : '.',
      ),
      el('p', { class: 'quiet', style: { marginTop: '0.5rem' } },
        'You can look around read-only, or go back. Two sessions are never allowed to write at once.'),
      lock?.stale
        ? el('p', { class: 'quiet', style: { marginTop: '0.5rem' } },
          'The lock looks stale — its process is no longer running. You can recover write access if you are sure no other session is using this library.')
        : null,
      el('div', { class: 'overlay-actions' },
        el('button', { class: 'btn btn-primary', onclick: () => close('read-only') }, 'Open read-only →'),
        lock?.stale ? el('button', { class: 'btn', onclick: () => close('take-over') }, 'Recover write access →') : null,
        el('button', { class: 'btn', onclick: () => close('back') }, 'Back to the chooser'),
      ),
    ), { label: 'Library locked' });
    return promise;
  };

  render();
  return host;
}
