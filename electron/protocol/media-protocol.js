import { protocol } from 'electron';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { logError } from '../services/log-service.js';

/**
 * Read-only custom protocol for displaying managed files:
 *   worldhub://media/<kind>/<identifier>
 *
 * Only known database-backed kinds resolve, and only while a library is
 * open. The open library exposes resolveMedia(kind, id) which returns
 * { absPath, mimeType } for identifiers it recognizes, or null.
 * Unrestricted file:// access is never exposed to the renderer.
 */

export const MEDIA_SCHEME = 'worldhub';

export function installMediaProtocol(appContext) {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      // With a standard scheme, worldhub://media/blob/x parses as
      // host "media" and pathname "/blob/x".
      if (url.host !== 'media') return notFound();
      const segments = url.pathname.split('/').filter(Boolean);
      if (segments.length < 2) return notFound();
      const [kind, ...idParts] = segments;
      const id = decodeURIComponent(idParts.join('/'));

      const library = appContext.library;
      if (!library || typeof library.resolveMedia !== 'function') return notFound();
      const resolved = await library.resolveMedia(kind, id);
      if (!resolved) return notFound();

      const stat = await fs.promises.stat(resolved.absPath).catch(() => null);
      if (!stat || !stat.isFile()) return notFound();

      const stream = fs.createReadStream(resolved.absPath);
      return new Response(Readable.toWeb(stream), {
        status: 200,
        headers: {
          'content-type': resolved.mimeType ?? 'application/octet-stream',
          'content-length': String(stat.size),
          'cache-control': resolved.cacheable === false ? 'no-store' : 'private, max-age=60',
        },
      });
    } catch (err) {
      logError('protocol.media', err);
      return notFound();
    }
  });
}

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}
