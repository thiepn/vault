# Phase 21 — Best-Effort Closed-App Replication & Background Sync

Phase 21 extends Vault's local-first replication architecture into the service worker **only as a transport/staging layer**.

## Data flow

```text
foreground local save
      │
      ▼
SyncEngine.prepareBackground()
      │ seals existing protocol-v1 operations
      ▼
immutable outbox ────────► service worker
                              │
                              ├─ upload referenced attachment blobs
                              ├─ call vault_sync_push
                              └─ call vault_sync_pull
                                          │
                                          ▼
                                      remoteInbox
                                          │
app opens / foreground sync               │
      └───────────────────────────────────┘
                    ▼
        normal SyncEngine apply/conflict path
                    │
                    ├─ remote shadow
                    ├─ sync cursor advance
                    └─ outbox acknowledgement
```

The service worker therefore cannot become a second canonical sync engine.

## Why successful pushes stay in the outbox

A successful worker push proves only that the server accepted the operation. Vault still needs its normal ordered remote event to establish the authoritative remote snapshot/revision. Deleting the outbox row in the worker would lose the foreground correlation needed to recognize that event as its own operation.

Therefore the worker leaves the sealed outbox row intact. It also skips re-pushing an operation when its operation ID already appears among staged remote events.

## Why pulls are staged instead of applied

Applying remote events can require:

- local dirty-state inspection;
- three-way Markdown auto-merge;
- conflict-copy creation;
- attachment integrity/download handling;
- local projection/index refresh;
- cursor advancement and exact sequence accounting.

Those remain foreground SyncEngine responsibilities. The worker only validates event sequencing and stores immutable event envelopes in `remoteInbox`.

## Cursor model

`syncCursors.cursor` always means **foreground-applied canonical history**.

The worker calculates a temporary staged cursor by walking contiguous `remoteInbox` sequences after that applied cursor. It may fetch beyond the applied cursor using this temporary value, but it never persists the cursor itself.

This keeps foreground replay deterministic after the browser wakes.

## Authentication

The foreground mirrors the same user access/refresh token pair already owned by the origin into `backgroundRuntime`. No service-role key is present. If the access token is near expiry, the service worker can use the normal Supabase `refresh_token` flow with the public publishable key and write the newer end-user session back for foreground adoption.

Explicit sign-out removes the runtime record.

## Scheduling

`BackgroundReplicationBridge` uses:

- one-shot tag `vault-background-sync`;
- optional periodic tag `vault-periodic-sync` with a 12-hour minimum interval request.

Both are browser hints. Browsers decide whether and when they execute them. Vault continues to work correctly when either API is absent, denied or delayed.

## Schema v5

Two stores are added:

- `backgroundRuntime` — runtime/session/status records;
- `remoteInbox` — validated staged remote events keyed by `<vaultId>:<sequence>`.

No canonical A1/A2 identity changes are introduced.
