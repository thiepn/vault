# Phase 20 — Implementation Results

## Delivered

- Added Yjs 13.6.32 as the live Markdown CRDT engine.
- Added deterministic canonical seed updates created in an isolated temporary Y.Doc while preserving unique client IDs for live documents.
- Added per-note private `vault-edit:<vault>:<epoch>:<entry>` Supabase Realtime Broadcast rooms.
- Added Yjs update, state-vector request and state-response transport with strict validation and payload caps.
- Added origin-scoped Y.UndoManager integration ahead of CodeMirror history while a live room is active.
- Added deterministic canonical-writer election from Phase 19 Presence state.
- Added Presence-readiness gating so canonical writer authority is never assumed before the room membership snapshot is known.
- Added writer suspension during Presence reconnect/uncertainty.
- Added follower recovery snapshots instead of follower canonical dirty writes.
- Added safe leadership transfer: a new leader immediately feeds converged Yjs text to SaveCoordinator.
- Added live-room rebase after successful canonical sync push.
- Routed current-note task, property, Kanban, Canvas and link-conversion mutations through Yjs.
- Added safe lifecycle finalization across note/Vault switches, Reading mode, sign-out, role loss and teardown.

## Canonical architecture

Yjs remains ephemeral. The durable path is unchanged:

`Y.Text -> elected writer -> SaveCoordinator -> LocalRepository/IndexedDB -> protocol-v1 sync outbox -> ordered remote event log`

Followers preserve live text in the existing recovery-draft store until canonical state catches up or leadership moves to them.

## Backend

`backend/supabase/phase20_crdt_editing.sql` was applied successfully to THIEPN Core.

The migration adds private Realtime SELECT/INSERT policies for `vault-edit` topics. Both require:

- an active membership;
- role `owner` or `editor`;
- matching Vault ID and epoch;
- a non-disabled Vault;
- a valid EntryId-shaped fourth topic segment.

Viewers have no CRDT-room read or write access.

Direct verification confirms both `vault_realtime_crdt_read` and `vault_realtime_crdt_write` policies exist.

## Security/advisor review

Supabase security and performance advisors were rerun after the Phase 20 migration.

- No Phase 20 RLS-without-policy finding was introduced.
- No Phase 20 unindexed-foreign-key finding was introduced.
- Remaining authenticated `SECURITY DEFINER` warnings are the intentional Phase 15/18 sync/share RPC boundaries, not Phase 20 CRDT functions.
- Remaining RLS-without-policy findings are unrelated pre-existing `core.apps` and `core.protocol_versions` informational findings.
- Existing unused-index notices are informational and unrelated to the CRDT Realtime policies.

## Automated coverage

`tests/phase20.test.mjs` covers:

- deterministic canonical seed encoding;
- concurrent two-peer convergence;
- local-origin undo/redo preserving remote edits;
- late-join state-vector synchronization;
- binary/Base64 transport limits;
- private CRDT Realtime join/update/sync protocol;
- viewer rejection;
- canonical-writer/follower-recovery source invariants;
- SQL owner/editor-only RLS invariants.

`tests/e2e/phase20.spec.ts` covers the browser path from canonical cloud sync into a live Yjs room, outgoing CRDT updates, collaborative undo and persistence back through the existing canonical sync RPC.

`scripts/benchmark-phase20.mjs` is wired into CI as `npm run benchmark:crdt`.

## Compatibility

- Sync protocol remains version 1.
- Phase 19 Presence/cursor transport remains separate.
- Phase 18 owner/editor/viewer membership semantics remain the authorization source.
- Canonical conflict handling outside a compatible active CRDT room remains unchanged.
- Local-only and viewer workflows remain non-CRDT.

## Explicitly not added

- durable server-side Yjs documents;
- durable/replayable CRDT operation history;
- a global cross-user undo timeline;
- semantic/block-aware conflict UI;
- guaranteed closed-app replication.
