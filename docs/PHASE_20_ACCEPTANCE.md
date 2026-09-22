# Phase 20 — Acceptance Contract

## Product behavior

- Active owner/editor members can co-edit the same non-deleted Markdown note concurrently.
- Live text rooms are entered only from a verified canonical remote shadow with no dirty entry or queued operation for that note.
- Local-only Vaults, viewers, deleted notes and Reading mode never enter a live text room.
- Multiple editors converge through Yjs updates without inserting conflict-marker text.
- Programmatic current-note mutations use the same CRDT document as direct typing: tasks, properties, Kanban, Canvas fence edits and current-note link conversion cannot bypass live collaboration.
- CodeMirror undo/redo is replaced by Yjs UndoManager only while a live room is active.
- Collaborative undo tracks this editor's local origin only and never removes another editor's remote operation.
- Switching notes/Vaults, entering Reading mode, sign-out, demotion/revocation and teardown safely finalize or preserve the active live state.

## Canonical ownership and durability

- Canonical Markdown remains the existing LocalRepository/IndexedDB representation.
- Durable cloud history remains the Phase 15–18 ordered event log and Storage path.
- Yjs state is ephemeral transport/session state and is not stored as a second canonical document database.
- One deterministic active editor session is elected as the canonical writer for a live room.
- The canonical writer feeds the converged Yjs text into SaveCoordinator and the existing sync outbox.
- Followers do not mark canonical Markdown dirty merely because they receive or produce CRDT operations.
- Followers persist a stable local recovery draft while they are not the canonical writer.
- When leadership moves to this session, the converged Yjs text is immediately handed to SaveCoordinator.
- A successful canonical push rebases the live room on the new verified remote revision.

## Bootstrap, convergence and mismatch safety

- Identical canonical base snapshots produce the same isolated seed update.
- Live Yjs documents always use unique generated client IDs; a deterministic client ID is used only by a temporary immutable seed document.
- Late joiners request state from the deterministic room leader using Yjs state vectors.
- Same-base sync sends only the missing Yjs update.
- A base mismatch may replace only an untouched local CRDT session.
- If a session has produced local CRDT edits and receives a conflicting base, live editing stops and its text is preserved as a recovery draft instead of being overwritten.
- Existing Phase 15/16 canonical conflict handling remains authoritative outside an active compatible CRDT room.

## Realtime protocol and privacy

- Live editing uses a private per-note topic: `vault-edit:<vault-id>:<epoch>:<entry-id>`.
- Only Supabase Broadcast is enabled on the CRDT room; Presence remains on the separate Phase 19 `vault-collab` topic.
- Yjs updates can encode Markdown content/deltas and are treated as private note content.
- Runtime validation rejects malformed UUIDs, revisions, fingerprints, Base64 payloads and oversized CRDT frames.
- CRDT update payloads are capped at 768 KiB; state-vector payloads are capped at 128 KiB.
- Heartbeat, JWT refresh and bounded reconnect follow the existing Realtime transport pattern.
- No attachment bytes are carried over the CRDT room.

## Authorization

- Realtime SELECT/INSERT RLS for `vault-edit` requires an active owner/editor membership, matching Vault ID/epoch, a non-disabled Vault, and a valid EntryId-shaped topic segment.
- Viewers are excluded from both receiving and publishing live text Broadcast.
- Browser-provided role/session/base metadata never grants authorization.
- Canonical sync/storage authorization remains independently enforced.

## Compatibility

- Sync protocol remains version 1.
- Phase 19 Presence/cursor channels remain separate and unchanged.
- Phase 18 membership/invitation behavior remains unchanged.
- Existing file, task, property, query, board, Canvas and migration behavior remains compatible.
- Existing Phase 1–19 core/browser contracts must remain green.

## Performance

- The CRDT benchmark performs 5,000 local edits across two peers and converges 5,000 updates.
- Local edit generation and cross-peer merge must each stay below the 3-second CI budget.
- Normal Realtime Presence remains throttled separately; CRDT text updates do not use Presence.

## Explicit non-goals

Phase 20 does not implement:

- a durable server-side Yjs document store;
- a global shared undo timeline across users;
- durable/replayable CRDT operation history;
- semantic/block-aware interactive conflict resolution;
- guaranteed closed-app service-worker replication;
- rich-text structural CRDT nodes beyond canonical Markdown text.

## Release gate

Phase 20 may merge only when:

1. the CRDT Realtime RLS migration is applied to THIEPN Core;
2. Supabase advisors show no new Phase 20 actionable security/performance finding;
3. deterministic seed, convergence, local-only undo, late-join sync, transport and RLS tests pass;
4. CRDT performance benchmark passes;
5. production TypeScript/Vite build passes;
6. all Phase 1–19 tests and established benchmarks pass;
7. Chromium acceptance includes the Phase 20 live-room/undo/canonical-persistence scenario and remains green.
