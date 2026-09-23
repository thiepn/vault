# Phase 22 — Acceptance Contract

## Goal

Provide explicit, Markdown-aware resolution for preserved sync conflicts while keeping Phase 15/16 conservative conflict-copy behavior and protocol-v1 replication authoritative.

## Conflict eligibility and persistence

- Interactive records are created only for Markdown conflicts with a verified prior remote shadow/base.
- Path collisions, structural move/rename races, attachment conflicts and delete races remain conservative non-interactive conflict-copy cases unless a safe Markdown base exists.
- Each persistent conflict record stores Vault ID, canonical EntryId, preserved conflict-copy EntryId, owner/epoch, base/remote revisions, immutable base/local/remote Markdown snapshots, source (`pull` or `push`), status, timestamps and optional resolution text.
- Conflict identity is deterministic per canonical EntryId + remote revision.
- Re-recording the same identity with different snapshots is a protocol error.
- Open and resolved records survive reload and full Vault backup/archive.

## Markdown block planning

- Resolver planning recognizes frontmatter, headings, paragraphs, lists, blockquotes, fenced code, Markdown tables, thematic breaks and blank spacing.
- The planner preserves exact Markdown bytes/text when blocks round-trip.
- Independent local-only and remote-only semantic regions are auto-merged.
- Identical edits are never shown as conflicts.
- Overlapping semantic regions become explicit conflict segments.
- Each conflict segment exposes Base, Local and Remote variants.
- Required choices are one of: local, remote, base, both local→remote, both remote→local.
- The final preview is generated from auto segments plus explicit choices; Apply remains disabled while a required choice is missing.

## Bounded complexity

- Block LCS is bounded to 450 blocks per side.
- Above that threshold the planner degrades to a conservative prefix/suffix coarse edit instead of unbounded quadratic work.
- UI visibly indicates degraded/coarse planning.
- The dedicated conflict benchmark must stay within its CI budget.

## Resolution safety

- Resolution first finalizes active CRDT/editor state and flushes current durable local text.
- Canonical overwrite is allowed only when current canonical Markdown still equals the captured remote snapshot or already equals the chosen resolution.
- If canonical Markdown changed after conflict capture, Apply fails with `STALE_WRITE`; the conflict remains open and newer canonical work is preserved.
- Applying a resolution writes through the normal LocalRepository/SaveCoordinator path so the result becomes ordinary dirty canonical Markdown for protocol-v1 sync.
- The conflict record is then marked resolved and retains its immutable captured snapshots plus `resolutionText`.
- If the preserved conflict copy is still unchanged from the captured local text, Vault moves it to Trash after resolution.
- If the preserved conflict copy was edited after capture, Vault retains it and reports that fact.

## UI and workflow

- The top bar exposes an unresolved conflict count only when open conflicts exist.
- Opening the resolver lists all unresolved conflicts in the active Vault.
- The resolver can navigate to either canonical note or preserved local copy.
- Resolving one conflict advances to the next open conflict.
- When no open conflicts remain, the resolver closes and the top-bar indicator disappears.
- Reading/local-only functionality remains usable without cloud connectivity.

## Schema and backup

- IndexedDB schema version is 6.
- Store `conflicts` is keyed by conflict ID and indexed by Vault ID, canonical EntryId and conflict-copy EntryId.
- Vault snapshots and full archives include conflict metadata.
- Restored resolved/open records preserve their original statuses and snapshots.

## Compatibility

- Sync protocol remains version 1.
- Phase 21 service-worker replication remains transport/staging only and does not resolve conflicts.
- Phase 20 CRDT live editing is finalized before resolver writes canonical Markdown.
- Phase 16 three-way auto-merge remains the first automatic merge attempt.
- Existing conflict-copy preservation remains the fallback whenever Phase 22 cannot prove safe interactive semantics.

## Explicit non-goals

Phase 22 does not implement:

- semantic resolution for attachments/binary content;
- automatic resolution of path collisions or structural tree conflicts;
- a full Markdown AST merge engine;
- automatic deletion of an edited preserved conflict copy;
- server-side conflict-resolution state;
- replayable CRDT history or global shared undo.

## Release gate

Phase 22 may merge only when:

1. schema-v6 compatibility tests pass;
2. planner and persistent conflict-store contracts pass;
3. conflict benchmark passes;
4. browser acceptance resolves a conflict end-to-end and verifies stale-write refusal;
5. full backup/snapshot paths remain green with conflict metadata;
6. all Phase 1–21 tests and benchmarks remain green;
7. production build and Chromium desktop/mobile acceptance pass.
