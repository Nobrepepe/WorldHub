# World Hub — Complete Implementation Prompt

## Assignment

Build a complete, production-quality desktop application named **World Hub**.

World Hub is the canonical home for a private collection of fictional worlds, characters, lore, Markdown documents, artwork, audio, relationships, and app-specific productions. It organizes original material once and publishes self-contained, versioned content snapshots through a standard protocol. Other applications must adapt to World Hub; World Hub must not accumulate custom exporters that imitate the internal storage conventions of existing applications.

Implement the application, persistence layer, tests, documentation, packaging configuration, and all workflows described below. Do not stop at a visual prototype. Do not leave non-functional buttons, sample-only repositories, in-memory persistence, TODO handlers, or placeholder services. The application must launch, create and reopen a real library, survive restarts, import and manage real files, edit real Markdown, search real content, generate real image renditions, create and validate Productions, publish real packages, and restore backups.

If the repository already contains instructions such as `AGENTS.md`, read and obey them before changing files. Preserve unrelated user changes. If the repository is empty, initialize it cleanly.

When a minor implementation detail is unspecified, choose the simplest maintainable solution consistent with this document. Do not weaken a requirement merely to reduce the implementation.

---

## 1. Product definition

World Hub is a **local-first, offline desktop authoring and distribution system** for one writer's fictional settings.

The user currently creates multiple applications that reuse the same worlds and characters. Maintaining independent copies of names, descriptions, lore, and art in each application has produced inconsistency and an increasingly difficult folder tree. World Hub solves this by becoming the sole authority for shared content.

The fundamental rule is:

> A world, character, fact, document, or original asset exists once in World Hub. Productions reference and arrange that material. Consumer applications read published snapshots and own only their runtime behavior and player state.

World Hub must support these activities comfortably:

- Create and organize worlds and characters.
- Keep concise structured profiles consistent.
- Write long-form material as actual Markdown files.
- Import large existing folders into an Inbox without losing filenames or folder provenance.
- File, tag, associate, search, edit, preview, and compare artwork and notes.
- Preserve original files and immutable asset history.
- Derive reusable image renditions from originals without destroying them.
- Describe app-specific content as schema-driven Productions that reference canon.
- Validate a Production against its application contract.
- Publish an immutable, self-contained World Hub package using one standard protocol.
- Back up, restore, inspect, and move the entire library between Arch Linux and Windows.

The application is for one local user. It requires no accounts, cloud service, telemetry, remote API, server, or network connection.

---

## 2. Dependency direction and hard exclusions

The following architectural boundary is non-negotiable:

```text
World Hub canonical library
          ↓
World Hub Production
          ↓
World Hub publication package
          ↓
consumer application
```

Do **not** implement any of the following:

- A HeroCollector exporter that reproduces `custom-content.json`.
- A StickerAlbum exporter that reproduces its numbered filenames or catalog JSON.
- A TaskStamps exporter that writes into its SQLite database.
- A ChatBot exporter that writes into its SQLite database.
- Direct writes into another application's repository, installation, database, asset folder, or save directory.
- Bidirectional synchronization with consumer applications.
- A plugin system that executes arbitrary third-party JavaScript inside the Hub.
- Cloud synchronization, authentication, collaboration, remote storage, telemetry, advertisements, or paid features.
- Canonical content stored only inside opaque JSON blobs.
- Destructive resizing or replacement of original artwork.
- Treating the user's pre-existing folder structure as canon automatically.

The existing applications are relevant only because they reveal recurring content needs:

- Worlds, descriptions, covers, backgrounds, locations, and lore.
- Characters, aliases, summaries, appearance, personality, biography, voice, relationships, portraits, tiles, full bodies, expressions, and sprites.
- Ordered sets of collectible images and optional voice lines.
- App-specific numeric, categorical, campaign, equipment, prompt, and presentation fields.

World Hub defines clean standards for these needs. Later, each consumer application will be adapted to read World Hub publications.

---

## 3. Required technology

Use this stack:

- **Electron** desktop application.
- **Plain modern JavaScript with ES modules**, not TypeScript.
- HTML and CSS authored directly; do not introduce React, Vue, Svelte, or another component framework.
- **SQLite** through `better-sqlite3`, used only in the Electron main process.
- `sharp` for image inspection and rendition generation.
- `marked` plus `DOMPurify` for safe Markdown preview in the renderer.
- `ajv` for validating World Hub contracts and publication manifests.
- A maintained ZIP library for full-library backup creation and restore.
- Node's built-in test runner for domain, persistence, migration, and publication tests.
- Electron Builder for Linux and Windows packaging configuration.

Keep dependencies small and justified. Runtime network access is forbidden. All fonts and application assets must be vendored locally.

Recommended package scripts:

```json
{
  "start": "electron .",
  "test": "node --test \"tests/**/*.test.mjs\"",
  "test:watch": "node --test --watch \"tests/**/*.test.mjs\"",
  "check": "npm test && node scripts/integrity-smoke.mjs",
  "dist:linux": "electron-builder --linux AppImage",
  "dist:win": "electron-builder --win nsis",
  "postinstall": "electron-builder install-app-deps"
}
```

Configure native dependencies correctly for Electron. The finished repository must work after `npm install`, `npm test`, and `npm start`.

---

## 4. Security and Electron boundaries

Use a conventional secure Electron split:

- `contextIsolation: true`
- `nodeIntegration: false`
- sandbox the renderer when compatible with the required preload bridge
- a strict Content Security Policy using only local resources
- no remote content, remote fonts, `eval`, or unsafe inline script
- all filesystem and SQLite operations in the main process or dedicated main-process services
- a narrow, explicitly named preload API

The renderer must never receive an unrestricted filesystem API or arbitrary SQL access. Validate every IPC argument in the main process. Every path received from the renderer must be resolved against an already-open library root or selected by a native file dialog. Reject traversal, unexpected absolute paths, and symlink escapes.

Register a read-only custom protocol such as `worldhub://media/...` for displaying managed files. Resolve only known database-backed asset, rendition, and temporary-preview identifiers. Never expose unrestricted `file://` access.

Use atomic writes for Markdown, manifests, settings, and publication pointers: write a sibling temporary file, flush it, then rename it into place. Ensure temporary files are ignored during normal loading and cleaned safely after interrupted work.

---

## 5. Library ownership and portability

World Hub can open one managed library at a time. On first launch, show a library chooser with:

- **Create a library →**
- **Open a library →**
- recently opened libraries, if they still exist

Only recent paths and window preferences live in Electron's OS `userData` directory. All creative content and its metadata live inside the selected library.

Create this self-contained folder contract:

```text
World Hub Library/
├── world-hub-library.json
├── world-hub.sqlite3
├── documents/
│   ├── world/
│   ├── character/
│   └── entry/
├── assets/
│   ├── originals/
│   └── renditions/
├── inbox/
│   ├── documents/
│   ├── media/
│   └── attachments/
├── productions/
│   └── <production-slug>/
│       ├── publications/
│       └── current.json
├── backups/
├── logs/
└── tmp/
```

`world-hub-library.json` is a small human-readable descriptor containing:

- format: `world-hub-library`
- protocol version
- permanent library UUID
- display name
- created timestamp
- minimum compatible app version

Store all paths in SQLite and manifests as normalized forward-slash paths relative to the library root. Convert them to native paths only at the filesystem boundary. Never store a required absolute path.

### Library lock

Prevent simultaneous writers. Acquire a lock file when opening a library and record a random session token, process ID, machine identifier, and timestamp. If a live lock exists, offer:

- open read-only
- return to the library chooser

A stale lock may be cleared only after the app establishes that its process is not active on the same machine or the user explicitly confirms recovery. Closing the library cleanly releases the lock. Never silently allow two writers.

---

## 6. Canonical identity model

Every canonical entity receives a permanent UUID generated with `crypto.randomUUID()`. IDs never depend on a name, filename, array position, or application. Renaming Nao must not change Nao's identity. Moving a document must not change its identity.

Use an `entities` base table so all canonical subjects can participate in tags, documents, relationships, assets, search, and Productions.

Supported entity types in version 1:

- `world`
- `character`
- `location`
- `group`
- `species`
- `object`
- `event`
- `lore`

Worlds and characters have dedicated structured profiles. Other entity types use the shared identity fields, summary, linked Markdown, relationships, tags, and assets. This keeps version 1 flexible without pretending to know every future worldbuilding category.

### Base entity fields

- UUID
- type
- optional parent world UUID
- name
- stable editable slug, unique within its namespace
- concise summary
- lifecycle status: `draft`, `canonical`, `archived`
- sort order
- revision integer incremented on meaningful change
- created, updated, and archived timestamps

### World profile fields

- tagline
- genre
- tone
- short setting description
- visual direction
- preferred cover asset link
- preferred background asset link

### Character profile fields

- aliases, as an ordered list
- role
- age or age description as text, never forced numeric
- concise appearance summary
- concise personality summary
- concise biography summary
- concise voice summary
- preferred portrait asset link
- preferred full-body asset link

These are intentionally short fields for browsing, searching, summaries, and reuse. Long biographies, setting material, character studies, timelines, stories, and design notes belong in linked Markdown documents.

Do not put application-only fields such as acquisition tier, stamp sequence, AI temperature, pack rarity, or combat statistics in canonical profiles.

---

## 7. Required SQLite schema and migrations

Implement numbered, transactional database migrations. Record applied versions in `schema_migrations`. Never create the entire schema opportunistically through scattered `CREATE TABLE IF NOT EXISTS` calls. A new library runs all migrations; an old library upgrades sequentially. Back up the database before upgrading an existing library.

The exact column organization may be refined, but the schema must represent these concepts explicitly rather than hiding them all in one JSON column:

### Canon

- `entities`
- `world_profiles`
- `character_profiles`
- `entity_aliases`
- `relationships`
- `tags`
- `taggings`

Relationships are directed records with source entity, target entity, relationship type, display label, concise description, optional inverse label, order, and canonical status. The UI may present a relationship as bidirectional, but preserve the direction in data.

### Documents

- `documents`
- `document_links`

A document may link to several entities. Store its relative Markdown path, title, lifecycle status, checksum, word count, revision, and timestamps. The Markdown file is canonical; a database text cache may exist solely for indexing and recovery diagnostics.

### Assets

- `blobs`
- `assets`
- `asset_versions`
- `asset_links`
- `rendition_recipes`
- `asset_crops`
- `generated_renditions`

Separate a logical asset from immutable versions and deduplicated blobs:

- A **blob** is a content-addressed managed file identified by SHA-256.
- An **asset** is the meaningful item, such as “Nao ceremonial full body.”
- An **asset version** records that logical asset using a particular blob at a particular time.
- An **asset link** associates the logical asset with one or more entities and semantic roles.
- A **crop** stores non-destructive framing instructions for one version and one rendition recipe.
- A **generated rendition** records reproducible output derived from a version, recipe, and crop fingerprint.

### Inbox

- `inbox_batches`
- `inbox_items`

### Productions and distribution

- `application_contracts`
- `productions`
- `production_entities`
- `production_values`
- `production_asset_sets`
- `production_asset_items`
- `publications`
- `publication_files`

Flexible Production values may use validated JSON, but identity, selection, asset sets, publication history, and contracts must remain explicit tables with foreign keys.

### Operational metadata

- `settings`
- `activity_log`
- `schema_migrations`

Enable foreign keys. Use WAL mode during normal work. Wrap multi-record changes in transactions. Use indexes for common world, entity type, asset role, tag, inbox state, Production, and publication queries.

### Full-text search

Use SQLite FTS5 for:

- entity names, aliases, summaries, and structured profile text
- Markdown title and body
- asset labels, source filenames, roles, notes, and tags
- relationship labels and descriptions

Keep the index synchronized through a single search-index service called by domain transactions and document saves. Provide an explicit **Rebuild search index** maintenance action and test it.

---

## 8. Markdown documents

Markdown files must remain ordinary UTF-8 `.md` files in the library. The user should be able to inspect and back them up without World Hub.

Required behavior:

- Create, rename, duplicate, archive, restore, and link documents.
- Link one document to multiple entities without copying it.
- Plain-text Markdown editing with a preview mode and a side-by-side mode.
- Safe rendering: raw HTML is escaped or sanitized; scripts and active content never execute.
- Autosave after a short debounce, visible `Saving…`, `Saved`, and error states.
- Flush unsaved content before navigation, library close, backup, publication, or application exit.
- Atomic file replacement.
- Word count and last-edit metadata.
- Internal links using stable World Hub identifiers, with a small insertion picker.
- Relative links to managed media resolved safely for preview.
- Search within the current document and global search across documents.
- A conflict warning if the file changed externally since it was loaded. Never silently overwrite the external change; offer reload or save a recovered copy.

Use human-comprehensible paths such as:

```text
documents/character/<character-uuid>/biography.md
documents/world/<world-uuid>/setting-guide.md
documents/entry/<document-uuid>/notes.md
```

The UUID directory preserves identity when titles change. The filename may be renamed safely when the title changes.

---

## 9. Managed assets and version history

Supported managed content in version 1:

- Images: PNG, JPEG, WebP, GIF
- Audio: WAV, MP3, OGG, M4A
- Markdown
- Other files as generic attachments

Validate file signatures where practical rather than trusting extensions. Reject unreadable or empty imports with a plain-language error.

### Import rules

On import:

1. Read the bytes and calculate SHA-256.
2. Inspect media metadata.
3. Store one content-addressed blob under `assets/originals/<first-two-hash-characters>/<full-hash>.<ext>`.
4. Reuse an existing blob when the exact bytes already exist.
5. Create a logical asset or a new immutable version as appropriate.
6. Preserve the original filename and imported-from relative provenance as metadata.
7. Never rely on the original external path after import.

Replacing an asset creates a new current version. It never overwrites or deletes earlier bytes. Publications continue resolving the exact version they used.

### Semantic roles

World Hub owns this initial role vocabulary:

- `world.cover`
- `world.background`
- `location.background`
- `character.portrait`
- `character.identity_tile`
- `character.full_body`
- `character.sprite`
- `character.expression`
- `character.collectible`
- `object.icon`
- `scene.key_art`
- `audio.voice_line`
- `audio.character_cue`
- `reference.art`
- `reference.document`

An asset may have several links and roles. Do not infer a role from a filename permanently; Inbox may suggest one, but the user confirms it.

### Standard rendition recipes

Ship editable built-in recipes with stable IDs:

| Recipe | Canvas | Default fit | Output |
| --- | ---: | --- | --- |
| `thumbnail_square` | 320×320 | contain | WebP |
| `square` | 1024×1024 | cover | WebP |
| `landscape_16x9` | 1600×900 | cover | WebP |
| `wide_tile_16x9` | 1280×720 | contain | WebP with alpha |
| `portrait_9x16` | 900×1600 | cover | WebP |
| `card_3x4` | 900×1200 | cover | WebP |
| `original` | unchanged | none | original bytes |

A recipe records dimensions, fit, output format, quality, alpha behavior, background, and whether upscaling is allowed. Contracts refer to recipe IDs, never filenames.

Provide a rendition editor that previews all requested shapes from one original. Store focal point, zoom, pan, rotation, and optional background per asset version and recipe. Regeneration must be deterministic. Never bake the crop into the original.

Audio is copied without transcoding in version 1. Record duration when available, but do not require an external executable.

### Safe deletion

Normal UI actions archive logical assets. No automatic process deletes original blobs or old versions. Provide an explicit maintenance audit that identifies truly unreferenced blobs, explains why each is considered unreferenced, and requires confirmation before moving them to a recoverable trash directory. Permanent deletion is not part of routine use.

---

## 10. Bulk import and Inbox triage

Bulk import is a first-release feature, not future work.

The user can select one or more files or a whole directory. Directory import recursively walks normal files, ignores common hidden/system files, refuses symlink traversal, and preserves the source-relative path in the import record.

Import is non-destructive:

- Copy supported material into the managed Inbox.
- Do not move, rename, alter, or delete the source.
- Deduplicate identical bytes.
- Record the batch, original path relative to the chosen root, filename, type, size, checksum, import time, and status.
- Do not automatically convert folder names into canonical worlds or characters.

Inbox statuses:

- `unreviewed`
- `filed`
- `duplicate`
- `ignored`
- `error`

The Inbox screen must support:

- batch and folder-path filters
- media-type filters
- filename, path, and text search
- image thumbnails and Markdown excerpts
- single and multi-selection
- assign to an existing entity
- create a new entity from the selected item, with confirmation
- choose semantic role and tags
- turn Markdown into a linked canonical document
- turn media into a logical asset
- mark duplicate or ignored
- undo the last filing operation when no later dependency prevents it
- clear only already-filed staging copies after confirming that their canonical managed records resolve

Suggested matches may use conservative filename/folder token comparison. They are suggestions only and must never silently merge records.

---

## 11. Tags, relationships, and consistency

Tags are user-created, reusable, searchable, and optionally grouped. They may apply to entities, documents, assets, and Productions.

Relationships are first-class. The relationship editor must let the user search for the other entity, choose or create a relationship type, write a short description, set forward and inverse labels, and order relationships for display.

The application must make consistency visible:

- A character belongs to one canonical world in version 1.
- The same character UUID is referenced by every Production.
- Renames propagate everywhere through references without rewriting historical publications.
- Archived entities remain visible in old publications and can be restored.
- Deleting or archiving referenced material shows all affected documents, relationships, Productions, and unpublished changes before confirmation.
- No Production may copy a canonical name or summary into its own permanent data. Publication resolves canonical values at a specific revision.

Provide a **Usage** view on every entity, document, and asset showing its links, Productions, and publications.

---

## 12. Application contracts

World Hub has one publication engine. Consumer requirements are described by declarative **application contracts**, not executable exporters.

Contracts are JSON files that follow `world-hub-application-contract` version 1. Validate them with a bundled JSON Schema before saving or using them.

A contract can declare:

- application type and contract version
- supported World Hub package protocol versions
- Production-level fields
- required or optional entity selections
- allowed canonical entity types
- minimum, maximum, or exact selection counts
- per-selected-entity fields
- ordered repeatable groups
- required asset sets and exact/minimum/maximum counts
- allowed semantic asset roles
- required rendition recipes
- whether canonical documents are included, excluded, or selected
- field validation constraints

The version-1 schema-driven form engine must support:

- short text
- multiline text
- Markdown
- integer and decimal number
- boolean
- enum
- color
- canonical entity reference
- logical asset reference
- ordered list of primitive or grouped fields
- ordered entity selection
- ordered asset set

Do not execute code from contracts. Contracts are data interpreted by the generic form and validation engine.

Include one small, clearly labeled **Example Character Gallery** contract for demonstration and automated tests. It should request one world, between one and twelve characters, one portrait per character, and an optional caption. Do not include app-specific HeroCollector, StickerAlbum, ChatBot, or TaskStamps contracts in version 1.

Provide both:

- a guided contract editor for the supported descriptors
- a raw JSON view with validation errors and formatting

Changes to a contract create a new contract version. Existing published snapshots retain the embedded contract version they used.

---

## 13. Productions

A Production is app-specific authored content that references canonical material without redefining it.

Examples of future Productions include a particular sticker collection, a task-stamp set, a character-chat cast, or an RPG world campaign. These examples explain the concept; do not hardcode their rules.

Each Production has:

- permanent UUID
- name and slug
- application contract and version
- optional primary world
- lifecycle status: `draft`, `ready`, `archived`
- revision
- contract-defined Production values
- ordered canonical entity selections
- contract-defined per-entity values
- ordered asset sets
- validation state
- publication history

Build the Production editor dynamically from its contract. It must allow reordering with accessible move actions as well as drag and drop. It must show canonical information by reference and clearly distinguish canonical fields from Production-only fields.

Validation must be deterministic and return structured issues with:

- severity: error or warning
- stable code
- human sentence
- target record and field/slot
- suggested destination in the editor

A Production can be marked ready only with zero errors. Warnings do not block publication but are shown in the preview.

---

## 14. Publication protocol

Publish immutable directory snapshots using **World Hub Package Protocol 1**.

Each successful publication creates:

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
│   └── files/
└── checksums.json
```

`manifest.json` must include:

- format: `world-hub-package`
- protocol version
- publication UUID
- production UUID, name, slug, and revision
- application type
- application contract UUID and version
- source library UUID
- publication timestamp in UTC
- canonical entity IDs and revisions included
- relative paths to package sections
- complete/valid state

`assets/index.json` maps logical asset UUID, exact version UUID, blob checksum, semantic role, rendition recipe, dimensions, MIME type, and relative package path. Consumers must never derive filenames.

`checksums.json` contains SHA-256 for every other file in the package. JSON output is deterministic: stable key order where practical, stable record sorting, UTF-8, and two-space indentation.

### Publication process

1. Flush pending edits.
2. Validate the contract and Production.
3. Resolve the exact canonical revisions and asset versions.
4. Generate missing renditions in a temporary work area.
5. Assemble the complete snapshot in `tmp/`.
6. Verify references, schemas, file existence, sizes, and checksums from the assembled copy.
7. Move the verified snapshot to its immutable publication directory.
8. Atomically replace `productions/<slug>/current.json` with a small pointer containing the active publication UUID and relative manifest path.
9. Record publication and file rows in SQLite.

If any step fails, `current.json` remains unchanged and the incomplete temporary directory is removed or retained as a clearly labeled recoverable failure. Never partially update the active snapshot.

The Publish screen must preview:

- errors and warnings
- canonical records included
- documents and exact asset versions included
- files and renditions to be generated
- differences from the current publication: added, changed, removed
- estimated package size

Provide **Publish snapshot →** and **Export snapshot as ZIP →**. The ZIP contains the exact same internal package structure and bytes as the folder snapshot.

Document the protocol thoroughly in `WORLD_HUB_PROTOCOL.md`, including JSON examples and a short consumer algorithm. Do not create consumer SDKs in this assignment.

---

## 15. Backup, restore, and integrity

Implement two forms of protection.

### Automatic safety backups

Create rotating lightweight safety backups before migrations, before restore, and at most once per day when the library has changed. Include:

- a consistent SQLite backup
- all Markdown documents
- the library descriptor
- a manifest of current original-asset checksums

Keep a documented rotation such as the most recent seven daily backups. Because original blobs are immutable and may be large, lightweight automatic backups need not duplicate all of them; their manifest must reveal missing bytes during integrity checks.

### Full portable archive

**Create full archive →** writes one ZIP containing the database, descriptor, documents, original assets, rendition recipes/crops, contracts, and optionally publications. It must be sufficient to recreate the library on another Arch Linux or Windows PC.

Restore behavior:

1. Validate archive structure, format, schema compatibility, checksums, and database readability before touching the current library.
2. Create a pre-restore safety backup.
3. Extract into a temporary sibling directory.
4. Revalidate the extracted library.
5. Replace the library atomically where the platform permits, with a clear fallback procedure otherwise.
6. Never mix half of one library with half of another.

### Integrity center

Provide checks for:

- database foreign keys
- missing Markdown files
- database/document checksum disagreement
- missing or corrupt original blobs
- missing generated renditions
- orphaned staging files
- broken publication checksums
- stale temporary files
- search index drift

Safe repairs include regenerating renditions, rebuilding search, recreating missing folders, and clearing verified stale temporary files. Never invent missing originals or delete content automatically.

---

## 16. Main-process architecture

Organize code by responsibility. A suggested structure is:

```text
electron/
├── main.js
├── preload.cjs
├── ipc/
├── services/
│   ├── library-service.js
│   ├── lock-service.js
│   ├── database-service.js
│   ├── migration-service.js
│   ├── entity-service.js
│   ├── document-service.js
│   ├── asset-service.js
│   ├── inbox-service.js
│   ├── search-service.js
│   ├── contract-service.js
│   ├── production-service.js
│   ├── publication-service.js
│   ├── backup-service.js
│   └── integrity-service.js
└── protocol/
src/
├── app.js
├── router.js
├── store.js
├── ui/
├── views/
└── styles/
schemas/
migrations/
scripts/
tests/
assets/fonts/
```

Domain rules belong in services, not click handlers. Database access belongs behind repositories or cohesive services. UI views request prepared view models and invoke validated commands. Do not couple renderer components to SQL row shapes.

Use one structured result convention for IPC commands:

```js
{ ok: true, value, notices: [] }
{ ok: false, error: { code, message, details } }
```

Expected validation failures must become readable interface messages, not uncaught exceptions. Unexpected errors go to a local log with technical detail and produce a concise user-facing failure.

---

## 17. Renderer state and navigation

Implement hash or history routing without a framework. Required destinations:

- `/home`
- `/search`
- `/inbox`
- `/worlds`
- `/world/:id`
- `/characters`
- `/character/:id`
- `/entries`
- `/entry/:id`
- `/documents`
- `/document/:id`
- `/assets`
- `/asset/:id`
- `/relationships`
- `/contracts`
- `/contract/:id`
- `/productions`
- `/production/:id`
- `/publication/:id`
- `/integrity`
- `/settings`

Use a small centralized store for current library summary, navigation, selection, dirty/saving state, filters, and transient UI state. Do not mirror the entire SQLite library in renderer memory. Reload affected view models after commands.

Support deep links within an open library, back/forward navigation, keyboard focus restoration, and an explicit unsaved-change guard.

Global shortcuts:

- `Ctrl/Cmd+K`: search and command palette
- `Ctrl/Cmd+S`: flush the active editor
- `Ctrl/Cmd+N`: context-sensitive new item
- `Escape`: close the top overlay or clear selection

---

## 18. Required screens and workflows

### Library chooser

Create or open a library, show recent libraries, communicate read-only/locked state, and never display a broken main shell with no active library.

### Home

Answer: **“What in the library needs attention?”**

Show a reactive headline, recent worlds and characters, unreviewed Inbox count, recently edited documents, draft Productions, publication status, and the one most useful next action. Art from the most recently active world may carry the screen.

### Universal search

Search as the user types. Group results by worlds, characters, other entries, documents, and assets. Show why a result matched. Filters include world, entity type, tag, asset role, lifecycle status, and modified date. Keyboard navigation and Enter-to-open are required.

### Worlds

Responsive art-led gallery with text filters and accessible list fallback. Creating a world asks only for its name, then opens its detail view.

World detail sections:

- Overview
- Characters
- Entries
- Documents
- Assets
- Relationships
- Usage

### Characters

Browse across all worlds or within one world. Filters include world, tags, canonical/draft status, missing preferred art, and recent changes.

Character detail sections:

- Overview
- Profile
- Documents
- Assets
- Relationships
- Usage

Profile fields remain concise. Show linked long-form Markdown prominently instead of encouraging enormous textareas.

### Entries

Create and browse location, group, species, object, event, and lore entities. Use one flexible detail screen based on the entity type.

### Documents

Document browser plus Markdown workspace. Long documents and lists scroll normally. The editor must remain usable at small supported windows and must not trap the user in a nested scroll area unnecessarily.

### Assets

Responsive gallery with role, world, character, media kind, tag, status, aspect ratio, and usage filters. Asset detail shows metadata, current and previous versions, associations, all crops/renditions, Usage, replace-version action, and original-file reveal action.

### Inbox

Fast triage optimized for many files, as defined in section 10.

### Relationships

A filterable relationship browser and editor. A graph visualization is not required. Prefer clear text and subject art over a visually impressive but difficult-to-edit node graph.

### Contracts

Guided descriptor editor, raw JSON view, schema validation, version history, duplicate contract, and archive action.

### Productions

Contract-driven editor, canonical selections, Production-only fields, ordered asset sets, validation path, readiness state, Usage, and publication history.

### Publish preview and publication detail

Implement the complete process from section 14. A historical publication is read-only and resolves its recorded names, files, revisions, and checksums even after current canon changes.

### Integrity

Run checks, show progress and readable findings, offer only safe targeted repairs, and preserve a log of the last run.

### Settings

Library name, text scale, reduced motion, default rendition quality, automatic-backup state, backup actions, protocol/app versions, reveal-library action, and return-to-library-chooser action.

---

## 19. Visual design philosophy

The visual direction combines the strongest shared principles of the existing HeroCollector and Character Chat interfaces, with **HeroCollector's warm archive palette** as the permanent identity.

The thesis for World Hub is:

> **The app is about entering a living archive. It should feel like handling the worlds themselves, not administering records about them.**

Five governing words:

- **Bleed** — significant art exceeds its nominal region and dissolves into the floor.
- **Imply** — proximity, typography, and fading rules create groups; boxes do not.
- **Name** — every meaningful block has a small eyebrow label; states are written in prose.
- **One** — one headline, one primary action, one accent thread, at most one pulsing element per view.
- **Quiet** — interface chrome recedes so worlds, characters, prose, and artwork remain dominant.

### Important correction: scrolling is allowed

Disregard any older HeroCollector rule saying screens must never scroll. World Hub is an authoring application containing Markdown, large galleries, search results, and long forms. Vertical scrolling is normal and required. What should be avoided is careless nesting of several independent scroll containers, hidden unreachable controls, or layouts designed only for 1440×900.

Use a stable application shell with a text navigation rail and a naturally scrolling main document. Sticky local navigation is acceptable. Overlays must keep their own content reachable.

### Palette

```css
:root {
  --bg: #12100f;
  --bg-2: #1a1512;
  --bg-hover: #221b16;
  --text: #f4ece1;
  --text-dim: #b8aca1;
  --muted: #a2958a;
  --muted-2: #8e8278;
  --faint: #6f645c;
  --line: rgba(244, 236, 225, 0.14);
  --line-input: rgba(244, 236, 225, 0.18);
  --accent: #e9a94f;
  --accent-2: #b48ade;
  --good: #6fc9a0;
  --bad: #c9705f;
}
```

Amber is scarce: primary action, active text-tab underline, and the one ready/attention state. Color never carries meaning alone. Every good, blocked, changed, draft, missing, or ready state is also written.

World and character colors belong to content and may create a restrained glow behind their own art. They do not recolor the interface.

### Typography

Vendor the same local font families used by HeroCollector, including licenses:

- **Instrument Serif** for headlines, world and character names, section titles, and meaningful quantities.
- **Figtree** for body text, labels, controls, metadata, and editing apparatus.

No web font requests. Use responsive `rem` sizing and a text-scale CSS variable. Headlines wrap rather than clip at 1.4× scale.

### No box-heavy interface

Avoid filled dashboard panels, bordered cards, pill filters, chips, rounded Material controls, and rows containing clusters of icon buttons. Group by spacing, uppercase 11px eyebrows, and horizontal rules that fade before their ends.

Exceptions are practical rather than stylistic:

- Dense Inbox and search result rows may use a very quiet bottom hairline.
- Code/JSON/Markdown editor regions may use a subtly recessed floor to establish an editing surface.
- Native menus and overlays need a readable surface, but should feel like full working layers rather than floating cards.

Inputs are transparent with underlined focus treatment. Textareas grow where practical. Selects and filters read as text controls. Destructive actions use `--bad` and explicit verbs.

### Art

World covers, portraits, and full-body artwork should carry subject screens. Use CSS masks, alpha-preserving images, restrained radial glows, and full-width scrims. Do not force transparent art into hard rectangles. Do not crop images merely to make a layout convenient; cropping belongs to the rendition editor.

Missing art uses a deliberate masked hatch and a readable `NO ART` caption, never a broken-image icon.

### Voice

- Sentence case and full stops.
- Warm and calm, never cute or jokey.
- Reactive headlines: “Three worlds have changed since their last publication.”
- Empty states are written: “Nothing has been filed yet — bring the first folder into the Inbox.”
- Actions use verb plus destination: “Create a world →”, “Review the Inbox →”, “Publish this snapshot →”.
- State guarantees are explicit: “The source folder will not be changed.” “The current publication stays active if validation fails.”
- Avoid emoji as decoration and avoid icons that require tooltips to explain their meaning.

### Motion and accessibility

- Route crossfade around 180ms.
- Hover raises text contrast and lifts art no more than 2px.
- One slow pulse may mark the single ready or blocking item.
- Rendition and publication progress may animate, but never indefinitely after completion.
- `prefers-reduced-motion` and the app setting disable nonessential motion.
- Preserve visible keyboard focus, semantic elements, ARIA names, focus traps, Escape behavior, and screen-reader text.
- Real information never uses `--faint` as its only color.

### Responsiveness

Design primarily for 1440×900, but keep all content and actions reachable at 960×640. Use CSS Grid/Flexbox and ratios, not screenshot coordinates. At narrow widths, collapse secondary inspectors below the main content and convert the navigation rail into a compact accessible drawer.

---

## 20. Reliability and user protection

- Autosave ordinary edits, but never hide failures.
- Keep explicit Save available in editors and bind it to `Ctrl/Cmd+S`.
- Archive rather than delete by default.
- Before destructive or structural operations, state the exact affected records.
- Never cascade-delete historical publications.
- Never remove asset bytes merely because a link was removed.
- Failed imports remain inspectable in the Inbox with their reason.
- Failed publication never changes the active pointer.
- Failed restore never changes the current library.
- A corrupt main database should lead to a recovery screen offering verified backups, not automatic silent replacement.
- Record important actions in a bounded local activity log without recording document contents.

---

## 21. Tests

Create deterministic tests using temporary library directories. Do not write tests against the user's real data directory.

At minimum, test:

### Library and migrations

- create/open/close a library
- descriptor validation
- sequential migration and rollback on failure
- foreign keys and transaction rollback
- read-only opening under a live lock
- path normalization across Windows- and POSIX-shaped paths

### Canon and documents

- stable UUID through rename
- world/character creation and association
- relationship direction and inverse label
- tag assignment
- document creation, atomic save, checksum, external-change conflict, multi-entity links
- FTS indexing and rebuild

### Assets

- signature validation
- hash deduplication
- same blob used by separate logical assets
- immutable replacement versions
- previous version remains resolvable
- crop persistence
- deterministic rendition generation and cache invalidation
- transparency preservation
- missing-file integrity finding

### Inbox

- recursive import without modifying source
- relative provenance preservation
- symlink refusal
- duplicate recognition
- filing Markdown and media
- undo filing

### Contracts and Productions

- contract schema validation
- every supported dynamic field type
- exact/min/max entity and asset-set validation
- canonical references stay references after rename
- readiness blocked by errors but not warnings

### Publications

- deterministic package generation
- exact asset version resolution
- checksums cover every package file
- schema and reference validation
- diff from previous publication
- current pointer changes only after success
- injected failure leaves prior pointer unchanged
- ZIP and folder package contain identical internal bytes
- historical snapshot remains valid after current canon changes

### Backup and integrity

- lightweight safety backup
- full archive round trip
- invalid archive rejected before mutation
- pre-restore backup
- search-index repair
- rendition regeneration

Also include a smoke script that creates a temporary library, imports fixture Markdown and images, creates a world and character, files the imports, creates a Production with the example contract, publishes it, verifies it, closes the database, and reopens the library successfully.

---

## 22. Documentation required in the repository

Create:

- `README.md`: installation, running, testing, packaging, data locations, library chooser, backups, and troubleshooting.
- `DESIGN_PHILOSOPHY.md`: the permanent World Hub visual rules distilled from section 19.
- `WORLD_HUB_PROTOCOL.md`: complete Package Protocol 1 and Application Contract 1 specification with JSON examples and consumer pseudocode.
- `ARCHITECTURE.md`: process boundaries, services, database model, migrations, file ownership, atomicity, and dependency direction.
- `ASSET_ROLES.md`: semantic roles, built-in rendition recipes, crops, versions, and consumer resolution rules.

Documentation must describe the implemented behavior, not an aspirational future system.

---

## 23. Completion criteria

The assignment is complete only when all of the following are true:

- `npm install` succeeds.
- `npm test` succeeds.
- `npm run check` succeeds.
- `npm start` opens the Electron application without developer-console errors.
- A new library can be created in an arbitrary writable folder.
- The same library can be closed and reopened with all data intact.
- Bulk folder import creates a reviewable Inbox without changing the source.
- Worlds, characters, other entries, relationships, tags, and linked Markdown can be fully edited.
- Original assets are managed, deduplicated, versioned, searchable, and associated.
- Image renditions can be previewed and generated from non-destructive crops.
- Global search returns canonical profiles, Markdown, relationships, and assets.
- An application contract can be created and validated.
- A schema-driven Production can be completed and validated.
- A complete immutable publication and identical ZIP can be generated.
- Failed publication demonstrably preserves the current active snapshot.
- Automatic backup, full portable archive, restore validation, and integrity checks work.
- The app is usable at 1440×900 and 960×640, with long screens scrolling normally.
- Reduced motion, keyboard navigation, focus visibility, and accessible names work.
- Linux AppImage and Windows NSIS build targets are configured.
- There are no app-specific exporters or direct writes into consumer applications.
- There are no TODOs representing required behavior, dead controls, or fake persistence.

At the end of implementation, run the full test and smoke suite. Then report:

1. What was built.
2. The most important architectural decisions.
3. Commands run and their results.
4. Any genuine remaining limitation that does not violate the completion criteria.

Do not call the work complete before the application has been exercised end to end with real temporary files and a publication that is reopened and revalidated.
