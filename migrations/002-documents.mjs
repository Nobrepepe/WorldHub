export const version = 2;
export const name = 'documents';

export function up(db) {
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','canonical','archived')),
      checksum TEXT NOT NULL DEFAULT '',
      word_count INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      content_cache TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE INDEX idx_documents_status ON documents(status);

    CREATE TABLE document_links (
      id INTEGER PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL DEFAULT 0,
      UNIQUE (document_id, entity_id)
    );
    CREATE INDEX idx_document_links_entity ON document_links(entity_id);
  `);
}
