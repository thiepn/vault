# Phase 23 — Acceptance Contract

## Goal

Persist bounded, replayable Yjs collaboration history locally so a live-editing session can survive reload/crash and be inspected/recovered later without turning the CRDT journal into a second canonical Markdown database.

## Schema and identity

- IndexedDB schema is version 7.
- `crdtSessions` stores immutable canonical-base/session metadata.
- `crdtUpdates` stores structured-clone Yjs update bytes.
- A room key is bound to VaultId, EntryId, epoch, base revision and base fingerprint.
- Session metadata also stores the immutable canonical base Markdown required for historical reconstruction.
- A local session ID cannot be reused for another canonical base.

## Durable-before-broadcast ordering

- Local Yjs updates are appended to the journal before they are Broadcast to peers.
- Remote and sync-response updates are journaled before they are applied to the local Y.Doc.
- A journal append failure stops durable live transport and surfaces an error rather than silently broadcasting an unjournaled local operation.
- Journal writes are serialized to preserve transaction/lifecycle ordering.

## Crash/reload replay

- A new live room starts only after the normal Phase 20 exact-base eligibility gate succeeds.
- Vault loads all non-canonicalized journal sessions for that exact room base.
- Persisted updates are replayed into a fresh Y.Doc before the Realtime edit room joins.
- Replayed state may restore text that was never written to the canonical LocalRepository by a follower session.
- Replay never applies history from a different revision, fingerprint, Vault, entry, account or epoch.
- If replay changes the base text, Vault treats that state as locally significant recovery state and preserves it until canonicalized.

## Canonicalization boundary

- Journal history is marked canonicalized only when the verified remote shadow advances beyond the journal base **and** its remote Markdown exactly equals the current converged Yjs text.
- Merely pushing some operation elsewhere in the Vault does not canonicalize the room.
- Canonicalized sessions are excluded from automatic crash replay.
- Canonicalized sessions remain available for history inspection until retention pruning.

## History and recovery UX

- Cloud Vaults expose a `Collab history` control when retained journal history exists or a live journal session is active.
- The history dialog reconstructs Markdown from the immutable base plus retained Yjs updates.
- History replay is read-only.
- A user may download the reconstructed Markdown.
- A user may save reconstructed Markdown as a **new note**.
- History recovery never overwrites the canonical note.

## Retention and limits

- Individual journal updates are capped at 768 KiB.
- One active local journal session is capped at 16 MiB of update bytes.
- Canonicalized history is retained by default for up to 30 days.
- Canonicalized history is pruned as needed to keep retained journal data within a 64 MiB per-Vault budget.
- Active/non-canonicalized recovery history is never deleted by retention pruning.

## Compatibility

- Canonical Markdown remains LocalRepository/IndexedDB `contents`.
- Durable cloud history remains the protocol-v1 ordered remote event log.
- Phase 20 Yjs collaboration protocol and private Realtime authorization are unchanged.
- Phase 22 interactive conflict records remain independent from CRDT journal history.
- The service worker upgrades schema v7 but does not read/write collaboration-journal records.
- Full Vault archive semantics remain canonical/recovery-focused; bounded collaboration journal history is local auxiliary state, not required to restore canonical notes.

## Performance

- CI benchmarks 1,500 durable Yjs update appends and full replay into a fresh document.
- Source generation must remain below 1.5 s.
- Journal append processing must remain below 2.5 s in the in-memory benchmark.
- Replay/reconstruction must remain below 1.5 s.

## Explicit non-goals

Phase 23 does not implement:

- a global cross-user undo timeline;
- server-side durable Yjs documents;
- replaying history onto a mismatched canonical base;
- unbounded permanent collaboration logs;
- collaborative-history replication between devices;
- replacing canonical protocol-v1 revisions/conflict handling.

## Release gate

Phase 23 may merge only when:

1. schema-v7 upgrade and service-worker compatibility tests pass;
2. journal identity/replay/canonicalization/pruning contracts pass;
3. local-before-broadcast ordering is covered;
4. journal replay benchmark passes;
5. Chromium acceptance proves follower-only live edits survive reload from the journal while canonical Markdown stays unchanged;
6. Chromium acceptance proves reconstructed history can be recovered only as a new note;
7. all Phase 1–22 contracts, benchmarks, production build and browser acceptance remain green.
