import { dialog } from 'electron';
import { register } from '../registry.js';
import { v } from '../validate.js';
import {
  validateContractJson, createContract, updateContract, getContract, listContracts,
  setContractStatus, duplicateContract, installExampleContract,
  importContractFile, contractDrift,
} from '../../services/contract-service.js';
import {
  createProduction, getProduction, updateProduction, setProductionValue, setSelection,
  setAssetSetItems, validateProduction, setProductionStatus, listProductions,
  rebindTargets, planProductionRebind, rebindProduction,
} from '../../services/production-service.js';

register('contract.validate', {
  payload: v.object({ contract: v.json() }),
  handler: (ctx, { contract }) => ({ issues: validateContractJson(contract) }),
});

register('contract.create', {
  requiresWrite: true,
  payload: v.object({ contract: v.json() }),
  handler: (ctx, { contract }) => createContract(ctx.library, contract),
});

register('contract.update', {
  requiresWrite: true,
  payload: v.object({ contractId: v.uuid(), contract: v.json() }),
  handler: (ctx, { contractId, contract }) => updateContract(ctx.library, contractId, contract),
});

register('contract.get', {
  payload: v.object({
    contractId: v.uuid(),
    version: v.optional(v.integer({ min: 1 }), null),
  }),
  handler: (ctx, { contractId, version }) => getContract(ctx.library, contractId, version ?? null),
});

register('contract.list', {
  payload: v.object({ includeArchived: v.optional(v.boolean(), false) }),
  handler: (ctx, payload) => listContracts(ctx.library, payload),
});

register('contract.setStatus', {
  requiresWrite: true,
  payload: v.object({ contractId: v.uuid(), status: v.enum(['active', 'archived']) }),
  handler: (ctx, { contractId, status }) => setContractStatus(ctx.library, contractId, status),
});

register('contract.duplicate', {
  requiresWrite: true,
  payload: v.object({ contractId: v.uuid() }),
  handler: (ctx, { contractId }) => duplicateContract(ctx.library, contractId),
});

register('contract.importFile', {
  requiresWrite: true,
  payload: v.object({ sourcePath: v.optional(v.nullable(v.string({ max: 4096 })), null) }),
  handler: async (ctx, { sourcePath }) => {
    let chosen = sourcePath ?? null;
    if (!chosen) {
      const result = await dialog.showOpenDialog(ctx.mainWindow, {
        title: 'Import an application contract',
        filters: [{ name: 'Application contract', extensions: ['json'] }],
        properties: ['openFile'],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      chosen = result.filePaths[0];
    }
    return importContractFile(ctx.library, chosen);
  },
});

register('contract.drift', {
  payload: v.object({ contractId: v.uuid() }),
  handler: (ctx, { contractId }) => contractDrift(ctx.library, contractId),
});

register('contract.installExample', {
  requiresWrite: true,
  payload: v.none(),
  handler: (ctx) => installExampleContract(ctx.library),
});

register('production.create', {
  requiresWrite: true,
  payload: v.object({
    name: v.string({ min: 1, max: 200, trim: true }),
    contractId: v.uuid(),
    contractVersion: v.optional(v.integer({ min: 1 }), null),
    worldId: v.optional(v.uuid(), null),
  }),
  handler: (ctx, payload) => createProduction(ctx.library, payload),
});

register('production.get', {
  payload: v.object({ id: v.uuid() }),
  handler: (ctx, { id }) => getProduction(ctx.library, id),
});

register('production.update', {
  requiresWrite: true,
  payload: v.object({
    id: v.uuid(),
    name: v.optional(v.string({ min: 1, max: 200, trim: true })),
    worldId: v.optional(v.nullable(v.uuid())),
  }),
  handler: (ctx, { id, ...patch }) => updateProduction(ctx.library, id, patch),
});

register('production.setValue', {
  requiresWrite: true,
  payload: v.object({
    id: v.uuid(),
    scope: v.enum(['production', 'entity']),
    entityId: v.optional(v.string({ max: 36 }), ''),
    field: v.string({ min: 1, max: 100 }),
    value: v.json({ maxBytes: 500_000 }),
  }),
  handler: (ctx, { id, ...payload }) => setProductionValue(ctx.library, id, payload),
});

register('production.setSelection', {
  requiresWrite: true,
  payload: v.object({
    id: v.uuid(),
    slot: v.string({ min: 1, max: 100 }),
    entityIds: v.array(v.uuid(), { max: 500 }),
  }),
  handler: (ctx, { id, slot, entityIds }) => setSelection(ctx.library, id, slot, entityIds),
});

register('production.setAssetSet', {
  requiresWrite: true,
  payload: v.object({
    id: v.uuid(),
    slot: v.string({ min: 1, max: 100 }),
    entityId: v.optional(v.string({ max: 36 }), ''),
    items: v.array(v.object({
      assetId: v.uuid(),
      values: v.optional(v.json({ maxBytes: 100_000 }), {}),
    }), { max: 500 }),
  }),
  handler: (ctx, { id, ...payload }) => setAssetSetItems(ctx.library, id, payload),
});

register('production.validate', {
  payload: v.object({ id: v.uuid() }),
  handler: (ctx, { id }) => validateProduction(ctx.library, id),
});

register('production.setStatus', {
  requiresWrite: true,
  payload: v.object({ id: v.uuid(), status: v.enum(['draft', 'ready', 'archived']) }),
  handler: (ctx, { id, status }) => setProductionStatus(ctx.library, id, status),
});

register('production.list', {
  payload: v.object({ includeArchived: v.optional(v.boolean(), false) }),
  handler: (ctx, payload) => listProductions(ctx.library, payload),
});

register('production.rebindTargets', {
  payload: v.object({ id: v.uuid() }),
  handler: (ctx, { id }) => rebindTargets(ctx.library, id),
});

register('production.planRebind', {
  payload: v.object({
    id: v.uuid(),
    contractId: v.optional(v.nullable(v.uuid()), null),
    contractVersion: v.optional(v.nullable(v.integer({ min: 1 })), null),
  }),
  handler: (ctx, { id, ...payload }) => planProductionRebind(ctx.library, id, payload),
});

register('production.rebind', {
  requiresWrite: true,
  payload: v.object({
    id: v.uuid(),
    contractId: v.optional(v.nullable(v.uuid()), null),
    contractVersion: v.optional(v.nullable(v.integer({ min: 1 })), null),
  }),
  handler: (ctx, { id, ...payload }) => rebindProduction(ctx.library, id, payload),
});
