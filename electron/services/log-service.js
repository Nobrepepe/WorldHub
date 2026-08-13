import fs from 'node:fs';
import path from 'node:path';

/**
 * Local rolling log. Before a library is open, logs go to the app
 * userData directory; once a library is open, logs go to its logs/
 * folder. Never records document contents.
 */

let logDir = null;
const MAX_LOG_BYTES = 1_000_000;
const KEEP_ROTATED = 3;

export function setLogDirectory(dir) {
  logDir = dir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* non-fatal */ }
}

function write(level, scope, message) {
  const line = `${new Date().toISOString()} [${level}] ${scope}: ${message}\n`;
  if (process.env.WORLDHUB_LOG_STDERR) process.stderr.write(line);
  if (!logDir) return;
  const file = path.join(logDir, 'world-hub.log');
  try {
    rotateIfNeeded(file);
    fs.appendFileSync(file, line);
  } catch { /* logging must never crash the app */ }
}

function rotateIfNeeded(file) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return; }
  if (size < MAX_LOG_BYTES) return;
  for (let i = KEEP_ROTATED - 1; i >= 1; i--) {
    const from = `${file}.${i}`;
    const to = `${file}.${i + 1}`;
    try { fs.renameSync(from, to); } catch { /* skip */ }
  }
  try { fs.renameSync(file, `${file}.1`); } catch { /* skip */ }
}

export function logInfo(scope, message) {
  write('info', scope, message);
}

export function logWarn(scope, message) {
  write('warn', scope, message);
}

export function logError(scope, err) {
  const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  write('error', scope, detail);
}
