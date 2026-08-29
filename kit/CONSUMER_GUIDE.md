# Building a World Hub consumer

Read this before changing anything under `worldhub/` or `vendor/worldhub-kit/`
in a consuming application. It is the whole standard; everything in it is
checked by `verify`, so you can confirm rather than remember.

    node vendor/worldhub-kit/js/verify.mjs

Wire that into the application's own test command. A failure names the file,
the line, and what to do instead.

---

## 1. The contract belongs to your repository

`worldhub/application-contract.json` is authoritative. World Hub imports it
and records the checksum of the bytes it read; a production whose contract has
drifted from that file **cannot be published**.

So: edit the contract here, then import it in World Hub (Contracts → Import
from file). Never retype a contract into World Hub — the copy that governs a
publication would then have no relationship to the one your repository keeps,
which is how the two came to disagree in four different ways at once.

`node scripts/kit-sync.mjs --check` in World Hub reports drift for every
checked-out application without changing anything.

## 2. Four version numbers, and only one you must never gate on

| Field | Where | Meaning | Do |
| --- | --- | --- | --- |
| `protocolVersion` | `manifest.json` | package format | gate |
| `contractFormatVersion` | `production/contract.json` | contract document format | gate |
| `vocabularyVersion` | `manifest.json` | the role and recipe names in use | gate |
| `contract.revision` | `manifest.json` | how many times the contract was edited | **record only** |

`contract.revision` climbs whenever anyone edits the contract in World Hub.
None of that changes how a package is read. Gating on it refuses every
publication after the next edit — which is exactly what happened, to a real
publication, in an app that had shipped `SUPPORTED_CONTRACT_REVISIONS = {1,2,3}`.

The shared reader does all four checks. If you are writing this code yourself,
you are doing something wrong — see §3.

## 3. Use the shared reader; do not write another one

`vendor/worldhub-kit/js/package-reader.mjs` (or `py/worldhub_kit/`) validates a
package completely: manifest, embedded contract, every checksum, unlisted
files, ZIP traversal and symlinks, and every internal reference. It reads
Package Protocol 1 and 2 and presents both in the current shape.

There were once four of these, one per application, transliterated by hand into
three languages. They disagreed exactly where the bugs were. Do not start a
fifth. If the reader is missing something, change it in World Hub's `kit/` and
re-sync; the lockfile makes a local edit a test failure.

## 4. Never write a recipe name in application code

Recipe ids are World Hub's to choose and they change. Ask the package:

```js
const set = pkg.setForRole('character.tile')     // what the art is FOR
const file = pkg.assetFile(assetId, pkg.recipesFor(set))
```

`recipesFor` reads the recipes out of the contract embedded in that package, so
a rename in World Hub needs no change here. `setForRole` means renaming a set
does not strand the screen that renders it. `assetFile` also consults
`renamedFrom`, so art published under a retired name still resolves.

`verify` fails on any recipe id in a string literal under `src/`. This is the
single reason one of the four applications survived the vocabulary rename that
broke the other three.

## 5. Two install-time traps that are invisible until they fire

**Content Security Policy.** Packaged art is served over a private scheme.
A policy of `img-src 'self' data:` refuses every image with no error in the
renderer — correct content, correct URLs, an app with no art. Admit your
scheme, and add `media-src` too if your contract ships audio.

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; img-src 'self' data: yourscheme:; media-src 'self' yourscheme:">
```

**Staging directory.** Activation ends in an atomic rename into the app's data
directory. Stage in the OS temp directory and that rename fails `EXDEV` when
temp is a different filesystem — often a tmpfs — so installs cannot complete.
Stage inside the app's own data directory.

`verify` checks both.

## 6. Fixtures are generated, never stored and forgotten

Conformance fixtures are built from a live World Hub and stamped with the
vocabulary version they were made under. `verify` fails when that stamp is
behind the kit.

This matters more than it sounds. Three applications once had green suites
*because* their fixtures predated a vocabulary rename: the tests certified the
drift instead of catching it, for eleven days. A fixture that cannot go stale
is the only kind worth keeping.

## 7. What belongs in a contract

**The contract carries what a writer would change. The repository carries what
a designer would tune.**

Names, lore, captions, art, the choices that shape a scene — contract. Power
values, weights, ratios, thresholds, anything in basis points — game code, in
your own repo.

A contract that has grown past a page of fields is usually carrying tuning that
does not belong to it. It makes the production screen unusable for the person
authoring the fiction, and World Hub cannot check the cross-references such
data always grows, so a typo publishes clean and fails at runtime.

## 8. What stays yours

Player state, progression, saves, settings, conversation history, ownership and
placements — all app-owned, never round-tripped into World Hub. The Hub is
upstream of your application and never reads from it.
