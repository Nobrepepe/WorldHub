export const version = 4;
export const name = 'inbox';

export function up(db) {
  db.exec(`
    CREATE TABLE inbox_batches (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      source_root TEXT NOT NULL DEFAULT '',
      imported_at TEXT NOT NULL
    );

    CREATE TABLE inbox_items (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES inbox_batches(id) ON DELETE RESTRICT,
      source_rel_path TEXT NOT NULL DEFAULT '',
      filename TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('image','audio','markdown','attachment')),
      size INTEGER NOT NULL DEFAULT 0,
      checksum TEXT NOT NULL DEFAULT '',
      staging_path TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (status IN ('unreviewed','filed','duplicate','ignored','error')),
      error_message TEXT NOT NULL DEFAULT '',
      filed_document_id TEXT,
      filed_asset_id TEXT,
      filed_asset_version_id TEXT,
      filed_entity_id TEXT,
      filed_at TEXT,
      imported_at TEXT NOT NULL
    );
    CREATE INDEX idx_inbox_items_batch ON inbox_items(batch_id, status);
    CREATE INDEX idx_inbox_items_status ON inbox_items(status);
    CREATE INDEX idx_inbox_items_checksum ON inbox_items(checksum);
  `);
}
