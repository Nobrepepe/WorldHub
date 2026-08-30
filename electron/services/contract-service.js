import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { domainError } from './errors.js';
import { nowIso } from './database-service.js';
import { recordActivity } from './activity-service.js';
import { stableJson } from './stable-json.js';

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

/**
 * Accept a contract that still names its format version the old way.
 *
 * `contractVersion` was renamed to `contractFormatVersion` because a
 * contract record also carries a revision counter, and the two names were
 * close enough that three of four consuming applications gated on the
 * wrong one. Documents written before the rename still import; they are
 * stored in the current shape.
 */
export function normalizeContractJson(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return contract;
  if (contract.contractFormatVersion !== undefined || contract.contractVersion === undefined) return contract;
  const { contractVersion, ...rest } = contract;
  return { ...rest, contractFormatVersion: contractVersion };
}

/** Structural validation plus duplicate-id and reference checks. */
export function validateContractJson(rawContract) {
  const contract = normalizeContractJson(rawContract);
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

  /* Per-record field ids and asset-set ids must be unique across the
     whole contract, not just within one selection: production storage
     and package content key them by (entity, id), so a shared id from
     two selections would collide when the same record appears in both. */
  const entityFieldOwners = new Map();
  const assetSetOwners = new Map();
  const checkGlobal = (map, id, owner, what) => {
    const existing = map.get(id);
    if (existing !== undefined && existing !== owner) {
      issues.push({
        severity: 'error',
        code: 'contract.id_shared',
        message: `The ${what} id "${id}" is used by both "${existing}" and "${owner}"; ${what} ids must be unique across the whole contract.`,
      });
    }
    map.set(id, owner);
  };

  for (const field of contract.productionFields ?? []) checkId(field.id, 'productionFields');
  for (const selection of contract.entitySelections ?? []) {
    checkId(selection.id, 'entitySelections');
    for (const field of selection.fields ?? []) {
      checkId(field.id, `selection ${selection.id} fields`);
      checkGlobal(entityFieldOwners, field.id, selection.id, 'per-record field');
    }
    for (const set of selection.assetSets ?? []) {
      checkId(set.id, `selection ${selection.id} assetSets`);
      checkGlobal(assetSetOwners, set.id, selection.id, 'asset-set');
    }
    if (selection.exact !== undefined && (selection.min !== undefined || selection.max !== undefined)) {
      issues.push({ severity: 'error', code: 'contract.count_conflict', message: `Selection "${selection.id}" mixes exact with min/max.` });
    }
    if (selection.min !== undefined && selection.max !== undefined && selection.min > selection.max) {
      issues.push({ severity: 'error', code: 'contract.count_conflict', message: `Selection "${selection.id}" has min greater than max.` });
    }
  }
  for (const set of contract.assetSets ?? []) {
    checkId(set.id, 'assetSets');
    checkGlobal(assetSetOwners, set.id, 'the production level', 'asset-set');
  }
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
export function createContract(library, rawContract) {
  const contractJson = normalizeContractJson(rawContract);
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
export function updateContract(library, contractId, rawContract) {
  const contractJson = normalizeContractJson(rawContract);
  assertValidContract(contractJson);
  const db = library.db;
  const latest = db.prepare('SELECT MAX(version) v FROM application_contracts WHERE contract_id = ?').get(contractId)?.v;
  if (!latest) throw domainError('contract.missing', 'That contract no longer exists.');
  /* A new version inherits where the contract came from. Dropping it would
     quietly untrack the contract, and an edit made here would then look like
     a contract nobody had ever bound to a file — which is precisely the state
     the whole import path exists to prevent. */
  const source = db.prepare(`
    SELECT source_path, source_sha256 FROM application_contracts
    WHERE contract_id = ? ORDER BY version DESC LIMIT 1
  `).get(contractId) ?? {};
  db.prepare(`
    INSERT INTO application_contracts (contract_id, version, app_type, name, json, created_at, source_path, source_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(contractId, latest + 1, contractJson.appType, contractJson.name,
    JSON.stringify(contractJson, null, 2), nowIso(), source.source_path ?? null, source.source_sha256 ?? null);
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
    sourcePath: row.source_path ?? null,
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

/* ---------------- provenance: the file a contract came from ---------------- */

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function recordSource(db, contractId, version, sourcePath, checksum) {
  db.prepare(`
    UPDATE application_contracts SET source_path = ?, source_sha256 = ?
    WHERE contract_id = ? AND version = ?
  `).run(sourcePath, checksum, contractId, version);
}

/**
 * Take a contract from the file its application keeps, which is the copy
 * that application's own repository treats as authoritative.
 *
 * Contracts are keyed by `appType`: importing a file for an app already
 * known here becomes a new version of that contract rather than a second
 * one. A file whose content already matches the stored version records
 * its provenance without bumping the version — the revision counter
 * should measure real changes, not how many times a file was re-read.
 */
export function importContractFile(library, sourcePath) {
  const absolute = path.resolve(sourcePath);
  let raw;
  try {
    raw = fs.readFileSync(absolute);
  } catch {
    throw domainError('contract.source_unreadable', `That contract file could not be read: ${absolute}`);
  }
  let parsed;
  try {
    parsed = normalizeContractJson(JSON.parse(raw.toString('utf8')));
  } catch {
    throw domainError('contract.source_invalid_json', `${absolute} is not valid JSON.`);
  }
  assertValidContract(parsed);

  const db = library.db;
  const checksum = sha256(raw);
  const existing = db.prepare(`
    SELECT contract_id FROM application_contracts WHERE app_type = ? ORDER BY version DESC LIMIT 1
  `).get(parsed.appType);

  if (!existing) {
    const created = createContract(library, parsed);
    recordSource(db, created.contractId, created.version, absolute, checksum);
    return { ...getContract(library, created.contractId), imported: 'created' };
  }

  const latest = getContract(library, existing.contract_id);
  if (stableJson(latest.contract) === stableJson(parsed)) {
    recordSource(db, latest.contractId, latest.version, absolute, checksum);
    return { ...getContract(library, latest.contractId), imported: 'unchanged' };
  }

  const updated = updateContract(library, latest.contractId, parsed);
  recordSource(db, updated.contractId, updated.version, absolute, checksum);
  recordActivity(db, 'contract.imported', 'contract', updated.contractId, path.basename(absolute));
  return { ...getContract(library, updated.contractId), imported: 'updated' };
}

/**
 * Has the file this contract came from changed since it was imported?
 *
 * Answering costs a read and a hash and changes nothing, which is the
 * point: the previous mechanism could only reveal drift by overwriting
 * the evidence. A contract authored in the app is untracked rather than
 * drifted — that is a state, not a fault.
 */
export function contractDrift(library, contractId) {
  const row = library.db.prepare(`
    SELECT * FROM application_contracts WHERE contract_id = ? ORDER BY version DESC LIMIT 1
  `).get(contractId);
  if (!row) throw domainError('contract.missing', 'That contract no longer exists.');

  const clean = {
    tracked: true, drifted: false, unverifiable: false,
    sourcePath: row.source_path, reason: null, message: null,
  };
  if (!row.source_path) {
    return {
      tracked: false, drifted: false, unverifiable: false,
      sourcePath: null, reason: null, message: null,
    };
  }
  let raw;
  try {
    raw = fs.readFileSync(row.source_path);
  } catch {
    /* Not every machine holds every application — that is the whole reason the
       repositories are separate. An absent file means the claim cannot be
       checked here, which is worth saying and not worth blocking on: the
       contract in this library is still the one that was imported, and nothing
       on this machine has touched it. */
    return {
      ...clean,
      unverifiable: true,
      reason: 'unreachable',
      message: `The contract file this was imported from is not on this machine (${row.source_path}), so it cannot be checked here. Publishing uses the version already imported.`,
    };
  }
  /* Compare the documents, not the bytes. A checksum only answers "has the
     file moved?", which misses the other way the two can disagree: a contract
     edited here drifts from a file that never changed at all. */
  let fromFile;
  try {
    fromFile = normalizeContractJson(JSON.parse(raw.toString('utf8')));
  } catch {
    return {
      ...clean,
      drifted: true,
      reason: 'unreadable',
      message: `${row.source_path} is no longer valid JSON, so this contract cannot be checked against it.`,
    };
  }
  if (stableJson(JSON.parse(row.json)) === stableJson(fromFile)) return clean;

  const fileMoved = sha256(raw) !== row.source_sha256;
  return {
    ...clean,
    drifted: true,
    reason: fileMoved ? 'file_changed' : 'edited_here',
    message: fileMoved
      ? `${row.source_path} has changed since version ${row.version} was imported. Re-import it so productions publish against what the application actually asks for.`
      : `Version ${row.version} was edited in World Hub and no longer matches ${row.source_path}. The application's own copy is the authoritative one — make the change there and import it.`,
  };
}
