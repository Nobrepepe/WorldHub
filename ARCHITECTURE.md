# Architecture

## Process boundaries

World Hub uses a conventional secure Electron split.

- **Main process** (`electron/`): all filesystem and SQLite access, every domain service, dialogs, the `worldhub://` media protocol, and window management.
- **Renderer** (`src/`): plain ES-module JavaScript, no framework. Sandboxed (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`) with a strict local-only Content Security Policy. Network requests are additionally cancelled at the session level.
- **Preload** (`electron/preload.cjs`): a narrow bridge exposing exactly three functions — `invoke(command, payload)`, `onEvent(listener)`, and `confirmFlushed()`.

The renderer never receives filesystem or SQL access. Every IPC payload is validated in the main process (`electron/ipc/validate.js`); every path from the renderer is resolved against the open library root with traversal, absolute-path, and symlink-escape rejection (`electron/services/paths.js`). Absolute paths enter the system only through native file dialogs.

## IPC convention

One channel (`worldhub:invoke`) with named commands registered in `electron/ipc/commands/*.js`. Every command declares whether it needs an open library and write access, and validates its payload before its handler runs. Results always take one shape:

```js
{ ok: true, value, notices: [] }
{ ok: false, error: { code, message, details } }
```

Expected domain failures are `DomainError`s with stable codes and human sentences; they become readable interface messages. Unexpected errors are logged locally with technical detail and surfaced as a concise failure.

## Services

Domain rules live in `electron/services/`, not in click handlers:

| Service | Owns |
| --- | --- |
| `library-service` | descriptor, folder contract, open/close lifecycle, counts |
| `lock-service` | session-token write lock, stale detection, recovery |
| `database-service` | SQLite open, pragmas (WAL, foreign keys), health checks |
| `migration-service` | numbered transactional migrations in `migrations/` |
| `entity-service` | entities, profiles, aliases, relationships, tags |
| `document-service` | Markdown files, atomic saves, conflicts, links |
| `asset-service` | blobs, versions, roles, crops, renditions, media URLs |
| `inbox-service` | non-destructive bulk import and triage |
| `search-service` | the single FTS5 sync point and rebuild |
| `contract-service` | contract validation (ajv) and versioning |
| `production-service` | productions, the field engine consumer, validation |
| `publication-service` | Package Protocol 1 assembly, verification, ZIP export |
| `backup-service` | safety backups, full archives, restore, DB recovery |
| `integrity-service` | checks and safe repairs |

`field-engine.js` validates contract-defined values; `stable-json.js` produces deterministic JSON for packages; `file-signatures.js` classifies files by bytes; `atomic-file.js` implements write-temp-then-rename with fsync.

## Database model

SQLite via better-sqlite3, WAL mode, foreign keys on, multi-record changes in transactions. The schema is created exclusively by the numbered migrations in `migrations/` and recorded in `schema_migrations`; an old library upgrades sequentially, with a database backup taken first.

Concept groups (see the migration files for exact columns):

- **Canon** — `entities` (all eight types share one base table), `world_profiles`, `character_profiles`, `entity_aliases`, `relationships` (directed), `tags`, `taggings`.
- **Documents** — `documents` (the .md file is canonical; `content_cache` exists for indexing and recovery only), `document_links` (many entities per document).
- **Assets** — `blobs` (content-addressed by sha-256), `assets` (logical), `asset_versions` (immutable), `asset_links` (entity + semantic role), `rendition_recipes`, `asset_crops`, `generated_renditions`.
- **Inbox** — `inbox_batches`, `inbox_items` (with source-relative provenance).
- **Distribution** — `application_contracts` (versioned JSON), `productions`, `production_entities`, `production_values` (the only JSON-valued table), `production_asset_sets`, `production_asset_items`, `publications`, `publication_files`.
- **Operational** — `settings`, `activity_log` (bounded), `schema_migrations`, and the `search_index` FTS5 table.

All stored paths are normalized forward-slash paths relative to the library root; conversion to native paths happens only at the filesystem boundary.

## File ownership and atomicity

- Markdown, manifests, settings, and publication pointers are written atomically: temp sibling → fsync → rename. Temp files carry a `.worldhub-tmp-` prefix, are ignored by loaders, and are cleaned when stale.
- Original blobs are immutable once written; replacement creates a new version row pointing at a new blob.
- Publications assemble in `tmp/`, are verified there (schema, checksums, references), then move into their immutable directory with a single rename. The database rows are recorded next, and `current.json` is replaced atomically as the very last step — so the pointer only ever names a fully recorded publication. If the pointer write itself fails, the rows are compensated away and the unreferenced directory removed.
- Restores extract to a temporary sibling, revalidate, then swap directories; the previous library is kept aside.

### Database/filesystem coupling

SQLite rollback cannot undo filesystem changes, so operations that touch both are ordered to fail safe: file writes are atomic (temp → rename) and happen such that an interruption leaves a *detectable* state, never a silently wrong one. A document whose row update failed after its file write is flagged as externally changed on next load (checksum disagreement) and routed through the conflict flow; a rendition whose rows and files diverge is found by the Integrity center and regenerated deterministically. Original blobs are immutable, so they can never be half-written into an inconsistent state — a partial import simply leaves an unreferenced file that the blob audit reports.

## Dependency direction

```text
canonical library → production → publication package → consumer application
```

There are no app-specific exporters, no writes into other applications' storage, and no bidirectional sync. Consumer requirements are declarative contracts (data), interpreted by one generic form/validation engine and one publication engine. Contract JSON is never executed.
