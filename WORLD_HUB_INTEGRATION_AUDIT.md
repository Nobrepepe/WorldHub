# World Hub Integration Audit

Phase 0 inventory for making World Hub the content authority for TaskStamps, ChatBot, StickerAlbum, and HeroCollector. Recorded before any integration change.

## Repositories and baseline

| Repository | Path | Branch | Revision | Uncommitted work | Baseline tests |
| --- | --- | --- | --- | --- | --- |
| WorldHub | /home/shiro/Projects/WorldHub | main | e93e002 | clean | 56 pass + smoke (`npm run check`) |
| TaskStamps | /home/shiro/Projects/TaskStamps | main | f20be9a | clean | 71 pass (`.venv/bin/python -m pytest`) |
| ChatBot | /home/shiro/Projects/ChatBot | main | 96c3f91 | clean | 28 pass (pytest installed into .venv for this work — the only environment change) |
| StickerAlbum | /home/shiro/Projects/StickerAlbum | main | daa466f | **9 modified files (pre-existing)** | 109 pass |
| HeroCollector | /home/shiro/Projects/HeroCollector | feature/goal-driven-qol-overhaul | 001f514 | **14 modified files (pre-existing)** | 81 pass (`npm test`) |

Pre-existing uncommitted work in StickerAlbum and HeroCollector is preserved untouched; integration changes are additive and isolated. No pre-existing test failures anywhere.

## Existing content sources (authored content)

- **TaskStamps** — SQLite (`Database` at app data dir), tables `worlds`, `characters`, `character_stamps` (exactly 15 ordered slots, CHECK 1–15), each referencing immutable `asset_versions` (relative_path + sha checksum). Content is authored in-app via `LibraryService` + `AssetService.import_file` (signature-sniffed images/sounds). Characters have `status: draft|ready`; only ready characters enter rotation.
- **ChatBot** — SQLite `data/chatbot.db`: `worlds` (genre, tone, summary, setting_description, style_guide, cover/session background paths), `locations` (per-world, background, mood_tags), `characters` (profile fields incl. `behavior_rules`, `ai_instructions`, `voice_style`, `relationship_to_user`, tile image), `character_images` (expression → sprite path), `lore_entries` (title, content, keywords, always_include). Images are files under `assets/`, referenced by relative path strings.
- **StickerAlbum** — JSON catalogs in `data/` (`collections.json`, `characters.json`, `stickers.json`, `packs.json`) loaded by repositories; authored via the in-app Creator (`creator_service`, drafts in `data/drafts.json`). Stickers: stable id, number, name, fixed 10-slot rarity pattern (3 common / 3 uncommon / 2 rare / 1 epic / 1 legendary via `RARITY_PATTERN`), image, flavor text, optional sound. Packs: price, foil rate, distribution selectors. A seed catalog is generated only when no catalog exists.
- **HeroCollector** — system content in `content/*.json` (balance, archetypes, materials, components, recipes, tags — mechanical definitions) merged with the Creator's `custom-content.json` (Electron userData; `active-custom-content.json` is the published copy) through `mergeContent()` → `buildContent(raw)` → semantic `validateContent(content)`. Custom DB v12 holds worlds (palette, campaign nodes ×30, chapter titles/images, HQ, archive with collections/relics/skins, world asset), characters (archetype, tier, faction, extraTags, equipment lines, skins, portrait/fullBody), factions, expeditions library, crisis library. **All imported art is stored as data URLs inside the JSON.**

## Existing user-state sources (must remain app-owned)

- **TaskStamps** — `habit_tasks`, `character_assignments`, `task_completions`, `task_penalties`, `stamp_placements` (historical boards reference exact `asset_version` ids), `pause_periods`, `vice_offerings/claims`, `app_settings`, `app_state`, backups.
- **ChatBot** — `scenes`, `scene_characters`, `messages`, `memories`, `personas`, `scene_templates`, `world_notes*` (private notes workspace, chats, suggestions), `settings` (provider/API/generation/display).
- **StickerAlbum** — `app_data/user_state.json` (`inventory` keyed by (sticker_id, style), `placements` sticker_id → style, savings, vice points/offerings, favorite character), `app_data/settings.json`, progress backups (`album-catalog-backup.json` pattern).
- **HeroCollector** — save state (`state.js`): owned characters, shards, equipment, campaign/node clears, parties, resources, HQ progress, crisis/expedition state, UI preferences; stored per platform (Electron userData / IndexedDB).

## Identifier dependencies in user state

- **TaskStamps** — TEXT UUID PKs everywhere (`uuid4` via `utilities/ids.new_id`). `stamp_placements` → `character_stamps.id` + `asset_versions.id`; `character_assignments` → `characters.id`; tasks may pin `world_id`. Assignment history survives removal via `CHARACTER_UNAVAILABLE` end reason. **New records can adopt Hub UUIDs directly; no legacy mapping needed for content imported fresh.**
- **ChatBot** — INTEGER AUTOINCREMENT ids. `scenes.world_id`, `scene_characters.character_id`, `memories` reference characters; messages reference scenes. **Hub UUIDs cannot replace local PKs; imported canonical rows need a `hub_id` column / mapping and scenes must pin their publication.**
- **StickerAlbum** — string catalog ids generated by the Creator (`character_id(code,index)`, `sticker_id(code,char,pos)` → e.g. `col_x_c3_s7`). `user_state.inventory`/`placements` are keyed by sticker id, so **sticker identity is the critical invariant**: an explicit one-time mapping from existing sticker ids to Hub Production sticker ids is required; never guessed.
- **HeroCollector** — Creator ids like `cw_*`, `cc_*`, `cf_*` (`newId(prefix)`); system ids are plain slugs. Saves reference character/world/node/crisis/skin/fragment ids; `reconcileSave` already keeps unknown references dormant rather than deleting. **Legacy-ID → Hub-UUID migration must be explicit, previewed, and backed up; dormant-reference behavior is the retirement mechanism.**

## Required World Hub content per application

- **TaskStamps** — selected worlds (cover art), selected characters (portrait, optional default sound), exactly 15 ordered stamp images per character with optional per-stamp sounds.
- **ChatBot** — worlds + profiles (genre/tone/setting/style guidance), locations (backgrounds, mood tags), characters + profiles, tile art, expression sprites, session/location backgrounds, linked Markdown lore, per-character AI guidance (Production-only), world/character selection and ordering.
- **StickerAlbum** — collection identity (title, description, theme color, cover, order), member characters (portrait/tile), 10 ordered sticker slots per character with fixed rarity pattern (number, name, flavor text, image, optional sound), pack catalog (price, foil rate, distributions).
- **HeroCollector** — worlds (palette, cover, HQ art, chapter art/titles, campaign nodes, archive collections/relics/skins, world asset identity), characters (archetype/tier/faction/tags selections, equipment line names + art, portrait/full body, skins), factions, expedition library content, crisis library content. Mechanical/balance definitions (`balance.json`, formulas, tier profiles, recipes) stay bundled with the game; the contract exposes enum choices referencing them.

## Content that must remain app-owned

Everything under "user-state sources" above, plus: ChatBot conversation-derived memories and private notes (never auto-promoted to canon), StickerAlbum ownership/duplicates/placements/savings, TaskStamps schedules/streaks/points, HeroCollector saves/progression/unlocks, and each app's settings and backups. HeroCollector's system/balance content is game code, not fiction, and stays in the repo.

## Migration risks and mitigations

1. **Existing user content vs Hub packages** (all apps) — transitional dual mode: legacy path stays the fallback until package parity; Hub mode makes legacy Creators read-only/hidden. No deletion of Creator data.
2. **StickerAlbum sticker identity** — ownership is keyed by sticker id. Mitigation: explicit one-time mapping table with preview; refuse ambiguous matches; retired stickers keep their last definition + media.
3. **TaskStamps historical boards** — placements must resolve exact bytes. Mitigation: import Hub media through the existing immutable `AssetVersion` system; new Hub art creates new versions; never delete referenced versions.
4. **ChatBot mid-conversation behavior changes** — scenes pin the `publicationId` they started under; updates apply to new scenes; explicit migrate-conversation action.
5. **HeroCollector data-URL art** — packages carry files, not data URLs. Mitigation: package-to-runtime adapter maps package paths through a narrow media protocol (Hub-content root only); saves gain an explicit, backed-up, previewed ID migration.
6. **Corrupt/adversarial packages** — all consumers validate in staging (ZIP path safety, manifest/protocol/appType, embedded contract, checksums, references, then app semantic validation) before any activation; failure changes nothing.
7. **Pre-existing uncommitted work** (HeroCollector, StickerAlbum) — integration files are new modules/dirs where possible; existing modified files are not reverted or rewritten wholesale.

## Conformance matrix (Phase 8)

Verified 2026-08-14. TS = TaskStamps (83 tests), CB = ChatBot (36), SA = StickerAlbum (123), HC = HeroCollector (87); WorldHub 66 + smoke.

| Requirement | TS | CB | SA | HC |
| --- | :-: | :-: | :-: | :-: |
| Authoritative contract in consumer repo, validates against Contract v1 | ✔ | ✔ | ✔ | ✔ |
| Representative publication publishes + verifies from World Hub | ✔ | ✔ | ✔ | ✔ |
| Install publication ZIP | ✔ | ✔ | ✔ | ✔ |
| Link production folder + check for update | ✔ | ✔ | ✔ | ✔ |
| Full validation before activation (paths, manifest, contract, checksums, references, app semantics) | ✔ | ✔ | ✔ | ✔ |
| Corrupt checksum rejected, nothing changes | ✔ | ✔ | ✔ | ✔ |
| Unlisted file rejected | ✔ | ✔ | ✔ | ✔ |
| Missing referenced asset rejected | ✔ | ✔ | ✔ | ✔ |
| Wrong applicationType rejected | ✔ | ✔ | ✔ | ✔ |
| Unsupported protocol version rejected | ✔ | ✔ | ✔ | ✔ |
| Traversal/absolute-path ZIP rejected | ✔ | ✔ | ✔ | ✔ |
| Failure-safe staged activation, atomic pointer | ✔ | ✔ | ✔ | ✔ |
| Import receipt with full provenance | ✔ | ✔ | ✔ | ✔ |
| Meaningful update preview | ✔ | ✔ | ✔ | ✔ |
| Rollback to previous publication | ✔ | ✔ | ✔ | ✔ |
| User state survives update/rename/retirement/failed import/rollback | ✔ | ✔ | ✔ | ✔ |
| Retirement is non-destructive (app-specific rule) | archive + reassignment | pinned scenes keep rows | last definition retained | dormant save data |
| Works offline from installed cache | ✔ | ✔ | ✔ | ✔ |
| Hub mode makes legacy authoring read-only/hidden; legacy data untouched | ✔ | ✔ | ✔ | ✔ |
| Never reads World Hub DB / library internals (grep-verified) | ✔ | ✔ | ✔ | ✔ |

World Hub side: no app-specific exporter or code path exists in the publication engine (grep-verified); packages are deterministic and immutable (test-verified). App-specific acceptance: TaskStamps historical boards resolve exact asset versions; ChatBot conversations stay pinned to their original publication with an explicit migrate action; StickerAlbum ownership is keyed by stable `hub:<char>:<slot>` identity; HeroCollector packages pass the game's own `validateContent()` and `gameReadiness()` with an explicit backed-up save-ID migration.
