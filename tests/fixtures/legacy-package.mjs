import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Turn a published package into one shaped the way Protocol 1 wrote them.
 *
 * World Hub keeps its own sample rather than borrowing a consumer's fixture:
 * those move to the current protocol as each application is migrated, and a
 * test whose subject disappears when the work succeeds is not a test of
 * backward compatibility at all.
 */

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function rewrite(root, relPath, mutate) {
  const file = path.join(root, ...relPath.split('/'));
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bytes = Buffer.from(`${JSON.stringify(mutate(value) ?? value, null, 2)}\n`);
  fs.writeFileSync(file, bytes);
  return bytes;
}

function reseal(root, changed) {
  const checksumFile = path.join(root, 'checksums.json');
  const checksums = JSON.parse(fs.readFileSync(checksumFile, 'utf8'));
  for (const [relPath, bytes] of Object.entries(changed)) checksums[relPath] = sha256(bytes);
  fs.writeFileSync(checksumFile, `${JSON.stringify(checksums, null, 2)}\n`);
}

/** Copy `source` to `destination` and rewrite it as a Protocol 1 package. */
export function makeLegacyPackage(source, destination, { retireRecipe = null } = {}) {
  fs.cpSync(source, destination, { recursive: true });
  const changed = {};

  changed['manifest.json'] = rewrite(destination, 'manifest.json', (manifest) => {
    manifest.protocolVersion = 1;
    manifest.contract = { id: manifest.contract.id, version: manifest.contract.revision };
    delete manifest.vocabularyVersion;
    delete manifest.renamedFrom;
  });

  changed['production/contract.json'] = rewrite(destination, 'production/contract.json', (contract) => {
    contract.contractVersion = contract.contractFormatVersion;
    delete contract.contractFormatVersion;
    contract.supportedProtocolVersions = [1];
  });

  /* Protocol 1 published no connection-kind definitions at all, and its
     relationships carried only their own labels. Removing them here is what
     makes this a real backward-compatibility test rather than a current
     package wearing an old version number. */
  const kindsFile = path.join(destination, 'catalog', 'connection-kinds.json');
  if (fs.existsSync(kindsFile)) {
    fs.rmSync(kindsFile);
    const checksums = JSON.parse(fs.readFileSync(path.join(destination, 'checksums.json'), 'utf8'));
    delete checksums['catalog/connection-kinds.json'];
    fs.writeFileSync(path.join(destination, 'checksums.json'), `${JSON.stringify(checksums, null, 2)}\n`);
  }
  changed['catalog/relationships.json'] = rewrite(destination, 'catalog/relationships.json', (relationships) => {
    for (const relationship of relationships) {
      delete relationship.kindId;
      delete relationship.category;
    }
  });

  /* Protocol 1 named the second character display slot differently. */
  changed['catalog/characters.json'] = rewrite(destination, 'catalog/characters.json', (characters) => {
    for (const character of characters) {
      character.fullBodyAssetId = character.tileAssetId ?? null;
      delete character.tileAssetId;
    }
  });

  if (retireRecipe) {
    changed['assets/index.json'] = rewrite(destination, 'assets/index.json', (index) => {
      for (const entry of index) {
        if (entry.recipeId === retireRecipe.current) entry.recipeId = retireRecipe.former;
      }
    });
  }

  reseal(destination, changed);
  return destination;
}
