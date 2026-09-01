/**
 * World Hub package reading and protocol validation — the one Node
 * implementation.
 *
 * This replaces the four hand-maintained copies that preceded it. Those
 * were transliterations of a single algorithm into three languages, and
 * they disagreed exactly where the bugs were: one gated compatibility on
 * the contract's revision counter and refused a real publication, three
 * validated a profile field the exporter had stopped writing and so
 * validated nothing at all.
 *
 * Reads Package Protocol 1 and 2 and presents both in the current shape,
 * so packages installed before the rename keep working — including packages
 * published before connections carried kind definitions, whose connections
 * still read through the labels they were published with.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const SUPPORTED_PROTOCOL_VERSIONS = new Set([1, 2]);
export const SUPPORTED_CONTRACT_FORMAT_VERSIONS = new Set([1]);
export const PACKAGE_FORMAT = 'world-hub-package';
export const CONTRACT_FORMAT = 'world-hub-application-contract';

/** A package failed validation. The message is user-facing. */
export class PackageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PackageError';
    this.code = 'package';
  }
}

const asArray = (value) => (Array.isArray(value) ? value : []);
const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * Read a catalog file a package may predate.
 *
 * `catalog/connection-kinds.json` arrived after Protocol 1 and part-way
 * through Protocol 2, so its absence is a fact about when a package was
 * published, not a fault. A package that has it is verified against it; one
 * that has not still loads, and its connections read the way they always did.
 */
function readJsonOptional(root, packagePath, fallback) {
  const path = join(root, ...packagePath.split('/'));
  if (!existsSync(path) || !statSync(path).isFile()) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    throw new PackageError(`The package file ${packagePath} is not valid JSON.`);
  }
}

function readJson(root, packagePath) {
  const path = join(root, ...packagePath.split('/'));
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new PackageError(`The package is missing ${packagePath}.`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    throw new PackageError(`The package file ${packagePath} is not valid JSON.`);
  }
}

function listFiles(root) {
  const results = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), relative);
      else if (entry.isFile()) results.push(relative);
    }
  };
  walk(root, '');
  return results.sort();
}

/**
 * Index every asset set and assetRef field in a contract by its id, keeping
 * the recipes and roles it declares. Covers the three places a contract can
 * declare them: top-level asset sets, the sets hanging off an entity
 * selection, and assetRef fields including those nested inside list fields.
 */
function declaredSets(contract) {
  const found = new Map();
  const remember = (record) => {
    if (typeof record?.id !== 'string') return;
    found.set(record.id, {
      recipes: asArray(record.recipes).map(String),
      roles: asArray(record.roles ?? record.assetRoles).map(String),
    });
  };
  const walkFields = (fields) => {
    for (const field of asArray(fields)) {
      if (field.type === 'assetRef') remember(field);
      walkFields(field.fields ?? field.itemFields);
    }
  };
  const walkSets = (sets) => {
    for (const set of asArray(sets)) {
      remember(set);
      walkFields(set.itemFields);
    }
  };
  walkSets(contract.assetSets);
  for (const selection of asArray(contract.entitySelections)) {
    walkSets(selection.assetSets);
    walkFields(selection.fields);
  }
  walkFields(contract.productionFields);
  return found;
}

export class PackageInfo {
  constructor(fields) {
    Object.assign(this, fields);
    this.sets = declaredSets(this.contract);
    /* former recipe name -> current one, so art asked for by an old name
       still resolves instead of silently falling back */
    this.recipeAliases = new Map();
    for (const [current, formerNames] of Object.entries(this.renamedFrom.recipes ?? {})) {
      for (const former of asArray(formerNames)) this.recipeAliases.set(former, current);
    }
  }

  get publicationId() { return this.manifest.publicationId; }
  get productionId() { return this.manifest.production.id; }
  entitiesById() { return new Map(this.entities.map((entity) => [entity.id, entity])); }
  absolute(packagePath) { return join(this.root, ...packagePath.split('/')); }
  assetEntries(assetId) { return this.assetIndex.filter((entry) => entry.assetId === assetId); }

  /**
   * The recipes this package's own contract declares for a set, best first.
   * Recipe names are World Hub's to choose and they change; reading them out
   * of the embedded contract means a rename over there needs no code change
   * over here.
   */
  recipesFor(setId) {
    return [...(this.sets.get(setId)?.recipes ?? [])];
  }

  /**
   * The asset set carrying one of these roles, first match wins. Ask for what
   * art is *for* — a character tile, a full body — rather than for a set id,
   * so renaming a set does not strand the screen that renders it.
   */
  setForRole(...roles) {
    for (const role of roles) {
      for (const [setId, declared] of this.sets) {
        if (declared.roles.includes(role)) return setId;
      }
    }
    return null;
  }

  /* ---- connections ---- */

  /** Every published connection kind, by its stable id. */
  connectionKindsById() {
    return new Map(this.connectionKinds.map((kind) => [kind.id, kind]));
  }

  /**
   * The label one end of a connection wears.
   *
   * The kind is asked first, so a rename in the authoring library reaches
   * every connection that uses it; the record's own label is the fallback,
   * which is all a package published before kinds existed carries.
   */
  connectionLabel(connection, direction) {
    const kind = this.connectionKindsById().get(connection.kindId);
    if (!kind) return direction === 'to' ? (connection.inverseLabel ?? '') : (connection.label ?? '');
    if (kind.symmetric) return kind.forwardLabel;
    return direction === 'to'
      ? (connection.inverseLabel || kind.inverseLabel)
      : (connection.label || kind.forwardLabel);
  }

  /**
   * Every connection touching a record, written from that record's side.
   *
   * `direction` is "from" when the record is the connection's source and
   * "to" when it is the target; `otherId` is always the record at the other
   * end, so a caller never has to work out which column it occupies.
   */
  connectionsFor(entityId) {
    return this.relationships
      .filter((connection) => connection.sourceId === entityId || connection.targetId === entityId)
      .map((connection) => {
        const from = connection.sourceId === entityId;
        const direction = from ? 'from' : 'to';
        return {
          ...connection,
          direction,
          otherId: from ? connection.targetId : connection.sourceId,
          label: this.connectionLabel(connection, direction),
        };
      });
  }

  /** Connections running out of a record, optionally of one kind only. */
  connectionsFrom(entityId, kindId = null) {
    return this.relationships.filter((connection) => connection.sourceId === entityId
      && (kindId === null || connection.kindId === kindId || connection.type === kindId));
  }

  /** Connections running into a record, optionally of one kind only. */
  connectionsTo(entityId, kindId = null) {
    return this.relationships.filter((connection) => connection.targetId === entityId
      && (kindId === null || connection.kindId === kindId || connection.type === kindId));
  }

  /** The best index entry for an asset given a recipe preference order. */
  assetFile(assetId, preferredRecipes = []) {
    const entries = this.assetEntries(assetId);
    for (const recipe of preferredRecipes) {
      const wanted = this.recipeAliases.get(recipe) ?? recipe;
      const match = entries.find((entry) => entry.recipeId === wanted || entry.recipeId === recipe);
      if (match) return match;
    }
    return entries[0] ?? null;
  }
}

/**
 * Normalise a manifest so a caller never has to know which protocol wrote
 * it. Protocol 1 named the contract's edit counter `version` and carried no
 * vocabulary version; both become their Protocol 2 spellings here.
 */
function normalizeManifest(manifest) {
  const contract = { ...manifest.contract };
  if (contract.revision === undefined && contract.version !== undefined) {
    contract.revision = contract.version;
  }
  delete contract.version;
  return {
    ...manifest,
    contract,
    vocabularyVersion: manifest.vocabularyVersion ?? 1,
    renamedFrom: manifest.renamedFrom ?? { recipes: {}, roles: {} },
  };
}

/** Union of two `renamedFrom` maps, keyed current id -> former names. */
function mergeRenames(a, b) {
  const out = { recipes: {}, roles: {} };
  for (const source of [a, b]) {
    for (const kind of ['recipes', 'roles']) {
      for (const [current, formerNames] of Object.entries(source?.[kind] ?? {})) {
        const merged = new Set([...(out[kind][current] ?? []), ...asArray(formerNames)]);
        out[kind][current] = [...merged];
      }
    }
  }
  return out;
}

function normalizeContract(contract) {
  if (contract.contractFormatVersion !== undefined) return contract;
  const { contractVersion, ...rest } = contract;
  return { ...rest, contractFormatVersion: contractVersion };
}

/**
 * Validate a package directory completely; throw PackageError otherwise.
 *
 * `supportedVocabularyVersion` is the vocabulary the calling application was
 * built against. A package published under a newer one is refused here, at
 * load, rather than resolving art through a name that has since moved and
 * failing three screens deep as missing pictures.
 */
export function loadPackage(root, expectedAppType, {
  supportedVocabularyVersion = 1,
  renamedFrom: knownRenames = null,
} = {}) {
  const rawManifest = readJson(root, 'manifest.json');
  if (typeof rawManifest !== 'object' || rawManifest === null || rawManifest.format !== PACKAGE_FORMAT) {
    throw new PackageError('This is not a World Hub package.');
  }
  const protocolVersion = rawManifest.protocolVersion;
  if (!SUPPORTED_PROTOCOL_VERSIONS.has(protocolVersion)) {
    throw new PackageError('This package uses a World Hub protocol this app does not understand.');
  }
  if (rawManifest.complete !== true) throw new PackageError('The package is marked incomplete.');
  if (rawManifest.applicationType !== expectedAppType) {
    throw new PackageError(`This package is for “${rawManifest.applicationType}”, not for this app.`);
  }
  for (const key of ['publicationId', 'production', 'contract', 'sourceLibraryId', 'publishedAt', 'entities', 'sections']) {
    if (!(key in rawManifest)) throw new PackageError(`The package manifest is missing ${key}.`);
  }
  const manifest = normalizeManifest(rawManifest);
  /* What the application knows about renames, plus what this package
     declares. A Protocol 1 package carries no rename map at all, so without
     the application's own copy an old package could never heal itself. */
  const renames = mergeRenames(knownRenames, manifest.renamedFrom);

  if (typeof manifest.contract.id !== 'string' || !manifest.contract.id) {
    throw new PackageError('The package manifest does not name its application contract.');
  }
  /* Recorded as a receipt, never gated on: it counts edits in the authoring
     library and climbs for changes that do not affect how a package reads. */
  if (!Number.isInteger(manifest.contract.revision) || manifest.contract.revision < 1) {
    throw new PackageError('The package manifest carries an invalid contract revision.');
  }
  if (!Number.isInteger(manifest.vocabularyVersion) || manifest.vocabularyVersion < 1) {
    throw new PackageError('The package manifest carries an invalid vocabulary version.');
  }
  if (manifest.vocabularyVersion > supportedVocabularyVersion) {
    throw new PackageError(
      `This package uses World Hub art vocabulary ${manifest.vocabularyVersion}; this app understands ${supportedVocabularyVersion}. Update the app before installing it.`);
  }

  const contract = normalizeContract(readJson(root, 'production/contract.json'));
  if (typeof contract !== 'object' || contract === null || contract.format !== CONTRACT_FORMAT) {
    throw new PackageError('The embedded application contract is not valid.');
  }
  if (contract.appType !== manifest.applicationType) {
    throw new PackageError("The embedded contract does not match the package's application type.");
  }
  if (!SUPPORTED_CONTRACT_FORMAT_VERSIONS.has(contract.contractFormatVersion)) {
    throw new PackageError('This package uses a contract format this app does not support.');
  }
  const declaredProtocols = Array.isArray(contract.supportedProtocolVersions) ? contract.supportedProtocolVersions : [1];
  if (!declaredProtocols.includes(protocolVersion)) {
    throw new PackageError("The embedded contract does not support this package's protocol version.");
  }

  const checksums = readJson(root, 'checksums.json');
  if (typeof checksums !== 'object' || checksums === null || Array.isArray(checksums)) {
    throw new PackageError('The package checksum list is unreadable.');
  }
  for (const [packagePath, expected] of Object.entries(checksums)) {
    const filePath = join(root, ...packagePath.split('/'));
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      throw new PackageError(`The package is missing ${packagePath}.`);
    }
    if (sha256File(filePath) !== expected) {
      throw new PackageError(`A package file failed its checksum: ${packagePath}.`);
    }
  }
  const listed = new Set([...Object.keys(checksums), 'checksums.json']);
  for (const relative of listFiles(root)) {
    if (!listed.has(relative)) throw new PackageError(`The package contains an unlisted file: ${relative}.`);
  }

  const entities = readJson(root, 'catalog/entities.json');
  const worlds = readJson(root, 'catalog/worlds.json');
  const characters = readJson(root, 'catalog/characters.json');
  const relationships = readJson(root, 'catalog/relationships.json');
  const connectionKinds = readJsonOptional(root, 'catalog/connection-kinds.json', []);
  const documents = readJson(root, 'catalog/documents.json');
  const tags = readJson(root, 'catalog/tags.json');
  const assetIndex = readJson(root, 'assets/index.json');
  const content = readJson(root, 'production/content.json');

  const entityIds = new Set(entities.map((entity) => entity.id));
  const kindIds = new Set(connectionKinds.map((kind) => kind.id));
  for (const relationship of relationships) {
    if (!entityIds.has(relationship.sourceId) || !entityIds.has(relationship.targetId)) {
      throw new PackageError('A packaged relationship references a missing record.');
    }
    /* Only when the package claims to carry kinds at all: a connection whose
       kind is missing would arrive as a label with nothing behind it. */
    if (connectionKinds.length > 0 && relationship.kindId !== undefined && !kindIds.has(relationship.kindId)) {
      throw new PackageError('A packaged connection names a kind that is not in the package.');
    }
  }
  for (const document of documents) {
    for (const entityId of asArray(document.entityIds)) {
      if (!entityIds.has(entityId)) throw new PackageError('A packaged document references a missing record.');
    }
    const documentPath = join(root, ...String(document.path).split('/'));
    if (!existsSync(documentPath) || !statSync(documentPath).isFile()) {
      throw new PackageError(`A document file is missing: ${document.path}.`);
    }
  }
  const assetIds = new Set(assetIndex.map((entry) => entry.assetId));
  for (const entry of assetIndex) {
    const assetPath = join(root, ...String(entry.path).split('/'));
    if (!existsSync(assetPath) || !statSync(assetPath).isFile()) {
      throw new PackageError(`An asset file is missing: ${entry.path}.`);
    }
  }
  for (const world of worlds) {
    for (const ref of [world.coverAssetId, world.backgroundAssetId]) {
      if (ref && !assetIds.has(ref)) throw new PackageError('A world profile references a missing asset.');
    }
  }
  /* `fullBodyAssetId` is what Protocol 1 called the second display slot. Both
     names are checked so a package from either protocol is really verified —
     naming only the retired one is how three consumers came to check nothing. */
  for (const character of characters) {
    for (const ref of [character.portraitAssetId, character.tileAssetId, character.fullBodyAssetId]) {
      if (ref && !assetIds.has(ref)) throw new PackageError('A character profile references a missing asset.');
    }
  }
  for (const [slot, selected] of Object.entries(content.selections ?? {})) {
    for (const entityId of asArray(selected)) {
      if (!entityIds.has(entityId)) throw new PackageError(`Selection “${slot}” references a missing record.`);
    }
  }
  for (const [setKey, items] of Object.entries(content.assetSets ?? {})) {
    for (const item of asArray(items)) {
      if (!assetIds.has(item.assetId)) throw new PackageError(`Asset set “${setKey}” references a missing asset.`);
    }
  }

  return new PackageInfo({
    root, manifest, contract, content, entities, worlds, characters,
    relationships, connectionKinds, documents, assetIndex, checksums, tags,
    protocolVersion, renamedFrom: renames,
  });
}

/** Read current.json from a linked World Hub production folder. */
export function readCurrentPointer(productionDir) {
  try {
    const pointer = JSON.parse(readFileSync(join(productionDir, 'current.json'), 'utf-8'));
    if (typeof pointer !== 'object' || pointer === null || Array.isArray(pointer)) return null;
    return pointer.publicationId ? pointer : null;
  } catch {
    return null;
  }
}
