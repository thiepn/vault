# Phase 17 — Realtime Sync Wakeups & Connection Resilience

Phase 17 adds low-latency server push without replacing Vault's existing local-first replication protocol.

## Architecture

A committed row in `vault_sync_events` emits a small private Supabase Realtime Broadcast:

```text
canonical mutation
      ↓
vault_sync_push RPC
      ↓
ordered vault_sync_events row
      ├─→ normal pull cursor/history
      └─→ private realtime wake signal
                  ↓
        active browser/PWA
                  ↓
        SyncCoordinator.wake('realtime')
                  ↓
        normal pull → merge → push
```

Realtime is therefore an acceleration layer, not a second source of truth.

## Security

- Channel topics are `vault:<vault-id>:<epoch>`.
- Channels are joined as private authenticated channels.
- Realtime RLS only allows an authenticated user to receive Broadcast messages for a Vault whose `auth_user_id` matches `auth.uid()` and whose epoch matches the topic.
- Browsers receive only Vault/event identity metadata: sequence, operation ID, entry ID, revision and device ID.
- Markdown text, attachment bytes and paths are never broadcast through Realtime.
- Clients cannot publish Vault sync broadcasts; the browser receives only database-originated wakeups.
- The existing sync RPC boundary remains default-deny for direct table access.

## Browser behavior

The browser uses the documented Supabase Realtime/Phoenix protocol directly:

- authenticated private channel join
- protocol v2 frames
- 25-second heartbeat
- access-token refresh in-band
- bounded reconnect delays
- strict topic/event/payload validation
- stale-socket generation guards

A received wakeup merely asks the Phase 16 `SyncCoordinator` to run. Existing Web Locks and single-flight behavior prevent wake storms from creating concurrent sync runs.

## Fallbacks

Realtime is best-effort. If the socket is unavailable, Vault still synchronizes through:

- 30-second Phase 16 checks
- reconnect wakeups
- focus/visibility wakeups
- local-save wakeups
- cross-tab invalidation
- manual **Sync now**

No canonical correctness property depends on Realtime delivery.

## Non-goals

Phase 17 does not implement:

- multi-user shared Vault permissions
- live co-editing/CRDTs
- cursor or typing presence
- guaranteed sync after the browser/PWA is fully terminated
- note contents over WebSockets
