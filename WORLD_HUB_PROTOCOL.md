# World Hub Protocol

This document specifies the two data formats consuming applications interact with:

1. **World Hub Application Contract, version 1** — how an application declares what it needs.
2. **World Hub Package Protocol, version 1** — the immutable snapshot format World Hub publishes.

Consumers read packages. They never read the World Hub database, and they never write into a library.

---

## 1. Application Contract, version 1

A contract is a JSON document with `format: "world-hub-application-contract"` and `contractVersion: 1`. It is validated against `schemas/application-contract.schema.json` before saving or use. Contracts are data; they contain no code.

```json
{
  "format": "world-hub-application-contract",
  "contractVersion": 1,
  "appType": "example.character-gallery",
  "name": "Example Character Gallery",
  "description": "One world, up to twelve characters, one portrait each.",
  "supportedProtocolVersions": [1],
  "productionFields": [
    { "id": "gallery_title", "label": "Gallery title", "type": "shortText", "required": true, "maxLength": 120 }
  ],
  "entitySelections": [
    { "id": "world", "label": "World", "entityTypes": ["world"], "exact": 1 },
    {
      "id": "cast", "label": "Characters", "entityTypes": ["character"],
      "min": 1, "max": 12, "ordered": true,
      "fields": [{ "id": "caption", "label": "Caption", "type": "shortText", "maxLength": 200 }],
      "assetSets": [{
        "id": "portrait", "label": "Portrait", "kinds": ["image"],
        "roles": ["character.portrait"], "recipes": ["portrait_3x4", "thumbnail_square"], "exact": 1
      }]
    }
  ],
  "assetSets": [],
  "documents": { "mode": "linked" },
  "requiredRecipes": ["portrait_3x4", "thumbnail_square"]
}
```

### Field types

`shortText`, `multilineText`, `markdown`, `integer`, `number`, `boolean`, `enum` (requires `options`), `color` (`#rrggbb`), `entityRef` (requires `entityTypes`), `assetRef` (optional `assetKinds`, `assetRoles`), `list` (requires `item` for primitive lists or `fields` for ordered repeatable groups; `minItems`/`maxItems`).

Common attributes: `id` (slug), `label`, `required`, `hint`, `default`, plus per-type constraints (`minLength`/`maxLength`/`pattern` for text, `min`/`max`/`step` for numbers).

An `assetRef` field may declare `recipes` (recipe ids) to request renditions for the referenced asset; without it the original bytes ship. Every asset referenced by a contract-defined value — including values nested inside `list` groups and asset-set `itemFields` — is packaged (its `assets/index.json` entries use `setId: "fields"`), and every `entityRef` value pulls its record into the catalog, so packages stay self-contained without app-specific code.

### Entity selections

Each selection declares `entityTypes`, count bounds (`exact`, or `min`/`max`), optional per-selected-entity `fields`, and optional per-entity `assetSets`. Selections are ordered.

Per-record field ids and asset-set ids must be unique across the **whole contract**, not just within one selection: production values and package content key them by (record, id), so a shared id from two selections would collide when the same record appears in both. Contract validation rejects shared ids.

### Asset sets

An asset set declares allowed `kinds`, allowed semantic `roles` (see [ASSET_ROLES.md](ASSET_ROLES.md)), required rendition `recipes` (recipe IDs, never filenames), count bounds, and optional per-item `itemFields`.

### Documents

`documents.mode` is `"none"`, `"linked"` (documents linked to any included entity), or `"selected"` (only documents the author checked in the production editor).

### Versioning

Saving a change creates a new contract version. A published snapshot embeds the full contract version it used; later contract edits never affect it.

---

## 2. Package Protocol, version 1

A publication is one immutable directory (also exportable as a ZIP with byte-identical contents):

```text
productions/<production-slug>/publications/<publication-uuid>/
├── manifest.json
├── catalog/
│   ├── entities.json
│   ├── worlds.json
│   ├── characters.json
│   ├── relationships.json
│   ├── tags.json
│   └── documents.json
├── production/
│   ├── contract.json
│   └── content.json
├── documents/
│   └── <document-uuid>.md
├── assets/
│   ├── index.json
│   └── files/…
└── checksums.json
```

Next to `publications/`, `current.json` names the active snapshot:

```json
{
  "format": "world-hub-current-publication",
  "publicationId": "0b0e…",
  "manifestPath": "publications/0b0e…/manifest.json",
  "updatedAt": "2026-08-13T22:41:00.000Z"
}
```

All JSON in a package is deterministic: recursively sorted keys, stable record ordering, UTF-8, two-space indentation, trailing newline.

### manifest.json

```json
{
  "format": "world-hub-package",
  "protocolVersion": 1,
  "publicationId": "…uuid…",
  "production": { "id": "…", "name": "Vel Gallery", "slug": "vel-gallery", "revision": 7 },
  "applicationType": "example.character-gallery",
  "contract": { "id": "…uuid…", "version": 2 },
  "sourceLibraryId": "…uuid…",
  "publishedAt": "2026-08-13T22:41:00.000Z",
  "entities": [ { "id": "…", "type": "character", "revision": 4 } ],
  "sections": { "catalog": "catalog", "production": "production", "documents": "documents", "assets": "assets", "checksums": "checksums.json" },
  "counts": { "entities": 3, "documents": 1, "assets": 2, "files": 14 },
  "complete": true
}
```

`entities` records the exact canonical revision of every included record. Identity is permanent: renaming a character in the library changes later snapshots, never this one.

### catalog/

- `entities.json` — every included record: `id`, `type`, `worldId`, `name`, `slug`, `summary`, `status`, `sortOrder`, `revision`, `aliases[]`, `tags[]`.
- `worlds.json` — world profiles: `id`, `tagline`, `genre`, `tone`, `settingDescription`, `visualDirection`, `coverAssetId`, `backgroundAssetId`. Profile asset references are `null` unless that asset ships in this package — a package never contains dangling references.
- `characters.json` — character profiles: `id`, `role`, `age` (text), `appearance`, `personality`, `biography`, `voice`, `portraitAssetId`, `tileAssetId` (same self-containment rule).
- `relationships.json` — directed, non-archived records whose both endpoints are included: `id`, `sourceId`, `targetId`, `type`, `label`, `inverseLabel`, `description`, `position`.
- `tags.json` — `id`, `name`, `group` for every tag used in the snapshot.
- `documents.json` — `id`, `title`, `path` (inside the package), `status`, `revision`, `wordCount`, `checksum`, `entityIds[]` (filtered to records this package includes). The Markdown bodies are real files under `documents/`.

### production/

- `contract.json` — the complete contract version this snapshot was validated against.
- `content.json` — the production's own data: `values`, per-entity `entityValues`, ordered `selections` (arrays of entity UUIDs per slot), and `assetSets` (keyed `slot` or `slot:entityUuid`, each an ordered array of `{ assetId, values }`).

### assets/index.json

One entry per (asset, recipe) pair:

```json
{
  "assetId": "…uuid…",
  "assetTitle": "Nao portrait",
  "versionId": "…uuid…",
  "blobChecksum": "sha256-hex-of-the-original",
  "setId": "portrait",
  "entityId": "…character-uuid-or-null…",
  "roles": ["character.portrait"],
  "recipeId": "portrait_3x4",
  "mime": "image/webp",
  "width": 900,
  "height": 1200,
  "position": 0,
  "path": "assets/files/<assetId>/<versionId>-portrait_3x4.webp"
}
```

Consumers resolve files only through `path`. Filenames are never derived. `roles` lists the roles the asset **actually holds** for that record (intersected with the set's allowed roles when the contract restricts them) — never the contract's allowed list verbatim.

### checksums.json

SHA-256 of every other file in the package, keyed by package-relative path. A package is valid when every listed file exists, matches its checksum, and no unlisted file is present (checksums.json excepted).

### Publication guarantees

- Assembly happens in a temporary work area; the snapshot is verified there (manifest schema, checksums, file existence, and reference resolution — including relationship endpoints, profile art, and document links) before being moved into place in one rename.
- The publication is recorded in World Hub's database first; `current.json` is replaced atomically as the very last step, so the pointer only ever names a fully recorded snapshot. If any step fails — including the pointer write itself — the previous snapshot stays active, the database is compensated, and the unreferenced package directory is removed.
- Publications are never modified after creation and never cascade-deleted.

### Consumer algorithm

```text
read  <production-folder>/current.json          → publicationId, manifestPath
read  manifest.json                             → verify format == "world-hub-package"
                                                  and protocolVersion is supported
read  checksums.json; verify files you rely on
read  catalog/entities.json (+ worlds/characters as needed), key records by id
read  production/content.json                   → ordering and app-specific values
for each needed image/audio:
    look up assets/index.json by (assetId, recipeId) → path
cache by publicationId; a new publication is a new folder and a new pointer
```

Player state, runtime behavior, and anything app-specific beyond the contract remain the consumer's own responsibility.
