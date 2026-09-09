# World Hub

World Hub is a local-first, offline desktop application for one writer's fictional settings. It is the canonical home for worlds, characters, lore entries, Markdown documents, artwork, and audio — organized once, then published as immutable, self-contained content snapshots that other applications read.

There are no accounts, no cloud, no telemetry, and no network access at runtime. Everything lives in one library folder you can back up and move between Arch Linux and Windows.

## Installation

```bash
npm install
```

`postinstall` rebuilds the native modules (better-sqlite3, sharp) against Electron's ABI via `electron-builder install-app-deps`. If npm blocked install scripts, approve them and rebuild:

```bash
npm install-scripts approve better-sqlite3
npm rebuild better-sqlite3
npx electron-builder install-app-deps
```

## Running

```bash
npm start
```

On first launch, World Hub shows the library chooser:

- **Create a library →** picks a parent folder and creates a new self-contained library folder inside it.
- **Open a library →** opens an existing library folder (the one containing `world-hub-library.json`).
- **Restore a library from an archive →** rebuilds a library from a full portable archive ZIP.
- Recently opened libraries are listed and reopen with one click.

Only recent paths and window preferences live in Electron's `userData` directory. All creative content lives inside the library folder you chose.

### Launching without a terminal

Install a desktop entry once, and World Hub can be started from the application
menu and pinned to the taskbar:

```bash
npm run app:install
```

This installs `~/.local/share/applications/world-hub.desktop` and the archive
icon into the user's `hicolor` icon theme. The entry runs
`packaging/world-hub`, which starts the app straight from this project the same
way `npm start` does — a launch from the taskbar always opens the current
source, and nothing needs rebuilding after an edit. Re-run the command after
moving the project directory; `./packaging/install-desktop-entry.sh --uninstall`
removes the entry and icons again.

The launcher's output is kept at
`~/.local/share/world-hub/logs/launcher.log` (truncated per launch), which is
where a startup failure will explain itself when there is no terminal to watch.
The app's own logs stay in its `userData` directory.

## Testing

```bash
npm test        # unit, persistence, migration, and publication tests
npm run check   # tests plus the end-to-end smoke script
```

Tests run against temporary directories only; they never touch a real library.

## Packaging

```bash
npm run dist:linux   # AppImage
npm run dist:win     # NSIS installer (run on Windows, or under wine)
```

Both builds carry the archive icon from `assets/icon/world-hub.png`. That PNG
is derived, never edited: `packaging/world-hub.svg` is the source of truth, and
`npm run icon:build` re-renders the PNG from it. A packaged AppImage is a frozen
copy of the source at build time; for day-to-day use the desktop entry above is
preferable, since it always runs the current code.

## Data locations

A library is one folder:

```text
My Worlds/
├── world-hub-library.json     descriptor: format, protocol version, library id
├── world-hub.sqlite3          the database (WAL mode)
├── documents/                 ordinary UTF-8 .md files
├── assets/originals/          content-addressed original files (sha-256)
├── assets/renditions/         regenerable derived images
├── inbox/                     staging copies awaiting triage
├── productions/<slug>/        publications and the current.json pointer
├── backups/                   rotating safety backups
├── logs/                      local logs
└── tmp/                       work area for atomic operations
```

Markdown files and original assets are ordinary files — you can read and back them up without World Hub.

## Backups

- **Safety backups** rotate automatically (at most one per day when the library changed, and before migrations or restores): a consistent database copy, all Markdown, the descriptor, and a checksum manifest of originals. The most recent seven are kept.
- **Full archive** (Settings → *Create full archive →*) writes one ZIP with the database, descriptor, documents, originals, and optionally publications — enough to recreate the library on another PC.
- **Restore** always validates the archive completely first, makes a pre-restore backup, extracts to a sibling folder, revalidates, and swaps atomically. A failed restore never changes the current library.

## Troubleshooting

- **"This library is already open"** — another World Hub session holds the write lock. Open read-only, or recover the lock if the other session crashed (the chooser detects stale locks from dead processes on the same machine).
- **"The library database could not be opened"** — the chooser offers recovery from verified safety backups. The damaged database is kept aside in `backups/`; nothing is replaced silently.
- **A document says it changed outside World Hub** — the file on disk was edited by another program. Choose *Reload* or *Save my text as a recovered copy*; the external change is never overwritten.
- **Missing renditions or search oddities** — run Integrity (Care → Integrity → *Run all checks →*). Renditions regenerate deterministically; the search index rebuilds from the database.
- **Native module errors on start** — rerun `npx electron-builder install-app-deps`.

## Consumer applications

Four sibling applications consume World Hub publications: Task Stamps,
ChatBot, Sticker Album, and Hero Collector. The integration follows one rule:

```text
canonical library → production → immutable publication → consumer's own cache
```

- **Contracts** — each consumer owns its Application Contract at
  `<App>/worldhub/application-contract.json`. World Hub keeps test copies in
  `tests/fixtures/contracts/` (re-sync with
  `node scripts/sync-consumer-contracts.mjs`); a contract edit in a consumer
  repo is imported into a library through the Contracts screen (raw JSON view)
  and becomes a new contract version there.
- **Creating productions** — create a Production from the app's contract,
  fill its fields and selections, mark it ready, and publish. Consumers
  install the ZIP export, or link the production folder
  (`productions/<slug>/`) and pull updates from `current.json`.
- **Conformance fixtures** — `node scripts/generate-consumer-fixtures.mjs`
  builds synthetic packages (valid v1, valid v2 update, six adversarial
  variants, and an `expected.json`) into every consumer repository's
  `tests/fixtures/worldhub/`; all four consumer test suites run against them.
- **Generic extension made for this integration** — reference-typed
  Production values (`entityRef`/`assetRef`, including inside nested lists
  and asset-set item fields) are resolved into packages, with an optional
  `recipes` hint on `assetRef` fields. No app-specific code exists in the
  publication engine.

The integration audit and conformance matrix live in
[WORLD_HUB_INTEGRATION_AUDIT.md](WORLD_HUB_INTEGRATION_AUDIT.md).

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — processes, services, database model, atomicity.
- [WORLD_HUB_PROTOCOL.md](WORLD_HUB_PROTOCOL.md) — Package Protocol 1 and Application Contract 1.
- [ASSET_ROLES.md](ASSET_ROLES.md) — semantic roles, recipes, crops, versions.
- [DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md) — the permanent visual rules.
