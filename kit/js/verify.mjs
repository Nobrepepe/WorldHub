#!/usr/bin/env node
/**
 * Conformance check for a World Hub consuming application.
 *
 * Every rule the seam depends on is checked here, so the standard is
 * something an application runs rather than something a document asks it to
 * remember. Wire it into the application's own test command; a new consumer
 * gets the whole standard by vendoring the kit.
 *
 *   node vendor/worldhub-kit/js/verify.mjs [--app-root <dir>]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.venv', '__pycache__', 'vendor', 'release', 'coverage']);
const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py']);

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

class Report {
  constructor() { this.failures = []; this.notes = []; }
  fail(check, detail) { this.failures.push({ check, detail }); }
  note(text) { this.notes.push(text); }
}

function sourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (SOURCE_EXT.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
        out.push(full);
      }
    }
  };
  for (const top of ['src', 'electron', 'app', 'lib']) {
    const dir = join(root, top);
    if (existsSync(dir)) walk(dir);
  }
  return out;
}

/* 1 — the vendored kit is the kit, unedited */
function checkLock(appRoot, report) {
  const vendor = join(appRoot, 'vendor', 'worldhub-kit');
  const lockFile = join(vendor, '.kit-lock.json');
  if (!existsSync(vendor)) {
    report.fail('kit', 'vendor/worldhub-kit is missing. Run kit-sync from World Hub.');
    return null;
  }
  if (!existsSync(lockFile)) {
    report.fail('kit', 'vendor/worldhub-kit/.kit-lock.json is missing. Run kit-sync from World Hub.');
    return null;
  }
  const lock = readJson(lockFile);
  for (const [relPath, expected] of Object.entries(lock.files)) {
    const file = join(vendor, ...relPath.split('/'));
    if (!existsSync(file)) {
      report.fail('kit', `vendored file is missing: ${relPath}`);
      continue;
    }
    if (sha256(readFileSync(file)) !== expected) {
      report.fail('kit', `vendored file was edited by hand: ${relPath}. Change it in World Hub's kit/ and re-sync.`);
    }
  }
  report.note(`kit v${lock.kitVersion}, vocabulary v${lock.vocabularyVersion}, ${Object.keys(lock.files).length} files`);
  return lock;
}

/* 2 — the application's contract is valid against the published vocabulary */
function checkContract(appRoot, vocabulary, report) {
  const file = join(appRoot, 'worldhub', 'application-contract.json');
  if (!existsSync(file)) {
    report.fail('contract', 'worldhub/application-contract.json is missing.');
    return null;
  }
  let contract;
  try { contract = readJson(file); } catch (error) {
    report.fail('contract', `worldhub/application-contract.json is not valid JSON: ${error.message}`);
    return null;
  }
  const formatVersion = contract.contractFormatVersion ?? contract.contractVersion;
  if (formatVersion !== 1) {
    report.fail('contract', `contractFormatVersion must be 1, found ${JSON.stringify(formatVersion)}.`);
  }
  const roles = new Set(vocabulary.roles.map((role) => role.id));
  const recipes = new Set(vocabulary.recipes.map((recipe) => recipe.id));

  const seen = { roles: new Set(), recipes: new Set() };
  const visitSets = (sets) => {
    for (const set of sets ?? []) {
      for (const role of set.roles ?? set.assetRoles ?? []) seen.roles.add(role);
      for (const recipe of set.recipes ?? []) seen.recipes.add(recipe);
      visitFields(set.itemFields);
    }
  };
  const visitFields = (fields) => {
    for (const field of fields ?? []) {
      if (field.type === 'assetRef') {
        for (const role of field.assetRoles ?? field.roles ?? []) seen.roles.add(role);
        for (const recipe of field.recipes ?? []) seen.recipes.add(recipe);
      }
      visitFields(field.fields);
      visitFields(field.itemFields);
    }
  };
  visitSets(contract.assetSets);
  for (const selection of contract.entitySelections ?? []) {
    visitSets(selection.assetSets);
    visitFields(selection.fields);
  }
  visitFields(contract.productionFields);
  for (const recipe of contract.requiredRecipes ?? []) seen.recipes.add(recipe);

  for (const role of [...seen.roles].sort()) {
    if (!roles.has(role)) report.fail('contract', `asks for role "${role}", which World Hub no longer publishes.`);
  }
  for (const recipe of [...seen.recipes].sort()) {
    if (!recipes.has(recipe)) report.fail('contract', `asks for recipe "${recipe}", which World Hub no longer publishes.`);
  }
  const protocols = contract.supportedProtocolVersions ?? [];
  if (!protocols.includes(2)) {
    report.fail('contract', `supportedProtocolVersions is ${JSON.stringify(protocols)}; it must include 2 now that the reader handles it.`);
  }
  report.note(`contract declares ${seen.roles.size} roles and ${seen.recipes.size} recipes, all current`);
  return contract;
}

/* 3 — no recipe name is written into application code */
function checkNoRecipeLiterals(appRoot, vocabulary, report) {
  const names = vocabulary.recipes.map((recipe) => recipe.id).filter((id) => id !== 'original');
  const retired = Object.values(vocabulary.renamedFrom?.recipes ?? {}).flat();
  const pattern = new RegExp(`['"\`](${[...names, ...retired].join('|')})['"\`]`);
  let offenders = 0;
  for (const file of sourceFiles(appRoot)) {
    const text = readFileSync(file, 'utf8');
    text.split('\n').forEach((line, index) => {
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('#') || line.trimStart().startsWith('*')) return;
      const match = pattern.exec(line);
      if (match) {
        offenders += 1;
        report.fail('recipes',
          `${relative(appRoot, file)}:${index + 1} names the recipe "${match[1]}" in code. Ask the package for recipesFor(setId) instead, so a rename in World Hub needs no change here.`);
      }
    });
  }
  if (offenders === 0) report.note('no recipe names written into application code');
}

/* 4 — nobody gates compatibility on the contract's revision counter */
function checkNoRevisionGating(appRoot, report) {
  const suspicious = [
    /SUPPORTED_CONTRACT_REVISIONS/,
    /contract\s*\[\s*['"]version['"]\s*\]\s*(?:not\s+in|in)\s/,
    /contract\.version.*(?:includes|has)\s*\(/,
  ];
  let offenders = 0;
  for (const file of sourceFiles(appRoot)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      for (const pattern of suspicious) {
        if (pattern.test(line)) {
          offenders += 1;
          report.fail('versions',
            `${relative(appRoot, file)}:${index + 1} appears to gate on the contract's revision counter. Gate on the embedded contract's contractFormatVersion; the revision is a receipt.`);
        }
      }
    });
  }
  if (offenders === 0) report.note('compatibility is not gated on the revision counter');
}

/* 5 — conformance fixtures were built under the vocabulary in force */
function checkFixturesAreCurrent(appRoot, lock, report) {
  const dir = join(appRoot, 'tests', 'fixtures', 'worldhub');
  if (!existsSync(dir)) {
    report.note('no conformance fixtures present');
    return;
  }
  const stampFile = join(dir, 'generated.json');
  if (!existsSync(stampFile)) {
    report.fail('fixtures',
      'tests/fixtures/worldhub/generated.json is missing, so nothing records which vocabulary these fixtures were built under. Regenerate them from World Hub.');
    return;
  }
  const stamp = readJson(stampFile);
  if (stamp.vocabularyVersion !== lock.vocabularyVersion) {
    report.fail('fixtures',
      `fixtures were generated under art vocabulary ${stamp.vocabularyVersion}, but the kit publishes ${lock.vocabularyVersion}. They are testing a vocabulary that has moved — regenerate them.`);
    return;
  }
  report.note(`fixtures generated under vocabulary v${stamp.vocabularyVersion}`);
}

/* 6 — the two install-time traps that are invisible until they fail */
function checkInstallEnvironment(appRoot, contract, report) {
  const htmlFiles = [];
  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith('.html')) htmlFiles.push(full);
    }
  };
  walk(appRoot);

  const shipsAudio = JSON.stringify(contract ?? {}).includes('"audio"');
  const policies = htmlFiles
    .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
    .filter(({ text }) => text.includes('Content-Security-Policy'));

  if (policies.length === 0) {
    report.note('no Content-Security-Policy found (not a renderer app?)');
  }
  let cspOk = 0;
  for (const { file, text } of policies) {
    const csp = /content\s*=\s*"([^"]*)"/i.exec(text.slice(text.indexOf('Content-Security-Policy')))?.[1] ?? '';
    const imgSrc = /img-src([^;]*)/i.exec(csp)?.[1] ?? '';
    if (!/[a-z][a-z0-9+.-]*:(?!\/)/i.test(imgSrc.replace(/\bdata:/g, ''))) {
      report.fail('install',
        `${relative(appRoot, file)} has img-src "${imgSrc.trim()}", which admits no private scheme. Packaged art is served over one, and the renderer will refuse every image with no error you can see.`);
    }
    if (shipsAudio) {
      const mediaSrc = /media-src([^;]*)/i.exec(csp)?.[1];
      if (!mediaSrc || !/[a-z][a-z0-9+.-]*:(?!\/)/i.test(mediaSrc)) {
        report.fail('install',
          `${relative(appRoot, file)} ships audio in its contract but its CSP has no media-src admitting a private scheme.`);
      }
    }
    cspOk += 1;
  }
  /* A check that says nothing when it passes cannot be told apart from a
     check that never ran, which is the whole failure mode this suite exists
     to prevent. */
  if (cspOk > 0) {
    report.note(`${cspOk} Content-Security-Policy admits the app's media scheme${shipsAudio ? ' for images and audio' : ''}`);
  }

  let staging = 0;
  for (const file of sourceFiles(appRoot)) {
    const text = readFileSync(file, 'utf8');
    if (!/worldhub|world_hub|hub/i.test(text)) continue;
    for (const [index, line] of text.split('\n').entries()) {
      if (/mkdtemp|TemporaryDirectory|mkdtempSync/.test(line) && /tmpdir\(\)|gettempdir\(\)|getPath\(['"]temp['"]\)/.test(line)) {
        staging += 1;
        report.fail('install',
          `${relative(appRoot, file)}:${index + 1} stages a package in the OS temp directory. Activation ends in a rename into the app's data directory, and that rename fails with EXDEV across filesystems — stage inside the app's own data directory.`);
      }
    }
  }
  if (staging === 0) report.note('package staging does not use the OS temp directory');
}

export function verify(appRoot) {
  const report = new Report();
  const lock = checkLock(appRoot, report);
  const vendor = join(appRoot, 'vendor', 'worldhub-kit');
  const vocabularyFile = existsSync(join(vendor, 'vocabulary.json'))
    ? join(vendor, 'vocabulary.json')
    : join(KIT_DIR, 'vocabulary.json');
  const vocabulary = readJson(vocabularyFile);
  const contract = checkContract(appRoot, vocabulary, report);
  checkNoRecipeLiterals(appRoot, vocabulary, report);
  checkNoRevisionGating(appRoot, report);
  if (lock) checkFixturesAreCurrent(appRoot, lock, report);
  checkInstallEnvironment(appRoot, contract, report);
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const flag = process.argv.indexOf('--app-root');
  const appRoot = resolve(flag === -1 ? process.cwd() : process.argv[flag + 1]);
  const report = verify(appRoot);
  for (const note of report.notes) console.log(`  ok   ${note}`);
  for (const { check, detail } of report.failures) console.error(`  FAIL [${check}] ${detail}`);
  if (report.failures.length > 0) {
    console.error(`\n${report.failures.length} conformance failure(s) in ${appRoot}`);
    process.exit(1);
  }
  console.log(`\nWorld Hub conformance: ${appRoot} passes.`);
}
