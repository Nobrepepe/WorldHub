import { assetDisplayUrl } from './asset-service.js';

/**
 * The character roles Home hangs, each with the recipe that gives it its
 * shape. Everything here carries alpha, which is what lets the wall
 * overlap pieces without boxes.
 */
export const WALL_RECIPE_BY_ROLE = {
  'character.portrait': 'portrait_3x4',
  'character.stamp': 'stamp_4x3',
  'character.collectible': 'square',
  'character.tile': 'tile_16x9',
  'character.full_body': 'full_body_9x16',
};

/**
 * Every piece of character art Home may hang on its wall: one entry per
 * image and role, named for the character it belongs to.
 *
 * Art follows its character out of sight — an archived character's
 * pieces are not offered — and an image linked to two characters under
 * the same role hangs once, under the first link. The renderer chooses
 * what to show; this only says what there is.
 */
export function characterWall(library) {
  const db = library.db;
  const roles = Object.keys(WALL_RECIPE_BY_ROLE);
  const rows = db.prepare(`
    SELECT a.id AS assetId, a.current_version_id AS versionId, l.role,
           e.id AS characterId, e.name, w.name AS worldName
    FROM asset_links l
    JOIN assets a ON a.id = l.asset_id
    JOIN entities e ON e.id = l.entity_id
    LEFT JOIN entities w ON w.id = e.world_id
    WHERE e.type = 'character' AND e.status != 'archived'
      AND a.status = 'active' AND a.kind = 'image' AND a.current_version_id IS NOT NULL
      AND l.role IN (${roles.map(() => '?').join(', ')})
    ORDER BY a.id, l.role, l.position
  `).all(...roles);

  const seen = new Set();
  const pieces = [];
  for (const row of rows) {
    const key = `${row.assetId}:${row.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const recipeId = WALL_RECIPE_BY_ROLE[row.role];
    const url = assetDisplayUrl(db, row.assetId, recipeId);
    if (!url) continue;
    pieces.push({
      assetId: row.assetId,
      versionId: row.versionId,
      role: row.role,
      recipeId,
      url,
      // Until the rendition exists the url is the original, uncropped;
      // the renderer asks for the rendition before it hangs the piece.
      isRendition: url.startsWith('worldhub://media/rendition/'),
      characterId: row.characterId,
      name: row.name,
      worldName: row.worldName ?? null,
    });
  }
  return pieces;
}
