import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from './helpers.mjs';
import { initConsumer } from '../scripts/kit-init.mjs';
import { verify } from '../kit/js/verify.mjs';
import { validateContractJson } from '../electron/services/contract-service.js';

/**
 * The rehearsal for application number six.
 *
 * The four that came first each acquired this integration by hand and each
 * reached a slightly different answer, one of them wrong. A new app has to be
 * able to arrive at the correct one without anybody remembering how — so
 * scaffolding it must produce something that passes conformance with no
 * hand-editing at all.
 */

const REGISTRY = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'kit', 'consumers.json');

/** Register, scaffold, then put the registry back exactly as it was. */
function withScaffoldedApp(t, run) {
  const before = fs.readFileSync(REGISTRY);
  const projectsDir = makeTempDir('projects-');
  /* Syncing a consumer also drops a copy of its contract into World Hub's own
     fixtures. A test that registers an imaginary app must not leave one there. */
  const contractCopy = path.join(
    path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'contracts', 'rehearsal.json');
  t.after(() => {
    fs.writeFileSync(REGISTRY, before);
    fs.rmSync(projectsDir, { recursive: true, force: true });
    fs.rmSync(contractCopy, { force: true });
  });
  const result = initConsumer({
    slug: 'rehearsal', repo: 'Rehearsal', appType: 'rehearsal.sample', runtime: 'js', projectsDir,
  });
  return run(result);
}

test('a scaffolded consumer passes conformance with no hand-editing', (t) => {
  withScaffoldedApp(t, ({ appRoot }) => {
    const report = verify(appRoot);
    /* Fixtures are generated in a separate step that needs a library, so that
       one check is expected to be outstanding; nothing else may be. */
    const outstanding = report.failures.filter((failure) => failure.check !== 'fixtures');
    assert.deepEqual(outstanding, [], JSON.stringify(report.failures, null, 2));
  });
});

test('the starter contract is valid and current', (t) => {
  withScaffoldedApp(t, ({ appRoot }) => {
    const contract = JSON.parse(
      fs.readFileSync(path.join(appRoot, 'worldhub', 'application-contract.json'), 'utf8'));
    assert.deepEqual(validateContractJson(contract), []);
    assert.equal(contract.contractFormatVersion, 1);
    assert.ok(contract.supportedProtocolVersions.includes(2),
      'a new app declares it can read what World Hub publishes today');
  });
});

test('scaffolding vendors the kit and locks it', (t) => {
  withScaffoldedApp(t, ({ appRoot }) => {
    const vendor = path.join(appRoot, 'vendor', 'worldhub-kit');
    for (const expected of ['js/package-reader.mjs', 'js/zip-reader.mjs', 'js/verify.mjs', 'vocabulary.json', 'CONSUMER_GUIDE.md']) {
      assert.ok(fs.existsSync(path.join(vendor, ...expected.split('/'))), `${expected} is vendored`);
    }
    const lock = JSON.parse(fs.readFileSync(path.join(vendor, '.kit-lock.json'), 'utf8'));
    assert.ok(Object.keys(lock.files).length > 0);
    assert.equal(lock.vocabularyVersion, 1);
  });
});

test('registering the same app twice does not duplicate it', (t) => {
  withScaffoldedApp(t, ({ appRoot }) => {
    const projectsDir = path.dirname(appRoot);
    initConsumer({ slug: 'rehearsal', repo: 'Rehearsal', appType: 'rehearsal.sample', runtime: 'js', projectsDir });
    const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    assert.equal(registry.consumers.filter((entry) => entry.slug === 'rehearsal').length, 1);
  });
});
