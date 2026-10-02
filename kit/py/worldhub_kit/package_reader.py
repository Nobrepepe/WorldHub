"""World Hub package reading and protocol validation — the one Python
implementation.

Mirrors ``kit/js/package-reader.mjs`` exactly. The two exist because the
applications are written in different languages; they are kept in step by the
shared conformance corpus, not by anyone remembering to copy a fix across.

Reads Package Protocol 1 and 2 and presents both in the current shape, so
packages installed before the rename keep working.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import zipfile
from pathlib import Path

SUPPORTED_PROTOCOL_VERSIONS = {1, 2}
SUPPORTED_CONTRACT_FORMAT_VERSIONS = {1}
PACKAGE_FORMAT = "world-hub-package"
CONTRACT_FORMAT = "world-hub-application-contract"


class PackageError(Exception):
    """A package failed validation. The message is user-facing."""


def _as_list(value) -> list:
    return value if isinstance(value, list) else []


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _declared_sets(contract: dict) -> dict[str, dict]:
    """Index every asset set and assetRef field by id, with its recipes and roles.

    Covers the three places a contract can declare them: top-level asset sets,
    the sets hanging off an entity selection, and assetRef fields including
    those nested inside list fields.
    """
    found: dict[str, dict] = {}

    def remember(record: dict) -> None:
        set_id = record.get("id")
        if not isinstance(set_id, str):
            return
        found[set_id] = {
            "recipes": [str(r) for r in _as_list(record.get("recipes"))],
            "roles": [str(r) for r in _as_list(record.get("roles") or record.get("assetRoles"))],
        }

    def walk_fields(fields) -> None:
        for field in _as_list(fields):
            if field.get("type") == "assetRef":
                remember(field)
            walk_fields(field.get("fields"))
            walk_fields(field.get("itemFields"))

    def walk_sets(sets) -> None:
        for record in _as_list(sets):
            remember(record)
            walk_fields(record.get("itemFields"))

    walk_sets(contract.get("assetSets"))
    for selection in _as_list(contract.get("entitySelections")):
        walk_sets(selection.get("assetSets"))
        walk_fields(selection.get("fields"))
    walk_fields(contract.get("productionFields"))
    return found


class PackageInfo:
    def __init__(self, **fields) -> None:
        for key, value in fields.items():
            setattr(self, key, value)
        self.sets = _declared_sets(self.contract)
        # former recipe name -> current one, so art asked for by an old name
        # still resolves instead of silently falling back
        self.recipe_aliases: dict[str, str] = {}
        for current, former_names in (self.renamed_from.get("recipes") or {}).items():
            for former in _as_list(former_names):
                self.recipe_aliases[former] = current

    @property
    def publication_id(self) -> str:
        return self.manifest["publicationId"]

    @property
    def production_id(self) -> str:
        return self.manifest["production"]["id"]

    def entities_by_id(self) -> dict[str, dict]:
        return {entity["id"]: entity for entity in self.entities}

    def absolute(self, package_path: str) -> Path:
        return self.root / Path(*package_path.split("/"))

    def asset_entries(self, asset_id: str) -> list[dict]:
        return [entry for entry in self.asset_index if entry["assetId"] == asset_id]

    def recipes_for(self, set_id: str) -> list[str]:
        """The recipes this package's contract declares for a set, best first.

        Recipe names are World Hub's to choose and they change; reading them
        out of the embedded contract means a rename over there needs no code
        change over here.
        """
        declared = self.sets.get(set_id)
        return list(declared["recipes"]) if declared else []

    def set_for_role(self, *roles: str) -> str | None:
        """The asset set carrying one of these roles, first match wins.

        Ask for what art is *for* rather than for a set id, so renaming a set
        does not strand the screen that renders it.
        """
        for role in roles:
            for set_id, declared in self.sets.items():
                if role in declared["roles"]:
                    return set_id
        return None

    # ---- connections ----

    def connection_kinds_by_id(self) -> dict[str, dict]:
        """Every published connection kind, by its stable id."""
        return {kind["id"]: kind for kind in self.connection_kinds}

    def connection_label(self, connection: dict, direction: str) -> str:
        """The label one end of a connection wears.

        The kind is asked first, so a rename in the authoring library reaches
        every connection that uses it; the record's own label is the fallback,
        which is all a package published before kinds existed carries.
        """
        kind = self.connection_kinds_by_id().get(connection.get("kindId"))
        if kind is None:
            return connection.get("inverseLabel", "") if direction == "to" else connection.get("label", "")
        if kind.get("symmetric"):
            return kind["forwardLabel"]
        if direction == "to":
            return connection.get("inverseLabel") or kind["inverseLabel"]
        return connection.get("label") or kind["forwardLabel"]

    def connections_for(self, entity_id: str) -> list[dict]:
        """Every connection touching a record, written from that record's side.

        ``direction`` is "from" when the record is the connection's source and
        "to" when it is the target; ``otherId`` is always the record at the
        other end, so a caller never has to work out which column it occupies.
        """
        found = []
        for connection in self.relationships:
            if entity_id not in (connection["sourceId"], connection["targetId"]):
                continue
            from_here = connection["sourceId"] == entity_id
            direction = "from" if from_here else "to"
            found.append({
                **connection,
                "direction": direction,
                "otherId": connection["targetId"] if from_here else connection["sourceId"],
                "label": self.connection_label(connection, direction),
            })
        return found

    def connections_from(self, entity_id: str, kind_id: str | None = None) -> list[dict]:
        """Connections running out of a record, optionally of one kind only."""
        return [
            connection for connection in self.relationships
            if connection["sourceId"] == entity_id
            and (kind_id is None or kind_id in (connection.get("kindId"), connection.get("type")))
        ]

    def connections_to(self, entity_id: str, kind_id: str | None = None) -> list[dict]:
        """Connections running into a record, optionally of one kind only."""
        return [
            connection for connection in self.relationships
            if connection["targetId"] == entity_id
            and (kind_id is None or kind_id in (connection.get("kindId"), connection.get("type")))
        ]

    def asset_file(self, asset_id: str, preferred_recipes: list[str] | None = None) -> dict | None:
        """The best index entry for an asset given a recipe preference order."""
        entries = self.asset_entries(asset_id)
        for recipe in preferred_recipes or []:
            wanted = self.recipe_aliases.get(recipe, recipe)
            for entry in entries:
                if entry["recipeId"] in (wanted, recipe):
                    return entry
        return entries[0] if entries else None


def extract_zip_safely(zip_path: Path, destination: Path) -> None:
    """Extract a package ZIP, refusing unsafe entries outright."""
    destination.mkdir(parents=True, exist_ok=True)
    resolved_destination = destination.resolve()
    seen: set[str] = set()
    try:
        with zipfile.ZipFile(zip_path) as archive:
            for info in archive.infolist():
                name = info.filename
                if name.endswith("/"):
                    continue
                if name in seen:
                    raise PackageError("The archive contains duplicate entries and was rejected.")
                seen.add(name)
                normalized = name.replace("\\", "/")
                parts = normalized.split("/")
                if normalized.startswith("/") or ".." in parts or ":" in parts[0]:
                    raise PackageError("The archive contains unsafe file paths and was rejected.")
                if (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise PackageError("The archive contains symbolic links and was rejected.")
                target = (destination / Path(*parts)).resolve()
                if resolved_destination != target and resolved_destination not in target.parents:
                    raise PackageError("The archive contains unsafe file paths and was rejected.")
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as source, target.open("wb") as out:
                    shutil.copyfileobj(source, out)
    except zipfile.BadZipFile as error:
        raise PackageError("The file is not a readable ZIP archive.") from error


def _read_json(root: Path, package_path: str):
    path = root / Path(*package_path.split("/"))
    if not path.is_file():
        raise PackageError(f"The package is missing {package_path}.")
    try:
        return json.loads(path.read_text("utf-8"))
    except json.JSONDecodeError as error:
        raise PackageError(f"The package file {package_path} is not valid JSON.") from error


def _read_json_optional(root: Path, package_path: str, fallback):
    """Read a catalog file a package may predate.

    ``catalog/connection-kinds.json`` arrived after Protocol 1 and part-way
    through Protocol 2, so its absence is a fact about when a package was
    published, not a fault. A package that has it is verified against it; one
    that has not still loads, and its connections read the way they always did.
    """
    path = root / Path(*package_path.split("/"))
    if not path.is_file():
        return fallback
    try:
        return json.loads(path.read_text("utf-8"))
    except json.JSONDecodeError as error:
        raise PackageError(f"The package file {package_path} is not valid JSON.") from error


def _normalize_manifest(manifest: dict) -> dict:
    """Present a Protocol 1 manifest in the current shape."""
    contract = dict(manifest.get("contract") or {})
    if "revision" not in contract and "version" in contract:
        contract["revision"] = contract["version"]
    contract.pop("version", None)
    return {
        **manifest,
        "contract": contract,
        "vocabularyVersion": manifest.get("vocabularyVersion", 1),
        "renamedFrom": manifest.get("renamedFrom") or {"recipes": {}, "roles": {}},
    }


def _normalize_contract(contract: dict) -> dict:
    if "contractFormatVersion" in contract:
        return contract
    out = dict(contract)
    out["contractFormatVersion"] = out.pop("contractVersion", None)
    return out


def _merge_renames(a: dict | None, b: dict | None) -> dict:
    out: dict[str, dict[str, list[str]]] = {"recipes": {}, "roles": {}}
    for source in (a, b):
        for kind in ("recipes", "roles"):
            for current, former_names in ((source or {}).get(kind) or {}).items():
                merged = dict.fromkeys(out[kind].get(current, []))
                merged.update(dict.fromkeys(_as_list(former_names)))
                out[kind][current] = list(merged)
    return out


def load_package(
    root: Path,
    expected_app_type: str,
    *,
    supported_vocabulary_version: int = 1,
    renamed_from: dict | None = None,
) -> PackageInfo:
    """Validate a package directory completely; raise PackageError otherwise.

    ``supported_vocabulary_version`` is the vocabulary this application was
    built against. A package published under a newer one is refused here, at
    load, rather than resolving art through a name that has since moved and
    failing three screens deep as missing pictures.
    """
    raw_manifest = _read_json(root, "manifest.json")
    if not isinstance(raw_manifest, dict) or raw_manifest.get("format") != PACKAGE_FORMAT:
        raise PackageError("This is not a World Hub package.")
    protocol_version = raw_manifest.get("protocolVersion")
    if protocol_version not in SUPPORTED_PROTOCOL_VERSIONS:
        raise PackageError("This package uses a World Hub protocol this app does not understand.")
    if raw_manifest.get("complete") is not True:
        raise PackageError("The package is marked incomplete.")
    if raw_manifest.get("applicationType") != expected_app_type:
        raise PackageError(
            f"This package is for “{raw_manifest.get('applicationType')}”, not for this app."
        )
    for key in ("publicationId", "production", "contract", "sourceLibraryId", "publishedAt", "entities", "sections"):
        if key not in raw_manifest:
            raise PackageError(f"The package manifest is missing {key}.")
    manifest = _normalize_manifest(raw_manifest)
    renames = _merge_renames(renamed_from, manifest["renamedFrom"])

    if not isinstance(manifest["contract"].get("id"), str) or not manifest["contract"]["id"]:
        raise PackageError("The package manifest does not name its application contract.")
    # Recorded as a receipt, never gated on: it counts edits in the authoring
    # library and climbs for changes that do not affect how a package reads.
    revision = manifest["contract"].get("revision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise PackageError("The package manifest carries an invalid contract revision.")
    vocabulary_version = manifest["vocabularyVersion"]
    if not isinstance(vocabulary_version, int) or isinstance(vocabulary_version, bool) or vocabulary_version < 1:
        raise PackageError("The package manifest carries an invalid vocabulary version.")
    if vocabulary_version > supported_vocabulary_version:
        raise PackageError(
            f"This package uses World Hub art vocabulary {vocabulary_version}; this app "
            f"understands {supported_vocabulary_version}. Update the app before installing it."
        )

    contract = _read_json(root, "production/contract.json")
    if not isinstance(contract, dict) or contract.get("format") != CONTRACT_FORMAT:
        raise PackageError("The embedded application contract is not valid.")
    contract = _normalize_contract(contract)
    if contract.get("appType") != manifest["applicationType"]:
        raise PackageError("The embedded contract does not match the package's application type.")
    if contract.get("contractFormatVersion") not in SUPPORTED_CONTRACT_FORMAT_VERSIONS:
        raise PackageError("This package uses a contract format this app does not support.")
    declared_protocols = contract.get("supportedProtocolVersions")
    if not isinstance(declared_protocols, list):
        declared_protocols = [1]
    if protocol_version not in declared_protocols:
        raise PackageError("The embedded contract does not support this package's protocol version.")

    checksums = _read_json(root, "checksums.json")
    if not isinstance(checksums, dict):
        raise PackageError("The package checksum list is unreadable.")
    for package_path, expected in checksums.items():
        file_path = root / Path(*package_path.split("/"))
        if not file_path.is_file():
            raise PackageError(f"The package is missing {package_path}.")
        if _sha256(file_path) != expected:
            raise PackageError(f"A package file failed its checksum: {package_path}.")
    listed = set(checksums.keys()) | {"checksums.json"}
    for file_path in sorted(root.rglob("*")):
        if file_path.is_file():
            relative = "/".join(file_path.relative_to(root).parts)
            if relative not in listed:
                raise PackageError(f"The package contains an unlisted file: {relative}.")

    entities = _read_json(root, "catalog/entities.json")
    worlds = _read_json(root, "catalog/worlds.json")
    characters = _read_json(root, "catalog/characters.json")
    relationships = _read_json(root, "catalog/relationships.json")
    connection_kinds = _read_json_optional(root, "catalog/connection-kinds.json", [])
    documents = _read_json(root, "catalog/documents.json")
    tags = _read_json(root, "catalog/tags.json")
    asset_index = _read_json(root, "assets/index.json")
    content = _read_json(root, "production/content.json")

    entity_ids = {entity["id"] for entity in entities}
    kind_ids = {kind["id"] for kind in connection_kinds}
    for relationship in relationships:
        if relationship["sourceId"] not in entity_ids or relationship["targetId"] not in entity_ids:
            raise PackageError("A packaged relationship references a missing record.")
        # Only when the package claims to carry kinds at all: a connection
        # whose kind is missing would arrive as a label with nothing behind it.
        if connection_kinds and "kindId" in relationship and relationship["kindId"] not in kind_ids:
            raise PackageError("A packaged connection names a kind that is not in the package.")
    for document in documents:
        for entity_id in _as_list(document.get("entityIds")):
            if entity_id not in entity_ids:
                raise PackageError("A packaged document references a missing record.")
        if not (root / Path(*document["path"].split("/"))).is_file():
            raise PackageError(f"A document file is missing: {document['path']}.")
    asset_ids = {entry["assetId"] for entry in asset_index}
    for entry in asset_index:
        if not (root / Path(*entry["path"].split("/"))).is_file():
            raise PackageError(f"An asset file is missing: {entry['path']}.")
    for world in worlds:
        for ref in (world.get("coverAssetId"), world.get("backgroundAssetId")):
            if ref and ref not in asset_ids:
                raise PackageError("A world profile references a missing asset.")
    # `fullBodyAssetId` is what Protocol 1 called the second display slot. Both
    # names are checked so a package from either protocol is really verified —
    # naming only the retired one is how three consumers came to check nothing.
    for character in characters:
        for ref in (
            character.get("portraitAssetId"),
            character.get("tileAssetId"),
            character.get("fullBodyAssetId"),
        ):
            if ref and ref not in asset_ids:
                raise PackageError("A character profile references a missing asset.")
    for slot, selected in (content.get("selections") or {}).items():
        for entity_id in _as_list(selected):
            if entity_id not in entity_ids:
                raise PackageError(f"Selection “{slot}” references a missing record.")
    for set_key, items in (content.get("assetSets") or {}).items():
        for item in _as_list(items):
            if item["assetId"] not in asset_ids:
                raise PackageError(f"Asset set “{set_key}” references a missing asset.")

    return PackageInfo(
        root=root, manifest=manifest, contract=contract, content=content,
        entities=entities, worlds=worlds, characters=characters,
        relationships=relationships, connection_kinds=connection_kinds,
        documents=documents, asset_index=asset_index,
        checksums=checksums, tags=tags, protocol_version=protocol_version,
        renamed_from=renames,
    )


def read_current_pointer(production_dir: Path) -> dict | None:
    """Read current.json from a linked World Hub production folder."""
    try:
        pointer = json.loads((production_dir / "current.json").read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(pointer, dict) or "publicationId" not in pointer:
        return None
    return pointer
