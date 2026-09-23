# Phase 21 — Implementation Results

## Delivered

- IndexedDB schema v5 with `backgroundRuntime` and `remoteInbox` stores.
- BackgroundReplicationState contracts for runtime, status and staged event records.
- Foreground preparation that seals dirty entries into the existing protocol-v1 outbox without network I/O.
- BackgroundReplicationBridge capability detection, one-shot registration and optional periodic registration.
- Mirroring/adoption of refreshable end-user auth sessions between foreground and worker runtime state.
- Service-worker attachment upload plus authenticated sealed-operation push.
- Service-worker remote pull with strict sequential validation into `remoteInbox` only.
- Foreground SyncEngine consumption of staged worker events before normal network pull.
- Worker completion/error messages that wake foreground SyncCoordinator.
- Background scheduling after durable local saves plus online/visibility lifecycle hints.
- Explicit sign-out cleanup of worker-readable auth runtime.

## Safety boundary

The service worker does not write canonical Markdown/content stores, does not advance sync cursors, does not delete/acknowledge outbox rows, and does not resolve conflicts. Those remain foreground SyncEngine responsibilities.

Successful worker push acknowledgements are intentionally not treated as durable local acknowledgement. The foreground later consumes the corresponding ordered server event and performs the normal remote-shadow/cursor/outbox transition.

## Browser semantics

Background Sync and Periodic Background Sync are feature-detected, best-effort browser capabilities. Phase 21 does not claim guaranteed closed-app execution, timing, or cross-browser availability.

## Automated coverage

`tests/phase21.test.mjs` covers:

- network-free foreground outbox preparation;
- foreground consumption of staged worker events before network pull;
- worker runtime/status storage;
- schema-v5 worker stores;
- service-worker source safety invariants.

`tests/e2e/phase21.spec.ts` covers the foreground browser contract:

- mocked Background Sync and Periodic Sync capability;
- post-adoption durable save scheduling;
- sealed outbox creation;
- worker-readable signed-in user runtime;
- background status surfacing;
- sign-out removal of worker auth runtime.

## Compatibility

- Sync protocol remains version 1.
- Phase 20 live CRDT editing remains foreground/session-scoped.
- Phase 19 Presence and Phase 17 Realtime wakeups remain independent accelerators.
- Phase 18 membership roles remain authoritative for write eligibility.
- Unsupported browsers continue using existing foreground/realtime/polling synchronization.
