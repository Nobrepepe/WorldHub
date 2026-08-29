#!/usr/bin/env node
/**
 * Set a new consuming application up against World Hub.
 *
 * The four applications that came first each acquired the integration by hand,
 * and each arrived at a slightly different answer — four package readers, four
 * readings of the version fields, one of them wrong. A new app should not get
 * the chance to repeat that: this scaffolds the contract, vendors the shared
 * kit, registers the app, and generates its conformance fixtures, so the whole
 * standard is in place before anyone writes a line of it.
 *
 *   node scripts/kit-init.mjs <slug> <repo-name> <app-type> [--runtime js|py]
 *
 * Example:
 *   node scripts/kit-init.mjs fieldguide FieldGuide field-guide.bestiary
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncConsumer } from './kit-sync.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS = path.join(ROOT, '..');
const REGISTRY = path.join(ROOT, 'kit', 'consumers.json');

const SLUG = /^[a-z][a-z0-9]*$/;
const APP_TYPE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

/**
 * A contract that is valid, current, and obviously a starting point: one
 * world, a small cast, one portrait each. Everything an app actually needs is
 * added by editing this file and re-importing it in World Hub.
 */
function starterContract(appType, repo) {
  return {
    format: 'world-hub-application-contract',
    contractFormatVersion: 1,
    appType,
    name: repo,
    description: `Worlds and characters for ${repo}. Replace this with what the application really needs.`,
    supportedProtocolVersions: [1, 2],
    productionFields: [
      {
        id: 'collection_title',
        label: 'Title',
        type: 'shortText',
        required: true,
        maxLength: 120,
        section: 'Presentation',
      },
    ],
    entitySelections: [
      {
        id: 'worlds',
        label: 'Worlds',
        entityTypes: ['world'],
        min: 1,
        assetSets: [{
          id: 'world_cover',
          label: 'Cover',
          kinds: ['image'],
          roles: ['world.cover'],
          recipes: ['tile_16x9', 'thumbnail_square'],
          exact: 1,
        }],
      },
      {
        id: 'cast',
        label: 'Characters',
        entityTypes: ['character'],
        min: 1,
        ordered: true,
        assetSets: [{
          id: 'portrait',
          label: 'Portrait',
          kinds: ['image'],
          roles: ['character.portrait'],
          recipes: ['portrait_3x4', 'thumbnail_square'],
          exact: 1,
        }],
      },
    ],
    assetSets: [],
    documents: { mode: 'linked' },
    requiredRecipes: ['tile_16x9', 'portrait_3x4', 'thumbnail_square'],
  };
}

function readRegistry() {
  return JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
}

function registerConsumer(entry) {
  const registry = readRegistry();
  if (registry.consumers.some((known) => known.slug === entry.slug)) return false;
  registry.consumers.push(entry);
  registry.consumers.sort((a, b) => a.slug.localeCompare(b.slug));
  fs.writeFileSync(REGISTRY, `${JSON.stringify(registry, null, 2)}\n`);
  return true;
}

export function initConsumer({ slug, repo, appType, runtime, projectsDir = PROJECTS }) {
  const appRoot = path.join(projectsDir, repo);
  const steps = [];

  for (const relative of ['worldhub', path.join('tests', 'fixtures', 'worldhub')]) {
    const dir = path.join(appRoot, relative);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      steps.push(`created ${relative}/`);
    }
  }

  const contractFile = path.join(appRoot, 'worldhub', 'application-contract.json');
  if (fs.existsSync(contractFile)) {
    steps.push('kept the existing worldhub/application-contract.json');
  } else {
    fs.writeFileSync(contractFile, `${JSON.stringify(starterContract(appType, repo), null, 2)}\n`);
    steps.push('wrote a starter worldhub/application-contract.json');
  }

  if (registerConsumer({ slug, repo, runtime, appType })) steps.push('registered in kit/consumers.json');
  else steps.push('already registered in kit/consumers.json');

  const synced = syncConsumer(slug, { check: false, projectsDir });
  steps.push(`vendored the kit (${synced.kit.length} file(s))`);
  return { appRoot, steps, runtime };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const runtimeFlag = args.indexOf('--runtime');
  const runtime = runtimeFlag === -1 ? 'js' : args[runtimeFlag + 1];
  const [slug, repo, appType] = args.filter((arg) => !arg.startsWith('--') && arg !== runtime);

  const fail = (message) => { console.error(message); process.exit(2); };
  if (!slug || !repo || !appType) {
    fail('usage: node scripts/kit-init.mjs <slug> <repo-name> <app-type> [--runtime js|py]');
  }
  if (!SLUG.test(slug)) fail(`slug "${slug}" must be lowercase letters and digits, starting with a letter.`);
  if (!APP_TYPE.test(appType)) fail(`app type "${appType}" must look like "field-guide.bestiary".`);
  if (!['js', 'py'].includes(runtime)) fail('runtime must be js or py.');

  const { appRoot, steps } = initConsumer({ slug, repo, appType, runtime });
  for (const step of steps) console.log(`  ${step}`);
  console.log(`\n${repo} is registered. Next:`);
  console.log(`  1. edit ${path.relative(PROJECTS, path.join(appRoot, 'worldhub', 'application-contract.json'))} to describe what the app needs`);
  console.log('  2. import it in World Hub (Contracts → Import from file)');
  console.log(`  3. node scripts/generate-consumer-fixtures.mjs ${slug}`);
  console.log(`  4. read vendor/worldhub-kit/CONSUMER_GUIDE.md, then run its verify from the app's test command`);
}
