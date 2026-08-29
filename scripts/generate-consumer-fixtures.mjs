#!/usr/bin/env node
/**
 * Generates the shared consumer conformance fixtures for all four
 * consumer applications:
 *
 *   valid-v1.zip            baseline publication
 *   valid-v2.zip            an update of the same production
 *   corrupt-checksum.zip    one listed file's bytes were altered
 *   unlisted-file.zip       contains a file checksums.json does not list
 *   missing-asset.zip       an indexed asset file was removed (checksums updated)
 *   wrong-apptype.zip       manifest applicationType is another app's
 *   unsupported-protocol.zip manifest protocolVersion is 99
 *   traversal.zip           ZIP with ../ and absolute-path entries
 *   legacy-protocol-1.zip   a Protocol 1 package using retired recipe names
 *   expected.json           ids and facts consumer tests assert against
 *
 * Fixtures are synthetic and deterministic in content (never the
 * user's creative assets). Output goes to each consumer repository's
 * tests/fixtures/worldhub/ directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
import yazl from 'yazl';
import yauzl from 'yauzl';

import { createLibrary, closeLibrary } from '../electron/services/library-service.js';
import { updateEntity } from '../electron/services/entity-service.js';
import { addAssetVersion } from '../electron/services/asset-service.js';
import { setAssetSetItems, setProductionStatus } from '../electron/services/production-service.js';
import { publishProduction, exportPublicationZip } from '../electron/services/publication-service.js';
import { CONSUMER_BUILDERS, fixturePng, loadConsumerContract } from '../tests/fixtures/consumer-fixtures.mjs';
import { buildAutoProduction } from './auto-production.mjs';
import { vocabularyVersion, renamedFrom } from '../electron/services/vocabulary.js';
import { PROTOCOL_VERSION } from '../electron/services/versions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS = path.join(__dirname, '..', '..');
/* Read from the kit's registry so registering a sixth consumer needs no edit
   here — the previous hard-coded maps were four more places to forget. */
const REGISTRY = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'kit', 'consumers.json'), 'utf8')).consumers;
const TARGETS = Object.fromEntries(REGISTRY.map((entry) => (
  [entry.slug, path.join(PROJECTS, entry.repo, 'tests', 'fixtures', 'worldhub')])));
/** Another registered app's type, for the "package built for someone else" fixture. */
const WRONG_APPTYPE = Object.fromEntries(REGISTRY.map((entry, index) => (
  [entry.slug, REGISTRY[(index + 1) % REGISTRY.length].appType])));

/* ---------------- zip helpers ---------------- */

function readZip(zipPath) {
  return new Promise((resolve, reject) => {
    const entries = new Map();
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
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

function writeZip(zipPath, entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const fixed = new Date(Date.UTC(2000, 0, 1));
    for (const [name, buffer] of [...entries.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      zip.addBuffer(buffer, name, { mtime: fixed, mode: 0o100644 });
    }
    zip.end();
    const out = fs.createWriteStream(zipPath);
    zip.outputStream.pipe(out);
    out.on('close', resolve);
    out.on('error', reject);
    zip.outputStream.on('error', reject);
  });
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/** Rewrite manifest/checksums consistently so only the intended flaw fires. */
function withManifest(entries, mutate) {
  const out = new Map(entries);
  const manifest = JSON.parse(out.get('manifest.json').toString('utf8'));
  mutate(manifest);
  const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  out.set('manifest.json', manifestBuffer);
  const checksums = JSON.parse(out.get('checksums.json').toString('utf8'));
  checksums['manifest.json'] = sha256(manifestBuffer);
  out.set('checksums.json', Buffer.from(`${JSON.stringify(checksums, null, 2)}\n`));
  return out;
}

/* ---------------- adversarial variants ---------------- */

/**
 * A package shaped the way Protocol 1 wrote them, with one recipe published
 * under the name it has since been renamed from.
 *
 * Every consumer keeps one so backward compatibility has a permanent subject.
 * Before this existed, the only protocol 1 sample each app owned was its own
 * `valid-v1.zip` — which stopped being one the moment its fixtures were
 * regenerated, quietly taking the coverage with it.
 */
async function writeLegacyProtocol1(targetDir, validEntries) {
  const out = new Map(validEntries);
  const changed = new Set();
  const rewriteJson = (name, mutate) => {
    const value = JSON.parse(out.get(name).toString('utf8'));
    const next = mutate(value) ?? value;
    out.set(name, Buffer.from(`${JSON.stringify(next, null, 2)}\n`));
    changed.add(name);
  };

  rewriteJson('manifest.json', (manifest) => {
    manifest.protocolVersion = 1;
    manifest.contract = { id: manifest.contract.id, version: manifest.contract.revision };
    delete manifest.vocabularyVersion;
    delete manifest.renamedFrom;
  });
  rewriteJson('production/contract.json', (contract) => {
    contract.contractVersion = contract.contractFormatVersion;
    delete contract.contractFormatVersion;
    contract.supportedProtocolVersions = [1];
  });
  rewriteJson('catalog/characters.json', (characters) => {
    for (const character of characters) {
      character.fullBodyAssetId = character.tileAssetId ?? null;
      delete character.tileAssetId;
    }
  });
  /* publish whatever recipes have former names under those names */
  const formerName = new Map();
  for (const [current, names] of Object.entries(renamedFrom().recipes ?? {})) {
    if (names.length > 0) formerName.set(current, names[0]);
  }
  rewriteJson('assets/index.json', (index) => {
    for (const entry of index) {
      const former = formerName.get(entry.recipeId);
      if (former) entry.recipeId = former;
    }
  });

  const checksums = JSON.parse(out.get('checksums.json').toString('utf8'));
  for (const name of changed) checksums[name] = sha256(out.get(name));
  out.set('checksums.json', Buffer.from(`${JSON.stringify(checksums, null, 2)}\n`));
  await writeZip(path.join(targetDir, 'legacy-protocol-1.zip'), out);
}

async function writeAdversarial(targetDir, appSlug, validEntries) {
  /* corrupt checksum: flip bytes in the first packaged asset file */
  {
    const out = new Map(validEntries);
    const victim = [...out.keys()].find((name) => name.startsWith('assets/files/'));
    const bytes = Buffer.from(out.get(victim));
    bytes[bytes.length - 5] ^= 0xff;
    out.set(victim, bytes);
    await writeZip(path.join(targetDir, 'corrupt-checksum.zip'), out);
  }
  /* unlisted file */
  {
    const out = new Map(validEntries);
    out.set('assets/files/sneaky-extra.bin', Buffer.from('not listed anywhere'));
    await writeZip(path.join(targetDir, 'unlisted-file.zip'), out);
  }
  /* missing referenced asset: drop an indexed file and update checksums so only the reference breaks */
  {
    const out = new Map(validEntries);
    const index = JSON.parse(out.get('assets/index.json').toString('utf8'));
    const victim = index[0].path;
    out.delete(victim);
    const checksums = JSON.parse(out.get('checksums.json').toString('utf8'));
    delete checksums[victim];
    out.set('checksums.json', Buffer.from(`${JSON.stringify(checksums, null, 2)}\n`));
    await writeZip(path.join(targetDir, 'missing-asset.zip'), out);
  }
  /* wrong application type */
  await writeZip(path.join(targetDir, 'wrong-apptype.zip'),
    withManifest(validEntries, (manifest) => { manifest.applicationType = WRONG_APPTYPE[appSlug]; }));
  /* unsupported protocol version */
  await writeZip(path.join(targetDir, 'unsupported-protocol.zip'),
    withManifest(validEntries, (manifest) => { manifest.protocolVersion = 99; }));
  /* path traversal + absolute entries — hand-rolled, since honest zip
     writers (rightly) refuse to create these */
  {
    const evil = new Map([
      ['manifest.json', validEntries.get('manifest.json')],
      ['../escaped.txt', Buffer.from('escaped')],
      ['/absolute.txt', Buffer.from('absolute')],
    ]);
    fs.writeFileSync(path.join(targetDir, 'traversal.zip'), rawStoredZip(evil));
  }
}

/** Minimal raw ZIP writer (stored entries) that permits hostile names. */
function rawStoredZip(entries) {
  const zlib = require('node:zlib');
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuffer, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuffer.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([dir, nameBuffer]));
    offset += local.length + nameBuffer.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuffer, end]);
}

/* ---------------- per-app updates for v2 ---------------- */

async function mutateForV2(slug, library, built) {
  const { canon, production, perCharacter } = built;
  /* a rename that must flow through by reference */
  updateEntity(library, canon.heroes[0].id, { name: `${canon.heroes[0].name} the Rekindled` });
  /* replace one artwork with a new immutable version */
  const target = slug === 'taskstamps' ? perCharacter[0].stamps[0]
    : slug === 'stickeralbum' ? perCharacter[0].stickers[0]
    : slug === 'chatbot' ? perCharacter[0].tile
    : slug === 'herocollector' ? perCharacter[0].portrait
    : null;
  /* A contract-derived production names no particular artwork, so there is
     nothing meaningful to replace; the rename alone makes it a real update. */
  if (target) await addAssetVersion(library, target.id, {
    buffer: await fixturePng(424242),
    filename: 'updated-art.png',
    note: 'v2 art',
  });
  /* retire one character from the selection when there are two */
  if (perCharacter.length > 1) {
    const slot = slug === 'taskstamps' ? 'stamp_characters'
      : slug === 'stickeralbum' ? 'album_characters'
      : slug === 'chatbot' ? 'cast'
      : slug === 'herocollector' ? 'hc_characters' : null;
    if (slot) {
      const { setSelection } = await import('../electron/services/production-service.js');
      setSelection(library, production.id, slot, [perCharacter[0].hero.id]);
    }
    if (slug === 'chatbot') {
      /* keep required per-entity values consistent — nothing to remove; values ride the selection */
    }
  }
  void setAssetSetItems;
}

/* ---------------- main ---------------- */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'worldhub-fixtures-'));
// Optional slugs on the command line regenerate only those consumers'
// fixtures; with none given, all four are rebuilt.
const only = process.argv.slice(2);
try {
  for (const { slug } of REGISTRY) {
    if (only.length && !only.includes(slug)) continue;
    /* An established app has a builder asserting facts only it knows. A newly
       registered one has none, and derives its production from its contract. */
    const builder = CONSUMER_BUILDERS[slug]
      ?? ((library) => buildAutoProduction(library, loadConsumerContract(slug)));
    const targetDir = TARGETS[slug];
    fs.mkdirSync(targetDir, { recursive: true });
    const ctx = { library: null, userDataDir: path.join(scratch, `ud-${slug}`), sendEvent() {} };
    await createLibrary(ctx, scratch, `Fixture ${slug}`);
    const library = ctx.library;

    const built = await builder(library);
    const v1Zip = path.join(targetDir, 'valid-v1.zip');
    await exportPublicationZip(library, built.publication.id, v1Zip);

    await mutateForV2(slug, library, built);
    setProductionStatus(library, built.production.id, 'ready');
    const v2 = await publishProduction(library, built.production.id);
    await exportPublicationZip(library, v2.id, path.join(targetDir, 'valid-v2.zip'));

    const validEntries = await readZip(v1Zip);
    await writeAdversarial(targetDir, slug, validEntries);
    await writeLegacyProtocol1(targetDir, validEntries);

    const expected = {
      appType: built.contract.contract.appType,
      contractId: built.contract.contractId,
      contractRevision: built.contract.version,
      libraryId: library.descriptor.libraryId,
      productionId: built.production.id,
      publicationV1: built.publication.id,
      publicationV2: v2.id,
      worldId: built.canon.world.id,
      characterIds: built.perCharacter.map((entry) => entry.hero.id),
      renamedCharacterId: built.canon.heroes[0].id,
      retiredCharacterIds: built.perCharacter.slice(1).map((entry) => entry.hero.id),
    };
    fs.writeFileSync(path.join(targetDir, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`);

    /* The stamp that makes a stale fixture fail instead of quietly certifying
       a vocabulary that has moved. `verify` compares it against the kit; three
       suites once ran green for eleven days against names World Hub had
       already deleted, because nothing recorded when they were built. */
    const generated = {
      generatedAt: new Date().toISOString(),
      vocabularyVersion: vocabularyVersion(),
      protocolVersion: PROTOCOL_VERSION,
      note: 'Generated by World Hub. Do not hand-edit; regenerate with scripts/generate-consumer-fixtures.mjs.',
    };
    fs.writeFileSync(path.join(targetDir, 'generated.json'), `${JSON.stringify(generated, null, 2)}\n`);

    await closeLibrary(ctx);
    const size = fs.readdirSync(targetDir).reduce((sum, file) => sum + fs.statSync(path.join(targetDir, file)).size, 0);
    console.log(`${slug}: fixtures written to ${targetDir} (${Math.round(size / 1024)} KB total)`);
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
