import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { domainError } from './errors.js';
import { openDatabase, quickCheck } from './database-service.js';
import { getSetting, setSetting } from './settings-service.js';
import { recordActivity } from './activity-service.js';
import { logInfo, logError } from './log-service.js';
import { LIBRARY_FORMAT } from './versions.js';

/**
 * Two forms of protection: rotating lightweight safety backups inside
 * the library, and a full portable ZIP archive that can recreate the
 * library on another machine.
 */

const SAFETY_KEEP = 7;

function timestampName() {
  return new Date().toISOString().replaceAll(':', '-').slice(0, 19);
}

/* ---------------- safety backups ---------------- */

/**
 * Lightweight safety backup: consistent SQLite copy, all Markdown,
 * the descriptor, and a manifest of original-asset checksums (large
 * immutable blobs are not duplicated; the manifest reveals missing
 * bytes during integrity checks).
 */
export async function createSafetyBackup(library, reason = 'manual') {
  const name = `safety-${timestampName()}`;
  const dir = path.join(library.root, 'backups', name);
  fs.mkdirSync(dir, { recursive: true });

  await library.db.backup(path.join(dir, 'world-hub.sqlite3'));
  fs.copyFileSync(path.join(library.root, 'world-hub-library.json'), path.join(dir, 'world-hub-library.json'));

  const documentsSource = path.join(library.root, 'documents');
  if (fs.existsSync(documentsSource)) {
    fs.cpSync(documentsSource, path.join(dir, 'documents'), { recursive: true });
  }

  const blobs = library.db.prepare('SELECT hash, path, size FROM blobs ORDER BY hash').all();
  const manifest = {
    format: 'world-hub-safety-backup',
    createdAt: new Date().toISOString(),
    reason,
    libraryId: library.descriptor.libraryId,
    originalBlobs: blobs.map((blob) => ({ hash: blob.hash, path: blob.path, size: blob.size })),
  };
  fs.writeFileSync(path.join(dir, 'backup-manifest.json'), JSON.stringify(manifest, null, 2));

  rotateSafetyBackups(library);
  if (!library.readOnly) {
    recordActivity(library.db, 'backup.safety', 'backup', name, reason);
    setSetting(library.db, 'lastAutoBackupAt', new Date().toISOString());
  }
  logInfo('backup', `Safety backup ${name} (${reason})`);
  return { name, path: dir };
}

function rotateSafetyBackups(library) {
  const backupsDir = path.join(library.root, 'backups');
  const entries = fs.readdirSync(backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('safety-'))
    .map((entry) => entry.name)
    .sort();
  while (entries.length > SAFETY_KEEP) {
    const oldest = entries.shift();
    try {
      fs.rmSync(path.join(backupsDir, oldest), { recursive: true, force: true });
      logInfo('backup', `Rotated out ${oldest}`);
    } catch (err) {
      logError('backup.rotate', err);
    }
  }
}

export function listSafetyBackups(libraryRoot) {
  const backupsDir = path.join(libraryRoot, 'backups');
  let entries = [];
  try {
    entries = fs.readdirSync(backupsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !(entry.name.startsWith('safety-') || entry.name.startsWith('pre-'))) continue;
    const dir = path.join(backupsDir, entry.name);
    const dbPath = path.join(dir, 'world-hub.sqlite3');
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, 'backup-manifest.json'), 'utf8'));
    } catch { /* pre-upgrade db copies have no manifest */ }
    const hasDb = fs.existsSync(dbPath) || fs.existsSync(`${dir}.sqlite3`);
    out.push({
      name: entry.name,
      createdAt: manifest?.createdAt ?? null,
      reason: manifest?.reason ?? 'database copy',
      hasDatabase: hasDb,
    });
  }
  // Loose pre-upgrade db files also count as recovery sources.
  for (const entry of entries) {
    if (entry.isFile() && entry.name.startsWith('pre-upgrade-') && entry.name.endsWith('.sqlite3')) {
      out.push({ name: entry.name, createdAt: null, reason: 'pre-upgrade database copy', hasDatabase: true });
    }
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

/** Run a daily safety backup when enabled and the library changed. */
export async function maybeDailyBackup(library) {
  if (library.readOnly) return null;
  if (!getSetting(library.db, 'autoBackup')) return null;
  const last = getSetting(library.db, 'lastAutoBackupAt');
  const today = new Date().toISOString().slice(0, 10);
  if (last && last.slice(0, 10) === today) return null;
  const lastActivity = library.db.prepare('SELECT at FROM activity_log ORDER BY id DESC LIMIT 1').get()?.at;
  if (last && lastActivity && lastActivity < last) return null; // unchanged since last backup
  return createSafetyBackup(library, 'daily');
}

/* ---------------- full portable archive ---------------- */

const ARCHIVE_MANIFEST = 'world-hub-archive.json';

/** Everything needed to recreate the library on another PC. */
export async function createFullArchive(library, targetAbs, { includePublications = true } = {}) {
  const yazl = await import('yazl');

  /* consistent database copy first */
  const tmpDb = path.join(library.root, 'tmp', `archive-db-${Date.now()}.sqlite3`);
  fs.mkdirSync(path.dirname(tmpDb), { recursive: true });
  await library.db.backup(tmpDb);

  const files = []; // { abs, zipPath }
  const addTree = (absDir, zipPrefix) => {
    if (!fs.existsSync(absDir)) return;
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(absDir, entry.name);
      const zipPath = `${zipPrefix}/${entry.name}`;
      if (entry.isDirectory()) addTree(abs, zipPath);
      else if (entry.isFile()) files.push({ abs, zipPath });
    }
  };

  files.push({ abs: path.join(library.root, 'world-hub-library.json'), zipPath: 'world-hub-library.json' });
  files.push({ abs: tmpDb, zipPath: 'world-hub.sqlite3' });
  addTree(path.join(library.root, 'documents'), 'documents');
  addTree(path.join(library.root, 'assets', 'originals'), 'assets/originals');
  if (includePublications) addTree(path.join(library.root, 'productions'), 'productions');

  const checksums = {};
  for (const file of files) {
    checksums[file.zipPath] = crypto.createHash('sha256').update(fs.readFileSync(file.abs)).digest('hex');
  }
  const manifest = {
    format: 'world-hub-archive',
    version: 1,
    createdAt: new Date().toISOString(),
    libraryId: library.descriptor.libraryId,
    libraryName: library.descriptor.name,
    includesPublications: includePublications,
    checksums,
  };

  await new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const fixedDate = new Date(Date.UTC(2000, 0, 1));
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), ARCHIVE_MANIFEST, { mtime: fixedDate });
    for (const file of files.sort((a, b) => a.zipPath.localeCompare(b.zipPath))) {
      zip.addFile(file.abs, file.zipPath, { mtime: fixedDate, mode: 0o100644 });
    }
    zip.end();
    const out = fs.createWriteStream(targetAbs);
    zip.outputStream.pipe(out);
    out.on('close', resolve);
    out.on('error', reject);
  });

  fs.rmSync(tmpDb, { force: true });
  if (!library.readOnly) recordActivity(library.db, 'backup.full_archive', 'backup', path.basename(targetAbs));
  logInfo('backup', `Full archive at ${targetAbs} (${files.length + 1} entries)`);
  return { path: targetAbs, entries: files.length + 1 };
}

/* ---------------- archive validation and restore ---------------- */

async function readZipEntries(zipPath) {
  const yauzl = await import('yauzl');
  return new Promise((resolve, reject) => {
    const entries = new Map();
    yauzl.default.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (entry.fileName.endsWith('/')) return zipfile.readEntry();
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr);
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => { entries.set(entry.fileName, Buffer.concat(chunks)); zipfile.readEntry(); });
          stream.on('error', reject);
        });
      });
      zipfile.on('end', () => resolve(entries));
      zipfile.on('error', reject);
    });
  });
}

/**
 * Validate structure, format, checksums, and database readability
 * before anything is touched. Returns parsed pieces on success.
 */
export async function validateArchive(zipPath, scratchDir) {
  const entries = await readZipEntries(zipPath);
  const manifestBuffer = entries.get(ARCHIVE_MANIFEST);
  if (!manifestBuffer) throw domainError('archive.not_archive', 'That file is not a World Hub archive.');
  let manifest;
  try {
    manifest = JSON.parse(manifestBuffer.toString('utf8'));
  } catch {
    throw domainError('archive.bad_manifest', 'The archive manifest is unreadable.');
  }
  if (manifest.format !== 'world-hub-archive') {
    throw domainError('archive.not_archive', 'That file is not a World Hub archive.');
  }

  for (const required of ['world-hub-library.json', 'world-hub.sqlite3']) {
    if (!entries.has(required)) throw domainError('archive.incomplete', `The archive is missing ${required}.`);
  }

  for (const [zipRel, expected] of Object.entries(manifest.checksums ?? {})) {
    const buffer = entries.get(zipRel);
    if (!buffer) throw domainError('archive.incomplete', `The archive is missing ${zipRel}.`);
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    if (digest !== expected) throw domainError('archive.corrupt', `Checksum mismatch inside the archive: ${zipRel}.`);
  }

  const descriptor = JSON.parse(entries.get('world-hub-library.json').toString('utf8'));
  if (descriptor.format !== LIBRARY_FORMAT) {
    throw domainError('archive.bad_descriptor', 'The archived library descriptor is not valid.');
  }

  /* database readability */
  fs.mkdirSync(scratchDir, { recursive: true });
  const probeDb = path.join(scratchDir, `probe-${Date.now()}.sqlite3`);
  fs.writeFileSync(probeDb, entries.get('world-hub.sqlite3'));
  try {
    const db = openDatabase(probeDb, { readOnly: true, fileMustExist: true });
    const problems = quickCheck(db);
    db.close();
    if (problems.length > 0) {
      throw domainError('archive.corrupt_database', 'The archived database fails its health check.', { problems: problems.slice(0, 5) });
    }
  } finally {
    fs.rmSync(probeDb, { force: true });
  }

  return { manifest, descriptor, entries };
}

const LIBRARY_SUBFOLDERS = [
  'documents/world', 'documents/character', 'documents/entry',
  'assets/originals', 'assets/renditions',
  'inbox/documents', 'inbox/media', 'inbox/attachments',
  'productions', 'backups', 'logs', 'tmp',
];

/** Extract a validated archive into targetDir as a complete library. */
function extractArchive(entries, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const folder of LIBRARY_SUBFOLDERS) {
    fs.mkdirSync(path.join(targetDir, ...folder.split('/')), { recursive: true });
  }
  for (const [zipRel, buffer] of entries) {
    if (zipRel === ARCHIVE_MANIFEST) continue;
    const abs = path.join(targetDir, ...zipRel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buffer);
  }
}

/** Restore into a brand-new library folder (from the chooser). */
export async function restoreArchiveToNewFolder(zipPath, parentDir, scratchDir) {
  const { descriptor, entries } = await validateArchive(zipPath, scratchDir);
  const baseName = `${(descriptor.name ?? 'library').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-restored`;
  let target = path.join(parentDir, baseName);
  let counter = 2;
  while (fs.existsSync(target)) target = path.join(parentDir, `${baseName}-${counter++}`);
  extractArchive(entries, target);
  /* revalidate the extracted library */
  const db = openDatabase(path.join(target, 'world-hub.sqlite3'), { readOnly: true, fileMustExist: true });
  const problems = quickCheck(db);
  db.close();
  if (problems.length > 0) {
    fs.rmSync(target, { recursive: true, force: true });
    throw domainError('archive.corrupt_database', 'The extracted library failed revalidation; nothing was kept.');
  }
  return { path: target, name: descriptor.name };
}

/**
 * Replace the currently open library with a validated archive.
 * The current library is closed, safety-backed-up, and kept as a
 * renamed sibling folder until the user removes it.
 */
export async function replaceCurrentFromArchive(appContext, zipPath) {
  const library = appContext.library;
  if (!library) throw domainError('library.not_open', 'No library is open.');
  if (library.readOnly) throw domainError('library.read_only', 'The library is open read-only.');
  const root = library.root;
  const scratch = path.join(root, 'tmp');

  /* 1. validate before touching anything */
  const { entries } = await validateArchive(zipPath, scratch);

  /* 2. pre-restore safety backup */
  await createSafetyBackup(library, 'pre-restore');

  /* 3. extract into a temporary sibling */
  const parent = path.dirname(root);
  const stamp = timestampName();
  const staging = path.join(parent, `${path.basename(root)}.restore-${stamp}`);
  extractArchive(entries, staging);

  /* 4. revalidate the extracted library */
  const probe = openDatabase(path.join(staging, 'world-hub.sqlite3'), { readOnly: true, fileMustExist: true });
  const problems = quickCheck(probe);
  probe.close();
  if (problems.length > 0) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw domainError('archive.corrupt_database', 'The extracted library failed revalidation. The current library was not changed.');
  }

  /* 5. swap: close current, rename aside, rename staging into place */
  const { closeLibrary, openLibrary } = await import('./library-service.js');
  await closeLibrary(appContext);
  const retired = path.join(parent, `${path.basename(root)}.replaced-${stamp}`);
  try {
    fs.renameSync(root, retired);
    fs.renameSync(staging, root);
  } catch (err) {
    /* fallback: put things back; never mix half of one library with half of another */
    if (!fs.existsSync(root) && fs.existsSync(retired)) fs.renameSync(retired, root);
    fs.rmSync(staging, { recursive: true, force: true });
    await openLibrary(appContext, root, {});
    throw domainError('archive.swap_failed', `The library could not be swapped (${err.message}). The current library was restored unchanged.`);
  }

  const reopened = await openLibrary(appContext, root, {});
  logInfo('backup', `Restored library from ${path.basename(zipPath)}; previous state kept at ${retired}`);
  return { ...reopened, retiredPath: retired };
}

/* ---------------- corrupt-database recovery ---------------- */

/** Recover a library whose main database is corrupt, from a verified backup. */
export function recoverDatabaseFromBackup(libraryRoot, backupName) {
  const backupsDir = path.join(libraryRoot, 'backups');
  const candidates = [
    path.join(backupsDir, backupName, 'world-hub.sqlite3'),
    path.join(backupsDir, backupName),
  ];
  const source = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!source) throw domainError('recovery.backup_missing', 'That backup has no database file.');

  const probe = openDatabase(source, { readOnly: true, fileMustExist: true });
  const problems = quickCheck(probe);
  probe.close();
  if (problems.length > 0) {
    throw domainError('recovery.backup_corrupt', 'That backup database fails its own health check; choose another.');
  }

  const mainDb = path.join(libraryRoot, 'world-hub.sqlite3');
  if (fs.existsSync(mainDb)) {
    fs.renameSync(mainDb, path.join(backupsDir, `corrupt-${timestampName()}.sqlite3`));
  }
  for (const suffix of ['-wal', '-shm']) {
    try { fs.rmSync(`${mainDb}${suffix}`, { force: true }); } catch { /* best effort */ }
  }
  fs.copyFileSync(source, mainDb);
  return { recoveredFrom: backupName };
}
