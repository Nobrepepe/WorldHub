export const version = 8;
export const name = 'built-in recipes keep transparency';

/**
 * The cover recipes shipped matting transparent art onto the archive
 * floor, so exported silhouettes arrived on a near-black rectangle. Art
 * here is drawn to bleed into whatever background a consumer uses, so
 * alpha is the default now. Renditions are fingerprinted over the recipe,
 * which includes this flag: existing outputs fall out of cache and are
 * regenerated the next time they are asked for.
 */
export function up(db) {
  db.exec(`
    UPDATE rendition_recipes
    SET preserve_alpha = 1
    WHERE builtin = 1 AND format = 'webp' AND preserve_alpha = 0;
  `);
}
