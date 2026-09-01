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
import { createEntity, updateEntity } from '../../electron/services/entity-service.js';
import { createConnection } from '../../electron/services/connection-service.js';
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
  createConnection(library, { kindId: 'based_at', entityId: heroes[0].id, counterpartId: place.id });
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
      stamps.push(await importImage(library, `${hero.name} stamp ${n}`, { entityId: hero.id, role: 'character.stamp', seed: 1000 + index * 100 + n + (variant === 2 && n === 1 ? 9999 : 0) }));
    }
    setAssetSetItems(library, production.id, { slot: 'stamps', entityId: hero.id, items: items(stamps) });
    const boss = await importImage(library, `${hero.name} boss`, { entityId: hero.id, role: 'character.tile', seed: 700 + index * 20 + variant });
    setAssetSetItems(library, production.id, { slot: 'boss_image', entityId: hero.id, items: items([boss]) });
    const bossSound = await importSound(library, `${hero.name} defeat`, { entityId: hero.id, role: 'audio.cue', seed: 800 + index });
    setAssetSetItems(library, production.id, { slot: 'boss_sound', entityId: hero.id, items: items([bossSound]) });
    const cue = await importSound(library, `${hero.name} cue`, { entityId: hero.id, role: 'audio.cue', seed: 300 + index });
    setAssetSetItems(library, production.id, { slot: 'default_sound', entityId: hero.id, items: items([cue]) });
    const line = await importSound(library, `${hero.name} stamp five line`, { entityId: hero.id, role: 'audio.voice_line', seed: 400 + index });
    setAssetSetItems(library, production.id, {
      slot: 'stamp_sounds', entityId: hero.id,
      items: [{ assetId: line.id, values: { stamp_number: 5 } }],
    });
    perCharacter.push({ hero, portrait, stamps, boss, bossSound, cue, line });
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
    const tile = await importImage(library, `${hero.name} tile`, { entityId: hero.id, role: 'character.tile', seed: 600 + index });
    setAssetSetItems(library, production.id, { slot: 'tile', entityId: hero.id, items: items([tile]) });
    const neutral = await importImage(library, `${hero.name} neutral sprite`, { entityId: hero.id, role: 'character.portrait', seed: 700 + index * 10 });
    const happy = await importImage(library, `${hero.name} happy sprite`, { entityId: hero.id, role: 'character.portrait', seed: 701 + index * 10 });
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
    const tile = await importImage(library, `${hero.name} album tile`, { entityId: hero.id, role: 'character.tile', seed: 900 + index * 30 + variant });
    setAssetSetItems(library, production.id, { slot: 'char_tile', entityId: hero.id, items: items([tile]) });
    const fullBody = await importImage(library, `${hero.name} album full body`, { entityId: hero.id, role: 'character.full_body', seed: 930 + index * 30 + variant });
    setAssetSetItems(library, production.id, { slot: 'char_full_body', entityId: hero.id, items: items([fullBody]) });
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
    perCharacter.push({ hero, tile, fullBody, stickers });
  }

  setProductionStatus(library, production.id, 'ready');
  const publication = await publishProduction(library, production.id);
  return { contract, canon, production, publication, perCharacter, packArt, cover };
}

export async function buildHeroCollectorProduction(library, { variant = 1 } = {}) {
  const contract = createContract(library, loadConsumerContract('herocollector'));
  const canon = await buildCanon(library, { variant });
  const { world } = canon;
  // A world is held back below five heroes, and the Main Campaign has to be
  // long enough to introduce five per world, so give the pack six.
  const heroes = [...canon.heroes];
  for (const name of ['Eryn', 'Fenn', 'Garrow', 'Hale'].slice(0, 6 - heroes.length)) {
    const extra = createEntity(library, { type: 'character', name, worldId: world.id });
    updateEntity(library, extra.id, { status: 'canonical', summary: `${name} of Emberfall.` });
    heroes.push(extra);
  }

  // Factions are canonical groups, and belonging to one is a canonical
  // connection — the game reads it through the contract's connection
  // selection rather than from a value repeated on every character.
  const emberguard = createEntity(library, { type: 'group', name: 'Emberguard', worldId: world.id });
  updateEntity(library, emberguard.id, { status: 'canonical', summary: 'Sworn to the captive star.' });

  const production = createProduction(library, {
    name: variant === 1 ? 'Emberfall Pack' : 'Emberfall Pack v2',
    contractId: contract.contractId,
    worldId: world.id,
  });

  /* Main Campaign — chapter titles and node names, and nothing else. The
     game sets every threshold, drop, reward and hero reveal along it. */
  const cast = heroes.slice(0, variant === 1 ? 5 : 6);
  const journeyArt = await importImage(library, 'Main Campaign chapter backdrop', { role: 'world.background', seed: 3900 });
  setProductionValue(library, production.id, {
    scope: 'production', field: 'hc_main_chapters',
    value: [{
      chapter_title: 'Emberfall · The First Light',
      chapter_art: journeyArt.id,
      chapter_nodes: Array.from({ length: 10 }, (_, i) => `Main Node ${i + 1}`),
    }],
  });

  /* factions */
  setSelection(library, production.id, 'hc_factions', [emberguard.id]);
  setProductionValue(library, production.id, {
    scope: 'entity', entityId: emberguard.id,
    field: 'hc_faction_explanation', value: 'They kept the same vigil, and it shows.',
  });

  /* world selection */
  setSelection(library, production.id, 'hc_worlds', [world.id]);
  const relicArt = await importImage(library, 'Relic ember shard', { entityId: world.id, role: 'object.icon', seed: 3200 });
  const cosmeticArt = await importImage(library, 'Vigil Ash cosmetic', { seed: 3500 });
  const worldValues = {
    hc_world_icon: '🔥',
    hc_palette_primary: '#5a7a9e',
    hc_palette_accent: '#9ec3e8',
    hc_palette_dark: '#1c2733',
    hc_chapter_titles: ['Emberfall · Chapter 1', 'Emberfall · Chapter 2', 'Emberfall · Chapter 3'],
    hc_campaign_nodes: Array.from({ length: 30 }, (_, i) => `Node ${i + 1}`),
    // One major relic in four pieces; the game chooses which nodes hide them.
    hc_relic_name: 'The Star Cage',
    hc_relic_lore: 'The lattice that once held the captive star together.',
    hc_relic_pieces: [
      { piece_name: 'North Lattice', piece_lore: 'A cooled fragment of the star.' },
      { piece_name: 'East Lattice', piece_lore: '' },
      { piece_name: 'South Lattice', piece_lore: '' },
      { piece_name: 'West Lattice', piece_lore: '' },
    ],
    // Ordered: the game decides which Mastery milestone each one lands on.
    hc_mastery_cosmetics: [
      { mc_character: heroes[0].id, mc_name: 'Vigil Ash', mc_art: cosmeticArt.id },
      { mc_character: heroes[0].id, mc_name: 'Starlit Ash', mc_art: null },
    ],
  };
  for (const [field, value] of Object.entries(worldValues)) {
    setProductionValue(library, production.id, { scope: 'entity', entityId: world.id, field, value });
  }
  const worldCover = await importImage(library, 'Emberfall world cover', { entityId: world.id, role: 'world.cover', seed: 3300 + variant });
  setAssetSetItems(library, production.id, { slot: 'hc_world_cover', entityId: world.id, items: items([worldCover]) });
  const chapterArts = [];
  for (let c = 1; c <= 3; c++) {
    chapterArts.push(await importImage(library, `Chapter ${c} backdrop`, { entityId: world.id, role: 'world.background', seed: 3320 + c }));
  }
  setAssetSetItems(library, production.id, { slot: 'hc_chapter_art', entityId: world.id, items: items(chapterArts) });
  setAssetSetItems(library, production.id, { slot: 'hc_relic_art', entityId: world.id, items: items([relicArt]) });

  /* characters — selection order is roster order */
  setSelection(library, production.id, 'hc_characters', cast.map((hero) => hero.id));
  const archetypes = ['leader', 'dreamer', 'rebel', 'caretaker', 'achiever', 'freespirit'];
  const perCharacter = [];
  for (const [index, hero] of cast.entries()) {
    const equipArt = await importImage(library, `${hero.name} signature art`, { seed: 3400 + index });
    const values = {
      hc_archetype: archetypes[index % archetypes.length],
      hc_equipment: [
        { equip_slot: 'attire', equip_name: `${hero.name}'s Ember Cloak`, equip_art: null },
        { equip_slot: 'signature', equip_name: `${hero.name}'s Star Brand`, equip_art: equipArt.id },
      ],
    };
    for (const [field, value] of Object.entries(values)) {
      setProductionValue(library, production.id, { scope: 'entity', entityId: hero.id, field, value });
    }
    createConnection(library, { kindId: 'member_of', entityId: hero.id, counterpartId: emberguard.id });
    const portrait = await importImage(library, `${hero.name} hc tile`, { entityId: hero.id, role: 'character.tile', seed: 3600 + index * 10 + variant });
    setAssetSetItems(library, production.id, { slot: 'hc_portrait', entityId: hero.id, items: items([portrait]) });
    const fullBody = await importImage(library, `${hero.name} full body`, { entityId: hero.id, role: 'character.full_body', seed: 3700 + index * 10 });
    setAssetSetItems(library, production.id, { slot: 'hc_full_body', entityId: hero.id, items: items([fullBody]) });
    perCharacter.push({ hero, portrait, fullBody, equipArt, cosmeticArt });
  }

  const boardArt = await importImage(library, 'Expedition board art', { seed: 3800 });
  setAssetSetItems(library, production.id, { slot: 'hc_expedition_art', items: items([boardArt]) });

  setProductionStatus(library, production.id, 'ready');
  const publication = await publishProduction(library, production.id);
  return { contract, canon, production, publication, perCharacter, emberguard, relicArt, cosmeticArt, worldCover, journeyArt };
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
