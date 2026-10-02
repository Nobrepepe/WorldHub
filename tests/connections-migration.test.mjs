import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { makeTempDir } from './helpers.mjs';
import { loadMigrations, applyMigrations, ensureMigrationTable } from '../electron/services/migration-service.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Upgrading a library that already holds relationships is the one moment
 * this redesign can lose canon, and losing it would be silent: a label
 * nobody had reread, a duplicate quietly resolved, a description dropped on
 * the way between two tables. So the upgrade is exercised against data that
 * is deliberately inconsistent — the state a real library reaches after a
 * year of free-text typing — rather than against tidy fixtures.
 */

/** A database carrying every migration up to, but not including, connections. */
function libraryBeforeConnections(t) {
  const dir = makeTempDir('worldhub-migration-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new Database(path.join(dir, 'library.db'));
  db.pragma('foreign_keys = ON');
  ensureMigrationTable(db);
  return { db, dir };
}

async function applyThrough(db, maxVersion) {
  const migrations = await loadMigrations(MIGRATIONS_DIR);
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version));
  for (const migration of migrations.filter((m) => m.version <= maxVersion && !applied.has(m.version))) {
    db.transaction(() => {
      migration.up(db);
      record.run(migration.version, migration.name, new Date().toISOString());
    })();
  }
}

const AT = '2026-01-02T03:04:05.000Z';

function seedLegacyLibrary(db) {
  const entity = (type, name, worldId = null) => {
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO entities (id, type, world_id, name, slug, summary, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '', 'canonical', ?, ?)
    `).run(id, type, worldId, name, `${name.toLowerCase().replace(/\W+/g, '-')}-${type}`, AT, AT);
    return id;
  };
  const world = entity('world', 'Emberfall');
  const ids = {
    world,
    nao: entity('character', 'Nao', world),
    bram: entity('character', 'Bram', world),
    wardens: entity('group', 'Kozuki Wardens', world),
    shrine: entity('location', 'North Shrine', world),
  };

  const relationship = (source, target, relType, label, inverseLabel, description, position, status = 'canonical') => {
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO relationships (id, source_id, target_id, rel_type, label, description,
                                 inverse_label, position, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, source, target, relType, label, description, inverseLabel, position, status, AT, AT);
    return id;
  };

  return {
    ids,
    /* the majority wording for "mentor" */
    majorityA: relationship(ids.nao, ids.bram, 'mentor', 'mentor of', 'student of', 'Since the flood year.', 0),
    majorityB: relationship(ids.bram, ids.nao, 'mentor', 'mentor of', 'student of', '', 1),
    /* the same type, typed differently on the day, against a different pair of types */
    dissenting: relationship(ids.nao, ids.wardens, 'mentor', 'teaches', 'taught by', 'An odd one.', 2),
    /* a type nobody ever labelled at all */
    unlabelled: relationship(ids.nao, ids.shrine, 'guards', '', '', 'Nightly.', 0),
    /* the same fact filed twice */
    duplicate: relationship(ids.nao, ids.bram, 'mentor', 'mentor of', 'student of', 'Filed twice.', 3),
    /* and something already put away */
    archived: relationship(ids.nao, ids.shrine, 'exile', 'exiled from', '', 'Long ago.', 0, 'archived'),
  };
}

test('upgrading carries every relationship across without losing text, ids or order', async (t) => {
  const { db } = libraryBeforeConnections(t);
  await applyThrough(db, 11);
  const seeded = seedLegacyLibrary(db);
  const before = db.prepare('SELECT * FROM relationships ORDER BY id').all();

  await applyMigrations(db, { dir: MIGRATIONS_DIR });

  const after = db.prepare('SELECT * FROM connections ORDER BY id').all();
  assert.equal(after.length, before.length, 'every relationship became a connection');

  for (const original of before) {
    const moved = after.find((row) => row.id === original.id);
    assert.ok(moved, `relationship ${original.id} kept its identity`);
    assert.equal(moved.source_id, original.source_id);
    assert.equal(moved.target_id, original.target_id);
    assert.equal(moved.description, original.description, 'the note survives verbatim');
    assert.equal(moved.position, original.position);
    assert.equal(moved.status, original.status);
    assert.equal(moved.created_at, original.created_at);
    assert.equal(moved.updated_at, original.updated_at);
  }

  assert.equal(db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table' AND name = 'relationships'`).get().n,
    0, 'the old table is gone once everything has left it');
});

test('each old type becomes one kind, labelled the way that type was usually labelled', async (t) => {
  const { db } = libraryBeforeConnections(t);
  await applyThrough(db, 11);
  const seeded = seedLegacyLibrary(db);
  await applyMigrations(db, { dir: MIGRATIONS_DIR });

  const legacy = db.prepare('SELECT * FROM connection_kinds WHERE is_legacy = 1 ORDER BY id').all();
  assert.deepEqual(legacy.map((kind) => kind.id), ['legacy_exile', 'legacy_guards', 'legacy_mentor'],
    'one kind per distinct type, and nothing merged on a hunch');

  const mentor = legacy.find((kind) => kind.id === 'legacy_mentor');
  assert.equal(mentor.forward_label, 'mentor of', 'the commonest wording becomes the kind');
  assert.equal(mentor.inverse_label, 'student of');

  const guards = legacy.find((kind) => kind.id === 'legacy_guards');
  assert.equal(guards.forward_label, 'guards', 'a type nobody labelled falls back to the type itself');
  assert.equal(guards.inverse_label, 'guards (of)');

  /* The allowed pairs are what the type was actually used with — never a guess
     about what it might have meant. "mentor" really was used both ways here. */
  const pairs = db.prepare(
    'SELECT source_type, target_type FROM connection_kind_pairs WHERE kind_id = ? ORDER BY target_type')
    .all('legacy_mentor');
  assert.deepEqual(pairs.map((pair) => `${pair.source_type}→${pair.target_type}`),
    ['character→character', 'character→group']);

  /* Built-ins arrive alongside, and a legacy id can never collide with one. */
  const builtins = db.prepare('SELECT COUNT(*) n FROM connection_kinds WHERE is_builtin = 1').get().n;
  assert.ok(builtins > 0);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM connection_kinds WHERE is_builtin = 1 AND is_legacy = 1`).get().n, 0);
  void seeded;
});

test('a record whose own wording disagreed keeps it, and duplicates are kept as duplicates', async (t) => {
  const { db } = libraryBeforeConnections(t);
  await applyThrough(db, 11);
  const seeded = seedLegacyLibrary(db);
  await applyMigrations(db, { dir: MIGRATIONS_DIR });

  const row = (id) => db.prepare('SELECT * FROM connections WHERE id = ?').get(id);

  const dissenting = row(seeded.dissenting);
  assert.equal(dissenting.label_override, 'teaches',
    'wording that disagreed with the majority is preserved rather than corrected');
  assert.equal(dissenting.inverse_label_override, 'taught by');

  const majority = row(seeded.majorityA);
  assert.equal(majority.label_override, '',
    'wording that already agreed with its kind is not restated as an override');
  assert.equal(majority.inverse_label_override, '');

  const duplicates = db.prepare(
    'SELECT COUNT(*) n FROM connections WHERE kind_id = ? AND source_id = ? AND target_id = ?')
    .get('legacy_mentor', seeded.ids.nao, seeded.ids.bram).n;
  assert.equal(duplicates, 2,
    'an upgrade that deleted canon to tidy a duplicate would be worse than the duplicate');
  assert.equal(row(seeded.duplicate).description, 'Filed twice.');
});

test('the search index follows the connections across, and leaves archived ones out', async (t) => {
  const { db } = libraryBeforeConnections(t);
  await applyThrough(db, 11);
  const seeded = seedLegacyLibrary(db);
  await applyMigrations(db, { dir: MIGRATIONS_DIR });

  assert.equal(db.prepare(`SELECT COUNT(*) n FROM search_index WHERE subject_type = 'relationship'`).get().n, 0,
    'nothing is left filed under a subject type nothing writes any more');
  const indexed = db.prepare(`SELECT subject_id, title FROM search_index WHERE subject_type = 'connection'`).all();
  assert.equal(indexed.length, 5, 'every live connection is searchable without a manual rebuild');
  assert.equal(indexed.some((row) => row.subject_id === seeded.archived), false,
    'an archived connection stays out of the index, as it always did');
  assert.ok(indexed.some((row) => row.title === 'Nao — mentor of — Bram'));
});
