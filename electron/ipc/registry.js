import { ipcMain } from 'electron';
import { isDomainError } from '../services/errors.js';
import { logError } from '../services/log-service.js';

/**
 * One structured result convention for every IPC command:
 *   { ok: true, value, notices: [] }
 *   { ok: false, error: { code, message, details } }
 *
 * Handlers may return a plain value (wrapped automatically) or
 * { value, notices } to attach notices.
 */

const commands = new Map();

export function register(name, { payload, handler, requiresLibrary = true, requiresWrite = false }) {
  if (commands.has(name)) throw new Error(`Duplicate IPC command: ${name}`);
  commands.set(name, { payload, handler, requiresLibrary, requiresWrite });
}

export function installIpc(appContext) {
  ipcMain.handle('worldhub:invoke', async (event, name, rawPayload) => {
    try {
      if (typeof name !== 'string' || !commands.has(name)) {
        return failure('ipc.unknown_command', 'The application sent an unknown command.', { name: String(name).slice(0, 100) });
      }
      const command = commands.get(name);
      if (command.requiresLibrary && !appContext.library) {
        return failure('library.not_open', 'No library is open.');
      }
      if (command.requiresWrite && appContext.library?.readOnly) {
        return failure('library.read_only', 'The library is open read-only, so this change is not available.');
      }
      const payload = command.payload ? command.payload(rawPayload ?? {}, 'payload') : undefined;
      const result = await command.handler(appContext, payload, event);
      if (result && typeof result === 'object' && '__notices' in result) {
        return { ok: true, value: result.value, notices: result.__notices };
      }
      return { ok: true, value: result ?? null, notices: [] };
    } catch (err) {
      if (isDomainError(err)) {
        return failure(err.code, err.message, err.details);
      }
      logError(`ipc:${name}`, err);
      return failure('internal', 'Something went wrong inside World Hub. The details were logged.', undefined);
    }
  });
}

export function withNotices(value, notices) {
  return { __notices: notices, value };
}

function failure(code, message, details) {
  return { ok: false, error: { code, message, details } };
}

export function listCommands() {
  return [...commands.keys()];
}
