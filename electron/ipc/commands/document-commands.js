import { register } from '../registry.js';
import { v } from '../validate.js';
import {
  createDocument, getDocument, saveDocument, saveRecoveredCopy, renameDocument,
  duplicateDocument, setDocumentStatus, setDocumentLinks, listDocuments,
} from '../../services/document-service.js';

const MAX_DOC = 4_000_000;

register('document.create', {
  requiresWrite: true,
  payload: v.object({
    title: v.string({ min: 1, max: 300, trim: true }),
    entityIds: v.optional(v.array(v.uuid(), { max: 100 }), []),
    content: v.optional(v.string({ max: MAX_DOC }), ''),
  }),
  handler: (ctx, payload) => createDocument(ctx.library, payload),
});

register('document.get', {
  payload: v.object({ id: v.uuid() }),
  handler: (ctx, { id }) => getDocument(ctx.library, id),
});

register('document.save', {
  requiresWrite: true,
  payload: v.object({
    id: v.uuid(),
    content: v.string({ max: MAX_DOC }),
    baseChecksum: v.string({ min: 64, max: 64 }),
  }),
  handler: (ctx, payload) => saveDocument(ctx.library, payload),
});

register('document.saveRecovered', {
  requiresWrite: true,
  payload: v.object({ id: v.uuid(), content: v.string({ max: MAX_DOC }) }),
  handler: (ctx, payload) => saveRecoveredCopy(ctx.library, payload),
});

register('document.rename', {
  requiresWrite: true,
  payload: v.object({ id: v.uuid(), title: v.string({ min: 1, max: 300, trim: true }) }),
  handler: (ctx, payload) => renameDocument(ctx.library, payload),
});

register('document.duplicate', {
  requiresWrite: true,
  payload: v.object({ id: v.uuid() }),
  handler: (ctx, { id }) => duplicateDocument(ctx.library, id),
});

register('document.setStatus', {
  requiresWrite: true,
  payload: v.object({ id: v.uuid(), status: v.enum(['draft', 'canonical', 'archived']) }),
  handler: (ctx, { id, status }) => setDocumentStatus(ctx.library, id, status),
});

register('document.setLinks', {
  requiresWrite: true,
  payload: v.object({ id: v.uuid(), entityIds: v.array(v.uuid(), { max: 100 }) }),
  handler: (ctx, { id, entityIds }) => setDocumentLinks(ctx.library, id, entityIds),
});

register('document.list', {
  payload: v.object({
    entityId: v.optional(v.uuid(), null),
    status: v.optional(v.enum(['draft', 'canonical', 'archived'])),
    text: v.optional(v.string({ max: 200 })),
    limit: v.optional(v.integer({ min: 1, max: 2000 }), 500),
  }),
  handler: (ctx, payload) => listDocuments(ctx.library, payload),
});
