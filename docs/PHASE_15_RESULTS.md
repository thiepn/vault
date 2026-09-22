# Phase 15 results — Remote Replication, Conflict Resolution & Attachment Sync

## Status

**Phase 15 is implemented, deployed to THIEPN Core, and browser-certified.**

Functional certification head: `64bf62faafde57c6451220449140f0de72e464a8`

Functional CI: **35748713538 / #308**

## Product boundary

Phase 15 turns Phase 14's account/device/Vault identity and local outbox/cursor foundation into real canonical content replication.

Synchronization remains local-first and explicit. Ordinary editing never requires network access, and only a user-adopted cloud Vault can run `Sync now`.

## Canonical content replicated

- stable folder/note/attachment Entry identities
- parent/name metadata
- exact Markdown content
- move/rename
- Trash/restore state
- attachment MIME/size/SHA-256 metadata
- attachment binary bytes through private content-addressed Supabase Storage

Derived knowledge/search/task/calendar/query/graph/board indexes are not synchronized.

## Replication algorithm

A Phase 15 sync run uses pull-before-push ordering:

1. validate account/Vault/epoch/device binding
2. pull ordered remote pages to the server high-water mark
3. validate and apply clean remote snapshots
4. synthesize immutable operations from local dirty entries and remote shadows
5. upload referenced attachment blobs
6. push exact sealed outbox operations
7. pull/ack their ordered server events
8. repeat synthesis/push/pull once for races created during the first pass

Outbox operations remain exact immutable wire bytes with SHA-256 identity. Successful push alone does not delete the outbox row; the operation is acknowledged after its ordered server event is observed.

## Conflict behavior

Phase 15 never silently chooses between divergent Markdown bodies.

- identical/converged state reconciles without a copy
- concurrent local/remote Markdown edits preserve the local side as a separate conflict-copy note and apply the remote version at the original stable Entry ID
- local delete racing a remote edit preserves a conflict copy and reapplies the local delete intent against the newer remote base
- historical remote events older than a newer known shadow are not replayed as new conflicts
- path conflicts fail closed and require user rename
- in-place mutation of already-synchronized attachment bytes fails closed; duplicate the attachment to preserve a new binary identity

Conflict copies deliberately use a visible `conflict` filename suffix. Automatic diff3 merging is not part of Phase 15.

## Attachment replication

Attachment JSON operations carry only SHA-256, MIME type and size.

The browser uploads immutable bytes first to:

`vault-sync/<auth-user-id>/<vault-id>/<sha256>`

The remote create RPC verifies that the object exists. Downloads on another device are SHA-256/size verified before local commit.

The browser treats an existing content-addressed upload as successful only after downloading and verifying the existing object.

## Cross-device reconstruction

The Cloud panel can add a remote adopted Vault to a browser that has no local copy.

Starting from cursor zero, the device reconstructs folders/notes/attachments from ordered remote events and downloads required attachment blobs. Stable Vault and Entry UUIDs are preserved.

Browser acceptance verifies this using a second isolated browser context.

## Deployed Supabase backend

THIEPN Core contains Phase 15 migrations:

- `20260922150204 vault_phase15_remote_replication`
- `20260922150354 vault_phase15_remote_replication_hardening`

Remote state:

- `public.vault_sync_entries`
- `public.vault_sync_operations`
- `public.vault_sync_events`
- `public.vault_sync_counters`
- private Storage bucket `vault-sync`

RPC API:

- `public.vault_sync_pull(uuid, uuid, text, integer)`
- `public.vault_sync_push(jsonb, text)`

Direct authenticated/anonymous access to replication tables is revoked/denied. RPC execution is false for `anon` and `public`, true only for `authenticated`.

The two RPCs are intentionally SECURITY DEFINER with empty `search_path` and internal `auth.uid()`/account/Vault/epoch/device checks. Supabase's generic security advisor therefore reports that authenticated users may execute these functions; this is the intended authenticated API boundary, not direct table access.

Storage object policies require:

- private bucket `vault-sync`
- authenticated role
- first object-path segment equal to `auth.uid()`
- second path segment an enabled cloud Vault owned by that user

## Cloud UI

The Cloud panel now exposes an explicit `Sync now` control and displays:

- remote cursor
- pulled event count
- pushed operation count
- preserved conflict count
- blob upload/download counts
- queued operation count
- remote Vaults that can be added to this device

Signing in still does not automatically adopt or upload a local Vault.

## Certification

CI **35748713538 / #308** passed:

- **114 / 114 core tests**
- search benchmark
- graph benchmark
- board benchmark
- maximum-size Canvas benchmark
- Obsidian migration benchmark
- Phase 14 sync-foundation benchmark
- Phase 15 remote-replication benchmark
- production TypeScript/Vite build
- **33 / 33 applicable Chromium desktop/mobile scenarios**
- **33** opposite-project scenarios skipped by design
- **0 failures**

### Replication benchmark

- **10,000 remote events**
- **10 pages**
- page validation: **21.6 ms**

Phase 14 protocol benchmark in the same run:

- 10,000 operation envelopes validated: **33.7 ms**
- 10,000 ordered events validated: **6.7 ms**
- 1,000 operation envelopes SHA-sealed: **33.9 ms**

Same-run snapshots:

- graph build: **146.8 ms**
- graph filter: **6.6 ms**
- local graph traversal: **6.6 ms**
- graph grouping: **2.3 ms**
- board projection: **66.9 ms**
- maximum Canvas parse: **208.6 ms**
- maximum Canvas serialize: **73.5 ms**
- 10k Obsidian migration planning: **243.8 ms**

## Explicit non-goals

Phase 15 does not implement:

- continuous/background sync scheduling
- realtime push notifications
- automatic diff3 text merging
- collaborative multi-cursor editing
- end-to-end encryption
- server-side execution of derived Vault views

Those are separate later concerns; Phase 15 certifies explicit remote canonical replication and conservative conflict preservation.