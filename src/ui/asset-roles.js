/**
 * What each semantic role looks like.
 *
 * Roles say what art *means*; recipes say what shape it is published at.
 * A role folder borrows its preview shape from the recipe that role is
 * normally rendered through, so browsing a folder shows the art the way
 * the role expects it rather than at one house crop. The convention is
 * not enforced on import — art that ignores it still belongs to the role
 * and letterboxes inside the folder, because cropping belongs to the
 * rendition editor and never to layout convenience.
 */

/** The recipe a role's previews are cut to when the role names no other. */
export const DEFAULT_PREVIEW_RECIPE = 'tile_16x9';

/** Role → the rendition recipe that defines its shape. */
export const RECIPE_BY_ROLE = {
  'character.portrait': 'portrait_3x4',
  'character.tile': 'tile_16x9',
  'character.stamp': 'stamp_4x3',
  'character.collectible': 'square',
  'character.full_body': 'full_body_9x16',
  'object.icon': 'square',
};

export function previewRecipeForRole(role) {
  return RECIPE_BY_ROLE[role] ?? DEFAULT_PREVIEW_RECIPE;
}

/**
 * Folder order. Roles the vocabulary knows read in a deliberate sequence;
 * anything else follows alphabetically rather than disappearing.
 */
export const ROLE_ORDER = [
  'world.cover',
  'world.background',
  'location.background',
  'character.portrait',
  'character.tile',
  'character.full_body',
  'character.collectible',
  'character.stamp',
  'object.icon',
  'scene.key_art',
  'audio.voice_line',
  'audio.cue',
  'reference.art',
  'reference.document',
];

/** Readable folder name for a role, without losing the role itself. */
export function roleLabel(role) {
  if (!role) return 'Unfiled';
  const tail = String(role).split('.').slice(1).join('.') || String(role);
  const words = tail.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Group one record's assets into role folders. An asset carrying two
 * roles for the same record appears under both — the link is the truth,
 * not the file. Returns folders in ROLE_ORDER, unknown roles last.
 */
export function groupAssetsByRole(assets) {
  const byRole = new Map();
  for (const asset of assets) {
    const roles = asset.entityRoles?.length ? asset.entityRoles : [''];
    for (const role of roles) {
      if (!byRole.has(role)) byRole.set(role, []);
      byRole.get(role).push(asset);
    }
  }
  const rank = (role) => {
    const index = ROLE_ORDER.indexOf(role);
    return index === -1 ? ROLE_ORDER.length : index;
  };
  return [...byRole.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([role, items]) => ({
      role,
      label: roleLabel(role),
      recipeId: previewRecipeForRole(role),
      assets: items,
    }));
}

/**
 * Preview aspect ratio for a recipe, read from the recipe's own canvas so
 * a retuned recipe moves its folders with it. Falls back to 16:9.
 */
export function aspectForRecipe(recipe) {
  if (!recipe?.width || !recipe?.height) return '16 / 9';
  return `${recipe.width} / ${recipe.height}`;
}

/** "3:4" for a recipe canvas, reduced. Empty when the recipe has none. */
export function ratioLabel(recipe) {
  if (!recipe?.width || !recipe?.height) return '';
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(recipe.width, recipe.height) || 1;
  return `${recipe.width / divisor}:${recipe.height / divisor}`;
}

/**
 * Column width for a folder of a given shape, in rem. Tiles aim for a
 * common height so wide and tall folders read as one page rather than
 * one folder of postage stamps beside one of billboards.
 */
export function tileColumnRem(recipe) {
  if (!recipe?.width || !recipe?.height) return 13;
  const target = 13 * (recipe.width / recipe.height);
  return Math.round(Math.min(20, Math.max(9, target)) * 10) / 10;
}
