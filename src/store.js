/**
 * Small centralized store: current library summary, navigation,
 * selection, dirty/saving state, and transient UI state. The full
 * SQLite library is never mirrored here; views request view models
 * through IPC and reload after commands.
 */

const state = {
  library: null,          // { name, path, readOnly, libraryId } or null
  route: { name: 'chooser', params: {} },
  counts: {},             // sidebar counts { inboxUnreviewed, draftProductions, ... }
  dirtyGuard: null,       // { message, flush } set by editors with unsaved work
  textScale: 1,
  reducedMotion: false,
};

const listeners = new Set();

export function getState() {
  return state;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function update(patch) {
  Object.assign(state, patch);
  for (const listener of listeners) listener(state);
}

/**
 * Editors register a dirty guard while they hold unsaved changes.
 * Navigation and close flows must call flushDirty() first.
 */
export function setDirtyGuard(guard) {
  state.dirtyGuard = guard;
}

export function clearDirtyGuard(guard) {
  if (state.dirtyGuard === guard) state.dirtyGuard = null;
}

export async function flushDirty() {
  if (state.dirtyGuard?.flush) {
    await state.dirtyGuard.flush();
  }
}
