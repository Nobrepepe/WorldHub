// Narrow, explicitly named preload bridge. The renderer receives only
// this API: a single validated command channel and an event subscription.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('worldhub', {
  /**
   * Invoke a named main-process command. Always resolves to
   * { ok: true, value, notices } or { ok: false, error }.
   */
  invoke(command, payload) {
    return ipcRenderer.invoke('worldhub:invoke', command, payload);
  },

  /** Subscribe to main-process events. Returns an unsubscribe function. */
  onEvent(listener) {
    const wrapped = (_event, name, data) => listener(name, data);
    ipcRenderer.on('worldhub:event', wrapped);
    return () => ipcRenderer.removeListener('worldhub:event', wrapped);
  },

  /** Signal that pre-close flushing finished. */
  confirmFlushed() {
    ipcRenderer.send('worldhub:flushed');
  },
});
