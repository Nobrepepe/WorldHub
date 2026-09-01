#!/usr/bin/env node
/**
 * Report what the Node reader sees in a package, as canonical JSON.
 *
 * Its Python twin prints the same document for the same package. Comparing
 * the two is how the readers are held in step: the fixture corpus that
 * preceded this only proved each reader rejected bad packages, never that
 * they agreed about good ones.
 *
 *   node observe.mjs <package-dir> <app-type> [vocabularyVersion]
 */
import { loadPackage, PackageError } from '../js/package-reader.mjs';

const [dir, appType, vocabulary] = process.argv.slice(2);

function observe() {
  let pkg;
  try {
    pkg = loadPackage(dir, appType, { supportedVocabularyVersion: Number(vocabulary ?? 1) });
  } catch (error) {
    if (error instanceof PackageError) return { ok: false, error: error.message };
    throw error;
  }
  const setIds = [...pkg.sets.keys()].sort();
  return {
    ok: true,
    protocolVersion: pkg.protocolVersion,
    contractRevision: pkg.manifest.contract.revision,
    vocabularyVersion: pkg.manifest.vocabularyVersion,
    applicationType: pkg.manifest.applicationType,
    contractFormatVersion: pkg.contract.contractFormatVersion,
    counts: {
      entities: pkg.entities.length,
      worlds: pkg.worlds.length,
      characters: pkg.characters.length,
      documents: pkg.documents.length,
      assetIndex: pkg.assetIndex.length,
      tags: pkg.tags.length,
      connections: pkg.relationships.length,
      connectionKinds: pkg.connectionKinds.length,
    },
    entityIds: pkg.entities.map((entity) => entity.id).sort(),
    sets: setIds.map((setId) => ({ setId, recipes: pkg.recipesFor(setId) })),
    rolesResolved: [
      'character.portrait', 'character.tile', 'character.full_body',
      'character.collectible', 'character.stamp', 'world.cover', 'scene.key_art',
    ].map((role) => ({ role, setId: pkg.setForRole(role) })),
    /* every connection read the way an application would read it, from both
       ends, so the two readers have to agree about labels and direction and
       not merely about how many rows there are */
    connectionKindIds: pkg.connectionKinds.map((kind) => kind.id).sort(),
    connections: [...pkg.relationships]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((connection) => ({
        id: connection.id,
        kindId: connection.kindId ?? null,
        type: connection.type,
        labelFrom: pkg.connectionLabel(connection, 'from'),
        labelTo: pkg.connectionLabel(connection, 'to'),
      })),
    connectedEntities: [...new Set(pkg.relationships.flatMap((c) => [c.sourceId, c.targetId]))]
      .sort()
      .map((entityId) => ({
        entityId,
        holds: pkg.connectionsFor(entityId).map((c) => `${c.direction}:${c.otherId}:${c.label}`).sort(),
        outbound: pkg.connectionsFrom(entityId).length,
        inbound: pkg.connectionsTo(entityId).length,
      })),
    /* every asset resolved the way an application would resolve it */
    resolved: [...new Set(pkg.assetIndex.map((entry) => entry.assetId))].sort().map((assetId) => {
      const entry = pkg.assetIndex.find((candidate) => candidate.assetId === assetId);
      const setId = entry.setId ?? '';
      const chosen = pkg.assetFile(assetId, pkg.recipesFor(setId));
      return { assetId, setId, path: chosen?.path ?? null, recipeId: chosen?.recipeId ?? null };
    }),
  };
}

process.stdout.write(`${JSON.stringify(observe(), null, 2)}\n`);
