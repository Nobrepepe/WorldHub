import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestLibrary } from './helpers.mjs';
import { loadConsumerContract } from './fixtures/consumer-fixtures.mjs';
import { buildAutoProduction } from '../scripts/auto-production.mjs';
import { validateProduction } from '../electron/services/production-service.js';
import { verifyPublication } from '../electron/services/publication-service.js';

/**
 * A new application arrives with a contract and nothing else. It must be able
 * to generate conformance fixtures the same day, or it will start life the way
 * the first four did: with a hand-written builder that is a second reading of
 * the contract, drifting from it quietly.
 *
 * The four established contracts are the hardest available test of that —
 * between them they cover every field type, nested lists, per-item fields,
 * asset references inside list rows, and one contract of 119 field
 * definitions.
 */

for (const slug of ['taskstamps', 'chatbot', 'stickeralbum', 'herocollector']) {
  test(`a production built from ${slug}'s contract alone validates and publishes`, async (t) => {
    const { library, cleanup } = await makeTestLibrary();
    t.after(cleanup);

    const built = await buildAutoProduction(library, loadConsumerContract(slug));
    const validation = validateProduction(library, built.production.id);
    assert.equal(validation.errors, 0, JSON.stringify(validation.issues, null, 2));
    assert.deepEqual(verifyPublication(library, built.publication.id), { ok: true, problems: [] });
  });
}

test('the generated production actually exercises the contract, not just its required parts', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const built = await buildAutoProduction(library, loadConsumerContract('herocollector'));

  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.join(root, ...built.publication.directory.split('/'));
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'assets', 'index.json'), 'utf8'));
  const content = JSON.parse(fs.readFileSync(path.join(dir, 'production', 'content.json'), 'utf8'));

  assert.ok(index.length > 0, 'art is packaged');
  assert.ok(Object.keys(content.values).length > 0, 'production-level fields are filled');
  assert.ok(Object.keys(content.entityValues).length > 0, 'per-record fields are filled');
  assert.ok(Object.keys(content.assetSets).length > 0, 'asset sets are filled');
});
