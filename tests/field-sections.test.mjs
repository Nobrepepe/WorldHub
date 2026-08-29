import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeTestLibrary } from './helpers.mjs';
import { EXAMPLE_CONTRACT_PATH, createContract, validateContractJson } from '../electron/services/contract-service.js';
import { createProduction, setProductionValue, validateProduction } from '../electron/services/production-service.js';

/**
 * Sections and the `advanced` flag are presentation, so the engine must keep
 * treating a sectioned contract exactly like an unsectioned one — and a
 * validation issue must still be able to name the field it is about, or the
 * "Go there →" jump lands on a heading with the field folded away beneath it.
 */

function sectionedContract() {
  const contract = JSON.parse(fs.readFileSync(EXAMPLE_CONTRACT_PATH, 'utf8'));
  contract.appType = 'example.sectioned-gallery';
  contract.productionFields = [
    { id: 'gallery_title', label: 'Gallery title', type: 'shortText', required: true, maxLength: 120, section: 'Presentation' },
    { id: 'gallery_blurb', label: 'Blurb', type: 'multilineText', section: 'Presentation' },
    { id: 'grid_columns', label: 'Grid columns', type: 'integer', min: 1, max: 8, section: 'Layout tuning', advanced: true },
    { id: 'grid_gap', label: 'Grid gap', type: 'integer', min: 0, max: 64, section: 'Layout tuning', advanced: true },
    { id: 'loose_note', label: 'A field belonging to no section', type: 'shortText' },
  ];
  return contract;
}

test('a contract may name sections and mark fields advanced', () => {
  assert.deepEqual(validateContractJson(sectionedContract()), []);
});

test('sections are presentation only — validation still names the field', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);

  const contract = createContract(library, sectionedContract());
  const production = createProduction(library, { name: 'Sectioned', contractId: contract.contractId });

  const before = validateProduction(library, production.id);
  const missing = before.issues.find((issue) => issue.target?.field === 'gallery_title');
  assert.ok(missing, 'the required field in a section is still validated');
  assert.equal(missing.destination, 'fields:gallery_title',
    'the issue points at the field, so revealing it can open the section that hides it');

  setProductionValue(library, production.id, { scope: 'production', field: 'gallery_title', value: 'Vel' });
  setProductionValue(library, production.id, { scope: 'production', field: 'grid_columns', value: 4 });
  const after = validateProduction(library, production.id);
  assert.equal(after.issues.some((issue) => issue.target?.field === 'gallery_title'), false);
});

test('an out-of-range value in an advanced section is still refused', async (t) => {
  const { library, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const contract = createContract(library, sectionedContract());
  const production = createProduction(library, { name: 'Sectioned', contractId: contract.contractId });

  setProductionValue(library, production.id, { scope: 'production', field: 'grid_columns', value: 99 });
  const issues = validateProduction(library, production.id).issues;
  const offending = issues.find((issue) => issue.target?.field === 'grid_columns');
  assert.ok(offending, 'being folded out of the way does not make a field unchecked');
  assert.equal(offending.destination, 'fields:grid_columns');
  assert.match(offending.message, /8/);
});
