# Consumer contract test copies

The authoritative Application Contracts live in the consumer repositories
(`<App>/worldhub/application-contract.json`). These are test copies used by
World Hub's conformance tests.

## Do not run the sync script yet

    node scripts/sync-consumer-contracts.mjs      # ← reds the build

Running it today takes this repository's suite from 9 passing to 3. The copies
here and the contracts in the consumer repositories have diverged in **both**
directions — Chat Bot's and Sticker Album's own contracts are ahead of these
copies, Task Stamps' differs again — and the representative productions in
`tests/fixtures/consumer-fixtures.mjs` are hand-written against *these* copies,
not against the real contracts. Syncing therefore replaces the copies with
contracts the builders cannot satisfy, and every affected production fails
validation with `production.not_ready`.

It is also the only mechanism that reveals the drift, and it destroys the
evidence by overwriting it. There is currently no way to ask whether these are
in sync without changing the answer.

This is being replaced by `scripts/kit-sync.mjs`, which pulls contracts through
`contract.importFile` in the correct direction and has a `--check` mode that
reports drift without writing. Until then, reconcile by hand and deliberately.
