import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTestLibrary, makeTempDir } from './helpers.mjs';
import { CONSUMER_BUILDERS } from './fixtures/consumer-fixtures.mjs';
import { extractZipSafely } from '../kit/js/zip-reader.mjs';
import { makeLegacyPackage } from './fixtures/legacy-package.mjs';
import { vocabularyVersion } from '../electron/services/vocabulary.js';

/**
 * The Node and Python readers must agree about *good* packages, not merely
 * both reject bad ones. The fixture corpus that preceded this proved only the
 * latter, which is how four implementations of one algorithm drifted apart
 * without any test noticing.
 */

const HERE = path.dirname(new URL(import.meta.url).pathname);
const OBSERVE_JS = path.join(HERE, '..', 'kit', 'conformance', 'observe.mjs');
const OBSERVE_PY = path.join(HERE, '..', 'kit', 'conformance', 'observe.py');

const APP_TYPE = {
  taskstamps: 'task-stamps.stamp-set', chatbot: 'chat-bot.cast',
  stickeralbum: 'sticker-album.collection', herocollector: 'hero-collector.content-pack',
};

function havePython() {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const observeJs = (dir, appType) =>
  JSON.parse(execFileSync('node', [OBSERVE_JS, dir, appType, String(vocabularyVersion())], { encoding: 'utf8' }));
const observePy = (dir, appType) =>
  JSON.parse(execFileSync('python3', [OBSERVE_PY, dir, appType, String(vocabularyVersion())], { encoding: 'utf8' }));

for (const slug of Object.keys(APP_TYPE)) {
  test(`${slug}: both readers see exactly the same package`, async (t) => {
    if (!havePython()) return t.skip('python3 not available');
    const { library, root, cleanup } = await makeTestLibrary();
    t.after(cleanup);
    const built = await CONSUMER_BUILDERS[slug](library);
    const dir = path.join(root, ...built.publication.directory.split('/'));

    const fromJs = observeJs(dir, APP_TYPE[slug]);
    const fromPy = observePy(dir, APP_TYPE[slug]);
    assert.equal(fromJs.ok, true, JSON.stringify(fromJs));
    assert.deepEqual(fromPy, fromJs, 'the two readers disagree about this package');
    assert.ok(fromJs.resolved.length > 0, 'and they agreed about a package that actually has art');
  });
}

test('both readers agree about protocol 1 packages too', async (t) => {
  if (!havePython()) return t.skip('python3 not available');
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const built = await CONSUMER_BUILDERS.herocollector(library);
  const legacy = makeLegacyPackage(
    path.join(root, ...built.publication.directory.split('/')),
    makeTempDir('agree-protocol-1-'),
    { retireRecipe: { current: 'tile_16x9', former: 'landscape_16x9' } });
  t.after(() => fs.rmSync(legacy, { recursive: true, force: true }));

  const fromJs = observeJs(legacy, APP_TYPE.herocollector);
  const fromPy = observePy(legacy, APP_TYPE.herocollector);
  assert.equal(fromJs.ok, true, JSON.stringify(fromJs));
  assert.equal(fromJs.protocolVersion, 1);
  assert.deepEqual(fromPy, fromJs, 'the readers disagree about a protocol 1 package');
  assert.ok(fromJs.resolved.some((entry) => entry.recipeId === 'landscape_16x9'),
    'and they agreed while resolving art published under a retired recipe name');
});

test('both readers reject the same bad packages, with the same words', async (t) => {
  if (!havePython()) return t.skip('python3 not available');
  const cases = ['corrupt-checksum.zip', 'unlisted-file.zip', 'missing-asset.zip', 'wrong-apptype.zip', 'unsupported-protocol.zip'];
  let checked = 0;
  for (const name of cases) {
    const zip = path.join(HERE, '..', '..', 'HeroCollector', 'tests', 'fixtures', 'worldhub', name);
    if (!fs.existsSync(zip)) continue;
    const dir = makeTempDir('agree-bad-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    extractZipSafely(zip, dir);

    const fromJs = observeJs(dir, APP_TYPE.herocollector);
    const fromPy = observePy(dir, APP_TYPE.herocollector);
    assert.equal(fromJs.ok, false, `${name} should be refused`);
    assert.deepEqual(fromPy, fromJs, `${name}: the readers refuse it for different reasons`);
    checked += 1;
  }
  t.diagnostic(`${checked} adversarial packages compared across both readers`);
});
