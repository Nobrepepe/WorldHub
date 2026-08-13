import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { domainError } from './errors.js';
import { nowIso } from './database-service.js';
import { recordActivity } from './activity-service.js';

/**
 * Application contracts are declarative JSON interpreted by the generic
 * form and validation engine. They are validated against the bundled
 * JSON Schema before saving or use; contract code is never executed.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'schemas', 'application-contract.schema.json');
export const EXAMPLE_CONTRACT_PATH = path.join(__dirname, '..', '..', 'schemas', 'example-character-gallery.contract.json');

let validator = null;

function getValidator() {
  if (!validator) {
    const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false });
    validator = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8')));
  }
  return validator;
}

/** Structural validation plus duplicate-id and reference checks. */
export function validateContractJson(contract) {
  const issues = [];
  const validate = getValidator();
  if (!validate(contract)) {
    for (const error of validate.errors ?? []) {
      issues.push({
        severity: 'error',
        code: 'contract.schema',
        message: `${error.instancePath || 'contract'} ${error.message}`,
        path: error.instancePath,
      });
    }
    return issues;
  }

  const seen = new Set();
  const checkId = (id, where) => {
    const key = `${where}:${id}`;
    if (seen.has(key)) {
      issues.push({ severity: 'error', code: 'contract.duplicate_id', message: `Duplicate id "${id}" in ${where}.` });
    }
    seen.add(key);
  };
  for (const field of contract.productionFields ?? []) checkId(field.id, 'productionFields');
  for (const selection of contract.entitySelections ?? []) {
    checkId(selection.id, 'entitySelections');
    for (const field of selection.fields ?? []) checkId(field.id, `selection ${selection.id} fields`);
    for (const set of selection.assetSets ?? []) checkId(set.id, `selection ${selection.id} assetSets`);
    if (selection.exact !== undefined && (selection.min !== undefined || selection.max !== undefined)) {
      issues.push({ severity: 'error', code: 'contract.count_conflict', message: `Selection "${selection.id}" mixes exact with min/max.` });
    }
    if (selection.min !== undefined && selection.max !== undefined && selection.min > selection.max) {
      issues.push({ severity: 'error', code: 'contract.count_conflict', message: `Selection "${selection.id}" has min greater than max.` });
    }
  }
  for (const set of contract.assetSets ?? []) checkId(set.id, 'assetSets');
  return issues;
}

export function assertValidContract(contract) {
  const issues = validateContractJson(contract);
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    throw domainError('contract.invalid', `The contract is not valid: ${errors[0].message}`, { issues });
  }
}

/** Save a brand-new contract as version 1. */
export function createContract(library, contractJson) {
  assertValidContract(contractJson);
  const db = library.db;
  const contractId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO application_contracts (contract_id, version, app_type, name, json, created_at)
    VALUES (?, 1, ?, ?, ?, ?)
  `).run(contractId, contractJson.appType, contractJson.name, JSON.stringify(contractJson, null, 2), nowIso());
  recordActivity(db, 'contract.created', 'contract', contractId, contractJson.name);
  return getContract(library, contractId);
}

/** Changing a contract creates a new version; old versions remain. */
export function updateContract(library, contractId, contractJson) {
  assertValidContract(contractJson);
  const db = library.db;
  const latest = db.prepare('SELECT MAX(version) v FROM application_contracts WHERE contract_id = ?').get(contractId)?.v;
  if (!latest) throw domainError('contract.missing', 'That contract no longer exists.');
  db.prepare(`
    INSERT INTO application_contracts (contract_id, version, app_type, name, json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(contractId, latest + 1, contractJson.appType, contractJson.name, JSON.stringify(contractJson, null, 2), nowIso());
  recordActivity(db, 'contract.new_version', 'contract', contractId, `v${latest + 1}`);
  return getContract(library, contractId);
}

export function getContract(library, contractId, version = null) {
  const db = library.db;
  const row = version
    ? db.prepare('SELECT * FROM application_contracts WHERE contract_id = ? AND version = ?').get(contractId, version)
    : db.prepare('SELECT * FROM application_contracts WHERE contract_id = ? ORDER BY version DESC LIMIT 1').get(contractId);
  if (!row) throw domainError('contract.missing', 'That contract (or version) no longer exists.');
  return contractView(db, row);
}

function contractView(db, row) {
  const versions = db.prepare('SELECT version, created_at FROM application_contracts WHERE contract_id = ? ORDER BY version DESC').all(row.contract_id);
  return {
    contractId: row.contract_id,
    version: row.version,
    appType: row.app_type,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    contract: JSON.parse(row.json),
    versions,
  };
}

export function listContracts(library, { includeArchived = false } = {}) {
  const db = library.db;
  const rows = db.prepare(`
    SELECT c.* FROM application_contracts c
    JOIN (SELECT contract_id, MAX(version) v FROM application_contracts GROUP BY contract_id) latest
      ON latest.contract_id = c.contract_id AND latest.v = c.version
    ${includeArchived ? '' : `WHERE c.status = 'active'`}
    ORDER BY c.name COLLATE NOCASE
  `).all();
  return rows.map((row) => ({
    contractId: row.contract_id,
    version: row.version,
    appType: row.app_type,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    productions: db.prepare('SELECT COUNT(*) n FROM productions WHERE contract_id = ?').get(row.contract_id).n,
  }));
}

export function setContractStatus(library, contractId, status) {
  const db = library.db;
  const changed = db.prepare('UPDATE application_contracts SET status = ? WHERE contract_id = ?').run(status, contractId);
  if (changed.changes === 0) throw domainError('contract.missing', 'That contract no longer exists.');
  recordActivity(db, `contract.${status}`, 'contract', contractId);
  return getContract(library, contractId);
}

export function duplicateContract(library, contractId) {
  const source = getContract(library, contractId);
  const copy = { ...source.contract, name: `${source.contract.name} (copy)` };
  return createContract(library, copy);
}

/** Install the bundled example contract into a new library. */
export function installExampleContract(library) {
  const example = JSON.parse(fs.readFileSync(EXAMPLE_CONTRACT_PATH, 'utf8'));
  const existing = library.db.prepare('SELECT contract_id FROM application_contracts WHERE app_type = ?').get(example.appType);
  if (existing) return getContract(library, existing.contract_id);
  return createContract(library, example);
}
