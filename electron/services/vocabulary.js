import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The published role and recipe vocabulary, read from the one file that
 * defines it.
 *
 * `kit/vocabulary.json` is shipped to consuming applications alongside the
 * package reader, so an application resolves art through the same names
 * World Hub validates against. Declaring the list here as well would make
 * this a second copy — and a second copy is exactly how a renamed role
 * came to mean one thing on this side of the seam and another on the far
 * side, discovered only when the art failed to appear.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const VOCABULARY_PATH = path.join(__dirname, '..', '..', 'kit', 'vocabulary.json');

let cached = null;

export function vocabulary() {
  if (!cached) cached = JSON.parse(fs.readFileSync(VOCABULARY_PATH, 'utf8'));
  return cached;
}

export const vocabularyVersion = () => vocabulary().vocabularyVersion;
export const assetRoles = () => vocabulary().roles.map((role) => role.id);
export const recipeIds = () => vocabulary().recipes.map((recipe) => recipe.id);

/** Drop the `$comment` keys that document the file but mean nothing to a reader. */
function withoutComments(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== '$comment')
      .map(([key, nested]) => [key, withoutComments(nested)]),
  );
}

/**
 * Former names for a current id, so a consumer holding an old one can heal.
 * This ships inside every package manifest, so it carries no commentary.
 */
export const renamedFrom = () => withoutComments(vocabulary().renamedFrom);

/** Roles that no longer exist, mapped to what their links became. */
export const retiredRoles = () => withoutComments(vocabulary().retiredRoles);
