export const version = 9;
export const name = 'rendition and role vocabulary';

/**
 * The built-in shapes shipped with two 16:9 recipes and no wide 4:3 one,
 * and their names described formats rather than what the art is for.
 * Recipes are now named after their purpose, and the second 16:9 recipe
 * (`wide_tile_16x9`) becomes the missing wide shape, `stamp_4x3`.
 *
 * A recipe id is a primary key that crops and generated renditions point
 * at, so each rename copies the row under its new id, repoints the
 * children, and drops the old row — no foreign key is ever dangling.
 * Renditions are a cache keyed by a fingerprint that covers every recipe
 * parameter: the repointed outputs for `stamp_4x3` no longer match its
 * canvas, so the next request regenerates them and deletes the stale
 * files.
 *
 * The role vocabulary is trimmed in the same pass. Roles say what art
 * means; `character.sprite`, `character.expression`, and `character.gsi`
 * said too little to be worth confirming on every import. Links that
 * carried them keep their asset and their record but move to
 * `reference.art` — kept, no longer presented.
 */

const RECIPE_RENAMES = [
  { from: 'card_3x4', to: 'portrait_3x4', name: 'Portrait 3:4' },
  { from: 'landscape_16x9', to: 'tile_16x9', name: 'Tile 16:9' },
  { from: 'portrait_9x16', to: 'full_body_9x16', name: 'Full body 9:16' },
  { from: 'wide_tile_16x9', to: 'stamp_4x3', name: 'Stamp 4:3', width: 1280, height: 960, fit: 'cover' },
];

const ROLE_RENAMES = [
  ['character.identity_tile', 'character.tile'],
  ['character.cowboy', 'character.stamp'],
  ['audio.character_cue', 'audio.cue'],
];

const RETIRED_ROLES = ['character.sprite', 'character.expression', 'character.gsi'];

export function up(db) {
  for (const rename of RECIPE_RENAMES) {
    const row = db.prepare('SELECT * FROM rendition_recipes WHERE id = ?').get(rename.from);
    if (!row) continue;
    if (db.prepare('SELECT id FROM rendition_recipes WHERE id = ?').get(rename.to)) continue;
    db.prepare(`
      INSERT INTO rendition_recipes (id, name, width, height, fit, format, quality, preserve_alpha, background, allow_upscale, builtin, created_at, updated_at)
      VALUES (@id, @name, @width, @height, @fit, @format, @quality, @preserve_alpha, @background, @allow_upscale, @builtin, @created_at, @updated_at)
    `).run({
      ...row,
      id: rename.to,
      name: rename.name,
      width: rename.width ?? row.width,
      height: rename.height ?? row.height,
      fit: rename.fit ?? row.fit,
      updated_at: new Date().toISOString(),
    });
    db.prepare('UPDATE asset_crops SET recipe_id = ? WHERE recipe_id = ?').run(rename.to, rename.from);
    db.prepare('UPDATE generated_renditions SET recipe_id = ? WHERE recipe_id = ?').run(rename.to, rename.from);
    db.prepare('DELETE FROM rendition_recipes WHERE id = ?').run(rename.from);
  }

  // A record may already hold the destination role for the same asset;
  // OR IGNORE keeps that link and the retired duplicate is dropped after.
  for (const [from, to] of ROLE_RENAMES) {
    db.prepare('UPDATE OR IGNORE asset_links SET role = ? WHERE role = ?').run(to, from);
    db.prepare('DELETE FROM asset_links WHERE role = ?').run(from);
  }
  for (const role of RETIRED_ROLES) {
    db.prepare(`UPDATE OR IGNORE asset_links SET role = 'reference.art' WHERE role = ?`).run(role);
    db.prepare('DELETE FROM asset_links WHERE role = ?').run(role);
  }

  db.exec('ALTER TABLE character_profiles RENAME COLUMN identity_tile_asset_id TO tile_asset_id;');
}
