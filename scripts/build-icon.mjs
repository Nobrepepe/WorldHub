#!/usr/bin/env node
/**
 * Render the application icon from its single source, `packaging/world-hub.svg`,
 * into the PNG the app and the packaged builds actually load.
 *
 * The PNG is committed because Electron's window icon and electron-builder both
 * want a raster file at runtime and build time — but it is derived, never
 * edited. Change the SVG, run this, commit both.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(projectRoot, 'packaging/world-hub.svg');
const target = path.join(projectRoot, 'assets/icon/world-hub.png');
const size = 512;

await sharp(source, { density: 288 }).resize(size, size).png().toFile(target);
console.log(`Rendered ${path.relative(projectRoot, target)} at ${size}×${size} from ${path.relative(projectRoot, source)}.`);
