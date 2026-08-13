import { dialog, shell } from 'electron';
import { register } from '../registry.js';
import { v } from '../validate.js';
import {
  previewPublication, publishProduction, getPublication, verifyPublication, exportPublicationZip,
} from '../../services/publication-service.js';
import { resolveInsideNoSymlink } from '../../services/paths.js';

register('publication.preview', {
  payload: v.object({ productionId: v.uuid() }),
  handler: (ctx, { productionId }) => previewPublication(ctx.library, productionId),
});

register('publication.publish', {
  requiresWrite: true,
  payload: v.object({ productionId: v.uuid() }),
  handler: (ctx, { productionId }) => publishProduction(ctx.library, productionId),
});

register('publication.get', {
  payload: v.object({ id: v.uuid() }),
  handler: (ctx, { id }) => getPublication(ctx.library, id),
});

register('publication.verify', {
  payload: v.object({ id: v.uuid() }),
  handler: (ctx, { id }) => verifyPublication(ctx.library, id),
});

register('publication.reveal', {
  payload: v.object({ id: v.uuid() }),
  handler: (ctx, { id }) => {
    const publication = getPublication(ctx.library, id);
    shell.showItemInFolder(resolveInsideNoSymlink(ctx.library.root, `${publication.directory}/manifest.json`));
    return { revealed: true };
  },
});

register('publication.exportZip', {
  payload: v.object({ id: v.uuid() }),
  handler: async (ctx, { id }) => {
    const publication = getPublication(ctx.library, id);
    const result = await dialog.showSaveDialog(ctx.mainWindow, {
      title: 'Export the snapshot as a ZIP archive',
      defaultPath: `${publication.productionSlug}-${id.slice(0, 8)}.zip`,
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) return null;
    return exportPublicationZip(ctx.library, id, result.filePath);
  },
});
