# Phase 20 — Live CRDT Text Co-Editing & Shared Undo Foundation

Phase 20 adds simultaneous character-level Markdown collaboration without replacing Vault's canonical local-first data model.

## Architecture

```text
CodeMirror
   │
   │ local text splice
   ▼
Y.Doc / Y.Text  ───────── private Broadcast ───────── Y.Doc / Y.Text
   │                                                     │
   │ converged text                                      │ follower recovery
   ▼                                                     ▼
elected canonical writer                          recovery draft store
   │
   ▼
SaveCoordinator
   │
   ▼
LocalRepository / IndexedDB
   │
   ▼
existing protocol-v1 sync outbox + ordered event log
```

The CRDT room is therefore a **live coordination layer**, not a second durable note database.

## Canonical-base gate

Vault starts a live room only when the currently open Markdown text exactly matches its verified remote shadow and the note has no local dirty marker or queued sync operation.

The room base is identified by EntryId, remote revision, and lightweight Markdown fingerprint. If those conditions are not true, editing continues through the existing local-first SaveCoordinator and normal sync/conflict path until a verified base exists.

## Deterministic seed without duplicate live client IDs

Every editor must represent the same canonical base as the same Yjs structure before concurrent operations can merge correctly.

Vault creates an isolated temporary Y.Doc whose client ID is derived from the canonical EntryId/revision/fingerprint, inserts the base Markdown once, encodes that seed as a Yjs update, then destroys the seed document.

Live Y.Docs **do not reuse that client ID**. They retain Yjs-generated unique live client IDs. This preserves Yjs client-identity safety while allowing independently opened editors to apply an identical canonical seed update.

## Room synchronization

The per-note room is `vault-edit:<vault-id>:<epoch>:<entry-id>`.

On connection:

1. an editor joins the authenticated private Broadcast room;
2. it builds its local Y.Doc from the verified canonical seed;
3. it requests missing state using its Yjs state vector;
4. the deterministic active leader responds;
5. if both sides share the same canonical base, only missing Yjs state is sent;
6. if bases differ, the leader sends a full state replacement marker.

A replacement is accepted only when the receiving session has not generated local CRDT edits. Otherwise Vault stops live editing and preserves the local text as recovery data.

## Canonical writer election

All owner/editor sessions participate in Yjs, but only one session writes the converged text into canonical local Markdown.

The writer is the lexicographically smallest active owner/editor session ID on the current note.

When leadership changes, the new leader immediately hands the current converged Yjs text to SaveCoordinator; the former leader stops generating new canonical saves; followers keep a stable recovery draft; the existing SyncCoordinator eventually publishes the leader's canonical dirty state; and after a successful push Vault rebases the live CRDT room on the new remote revision.

This prevents every participant from turning identical CRDT convergence into competing protocol-v1 canonical writes.

## Undo/redo

Y.UndoManager tracks only the local editor transaction origin.

While a live room is active, Ctrl/Cmd+Z uses Yjs undo, Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y use Yjs redo, and remote Yjs updates are not included in this editor's undo stack. When the live room is inactive, Vault falls back to CodeMirror's normal local editor history.

## Current-note mutation coverage

The CRDT layer is not limited to keystrokes. Current-note mutations from task controls, properties, Kanban moves, Canvas fence persistence, unlinked-mention conversion, and normal typing/formatting commands all flow through the active Y.Text document.

Mutations to other notes remain ordinary repository writes because those notes do not have an active local editor/CRDT session.

## Security and privacy

The Supabase RLS migration permits `vault-edit` SELECT/INSERT only for active `owner` or `editor` memberships on the matching Vault/epoch.

Unlike Phase 19 cursor metadata, Yjs updates can reveal actual Markdown text/deltas. They are therefore treated as note content and are never available to viewers.

The CRDT room carries no attachment bytes and stores no durable server-side CRDT document.
