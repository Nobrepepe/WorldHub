/**
 * Bounded local activity log. Records important actions without
 * recording document contents.
 */

const MAX_ROWS = 2000;

export function recordActivity(db, action, subjectType = '', subjectId = '', detail = '') {
  db.prepare(`
    INSERT INTO activity_log (at, action, subject_type, subject_id, detail)
    VALUES (?, ?, ?, ?, ?)
  `).run(new Date().toISOString(), action, subjectType, subjectId, String(detail).slice(0, 500));
  db.prepare(`
    DELETE FROM activity_log
    WHERE id <= (SELECT MAX(id) FROM activity_log) - ?
  `).run(MAX_ROWS);
}

export function recentActivity(db, limit = 50) {
  return db.prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT ?').all(limit);
}
