export const version = 3;
export const name = 'assets';

export function up(db) {
  db.exec(`
    CREATE TABLE blobs (
      hash TEXT PRIMARY KEY,
      ext TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      duration_seconds REAL,
      has_alpha INTEGER,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE assets (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('image','audio','markdown','attachment')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
      notes TEXT NOT NULL DEFAULT '',
      current_version_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );

    CREATE TABLE asset_versions (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
      blob_hash TEXT NOT NULL REFERENCES blobs(hash) ON DELETE RESTRICT,
      version_number INTEGER NOT NULL,
      original_filename TEXT NOT NULL DEFAULT '',
      imported_from TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE (asset_id, version_number)
    );
    CREATE INDEX idx_asset_versions_asset ON asset_versions(asset_id);
    CREATE INDEX idx_asset_versions_blob ON asset_versions(blob_hash);

    CREATE TABLE asset_links (
      id INTEGER PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
      role TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      UNIQUE (asset_id, entity_id, role)
    );
    CREATE INDEX idx_asset_links_entity ON asset_links(entity_id);
    CREATE INDEX idx_asset_links_role ON asset_links(role);

    CREATE TABLE rendition_recipes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      fit TEXT NOT NULL DEFAULT 'cover' CHECK (fit IN ('contain','cover','none')),
      format TEXT NOT NULL DEFAULT 'webp' CHECK (format IN ('webp','original')),
      quality INTEGER NOT NULL DEFAULT 82,
      preserve_alpha INTEGER NOT NULL DEFAULT 0,
      background TEXT NOT NULL DEFAULT '',
      allow_upscale INTEGER NOT NULL DEFAULT 0,
      builtin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE asset_crops (
      id INTEGER PRIMARY KEY,
      version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
      recipe_id TEXT NOT NULL REFERENCES rendition_recipes(id) ON DELETE CASCADE,
      focal_x REAL NOT NULL DEFAULT 0.5,
      focal_y REAL NOT NULL DEFAULT 0.5,
      zoom REAL NOT NULL DEFAULT 1,
      pan_x REAL NOT NULL DEFAULT 0,
      pan_y REAL NOT NULL DEFAULT 0,
      rotation REAL NOT NULL DEFAULT 0,
      background TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      UNIQUE (version_id, recipe_id)
    );

    CREATE TABLE generated_renditions (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
      recipe_id TEXT NOT NULL REFERENCES rendition_recipes(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      path TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      size INTEGER NOT NULL,
      mime TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (version_id, recipe_id, fingerprint)
    );
    CREATE INDEX idx_generated_renditions_version ON generated_renditions(version_id);
  `);

  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO rendition_recipes (id, name, width, height, fit, format, quality, preserve_alpha, background, allow_upscale, builtin, created_at, updated_at)
    VALUES (@id, @name, @width, @height, @fit, @format, @quality, @preserve_alpha, @background, @allow_upscale, 1, @now, @now)
  `);
  const recipes = [
    { id: 'thumbnail_square', name: 'Thumbnail square', width: 320, height: 320, fit: 'contain', format: 'webp', quality: 80, preserve_alpha: 1, background: '', allow_upscale: 0 },
    { id: 'square', name: 'Square', width: 1024, height: 1024, fit: 'cover', format: 'webp', quality: 84, preserve_alpha: 1, background: '', allow_upscale: 0 },
    { id: 'landscape_16x9', name: 'Landscape 16:9', width: 1600, height: 900, fit: 'cover', format: 'webp', quality: 84, preserve_alpha: 1, background: '', allow_upscale: 0 },
    { id: 'wide_tile_16x9', name: 'Wide tile 16:9', width: 1280, height: 720, fit: 'contain', format: 'webp', quality: 84, preserve_alpha: 1, background: '', allow_upscale: 0 },
    { id: 'portrait_9x16', name: 'Portrait 9:16', width: 900, height: 1600, fit: 'cover', format: 'webp', quality: 84, preserve_alpha: 1, background: '', allow_upscale: 0 },
    { id: 'card_3x4', name: 'Card 3:4', width: 900, height: 1200, fit: 'cover', format: 'webp', quality: 84, preserve_alpha: 1, background: '', allow_upscale: 0 },
    { id: 'original', name: 'Original', width: null, height: null, fit: 'none', format: 'original', quality: 100, preserve_alpha: 1, background: '', allow_upscale: 0 },
  ];
  for (const recipe of recipes) insert.run({ ...recipe, now });
}
