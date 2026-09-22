# Phase A2 Acceptance — Local Storage, Serialization & Offline Persistence

## Status

**IMPLEMENTED — acceptance architecture and regression coverage are in place.**

The Phase 12 baseline commit `79a852b49f8476b3e985b055c167f21981ad827b` already contained the core A2 persistence foundation and was certified at that point with **87/87 core tests**, the search/graph/board/Canvas benchmarks, production build, and the then-current Chromium desktop/mobile suite.

The subsequent A2 hardening commits add restore, collision repair, cross-tab invalidation and additional tests. The GitHub connector available in this session does not expose a completed push-workflow status/check for the current head, so this document does **not** claim a fresh CI pass for those newer commits.

## Acceptance requirements

### Database and identity

- [x] IndexedDB remains the transactional local database.
- [x] Schema v4 adds canonical `entities`, `noteBodies`, `blobPayloads`, and `migrationState`.
- [x] Existing Phase 1–12 IDs survive migration unchanged.
- [x] Paths/titles/filenames remain mutable and are never identity.
- [x] Canonical migration is additive rather than destructive.

### Notes and Markdown

- [x] Exact Markdown remains durable authored Note content.
- [x] Note body storage is split from canonical Note headers.
- [x] YAML/frontmatter remains human-readable authored metadata.
- [x] Stale writes remain version-checked.
- [x] Failed/stale edits remain recoverable through drafts/revisions.

### Tasks

- [x] Embedded tasks remain readable Markdown checkboxes.
- [x] Embedded tasks receive stable hidden UUID identities.
- [x] Task edits preserve identity.
- [x] Recurring next occurrences receive new identities.
- [x] Note/folder duplication rekeys copied task identities.
- [x] Recovery into a new Note rekeys copied task identities.
- [x] Cross-note pasted duplicate task identities are rekeyed.
- [x] Migration v2 repairs historical task-ID collisions, including Trash.
- [x] Structured Task entities are reconciled from identified Markdown.

### Attachments

- [x] Attachment metadata and binary payload identity are separate.
- [x] Binary payloads are SHA-256 content-addressed.
- [x] OPFS is preferred when available.
- [x] IndexedDB provides a supported fallback.
- [x] Canonical attachment reads verify size/hash integrity.
- [x] Legacy attachment bytes remain a compatibility/recovery path during migration.

### Multi-tab behavior

- [x] Web Locks coordinate migration-class work.
- [x] BroadcastChannel distributes committed invalidations.
- [x] Broadcast messages include a per-session source identity.
- [x] A tab ignores its own invalidations.
- [x] Unsaved editor state is never overwritten by another tab's invalidation.

### Browser durability and offline operation

- [x] Persistent storage can be requested after Vault adoption.
- [x] Usage/quota/persistence health can be inspected.
- [x] Cache Storage is limited to the application shell.
- [x] Service Worker supports cold offline PWA startup.
- [x] Canonical user data remains outside Cache Storage.

### Export and restore

- [x] Interoperable Markdown ZIP remains available.
- [x] Full Vault Archive is distinct from Markdown export.
- [x] Archive v2 preserves stable IDs.
- [x] Archive v2 preserves exact Markdown.
- [x] Archive v2 preserves Trash state.
- [x] Archive v2 preserves revisions and recovery drafts.
- [x] Deleted attachment payloads are retained in the archive.
- [x] Archive files have SHA-256 checksums.
- [x] ZIP reader validates paths, UTF-8, CRC and STORE-only structure.
- [x] Restore validates canonical and compatibility-state consistency before committing.
- [x] Restore rejects Vault/entity identity collisions instead of overwriting.
- [x] Restore writes database state atomically after blob validation.
- [x] Restored entries preserve Task and Note identity.
- [x] Browser acceptance coverage restores a downloaded archive into a fresh profile.

### Corruption safety

- [x] Restore rejects duplicate Entry identities.
- [x] Restore rejects cross-vault Entries/entities.
- [x] Restore validates folder ancestry/cycles.
- [x] Restore rejects revision-mismatched Markdown.
- [x] Restore validates revision and recovery-draft ownership.
- [x] Restore validates attachment size and SHA-256.
- [x] Restore requires exactly one canonical Vault entity.
- [x] Restore requires canonical Note bodies with matching revisions.
- [x] Derived state remains rebuildable rather than restore-critical.

## Regression suite

The normal `npm test` command includes:

- Phase 1–12 core tests
- A1 domain tests
- A2 storage tests

The Playwright suite includes A2 browser tests for:

- stable Task identity across reload/duplication
- cold offline startup
- full Vault archive restore into a fresh browser context

## Release boundary

A2 deliberately does **not** implement:

- user accounts
- remote/cloud persistence
- cross-device synchronization
- remote encryption/key management
- server conflict resolution
- external Markdown/Obsidian import

Those belong to later architecture phases.

## Next

**A3 — Backend & Deployment Architecture**
