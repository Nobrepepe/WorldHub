export const version = 7;
export const name = 'character identity-tile display art';

export function up(db) {
  db.exec('ALTER TABLE character_profiles ADD COLUMN identity_tile_asset_id TEXT;');
}
