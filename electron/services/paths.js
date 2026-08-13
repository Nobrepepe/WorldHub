import path from 'node:path';
import fs from 'node:fs';
import { domainError } from './errors.js';

/**
 * All stored paths are normalized forward-slash paths relative to the
 * library root. Conversion to native paths happens only here, at the
 * filesystem boundary.
 */

/** Normalize any relative path to forward slashes, collapsing segments. */
export function normalizeRelative(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw domainError('path.invalid', 'A path was empty or not text.');
  }
  const unified = relPath.replaceAll('\\', '/');
  const segments = [];
  for (const part of unified.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      throw domainError('path.traversal', 'A path tried to leave its folder.', { path: relPath });
    }
    segments.push(part);
  }
  if (segments.length === 0) {
    throw domainError('path.invalid', 'A path was empty after normalization.', { path: relPath });
  }
  return segments.join('/');
}

/** True when the string looks absolute on either platform. */
export function isAbsoluteLike(p) {
  return path.posix.isAbsolute(p) || path.win32.isAbsolute(p);
}

/**
 * Resolve a stored library-relative path to a native absolute path,
 * guaranteed to stay inside the library root.
 */
export function resolveInside(rootAbs, relPath) {
  if (isAbsoluteLike(relPath)) {
    throw domainError('path.absolute', 'An absolute path was rejected.', { path: relPath });
  }
  const normalized = normalizeRelative(relPath);
  const abs = path.resolve(rootAbs, ...normalized.split('/'));
  const rootResolved = path.resolve(rootAbs);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    throw domainError('path.escape', 'A path resolved outside the library.', { path: relPath });
  }
  return abs;
}

/**
 * Like resolveInside, but additionally rejects paths whose existing
 * portion contains a symlink that escapes the root.
 */
export function resolveInsideNoSymlink(rootAbs, relPath) {
  const abs = resolveInside(rootAbs, relPath);
  const rootReal = fs.realpathSync(path.resolve(rootAbs));
  // Walk up from the target to the first existing ancestor and realpath it.
  let probe = abs;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw domainError('path.symlink_escape', 'A linked path led outside the library.', { path: relPath });
  }
  return abs;
}

/** Convert a native absolute path inside root to a normalized relative path. */
export function toLibraryRelative(rootAbs, absPath) {
  const rel = path.relative(path.resolve(rootAbs), path.resolve(absPath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw domainError('path.escape', 'A file was outside the library.', { path: absPath });
  }
  return rel.split(path.sep).join('/');
}

/** Make a safe filesystem slug from a display name. */
export function slugify(name, fallback = 'item') {
  const slug = String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || fallback;
}
