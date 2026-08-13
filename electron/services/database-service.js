import Database from 'better-sqlite3';
import { domainError } from './errors.js';

export const DATABASE_FILENAME = 'world-hub.sqlite3';

/** Open the library database with the standard pragmas. */
export function openDatabase(dbPath, { readOnly = false, fileMustExist = false } = {}) {
  let db;
  try {
    db = new Database(dbPath, { readonly: readOnly, fileMustExist });
  } catch (err) {
    throw domainError('database.unreadable', 'The library database could not be opened.', { cause: String(err?.message ?? err) });
  }
  if (!readOnly) {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 4000');
  return db;
}

/** Run fn inside a transaction; rolls back on any throw. */
export function inTransaction(db, fn) {
  return db.transaction(fn)();
}

/** Verify basic database health; returns a list of problems. */
export function quickCheck(db) {
  const problems = [];
  try {
    const integrity = db.pragma('quick_check');
    for (const row of integrity) {
      const value = row.quick_check ?? Object.values(row)[0];
      if (value !== 'ok') problems.push(String(value));
    }
  } catch (err) {
    problems.push(`quick_check failed: ${err.message}`);
  }
  try {
    const violations = db.pragma('foreign_key_check');
    for (const row of violations) {
      problems.push(`foreign key violation in ${row.table} rowid ${row.rowid}`);
    }
  } catch (err) {
    problems.push(`foreign_key_check failed: ${err.message}`);
  }
  return problems;
}

export function nowIso() {
  return new Date().toISOString();
}
