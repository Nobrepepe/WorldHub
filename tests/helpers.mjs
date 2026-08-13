import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLibrary, closeLibrary } from '../electron/services/library-service.js';

/**
 * Deterministic test helpers using temporary library directories.
 * Tests never touch the user's real data directory.
 */

export function makeTempDir(prefix = 'worldhub-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeAppContext() {
  return {
    library: null,
    mainWindow: null,
    userDataDir: makeTempDir('worldhub-userdata-'),
    events: [],
    sendEvent(name, data) { this.events.push({ name, data }); },
  };
}

/** Create and open a fresh library in a temp dir. Returns { ctx, root, cleanup }. */
export async function makeTestLibrary(name = 'Test Library') {
  const parent = makeTempDir();
  const ctx = makeAppContext();
  const opened = await createLibrary(ctx, parent, name);
  return {
    ctx,
    library: ctx.library,
    opened,
    root: ctx.library.root,
    parent,
    async cleanup() {
      await closeLibrary(ctx);
      fs.rmSync(parent, { recursive: true, force: true });
      fs.rmSync(ctx.userDataDir, { recursive: true, force: true });
    },
  };
}

export function writeFixtureFile(dir, name, content) {
  const abs = path.join(dir, name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/** A tiny valid 4x4 PNG with transparency, generated once with sharp. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFklEQVR4nGP8z8DwnwEJMKEL0F0AAErfAf1Hf1sQAAAAAElFTkSuQmCC',
  'base64',
);

/** A minimal RIFF/WAVE file: 8 samples of silence, 8kHz mono 8-bit. */
export function tinyWav() {
  const dataSize = 8;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(8000, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  buffer.fill(128, 44);
  return buffer;
}
