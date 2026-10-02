export const version = 12;
export const name = 'connections';

/**
 * A relationship carried its own vocabulary. `rel_type`, `label` and
 * `inverse_label` were free text typed again on every record, so the
 * second guardian in a library was "guards"/"guarded by" only if whoever
 * filed it remembered the first one's wording — and `SELECT DISTINCT
 * rel_type` was the whole of the vocabulary anyone could consult. Nothing
 * could say that `member_of` runs from a character to a group and nowhere
 * else, so nothing stopped a membership pointing at an object, and an
 * author had to understand which endpoint the database called the source
 * in order to file a fact at all.
 *
 * A connection now names a reusable *kind*. The kind carries the labels,
 * the category, the sections each side is presented under, and the entity
 * type pairs it is allowed to join — so orientation is read from the
 * definition rather than chosen, and an impossible pair cannot be saved.
 *
 * Nothing is guessed on the way in. Every distinct `rel_type` becomes its
 * own legacy kind whose labels are the most common ones that type actually
 * carried, and whose allowed pairs are the type combinations it was
 * actually used with. A record whose own labels disagreed with that
 * majority keeps them verbatim in `label_override` / `inverse_label_override`
 * rather than being corrected into agreement — merging synonymous legacy
 * kinds is a judgement, offered on the Connections screen, never made here.
 * Duplicate rows are copied across as duplicates for the same reason: an
 * upgrade that silently deleted canon would be a worse bug than the one it
 * was tidying.
 *
 * The seed below is a frozen copy of `kit/connection-kinds.json`, not a read
 * of it: a migration that seeded from a file that can still change would
 * seed different rows on replay. `tests/vocabulary.test.mjs` asserts the two
 * still agree, and a later built-in arrives in its own numbered migration.
 */

const BUILTIN_KINDS = [
  { id: "friend_of", category: "social", symmetric: true,
    forwardLabel: "Friend", inverseLabel: "Friend",
    forwardSection: "People", inverseSection: "People",
    sentence: "{source} and {target} are friends.",
    pairs: [['character','character']] },

  { id: "rival_of", category: "social", symmetric: true,
    forwardLabel: "Rival", inverseLabel: "Rival",
    forwardSection: "People", inverseSection: "People",
    sentence: "{source} and {target} are rivals.",
    pairs: [['character','character']] },

  { id: "sibling_of", category: "social", symmetric: true,
    forwardLabel: "Sibling", inverseLabel: "Sibling",
    forwardSection: "People", inverseSection: "People",
    sentence: "{source} and {target} are siblings.",
    pairs: [['character','character']] },

  { id: "partner_of", category: "social", symmetric: true,
    forwardLabel: "Partner", inverseLabel: "Partner",
    forwardSection: "People", inverseSection: "People",
    sentence: "{source} and {target} are partners.",
    pairs: [['character','character']] },

  { id: "parent_of", category: "social", symmetric: false,
    forwardLabel: "Parent", inverseLabel: "Child",
    forwardSection: "People", inverseSection: "People",
    sentence: "{source} is the parent of {target}.",
    pairs: [['character','character']] },

  { id: "mentor_of", category: "social", symmetric: false,
    forwardLabel: "Mentor", inverseLabel: "Student",
    forwardSection: "People", inverseSection: "People",
    sentence: "{source} is the mentor of {target}.",
    pairs: [['character','character']] },

  { id: "member_of", category: "affiliation", symmetric: false,
    forwardLabel: "Member", inverseLabel: "Member",
    forwardSection: "Affiliations", inverseSection: "Members",
    sentence: "{source} is a member of {target}.",
    pairs: [['character','group']] },

  { id: "leads", category: "affiliation", symmetric: false,
    forwardLabel: "Leader", inverseLabel: "Leader",
    forwardSection: "Affiliations", inverseSection: "Leadership",
    sentence: "{source} leads {target}.",
    pairs: [['character','group']] },

  { id: "founded", category: "affiliation", symmetric: false,
    forwardLabel: "Founder", inverseLabel: "Founder",
    forwardSection: "Affiliations", inverseSection: "Leadership",
    sentence: "{source} founded {target}.",
    pairs: [['character','group']] },

  { id: "lives_in", category: "place", symmetric: false,
    forwardLabel: "Home", inverseLabel: "Resident",
    forwardSection: "Places", inverseSection: "Residents",
    sentence: "{source} lives in {target}.",
    pairs: [['character','location']] },

  { id: "works_at", category: "place", symmetric: false,
    forwardLabel: "Workplace", inverseLabel: "Works here",
    forwardSection: "Places", inverseSection: "Residents",
    sentence: "{source} works at {target}.",
    pairs: [['character','location']] },

  { id: "based_at", category: "place", symmetric: false,
    forwardLabel: "Base", inverseLabel: "Based here",
    forwardSection: "Places", inverseSection: "Organizations present",
    sentence: "{source} is based at {target}.",
    pairs: [['character','location'], ['group','location']] },

  { id: "controls", category: "place", symmetric: false,
    forwardLabel: "Controls", inverseLabel: "Controlled by",
    forwardSection: "Places", inverseSection: "Organizations present",
    sentence: "{source} controls {target}.",
    pairs: [['group','location']] },

  { id: "operates_in", category: "place", symmetric: false,
    forwardLabel: "Operates in", inverseLabel: "Operates here",
    forwardSection: "Places", inverseSection: "Organizations present",
    sentence: "{source} operates in {target}.",
    pairs: [['group','location']] },

  { id: "located_in", category: "place", symmetric: false,
    forwardLabel: "Inside", inverseLabel: "Contains",
    forwardSection: "Part of", inverseSection: "Places within",
    sentence: "{source} is inside {target}.",
    pairs: [['location','location']] },

  { id: "kept_at", category: "place", symmetric: false,
    forwardLabel: "Kept at", inverseLabel: "Kept here",
    forwardSection: "Location", inverseSection: "Objects",
    sentence: "{source} is kept at {target}.",
    pairs: [['object','location']] },

  { id: "belongs_to_species", category: "identity", symmetric: false,
    forwardLabel: "Species", inverseLabel: "Character",
    forwardSection: "Species", inverseSection: "Characters",
    sentence: "{source} belongs to the {target}.",
    pairs: [['character','species']] },

  { id: "originates_from", category: "identity", symmetric: false,
    forwardLabel: "Origin", inverseLabel: "Origin of",
    forwardSection: "Places of origin", inverseSection: "Species",
    sentence: "{source} originates from {target}.",
    pairs: [['species','location']] },

  { id: "owns", category: "ownership", symmetric: false,
    forwardLabel: "Owner", inverseLabel: "Owner",
    forwardSection: "Objects", inverseSection: "Owners",
    sentence: "{source} owns {target}.",
    pairs: [['character','object'], ['group','object']] },

  { id: "wields", category: "ownership", symmetric: false,
    forwardLabel: "Wields", inverseLabel: "Wielder",
    forwardSection: "Objects", inverseSection: "Wielders",
    sentence: "{source} wields {target}.",
    pairs: [['character','object']] },

  { id: "created", category: "ownership", symmetric: false,
    forwardLabel: "Creator", inverseLabel: "Creator",
    forwardSection: "Objects", inverseSection: "Creators",
    sentence: "{source} created {target}.",
    pairs: [['character','object'], ['group','object']] },

  { id: "participated_in", category: "participation", symmetric: false,
    forwardLabel: "Took part", inverseLabel: "Participant",
    forwardSection: "Events", inverseSection: "Participants",
    sentence: "{source} took part in {target}.",
    pairs: [['character','event'], ['group','event']] },

  { id: "caused", category: "participation", symmetric: false,
    forwardLabel: "Caused", inverseLabel: "Cause",
    forwardSection: "Events", inverseSection: "Participants",
    sentence: "{source} caused {target}.",
    pairs: [['character','event'], ['group','event']] },

  { id: "survived", category: "participation", symmetric: false,
    forwardLabel: "Survived", inverseLabel: "Survivor",
    forwardSection: "Events", inverseSection: "Participants",
    sentence: "{source} survived {target}.",
    pairs: [['character','event']] },

  { id: "took_place_at", category: "participation", symmetric: false,
    forwardLabel: "Place", inverseLabel: "Event",
    forwardSection: "Places", inverseSection: "Events",
    sentence: "{source} took place at {target}.",
    pairs: [['event','location']] },

  { id: "used_in", category: "participation", symmetric: false,
    forwardLabel: "Used in", inverseLabel: "Important object",
    forwardSection: "Events", inverseSection: "Important objects",
    sentence: "{source} was used in {target}.",
    pairs: [['object','event']] },

  { id: "allied_with", category: "organization", symmetric: true,
    forwardLabel: "Ally", inverseLabel: "Ally",
    forwardSection: "Allied groups", inverseSection: "Allied groups",
    sentence: "{source} and {target} are allied.",
    pairs: [['group','group']] },

  { id: "rival_group_of", category: "organization", symmetric: true,
    forwardLabel: "Rival", inverseLabel: "Rival",
    forwardSection: "Rival groups", inverseSection: "Rival groups",
    sentence: "{source} and {target} are rivals.",
    pairs: [['group','group']] },

  { id: "subordinate_to", category: "organization", symmetric: false,
    forwardLabel: "Answers to", inverseLabel: "Subordinate",
    forwardSection: "Parent organization", inverseSection: "Subordinate groups",
    sentence: "{source} answers to {target}.",
    pairs: [['group','group']] },

  { id: "concerns", category: "subject", symmetric: false,
    forwardLabel: "Subject", inverseLabel: "Lore",
    forwardSection: "Subjects", inverseSection: "Lore",
    sentence: "{source} concerns {target}.",
    pairs: [['lore','character'], ['lore','group'], ['lore','location'], ['lore','species'], ['lore','object'], ['lore','event'], ['lore','lore']] },];

/** Same shape as slugify() makes elsewhere, kept local so the migration is frozen. */
function kindSlug(text) {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return slug || 'connection';
}

/** The value that appears most often, ignoring blanks; ties break alphabetically. */
function commonest(values) {
  const counts = new Map();
  for (const value of values) {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) continue;
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [value, count] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > bestCount) { best = value; bestCount = count; }
  }
  return best;
}

export function up(db) {
  const now = new Date().toISOString();

  db.exec(`
    CREATE TABLE connection_kinds (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      forward_label TEXT NOT NULL,
      inverse_label TEXT NOT NULL,
      forward_section TEXT NOT NULL DEFAULT '',
      inverse_section TEXT NOT NULL DEFAULT '',
      sentence TEXT NOT NULL DEFAULT '',
      symmetric INTEGER NOT NULL DEFAULT 0,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      is_legacy INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_connection_kinds_category ON connection_kinds(category);

    CREATE TABLE connection_kind_pairs (
      kind_id TEXT NOT NULL REFERENCES connection_kinds(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      target_type TEXT NOT NULL,
      PRIMARY KEY (kind_id, source_type, target_type)
    );

    CREATE TABLE connections (
      id TEXT PRIMARY KEY,
      kind_id TEXT NOT NULL REFERENCES connection_kinds(id) ON DELETE RESTRICT,
      source_id TEXT NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
      target_id TEXT NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
      description TEXT NOT NULL DEFAULT '',
      label_override TEXT NOT NULL DEFAULT '',
      inverse_label_override TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'canonical' CHECK (status IN ('draft','canonical','archived')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_connections_source ON connections(source_id);
    CREATE INDEX idx_connections_target ON connections(target_id);
    CREATE INDEX idx_connections_kind ON connections(kind_id);
  `);

  const insertKind = db.prepare(`
    INSERT INTO connection_kinds (id, category, forward_label, inverse_label, forward_section,
                                  inverse_section, sentence, symmetric, is_builtin, is_legacy,
                                  created_at, updated_at)
    VALUES (@id, @category, @forwardLabel, @inverseLabel, @forwardSection, @inverseSection,
            @sentence, @symmetric, @isBuiltin, @isLegacy, @now, @now)
  `);
  const insertPair = db.prepare(
    'INSERT OR IGNORE INTO connection_kind_pairs (kind_id, source_type, target_type) VALUES (?, ?, ?)');

  for (const kind of BUILTIN_KINDS) {
    insertKind.run({
      ...kind,
      symmetric: kind.symmetric ? 1 : 0,
      isBuiltin: 1,
      isLegacy: 0,
      now,
    });
    for (const [sourceType, targetType] of kind.pairs) insertPair.run(kind.id, sourceType, targetType);
  }

  /* ---- everything already filed, carried across without a guess ---- */

  const existing = db.prepare(`
    SELECT r.*, s.type AS source_type, t.type AS target_type
    FROM relationships r
    JOIN entities s ON s.id = r.source_id
    JOIN entities t ON t.id = r.target_id
    ORDER BY r.created_at, r.id
  `).all();

  const byType = new Map();
  for (const row of existing) {
    if (!byType.has(row.rel_type)) byType.set(row.rel_type, []);
    byType.get(row.rel_type).push(row);
  }

  const legacyKindIds = new Map();
  const usedIds = new Set(BUILTIN_KINDS.map((kind) => kind.id));
  for (const [relType, rows] of [...byType].sort((a, b) => a[0].localeCompare(b[0]))) {
    let kindId = `legacy_${kindSlug(relType)}`;
    let suffix = 2;
    while (usedIds.has(kindId)) kindId = `legacy_${kindSlug(relType)}_${suffix++}`;
    usedIds.add(kindId);
    legacyKindIds.set(relType, kindId);

    const forwardLabel = commonest(rows.map((row) => row.label)) || relType;
    const inverseLabel = commonest(rows.map((row) => row.inverse_label)) || `${forwardLabel} (of)`;
    insertKind.run({
      id: kindId,
      category: 'legacy',
      forwardLabel,
      inverseLabel,
      forwardSection: 'Other connections',
      inverseSection: 'Other connections',
      sentence: '',
      symmetric: 0,
      isBuiltin: 0,
      isLegacy: 1,
      now,
    });
    for (const row of rows) insertPair.run(kindId, row.source_type, row.target_type);
  }

  const insertConnection = db.prepare(`
    INSERT INTO connections (id, kind_id, source_id, target_id, description,
                             label_override, inverse_label_override, position, status,
                             created_at, updated_at)
    VALUES (@id, @kindId, @sourceId, @targetId, @description,
            @labelOverride, @inverseLabelOverride, @position, @status, @createdAt, @updatedAt)
  `);
  const kindLabels = db.prepare('SELECT forward_label, inverse_label FROM connection_kinds WHERE id = ?');

  for (const row of existing) {
    const kindId = legacyKindIds.get(row.rel_type);
    const kind = kindLabels.get(kindId);
    const ownLabel = String(row.label ?? '').trim();
    const ownInverse = String(row.inverse_label ?? '').trim();
    insertConnection.run({
      id: row.id,
      kindId,
      sourceId: row.source_id,
      targetId: row.target_id,
      description: row.description,
      // Only a disagreement is worth keeping: a label that already matches
      // its kind is not an override, it is the kind saying the same thing.
      labelOverride: ownLabel && ownLabel !== kind.forward_label ? ownLabel : '',
      inverseLabelOverride: ownInverse && ownInverse !== kind.inverse_label ? ownInverse : '',
      position: row.position,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  db.exec('DROP TABLE relationships;');

  /* The search index is a cache, but leaving it keyed by a subject type
     nothing writes any more would strand these rows until somebody ran a
     rebuild by hand. They are rewritten here instead, under the labels the
     kinds now carry. */
  db.prepare(`DELETE FROM search_index WHERE subject_type = 'relationship'`).run();
  const insertIndex = db.prepare(
    'INSERT INTO search_index (subject_type, subject_id, facet, title, body) VALUES (?, ?, ?, ?, ?)');
  const indexable = db.prepare(`
    SELECT c.id, c.description, c.label_override, c.inverse_label_override,
           k.forward_label, k.inverse_label, k.id AS kind_id,
           s.name AS source_name, t.name AS target_name
    FROM connections c
    JOIN connection_kinds k ON k.id = c.kind_id
    JOIN entities s ON s.id = c.source_id
    JOIN entities t ON t.id = c.target_id
    WHERE c.status != 'archived'
  `).all();
  for (const row of indexable) {
    const label = row.label_override || row.forward_label;
    const body = [row.kind_id, label, row.inverse_label_override || row.inverse_label, row.description]
      .filter(Boolean).join('\n');
    insertIndex.run('connection', row.id, 'connection',
      `${row.source_name} — ${label} — ${row.target_name}`, body);
  }
}
