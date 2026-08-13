import path from 'node:path';

/**
 * File-signature detection for managed content. Extensions are hints;
 * where practical the bytes decide. Returns null when the buffer is
 * empty or unreadable as any supported kind.
 */

export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
export const AUDIO_EXTS = ['wav', 'mp3', 'ogg', 'm4a'];

export const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4',
  md: 'text/markdown',
};

function startsWith(buffer, bytes, offset = 0) {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((byte, i) => buffer[offset + i] === byte);
}

function asciiAt(buffer, text, offset = 0) {
  return startsWith(buffer, [...text].map((c) => c.charCodeAt(0)), offset);
}

/** Detect image type from magic bytes; null when unrecognized. */
export function detectImage(buffer) {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: 'png', mime: 'image/png' };
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return { ext: 'jpg', mime: 'image/jpeg' };
  if (asciiAt(buffer, 'RIFF') && asciiAt(buffer, 'WEBP', 8)) return { ext: 'webp', mime: 'image/webp' };
  if (asciiAt(buffer, 'GIF87a') || asciiAt(buffer, 'GIF89a')) return { ext: 'gif', mime: 'image/gif' };
  return null;
}

/** Detect audio type from magic bytes; null when unrecognized. */
export function detectAudio(buffer) {
  if (asciiAt(buffer, 'RIFF') && asciiAt(buffer, 'WAVE', 8)) return { ext: 'wav', mime: 'audio/wav' };
  if (asciiAt(buffer, 'ID3') || (buffer.length > 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return { ext: 'mp3', mime: 'audio/mpeg' };
  if (asciiAt(buffer, 'OggS')) return { ext: 'ogg', mime: 'audio/ogg' };
  if (asciiAt(buffer, 'ftyp', 4)) return { ext: 'm4a', mime: 'audio/mp4' };
  return null;
}

function looksLikeText(buffer) {
  const sample = buffer.subarray(0, 4096);
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious++;
  }
  return sample.length === 0 || suspicious / sample.length < 0.05;
}

/**
 * Classify a file into a managed kind:
 * { kind: 'image'|'audio'|'markdown'|'attachment', ext, mime } or null
 * for empty/unreadable input.
 */
export function classifyFile(filename, buffer) {
  if (!buffer || buffer.length === 0) return null;
  const ext = path.extname(filename).slice(1).toLowerCase();

  const image = detectImage(buffer);
  if (image) return { kind: 'image', ...image };
  const audio = detectAudio(buffer);
  if (audio) return { kind: 'audio', ...audio };

  if (IMAGE_EXTS.includes(ext) || AUDIO_EXTS.includes(ext)) {
    // The extension promised media but the bytes disagree.
    return null;
  }
  if (ext === 'md' || ext === 'markdown') {
    if (!looksLikeText(buffer)) return null;
    return { kind: 'markdown', ext: 'md', mime: 'text/markdown' };
  }
  return { kind: 'attachment', ext: ext || 'bin', mime: 'application/octet-stream' };
}

/** Duration in seconds from a WAV header, when present. */
export function wavDuration(buffer) {
  try {
    if (!asciiAt(buffer, 'RIFF') || !asciiAt(buffer, 'WAVE', 8)) return null;
    let offset = 12;
    let byteRate = null;
    let dataSize = null;
    while (offset + 8 <= buffer.length) {
      const chunkId = buffer.toString('ascii', offset, offset + 4);
      const chunkSize = buffer.readUInt32LE(offset + 4);
      if (chunkId === 'fmt ') byteRate = buffer.readUInt32LE(offset + 16);
      if (chunkId === 'data') { dataSize = chunkSize; break; }
      offset += 8 + chunkSize + (chunkSize % 2);
    }
    if (byteRate && dataSize) return Math.round((dataSize / byteRate) * 100) / 100;
  } catch { /* fall through */ }
  return null;
}
