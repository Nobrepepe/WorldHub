export const version = 6;
export const name = 'search';

export function up(db) {
  db.exec(`
    CREATE VIRTUAL TABLE search_index USING fts5(
      subject_type UNINDEXED,
      subject_id UNINDEXED,
      facet UNINDEXED,
      title,
      body,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
}
