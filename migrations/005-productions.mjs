export const version = 5;
export const name = 'productions';

export function up(db) {
  db.exec(`
    CREATE TABLE application_contracts (
      id INTEGER PRIMARY KEY,
      contract_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      app_type TEXT NOT NULL,
      name TEXT NOT NULL,
      json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
      created_at TEXT NOT NULL,
      UNIQUE (contract_id, version)
    );

    CREATE TABLE productions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      contract_id TEXT NOT NULL,
      contract_version INTEGER NOT NULL,
      world_id TEXT REFERENCES entities(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','archived')),
      revision INTEGER NOT NULL DEFAULT 1,
      validation_state TEXT NOT NULL DEFAULT 'unknown' CHECK (validation_state IN ('unknown','valid','warnings','errors')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE INDEX idx_productions_status ON productions(status);

    CREATE TABLE production_entities (
      id INTEGER PRIMARY KEY,
      production_id TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
      slot TEXT NOT NULL,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL DEFAULT 0,
      UNIQUE (production_id, slot, entity_id)
    );
    CREATE INDEX idx_production_entities_production ON production_entities(production_id, slot);
    CREATE INDEX idx_production_entities_entity ON production_entities(entity_id);

    CREATE TABLE production_values (
      id INTEGER PRIMARY KEY,
      production_id TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
      scope TEXT NOT NULL DEFAULT 'production' CHECK (scope IN ('production','entity')),
      entity_id TEXT NOT NULL DEFAULT '',
      field TEXT NOT NULL,
      value_json TEXT NOT NULL DEFAULT 'null',
      UNIQUE (production_id, scope, entity_id, field)
    );

    CREATE TABLE production_asset_sets (
      id INTEGER PRIMARY KEY,
      production_id TEXT NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
      slot TEXT NOT NULL,
      entity_id TEXT NOT NULL DEFAULT '',
      UNIQUE (production_id, slot, entity_id)
    );

    CREATE TABLE production_asset_items (
      id INTEGER PRIMARY KEY,
      set_id INTEGER NOT NULL REFERENCES production_asset_sets(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL DEFAULT 0,
      value_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX idx_production_asset_items_set ON production_asset_items(set_id);

    CREATE TABLE publications (
      id TEXT PRIMARY KEY,
      production_id TEXT NOT NULL REFERENCES productions(id) ON DELETE RESTRICT,
      production_revision INTEGER NOT NULL,
      contract_id TEXT NOT NULL,
      contract_version INTEGER NOT NULL,
      manifest_path TEXT NOT NULL,
      package_size INTEGER NOT NULL DEFAULT 0,
      file_count INTEGER NOT NULL DEFAULT 0,
      entity_count INTEGER NOT NULL DEFAULT 0,
      is_current INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_publications_production ON publications(production_id);

    CREATE TABLE publication_files (
      id INTEGER PRIMARY KEY,
      publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      UNIQUE (publication_id, path)
    );
  `);
}
