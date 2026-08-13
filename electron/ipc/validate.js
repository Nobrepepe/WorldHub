import { domainError } from '../services/errors.js';

/**
 * Small declarative validators for IPC payloads. Every command validates
 * its payload in the main process before any handler runs.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(field, why) {
  throw domainError('ipc.invalid_argument', `Invalid argument "${field}": ${why}.`, { field });
}

export const v = {
  string({ min = 0, max = 100_000, trim = false } = {}) {
    return (value, field) => {
      if (typeof value !== 'string') fail(field, 'expected text');
      const out = trim ? value.trim() : value;
      if (out.length < min) fail(field, `shorter than ${min} characters`);
      if (out.length > max) fail(field, `longer than ${max} characters`);
      return out;
    };
  },
  uuid() {
    return (value, field) => {
      if (typeof value !== 'string' || !UUID_RE.test(value)) fail(field, 'expected an identifier');
      return value.toLowerCase();
    };
  },
  integer({ min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
    return (value, field) => {
      if (typeof value !== 'number' || !Number.isInteger(value)) fail(field, 'expected a whole number');
      if (value < min || value > max) fail(field, `outside ${min}..${max}`);
      return value;
    };
  },
  number({ min = -Infinity, max = Infinity } = {}) {
    return (value, field) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(field, 'expected a number');
      if (value < min || value > max) fail(field, `outside ${min}..${max}`);
      return value;
    };
  },
  boolean() {
    return (value, field) => {
      if (typeof value !== 'boolean') fail(field, 'expected true or false');
      return value;
    };
  },
  enum(options) {
    return (value, field) => {
      if (!options.includes(value)) fail(field, `expected one of ${options.join(', ')}`);
      return value;
    };
  },
  /** A library-relative path; normalization/containment happens later against the open root. */
  relPath() {
    return (value, field) => {
      if (typeof value !== 'string' || value.length === 0 || value.length > 4096) fail(field, 'expected a path');
      return value;
    };
  },
  /** An absolute native path that must come from a native dialog flow. */
  dialogPath() {
    return (value, field) => {
      if (typeof value !== 'string' || value.length === 0 || value.length > 4096) fail(field, 'expected a path');
      return value;
    };
  },
  array(item, { min = 0, max = 10_000 } = {}) {
    return (value, field) => {
      if (!Array.isArray(value)) fail(field, 'expected a list');
      if (value.length < min || value.length > max) fail(field, `list size outside ${min}..${max}`);
      return value.map((entry, i) => item(entry, `${field}[${i}]`));
    };
  },
  object(shape, { allowExtra = false } = {}) {
    return (value, field = 'payload') => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(field, 'expected an object');
      const out = {};
      for (const [key, check] of Object.entries(shape)) {
        out[key] = check(value[key], `${field}.${key}`);
      }
      if (!allowExtra) {
        for (const key of Object.keys(value)) {
          if (!(key in shape)) fail(`${field}.${key}`, 'unexpected field');
        }
      }
      return out;
    };
  },
  optional(check, fallback = undefined) {
    return (value, field) => {
      if (value === undefined || value === null) return fallback;
      return check(value, field);
    };
  },
  nullable(check) {
    return (value, field) => {
      if (value === undefined || value === null) return null;
      return check(value, field);
    };
  },
  /** Contract-defined JSON values: validated structurally later by ajv. */
  json({ maxBytes = 2_000_000 } = {}) {
    return (value, field) => {
      let text;
      try { text = JSON.stringify(value); } catch { fail(field, 'not serializable'); }
      if (text === undefined) fail(field, 'not serializable');
      if (text.length > maxBytes) fail(field, 'too large');
      return JSON.parse(text);
    };
  },
  none() {
    return (value, field) => {
      if (value !== undefined && value !== null) {
        const keys = typeof value === 'object' ? Object.keys(value) : [value];
        if (keys.length > 0) fail(field, 'expected no payload');
      }
      return undefined;
    };
  },
};
