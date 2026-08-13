import { showToast } from './ui/toast.js';

/**
 * Renderer-side command wrapper. call() resolves with the command value
 * and surfaces notices; it throws a CommandError on failure.
 */

export class CommandError extends Error {
  constructor(error) {
    super(error?.message ?? 'Something went wrong.');
    this.name = 'CommandError';
    this.code = error?.code ?? 'unknown';
    this.details = error?.details;
  }
}

export async function call(command, payload) {
  const result = await window.worldhub.invoke(command, payload);
  if (!result || typeof result !== 'object') {
    throw new CommandError({ code: 'ipc.bad_result', message: 'The application returned an unreadable result.' });
  }
  if (!result.ok) throw new CommandError(result.error);
  for (const notice of result.notices ?? []) {
    showToast(notice, 'info');
  }
  return result.value;
}

/**
 * Like call(), but shows the error as a toast and returns null instead
 * of throwing. For fire-and-observe UI actions.
 */
export async function callSafe(command, payload) {
  try {
    return await call(command, payload);
  } catch (err) {
    showToast(err.message, 'error');
    return null;
  }
}

export function onEvent(listener) {
  return window.worldhub.onEvent(listener);
}
