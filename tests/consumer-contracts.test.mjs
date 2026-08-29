import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTestLibrary } from './helpers.mjs';
import { vocabularyVersion } from '../electron/services/vocabulary.js';
import { PROTOCOL_VERSION } from '../electron/services/versions.js';
import { validateContractJson } from '../electron/services/contract-service.js';
import { validateProduction } from '../electron/services/production-service.js';
import { verifyPublication } from '../electron/services/publication-service.js';
import {
  loadConsumerContract, CONSUMER_BUILDERS,
  buildTaskStampsProduction, buildStickerAlbumProduction, buildHeroCollectorProduction, buildChatBotProduction,
} from './fixtures/consumer-fixtures.mjs';

const SLUGS = ['taskstamps', 'chatbot', 'stickeralbum', 'herocollector'];

test('all four consumer contracts validate against Contract version 1', () => {
  for (const slug of SLUGS) {
    const contract = loadConsumerContract(slug);
    const issues = validateContractJson(contract);
    assert.deepEqual(issues, [], `${slug}: ${JSON.stringify(issues, null, 2)}`);
    assert.ok(contract.supportedProtocolVersions.includes(PROTOCOL_VERSION),
      `${slug} must declare it can read the protocol this library publishes`);
  }
});

for (const slug of SLUGS) {
  test(`${slug}: representative production publishes and verifies completely`, async (t) => {
    const { library, root, cleanup } = await makeTestLibrary();
    t.after(cleanup);

    const built = await CONSUMER_BUILDERS[slug](library);
    const validation = validateProduction(library, built.production.id);
    assert.equal(validation.errors, 0, JSON.stringify(validation.issues, null, 2));
    assert.deepEqual(verifyPublication(library, built.publication.id), { ok: true, problems: [] });

    const manifest = JSON.parse(fs.readFileSync(
      path.join(root, ...built.publication.directory.split('/'), 'manifest.json'), 'utf8'));
    assert.equal(manifest.applicationType, loadConsumerContract(slug).appType);
    assert.equal(manifest.protocolVersion, 2);
    assert.equal(manifest.vocabularyVersion, vocabularyVersion(),
      'the package names the vocabulary its files were published under');
    assert.ok(Number.isInteger(manifest.contract.revision),
      'the contract revision is recorded as a receipt, under a name no one will gate on');
    assert.equal('version' in manifest.contract, false, 'and the ambiguous old name is gone');
  });
}

test('taskstamps package carries 15 ordered stamps and per-stamp sound numbers', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const built = await buildTaskStampsProduction(library);
  const dir = path.join(root, ...built.publication.directory.split('/'));
  const content = JSON.parse(fs.readFileSync(path.join(dir, 'production', 'content.json'), 'utf8'));
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'assets', 'index.json'), 'utf8'));

  const hero = built.perCharacter[0].hero;
  const stamps = content.assetSets[`stamps:${hero.id}`];
  assert.equal(stamps.length, 15, 'exactly fifteen ordered stamps');
  assert.deepEqual(stamps.map((item) => item.assetId), built.perCharacter[0].stamps.map((asset) => asset.id), 'order preserved');
  const sounds = content.assetSets[`stamp_sounds:${hero.id}`];
  assert.equal(sounds[0].values.stamp_number, 5, 'per-stamp sound remembers its stamp');
  /* Which recipe a stamp ships as is the contract's business, not this
     test's. Reading it from the contract is the same rule the consuming
     applications follow, and it means a rename needs no edit here. */
  const stampRecipes = loadConsumerContract('taskstamps').entitySelections
    .flatMap((selection) => selection.assetSets ?? [])
    .find((set) => set.id === 'stamps').recipes;
  for (const stamp of stamps) {
    for (const recipeId of stampRecipes) {
      assert.ok(index.some((entry) => entry.assetId === stamp.assetId && entry.recipeId === recipeId),
        `stamp rendition packaged as ${recipeId}`);
    }
  }
});

test('stickeralbum package carries 10 slots, itemFields, packs with nested distributions, and pack art', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const built = await buildStickerAlbumProduction(library);
  const dir = path.join(root, ...built.publication.directory.split('/'));
  const content = JSON.parse(fs.readFileSync(path.join(dir, 'production', 'content.json'), 'utf8'));
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'assets', 'index.json'), 'utf8'));

  assert.equal(content.values.collection_title, 'Emberfall Collection');
  const hero = built.perCharacter[0].hero;
  const stickers = content.assetSets[`stickers:${hero.id}`];
  assert.equal(stickers.length, 10);
  assert.equal(stickers[0].values.sticker_name, `${hero.name} №1`);
  assert.ok(stickers[9].values.sticker_sound, 'legendary slot has its voice line');
  assert.ok(index.some((entry) => entry.assetId === stickers[9].values.sticker_sound), 'voice line referenced by an itemField is packaged');

  assert.equal(content.values.packs.length, 2);
  assert.equal(content.values.packs[0].pack_distribution[0].dist_selector, 'standard');
  /* Which recipe pack art ships as is the contract's business, not this
     test's — the same rule the consuming applications follow. */
  const packRecipes = loadConsumerContract('stickeralbum').productionFields
    .flatMap((field) => field.fields ?? field.itemFields ?? [])
    .find((field) => field.id === 'pack_image').recipes;
  for (const recipeId of packRecipes) {
    assert.ok(index.some((entry) => entry.assetId === built.packArt.id && entry.recipeId === recipeId),
      `pack art assetRef packaged as ${recipeId}`);
  }
});

test('herocollector package carries nested campaign, relic, expedition, and crisis structures with their art', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const built = await buildHeroCollectorProduction(library);
  const dir = path.join(root, ...built.publication.directory.split('/'));
  const content = JSON.parse(fs.readFileSync(path.join(dir, 'production', 'content.json'), 'utf8'));
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'assets', 'index.json'), 'utf8'));

  const worldId = built.canon.world.id;
  const worldValues = content.entityValues[worldId];
  assert.equal(worldValues.hc_campaign_nodes.length, 30);
  assert.equal(worldValues.hc_campaign_nodes[10].node_grade, 'improved');
  assert.equal(worldValues.hc_campaign_nodes[5].node_encounter_character, built.perCharacter[0].hero.id, 'world encounters name heroes');
  assert.equal(worldValues.hc_relic_pieces.length, 4, 'the relic comes in four pieces');
  assert.equal(worldValues.hc_relic_name, 'The Star Cage');
  assert.equal(worldValues.hc_mastery_skins[0].ms_character, built.perCharacter[0].hero.id);
  assert.ok(index.some((entry) => entry.assetId === built.relicArt.id), 'relic piece art from a nested list is packaged');
  assert.ok(index.some((entry) => entry.assetId === built.crisisArt.id && entry.recipeId === 'tile_16x9'), 'crisis art packaged with its recipe');

  assert.equal(content.values.hc_crises[0].crisis_fronts.length, 3);
  assert.equal(content.values.hc_crises[0].crisis_world, worldId);
  assert.equal(content.values.hc_expedition_templates[0].exptpl_reward_package, 'reward_basic');

  const heroValues = content.entityValues[built.perCharacter[0].hero.id];
  assert.equal(heroValues.hc_archetype, 'leader');
  assert.equal(heroValues.hc_equipment[1].equip_slot, 'signature');
  assert.ok(index.some((entry) => entry.assetId === built.perCharacter[0].equipArt.id), 'equipment art packaged');
});

test('chatbot package separates canon from AI guidance and includes linked lore', async (t) => {
  const { library, root, cleanup } = await makeTestLibrary();
  t.after(cleanup);
  const built = await buildChatBotProduction(library);
  const dir = path.join(root, ...built.publication.directory.split('/'));
  const content = JSON.parse(fs.readFileSync(path.join(dir, 'production', 'content.json'), 'utf8'));
  const characters = JSON.parse(fs.readFileSync(path.join(dir, 'catalog', 'characters.json'), 'utf8'));
  const documents = JSON.parse(fs.readFileSync(path.join(dir, 'catalog', 'documents.json'), 'utf8'));

  const hero = built.perCharacter[0].hero;
  const profile = characters.find((entry) => entry.id === hero.id);
  assert.match(profile.personality, /stubborn/i, 'canonical profile ships in the catalog');
  assert.equal(content.entityValues[hero.id].char_behavior_rules, 'Never breaks character; never narrates the user.');
  assert.ok(!JSON.stringify(profile).includes('Never breaks character'), 'AI guidance stays out of canon');

  assert.equal(documents.length, 1, 'linked lore document included');
  assert.ok(fs.existsSync(path.join(dir, ...documents[0].path.split('/'))));
  const sprites = content.assetSets[`sprites:${hero.id}`];
  assert.deepEqual(sprites.map((item) => item.values.expression), ['neutral', 'happy']);
});
