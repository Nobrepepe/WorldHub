import { el, debounce } from './dom.js';
import { setDirtyGuard, clearDirtyGuard } from '../store.js';

/**
 * Shared autosave controller: debounced save with visible Saving…,
 * Saved, and error states, plus a dirty guard so navigation, close,
 * backup, and publication flush unsaved content first.
 */
export function createAutosaver({ save, delayMs = 800 }) {
  const stateEl = el('span', { class: 'save-state', role: 'status' }, '');
  let dirty = false;
  let saving = false;

  const guard = {
    message: 'Unsaved changes',
    flush: async () => { await flush(); },
  };

  const doSave = async () => {
    if (!dirty || saving) return;
    saving = true;
    dirty = false;
    stateEl.textContent = 'Saving…';
    stateEl.className = 'save-state saving';
    try {
      await save();
      if (!dirty) {
        stateEl.textContent = 'Saved';
        stateEl.className = 'save-state saved';
        clearDirtyGuard(guard);
      }
    } catch (err) {
      dirty = true;
      stateEl.textContent = `Not saved — ${err.message}`;
      stateEl.className = 'save-state error';
    } finally {
      saving = false;
      if (dirty) schedule();
    }
  };

  const debounced = debounce(doSave, delayMs);
  const schedule = () => debounced();

  const markDirty = () => {
    dirty = true;
    stateEl.textContent = 'Unsaved changes';
    stateEl.className = 'save-state';
    setDirtyGuard(guard);
    schedule();
  };

  const flush = async () => {
    debounced.cancel();
    await doSave();
  };

  const dispose = () => {
    debounced.cancel();
    clearDirtyGuard(guard);
  };

  return { stateEl, markDirty, flush, dispose, isDirty: () => dirty };
}
