# Phase 22 — Implementation Results

## Delivered

- Schema-v6 `conflicts` store with Vault/canonical/copy indexes.
- Persistent MarkdownConflictRecord model with deterministic identity and immutable captured snapshots.
- SyncEngine recording of eligible pull/push Markdown conflicts after conservative conflict-copy preservation.
- Vault snapshot/archive preservation of conflict metadata.
- Markdown semantic block splitter and bounded block-LCS planner.
- Automatic one-sided/identical region merging.
- Explicit local/remote/base/both-order choices for overlapping regions.
- Resolver preview UI with degraded-mode warning for large notes.
- Top-bar unresolved-conflict indicator and multi-conflict queue.
- Navigation to canonical note or preserved local copy.
- Stale-safe canonical resolution commit.
- Automatic Trash of untouched preserved local copy after resolution; edited copies are retained.
- Background/CRDT lifecycle hooks so resolution remains foreground canonical work.

## Automated coverage

`tests/phase22.test.mjs` covers:

- block round-tripping;
- independent semantic auto-merge;
- overlapping conflict detection;
- every explicit conflict choice;
- identical-edit handling;
- conflict-store idempotency/identity immutability;
- resolved-state persistence and open-queue removal.

`scripts/benchmark-phase22.mjs` exercises hundreds of semantic blocks near the bounded-LCS threshold and validates planning/resolution budgets.

`tests/e2e/phase22.spec.ts` covers:

- persisted unresolved indicator;
- resolver rendering of Base/Local/Remote variants;
- explicit local choice and preview;
- successful canonical resolution;
- resolved conflict metadata;
- automatic Trash of untouched local copy;
- rejection when canonical Markdown changed after conflict capture.

## Compatibility fixes

- Phase 21 schema contract was made forward-compatible with later schema upgrades.
- Phase 9 in-memory snapshot fixture now exposes the `conflicts` store because full Vault snapshots include conflict metadata.

## Safety boundary

Phase 22 does not alter protocol-v1 remote ordering, attachment synchronization, tree/path collision behavior, CRDT operation history or service-worker conflict authority. It is a foreground Markdown resolution layer over existing preserved conflicts.
