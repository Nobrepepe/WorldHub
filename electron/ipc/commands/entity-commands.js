import { register } from '../registry.js';
import { v } from '../validate.js';
import {
  ENTITY_TYPES, createEntity, getEntity, updateEntity, listEntities, entityUsage,
  archiveEntity, restoreEntity,
  createRelationship, updateRelationship, deleteRelationship, listRelationships, listRelationshipTypes,
  listTags, setSubjectTags, tagsFor,
  preferredRendition,
} from '../../services/entity-service.js';
import { rebuildSearchIndex, searchLibrary } from '../../services/search-service.js';

const optionalUuid = () => v.optional(v.uuid(), null);

register('entity.create', {
  requiresWrite: true,
  payload: v.object({
    type: v.enum(ENTITY_TYPES),
    name: v.string({ min: 1, max: 200, trim: true }),
    worldId: optionalUuid(),
    summary: v.optional(v.string({ max: 2000 }), ''),
  }),
  handler: (ctx, payload) => createEntity(ctx.library, payload),
});

register('entity.get', {
  payload: v.object({ id: v.uuid() }),
  handler: (ctx, { id }) => getEntity(ctx.library, id),
});

register('entity.preferredArt', {
  payload: v.object({
    id: v.uuid(), recipeId: v.string({ min: 1, max: 100 }),
    slot: v.optional(v.enum(['cover', 'background', 'portrait', 'tile'])),
  }),
  handler: async (ctx, { id, recipeId, slot }) => {
    const entity = getEntity(ctx.library, id);
    return preferredRendition(ctx.library, entity.type, id, recipeId, slot);
  },
});

register('entity.update', {
  requiresWrite: true,
  payload: v.object({
    id: v.uuid(),
    name: v.optional(v.string({ min: 1, max: 200, trim: true })),
    slug: v.optional(v.string({ min: 1, max: 100 })),
    summary: v.optional(v.string({ max: 2000 })),
    status: v.optional(v.enum(['draft', 'canonical', 'archived'])),
    worldId: v.optional(v.nullable(v.uuid())),
    sortOrder: v.optional(v.integer({ min: -100000, max: 100000 })),
    aliases: v.optional(v.array(v.string({ max: 200 }), { max: 50 })),
    profile: v.optional(v.object({
      tagline: v.optional(v.string({ max: 500 })),
      genre: v.optional(v.string({ max: 200 })),
      tone: v.optional(v.string({ max: 200 })),
      settingDescription: v.optional(v.string({ max: 4000 })),
      visualDirection: v.optional(v.string({ max: 4000 })),
      coverAssetId: v.optional(v.nullable(v.uuid())),
      backgroundAssetId: v.optional(v.nullable(v.uuid())),
      role: v.optional(v.string({ max: 200 })),
      ageText: v.optional(v.string({ max: 200 })),
      appearance: v.optional(v.string({ max: 4000 })),
      personality: v.optional(v.string({ max: 4000 })),
      biography: v.optional(v.string({ max: 4000 })),
      voice: v.optional(v.string({ max: 4000 })),
      portraitAssetId: v.optional(v.nullable(v.uuid())),
      tileAssetId: v.optional(v.nullable(v.uuid())),
    })),
  }),
  handler: (ctx, { id, ...patch }) => updateEntity(ctx.library, id, patch),
});

register('entity.list', {
  payload: v.object({
    type: v.optional(v.enum(ENTITY_TYPES)),
    types: v.optional(v.array(v.enum(ENTITY_TYPES), { max: 8 })),
    worldId: optionalUuid(),
    status: v.optional(v.enum(['draft', 'canonical', 'archived'])),
    tagId: optionalUuid(),
    limit: v.optional(v.integer({ min: 1, max: 2000 }), 500),
    offset: v.optional(v.integer({ min: 0 }), 0),
  }),
  handler: (ctx, payload) => listEntities(ctx.library, payload),
});

register('entity.usage', {
  payload: v.object({ id: v.uuid() }),
  handler: (ctx, { id }) => entityUsage(ctx.library, id),
});

register('entity.archive', {
  requiresWrite: true,
  payload: v.object({ id: v.uuid() }),
  handler: (ctx, { id }) => archiveEntity(ctx.library, id),
});

register('entity.restore', {
  requiresWrite: true,
  payload: v.object({ id: v.uuid() }),
  handler: (ctx, { id }) => restoreEntity(ctx.library, id),
});

register('relationship.create', {
  requiresWrite: true,
  payload: v.object({
    sourceId: v.uuid(),
    targetId: v.uuid(),
    relType: v.string({ min: 1, max: 100, trim: true }),
    label: v.optional(v.string({ max: 200 }), ''),
    description: v.optional(v.string({ max: 2000 }), ''),
    inverseLabel: v.optional(v.string({ max: 200 }), ''),
  }),
  handler: (ctx, payload) => createRelationship(ctx.library, payload),
});

register('relationship.update', {
  requiresWrite: true,
  payload: v.object({
    id: v.uuid(),
    relType: v.optional(v.string({ min: 1, max: 100, trim: true })),
    label: v.optional(v.string({ max: 200 })),
    description: v.optional(v.string({ max: 2000 })),
    inverseLabel: v.optional(v.string({ max: 200 })),
    position: v.optional(v.integer({ min: 0, max: 100000 })),
    status: v.optional(v.enum(['draft', 'canonical', 'archived'])),
  }),
  handler: (ctx, { id, ...patch }) => updateRelationship(ctx.library, id, patch),
});

register('relationship.delete', {
  requiresWrite: true,
  payload: v.object({ id: v.uuid() }),
  handler: (ctx, { id }) => deleteRelationship(ctx.library, id),
});

register('relationship.list', {
  payload: v.object({
    entityId: optionalUuid(),
    relType: v.optional(v.string({ max: 100 })),
    worldId: optionalUuid(),
    limit: v.optional(v.integer({ min: 1, max: 2000 }), 500),
  }),
  handler: (ctx, payload) => listRelationships(ctx.library, payload),
});

register('relationship.types', {
  payload: v.none(),
  handler: (ctx) => listRelationshipTypes(ctx.library),
});

register('tag.list', {
  payload: v.none(),
  handler: (ctx) => listTags(ctx.library),
});

register('tag.setForSubject', {
  requiresWrite: true,
  payload: v.object({
    subjectType: v.enum(['entity', 'document', 'asset', 'production']),
    subjectId: v.uuid(),
    tags: v.array(v.string({ min: 1, max: 100, trim: true }), { max: 50 }),
  }),
  handler: (ctx, { subjectType, subjectId, tags }) => setSubjectTags(ctx.library, subjectType, subjectId, tags),
});

register('tag.forSubject', {
  payload: v.object({
    subjectType: v.enum(['entity', 'document', 'asset', 'production']),
    subjectId: v.uuid(),
  }),
  handler: (ctx, { subjectType, subjectId }) => tagsFor(ctx.library, subjectType, subjectId),
});

register('search.query', {
  payload: v.object({
    query: v.string({ min: 1, max: 200 }),
    types: v.optional(v.array(v.enum(['world', 'character', 'entry', 'document', 'asset', 'relationship']), { max: 6 })),
    worldId: optionalUuid(),
    tagId: optionalUuid(),
    role: v.optional(v.string({ max: 100 })),
    status: v.optional(v.enum(['draft', 'canonical', 'active'])),
    modifiedAfter: v.optional(v.string({ max: 40 })),
    limit: v.optional(v.integer({ min: 1, max: 200 }), 60),
  }),
  handler: (ctx, payload) => searchLibrary(ctx.library, payload),
});

register('search.rebuild', {
  requiresWrite: true,
  payload: v.none(),
  handler: (ctx) => rebuildSearchIndex(ctx.library),
});
