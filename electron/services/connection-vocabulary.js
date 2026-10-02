import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The built-in connection-kind vocabulary, read from the one file that
 * defines it.
 *
 * `kit/connection-kinds.json` is shipped to consuming applications alongside
 * the package reader, for the same reason `kit/vocabulary.json` is: a fact
 * published as `member_of` has to mean the same thing on both sides of the
 * seam. Restating the list in JavaScript would make this a second copy, and
 * a second copy is how a role came to mean one thing here and another there.
 *
 * Migrations deliberately do *not* read this file. A migration that seeded
 * from a file that can still change would seed different rows on replay; it
 * carries a frozen copy instead, and `tests/vocabulary.test.mjs` holds the
 * two together.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CONNECTION_KINDS_PATH = path.join(__dirname, '..', '..', 'kit', 'connection-kinds.json');

let cached = null;

export function connectionVocabulary() {
  if (!cached) cached = JSON.parse(fs.readFileSync(CONNECTION_KINDS_PATH, 'utf8'));
  return cached;
}

export const connectionKindsVersion = () => connectionVocabulary().connectionKindsVersion;

/** Category descriptors, in the order the authoring drawer offers them. */
export const connectionCategories = () =>
  connectionVocabulary().categories.map(({ id, label, section }) => ({ id, label, section }));

export const CONNECTION_CATEGORY_IDS = connectionCategories().map((category) => category.id);

/**
 * A kind's own section names, falling back to its category's.
 *
 * Most kinds only need to name the side where the generic heading would be
 * wrong: a character's affiliations sit under "Affiliations" like everything
 * else in that category, but the group's side of the same fact is "Members",
 * not "Affiliations". Declaring only the exception keeps the vocabulary
 * readable and keeps a custom kind cheap to define.
 */
export function sectionsFor(kind, categories = connectionCategories()) {
  const fallback = categories.find((category) => category.id === kind.category)?.section ?? 'Connections';
  return {
    forwardSection: kind.forwardSection || fallback,
    inverseSection: kind.inverseSection || fallback,
  };
}

/** The plain sentence a kind states, used by the authoring drawer. */
export function sentenceFor(kind, sourceName, targetName) {
  const template = kind.sentence || `{source} — ${kind.forwardLabel} — {target}`;
  return template.replaceAll('{source}', sourceName).replaceAll('{target}', targetName);
}

/** Every built-in kind, with its sections resolved and pairs normalised. */
export function builtinConnectionKinds() {
  const categories = connectionCategories();
  return connectionVocabulary().kinds.map((kind) => ({
    id: kind.id,
    category: kind.category,
    forwardLabel: kind.forwardLabel,
    inverseLabel: kind.inverseLabel,
    ...sectionsFor(kind, categories),
    sentence: kind.sentence ?? '',
    symmetric: Boolean(kind.symmetric),
    pairs: kind.pairs.map(([sourceType, targetType]) => ({ sourceType, targetType })),
  }));
}
