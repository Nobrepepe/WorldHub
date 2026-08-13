export const version = 1;
export const name = 'canon';

export function up(db) {
  db.exec(`
    CREATE TABLE entities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('world','character','location','group','species','object','event','lore')),
      world_id TEXT REFERENCES entities(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','canonical','archived')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      UNIQUE (type, slug)
    );
    CREATE INDEX idx_entities_type ON entities(type, status);
    CREATE INDEX idx_entities_world ON entities(world_id);

    CREATE TABLE world_profiles (
      entity_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
      tagline TEXT NOT NULL DEFAULT '',
      genre TEXT NOT NULL DEFAULT '',
      tone TEXT NOT NULL DEFAULT '',
      setting_description TEXT NOT NULL DEFAULT '',
      visual_direction TEXT NOT NULL DEFAULT '',
      cover_asset_id TEXT,
      background_asset_id TEXT
    );

    CREATE TABLE character_profiles (
      entity_id TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT '',
      age_text TEXT NOT NULL DEFAULT '',
      appearance TEXT NOT NULL DEFAULT '',
      personality TEXT NOT NULL DEFAULT '',
      biography TEXT NOT NULL DEFAULT '',
      voice TEXT NOT NULL DEFAULT '',
      portrait_asset_id TEXT,
      full_body_asset_id TEXT
    );

    CREATE TABLE entity_aliases (
      id INTEGER PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_aliases_entity ON entity_aliases(entity_id);

    CREATE TABLE relationships (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
      target_id TEXT NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
      rel_type TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      inverse_label TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'canonical' CHECK (status IN ('draft','canonical','archived')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_relationships_source ON relationships(source_id);
    CREATE INDEX idx_relationships_target ON relationships(target_id);

    CREATE TABLE tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      group_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE taggings (
      id INTEGER PRIMARY KEY,
      tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      subject_type TEXT NOT NULL CHECK (subject_type IN ('entity','document','asset','production')),
      subject_id TEXT NOT NULL,
      UNIQUE (tag_id, subject_type, subject_id)
    );
    CREATE INDEX idx_taggings_subject ON taggings(subject_type, subject_id);

    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      action TEXT NOT NULL,
      subject_type TEXT NOT NULL DEFAULT '',
      subject_id TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT ''
    );
  `);
}
