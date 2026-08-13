/** Per-library settings stored in the settings table as JSON values. */

export const SETTING_DEFAULTS = {
  textScale: 1,
  reducedMotion: false,
  renditionQuality: 82,
  autoBackup: true,
  lastAutoBackupAt: null,
};

export function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return SETTING_DEFAULTS[key] ?? null;
  try { return JSON.parse(row.value); } catch { return SETTING_DEFAULTS[key] ?? null; }
}

export function setSetting(db, key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, JSON.stringify(value ?? null));
}

export function getAllSettings(db) {
  const out = { ...SETTING_DEFAULTS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    try { out[row.key] = JSON.parse(row.value); } catch { /* keep default */ }
  }
  return out;
}
