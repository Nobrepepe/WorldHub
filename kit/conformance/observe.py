#!/usr/bin/env python3
"""Report what the Python reader sees in a package, as canonical JSON.

Its Node twin prints the same document for the same package. Comparing the
two is how the readers are held in step.

    python3 observe.py <package-dir> <app-type> [vocabularyVersion]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py"))

from worldhub_kit import PackageError, load_package  # noqa: E402


def observe(directory: str, app_type: str, vocabulary: int) -> dict:
    try:
        package = load_package(Path(directory), app_type, supported_vocabulary_version=vocabulary)
    except PackageError as error:
        return {"ok": False, "error": str(error)}

    set_ids = sorted(package.sets.keys())
    index = package.asset_index
    asset_ids = sorted({entry["assetId"] for entry in index})
    resolved = []
    for asset_id in asset_ids:
        entry = next(candidate for candidate in index if candidate["assetId"] == asset_id)
        set_id = entry.get("setId") or ""
        chosen = package.asset_file(asset_id, package.recipes_for(set_id))
        resolved.append({
            "assetId": asset_id,
            "setId": set_id,
            "path": chosen["path"] if chosen else None,
            "recipeId": chosen["recipeId"] if chosen else None,
        })

    return {
        "ok": True,
        "protocolVersion": package.protocol_version,
        "contractRevision": package.manifest["contract"]["revision"],
        "vocabularyVersion": package.manifest["vocabularyVersion"],
        "applicationType": package.manifest["applicationType"],
        "contractFormatVersion": package.contract["contractFormatVersion"],
        "counts": {
            "entities": len(package.entities),
            "worlds": len(package.worlds),
            "characters": len(package.characters),
            "documents": len(package.documents),
            "assetIndex": len(index),
            "tags": len(package.tags),
            "connections": len(package.relationships),
            "connectionKinds": len(package.connection_kinds),
        },
        "entityIds": sorted(entity["id"] for entity in package.entities),
        "sets": [{"setId": s, "recipes": package.recipes_for(s)} for s in set_ids],
        "rolesResolved": [
            {"role": role, "setId": package.set_for_role(role)}
            for role in (
                "character.portrait", "character.tile", "character.full_body",
                "character.collectible", "character.stamp", "world.cover", "scene.key_art",
            )
        ],
        # Every connection read the way an application would read it, from
        # both ends, so the two readers have to agree about labels and
        # direction and not merely about how many rows there are.
        "connectionKindIds": sorted(kind["id"] for kind in package.connection_kinds),
        "connections": [
            {
                "id": connection["id"],
                "kindId": connection.get("kindId"),
                "type": connection["type"],
                "labelFrom": package.connection_label(connection, "from"),
                "labelTo": package.connection_label(connection, "to"),
            }
            for connection in sorted(package.relationships, key=lambda c: c["id"])
        ],
        "connectedEntities": [
            {
                "entityId": entity_id,
                "holds": sorted(
                    f"{c['direction']}:{c['otherId']}:{c['label']}"
                    for c in package.connections_for(entity_id)
                ),
                "outbound": len(package.connections_from(entity_id)),
                "inbound": len(package.connections_to(entity_id)),
            }
            for entity_id in sorted({
                endpoint
                for connection in package.relationships
                for endpoint in (connection["sourceId"], connection["targetId"])
            })
        ],
        "resolved": resolved,
    }


if __name__ == "__main__":
    directory, app_type = sys.argv[1], sys.argv[2]
    vocabulary = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    print(json.dumps(observe(directory, app_type, vocabulary), indent=2))
