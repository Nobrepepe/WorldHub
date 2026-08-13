import { resolveInsideNoSymlink } from './paths.js';

/**
 * Asset service. Media resolution for the worldhub:// protocol is
 * installed here; import/rendition machinery arrives with the asset
 * pipeline.
 */

/** Register worldhub://media resolvers on an opened library. */
export function installMediaResolvers(library) {
  library.mediaResolvers.set('blob', (lib, hash) => {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    const row = lib.db.prepare('SELECT path, mime FROM blobs WHERE hash = ?').get(hash);
    if (!row) return null;
    return { absPath: resolveInsideNoSymlink(lib.root, row.path), mimeType: row.mime };
  });

  library.mediaResolvers.set('rendition', (lib, id) => {
    const row = lib.db.prepare('SELECT path, mime FROM generated_renditions WHERE id = ?').get(id);
    if (!row) return null;
    return { absPath: resolveInsideNoSymlink(lib.root, row.path), mimeType: row.mime };
  });

  library.mediaResolvers.set('inbox', (lib, id) => {
    const row = lib.db.prepare('SELECT staging_path, kind FROM inbox_items WHERE id = ?').get(id);
    if (!row || !row.staging_path) return null;
    return {
      absPath: resolveInsideNoSymlink(lib.root, row.staging_path),
      mimeType: guessInboxMime(row),
      cacheable: false,
    };
  });
}

/**
 * Displayable worldhub:// URL for an asset's current version, or null.
 * Views use this for gallery and preferred-art thumbnails.
 */
export function assetDisplayUrl(db, assetId) {
  if (!assetId) return null;
  const row = db.prepare(`
    SELECT b.hash FROM assets a
    JOIN asset_versions v ON v.id = a.current_version_id
    JOIN blobs b ON b.hash = v.blob_hash
    WHERE a.id = ? AND a.status = 'active'
  `).get(assetId);
  return row ? `worldhub://media/blob/${row.hash}` : null;
}

function guessInboxMime(row) {
  const ext = row.staging_path.split('.').pop()?.toLowerCase();
  const map = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4',
    md: 'text/markdown',
  };
  return map[ext] ?? 'application/octet-stream';
}
