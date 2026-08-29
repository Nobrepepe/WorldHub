export const version = 11;
export const name = 'contract provenance';

/**
 * A contract could only be typed into World Hub by hand. The file the
 * consuming application keeps under `worldhub/application-contract.json`
 * — the one its own repository treats as authoritative — had no way in,
 * so the two drifted silently and the version counter recorded nothing
 * but how many times somebody had retyped it.
 *
 * A contract version now remembers the file it was imported from and the
 * checksum of that file's bytes at import time. Drift is then a question
 * anyone can ask without changing the answer: hash the file again and
 * compare. Contracts authored in the app keep both columns NULL and are
 * simply untracked, which is a state, not a fault.
 */
export function up(db) {
  db.exec(`
    ALTER TABLE application_contracts ADD COLUMN source_path TEXT;
    ALTER TABLE application_contracts ADD COLUMN source_sha256 TEXT;
  `);
}
