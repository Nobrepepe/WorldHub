import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestLibrary, makeTempDir } from './helpers.mjs';
import { CONSUMER_BUILDERS } from './fixtures/consumer-fixtures.mjs';
import { loadPackage, PackageError } from '../kit/js/package-reader.mjs';
import { extractZipSafely } from '../kit/js/zip-reader.mjs';
import { vocabularyVersion, renamedFrom } from '../electron/services/vocabulary.js';
import { makeLegacyPackage } from './fixtures/legacy-package.mjs';

const SLUGS = ['taskstamps', 'chatbot', 'stickeralbum', 'herocollector'];
const SIBLING = {
  taskstamps: 'TaskStamps', chatbot: 'ChatBot',
  stickeralbum: 'StickerAlbum', herocollector: 'HeroCollector',
};
const APP_TYPE = {
  taskstamps: 'task-stamps.stamp-set', chatbot: 'chat-bot.cast',
  stickeralbum: 'sticker-album.collection', herocollector: 'hero-collector.content-pack',
};
const options = () => ({ supportedVocabularyVersion: vocabularyVersion(), renamedFrom: renamedFrom() });

/** Where a sibling checkout keeps its conformance fixtures, when it is present. */
function siblingFixture(slug, name) {
  const file = path.join(
    path.dirname(new URL(import.meta.url).pathname), '..', '..', SIBLING[slug],
    'tests', 'fixtures', 'worldhub', name);
  return fs.existsSync(file) ? file : null;
}

for (const slug of SLUGS) {
  test(`${slug}: the shared reader accepts a freshly published protocol 2 package`, async (t) => {
    const { library, root, cleanup } = await makeTestLibrary();
    t.after(cleanup);
    const built = await CONSUMER_BUILDERS[slug](library);
    const dir = path.join(root, ...built.publication.directory.split('/'));

    const pkg = loadPackage(dir, APP_TYPE[slug], options());
    assert.equal(pkg.protocolVersion, 2);
    assert.equal(pkg.manifest.vocabularyVersion, vocabularyVersion());
    assert.ok(Number.isInteger(pkg.manifest.contract.revision));
    assert.equal('version' in pkg.manifest.contract, false);
    assert.equal(pkg.contract.contractFormatVersion, 1);
  });
}

test('the same reader still accepts a protocol 1 package', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const built = await CONSUMER_BUILDERS.herocollector(library);
  const legacy = makeLegacyPackage(
    path.join(root, ...built.publication.directory.split('/')),
    makeTempDir('protocol-1-'));
  t.after(() => fs.rmSync(legacy, { recursive: true, force: true }));

  const pkg = loadPackage(legacy, APP_TYPE.herocollector, options());
  assert.equal(pkg.protocolVersion, 1);
  assert.ok(Number.isInteger(pkg.manifest.contract.revision),
    'the old contract.version is presented under the current name');
  assert.equal(pkg.contract.contractFormatVersion, 1,
    'the old contractVersion is presented under the current name');
  assert.equal(pkg.manifest.vocabularyVersion, 1,
    'a package with no vocabulary version predates vocabulary versioning');
});

test('art asked for by a retired recipe name still resolves', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const built = await CONSUMER_BUILDERS.herocollector(library);
  /* published before tile_16x9 had that name */
  const legacy = makeLegacyPackage(
    path.join(root, ...built.publication.directory.split('/')),
    makeTempDir('retired-recipe-'),
    { retireRecipe: { current: 'tile_16x9', former: 'landscape_16x9' } });
  t.after(() => fs.rmSync(legacy, { recursive: true, force: true }));

  const pkg = loadPackage(legacy, APP_TYPE.herocollector, options());
  const stale = pkg.assetIndex.find((entry) => entry.recipeId === 'landscape_16x9');
  assert.ok(stale, 'the package really does carry the old name');
  assert.equal(pkg.assetIndex.some((entry) => entry.recipeId === 'tile_16x9'), false);

  /* the application asks by the name it knows today */
  const resolved = pkg.assetFile(stale.assetId, ['tile_16x9']);
  assert.equal(resolved.recipeId, 'landscape_16x9',
    'the renamed-from map finds the file the old name produced');
});

test('a package from a newer vocabulary is refused loudly, not rendered wrongly', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const built = await CONSUMER_BUILDERS.herocollector(library);
  const dir = path.join(root, ...built.publication.directory.split('/'));

  assert.throws(
    () => loadPackage(dir, APP_TYPE.herocollector, { supportedVocabularyVersion: vocabularyVersion() - 1 }),
    (error) => {
      assert.ok(error instanceof PackageError);
      assert.match(error.message, /art vocabulary/);
      return true;
    },
    'the failure arrives at load, not as missing pictures three screens deep',
  );
});

test('recipes and roles are resolved from the embedded contract, not from names in code', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const built = await CONSUMER_BUILDERS.herocollector(library);
  const pkg = loadPackage(path.join(root, ...built.publication.directory.split('/')),
    APP_TYPE.herocollector, options());

  const portraitSet = pkg.setForRole('character.portrait');
  assert.equal(portraitSet, 'hc_portrait');
  assert.deepEqual(pkg.recipesFor(portraitSet), ['square', 'thumbnail_square']);
  assert.equal(pkg.setForRole('character.full_body'), 'hc_full_body');
  assert.equal(pkg.setForRole('nonexistent.role'), null);
});

test('the adversarial fixtures are still rejected, each for its own reason', async (t) => {
  const cases = [
    ['corrupt-checksum.zip', /failed its checksum/],
    ['unlisted-file.zip', /unlisted file/],
    ['missing-asset.zip', /missing|asset file/i],
    ['wrong-apptype.zip', /not for this app/],
    ['unsupported-protocol.zip', /protocol this app does not understand/],
  ];
  let checked = 0;
  for (const [name, pattern] of cases) {
    const zip = siblingFixture('herocollector', name);
    if (!zip) continue;
    const dir = makeTempDir('adversarial-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    extractZipSafely(zip, dir);
    assert.throws(() => loadPackage(dir, APP_TYPE.herocollector, options()), pattern, name);
    checked += 1;
  }
  t.diagnostic(`${checked} adversarial fixtures checked`);
});

test('a hostile archive is refused before anything is written', async (t) => {
  const zip = siblingFixture('herocollector', 'traversal.zip');
  if (!zip) return t.skip('HeroCollector checkout not present');
  const dir = makeTempDir('traversal-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => extractZipSafely(zip, dir), /unsafe file paths|symbolic links/);
});
