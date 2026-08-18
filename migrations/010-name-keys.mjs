export const version = 10;
export const name = 'name keys for Inbox duplicate hints';

/**
 * The Inbox could only see byte-identical duplicates. A re-exported file
 * carrying a name the library already uses arrived unannounced and became
 * a second asset with the same title instead of a new version of the
 * first. Both sides now store a comparison key so the match is a plain
 * indexed lookup rather than a scan.
 *
 * The key is deliberately loose: case is folded and `-`/`_` are treated
 * as noise, so `HDV08_ST01`, `hdv08-st01`, and `HDV08ST01` all collide.
 * A false hint costs a glance; a missed one costs a duplicate asset.
 */
function comparisonKey(text) {
  return String(text ?? '').toLowerCase().replaceAll('-', '').replaceAll('_', '');
}

function filenameStem(filename) {
  const base = String(filename ?? '').split('/').pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

export function up(db) {
  db.exec(`
    ALTER TABLE assets ADD COLUMN title_key TEXT NOT NULL DEFAULT '';
    ALTER TABLE inbox_items ADD COLUMN name_key TEXT NOT NULL DEFAULT '';
  `);

  const setTitleKey = db.prepare('UPDATE assets SET title_key = ? WHERE id = ?');
  for (const row of db.prepare('SELECT id, title FROM assets').all()) {
    setTitleKey.run(comparisonKey(row.title), row.id);
  }
  const setNameKey = db.prepare('UPDATE inbox_items SET name_key = ? WHERE id = ?');
  for (const row of db.prepare('SELECT id, filename FROM inbox_items').all()) {
    setNameKey.run(comparisonKey(filenameStem(row.filename)), row.id);
  }

  db.exec(`
    CREATE INDEX idx_assets_title_key ON assets(title_key);
    CREATE INDEX idx_inbox_items_name_key ON inbox_items(name_key);
  `);
}
