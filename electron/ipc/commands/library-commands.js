import { app, dialog, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { register } from '../registry.js';
import { v } from '../validate.js';
import {
  createLibrary, openLibrary, closeLibrary, librarySummary, libraryCounts, DESCRIPTOR_FILENAME,
} from '../../services/library-service.js';
import { getAllSettings } from '../../services/settings-service.js';
import { getRecentLibraries, forgetLibrary } from '../../services/app-settings.js';
import { domainError } from '../../services/errors.js';

register('library.status', {
  requiresLibrary: false,
  payload: v.none(),
  handler: (ctx) => {
    if (!ctx.library) return { open: false };
    return {
      open: true,
      library: librarySummary(ctx.library),
      settings: getAllSettings(ctx.library.db),
    };
  },
});

register('library.recents', {
  requiresLibrary: false,
  payload: v.none(),
  handler: () => getRecentLibraries(),
});

register('library.pickCreateLocation', {
  requiresLibrary: false,
  payload: v.none(),
  handler: async (ctx) => {
    if (process.env.WORLDHUB_SMOKE_CREATE_DIRECTORY) {
      return { directory: process.env.WORLDHUB_SMOKE_CREATE_DIRECTORY, suggestedName: 'Chooser Smoke Library' };
    }
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: 'Choose where the new library folder will be created',
      defaultPath: app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return { directory: result.filePaths[0], suggestedName: 'My Worlds' };
  },
});

register('library.pickOpen', {
  requiresLibrary: false,
  payload: v.none(),
  handler: async (ctx) => {
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: 'Open a World Hub library folder',
      defaultPath: app.getPath('documents'),
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const directory = result.filePaths[0];
    if (!fs.existsSync(path.join(directory, DESCRIPTOR_FILENAME))) {
      throw domainError('library.not_a_library', 'That folder is not a World Hub library — it has no world-hub-library.json descriptor.');
    }
    return { directory };
  },
});

register('library.create', {
  requiresLibrary: false,
  payload: v.object({
    directory: v.dialogPath(),
    name: v.string({ min: 1, max: 120, trim: true }),
  }),
  handler: async (ctx, { directory, name }) => {
    return createLibrary(ctx, directory, name);
  },
});

register('library.open', {
  requiresLibrary: false,
  payload: v.object({
    directory: v.dialogPath(),
    readOnly: v.optional(v.boolean(), false),
    takeOverLock: v.optional(v.boolean(), false),
  }),
  handler: async (ctx, { directory, readOnly, takeOverLock }) => {
    try {
      return await openLibrary(ctx, directory, { readOnly, takeOverLock });
    } catch (err) {
      if (err?.code === 'library.not_a_library' || err?.code === 'library.missing_database') {
        forgetLibrary(directory);
      }
      throw err;
    }
  },
});

register('library.close', {
  requiresLibrary: true,
  payload: v.none(),
  handler: async (ctx) => {
    await closeLibrary(ctx);
    ctx.sendEvent('library.closed', {});
    return { closed: true };
  },
});

register('library.counts', {
  requiresLibrary: true,
  payload: v.none(),
  handler: (ctx) => libraryCounts(ctx.library),
});

register('library.reveal', {
  requiresLibrary: true,
  payload: v.none(),
  handler: (ctx) => {
    shell.showItemInFolder(path.join(ctx.library.root, DESCRIPTOR_FILENAME));
    return { revealed: true };
  },
});
