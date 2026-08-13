import { dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { register, withNotices } from '../registry.js';
import { v } from '../validate.js';
import {
  ASSET_ROLES, importAsset, addAssetVersion, getAsset, updateAsset, setAssetArchived,
  setAssetLinks, listAssets, assetUsage, listRecipes, updateRecipe, setCrop, getCrop,
  generateRendition, auditUnreferencedBlobs, trashUnreferencedBlobs,
} from '../../services/asset-service.js';
import { resolveInsideNoSymlink } from '../../services/paths.js';
import { domainError } from '../../services/errors.js';

const MEDIA_FILTERS = [
  { name: 'Supported files', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'wav', 'mp3', 'ogg', 'm4a', 'md'] },
  { name: 'All files', extensions: ['*'] },
];

register('asset.roles', {
  payload: v.none(),
  handler: () => ASSET_ROLES,
});

register('asset.importFiles', {
  requiresWrite: true,
  payload: v.object({
    entityId: v.optional(v.uuid(), null),
    role: v.optional(v.string({ max: 100 }), null),
  }),
  handler: async (ctx, { entityId, role }) => {
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: 'Import files as managed assets',
      properties: ['openFile', 'multiSelections'],
      filters: MEDIA_FILTERS,
    });
    if (result.canceled || result.filePaths.length === 0) return { imported: [], failed: [] };
    const imported = [];
    const failed = [];
    for (const filePath of result.filePaths) {
      try {
        const buffer = fs.readFileSync(filePath);
        const asset = await importAsset(ctx.library, {
          buffer,
          filename: path.basename(filePath),
          title: path.parse(filePath).name,
          entityId,
          role,
        });
        imported.push(asset);
      } catch (err) {
        failed.push({ file: path.basename(filePath), reason: err.message });
      }
    }
    const notices = failed.map((f) => `${f.file}: ${f.reason}`);
    return withNotices({ imported, failed }, notices);
  },
});

register('asset.replaceVersion', {
  requiresWrite: true,
  payload: v.object({ id: v.uuid() }),
  handler: async (ctx, { id }) => {
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: 'Choose the replacement file (a new version is created; nothing is overwritten)',
      properties: ['openFile'],
      filters: MEDIA_FILTERS,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    return addAssetVersion(ctx.library, id, {
      buffer: fs.readFileSync(filePath),
      filename: path.basename(filePath),
    });
  },
});

register('asset.get', {
  payload: v.object({ id: v.uuid() }),
  handler: (ctx, { id }) => getAsset(ctx.library, id),
});

register('asset.update', {
  requiresWrite: true,
  payload: v.object({
    id: v.uuid(),
    title: v.optional(v.string({ min: 1, max: 300, trim: true })),
    notes: v.optional(v.string({ max: 4000 })),
  }),
  handler: (ctx, { id, ...patch }) => updateAsset(ctx.library, id, patch),
});

register('asset.setArchived', {
  requiresWrite: true,
  payload: v.object({ id: v.uuid(), archived: v.boolean() }),
  handler: (ctx, { id, archived }) => setAssetArchived(ctx.library, id, archived),
});

register('asset.setLinks', {
  requiresWrite: true,
  payload: v.object({
    id: v.uuid(),
    links: v.array(v.object({
      entityId: v.uuid(),
      role: v.string({ min: 1, max: 100 }),
    }), { max: 100 }),
  }),
  handler: (ctx, { id, links }) => setAssetLinks(ctx.library, id, links),
});

register('asset.list', {
  payload: v.object({
    entityId: v.optional(v.uuid(), null),
    role: v.optional(v.string({ max: 100 })),
    kind: v.optional(v.enum(['image', 'audio', 'markdown', 'attachment'])),
    worldId: v.optional(v.uuid(), null),
    status: v.optional(v.enum(['active', 'archived']), 'active'),
    text: v.optional(v.string({ max: 200 })),
    aspect: v.optional(v.enum(['wide', 'tall', 'square'])),
    limit: v.optional(v.integer({ min: 1, max: 2000 }), 500),
  }),
  handler: (ctx, payload) => listAssets(ctx.library, payload),
});

register('asset.usage', {
  payload: v.object({ id: v.uuid() }),
  handler: (ctx, { id }) => assetUsage(ctx.library, id),
});

register('asset.revealOriginal', {
  payload: v.object({ versionId: v.uuid() }),
  handler: (ctx, { versionId }) => {
    const row = ctx.library.db.prepare(`
      SELECT b.path FROM asset_versions v JOIN blobs b ON b.hash = v.blob_hash WHERE v.id = ?
    `).get(versionId);
    if (!row) throw domainError('asset.version_missing', 'That asset version no longer exists.');
    shell.showItemInFolder(resolveInsideNoSymlink(ctx.library.root, row.path));
    return { revealed: true };
  },
});

register('recipe.list', {
  payload: v.none(),
  handler: (ctx) => listRecipes(ctx.library),
});

register('recipe.update', {
  requiresWrite: true,
  payload: v.object({
    id: v.string({ min: 1, max: 100 }),
    name: v.optional(v.string({ min: 1, max: 200 })),
    width: v.optional(v.integer({ min: 16, max: 8192 })),
    height: v.optional(v.integer({ min: 16, max: 8192 })),
    fit: v.optional(v.enum(['contain', 'cover'])),
    quality: v.optional(v.integer({ min: 30, max: 100 })),
    preserveAlpha: v.optional(v.boolean()),
    background: v.optional(v.string({ max: 20 })),
    allowUpscale: v.optional(v.boolean()),
  }),
  handler: (ctx, { id, ...patch }) => updateRecipe(ctx.library, id, patch),
});

register('crop.set', {
  requiresWrite: true,
  payload: v.object({
    versionId: v.uuid(),
    recipeId: v.string({ min: 1, max: 100 }),
    focalX: v.number({ min: 0, max: 1 }),
    focalY: v.number({ min: 0, max: 1 }),
    zoom: v.number({ min: 1, max: 8 }),
    panX: v.optional(v.number({ min: -1, max: 1 }), 0),
    panY: v.optional(v.number({ min: -1, max: 1 }), 0),
    rotation: v.optional(v.number({ min: -180, max: 180 }), 0),
    background: v.optional(v.string({ max: 20 }), ''),
  }),
  handler: (ctx, payload) => setCrop(ctx.library, payload),
});

register('crop.get', {
  payload: v.object({ versionId: v.uuid(), recipeId: v.string({ min: 1, max: 100 }) }),
  handler: (ctx, { versionId, recipeId }) => getCrop(ctx.library, versionId, recipeId),
});

register('rendition.generate', {
  requiresWrite: true,
  payload: v.object({ versionId: v.uuid(), recipeId: v.string({ min: 1, max: 100 }) }),
  handler: (ctx, { versionId, recipeId }) => generateRendition(ctx.library, versionId, recipeId),
});

register('asset.auditBlobs', {
  payload: v.none(),
  handler: (ctx) => auditUnreferencedBlobs(ctx.library),
});

register('asset.trashBlobs', {
  requiresWrite: true,
  payload: v.object({ hashes: v.array(v.string({ min: 64, max: 64 }), { min: 1, max: 1000 }) }),
  handler: (ctx, { hashes }) => trashUnreferencedBlobs(ctx.library, hashes),
});
