import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { domainError } from './errors.js';
import { nowIso, inTransaction } from './database-service.js';
import { resolveInsideNoSymlink } from './paths.js';
import { recordActivity } from './activity-service.js';
import { syncAssetIndex, removeFromIndex } from './search-service.js';
import { classifyFile, wavDuration } from './file-signatures.js';
import { tagsFor } from './entity-service.js';

/**
 * Managed assets: content-addressed immutable blobs, logical assets,
 * immutable versions, semantic role links, non-destructive crops, and
 * deterministic generated renditions.
 */

export const ASSET_ROLES = [
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

const PREFERRED_SLOT_BY_ROLE = {
  'world.cover': ['world_profiles', 'cover_asset_id'],
  'world.background': ['world_profiles', 'background_asset_id'],
  'character.portrait': ['character_profiles', 'portrait_asset_id'],
  'character.tile': ['character_profiles', 'tile_asset_id'],
};

function fillEmptyPreferredSlot(db, assetId, entityId, role) {
  const slot = PREFERRED_SLOT_BY_ROLE[role];
  if (!slot) return;
  const [table, column] = slot;
  db.prepare(`UPDATE ${table} SET ${column} = ? WHERE entity_id = ? AND ${column} IS NULL`).run(assetId, entityId);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Comparison key for "is this the same name?" questions. Case is folded
 * and `-`/`_` are treated as noise, so `HDV08_ST01` and `hdv08-st01` are
 * one name. Stored alongside the title so the Inbox can look matches up
 * through an index; the same rule is frozen into migration 010.
 */
export function titleKey(text) {
  return String(text ?? '').toLowerCase().replaceAll('-', '').replaceAll('_', '');
}

/** World Hub owns the role vocabulary; unknown roles never become data. */
function assertKnownRole(role) {
  if (!ASSET_ROLES.includes(role)) {
    throw domainError('asset.unknown_role', `"${role}" is not a World Hub semantic role.`, { allowed: ASSET_ROLES });
  }
}

/* ---------------- blobs ---------------- */

/**
 * Store bytes as a content-addressed blob. Identical bytes reuse the
 * existing blob. Returns the blob row.
 */
export async function storeBlob(library, buffer, filename) {
  if (!buffer || buffer.length === 0) {
    throw domainError('asset.empty', `"${filename}" is empty and cannot be imported.`);
  }
  const info = classifyFile(filename, buffer);
  if (!info) {
    throw domainError('asset.unreadable', `"${filename}" could not be read as a supported image, audio, Markdown, or attachment file.`);
  }
  const hash = sha256(buffer);
  const db = library.db;
  const existing = db.prepare('SELECT * FROM blobs WHERE hash = ?').get(hash);
  if (existing) return { ...existing, deduplicated: true, kind: info.kind };

  let width = null;
  let height = null;
  let hasAlpha = null;
  let duration = null;
  if (info.kind === 'image') {
    try {
      const meta = await sharp(buffer).metadata();
      width = meta.width ?? null;
      height = meta.height ?? null;
      hasAlpha = meta.hasAlpha ? 1 : 0;
    } catch {
      throw domainError('asset.unreadable', `"${filename}" looks like an image but could not be decoded.`);
    }
  } else if (info.kind === 'audio' && info.ext === 'wav') {
    duration = wavDuration(buffer);
  }

  const relPath = `assets/originals/${hash.slice(0, 2)}/${hash}.${info.ext}`;
  const abs = resolveInsideNoSymlink(library.root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, buffer);

  db.prepare(`
    INSERT INTO blobs (hash, ext, size, mime, width, height, duration_seconds, has_alpha, path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(hash, info.ext, buffer.length, info.mime, width, height, duration, hasAlpha, relPath, nowIso());
  return { ...db.prepare('SELECT * FROM blobs WHERE hash = ?').get(hash), deduplicated: false, kind: info.kind };
}

/* ---------------- assets and versions ---------------- */

export async function importAsset(library, { buffer, filename, title, importedFrom = '', entityId = null, role = null }) {
  const blob = await storeBlob(library, buffer, filename);
  const kind = blob.kind ?? kindFromMime(blob.mime);
  const db = library.db;
  const id = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const now = nowIso();

  const finalTitle = title?.trim() || filename;
  inTransaction(db, () => {
    db.prepare(`
      INSERT INTO assets (id, title, title_key, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, finalTitle, titleKey(finalTitle), kind, now, now);
    db.prepare(`
      INSERT INTO asset_versions (id, asset_id, blob_hash, version_number, original_filename, imported_from, created_at)
      VALUES (?, ?, ?, 1, ?, ?, ?)
    `).run(versionId, id, blob.hash, filename, importedFrom, now);
    db.prepare('UPDATE assets SET current_version_id = ? WHERE id = ?').run(versionId, id);
    if (entityId && role) {
      assertKnownRole(role);
      db.prepare('INSERT OR IGNORE INTO asset_links (asset_id, entity_id, role, position) VALUES (?, ?, ?, 0)').run(id, entityId, role);
      if (kind === 'image') fillEmptyPreferredSlot(db, id, entityId, role);
    }
    recordActivity(db, 'asset.imported', 'asset', id, filename);
    syncAssetIndex(library, id);
  });
  return getAsset(library, id);
}

/** Replacing an asset creates a new current version; old bytes stay. */
export async function addAssetVersion(library, assetId, { buffer, filename, importedFrom = '', note = '' }) {
  const db = library.db;
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
  if (!asset) throw domainError('asset.missing', 'That asset no longer exists.');
  const blob = await storeBlob(library, buffer, filename);
  const kind = blob.kind ?? kindFromMime(blob.mime);
  if (kind !== asset.kind) {
    throw domainError('asset.kind_mismatch', `This asset holds ${asset.kind} content; "${filename}" is ${kind}.`);
  }
  const versionId = crypto.randomUUID();
  const now = nowIso();
  inTransaction(db, () => {
    const next = (db.prepare('SELECT MAX(version_number) n FROM asset_versions WHERE asset_id = ?').get(assetId)?.n ?? 0) + 1;
    db.prepare(`
      INSERT INTO asset_versions (id, asset_id, blob_hash, version_number, original_filename, imported_from, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(versionId, assetId, blob.hash, next, filename, importedFrom, note, now);
    db.prepare('UPDATE assets SET current_version_id = ?, updated_at = ? WHERE id = ?').run(versionId, now, assetId);
    recordActivity(db, 'asset.new_version', 'asset', assetId, filename);
    syncAssetIndex(library, assetId);
  });
  return getAsset(library, assetId);
}

export function getAsset(library, id) {
  const db = library.db;
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  if (!row) throw domainError('asset.missing', 'That asset no longer exists.');
  const versions = db.prepare(`
    SELECT v.*, b.size, b.mime, b.width, b.height, b.duration_seconds, b.has_alpha, b.path AS blob_path
    FROM asset_versions v JOIN blobs b ON b.hash = v.blob_hash
    WHERE v.asset_id = ? ORDER BY v.version_number DESC
  `).all(id);
  const links = db.prepare(`
    SELECT l.id AS link_id, l.role, l.position, e.id, e.name, e.type
    FROM asset_links l JOIN entities e ON e.id = l.entity_id
    WHERE l.asset_id = ? ORDER BY l.position
  `).all(id);
  const renditions = db.prepare(`
    SELECT g.* FROM generated_renditions g
    JOIN asset_versions v ON v.id = g.version_id
    WHERE v.asset_id = ? ORDER BY g.created_at DESC
  `).all(id);
  const crops = db.prepare(`
    SELECT c.* FROM asset_crops c
    JOIN asset_versions v ON v.id = c.version_id
    WHERE v.asset_id = ?
  `).all(id);
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    status: row.status,
    notes: row.notes,
    currentVersionId: row.current_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: tagsFor(library, 'asset', id),
    versions: versions.map((v) => ({
      id: v.id,
      versionNumber: v.version_number,
      blobHash: v.blob_hash,
      originalFilename: v.original_filename,
      importedFrom: v.imported_from,
      note: v.note,
      createdAt: v.created_at,
      size: v.size,
      mime: v.mime,
      width: v.width,
      height: v.height,
      durationSeconds: v.duration_seconds,
      hasAlpha: !!v.has_alpha,
      url: `worldhub://media/blob/${v.blob_hash}`,
    })),
    links,
    crops,
    renditions: renditions.map((g) => ({ ...g, url: `worldhub://media/rendition/${g.id}` })),
    url: assetDisplayUrl(db, id),
  };
}

export function updateAsset(library, id, { title, notes }) {
  const db = library.db;
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  if (!row) throw domainError('asset.missing', 'That asset no longer exists.');
  inTransaction(db, () => {
    if (title !== undefined && title.trim()) {
      db.prepare('UPDATE assets SET title = ?, title_key = ? WHERE id = ?').run(title.trim(), titleKey(title.trim()), id);
    }
    if (notes !== undefined) db.prepare('UPDATE assets SET notes = ? WHERE id = ?').run(notes, id);
    db.prepare('UPDATE assets SET updated_at = ? WHERE id = ?').run(nowIso(), id);
    syncAssetIndex(library, id);
  });
  return getAsset(library, id);
}

export function setAssetArchived(library, id, archived) {
  const db = library.db;
  if (!db.prepare('SELECT id FROM assets WHERE id = ?').get(id)) {
    throw domainError('asset.missing', 'That asset no longer exists.');
  }
  inTransaction(db, () => {
    db.prepare('UPDATE assets SET status = ?, archived_at = ?, updated_at = ? WHERE id = ?')
      .run(archived ? 'archived' : 'active', archived ? nowIso() : null, nowIso(), id);
    if (archived) removeFromIndex(library, 'asset', id);
    else syncAssetIndex(library, id);
    recordActivity(library.db, archived ? 'asset.archived' : 'asset.restored', 'asset', id);
  });
  return getAsset(library, id);
}

/* ---------------- links ---------------- */

export function setAssetLinks(library, assetId, links) {
  const db = library.db;
  if (!db.prepare('SELECT id FROM assets WHERE id = ?').get(assetId)) {
    throw domainError('asset.missing', 'That asset no longer exists.');
  }
  inTransaction(db, () => {
    db.prepare('DELETE FROM asset_links WHERE asset_id = ?').run(assetId);
    const insert = db.prepare('INSERT OR IGNORE INTO asset_links (asset_id, entity_id, role, position) VALUES (?, ?, ?, ?)');
    links.forEach((link, i) => {
      if (!db.prepare('SELECT id FROM entities WHERE id = ?').get(link.entityId)) {
        throw domainError('entity.missing', 'A linked record no longer exists.');
      }
      assertKnownRole(link.role);
      insert.run(assetId, link.entityId, link.role, i);
      const asset = db.prepare('SELECT kind, status FROM assets WHERE id = ?').get(assetId);
      if (asset?.kind === 'image' && asset.status === 'active') fillEmptyPreferredSlot(db, assetId, link.entityId, link.role);
    });
    syncAssetIndex(library, assetId);
  });
  return getAsset(library, assetId);
}

export function listAssets(library, { entityId, role, kind, worldId, status = 'active', text, aspect, recipeId = 'tile_16x9', limit = 500 } = {}) {
  const db = library.db;
  const where = ['a.status = ?'];
  const args = [status];
  // A record and a role together name one link, not two independent
  // conditions: art linked to Nao as a portrait and to Bram as a tile
  // is not one of Nao's tiles.
  if (entityId && role) {
    where.push('EXISTS (SELECT 1 FROM asset_links l WHERE l.asset_id = a.id AND l.entity_id = ? AND l.role = ?)');
    args.push(entityId, role);
  } else if (entityId) {
    where.push('EXISTS (SELECT 1 FROM asset_links l WHERE l.asset_id = a.id AND l.entity_id = ?)');
    args.push(entityId);
  } else if (role) {
    where.push('EXISTS (SELECT 1 FROM asset_links l WHERE l.asset_id = a.id AND l.role = ?)');
    args.push(role);
  }
  if (worldId) {
    where.push(`EXISTS (
      SELECT 1 FROM asset_links l JOIN entities e ON e.id = l.entity_id
      WHERE l.asset_id = a.id AND (e.world_id = ? OR e.id = ?)
    )`);
    args.push(worldId, worldId);
  }
  if (kind) { where.push('a.kind = ?'); args.push(kind); }
  if (text) { where.push('(a.title LIKE ? OR EXISTS (SELECT 1 FROM asset_versions v WHERE v.asset_id = a.id AND v.original_filename LIKE ?))'); args.push(`%${text}%`, `%${text}%`); }
  const rows = db.prepare(`
    SELECT a.*, b.width, b.height, b.size, b.mime
    FROM assets a
    LEFT JOIN asset_versions cv ON cv.id = a.current_version_id
    LEFT JOIN blobs b ON b.hash = cv.blob_hash
    WHERE ${where.join(' AND ')}
    ORDER BY a.updated_at DESC LIMIT ?
  `).all(...args, limit);

  let mapped = rows.map((row) => ({
    id: row.id,
    title: row.title,
    kind: row.kind,
    status: row.status,
    width: row.width,
    height: row.height,
    size: row.size,
    mime: row.mime,
    updatedAt: row.updated_at,
    currentVersionId: row.current_version_id,
    roles: db.prepare('SELECT DISTINCT role FROM asset_links WHERE asset_id = ?').all(row.id).map((r) => r.role),
    // The roles this asset holds *for the record being browsed*, which is
    // what a per-record view groups by. Empty when no record was named.
    entityRoles: entityId
      ? db.prepare('SELECT DISTINCT role FROM asset_links WHERE asset_id = ? AND entity_id = ? ORDER BY role').all(row.id, entityId).map((r) => r.role)
      : [],
    // Prefer the crop-aware rendition for the caller's recipe when it has
    // already been generated; the renderer lazily creates missing ones as
    // tiles enter view. Until then this is the original, uncropped.
    thumbUrl: assetDisplayUrl(db, row.id, recipeId),
  }));
  if (aspect === 'wide') mapped = mapped.filter((a) => a.width && a.height && a.width / a.height > 1.2);
  else if (aspect === 'tall') mapped = mapped.filter((a) => a.width && a.height && a.height / a.width > 1.2);
  else if (aspect === 'square') mapped = mapped.filter((a) => a.width && a.height && Math.abs(a.width / a.height - 1) <= 0.2);
  return mapped;
}

export function assetUsage(library, id) {
  const db = library.db;
  const links = db.prepare(`
    SELECT e.id, e.name, e.type, l.role FROM asset_links l
    JOIN entities e ON e.id = l.entity_id WHERE l.asset_id = ?
  `).all(id);
  const productions = db.prepare(`
    SELECT DISTINCT p.id, p.name, p.status FROM production_asset_items i
    JOIN production_asset_sets s ON s.id = i.set_id
    JOIN productions p ON p.id = s.production_id
    WHERE i.asset_id = ?
  `).all(id);
  const preferredIn = db.prepare(`
    SELECT e.id, e.name, 'world cover or background' AS via FROM world_profiles w
    JOIN entities e ON e.id = w.entity_id
    WHERE w.cover_asset_id = ? OR w.background_asset_id = ?
    UNION ALL
    SELECT e.id, e.name, 'character portrait or tile' AS via FROM character_profiles c
    JOIN entities e ON e.id = c.entity_id
    WHERE c.portrait_asset_id = ? OR c.tile_asset_id = ?
  `).all(id, id, id, id);
  return { links, productions, preferredIn };
}

/* ---------------- crops and renditions ---------------- */

export function listRecipes(library) {
  return library.db.prepare('SELECT * FROM rendition_recipes ORDER BY builtin DESC, id').all();
}

export function updateRecipe(library, id, patch) {
  const db = library.db;
  const row = db.prepare('SELECT * FROM rendition_recipes WHERE id = ?').get(id);
  if (!row) throw domainError('recipe.missing', 'That rendition recipe does not exist.');
  const fields = {
    name: patch.name, width: patch.width, height: patch.height, fit: patch.fit,
    quality: patch.quality, preserve_alpha: patch.preserveAlpha, background: patch.background,
    allow_upscale: patch.allowUpscale,
  };
  const sets = [];
  const values = [];
  for (const [column, value] of Object.entries(fields)) {
    if (value !== undefined) { sets.push(`${column} = ?`); values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value); }
  }
  if (sets.length > 0) {
    db.prepare(`UPDATE rendition_recipes SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
  }
  return db.prepare('SELECT * FROM rendition_recipes WHERE id = ?').get(id);
}

export function setCrop(library, { versionId, recipeId, focalX, focalY, zoom, panX, panY, rotation, background }) {
  const db = library.db;
  if (!db.prepare('SELECT id FROM asset_versions WHERE id = ?').get(versionId)) {
    throw domainError('asset.version_missing', 'That asset version no longer exists.');
  }
  if (!db.prepare('SELECT id FROM rendition_recipes WHERE id = ?').get(recipeId)) {
    throw domainError('recipe.missing', 'That rendition recipe does not exist.');
  }
  db.prepare(`
    INSERT INTO asset_crops (version_id, recipe_id, focal_x, focal_y, zoom, pan_x, pan_y, rotation, background, updated_at)
    VALUES (@versionId, @recipeId, @focalX, @focalY, @zoom, @panX, @panY, @rotation, @background, @now)
    ON CONFLICT(version_id, recipe_id) DO UPDATE SET
      focal_x = @focalX, focal_y = @focalY, zoom = @zoom, pan_x = @panX, pan_y = @panY,
      rotation = @rotation, background = @background, updated_at = @now
  `).run({ versionId, recipeId, focalX, focalY, zoom, panX, panY, rotation, background, now: nowIso() });
  return getCrop(library, versionId, recipeId);
}

export function getCrop(library, versionId, recipeId) {
  return library.db.prepare('SELECT * FROM asset_crops WHERE version_id = ? AND recipe_id = ?').get(versionId, recipeId) ?? null;
}

/**
 * Bumped whenever renderImage changes in a way that alters output bytes,
 * so cached renditions from an older pipeline fall out and regenerate.
 * 2: transparency is carried through with a lossless alpha channel.
 */
const PIPELINE_VERSION = 2;

/** Deterministic fingerprint of everything that shapes the output. */
function renditionFingerprint(blobHash, recipe, crop) {
  const payload = JSON.stringify({
    pipeline: PIPELINE_VERSION,
    blob: blobHash,
    recipe: {
      w: recipe.width, h: recipe.height, fit: recipe.fit, format: recipe.format,
      q: recipe.quality, alpha: recipe.preserve_alpha, bg: recipe.background, up: recipe.allow_upscale,
    },
    crop: crop ? {
      fx: crop.focal_x, fy: crop.focal_y, z: crop.zoom, px: crop.pan_x, py: crop.pan_y,
      r: crop.rotation, bg: crop.background,
    } : null,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Generate (or return cached) rendition for a version + recipe. Stale
 * outputs from older crop fingerprints are removed. The original is
 * never modified.
 */
export async function generateRendition(library, versionId, recipeId) {
  const db = library.db;
  const version = db.prepare(`
    SELECT v.*, b.path AS blob_path, b.mime, b.hash, b.width, b.height
    FROM asset_versions v JOIN blobs b ON b.hash = v.blob_hash WHERE v.id = ?
  `).get(versionId);
  if (!version) throw domainError('asset.version_missing', 'That asset version no longer exists.');
  const recipe = db.prepare('SELECT * FROM rendition_recipes WHERE id = ?').get(recipeId);
  if (!recipe) throw domainError('recipe.missing', 'That rendition recipe does not exist.');

  if (recipe.format === 'original') {
    return {
      original: true,
      path: version.blob_path,
      mime: version.mime,
      width: version.width,
      height: version.height,
      url: `worldhub://media/blob/${version.hash}`,
    };
  }
  if (!version.mime.startsWith('image/')) {
    throw domainError('asset.not_image', 'Renditions can only be generated from images.');
  }

  const crop = getCrop(library, versionId, recipeId);
  const fingerprint = renditionFingerprint(version.blob_hash, recipe, crop);
  const cached = db.prepare('SELECT * FROM generated_renditions WHERE version_id = ? AND recipe_id = ? AND fingerprint = ?')
    .get(versionId, recipeId, fingerprint);
  if (cached) {
    const cachedAbs = resolveInsideNoSymlink(library.root, cached.path);
    if (fs.existsSync(cachedAbs)) return { ...cached, url: `worldhub://media/rendition/${cached.id}` };
    db.prepare('DELETE FROM generated_renditions WHERE id = ?').run(cached.id);
  }

  const sourceAbs = resolveInsideNoSymlink(library.root, version.blob_path);
  if (!fs.existsSync(sourceAbs)) {
    throw domainError('asset.blob_missing', 'The original file for this version is missing. Run an integrity check.');
  }

  const output = await renderImage(sourceAbs, recipe, crop);
  const relPath = `assets/renditions/${versionId}/${recipeId}-${fingerprint.slice(0, 16)}.webp`;
  const abs = resolveInsideNoSymlink(library.root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, output.buffer);

  const id = crypto.randomUUID();
  inTransaction(db, () => {
    // Cache invalidation: outputs for older fingerprints are stale.
    const stale = db.prepare('SELECT * FROM generated_renditions WHERE version_id = ? AND recipe_id = ?').all(versionId, recipeId);
    for (const old of stale) {
      try { fs.rmSync(resolveInsideNoSymlink(library.root, old.path), { force: true }); } catch { /* best effort */ }
      db.prepare('DELETE FROM generated_renditions WHERE id = ?').run(old.id);
    }
    db.prepare(`
      INSERT INTO generated_renditions (id, version_id, recipe_id, fingerprint, path, width, height, size, mime, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'image/webp', ?)
    `).run(id, versionId, recipeId, fingerprint, relPath, output.width, output.height, output.buffer.length, nowIso());
  });
  return { ...db.prepare('SELECT * FROM generated_renditions WHERE id = ?').get(id), url: `worldhub://media/rendition/${id}` };
}

/** Deterministic sharp pipeline shared by preview and publication. */
async function renderImage(sourceAbs, recipe, crop) {
  const background = parseBackground(crop?.background || recipe.background, recipe.preserve_alpha);
  let image = sharp(sourceAbs, { animated: false }).rotate(); // normalize EXIF orientation

  if (crop?.rotation) {
    image = image.rotate(crop.rotation, { background });
  }

  const meta = await image.clone().metadata();
  const srcW = meta.width;
  const srcH = meta.height;

  if (crop && (crop.zoom !== 1 || crop.focal_x !== 0.5 || crop.focal_y !== 0.5 || crop.pan_x !== 0 || crop.pan_y !== 0)) {
    const window = cropWindow(srcW, srcH, recipe, crop);
    image = image.extract(window);
  }

  const fit = recipe.fit === 'contain' ? 'contain' : 'cover';
  image = image.resize({
    width: recipe.width,
    height: recipe.height,
    fit,
    position: 'centre',
    background,
    // Honored for every fit: when upscaling is off, a small original
    // yields a smaller-than-canvas rendition (its true dimensions are
    // recorded in the database and in assets/index.json).
    withoutEnlargement: !recipe.allow_upscale,
  });

  if (!recipe.preserve_alpha) {
    image = image.flatten({ background });
  }
  // Silhouettes live or die by their edges, so the alpha channel is kept
  // lossless even though the colour channels are not.
  const buffer = await image
    .webp({ quality: recipe.quality, alphaQuality: recipe.preserve_alpha ? 100 : 0 })
    .toBuffer();
  const outMeta = await sharp(buffer).metadata();
  return { buffer, width: outMeta.width, height: outMeta.height };
}

/** Compute the source window for focal point, zoom, and pan. */
function cropWindow(srcW, srcH, recipe, crop) {
  const targetAspect = recipe.width && recipe.height ? recipe.width / recipe.height : srcW / srcH;
  // Largest window with the target aspect that fits in the source.
  let winW = srcW;
  let winH = Math.round(winW / targetAspect);
  if (winH > srcH) {
    winH = srcH;
    winW = Math.round(winH * targetAspect);
  }
  const zoom = Math.max(1, Math.min(8, crop.zoom || 1));
  winW = Math.max(8, Math.round(winW / zoom));
  winH = Math.max(8, Math.round(winH / zoom));

  const cx = (crop.focal_x + (crop.pan_x || 0)) * srcW;
  const cy = (crop.focal_y + (crop.pan_y || 0)) * srcH;
  const left = Math.round(Math.min(Math.max(cx - winW / 2, 0), srcW - winW));
  const top = Math.round(Math.min(Math.max(cy - winH / 2, 0), srcH - winH));
  return { left, top, width: winW, height: winH };
}

function parseBackground(hex, preserveAlpha) {
  if (!hex) return preserveAlpha ? { r: 0, g: 0, b: 0, alpha: 0 } : { r: 18, g: 16, b: 15, alpha: 1 };
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return preserveAlpha ? { r: 0, g: 0, b: 0, alpha: 0 } : { r: 18, g: 16, b: 15, alpha: 1 };
  const value = parseInt(match[1], 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255, alpha: 1 };
}

/* ---------------- safe deletion audit ---------------- */

/** Blobs referenced by no asset version: candidates for the trash. */
export function auditUnreferencedBlobs(library) {
  const db = library.db;
  const rows = db.prepare(`
    SELECT b.* FROM blobs b
    WHERE NOT EXISTS (SELECT 1 FROM asset_versions v WHERE v.blob_hash = b.hash)
  `).all();
  return rows.map((blob) => ({
    hash: blob.hash,
    path: blob.path,
    size: blob.size,
    mime: blob.mime,
    reason: 'No asset version uses these bytes. They may remain from an undone filing.',
  }));
}

/** Move confirmed unreferenced blobs into a recoverable trash folder. */
export function trashUnreferencedBlobs(library, hashes) {
  const db = library.db;
  const audit = new Map(auditUnreferencedBlobs(library).map((b) => [b.hash, b]));
  const moved = [];
  for (const hash of hashes) {
    const blob = audit.get(hash);
    if (!blob) continue; // referenced after all — never touch it
    const abs = resolveInsideNoSymlink(library.root, blob.path);
    const trashRel = `trash/blobs/${path.posix.basename(blob.path)}`;
    const trashAbs = resolveInsideNoSymlink(library.root, trashRel);
    fs.mkdirSync(path.dirname(trashAbs), { recursive: true });
    if (fs.existsSync(abs)) fs.renameSync(abs, trashAbs);
    db.prepare('DELETE FROM blobs WHERE hash = ?').run(hash);
    recordActivity(db, 'blob.trashed', 'blob', hash, blob.path);
    moved.push({ hash, trashPath: trashRel });
  }
  return moved;
}

/* ---------------- media protocol resolvers ---------------- */

export function installMediaResolvers(library) {
  library.mediaResolvers.set('blob', (lib, hash) => {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    const row = lib.db.prepare('SELECT path, mime FROM blobs WHERE hash = ?').get(hash);
    if (!row) return null;
    return { absPath: resolveInsideNoSymlink(lib.root, row.path), mimeType: row.mime };
  });

  library.mediaResolvers.set('rendition', (lib, id) => {
    const row = lib.db.prepare('SELECT path, mime FROM generated_renditions WHERE id = ?').get(id);
    if (!row) return null;
    return { absPath: resolveInsideNoSymlink(lib.root, row.path), mimeType: row.mime };
  });

  library.mediaResolvers.set('inbox', (lib, id) => {
    const row = lib.db.prepare('SELECT staging_path, kind FROM inbox_items WHERE id = ?').get(id);
    if (!row || !row.staging_path) return null;
    const ext = row.staging_path.split('.').pop()?.toLowerCase();
    const map = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
      wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', md: 'text/markdown',
    };
    return {
      absPath: resolveInsideNoSymlink(lib.root, row.staging_path),
      mimeType: map[ext] ?? 'application/octet-stream',
      cacheable: false,
    };
  });
}

/** Displayable worldhub:// URL for an asset's current version, or null. */
export function assetDisplayUrl(db, assetId, recipeId = null) {
  if (!assetId) return null;
  const row = db.prepare(`
    SELECT b.hash, a.current_version_id FROM assets a
    JOIN asset_versions v ON v.id = a.current_version_id
    JOIN blobs b ON b.hash = v.blob_hash
    WHERE a.id = ? AND a.status = 'active'
  `).get(assetId);
  if (!row) return null;
  if (recipeId) {
    const rendition = db.prepare(`
      SELECT id FROM generated_renditions
      WHERE version_id = ? AND recipe_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(row.current_version_id, recipeId);
    if (rendition) return `worldhub://media/rendition/${rendition.id}`;
  }
  return `worldhub://media/blob/${row.hash}`;
}

function kindFromMime(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'text/markdown') return 'markdown';
  return 'attachment';
}
