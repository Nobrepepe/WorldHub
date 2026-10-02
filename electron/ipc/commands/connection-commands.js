import { register } from '../registry.js';
import { v } from '../validate.js';
import { ENTITY_TYPES } from '../../services/entity-service.js';
import {
  CONNECTION_STATUSES,
  listConnectionKinds, getConnectionKind, kindsForEndpoint,
  createConnectionKind, updateConnectionKind, deleteConnectionKind, mergeConnectionKinds,
  connectionKindUsage,
  createConnection, getConnection, updateConnection, deleteConnection,
  listConnections, connectionsForEntity, connectionSummary,
} from '../../services/connection-service.js';
import { connectionCategories, CONNECTION_CATEGORY_IDS } from '../../services/connection-vocabulary.js';

const kindId = () => v.string({ min: 1, max: 80, trim: true });
const pairList = () => v.array(v.object({
  sourceType: v.enum(ENTITY_TYPES),
  targetType: v.enum(ENTITY_TYPES),
}), { min: 1, max: 64 });

/* ---------------- kinds ---------------- */

register('connection.categories', {
  payload: v.none(),
  handler: () => connectionCategories(),
});

register('connection.kinds', {
  payload: v.object({
    category: v.optional(v.enum(CONNECTION_CATEGORY_IDS)),
    sourceType: v.optional(v.enum(ENTITY_TYPES)),
    targetType: v.optional(v.enum(ENTITY_TYPES)),
    includeLegacy: v.optional(v.boolean(), true),
  }),
  handler: (ctx, payload) => listConnectionKinds(ctx.library, payload),
});

register('connection.kind', {
  payload: v.object({ id: kindId() }),
  handler: (ctx, { id }) => getConnectionKind(ctx.library, id),
});

/** The kinds a record of this type can hold, already turned to face it. */
register('connection.kindsForType', {
  payload: v.object({
    entityType: v.enum(ENTITY_TYPES),
    category: v.optional(v.enum(CONNECTION_CATEGORY_IDS)),
    includeLegacy: v.optional(v.boolean(), false),
  }),
  handler: (ctx, { entityType, ...rest }) => kindsForEndpoint(ctx.library, entityType, rest),
});

register('connection.kindUsage', {
  payload: v.none(),
  handler: (ctx) => connectionKindUsage(ctx.library),
});

register('connection.kindCreate', {
  requiresWrite: true,
  payload: v.object({
    id: v.optional(v.string({ max: 80, trim: true })),
    category: v.enum(CONNECTION_CATEGORY_IDS),
    forwardLabel: v.string({ min: 1, max: 120, trim: true }),
    inverseLabel: v.optional(v.string({ max: 120, trim: true }), ''),
    forwardSection: v.optional(v.string({ max: 120, trim: true }), ''),
    inverseSection: v.optional(v.string({ max: 120, trim: true }), ''),
    sentence: v.optional(v.string({ max: 300 }), ''),
    symmetric: v.optional(v.boolean(), false),
    pairs: pairList(),
  }),
  handler: (ctx, payload) => createConnectionKind(ctx.library, payload),
});

register('connection.kindUpdate', {
  requiresWrite: true,
  payload: v.object({
    id: kindId(),
    category: v.optional(v.enum(CONNECTION_CATEGORY_IDS)),
    forwardLabel: v.optional(v.string({ min: 1, max: 120, trim: true })),
    inverseLabel: v.optional(v.string({ min: 1, max: 120, trim: true })),
    forwardSection: v.optional(v.string({ max: 120, trim: true })),
    inverseSection: v.optional(v.string({ max: 120, trim: true })),
    sentence: v.optional(v.string({ max: 300 })),
    symmetric: v.optional(v.boolean()),
    pairs: v.optional(pairList()),
  }),
  handler: (ctx, { id, ...patch }) => updateConnectionKind(ctx.library, id, patch),
});

register('connection.kindDelete', {
  requiresWrite: true,
  payload: v.object({ id: kindId() }),
  handler: (ctx, { id }) => deleteConnectionKind(ctx.library, id),
});

register('connection.kindMerge', {
  requiresWrite: true,
  payload: v.object({ fromId: kindId(), toId: kindId() }),
  handler: (ctx, { fromId, toId }) => mergeConnectionKinds(ctx.library, fromId, toId),
});

/* ---------------- connections ---------------- */

register('connection.create', {
  requiresWrite: true,
  payload: v.object({
    kindId: kindId(),
    entityId: v.uuid(),
    counterpartId: v.uuid(),
    description: v.optional(v.string({ max: 2000 }), ''),
    orientation: v.optional(v.enum(['forward', 'inverse']), 'forward'),
    status: v.optional(v.enum(CONNECTION_STATUSES), 'canonical'),
  }),
  handler: (ctx, payload) => createConnection(ctx.library, payload),
});

register('connection.get', {
  payload: v.object({ id: v.uuid() }),
  handler: (ctx, { id }) => getConnection(ctx.library, id),
});

register('connection.update', {
  requiresWrite: true,
  payload: v.object({
    id: v.uuid(),
    kindId: v.optional(kindId()),
    viewerId: v.optional(v.uuid()),
    counterpartId: v.optional(v.uuid()),
    orientation: v.optional(v.enum(['forward', 'inverse'])),
    description: v.optional(v.string({ max: 2000 })),
    labelOverride: v.optional(v.string({ max: 200 })),
    inverseLabelOverride: v.optional(v.string({ max: 200 })),
    position: v.optional(v.integer({ min: 0, max: 100000 })),
    status: v.optional(v.enum(CONNECTION_STATUSES)),
  }),
  handler: (ctx, { id, ...patch }) => updateConnection(ctx.library, id, patch),
});

register('connection.delete', {
  requiresWrite: true,
  payload: v.object({ id: v.uuid() }),
  handler: (ctx, { id }) => deleteConnection(ctx.library, id),
});

register('connection.list', {
  payload: v.object({
    entityId: v.optional(v.uuid(), null),
    kindId: v.optional(kindId(), null),
    category: v.optional(v.enum(CONNECTION_CATEGORY_IDS), null),
    worldId: v.optional(v.uuid(), null),
    sourceType: v.optional(v.enum(ENTITY_TYPES), null),
    targetType: v.optional(v.enum(ENTITY_TYPES), null),
    nameQuery: v.optional(v.string({ max: 200 }), null),
    status: v.optional(v.enum(CONNECTION_STATUSES), null),
    legacyOnly: v.optional(v.boolean(), false),
    customOnly: v.optional(v.boolean(), false),
    limit: v.optional(v.integer({ min: 1, max: 2000 }), 500),
  }),
  handler: (ctx, payload) => listConnections(ctx.library, payload),
});

/** One record's connections, written from its own side and grouped. */
register('connection.forEntity', {
  payload: v.object({
    id: v.uuid(),
    includeArchived: v.optional(v.boolean(), false),
  }),
  handler: (ctx, { id, includeArchived }) => connectionsForEntity(ctx.library, id, { includeArchived }),
});

register('connection.summary', {
  payload: v.object({ id: v.uuid() }),
  handler: (ctx, { id }) => connectionSummary(ctx.library, id),
});
