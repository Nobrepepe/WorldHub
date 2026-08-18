import { dialog } from 'electron';
import { register } from '../registry.js';
import { v } from '../validate.js';
import {
  importIntoInbox, listBatches, listInbox, itemExcerpt,
  fileItemAsAsset, fileItemAsNewVersion, fileItemAsDocument, setItemStatus, setItemsStatus,
  undoLastFiling, clearFiledStaging, suggestMatches,
} from '../../services/inbox-service.js';

register('inbox.pickImportFiles', {
  requiresWrite: true,
  payload: v.none(),
  handler: async (ctx) => {
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: 'Bring files into the Inbox (the sources are not changed)',
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return importIntoInbox(ctx.library, result.filePaths);
  },
});

register('inbox.pickImportDirectory', {
  requiresWrite: true,
  payload: v.none(),
  handler: async (ctx) => {
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: 'Bring a whole folder into the Inbox (the source is not changed)',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return importIntoInbox(ctx.library, result.filePaths);
  },
});

register('inbox.batches', {
  payload: v.none(),
  handler: (ctx) => listBatches(ctx.library),
});

register('inbox.list', {
  payload: v.object({
    batchId: v.optional(v.uuid(), null),
    status: v.optional(v.enum(['unreviewed', 'filed', 'duplicate', 'ignored', 'error'])),
    kind: v.optional(v.enum(['image', 'audio', 'markdown', 'attachment'])),
    text: v.optional(v.string({ max: 200 })),
    folder: v.optional(v.string({ max: 500 })),
    nameMatch: v.optional(v.boolean()),
    limit: v.optional(v.integer({ min: 1, max: 5000 }), 1000),
  }),
  handler: (ctx, payload) => listInbox(ctx.library, payload),
});

register('inbox.excerpt', {
  payload: v.object({ id: v.uuid() }),
  handler: (ctx, { id }) => ({ excerpt: itemExcerpt(ctx.library, id) }),
});

register('inbox.fileAsset', {
  requiresWrite: true,
  payload: v.object({
    id: v.uuid(),
    title: v.optional(v.string({ max: 300, trim: true })),
    entityId: v.optional(v.uuid(), null),
    role: v.optional(v.string({ max: 100 }), null),
    tags: v.optional(v.array(v.string({ min: 1, max: 100 }), { max: 50 }), []),
  }),
  handler: async (ctx, { id, tags, ...rest }) => {
    const result = await fileItemAsAsset(ctx.library, id, rest);
    if (tags.length > 0) {
      const { setSubjectTags } = await import('../../services/entity-service.js');
      setSubjectTags(ctx.library, 'asset', result.asset.id, tags);
    }
    return result;
  },
});

register('inbox.fileAsNewVersion', {
  requiresWrite: true,
  payload: v.object({
    id: v.uuid(),
    assetId: v.uuid(),
    note: v.optional(v.string({ max: 500, trim: true }), ''),
  }),
  handler: (ctx, { id, ...rest }) => fileItemAsNewVersion(ctx.library, id, rest),
});

register('inbox.fileDocument', {
  requiresWrite: true,
  payload: v.object({
    id: v.uuid(),
    title: v.optional(v.string({ max: 300, trim: true })),
    entityIds: v.optional(v.array(v.uuid(), { max: 50 }), []),
  }),
  handler: (ctx, payload) => fileItemAsDocument(ctx.library, payload.id, payload),
});

register('inbox.setStatus', {
  requiresWrite: true,
  payload: v.object({
    id: v.uuid(),
    status: v.enum(['unreviewed', 'duplicate', 'ignored']),
  }),
  handler: (ctx, { id, status }) => setItemStatus(ctx.library, id, status),
});

register('inbox.setStatuses', {
  requiresWrite: true,
  payload: v.object({
    ids: v.array(v.uuid(), { min: 1, max: 2000 }),
    status: v.enum(['unreviewed', 'duplicate', 'ignored']),
  }),
  handler: (ctx, { ids, status }) => setItemsStatus(ctx.library, ids, status),
});

register('inbox.undoLast', {
  requiresWrite: true,
  payload: v.none(),
  handler: (ctx) => undoLastFiling(ctx.library),
});

register('inbox.clearFiled', {
  requiresWrite: true,
  payload: v.none(),
  handler: (ctx) => clearFiledStaging(ctx.library),
});

register('inbox.suggest', {
  payload: v.object({ id: v.uuid() }),
  handler: (ctx, { id }) => suggestMatches(ctx.library, id),
});
