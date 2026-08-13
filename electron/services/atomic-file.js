import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Atomic file replacement: write a sibling temporary file, flush it,
 * then rename it into place. Temporary siblings use a recognizable
 * prefix so loaders can ignore them and cleanup can find them.
 */

export const TMP_PREFIX = '.worldhub-tmp-';

export function isTemporaryName(name) {
  return name.startsWith(TMP_PREFIX);
}

export function writeFileAtomic(absPath, data) {
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `${TMP_PREFIX}${crypto.randomBytes(6).toString('hex')}-${path.basename(absPath)}`);
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmpPath, absPath);
  } catch (err) {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  syncDirectory(dir);
}

export function writeJsonAtomic(absPath, value) {
  writeFileAtomic(absPath, JSON.stringify(value, null, 2) + '\n');
}

function syncDirectory(dir) {
  // Directory fsync is not supported on Windows; skip it there.
  if (process.platform === 'win32') return;
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* non-fatal */ }
}

/** Remove stale temporary siblings older than maxAgeMs in a directory tree. */
export function cleanStaleTemporaries(rootDir, maxAgeMs = 24 * 60 * 60 * 1000) {
  const removed = [];
  const now = Date.now();
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (isTemporaryName(entry.name)) {
        try {
          const stat = fs.statSync(abs);
          if (now - stat.mtimeMs > maxAgeMs) {
            fs.rmSync(abs, { force: true });
            removed.push(abs);
          }
        } catch { /* skip */ }
      }
    }
  };
  walk(rootDir);
  return removed;
}
