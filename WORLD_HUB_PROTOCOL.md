# World Hub Protocol

This document specifies the two data formats consuming applications interact with:

1. **World Hub Application Contract, format version 1** — how an application declares what it needs.
2. **World Hub Package Protocol, version 2** — the immutable snapshot format World Hub publishes.

Consumers read packages. They never read the World Hub database, and they never write into a library.

---

## 1. Application Contract, version 1

A contract is a JSON document with `format: "world-hub-application-contract"` and `contractFormatVersion: 1`. It is validated against `schemas/application-contract.schema.json` before saving or use. Contracts are data; they contain no code.

```json
{
  "format": "world-hub-application-contract",
  "contractFormatVersion": 1,
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

### What belongs in a contract

**The contract carries what a writer would change. The application's own repository carries what a designer would tune.**

Names, lore, captions, art, and the choices that shape a scene are content. Power values, weights, ratios, thresholds, and anything measured in basis points are engine configuration, and they belong in the consuming application beside the rest of its balance data.

The failure this prevents is quiet. A number with no author-visible meaning still has to be filled in by somebody, so it either sits in the production screen as noise or — worse — settles into the consumer's adapter as a hard-coded default, where the person authoring the content can neither see it nor change it. Hero Collector had ten such defaults living inside its adapter; they now sit in its `content/balance.json`, visible to whoever is actually balancing the game.

Two practical tests:

- *Would a writer with no interest in the mechanics have an opinion about this value?* If not, it is engine configuration.
- *Does the number mean something about this particular item, or is it the same arithmetic applied per item?* Per-item meaning is content; repeated arithmetic is configuration with a default.

A contract that has grown long is not automatically wrong — a game with thirty campaign nodes per world genuinely has a lot of content — but it should grow in fiction, not in tuning. Use `section` to group fields under headings and `advanced` on the ones an author rarely touches, so the production screen opens on what people came to write.

### Field types

`shortText`, `multilineText`, `markdown`, `integer`, `number`, `boolean`, `enum` (requires `options`), `color` (`#rrggbb`), `entityRef` (requires `entityTypes`), `assetRef` (optional `assetKinds`, `assetRoles`), `list` (requires `item` for primitive lists or `fields` for ordered repeatable groups; `minItems`/`maxItems`).

Common attributes: `id` (slug), `label`, `required`, `hint`, `default`, plus per-type constraints (`minLength`/`maxLength`/`pattern` for text, `min`/`max`/`step` for numbers).

An `assetRef` field may declare `recipes` (recipe ids) to request renditions for the referenced asset; without it the original bytes ship. Every asset referenced by a contract-defined value — including values nested inside `list` groups and asset-set `itemFields` — is packaged (its `assets/index.json` entries use `setId: "fields"`), and every `entityRef` value pulls its record into the catalog, so packages stay self-contained without app-specific code.

### Entity selections

Each selection declares `entityTypes`, count bounds (`exact`, or `min`/`max`), optional per-selected-entity `fields`, and optional per-entity `assetSets`. Selections are ordered.

Per-record field ids and asset-set ids must be unique across the **whole contract**, not just within one selection: production values and package content key them by (record, id), so a shared id from two selections would collide when the same record appears in both. Contract validation rejects shared ids.

### Connection selections

`connectionSelections` is optional; a contract without it is unchanged, and no
connection reaches the application through it. Each entry names the canonical
connection kinds the application consumes and the two entity selections they
run between:

```json
{
  "id": "hc_faction_membership",
  "label": "Faction memberships",
  "kinds": ["member_of"],
  "sourceSelection": "hc_characters",
  "targetSelection": "hc_factions",
  "minPerSource": 0,
  "maxPerSource": 1
}
```

The point of the boundary is `maxPerSource`. Membership is canonical fiction —
World Hub lets a character belong to several groups — while showing one faction
is a game rule, so the game states it in its own contract rather than canon
being narrowed to suit it.

Validation splits by what it needs. Unique ids, `sourceSelection` and
`targetSelection` naming real selections, and coherent bounds are checked from
the document alone, so a contract file still imports with no library open.
Whether the named kinds exist, and whether they can join the record types those
selections allow, is checked against the library and again when a production is
validated.

A production is checked against the canonical graph: a source record whose
connections into the target selection fall outside `minPerSource`…`maxPerSource`
is an **error**, and a record connected to something the author has not selected
is a **warning** naming that record, so the editor can offer to add it. Nothing
is traversed automatically — production selection stays explicit, so choosing
one character cannot pull most of a world into a package.

### Asset sets

An asset set declares allowed `kinds`, allowed semantic `roles` (see [ASSET_ROLES.md](ASSET_ROLES.md)), required rendition `recipes` (recipe IDs, never filenames), count bounds, and optional per-item `itemFields`.

### Documents

`documents.mode` is `"none"`, `"linked"` (documents linked to any included entity), or `"selected"` (only documents the author checked in the production editor).

### The contract lives in the application's repository

The authoritative copy of a contract is the file the consuming application keeps at `worldhub/application-contract.json`. World Hub imports it (`contract.importFile`) and records the path and the checksum of the bytes it read. Asking whether the two still agree costs a read and a hash and changes nothing.

A production whose contract has drifted from that file **cannot be marked ready**. The remedy is to re-import, which is offered wherever the drift is reported. Contracts typed directly into World Hub are untracked rather than drifted — a state, not a fault.

### Versioning

Saving a change creates a new contract *revision*. A published snapshot embeds the full contract it used; later edits never affect it. Importing a file whose content already matches the stored revision does not create a new one, so the counter measures real changes rather than re-reads.

---

## Version fields, and which to gate on

Four numbers travel with a package. They answer different questions, and a consumer that confuses them fails in a way that looks like a content bug. Three of the four existing consumers gated on the wrong one at some point; one shipped it and had a real publication refused.

| Field | Where | What it means | Consumer must |
| --- | --- | --- | --- |
| `protocolVersion` | `manifest.json` | the package *format* | **gate** — refuse an unsupported value |
| `contractFormatVersion` | `production/contract.json` | the contract *document* format | **gate** — refuse an unsupported value |
| `vocabularyVersion` | `manifest.json` | the role and recipe names in use | **gate** — refuse loudly rather than resolve art by a moved name |
| `contract.revision` | `manifest.json` | how many times this contract has been edited | **never gate** — record it, display it, nothing else |

`contract.revision` climbs every time the contract is edited in the authoring library — adding a field, renaming a recipe. None of that changes how a package is read. Gating on it refuses every publication after the next edit. It was called `contract.version` before Protocol 2; the rename exists so the mistake is harder to write.

`manifest.renamedFrom` maps each current recipe and role id to the names it was previously published under, so a consumer holding an old name can find the current one instead of rendering a fallback. Resolve art through the recipes the *embedded contract* declares rather than through names written into application code; then a rename over here needs no change over there.

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
│   ├── connection-kinds.json
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
  "protocolVersion": 2,
  "publicationId": "…uuid…",
  "production": { "id": "…", "name": "Vel Gallery", "slug": "vel-gallery", "revision": 7 },
  "applicationType": "example.character-gallery",
  "contract": { "id": "…uuid…", "revision": 2 },
  "vocabularyVersion": 1,
  "renamedFrom": { "recipes": { "tile_16x9": ["landscape_16x9"] }, "roles": { "character.tile": ["character.identity_tile"] } },
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
- `relationships.json` — canonical connections, non-archived and with both endpoints included: `id`, `sourceId`, `targetId`, `type`, `label`, `inverseLabel`, `description`, `position`, plus `kindId` and `category`. `kindId` is the stable machine name of the connection kind; `type` carries the same string, and `label`/`inverseLabel` are resolved from that kind rather than retyped per record — so a reader written before kinds existed reads exactly what it read before. The file keeps its Protocol 1 name deliberately: renaming it would break every vendored reader for no gain.
- `connection-kinds.json` — the definition of every kind the package uses, plus any its contract names: `id`, `category`, `forwardLabel`, `inverseLabel`, `forwardSection`, `inverseSection`, `symmetric`, `builtin`, and `pairs` (the ordered `[sourceType, targetType]` combinations the kind may join). A setting-specific custom kind travels the same way as a built-in one, so a consumer never hard-codes what a kind means. Packages published before this file existed simply do not have it, and readers treat its absence as a fact about when the package was published rather than a fault.
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

- Assembly happens in a temporary work area; the snapshot is verified there (manifest schema, checksums, file existence, and reference resolution — including relationship endpoints, the connection kind every connection names, profile art, and document links) before being moved into place in one rename.
- The publication is recorded in World Hub's database first; `current.json` is replaced atomically as the very last step, so the pointer only ever names a fully recorded snapshot. If any step fails — including the pointer write itself — the previous snapshot stays active, the database is compensated, and the unreferenced package directory is removed.
- Publications are never modified after creation and never cascade-deleted.

### Consumer algorithm

```text
read  <production-folder>/current.json          → publicationId, manifestPath
read  manifest.json                             → verify format == "world-hub-package",
                                                  protocolVersion is supported, and
                                                  vocabularyVersion is supported.
                                                  Record contract.revision; never gate on it.
read  checksums.json; verify files you rely on
read  catalog/entities.json (+ worlds/characters as needed), key records by id
read  production/content.json                   → ordering and app-specific values
read  catalog/relationships.json + connection-kinds.json (both optional to use)
                                                → canonical facts between records
for each needed image/audio:
    look up assets/index.json by (assetId, recipeId) → path
cache by publicationId; a new publication is a new folder and a new pointer
```

Player state, runtime behavior, and anything app-specific beyond the contract remain the consumer's own responsibility.
