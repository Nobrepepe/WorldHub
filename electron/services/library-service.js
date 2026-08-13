import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { domainError } from './errors.js';
import { writeJsonAtomic, cleanStaleTemporaries } from './atomic-file.js';
import { openDatabase, quickCheck, DATABASE_FILENAME } from './database-service.js';
import { applyMigrations } from './migration-service.js';
import { acquireLock, releaseLock, describeLock } from './lock-service.js';
import { getAllSettings } from './settings-service.js';
import { recordActivity } from './activity-service.js';
import { setLogDirectory, logInfo, logError } from './log-service.js';
import { LIBRARY_FORMAT, PROTOCOL_VERSION, MIN_COMPATIBLE_APP_VERSION } from './versions.js';
import { rememberLibrary } from './app-settings.js';
import { slugify } from './paths.js';

export const DESCRIPTOR_FILENAME = 'world-hub-library.json';

export const LIBRARY_FOLDERS = [
  'documents/world',
  'documents/character',
  'documents/entry',
  'assets/originals',
  'assets/renditions',
  'inbox/documents',
  'inbox/media',
  'inbox/attachments',
  'productions',
  'backups',
  'logs',
  'tmp',
];

/** Validate and read a library descriptor. */
export function readDescriptor(rootAbs) {
  const descriptorPath = path.join(rootAbs, DESCRIPTOR_FILENAME);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
  } catch {
    throw domainError('library.not_a_library', 'That folder is not a World Hub library — its descriptor is missing or unreadable.');
  }
  if (raw?.format !== LIBRARY_FORMAT) {
    throw domainError('library.wrong_format', 'That folder is not a World Hub library.');
  }
  if (typeof raw.protocolVersion !== 'number' || raw.protocolVersion > PROTOCOL_VERSION) {
    throw domainError('library.newer_protocol', 'This library uses a newer World Hub format than this app understands.');
  }
  if (typeof raw.libraryId !== 'string' || typeof raw.name !== 'string') {
    throw domainError('library.bad_descriptor', 'The library descriptor is incomplete.');
  }
  return raw;
}

/** Create a new library folder inside the chosen parent directory. */
export async function createLibrary(appContext, parentDirectory, name) {
  if (appContext.library) {
    throw domainError('library.already_open', 'Close the current library before creating another.');
  }
  const stat = fs.statSync(parentDirectory, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) {
    throw domainError('library.bad_location', 'The chosen location is not a folder.');
  }
  const folderName = slugify(name, 'world-hub-library');
  const rootAbs = path.join(parentDirectory, folderName);
  if (fs.existsSync(rootAbs) && fs.readdirSync(rootAbs).length > 0) {
    throw domainError('library.folder_exists', `A non-empty folder named "${folderName}" already exists there.`);
  }

  fs.mkdirSync(rootAbs, { recursive: true });
  for (const folder of LIBRARY_FOLDERS) {
    fs.mkdirSync(path.join(rootAbs, folder), { recursive: true });
  }

  const descriptor = {
    format: LIBRARY_FORMAT,
    protocolVersion: PROTOCOL_VERSION,
    libraryId: crypto.randomUUID(),
    name,
    createdAt: new Date().toISOString(),
    minAppVersion: MIN_COMPATIBLE_APP_VERSION,
  };
  writeJsonAtomic(path.join(rootAbs, DESCRIPTOR_FILENAME), descriptor);

  // Initialize the database with the full migration sequence.
  const db = openDatabase(path.join(rootAbs, DATABASE_FILENAME));
  try {
    await applyMigrations(db);
    recordActivity(db, 'library.created', 'library', descriptor.libraryId, name);
  } finally {
    db.close();
  }
  logInfo('library', `Created library "${name}" at ${rootAbs}`);
  const opened = await openLibrary(appContext, rootAbs, {});
  // Every new library ships the demonstration contract.
  const { installExampleContract } = await import('./contract-service.js');
  installExampleContract(appContext.library);
  return opened;
}

/**
 * Open a library. Returns { locked: true, lock } when a live lock
 * prevents writing and neither readOnly nor takeOverLock was chosen.
 */
export async function openLibrary(appContext, rootAbs, { readOnly = false, takeOverLock = false } = {}) {
  if (appContext.library) {
    throw domainError('library.already_open', 'Close the current library before opening another.');
  }
  const descriptor = readDescriptor(rootAbs);

  let lockToken = null;
  if (!readOnly) {
    // Any existing lock — live or stale — stops the open until the
    // user chooses read-only or explicitly confirms recovery.
    const existing = describeLock(rootAbs);
    if (existing && !takeOverLock) {
      return { locked: true, lock: existing };
    }
    const lock = acquireLock(rootAbs, { force: takeOverLock });
    lockToken = lock.token;
  }

  let db;
  try {
    const dbPath = path.join(rootAbs, DATABASE_FILENAME);
    if (!fs.existsSync(dbPath)) {
      throw domainError('library.missing_database', 'The library database file is missing. Restore it from a backup.');
    }
    db = openDatabase(dbPath, { readOnly, fileMustExist: true });

    const problems = quickCheck(db);
    if (problems.length > 0) {
      throw domainError('library.corrupt_database', 'The library database failed its health check. Restore a verified backup from the recovery screen.', { problems: problems.slice(0, 10) });
    }

    if (!readOnly) {
      await applyMigrations(db, {
        onBeforeUpgrade: async (pending) => {
          const backupName = `pre-upgrade-${new Date().toISOString().replaceAll(':', '-')}.sqlite3`;
          const backupPath = path.join(rootAbs, 'backups', backupName);
          fs.mkdirSync(path.dirname(backupPath), { recursive: true });
          await db.backup(backupPath);
          logInfo('library', `Backed up database before upgrade (${pending.length} pending) to ${backupName}`);
        },
      });
      cleanStaleTemporaries(path.join(rootAbs, 'tmp'));
    }
  } catch (err) {
    if (lockToken) releaseLock(rootAbs, lockToken);
    if (db) { try { db.close(); } catch { /* already closed */ } }
    throw err;
  }

  setLogDirectory(path.join(rootAbs, 'logs'));

  const library = {
    root: rootAbs,
    descriptor,
    db,
    readOnly,
    lockToken,
    flushHooks: new Set(),
    mediaResolvers: new Map(),
    async resolveMedia(kind, id) {
      const resolver = library.mediaResolvers.get(kind);
      return resolver ? resolver(library, id) : null;
    },
  };
  const { installMediaResolvers } = await import('./asset-service.js');
  installMediaResolvers(library);

  appContext.library = library;
  rememberLibrary(rootAbs, descriptor.name);
  if (!readOnly) recordActivity(db, 'library.opened', 'library', descriptor.libraryId);
  logInfo('library', `Opened "${descriptor.name}"${readOnly ? ' (read-only)' : ''}`);

  return {
    library: librarySummary(library),
    settings: getAllSettings(db),
  };
}

export function librarySummary(library) {
  return {
    name: library.descriptor.name,
    path: library.root,
    libraryId: library.descriptor.libraryId,
    readOnly: library.readOnly,
    protocolVersion: library.descriptor.protocolVersion,
    createdAt: library.descriptor.createdAt,
  };
}

/** Flush pending editor state, then close database and release lock. */
export async function closeLibrary(appContext) {
  const library = appContext.library;
  if (!library) return;
  appContext.library = null;
  for (const hook of library.flushHooks) {
    try { await hook(); } catch (err) { logError('library.flush', err); }
  }
  try {
    if (!library.readOnly) {
      recordActivity(library.db, 'library.closed', 'library', library.descriptor.libraryId);
      library.db.pragma('wal_checkpoint(TRUNCATE)');
    }
    library.db.close();
  } catch (err) {
    logError('library.close', err);
  }
  if (library.lockToken) releaseLock(library.root, library.lockToken);
  setLogDirectory(path.join(appContext.userDataDir ?? '.', 'logs'));
  logInfo('library', `Closed "${library.descriptor.name}"`);
}

/** Sidebar and home counts. */
export function libraryCounts(library) {
  const db = library.db;
  const one = (sql, ...args) => db.prepare(sql).get(...args)?.n ?? 0;
  return {
    worlds: one(`SELECT COUNT(*) n FROM entities WHERE type = 'world' AND status != 'archived'`),
    characters: one(`SELECT COUNT(*) n FROM entities WHERE type = 'character' AND status != 'archived'`),
    entries: one(`SELECT COUNT(*) n FROM entities WHERE type NOT IN ('world','character') AND status != 'archived'`),
    documents: one(`SELECT COUNT(*) n FROM documents WHERE status != 'archived'`),
    assets: one(`SELECT COUNT(*) n FROM assets WHERE status = 'active'`),
    inboxUnreviewed: one(`SELECT COUNT(*) n FROM inbox_items WHERE status = 'unreviewed'`),
    draftProductions: one(`SELECT COUNT(*) n FROM productions WHERE status = 'draft'`),
    publications: one(`SELECT COUNT(*) n FROM publications`),
  };
}
