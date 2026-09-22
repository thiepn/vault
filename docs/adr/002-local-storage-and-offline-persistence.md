# ADR-002 — IndexedDB + content-addressed BlobStore for local persistence

**Status:** Accepted  
**Date:** 2026-09-22

## Context

Vault requires a durable local-first browser architecture that:

- works offline
- supports exact Markdown
- preserves stable identities across rename/move
- supports structured entities
- stores binary attachments efficiently
- remains portable
- survives multi-tab use
- does not depend on a commercial backend
- can later synchronize to a remote server

Phase 1–12 already had a functioning IndexedDB persistence layer.

Alternatives considered included:

- replacing the entire local store with SQLite/WASM
- treating OPFS files as the primary Note database
- keeping all binaries directly in the same legacy IndexedDB attachment records
- adopting IndexedDB incrementally and placing binary payloads behind a replaceable BlobStore

## Decision

Vault keeps IndexedDB as the primary transactional local database.

Schema v4 adds canonical persistence stores while preserving the working legacy stores during migration.

Large/binary payloads use a content-addressed BlobStore:

- OPFS preferred
- IndexedDB fallback

Notes remain exact Markdown strings in transactional storage rather than authoritative OPFS filesystem paths.

Task identity is embedded in readable Markdown using hidden stable identifiers and reconciled to structured Task entities.

Cache Storage is restricted to the PWA application shell.

## Why not SQLite/WASM

SQLite is technically viable, but no measured Vault requirement currently justifies:

- another database runtime
- WASM loading
- VFS selection
- worker coordination
- a destructive migration from already-working IndexedDB

SQLite can be reconsidered if benchmark evidence shows IndexedDB prevents required scale or query performance.

## Why not OPFS as the Note filesystem

A physical filename/path must not become identity.

Using OPFS paths as the database would weaken:

- transaction semantics across related entities
- rename/move identity
- structured querying
- future synchronization
- migration safety

OPFS is therefore used for what it is best suited to here: binary payload bytes.

## Consequences

### Positive

- builds on certified existing persistence
- preserves all existing IDs
- maintains offline behavior
- supports content-addressed attachment integrity
- keeps OPFS replaceable
- keeps human-readable Markdown
- allows future remote backends to use a different physical schema
- supports incremental migration rather than a flag-day rewrite

### Costs

- legacy and canonical stores coexist temporarily
- A2LocalRepository must mirror state
- migration/repair logic is required
- attachment data may temporarily exist in both legacy and content-addressed forms
- consistency certification is more important during the transition

## Safety requirements

- canonical mirror failures mark repair-needed
- legacy data is not deleted as part of A2 adoption
- stale writes preserve drafts
- task IDs remain globally unique
- full archive restore validates before committing
- restore refuses existing identity collisions
- derived data can always be rebuilt

## Implementation

See:

- `docs/A2_STORAGE_ARCHITECTURE.md`
- `src/storage/a2-persistence.ts`
- `src/storage/blob-store.ts`
- `src/services/a2-archive.ts`

Any future change that makes a filename/path the canonical identity or makes Cache Storage the only home of user data violates this ADR.
