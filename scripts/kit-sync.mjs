#!/usr/bin/env node
/**
 * Move the seam's shared material between World Hub and its consumers.
 *
 * Two directions, each with one owner:
 *
 *   contract   app -> Hub    the application's repository is authoritative;
 *                            World Hub imports the file and records its
 *                            checksum, so drift becomes a question anyone
 *                            can ask.
 *   kit        Hub -> app    the reader, the vocabulary, and the conformance
 *                            command travel outward, vendored with a lock so
 *                            a hand-edit is detectable.
 *
 * The script this replaces copied contracts the wrong way and could only
 * reveal drift by overwriting it. `--check` reports and writes nothing.
 *
 *   node scripts/kit-sync.mjs [--check] [slug…]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS = path.join(ROOT, '..');
const KIT = path.join(ROOT, 'kit');

/**
 * Every application that consumes World Hub packages, read from the kit's own
 * registry rather than listed here — a sixth app registers itself with
 * kit-init and needs no edit to this script.
 */
export function consumers() {
  const registry = JSON.parse(fs.readFileSync(path.join(KIT, 'consumers.json'), 'utf8'));
  return Object.fromEntries(registry.consumers.map((entry) => [entry.slug, entry]));
}

/* Snapshotting the registry at module load would hide an app registered
   during this same process — which is exactly what kit-init does. */
export const CONSUMERS = new Proxy({}, {
  get: (_, slug) => consumers()[slug],
  has: (_, slug) => slug in consumers(),
  ownKeys: () => Reflect.ownKeys(consumers()),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
});

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * Files a consumer vendors, relative to the kit.
 *
 * An application takes the reader for its own runtime, plus the shared
 * vocabulary and guide. The conformance command is written in JavaScript and
 * every consumer runs it under node, whatever the application itself is
 * written in — so it travels with all of them.
 */
function plannedFiles(runtime) {
  const walk = (relDir) => {
    const abs = path.join(KIT, relDir);
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) return [];
      return entry.isDirectory() ? walk(`${relDir}/${entry.name}`) : [`${relDir}/${entry.name}`];
    });
  };
  const files = ['kit.json', 'vocabulary.json', 'connection-kinds.json', 'CONSUMER_GUIDE.md']
    .filter((name) => fs.existsSync(path.join(KIT, name)));
  files.push(...walk(runtime === 'py' ? 'py' : 'js'));
  if (runtime === 'py') files.push('js/verify.mjs');
  return [...new Set(files)].sort();
}

export function syncConsumer(slug, { check = false, projectsDir = PROJECTS } = {}) {
  const consumer = consumers()[slug];
  if (!consumer) throw new Error(`unknown consumer "${slug}" — not in kit/consumers.json`);
  const appRoot = path.join(projectsDir, consumer.repo);
  const result = { slug, repo: consumer.repo, present: fs.existsSync(appRoot), kit: [], contract: null };
  if (!result.present) return result;

  /* ---- kit outward ---- */
  const vendor = path.join(appRoot, 'vendor', 'worldhub-kit');
  const lockPath = path.join(vendor, '.kit-lock.json');
  const kitMeta = JSON.parse(fs.readFileSync(path.join(KIT, 'kit.json'), 'utf8'));
  const files = {};
  for (const rel of plannedFiles(consumer.runtime)) {
    const source = path.join(KIT, ...rel.split('/'));
    const target = path.join(vendor, ...rel.split('/'));
    const bytes = fs.readFileSync(source);
    files[rel] = sha256(bytes);
    const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
    if (current === null) result.kit.push({ rel, state: 'added' });
    else if (!current.equals(bytes)) result.kit.push({ rel, state: 'changed' });
    if (!check) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
    }
  }
  const lock = {
    kitVersion: kitMeta.kitVersion,
    protocolVersion: kitMeta.protocolVersion,
    vocabularyVersion: kitMeta.vocabularyVersion,
    files,
  };
  const lockBytes = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`);
  const currentLock = fs.existsSync(lockPath) ? fs.readFileSync(lockPath) : null;
  if (currentLock === null || !currentLock.equals(lockBytes)) {
    result.kit.push({ rel: '.kit-lock.json', state: currentLock === null ? 'added' : 'changed' });
  }
  if (!check) {
    fs.mkdirSync(vendor, { recursive: true });
    fs.writeFileSync(lockPath, lockBytes);
  }

  /* ---- contract inward ----
     World Hub's conformance suite needs each contract without requiring the
     sibling checkout, so a copy lives under tests/fixtures/contracts. It is a
     build artefact: generated here, never hand-edited. Editing it in place is
     what turned the previous copies into a fork wearing the name of a mirror. */
  const contractFile = path.join(appRoot, 'worldhub', 'application-contract.json');
  if (!fs.existsSync(contractFile)) {
    result.contract = { path: contractFile, missing: true };
    return result;
  }
  const bytes = fs.readFileSync(contractFile);
  const fixture = path.join(ROOT, 'tests', 'fixtures', 'contracts', `${slug}.json`);
  const currentFixture = fs.existsSync(fixture) ? fs.readFileSync(fixture) : null;
  result.contract = {
    path: contractFile,
    sha256: sha256(bytes),
    fixtureStale: currentFixture === null || !currentFixture.equals(bytes),
  };
  if (!check && result.contract.fixtureStale) fs.writeFileSync(fixture, bytes);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const only = args.filter((arg) => !arg.startsWith('--'));
  const slugs = only.length ? only : Object.keys(CONSUMERS);

  let changes = 0;
  for (const slug of slugs) {
    if (!CONSUMERS[slug]) {
      console.error(`unknown consumer "${slug}" — known: ${Object.keys(CONSUMERS).join(', ')}`);
      process.exitCode = 2;
      continue;
    }
    const result = syncConsumer(slug, { check });
    if (!result.present) {
      console.log(`${result.repo.padEnd(15)} not checked out here — skipped`);
      continue;
    }
    if (result.kit.length === 0) {
      console.log(`${result.repo.padEnd(15)} kit up to date`);
    } else {
      changes += result.kit.length;
      console.log(`${result.repo.padEnd(15)} kit ${check ? 'would change' : 'updated'}: ${result.kit.length} file(s)`);
      for (const { rel, state } of result.kit) console.log(`${''.padEnd(17)}${state.padEnd(8)} ${rel}`);
    }
    if (result.contract.missing) {
      console.log(`${''.padEnd(17)}contract   MISSING at ${result.contract.path}`);
    } else {
      const state = result.contract.fixtureStale ? (check ? 'would refresh' : 'refreshed') : 'in step';
      console.log(`${''.padEnd(17)}contract   ${result.contract.sha256.slice(0, 12)}  test copy ${state}`);
      if (result.contract.fixtureStale) changes += 1;
    }
  }
  if (check && changes > 0) {
    console.log(`\n${changes} vendored file(s) differ from the kit. Re-run without --check to update them.`);
    process.exitCode = 1;
  } else if (check) {
    console.log('\nEvery checked-out consumer is carrying the current kit.');
  }
}
