# Phase 23 — Implementation Results

## Delivered

- Schema v7 with `crdtSessions` and `crdtUpdates`.
- Immutable exact-base room/session identities including canonical base Markdown.
- Serialized local/remote/sync-response journal writes.
- Durable-before-Broadcast ordering for local Yjs operations.
- Exact-base automatic replay before Realtime room join.
- Recovery-significant handling when replayed text differs from canonical base.
- Exact remote-shadow text/revision canonicalization gate.
- Session close/reopen handling across note/Vault/mode/auth lifecycle.
- Teardown/auth-failure journal flushing.
- 768 KiB per-update and 16 MiB active-session safety limits.
- 30-day / 64 MiB canonicalized-history retention policy.
- Read-only Collab history replay UI with download and save-as-new-note recovery.
- Schema-v7 service-worker upgrade compatibility without worker access to the journal.
- Phase 23 journal contract tests and replay benchmark.
- Chromium follower crash/reload recovery acceptance.

## Canonical boundary

The journal is auxiliary local history. It does not replace:

- `contents` as canonical local Markdown;
- SaveCoordinator/localVersion semantics;
- protocol-v1 outbox/event-log history;
- remote shadows/cursors;
- Phase 22 interactive conflict resolution.

## Recovery behavior

A follower's live edit can remain absent from canonical `contents` while still being durable in `crdtUpdates`. After reload, if the remote shadow is still the same exact base, Vault replays the journal and restores that live text before joining Realtime again.

If the canonical base no longer matches, the old room is never auto-applied to the newer note. It remains historical/recovery data until canonicalized/pruned or recovered explicitly as a new note.

## User-facing history

The Collab history dialog reconstructs retained sessions from base Markdown plus Yjs updates. It exposes status, base/canonical revision, update count and retained byte size. Recovery is deliberately copy-only: reconstructed history can be downloaded or saved as a new note, never applied directly over canonical Markdown.
