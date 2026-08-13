/**
 * Domain errors carry a stable code and a user-readable message.
 * The IPC layer converts them into { ok: false, error } results.
 */
export class DomainError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export function domainError(code, message, details) {
  return new DomainError(code, message, details);
}

export function isDomainError(err) {
  return err instanceof DomainError;
}
