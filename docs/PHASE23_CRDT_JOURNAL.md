# Phase 23 — Durable CRDT Collaboration Journal & Session Recovery

Phase 23 makes Phase 20 live collaboration recoverable across reload/crash without making Yjs the canonical storage model.

## Architecture

```text
canonical remote shadow (exact base)
            │
            ▼
      deterministic Yjs seed
            │
            ├── persisted local/remote Yjs updates ──► crdtUpdates
            │                                             │
            │                                             ▼
            │                                       replay on reload
            ▼                                             │
       active Y.Doc ◄──────────────────────────────────────┘
            │
            ├── local update: journal first → Broadcast
            ├── follower: recovery draft + journal
            └── leader: SaveCoordinator → protocol-v1 sync
                                      │
                                      ▼
                            verified remote shadow advances
                                      │
                                      ▼
                              mark room canonicalized
```

## Exact-base room identity

Every journal room is keyed by:

- VaultId;
- EntryId;
- cloud epoch;
- canonical remote revision;
- canonical Markdown fingerprint.

The canonical base Markdown itself is stored immutably in session metadata so old sessions can be reconstructed later. The base text is not used as canonical state; it is only the replay seed for the recorded Yjs updates.

## Why updates are journaled before Broadcast

A local follower can edit collaboratively without writing canonical Markdown. If the browser crashes after Broadcast but before durable local recovery, the peer may have seen the edit while this device loses it.

Phase 23 serializes each local append into `crdtUpdates` first and only then calls the existing Phase 20 Broadcast transport. This gives the origin device a durable recovery record before exposing the operation to peers.

## Replay

After the normal exact-base Phase 20 gate verifies the current canonical note, Vault:

1. opens/reopens the local journal session for that base;
2. loads all non-canonicalized updates for the room;
3. applies them to a fresh seeded Y.Doc;
4. marks the reconstructed text as recovery-significant when it differs from the base;
5. elects the normal canonical writer;
6. then joins the private Realtime edit room.

Yjs updates are idempotent/commutative, so updates from prior local sessions on the same exact room can be replayed together.

## Canonicalization

The journal is not acknowledged by timing or by a generic successful sync pass.

A room becomes canonicalized only when the normal SyncEngine has produced a verified remote shadow whose revision is newer than the room base and whose Markdown exactly equals the current converged Yjs text. At that point automatic crash replay excludes the room, but history remains available until retention pruning.

## Local history

`Collab history` lists retained local sessions and reconstructs their Markdown on demand. Recovery creates a new Markdown note. This makes the journal useful as a crash/session history without creating a hidden overwrite path into canonical content.

## Retention

Canonicalized histories are bounded by age and per-Vault size. Active/non-canonicalized history is protected from pruning. This prevents a long-running collaborative Vault from accumulating an unbounded private operation log.
