import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { domainError } from './errors.js';
import { logInfo } from './log-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

let cachedMigrations = null;

/** Load and sort all migration modules once. */
export async function loadMigrations(dir = MIGRATIONS_DIR) {
  if (cachedMigrations && dir === MIGRATIONS_DIR) return cachedMigrations;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
  const migrations = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(dir, file)).href);
    if (typeof mod.version !== 'number' || typeof mod.up !== 'function') {
      throw domainError('migration.invalid', `Migration file ${file} is malformed.`);
    }
    migrations.push({ version: mod.version, name: mod.name ?? file, up: mod.up, file });
  }
  migrations.sort((a, b) => a.version - b.version);
  for (let i = 0; i < migrations.length; i++) {
    if (migrations[i].version !== i + 1) {
      throw domainError('migration.sequence', 'Migration versions must be sequential starting at 1.');
    }
  }
  if (dir === MIGRATIONS_DIR) cachedMigrations = migrations;
  return migrations;
}

export function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

export function appliedVersions(db) {
  ensureMigrationTable(db);
  return db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
}

export async function pendingMigrations(db, dir) {
  const migrations = await loadMigrations(dir);
  const applied = new Set(appliedVersions(db));
  const maxDefined = migrations.length;
  for (const version of applied) {
    if (version > maxDefined) {
      throw domainError('migration.future', 'This library was created by a newer World Hub and cannot be opened by this version.', { version });
    }
  }
  return migrations.filter((m) => !applied.has(m.version));
}

/**
 * Apply all pending migrations sequentially. Each migration runs in its
 * own transaction; a failure rolls that migration back and stops.
 */
export async function applyMigrations(db, { dir, onBeforeUpgrade } = {}) {
  const pending = await pendingMigrations(db, dir);
  if (pending.length === 0) return { applied: [] };

  const existing = appliedVersions(db).length > 0;
  if (existing && onBeforeUpgrade) {
    // Back up the database before upgrading an existing library.
    await onBeforeUpgrade(pending);
  }

  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  const applied = [];
  for (const migration of pending) {
    const run = db.transaction(() => {
      migration.up(db);
      record.run(migration.version, migration.name, new Date().toISOString());
    });
    try {
      run();
    } catch (err) {
      throw domainError('migration.failed', `Upgrading the library failed at step ${migration.version} (${migration.name}). No partial changes were kept.`, {
        version: migration.version,
        cause: String(err?.message ?? err),
      });
    }
    applied.push(migration.version);
    logInfo('migrations', `Applied ${migration.version} ${migration.name}`);
  }
  return { applied };
}
