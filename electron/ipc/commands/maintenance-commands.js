import { app, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { register } from '../registry.js';
import { v } from '../validate.js';
import {
  createSafetyBackup, listSafetyBackups, createFullArchive, validateArchive,
  restoreArchiveToNewFolder, replaceCurrentFromArchive, recoverDatabaseFromBackup,
} from '../../services/backup-service.js';
import { runIntegrityChecks, lastIntegrityRun, runRepair } from '../../services/integrity-service.js';
import { getAllSettings, setSetting } from '../../services/settings-service.js';
import { writeJsonAtomic } from '../../services/atomic-file.js';
import { librarySummary, DESCRIPTOR_FILENAME } from '../../services/library-service.js';
import { domainError } from '../../services/errors.js';

/* ---------------- settings ---------------- */

register('settings.update', {
  requiresWrite: true,
  payload: v.object({
    textScale: v.optional(v.number({ min: 0.8, max: 1.6 })),
    reducedMotion: v.optional(v.boolean()),
    renditionQuality: v.optional(v.integer({ min: 50, max: 100 })),
    autoBackup: v.optional(v.boolean()),
  }),
  handler: (ctx, patch) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) setSetting(ctx.library.db, key, value);
    }
    return getAllSettings(ctx.library.db);
  },
});

register('library.rename', {
  requiresWrite: true,
  payload: v.object({ name: v.string({ min: 1, max: 120, trim: true }) }),
  handler: (ctx, { name }) => {
    ctx.library.descriptor.name = name;
    writeJsonAtomic(path.join(ctx.library.root, DESCRIPTOR_FILENAME), ctx.library.descriptor);
    return librarySummary(ctx.library);
  },
});

/* ---------------- backups ---------------- */

register('backup.safetyNow', {
  requiresWrite: true,
  payload: v.none(),
  handler: (ctx) => createSafetyBackup(ctx.library, 'manual'),
});

register('backup.list', {
  payload: v.none(),
  handler: (ctx) => listSafetyBackups(ctx.library.root),
});

register('backup.createArchive', {
  payload: v.object({ includePublications: v.optional(v.boolean(), true) }),
  handler: async (ctx, { includePublications }) => {
    const result = await dialog.showSaveDialog(ctx.mainWindow, {
      title: 'Create a full portable archive',
      defaultPath: path.join(app.getPath('documents'), `world-hub-${new Date().toISOString().slice(0, 10)}.zip`),
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) return null;
    return createFullArchive(ctx.library, result.filePath, { includePublications });
  },
});

register('backup.replaceFromArchive', {
  requiresWrite: true,
  payload: v.none(),
  handler: async (ctx) => {
    const picked = await dialog.showOpenDialog(ctx.mainWindow, {
      title: 'Choose the archive to restore (the current library is validated, backed up, and kept aside)',
      properties: ['openFile'],
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    return replaceCurrentFromArchive(ctx, picked.filePaths[0]);
  },
});

register('backup.validateArchive', {
  requiresLibrary: false,
  payload: v.object({ path: v.dialogPath() }),
  handler: async (ctx, { path: zipPath }) => {
    const scratch = path.join(ctx.userDataDir, 'tmp');
    const { manifest, descriptor } = await validateArchive(zipPath, scratch);
    return { valid: true, libraryName: descriptor.name, createdAt: manifest.createdAt };
  },
});

register('backup.restoreToNew', {
  requiresLibrary: false,
  payload: v.none(),
  handler: async (ctx) => {
    if (ctx.library) throw domainError('library.already_open', 'Close the current library first.');
    const archive = await dialog.showOpenDialog(ctx.mainWindow, {
      title: 'Choose a World Hub archive',
      properties: ['openFile'],
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    if (archive.canceled || archive.filePaths.length === 0) return null;
    const parent = await dialog.showOpenDialog(ctx.mainWindow, {
      title: 'Choose where the restored library folder will be created',
      defaultPath: app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (parent.canceled || parent.filePaths.length === 0) return null;
    const scratch = path.join(ctx.userDataDir, 'tmp');
    return restoreArchiveToNewFolder(archive.filePaths[0], parent.filePaths[0], scratch);
  },
});

/* ---------------- corrupt-database recovery ---------------- */

register('library.recoveryBackups', {
  requiresLibrary: false,
  payload: v.object({ directory: v.dialogPath() }),
  handler: (ctx, { directory }) => {
    if (!fs.existsSync(path.join(directory, DESCRIPTOR_FILENAME))) {
      throw domainError('library.not_a_library', 'That folder is not a World Hub library.');
    }
    return listSafetyBackups(directory);
  },
});

register('library.recoverDatabase', {
  requiresLibrary: false,
  payload: v.object({ directory: v.dialogPath(), backupName: v.string({ min: 1, max: 200 }) }),
  handler: (ctx, { directory, backupName }) => {
    if (!fs.existsSync(path.join(directory, DESCRIPTOR_FILENAME))) {
      throw domainError('library.not_a_library', 'That folder is not a World Hub library.');
    }
    return recoverDatabaseFromBackup(directory, backupName);
  },
});

/* ---------------- integrity ---------------- */

register('integrity.run', {
  payload: v.none(),
  handler: (ctx) => runIntegrityChecks(ctx.library),
});

register('integrity.last', {
  payload: v.none(),
  handler: (ctx) => lastIntegrityRun(ctx.library),
});

register('integrity.repair', {
  requiresWrite: true,
  payload: v.object({ repairId: v.enum(['recreate-folders', 'rebuild-search', 'regenerate-renditions', 'clear-tmp']) }),
  handler: (ctx, { repairId }) => runRepair(ctx.library, repairId),
});
