import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { domainError } from './errors.js';
import { logWarn } from './log-service.js';

export const LOCK_FILENAME = 'world-hub.lock';

/**
 * Library write lock. A lock file records a random session token,
 * process id, machine identifier, and timestamp. Two writers are never
 * silently allowed.
 */

function machineId() {
  return os.hostname();
}

export function readLock(rootAbs) {
  const lockPath = path.join(rootAbs, LOCK_FILENAME);
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (raw && typeof raw === 'object' && typeof raw.token === 'string') return raw;
  } catch { /* absent or unreadable */ }
  return null;
}

/**
 * Describe an existing lock for the UI. Ownership is judged by session
 * token, never by process id — two sessions are distinct even inside
 * one process.
 */
export function describeLock(rootAbs, ownToken = null) {
  const lock = readLock(rootAbs);
  if (!lock) return null;
  const sameMachine = lock.machine === machineId();
  let processAlive = false;
  if (sameMachine && Number.isInteger(lock.pid)) {
    try {
      process.kill(lock.pid, 0);
      processAlive = true;
    } catch {
      processAlive = false;
    }
  }
  // A lock is provably stale only when we can see that its process is
  // not running on this same machine. A different machine's lock may
  // only be cleared by explicit user recovery.
  const stale = sameMachine && !processAlive;
  return {
    acquiredAt: lock.acquiredAt,
    machine: lock.machine,
    pid: lock.pid,
    sameMachine,
    stale,
    ownedBySession: ownToken !== null && lock.token === ownToken,
  };
}

/**
 * Acquire the write lock. Throws lock.held if a live lock exists.
 * Set force=true only after the user explicitly confirmed recovery.
 */
export function acquireLock(rootAbs, { force = false } = {}) {
  const lockPath = path.join(rootAbs, LOCK_FILENAME);
  const existing = describeLock(rootAbs);
  if (existing) {
    if (!existing.stale && !force) {
      throw domainError('lock.held', 'This library is open in another World Hub session.', existing);
    }
    logWarn('lock', `Clearing ${existing.stale ? 'stale' : 'user-recovered'} lock from ${existing.machine} pid ${existing.pid}`);
    fs.rmSync(lockPath, { force: true });
  }
  const lock = {
    token: crypto.randomUUID(),
    pid: process.pid,
    machine: machineId(),
    acquiredAt: new Date().toISOString(),
  };
  // 'wx' fails if the file reappeared between the check and the write.
  try {
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2), { flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw domainError('lock.held', 'This library was just opened by another session.', describeLock(rootAbs));
    }
    throw err;
  }
  return lock;
}

/** Release the lock if we still own it (token match). */
export function releaseLock(rootAbs, token) {
  const lockPath = path.join(rootAbs, LOCK_FILENAME);
  const current = readLock(rootAbs);
  if (current && current.token === token) {
    try { fs.rmSync(lockPath, { force: true }); } catch { /* best effort */ }
  }
}
