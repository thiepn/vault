# Phase 18 — Shared Vaults, Membership & Permission Architecture

## Goal

Allow an explicitly cloud-enabled Vault to be shared with other authenticated Vault accounts while preserving the existing local-first, protocol-v1 replication architecture.

## Acceptance criteria

### Ownership and membership

- Every cloud Vault retains exactly one canonical owner.
- Existing cloud Vaults migrate to an active owner membership without changing Vault UUID, epoch, event history or blob paths.
- Owners can issue one-time invitations for either `editor` or `viewer`.
- Invitations expire, can be accepted only once, and store only a SHA-256 token hash server-side.
- Owners can change an editor to viewer, a viewer to editor, or revoke a non-owner member.
- The canonical owner cannot be demoted or revoked through membership APIs.

### Authorization

- Owner and editor memberships may pull and push canonical sync operations.
- Viewer memberships may pull but cannot push.
- Revoked/non-member accounts cannot pull or push.
- Every write still requires an active DeviceId owned by the authenticated actor.
- Storage reads follow active membership; Storage inserts require owner/editor.
- Realtime wakeups follow active membership and remain non-authoritative metadata only.
- Direct access to invitation rows is denied; invitation workflows occur only through authenticated RPCs.

### Local behavior

- Cloud bindings distinguish the current actor identity from the stable Vault owner identity.
- Legacy Phase 14–17 bindings without a role remain owner-compatible.
- Server role changes reconcile into the local binding.
- Viewer replicas expose a read-only editor and disable mutation affordances for files, tasks, properties, query-task controls, Kanban and Canvas.
- Repository-level mutation guards reject writes even if a UI path fails to disable itself.
- Viewer synchronization with no pending writes is pull-only.
- A viewer replica containing pre-existing dirty/outbox state fails closed rather than dropping or publishing those changes.
- Revocation preserves already-downloaded local data.

### Canonical data and compatibility

- Protocol version remains 1.
- The existing ordered event log, remote shadows, conflict-copy behavior and three-way Markdown merge remain authoritative.
- Canonical event/entry/blob ownership stays under the original owner namespace.
- Collaborator actor/account identity is recorded separately from canonical ownership for provenance.
- Sharing does not create a second note/task/query database.
- Existing Phase 1–17 core behavior, benchmarks, production build and Chromium desktop/mobile acceptance remain green.

### Explicit non-goals

Phase 18 does not implement:

- CRDT or OT collaboration;
- cursor/presence indicators;
- simultaneous character-level co-editing;
- guaranteed sync while the browser/PWA is terminated;
- owner transfer;
- public/anonymous share links.

## Release gate

Phase 18 may merge only after:

1. the Supabase migration is applied successfully to THIEPN Core;
2. security/performance advisors are reviewed and Phase 18-introduced actionable issues are fixed;
3. Phase 18 permission tests pass;
4. the complete pre-existing core suite passes;
5. all existing performance gates pass;
6. the production TypeScript/Vite build passes;
7. Chromium desktop/mobile acceptance passes.
