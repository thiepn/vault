# Phase 21 — Acceptance Contract

## Goal

Add best-effort replication while Vault is not actively open, using browser Background Sync / Periodic Background Sync where available, without moving canonical mutation or conflict resolution into the service worker.

## Capability semantics

- Background replication is capability-detected at runtime.
- `unsupported` means the browser/installation does not expose one-shot Background Sync.
- `available` means the API exists but no durable registration is currently confirmed.
- `registered` means Vault successfully requested a Background Sync registration; it does **not** guarantee the browser will execute it at a particular time.
- Periodic Background Sync is optional and separately detected/registered.
- Browsers without these APIs continue using the Phase 16/17 foreground/realtime/polling behavior with no loss of local functionality.

## Foreground preparation

- Only signed-in owner/editor cloud Vaults are eligible.
- The foreground mirrors the current refreshable **user** session and public Supabase runtime config into worker-readable IndexedDB state.
- No service-role, secret key or elevated credential is accepted or stored.
- Dirty canonical entries are converted to the existing immutable, SHA-256-sealed protocol-v1 outbox before the worker is scheduled.
- Foreground preparation performs no network pull/push.
- A durable local save requests background preparation/scheduling without blocking the editor.

## Worker push boundary

- The service worker reads only already-sealed outbox operations.
- It validates operation identity, Vault/account/device binding and retry timing before network use.
- Attachment blobs referenced by create operations may be uploaded before the operation push.
- The worker may call the existing authenticated `vault_sync_push` RPC.
- A canonical conflict causes background replication to stop and requires foreground reconciliation.
- The worker does **not** delete or acknowledge outbox rows after a successful push.
- Foreground SyncEngine later observes the server event, records the remote shadow and acknowledges the existing sealed operation.

## Worker pull boundary

- The worker requires an already initialized foreground sync cursor for the Vault.
- It may call the existing authenticated `vault_sync_pull` RPC starting after the applied cursor plus any contiguous staged inbox events.
- Remote events are strictly validated and written only to the dedicated `remoteInbox` store.
- The worker does **not** mutate `entries`, `contents`, `attachments`, `dirty`, `remoteShadows` or `syncCursors`.
- The worker never advances the applied sync cursor.
- Foreground SyncEngine consumes staged events in sequence before its next network pull, applies normal conflict rules, advances the cursor, and removes staged inbox rows.

## Authentication and lifecycle

- The worker may refresh the same end-user Supabase session using its refresh token.
- A refreshed worker session is persisted back to the runtime record so the foreground can adopt the newer session later.
- Explicit foreground sign-out clears worker-readable runtime credentials.
- Invalid/rejected refresh credentials cause background replication to fail closed.
- Offline/network failures must not silently discard the local foreground session or canonical data.

## Status and wakeups

- Background status records track capability, last attempt/success/error, staged-event count and pushed-operation count.
- Worker completion/error messages wake the existing foreground SyncCoordinator when a Vault window is open.
- Foreground focus/online/visibility and explicit Sync remain valid fallback paths.

## Schema

- IndexedDB schema is version 5.
- `backgroundRuntime` stores worker runtime/session/status records.
- `remoteInbox` stores staged remote events and has Vault plus unique `(vaultId, sequence)` indexes.
- Existing A1/A2 canonical stores and identities remain unchanged.

## Browser acceptance

- A browser exposing mocked Background Sync/Periodic Sync capability must register `vault-background-sync` after a durable post-adoption save.
- Best-effort periodic registration uses `vault-periodic-sync`.
- The sealed outbox must exist before scheduling evidence is accepted.
- Worker-readable runtime must contain only the signed-in user session/public backend config and be cleared on sign-out.
- Cloud UI must expose the detected/scheduled background-sync status.

## Explicit non-goals

Phase 21 does not claim:

- guaranteed closed-app execution on every browser or OS;
- exact execution timing or minimum wake frequency;
- canonical note mutation inside the service worker;
- service-worker conflict resolution;
- service-worker cursor advancement/outbox acknowledgement;
- durable CRDT-room execution while the app is closed;
- replacing explicit/foreground synchronization.

## Release gate

Phase 21 may merge only when:

1. schema-v5 upgrade tests and Phase 21 core contracts pass;
2. foreground preparation is proven network-free;
3. staged inbox is consumed by foreground SyncEngine before network pull;
4. service-worker source contracts prove it cannot mutate canonical Markdown, cursor or outbox acknowledgement state;
5. browser acceptance verifies capability registration, sealed outbox preparation, worker runtime state and sign-out cleanup;
6. all Phase 1–20 tests, benchmarks and browser acceptance remain green;
7. production TypeScript/Vite build passes.
