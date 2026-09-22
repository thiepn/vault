# Phase 18 — Implementation Results

## Delivered

- Added server-authoritative `owner`, `editor` and `viewer` memberships for cloud Vaults.
- Added expiring one-time share invitations whose raw secret is returned once and whose SHA-256 hash is stored server-side.
- Added owner member management for role changes and revocation.
- Preserved protocol v1, Vault UUIDs, epochs, ordered event history, conflict behavior and owner-scoped attachment paths.
- Added collaborator actor/account provenance without re-owning canonical sync rows.
- Made viewer synchronization pull-only and made revoked memberships non-readable to sync.
- Added repository-level write guards plus read-only UI behavior across Markdown editing, files, tasks, properties, query task controls, Kanban and Canvas.
- Added role reconciliation so an already-open editor transitions safely when server membership changes.
- Kept each local cloud replica bound to one authenticated account identity so existing actor-bound cursors, shadows and outbox invariants cannot be silently crossed.

## Backend migration

`backend/supabase/phase18_shared_vaults.sql` was applied to the THIEPN Core Supabase project.

The migration adds:

- `vault_memberships` and owner-membership backfill/creation guards;
- `vault_share_invites` with direct-table access denied;
- authenticated RPCs for accessible Vaults, member listing, invite creation/acceptance and role changes;
- membership-aware `vault_sync_pull`;
- owner/editor-only `vault_sync_push`;
- member-aware Storage reads and owner/editor Storage writes;
- member-aware Realtime wakeup reads;
- separate actor provenance columns for entries, operations and events.

A follow-up hardening migration added the membership foreign-key index and an explicit deny policy for direct invitation-table access.

## Security review

Supabase advisors were rerun after hardening.

- No Phase 18 `rls_enabled_no_policy` finding remains.
- No Phase 18 unindexed foreign-key finding remains.
- Remaining `SECURITY DEFINER` warnings are intentional authenticated RPC boundaries. Each exposed Phase 18 RPC uses explicit `auth.uid()` authorization, an empty `search_path`, and revoked `PUBLIC`/`anon` execution; execution is granted only to `authenticated`.
- Remaining RLS-without-policy findings are unrelated pre-existing `core.apps` and `core.protocol_versions` tables.
- Unused-index notices are informational on the new/empty sync-sharing tables and are not a release blocker.

## Automated coverage

`tests/phase18.test.mjs` verifies:

- legacy binding compatibility;
- viewer local write rejection;
- promotion to editor restores canonical writes;
- viewer pull-only synchronization;
- refusal to rebind one local replica across authenticated accounts;
- shared-Vault registry/RPC mapping and owner identity preservation;
- SQL invariants for membership roles, owner-scoped blob paths, Realtime membership policy and actor provenance.

The repository CI remains the release authority for the full Phase 1–18 contract: core tests, all established performance gates, production build, and Chromium desktop/mobile acceptance. Phase 18 merges only from a green final-head PR check.

## Non-goals retained

- no CRDT/OT engine;
- no cursor/presence system;
- no simultaneous character-level co-editing;
- no guaranteed closed-app replication;
- no public/anonymous share links;
- no owner-transfer workflow.
