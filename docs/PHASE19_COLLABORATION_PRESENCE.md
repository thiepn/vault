# Phase 19 — Live Presence & Collaborative Session Foundation

Phase 19 adds collaboration awareness to shared Vaults while deliberately leaving canonical Markdown synchronization unchanged.

## Architecture

```text
Phase 18 active membership
          │
          ├─→ canonical sync authorization
          │      vault:<vault>:<epoch>
          │      ordered event log / RPC / Storage
          │
          └─→ Phase 19 ephemeral collaboration
                 vault-collab:<vault>:<epoch>
                       │
                       ├─ Presence → active item / mode / role
                       └─ Broadcast → cursor + selection offsets
```

The two Realtime topics are intentionally separate. A collaboration outage cannot alter canonical sync correctness, and a collaboration message cannot mutate a note.

## Presence payload

Presence is slow-changing session state only:

- protocol version;
- Vault UUID;
- authenticated user UUID;
- DeviceId;
- random per-tab session UUID;
- current Phase 18 role: owner/editor/viewer;
- active EntryId or null;
- current surface: source, live, reading, attachment, folder or none;
- online timestamp.

Vault does not send email addresses, display names, note titles, paths, Markdown content, selection text, task content or attachment data through Presence.

Supabase Presence is deliberately updated only when the active item/mode/role changes. It is not used for mouse/caret movement.

## Cursor Broadcast

Cursor updates are private Realtime Broadcast messages containing:

- Vault and Entry UUID;
- user/device/session UUIDs;
- caret position;
- selection start/end offsets;
- an 8-hex advisory document fingerprint;
- timestamp.

Outgoing cursor updates are throttled to at most 10 Hz.

### Snapshot alignment

Offsets are meaningful only if both clients see the same Markdown text. The editor therefore keeps a lightweight FNV-1a-style fingerprint of its current document. Remote cursors render only when the incoming fingerprint exactly matches the local fingerprint.

This fingerprint is **not cryptographic** and is not used for authorization, integrity or conflict resolution. Its only purpose is to avoid misleading cursor placement when two local-first replicas have diverged.

Remote cursor state expires locally after 8 seconds. A document edit immediately invalidates decorations from the previous fingerprint.

## CodeMirror integration

Remote collaboration state is represented with a CodeMirror StateField/DecorationSet:

- remote selections are decorations, never inserted into Markdown;
- remote carets are widgets, never part of editor history;
- decorations map through local transactions while the snapshot fingerprint remains valid;
- switching notes, switching to Reading mode, losing membership or leaving the cloud Vault clears remote cursor decorations.

## Security boundary

The Supabase migration creates two RLS policies on `realtime.messages` for the isolated `vault-collab:<vault>:<epoch>` topic:

- SELECT: active owner/editor/viewer members may receive Presence/Broadcast messages;
- INSERT: active owner/editor/viewer members may publish Presence/Broadcast messages.

Both policies additionally require:

- the topic Vault UUID to match an active cloud Vault;
- the topic epoch to match that Vault's synchronization epoch;
- membership `auth_user_id = auth.uid()`;
- `revoked_at is null`;
- the Vault is not disabled.

Presence payload identity remains client-authored/advisory. Vault never trusts Presence fields for authorization. The database membership/RLS boundary is authoritative.

Supabase caches private-channel authorization for a live connection. A membership change is therefore guaranteed to affect a newly authorized/reconnected channel; Vault also tears down its own collaboration session when its normal membership reconciliation observes revocation. Canonical sync and Storage authorization remain independently enforced even during that Realtime cache window.

## Reliability

The collaboration client follows the documented Realtime v2/Phoenix protocol directly:

- authenticated private `phx_join`;
- Presence key = per-tab session UUID;
- `presence_state` full-state replacement;
- `presence_diff` join/leave reconciliation by `phx_ref`;
- 25-second heartbeat;
- 30-second access-token refresh check;
- bounded 1/2/5/10-second reconnect delays;
- strict runtime validation of all received Presence/cursor payloads;
- malformed or wrong-topic messages are ignored.

Collaboration is best-effort. Losing the collaboration socket does not stop local editing or canonical synchronization.

## Explicit non-goals

Phase 19 does not implement:

- CRDT or OT document mutation;
- simultaneous character-level text convergence;
- shared undo/redo;
- live block operations;
- Presence as an authorization source;
- closed-app collaboration;
- durable cursor/presence history.
