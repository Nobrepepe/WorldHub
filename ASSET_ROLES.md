# Assets: roles, recipes, crops, and versions

## The model

- A **blob** is an immutable, content-addressed file: `assets/originals/<hh>/<sha256>.<ext>`. Identical bytes are stored once.
- An **asset** is the meaningful item ("Nao ceremonial full body"). It has a title, kind (image / audio / markdown / attachment), notes, tags, and links.
- An **asset version** records that the asset used a particular blob at a particular time, with the original filename and imported-from provenance. Replacing an asset appends a new version; earlier bytes are never overwritten or deleted, and publications keep resolving the exact version they used.
- An **asset link** associates the asset with an entity under a semantic role. One asset may carry several links and roles.
- A **crop** stores non-destructive framing instructions for one version and one recipe.
- A **generated rendition** is reproducible derived output, fingerprinted by original bytes + recipe + crop.

## Semantic roles

Roles say what art *means*, never how it is stored. The built-in vocabulary:

| Role | Meaning |
| --- | --- |
| `world.cover` | The world's leading image |
| `world.background` | Full-screen backdrop for the world |
| `location.background` | Backdrop for a location |
| `character.portrait` | Face-forward character image |
| `character.identity_tile` | Small identifying tile |
| `character.full_body` | Full-body artwork |
| `character.sprite` | Game-ready sprite |
| `character.expression` | An expression variant |
| `character.collectible` | A collectible presentation of the character |
| `object.icon` | Icon for an object |
| `scene.key_art` | Key art for a scene or moment |
| `audio.voice_line` | A spoken line |
| `audio.character_cue` | A musical or audio cue for a character |
| `reference.art` | Reference material, not for presentation |
| `reference.document` | Reference file |

The Inbox may suggest a role from the file path, but a person always confirms it. Contract asset sets constrain which roles they accept, and validation enforces that a chosen asset is linked to the selected entity under an allowed role.

The vocabulary is enforced at the service boundary: linking or importing with a role outside this list is refused, so typos never become permanent data. Published packages export the roles an asset **actually holds** for the linked record, never a contract's allowed list.

## Built-in rendition recipes

| Recipe | Canvas | Default fit | Output |
| --- | ---: | --- | --- |
| `thumbnail_square` | 320×320 | contain | WebP with alpha |
| `square` | 1024×1024 | cover | WebP |
| `landscape_16x9` | 1600×900 | cover | WebP |
| `wide_tile_16x9` | 1280×720 | contain | WebP with alpha |
| `portrait_9x16` | 900×1600 | cover | WebP |
| `card_3x4` | 900×1200 | cover | WebP |
| `original` | unchanged | none | original bytes |

A recipe records dimensions, fit, output format, quality, alpha behavior, background, and whether upscaling is allowed. Recipes are editable (Settings → rendition quality sets the default; each recipe can be tuned via the API). Contracts refer to recipe IDs, never filenames.

`allow_upscale` is honored for every fit: when it is off (the default) and the original is smaller than the canvas, the rendition keeps the original's scale instead of being enlarged, and its true dimensions are recorded in the database and in `assets/index.json`. Enable upscaling on a recipe when exact canvas dimensions matter more than sharpness.

## Crops and determinism

The rendition editor stores, per version and recipe: focal point (x/y in 0–1), zoom (1–8), pan, rotation, and an optional background color. Generation is deterministic — the fingerprint covers the original's checksum, every recipe parameter, and every crop parameter, so the same inputs always produce the same bytes. Changing a crop invalidates and removes the stale output for that version+recipe. The crop is never baked into the original.

Audio is copied without transcoding. WAV duration is read from the header; no external executable is required.

## Deletion safety

Archiving an asset hides it from browsing but touches no bytes. No automatic process deletes blobs or versions. The Integrity screen's audit lists blobs no version references, explains why each is considered unreferenced, and — only with confirmation — moves them to `trash/` inside the library, from which they can be re-imported. Permanent deletion is not part of routine use.

## Consumer resolution

Consumers never look at `assets/originals/`. A published package carries `assets/index.json`, mapping (assetId, recipeId) → exact versionId, blob checksum, dimensions, MIME type, and the package-relative file path. See [WORLD_HUB_PROTOCOL.md](WORLD_HUB_PROTOCOL.md).
