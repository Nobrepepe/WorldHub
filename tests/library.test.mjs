import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir, makeAppContext, makeTestLibrary } from './helpers.mjs';
import { createLibrary, openLibrary, closeLibrary, readDescriptor, LIBRARY_FOLDERS } from '../electron/services/library-service.js';
import { describeLock, acquireLock, releaseLock } from '../electron/services/lock-service.js';
import { openDatabase } from '../electron/services/database-service.js';
import { applyMigrations, appliedVersions, loadMigrations } from '../electron/services/migration-service.js';
import { normalizeRelative, resolveInside, resolveInsideNoSymlink, toLibraryRelative } from '../electron/services/paths.js';
import { writeFileAtomic } from '../electron/services/atomic-file.js';

test('create, close, and reopen a library with data intact', async () => {
  const parent = makeTempDir();
  const ctx = makeAppContext();
  const created = await createLibrary(ctx, parent, 'Chronicle');
  assert.equal(created.library.name, 'Chronicle');
  const root = ctx.library.root;

  for (const folder of LIBRARY_FOLDERS) {
    assert.ok(fs.existsSync(path.join(root, folder)), `missing folder ${folder}`);
  }
  const descriptor = readDescriptor(root);
  assert.equal(descriptor.format, 'world-hub-library');
  assert.match(descriptor.libraryId, /^[0-9a-f-]{36}$/);

  ctx.library.db.prepare(`
    INSERT INTO entities (id, type, name, slug, created_at, updated_at)
    VALUES ('11111111-1111-4111-8111-111111111111', 'world', 'Aster', 'aster', '2026-01-01', '2026-01-01')
  `).run();
  await closeLibrary(ctx);
  assert.equal(ctx.library, null);

  const reopened = await openLibrary(ctx, root, {});
  const row = ctx.library.db.prepare('SELECT name FROM entities WHERE slug = ?').get('aster');
  assert.equal(row.name, 'Aster');
  assert.equal(reopened.library.libraryId, descriptor.libraryId);
  await closeLibrary(ctx);
  fs.rmSync(parent, { recursive: true, force: true });
});

test('descriptor validation rejects non-libraries and newer protocols', async () => {
  const dir = makeTempDir();
  assert.throws(() => readDescriptor(dir), /not a World Hub library/);

  fs.writeFileSync(path.join(dir, 'world-hub-library.json'), JSON.stringify({ format: 'something-else' }));
  assert.throws(() => readDescriptor(dir), /not a World Hub library/);

  fs.writeFileSync(path.join(dir, 'world-hub-library.json'), JSON.stringify({
    format: 'world-hub-library', protocolVersion: 99, libraryId: 'x', name: 'X',
  }));
  assert.throws(() => readDescriptor(dir), /newer World Hub format/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migrations apply sequentially and are recorded', async () => {
  const dir = makeTempDir();
  const db = openDatabase(path.join(dir, 'test.sqlite3'));
  await applyMigrations(db);
  const migrations = await loadMigrations();
  assert.deepEqual(appliedVersions(db), migrations.map((m) => m.version));
  // Applying again is a no-op.
  const second = await applyMigrations(db);
  assert.deepEqual(second.applied, []);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failing migration rolls back and leaves no partial schema', async () => {
  const dir = makeTempDir();
  const migDir = path.join(dir, 'migrations');
  fs.mkdirSync(migDir);
  fs.writeFileSync(path.join(migDir, '001-ok.mjs'), `
    export const version = 1;
    export const name = 'ok';
    export function up(db) { db.exec('CREATE TABLE alpha (id INTEGER PRIMARY KEY)'); }
  `);
  fs.writeFileSync(path.join(migDir, '002-bad.mjs'), `
    export const version = 2;
    export const name = 'bad';
    export function up(db) {
      db.exec('CREATE TABLE beta (id INTEGER PRIMARY KEY)');
      db.exec('THIS IS NOT SQL');
    }
  `);
  const db = openDatabase(path.join(dir, 'test.sqlite3'));
  await assert.rejects(() => applyMigrations(db, { dir: migDir }), /failed at step 2/);
  assert.deepEqual(appliedVersions(db), [1]);
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r) => r.name);
  assert.ok(tables.includes('alpha'));
  assert.ok(!tables.includes('beta'), 'partial migration table must be rolled back');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('foreign keys are enforced and transactions roll back', async () => {
  const { library, cleanup } = await makeTestLibrary();
  const db = library.db;
  assert.throws(() => {
    db.prepare(`
      INSERT INTO entities (id, type, world_id, name, slug, created_at, updated_at)
      VALUES ('22222222-2222-4222-8222-222222222222', 'character', 'missing-world', 'Nao', 'nao', '2026-01-01', '2026-01-01')
    `).run();
  }, /FOREIGN KEY/);

  const failing = db.transaction(() => {
    db.prepare(`
      INSERT INTO entities (id, type, name, slug, created_at, updated_at)
      VALUES ('33333333-3333-4333-8333-333333333333', 'world', 'Vel', 'vel', '2026-01-01', '2026-01-01')
    `).run();
    throw new Error('boom');
  });
  assert.throws(() => failing(), /boom/);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM entities WHERE slug = 'vel'`).get().n, 0);
  await cleanup();
});

test('a live lock forces read-only or chooser; stale locks are detectable', async () => {
  const { ctx, root, cleanup } = await makeTestLibrary();

  // A second context sees the live lock and cannot open for writing.
  const ctx2 = makeAppContext();
  const attempt = await openLibrary(ctx2, root, {});
  assert.equal(attempt.locked, true);
  assert.equal(attempt.lock.sameMachine, true);
  assert.equal(attempt.lock.stale, false);

  // Read-only opening under a live lock works.
  const readOnly = await openLibrary(ctx2, root, { readOnly: true });
  assert.equal(readOnly.library.readOnly, true);
  await closeLibrary(ctx2);

  await cleanup();

  // A lock from a dead process on this machine reads as stale.
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'world-hub.lock'), JSON.stringify({
    token: 'tok', pid: 999999999, machine: (await import('node:os')).default.hostname(), acquiredAt: '2026-01-01',
  }));
  const lock = describeLock(dir);
  assert.equal(lock.stale, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('acquire and release lock round trip', () => {
  const dir = makeTempDir();
  const lock = acquireLock(dir);
  assert.ok(describeLock(dir, lock.token).ownedBySession);
  releaseLock(dir, lock.token);
  assert.equal(describeLock(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('path normalization handles POSIX- and Windows-shaped paths', () => {
  assert.equal(normalizeRelative('a\\b\\c.md'), 'a/b/c.md');
  assert.equal(normalizeRelative('./a//b/./c.md'), 'a/b/c.md');
  assert.throws(() => normalizeRelative('../escape.md'), /leave its folder/);
  assert.throws(() => normalizeRelative('a/../../b'), /leave its folder/);

  const root = makeTempDir();
  assert.ok(resolveInside(root, 'documents/x.md').startsWith(root));
  assert.throws(() => resolveInside(root, '/etc/passwd'), /absolute path/);
  assert.throws(() => resolveInside(root, 'C:\\Windows\\system32'), /absolute path/);

  const abs = path.join(root, 'assets', 'originals', 'ab', 'cd.png');
  assert.equal(toLibraryRelative(root, abs), 'assets/originals/ab/cd.png');
  assert.throws(() => toLibraryRelative(root, '/somewhere/else'), /outside the library/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('symlink escapes are rejected', (t) => {
  if (process.platform === 'win32') return t.skip('symlinks need privileges on Windows');
  const root = makeTempDir();
  const outside = makeTempDir();
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(outside, path.join(root, 'sneaky'));
  assert.throws(() => resolveInsideNoSymlink(root, 'sneaky/secret.txt'), /outside the library/);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('atomic writes replace content without partial files', () => {
  const dir = makeTempDir();
  const target = path.join(dir, 'nested', 'file.md');
  writeFileAtomic(target, 'one');
  assert.equal(fs.readFileSync(target, 'utf8'), 'one');
  writeFileAtomic(target, 'two');
  assert.equal(fs.readFileSync(target, 'utf8'), 'two');
  const leftovers = fs.readdirSync(path.dirname(target)).filter((n) => n.startsWith('.worldhub-tmp-'));
  assert.deepEqual(leftovers, []);
  fs.rmSync(dir, { recursive: true, force: true });
});
