# Vault — A2 Local Storage, Serialization & Offline Persistence

**Status:** Implemented  
**Database schema:** 4  
**Migration generation:** `a2-canonical-shadow-v2`  
**Depends on:** A0, A1

## Purpose

A2 makes the A1 domain durable on a browser device without replacing the working Phase 1–12 Markdown product.

The implementation deliberately uses an additive migration:

```text
existing Phase 1–12 stores
          +
A1 canonical persistence stores
          +
content-addressed blob layer
```

Existing user IDs are never regenerated merely because storage architecture changed.

## Physical architecture

```text
UI / CodeMirror
      ↓
SaveCoordinator + domain commands
      ↓
A2LocalRepository
      │
      ├── IndexedDB schema v4
      │     ├── legacy compatibility stores
      │     ├── entities
      │     ├── noteBodies
      │     ├── blobPayloads
      │     └── migrationState
      │
      └── BlobStore
            ├── OPFS preferred
            └── IndexedDB fallback

Service Worker + Cache Storage
      └── application shell only
```

## IndexedDB

IndexedDB remains the transactional database.

Vault does not introduce SQLite/WASM in A2. The existing IndexedDB repository already provides the capabilities required by the product, and replacing it would add a second database runtime, worker/VFS complexity and another migration without demonstrated need.

Schema v4 adds:

- `entities`
- `noteBodies`
- `blobPayloads`
- `migrationState`

The Phase 1–12 stores remain available during the compatibility period.

## Canonical entity mirror

`entities` stores the structured A1 representation for persistent entity types currently materialized by the application.

Existing Entry UUIDs are reused for Notes, Folders and Attachments.

A path, filename or title never becomes canonical identity.

`A2LocalRepository` mirrors successful compatibility-store writes into the canonical stores. A mirror failure marks A2 as repair-needed instead of pretending that the canonical migration succeeded.

## Note bodies

Note metadata and bodies are split.

`entities` contains the Note header while `noteBodies` contains exact Markdown text keyed by stable Note ID.

The original `contents` store remains during the compatibility migration.

No automatic whitespace, line-ending or YAML normalization is performed merely because A2 is active.

## Tasks

Embedded tasks remain readable Markdown:

```markdown
- [ ] Prepare report @due(2026-09-25) <!-- vault:task=019c... -->
```

The HTML comment is invisible in rendered Markdown but preserves Task identity through edits, exports and imports.

A2 behavior:

- new Markdown tasks receive UUIDv7 IDs
- task text/date/status edits preserve identity
- recurring completion preserves the completed Task ID and creates a fresh ID for the next occurrence
- duplicated notes/folders rekey copied Task IDs
- recovered drafts rekey Task IDs because they become new Notes
- pasted IDs already owned by another Note are rekeyed
- migration v2 repairs historical duplicate IDs across the entire Vault, including Trash
- structured `TaskEntity` records are reconciled from the identified Markdown source

Task IDs are globally unique across canonical entities.

## Attachments

Attachment metadata and bytes are separated.

```text
AttachmentEntity
      ↓
checksumSha256
      ↓
BlobStore
```

Blob keys are SHA-256 hashes rather than filenames.

This means:

- rename does not move binary identity
- identical payloads can share storage
- corruption can be detected
- historical revisions can eventually reference old payloads safely

## OPFS and fallback

`OpfsBlobStore` is preferred when OPFS is available.

`IndexedDbBlobStore` is the supported fallback.

`HybridBlobStore` attempts OPFS first and falls back safely when browser capability or an OPFS write fails.

Application features depend on the BlobStore abstraction rather than directly depending on OPFS.

## Attachment migration safety

Legacy attachment bytes remain available while canonical blobs are being adopted.

Canonical reads prefer the verified content-addressed blob. If it is unavailable, compatibility data remains a recovery path.

Metadata must never be considered sufficient if the binary payload is missing or fails integrity validation.

## Revisions and recovery

Existing version-checked writes remain authoritative during the compatibility period.

A stale editor cannot silently overwrite a newer revision.

Recovery drafts continue preserving:

- stale edits
- edits to deleted notes
- invalid/corrupt save attempts
- editor recovery state

A2 task-ID migration creates a revision checkpoint before changing Markdown.

## Multi-tab coordination

A2 uses two mechanisms with different responsibilities.

### Web Locks

Long exclusive operations such as migration use Web Locks where available.

Normal typing does not globally lock the Vault.

### BroadcastChannel

Committed A2 changes publish lightweight invalidation messages.

Messages carry a storage-session ID so a tab ignores its own broadcasts.

Another tab:

- reloads durable state when safe
- never overwrites an unsaved active editor
- surfaces a reconciliation warning when local unsaved text exists

BroadcastChannel is notification only. It is never the source of truth.

## Browser persistence and quota

Vault requests persistent storage after a Vault exists or has been restored.

The Storage API is used to inspect:

- persisted status
- approximate usage
- approximate quota
- usage ratio

Persistent browser storage reduces automatic eviction risk but is not a backup.

## Offline PWA shell

The service worker caches the application shell.

Cache Storage contains:

- HTML shell
- built JS/CSS
- manifest
- icon/static resources

It does **not** contain canonical Vault user data.

After one successful online load, the installed PWA can cold-start offline and open IndexedDB/BlobStore data.

## Full Vault archive

Vault has two intentionally different export paths.

### Markdown ZIP

Optimized for interoperability.

### Full Vault archive

Optimized for lossless Vault recovery.

Archive version 2 includes:

- readable active Vault files
- stable entry identities
- canonical entities
- canonical note bodies
- exact compatibility Entry/Markdown state
- Trash state
- revisions
- recovery drafts
- attachment restore metadata
- hidden payloads for deleted attachments
- SHA-256 checksums

The archive uses the strict ZIP STORE subset produced by Vault.

The restore reader verifies:

- ZIP structure
- safe paths
- UTF-8 filenames
- CRC32
- metadata checksums
- archive version
- Entry identity consistency
- Markdown presence
- attachment presence and sizes
- canonical attachment SHA-256 checksums
- duplicate canonical IDs

## Restore semantics

Full archive restore is deliberately conservative.

Restore:

1. validates the complete archive before writing canonical data
2. refuses an existing Vault-ID collision
3. writes content-addressed blobs
4. performs the database restore in one IndexedDB transaction
5. preserves original Vault/Entry/Task IDs
6. restores Trash, revisions and recovery drafts
7. marks restored Entries as local changes for future synchronization
8. rebuilds derived state after reopening

It does not silently overwrite an existing Vault.

## Migration framework

A2 migration status lives in `migrationState`.

Current generation:

```text
a2-canonical-shadow-v2
```

States:

- running
- complete
- repair-needed

Migration is restart-safe at the architectural level because legacy state is not deleted before canonical state is created.

Generation v2 specifically repairs global Task-ID collisions introduced by copied/pasted identified Markdown.

## Derived data

The following remain disposable/rebuildable:

- knowledge index
- search index
- backlink projections
- graph layouts
- query rows
- Kanban cards/lanes
- Canvas runtime DOM
- semantic embeddings when introduced

A2 does not migrate derived indexes as canonical knowledge.

## Scale behavior

Startup does not need to hydrate every Markdown body into application memory.

Metadata/indexes and active content can be loaded independently.

Existing 10k search, graph, board and Canvas benchmark infrastructure remains the performance baseline; future storage endurance tests may raise these datasets further.

## Failure rules

A2 follows preservation-first failure handling.

- failed canonical mirroring marks repair-needed
- stale writes preserve drafts
- corrupt derived indexes are rebuilt
- missing blobs do not cause metadata to be silently deleted
- restore validates before committing
- blob writes may orphan a harmless content-addressed payload if a later DB restore fails
- canonical user content is never automatically purged to recover quota

## Compatibility boundary

A2 is intentionally additive.

The legacy stores are not deleted in this phase because Phase 1–12 features are already browser-certified against them.

A later architecture phase may perform a cut-over only after:

- equivalent canonical repository coverage exists
- migrations are proven
- restore is proven
- sync requirements are known

## Implemented files

Core A2 implementation includes:

- `src/storage/database.ts`
- `src/storage/a2-persistence.ts`
- `src/storage/blob-store.ts`
- `src/storage/coordination.ts`
- `src/storage/storage-health.ts`
- `src/tasks/markdown.ts`
- `src/services/a2-archive.ts`
- `src/services/export.ts`
- `public/sw.js`
- `public/manifest.webmanifest`
- `tests/a2-storage.test.mjs`
- `tests/e2e/a2.spec.ts`

## Frozen A2 decisions

1. IndexedDB remains the primary transactional local database.
2. SQLite/WASM is not adopted without benchmark evidence.
3. OPFS is the preferred blob backend, not the Note filesystem.
4. IndexedDB is the supported blob fallback.
5. Cache Storage never owns user knowledge.
6. exact Markdown is preserved.
7. existing Entry IDs survive canonical migration.
8. embedded Tasks have stable hidden identities.
9. copied/recovered Tasks receive new identities.
10. attachments use SHA-256 content addressing.
11. stale writes fail rather than overwrite.
12. recovery drafts remain durable.
13. migrations are explicit and repairable.
14. multi-tab coordination cannot overwrite unsaved editor text.
15. browser persistence is not backup.
16. Markdown export and full Vault archive serve different purposes.
17. full Vault archive restore refuses silent identity collisions.
18. derived state remains rebuildable.

## Next architecture phase

**A3 — Backend & Deployment Architecture**

A3 must consume A1/A2 rather than redefine their local ownership model.
