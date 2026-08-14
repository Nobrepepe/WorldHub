#!/usr/bin/env node
// Re-copies the authoritative consumer contracts into tests/fixtures/contracts.
// The consumer repositories are the source of truth; World Hub only keeps
// test copies so its conformance tests run without sibling checkouts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const apps = {
  taskstamps: 'TaskStamps',
  chatbot: 'ChatBot',
  stickeralbum: 'StickerAlbum',
  herocollector: 'HeroCollector',
};
for (const [slug, repo] of Object.entries(apps)) {
  const source = path.join(root, '..', repo, 'worldhub', 'application-contract.json');
  const target = path.join(root, 'tests', 'fixtures', 'contracts', `${slug}.json`);
  if (!fs.existsSync(source)) {
    console.error(`skip ${repo}: ${source} not found`);
    continue;
  }
  fs.copyFileSync(source, target);
  console.log(`synced ${repo} -> tests/fixtures/contracts/${slug}.json`);
}
