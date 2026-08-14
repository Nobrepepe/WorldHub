/**
 * Synthetic, redistributable consumer fixtures. Builds a complete
 * representative Production for each consumer contract inside a test
 * library, exercising every field type, nested structure, reference,
 * document mode, asset set, and recipe the contract declares.
 *
 * variant 1 is the baseline; variant 2 is a plausible update (renamed
 * records, one replaced artwork, one added character) used for update
 * and rollback testing. None of this uses private creative assets.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { createContract } from '../../electron/services/contract-service.js';
import { createEntity, updateEntity, createRelationship } from '../../electron/services/entity-service.js';
import { importAsset, setAssetLinks, addAssetVersion } from '../../electron/services/asset-service.js';
import { createDocument } from '../../electron/services/document-service.js';
import {
  createProduction, setProductionValue, setSelection, setAssetSetItems, setProductionStatus,
} from '../../electron/services/production-service.js';
import { publishProduction } from '../../electron/services/publication-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CONTRACTS_DIR = path.join(__dirname, 'contracts');

export function loadConsumerContract(slug) {
  return JSON.parse(fs.readFileSync(path.join(CONTRACTS_DIR, `${slug}.json`), 'utf8'));
}

/* ---------------- deterministic synthetic media ---------------- */

/** A small deterministic gradient PNG; the seed changes the pixels. */
export async function fixturePng(seed, width = 96, height = 96) {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = (x * 7 + seed * 31) % 256;
      raw[i + 1] = (y * 5 + seed * 17) % 256;
      raw[i + 2] = (x + y + seed * 53) % 256;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** A minimal valid WAV: `frames` bytes of shaped silence. */
export function fixtureWav(seed, frames = 32) {
  const buffer = Buffer.alloc(44 + frames);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + frames, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(8000, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(frames, 40);
  for (let i = 0; i < frames; i++) buffer[44 + i] = 128 + ((i * seed) % 64);
  return buffer;
}

let seedCounter = 1;
export async function importImage(library, title, { entityId = null, role = null, seed = null } = {}) {
  const s = seed ?? seedCounter++;
  const asset = await importAsset(library, {
    buffer: await fixturePng(s),
    filename: `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`,
    title,
  });
  if (entityId && role) setAssetLinks(library, asset.id, [{ entityId, role }]);
  return asset;
}

export async function importSound(library, title, { entityId = null, role = null, seed = null } = {}) {
  const s = seed ?? seedCounter++;
  const asset = await importAsset(library, {
    buffer: fixtureWav(s),
    filename: `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.wav`,
    title,
  });
  if (entityId && role) setAssetLinks(library, asset.id, [{ entityId, role }]);
  return asset;
}

function items(assets) {
  return assets.map((asset) => ({ assetId: asset.id }));
}

/* ---------------- shared canon ---------------- */

/** Two worlds, three characters, a location, lore documents. */
export async function buildCanon(library, { variant = 1 } = {}) {
  const world = createEntity(library, { type: 'world', name: variant === 1 ? 'Emberfall' : 'Emberfall Reborn' });
  updateEntity(library, world.id, {
    status: 'canonical',
    summary: 'A city warmed by a captive star.',
    profile: { tagline: 'Keep the last light burning', genre: 'Mythic fantasy', tone: 'Warm, defiant' },
  });
  const heroes = [];
  const heroNames = variant === 1 ? ['Ash', 'Brialla', 'Cato'] : ['Ash the Rekindled', 'Brialla', 'Cato'];
  for (const name of heroNames) {
    const hero = createEntity(library, { type: 'character', name, worldId: world.id });
    updateEntity(library, hero.id, {
      status: 'canonical',
      summary: `${name} of Emberfall.`,
      aliases: [`${name} of the Ember`],
      profile: {
        role: 'Keeper of the flame',
        ageText: 'Young adult',
        appearance: `${name} wears ember-lined travel clothes.`,
        personality: 'Steady, wry, quietly stubborn.',
        biography: `${name} grew up beneath the star-cage.`,
        voice: 'Low and certain.',
      },
    });
    heroes.push(hero);
  }
  if (variant === 2) {
    const dara = createEntity(library, { type: 'character', name: 'Dara', worldId: world.id });
    updateEntity(library, dara.id, { status: 'canonical', summary: 'A newcomer from the cold quarter.' });
    heroes.push(dara);
  }
  const place = createEntity(library, { type: 'location', name: 'The Star Cage', worldId: world.id });
  updateEntity(library, place.id, { status: 'canonical', summary: 'The lattice holding the captive star.' });
  createRelationship(library, {
    sourceId: heroes[0].id, targetId: place.id, relType: 'guardian', label: 'guards', inverseLabel: 'guarded by',
  });
  const lore = createDocument(library, {
    title: 'The Emberfall Accord',
    entityIds: [world.id, heroes[0].id],
    content: '# The Emberfall Accord\n\nThe city agreed to feed the star one memory a year.',
  });
  return { world, heroes, place, lore };
}

/* ---------------- per-consumer productions ---------------- */

export async function buildTaskStampsProduction(library, { variant = 1 } = {}) {
  const contract = createContract(library, loadConsumerContract('taskstamps'));
  const canon = await buildCanon(library, { variant });
  const { world, heroes } = canon;

  const cover = await importImage(library, 'Emberfall cover', { entityId: world.id, role: 'world.cover', seed: 100 + variant });
  const production = createProduction(library, {
    name: variant === 1 ? 'Emberfall Stamps' : 'Emberfall Stamps v2',
    contractId: contract.contractId,
    worldId: world.id,
  });
  setSelection(library, production.id, 'stamp_worlds', [world.id]);
  setAssetSetItems(library, production.id, { slot: 'world_cover', entityId: world.id, items: items([cover]) });

  const characters = heroes.slice(0, variant === 1 ? 2 : 3);
  setSelection(library, production.id, 'stamp_characters', characters.map((hero) => hero.id));
  const perCharacter = [];
  for (const [index, hero] of characters.entries()) {
    const portrait = await importImage(library, `${hero.name} portrait`, { entityId: hero.id, role: 'character.portrait', seed: 200 + index * 20 + variant });
    setAssetSetItems(library, production.id, { slot: 'portrait', entityId: hero.id, items: items([portrait]) });
    const stamps = [];
    for (let n = 1; n <= 15; n++) {
      stamps.push(await importImage(library, `${hero.name} stamp ${n}`, { entityId: hero.id, role: 'character.collectible', seed: 1000 + index * 100 + n + (variant === 2 && n === 1 ? 9999 : 0) }));
    }
    setAssetSetItems(library, production.id, { slot: 'stamps', entityId: hero.id, items: items(stamps) });
    const cue = await importSound(library, `${hero.name} cue`, { entityId: hero.id, role: 'audio.character_cue', seed: 300 + index });
    setAssetSetItems(library, production.id, { slot: 'default_sound', entityId: hero.id, items: items([cue]) });
    const line = await importSound(library, `${hero.name} stamp five line`, { entityId: hero.id, role: 'audio.voice_line', seed: 400 + index });
    setAssetSetItems(library, production.id, {
      slot: 'stamp_sounds', entityId: hero.id,
      items: [{ assetId: line.id, values: { stamp_number: 5 } }],
    });
    perCharacter.push({ hero, portrait, stamps, cue, line });
  }
  setProductionStatus(library, production.id, 'ready');
  const publication = await publishProduction(library, production.id);
  return { contract, canon, production, publication, perCharacter, cover };
}

export async function buildChatBotProduction(library, { variant = 1 } = {}) {
  const contract = createContract(library, loadConsumerContract('chatbot'));
  const canon = await buildCanon(library, { variant });
  const { world, heroes, place } = canon;

  const cover = await importImage(library, 'Emberfall chat cover', { entityId: world.id, role: 'world.cover', seed: 500 + variant });
  const background = await importImage(library, 'Emberfall session backdrop', { entityId: world.id, role: 'world.background', seed: 510 + variant });
  const placeArt = await importImage(library, 'Star Cage backdrop', { entityId: place.id, role: 'location.background', seed: 520 });

  const production = createProduction(library, {
    name: variant === 1 ? 'Emberfall Cast' : 'Emberfall Cast v2',
    contractId: contract.contractId,
    worldId: world.id,
  });
  setProductionValue(library, production.id, { scope: 'production', field: 'cast_notes', value: 'Synthetic conformance cast.' });
  setSelection(library, production.id, 'cb_worlds', [world.id]);
  setProductionValue(library, production.id, { scope: 'entity', entityId: world.id, field: 'world_style_guide', value: 'Write warmly; short paragraphs; no modern slang.' });
  setAssetSetItems(library, production.id, { slot: 'cb_world_cover', entityId: world.id, items: items([cover]) });
  setAssetSetItems(library, production.id, { slot: 'session_background', entityId: world.id, items: items([background]) });

  const cast = heroes.slice(0, variant === 1 ? 2 : 3);
  setSelection(library, production.id, 'cast', cast.map((hero) => hero.id));
  const perCharacter = [];
  for (const [index, hero] of cast.entries()) {
    setProductionValue(library, production.id, { scope: 'entity', entityId: hero.id, field: 'char_behavior_rules', value: 'Never breaks character; never narrates the user.' });
    setProductionValue(library, production.id, { scope: 'entity', entityId: hero.id, field: 'char_ai_instructions', value: 'Enjoys ember metaphors.' });
    setProductionValue(library, production.id, { scope: 'entity', entityId: hero.id, field: 'char_relationship_to_user', value: 'trusted friend' });
    const tile = await importImage(library, `${hero.name} tile`, { entityId: hero.id, role: 'character.identity_tile', seed: 600 + index });
    setAssetSetItems(library, production.id, { slot: 'tile', entityId: hero.id, items: items([tile]) });
    const neutral = await importImage(library, `${hero.name} neutral sprite`, { entityId: hero.id, role: 'character.expression', seed: 700 + index * 10 });
    const happy = await importImage(library, `${hero.name} happy sprite`, { entityId: hero.id, role: 'character.expression', seed: 701 + index * 10 });
    setAssetSetItems(library, production.id, {
      slot: 'sprites', entityId: hero.id,
      items: [
        { assetId: neutral.id, values: { expression: 'neutral' } },
        { assetId: happy.id, values: { expression: 'happy' } },
      ],
    });
    perCharacter.push({ hero, tile, neutral, happy });
  }

  setSelection(library, production.id, 'places', [place.id]);
  setProductionValue(library, production.id, { scope: 'entity', entityId: place.id, field: 'loc_mood_tags', value: 'quiet, luminous' });
  setAssetSetItems(library, production.id, { slot: 'location_background', entityId: place.id, items: items([placeArt]) });

  setProductionStatus(library, production.id, 'ready');
  const publication = await publishProduction(library, production.id);
  return { contract, canon, production, publication, perCharacter, cover, background, placeArt };
}

export async function buildStickerAlbumProduction(library, { variant = 1 } = {}) {
  const contract = createContract(library, loadConsumerContract('stickeralbum'));
  const canon = await buildCanon(library, { variant });
  const { heroes } = canon;

  const production = createProduction(library, {
    name: variant === 1 ? 'Emberfall Album' : 'Emberfall Album v2',
    contractId: contract.contractId,
    worldId: canon.world.id,
  });
  setProductionValue(library, production.id, { scope: 'production', field: 'collection_title', value: variant === 1 ? 'Emberfall Collection' : 'Emberfall Collection — Second Printing' });
  setProductionValue(library, production.id, { scope: 'production', field: 'collection_description', value: 'Synthetic conformance collection.' });
  setProductionValue(library, production.id, { scope: 'production', field: 'theme_color', value: '#e9a94f' });
  setProductionValue(library, production.id, { scope: 'production', field: 'collection_order', value: 1 });

  const packArt = await importImage(library, 'Ember pack art', { seed: 800 + variant });
  setProductionValue(library, production.id, {
    scope: 'production', field: 'packs',
    value: [
      {
        pack_name: 'Ember Pack',
        pack_description: 'Five stickers, mostly common.',
        pack_price: 250,
        pack_foil_rate: 0.1,
        pack_image: packArt.id,
        pack_distribution: [
          { dist_selector: 'standard', dist_quantity: 4 },
          { dist_selector: 'rare+', dist_quantity: 1 },
        ],
      },
      {
        pack_name: 'Star Pack',
        pack_description: 'Three stickers, rare or better.',
        pack_price: 600,
        pack_foil_rate: 0.25,
        pack_image: null,
        pack_distribution: [{ dist_selector: 'rare+', dist_quantity: 3 }],
      },
    ],
  });

  const cover = await importImage(library, 'Album cover', { seed: 810 + variant });
  setAssetSetItems(library, production.id, { slot: 'collection_cover', items: items([cover]) });

  const characters = heroes.slice(0, variant === 1 ? 2 : 3);
  setSelection(library, production.id, 'album_characters', characters.map((hero) => hero.id));
  const perCharacter = [];
  for (const [index, hero] of characters.entries()) {
    const portrait = await importImage(library, `${hero.name} album portrait`, { entityId: hero.id, role: 'character.portrait', seed: 900 + index * 30 + variant });
    setAssetSetItems(library, production.id, { slot: 'char_portrait', entityId: hero.id, items: items([portrait]) });
    const stickers = [];
    const stickerItems = [];
    for (let n = 1; n <= 10; n++) {
      const art = await importImage(library, `${hero.name} sticker ${n}`, { entityId: hero.id, role: 'character.collectible', seed: 2000 + index * 100 + n + (variant === 2 && n === 10 ? 7777 : 0) });
      stickers.push(art);
      const values = { sticker_name: `${hero.name} №${n}` };
      if (n === 1) values.sticker_flavor = 'The first spark.';
      if (n === 10) {
        const sound = await importSound(library, `${hero.name} legendary line`, { entityId: hero.id, role: 'audio.voice_line', seed: 950 + index });
        values.sticker_sound = sound.id;
      }
      stickerItems.push({ assetId: art.id, values });
    }
    setAssetSetItems(library, production.id, { slot: 'stickers', entityId: hero.id, items: stickerItems });
    perCharacter.push({ hero, portrait, stickers });
  }

  setProductionStatus(library, production.id, 'ready');
  const publication = await publishProduction(library, production.id);
  return { contract, canon, production, publication, perCharacter, packArt, cover };
}

export async function buildHeroCollectorProduction(library, { variant = 1 } = {}) {
  const contract = createContract(library, loadConsumerContract('herocollector'));
  const canon = await buildCanon(library, { variant });
  const { world, heroes } = canon;

  const production = createProduction(library, {
    name: variant === 1 ? 'Emberfall Pack' : 'Emberfall Pack v2',
    contractId: contract.contractId,
    worldId: world.id,
  });

  /* production-level libraries */
  setProductionValue(library, production.id, {
    scope: 'production', field: 'hc_factions',
    value: [{ faction_id: 'faction_emberguard', faction_name: 'Emberguard', faction_explanation: 'Sworn to the captive star.', faction_bonus_2_bp: 200, faction_bonus_3_bp: 400 }],
  });
  setProductionValue(library, production.id, {
    scope: 'production', field: 'hc_expedition_requirements',
    value: [{ expreq_id: 'req_scholars', expreq_type: 'tag_count', expreq_world: world.id, expreq_count: 1, expreq_text: 'Bring a scholar.' }],
  });
  setProductionValue(library, production.id, {
    scope: 'production', field: 'hc_expedition_objectives',
    value: [{ expobj_id: 'obj_swift', expobj_type: 'duration', expobj_count: 1, expobj_text: 'Return within a day.' }],
  });
  setProductionValue(library, production.id, {
    scope: 'production', field: 'hc_expedition_rewards',
    value: [{
      expreward_id: 'reward_basic', expreward_name: 'Field Supplies', expreward_rare: false,
      expreward_entries: [{ rentry_kind: 'resource', rentry_id: 'renown', rentry_amount: 50 }],
    }],
  });
  setProductionValue(library, production.id, {
    scope: 'production', field: 'hc_expedition_templates',
    value: [{
      exptpl_id: 'tpl_ember_run', exptpl_world: world.id, exptpl_weight: 10, exptpl_party_size: 2,
      exptpl_durations: [4, 8], exptpl_requirement_ids: ['req_scholars'], exptpl_requirement_count: 1,
      exptpl_optional_ids: ['obj_swift'], exptpl_reward_package: 'reward_basic', exptpl_power_ratio_bp: 10000,
      exptpl_titles: ['Ember Run'], exptpl_descriptions: ['A short supply run along the star canals.'],
    }],
  });
  const crisisArt = await importImage(library, 'Crisis art', { seed: 3000 + variant });
  setProductionValue(library, production.id, {
    scope: 'production', field: 'hc_crises',
    value: [{
      crisis_id: 'crisis_starfall', crisis_world: world.id, crisis_name: 'Starfall Warning',
      crisis_opening: 'The cage hums off-key.', crisis_art: crisisArt.id, crisis_weight: 10, crisis_min_cleared: 3,
      crisis_fronts: [
        { front_id: 'front_gate', front_name: 'The Gate', front_description: 'Hold the gate.', front_favored_tags: ['tag_scholar'], front_power_local: 100, front_power_major: 300, front_power_world: 900, front_struggle_text: 'The gate held, barely.', front_success_text: 'The gate held.', front_excel_text: 'The gate never wavered.' },
        { front_id: 'front_canal', front_name: 'The Canals', front_description: 'Calm the canals.', front_favored_tags: [], front_power_local: 120, front_power_major: 320, front_power_world: 950, front_struggle_text: 'The canals steamed.', front_success_text: 'The canals calmed.', front_excel_text: 'The canals sang.' },
      ],
      crisis_consolation: [{ cons_kind: 'resource', cons_id: 'renown', cons_amount: 10 }],
      crisis_cache_choices: [{
        cache_id: 'cache_supply', cache_name: 'Supply Cache',
        cache_entries: [{ centry_kind: 'energy', centry_id: '', centry_amount: 10 }],
      }],
      crisis_boon_text: 'The star remembers your help.',
    }],
  });

  /* world selection */
  setSelection(library, production.id, 'hc_worlds', [world.id]);
  const worldValues = {
    hc_world_icon: '🔥',
    hc_palette_primary: '#5a7a9e',
    hc_palette_accent: '#9ec3e8',
    hc_palette_dark: '#1c2733',
    hc_world_display_order: 0,
    hc_asset_name: 'Emberlight',
    hc_asset_description: 'Bottled warmth of the captive star.',
    hc_asset_icon: '◆',
    hc_chapter_titles: ['Emberfall · Chapter 1', 'Emberfall · Chapter 2', 'Emberfall · Chapter 3'],
    hc_hq_signature: 'daily_free_reroll',
    hc_full_reward_character: heroes[0].id,
    hc_full_reward_skin_name: 'Starlit Ash',
  };
  const families = ['metal', 'fiber', 'mineral', 'compound', 'mechanism', 'essence'];
  const grades = ['improved', 'improved', 'advanced'];
  worldValues.hc_campaign_nodes = Array.from({ length: 30 }, (_, i) => ({
    node_name: `Node ${i + 1}`,
    node_threshold: 100 + i * 50,
    node_family: families[i % 6],
    node_grade: grades[Math.floor(i / 10)],
  }));
  const facilityArt = await importImage(library, 'Forge facility art', { seed: 3100 });
  worldValues.hc_hq_facilities = [{ facility_id: 'fac_forge', facility_name: 'Star Forge', facility_description: 'Refines emberlight.', facility_art: facilityArt.id }];
  const relicArt = await importImage(library, 'Relic ember shard', { seed: 3200 });
  worldValues.hc_archive_collections = [{
    col_name: 'First Sparks',
    col_relics: [
      { relic_name: 'Ember Shard', relic_lore: 'A cooled fragment of the star.', relic_art: relicArt.id },
      { relic_name: 'Cage Key', relic_lore: 'It opens nothing anymore.', relic_art: null },
    ],
    col_reward_character: heroes[0].id,
    col_reward_skin_name: 'Vigil Ash',
  }];
  for (const [field, value] of Object.entries(worldValues)) {
    setProductionValue(library, production.id, { scope: 'entity', entityId: world.id, field, value });
  }
  const worldCover = await importImage(library, 'Emberfall world cover', { entityId: world.id, role: 'world.cover', seed: 3300 + variant });
  setAssetSetItems(library, production.id, { slot: 'hc_world_cover', entityId: world.id, items: items([worldCover]) });
  const hqArt = await importImage(library, 'Emberfall HQ', { entityId: world.id, role: 'world.background', seed: 3310 });
  setAssetSetItems(library, production.id, { slot: 'hc_hq_art', entityId: world.id, items: items([hqArt]) });
  const chapterArts = [];
  for (let c = 1; c <= 3; c++) {
    chapterArts.push(await importImage(library, `Chapter ${c} art`, { entityId: world.id, role: 'scene.key_art', seed: 3320 + c }));
  }
  setAssetSetItems(library, production.id, { slot: 'hc_chapter_art', entityId: world.id, items: items(chapterArts) });

  /* characters */
  const cast = heroes.slice(0, variant === 1 ? 2 : 3);
  setSelection(library, production.id, 'hc_characters', cast.map((hero) => hero.id));
  const archetypes = ['leader', 'dreamer', 'rebel', 'caretaker'];
  const perCharacter = [];
  for (const [index, hero] of cast.entries()) {
    const equipArt = await importImage(library, `${hero.name} signature art`, { seed: 3400 + index });
    const skinArt = await importImage(library, `${hero.name} skin art`, { seed: 3500 + index });
    const values = {
      hc_archetype: archetypes[index % archetypes.length],
      hc_tier: index === 0 ? 'major' : 'minor',
      hc_starting: index === 0,
      hc_faction: 'faction_emberguard',
      hc_extra_tags: ['tag_scholar'],
      hc_glyph: hero.name[0],
      hc_color: '#7a8aa0',
      hc_equipment: [
        { equip_slot: 'attire', equip_name: `${hero.name}'s Ember Cloak`, equip_art: null },
        { equip_slot: 'signature', equip_name: `${hero.name}'s Star Brand`, equip_art: equipArt.id },
      ],
      hc_skins: [{ skin_id: `skin_${index === 0 ? 'vigil_ash' : `hero_${index}`}`, skin_name: index === 0 ? 'Vigil Ash' : 'Festival Wear', skin_art: skinArt.id }],
    };
    for (const [field, value] of Object.entries(values)) {
      setProductionValue(library, production.id, { scope: 'entity', entityId: hero.id, field, value });
    }
    const portrait = await importImage(library, `${hero.name} hc portrait`, { entityId: hero.id, role: 'character.portrait', seed: 3600 + index * 10 + variant });
    setAssetSetItems(library, production.id, { slot: 'hc_portrait', entityId: hero.id, items: items([portrait]) });
    const fullBody = await importImage(library, `${hero.name} full body`, { entityId: hero.id, role: 'character.full_body', seed: 3700 + index * 10 });
    setAssetSetItems(library, production.id, { slot: 'hc_full_body', entityId: hero.id, items: items([fullBody]) });
    perCharacter.push({ hero, portrait, fullBody, equipArt, skinArt });
  }

  const boardArt = await importImage(library, 'Expedition board art', { seed: 3800 });
  setAssetSetItems(library, production.id, { slot: 'hc_expedition_art', items: items([boardArt]) });

  setProductionStatus(library, production.id, 'ready');
  const publication = await publishProduction(library, production.id);
  return { contract, canon, production, publication, perCharacter, crisisArt, relicArt, facilityArt, worldCover };
}

export const CONSUMER_BUILDERS = {
  taskstamps: buildTaskStampsProduction,
  chatbot: buildChatBotProduction,
  stickeralbum: buildStickerAlbumProduction,
  herocollector: buildHeroCollectorProduction,
};

/** Update a variant-1 library to produce a version-2 publication of the same production. */
export async function republishUpdate(library, built, mutate) {
  await mutate?.();
  setProductionStatus(library, built.production.id, 'ready');
  return publishProduction(library, built.production.id);
}

export { addAssetVersion };
