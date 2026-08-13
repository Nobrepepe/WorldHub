import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-file.js';

/**
 * Small app-level preferences stored in Electron's userData directory.
 * Only recent library paths and window preferences live here; all
 * creative content lives inside the selected library.
 */

let settingsPath = null;
let cache = null;

const DEFAULTS = {
  recentLibraries: [],
  window: { width: 1440, height: 900, x: undefined, y: undefined, maximized: false },
};

export function initAppSettings(userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true });
  settingsPath = path.join(userDataDir, 'app-settings.json');
  cache = { ...DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (raw && typeof raw === 'object') {
      cache = {
        recentLibraries: Array.isArray(raw.recentLibraries)
          ? raw.recentLibraries.filter((entry) => typeof entry?.path === 'string').slice(0, 8)
          : [],
        window: { ...DEFAULTS.window, ...(raw.window ?? {}) },
      };
    }
  } catch { /* first run or unreadable settings: use defaults */ }
}

function save() {
  if (!settingsPath) return;
  try { writeJsonAtomic(settingsPath, cache); } catch { /* non-fatal */ }
}

export function getRecentLibraries() {
  if (!cache) return [];
  return cache.recentLibraries.filter((entry) => {
    try { return fs.existsSync(path.join(entry.path, 'world-hub-library.json')); } catch { return false; }
  });
}

export function rememberLibrary(libraryPath, displayName) {
  if (!cache) return;
  cache.recentLibraries = [
    { path: libraryPath, name: displayName, openedAt: new Date().toISOString() },
    ...cache.recentLibraries.filter((entry) => entry.path !== libraryPath),
  ].slice(0, 8);
  save();
}

export function forgetLibrary(libraryPath) {
  if (!cache) return;
  cache.recentLibraries = cache.recentLibraries.filter((entry) => entry.path !== libraryPath);
  save();
}

export function getWindowState() {
  return { ...(cache?.window ?? DEFAULTS.window) };
}

export function saveWindowState(state) {
  if (!cache) return;
  cache.window = { ...cache.window, ...state };
  save();
}
