# Phase 15 acceptance — Remote Replication, Conflict Resolution & Attachment Sync

## Result

**ACCEPTED — canonical remote replication, conservative conflict preservation and cross-device attachment synchronization are certified.**

## Acceptance criteria

- local editing works with no network
- only explicitly adopted cloud Vaults can synchronize
- sync binding is account/Vault/epoch/device checked
- pull occurs before local push synthesis
- pull pages are runtime validated before application
- remote event sequence must be gap-free and monotonic
- remote snapshots are Vault/Entry/revision validated
- local cursor advances only after event application
- local dirty state synthesizes deterministic operations against the last remote shadow
- outbox operations keep immutable exact wire bytes and SHA-256
- retries reuse operation identity/bytes
- successful pushes remain queued until ordered server events are pulled
- clean remote Markdown changes apply canonically
- same-state convergence does not create a conflict
- concurrent Markdown edits preserve a conflict copy
- local-delete/remote-edit races preserve both user intent and remote content
- duplicate/historical events do not duplicate conflict copies
- remote path collisions fail closed
- local attachment blob uploads before remote attachment create
- remote attachment metadata is hash/size validated
- downloaded attachment bytes are hash/size validated
- content-addressed blob upload retry is idempotent
- a second device can reconstruct a remote Vault from cursor zero
- stable Vault/Entry IDs survive cross-device reconstruction
- remote attachment bytes arrive on the second device
- remote shadows are owner/epoch bound
- pending outbox operations are owner bound
- live replication tables deny direct authenticated table access
- live pull/push RPCs are authenticated-only
- RPCs verify auth/account/Vault/epoch/device state
- private Storage policies scope blobs to user + Vault
- desktop Sync-now workflow passes
- mobile Sync-now workflow passes
- all Phase 1–14/A2 browser regressions pass
- all core/performance/build gates pass

## Certification

Functional CI: **35748713538 / #308**

- **114 core tests passed**
- **33 applicable Chromium scenarios passed**
- **33 opposite-device scenarios skipped by design**
- **0 failures**

Remote page benchmark: **10,000 events across 10 pages in 21.6 ms**.

## Conflict policy

Phase 15 intentionally prefers visible preservation over speculative automatic merging.

Concurrent divergent Markdown creates a conflict copy rather than silently merging or discarding either side. Path conflicts require explicit user intervention. Already-synchronized attachment byte changes require a new/duplicated attachment identity.

## Backend security note

Supabase's advisor reports a warning because `vault_sync_pull` and `vault_sync_push` are intentionally SECURITY DEFINER functions executable by `authenticated`.

The deployed functions are the deliberate narrow client API: execution is revoked from `public` and `anon`, granted to `authenticated`, `search_path` is empty, and every request validates `auth.uid()`, account mapping, Vault ownership/epoch/protocol and authorized device state. Direct synchronization tables remain unavailable to authenticated browser clients.

## Deliberate non-goals

Phase 15 does not claim continuous background synchronization, realtime collaborative editing, automatic diff3, or end-to-end encryption.