# Phase 16 — Continuous/Background Sync, Advanced Conflict Resolution & Sync Hardening

Phase 16 hardens the Phase 14–15 cloud architecture without changing Vault's local-first ownership model.

## Guarantees

- Editing remains local-first. Network availability never becomes a precondition for local saves.
- Only explicitly cloud-adopted Vaults synchronize.
- Sync runs are single-flight per account/Vault/epoch in one workspace.
- Web Locks are used when available so multiple open tabs do not duplicate the same replication loop.
- Scheduled requests are coalesced instead of spawning overlapping pull/push passes.
- Retry uses bounded exponential backoff with jitter.
- Manual **Sync now** remains available even though adopted Vaults now synchronize opportunistically.

## Continuous sync triggers

While Vault is open, adopted Vaults are woken by:

- startup/session restoration
- local saves
- periodic 30-second checks
- browser reconnect
- window focus
- visibility changes
- local mutations observed from another tab

Background browser execution is best-effort: browsers may throttle or suspend timers, especially after the PWA is fully closed. Phase 16 therefore does not claim server-push real-time delivery or guaranteed closed-app service-worker replication.

## Markdown three-way merge

The last verified remote shadow is the merge base.

For a concurrent Markdown edit:

1. compare the last remote base, current local Markdown and incoming remote Markdown;
2. if one side is unchanged, accept the other side;
3. if both sides changed distinct non-overlapping line regions, merge them automatically;
4. apply the remote snapshot as the new synchronization base;
5. save the merged Markdown locally and push it through the normal immutable outbox;
6. if the edits overlap or structural state is also changing locally, preserve the existing conflict-copy behavior.

Vault does not write Git-style conflict markers into canonical Markdown automatically.

## Structural conflicts

Rename/move/delete/path conflicts remain conservative. Phase 16 does not infer user intent when two devices race on structure. Existing conflict-copy and collision handling remains authoritative.

## Hardening

- SyncEngine returns the current in-flight run for overlapping direct calls targeting the same account/Vault/epoch.
- Coordinator wakeups remain pending while the editor has unsaved/focused work, preventing background refresh from disrupting active typing.
- Remote changes refresh the visible workspace only when a background run actually pulled or materialized remote state.
- Successful zero-queue runs can report the selected note as synced.
- Phase 16 adds integration tests for automatic merge/convergence, conflict fallback and scheduler single-flight behavior.
- A large-Markdown merge benchmark is part of CI.

## Non-goals

- CRDT collaborative editing
- server-push/WebSocket real-time presence
- semantic/block-aware interactive merge UI
- guaranteed replication after the browser/PWA has been fully terminated
