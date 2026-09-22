# Phase A2 Results — Local Storage, Serialization & Offline Persistence

## Result

A2 is implemented as the permanent **local persistence foundation** beneath Vault's Phase 1–12 product.

The main architectural outcome is that Vault did not discard its proven Markdown-first IndexedDB runtime. Instead, A2 added a canonical storage layer beside it and created explicit migration/repair paths.

## Implemented system

```text
UI / CodeMirror
      ↓
SaveCoordinator
      ↓
A2LocalRepository
      │
      ├── legacy compatibility state
      │     Entry / Markdown / revisions / drafts
      │
      ├── canonical schema-v4 state
      │     entities / noteBodies / migrationState
      │
      └── binary BlobStore
             ├── OPFS preferred
             └── IndexedDB fallback

Service Worker + Cache Storage
      └── offline application shell
```

## Key implementation outcomes

### Stable canonical identity

A1 identities now have a durable A2 storage representation.

Existing Note/Folder/Attachment Entry UUIDs are preserved rather than regenerated.

### First-class Task persistence without sacrificing Markdown

Tasks remain readable checkboxes but use hidden stable markers:

```markdown
- [ ] Example task <!-- vault:task=019c... -->
```

A2 mirrors those identified tasks into structured Task entities.

Migration generation `a2-canonical-shadow-v2` also repairs duplicate task identities from pasted/copied historical Markdown, including records in Trash.

### Content-addressed attachment storage

Attachment bytes are keyed by SHA-256.

OPFS is preferred where available. IndexedDB remains a complete fallback.

The existing legacy attachment store is retained during the compatibility period so migration never destroys the only local copy.

### Cross-tab safety

Web Locks protect migration-class operations.

BroadcastChannel messages now carry a session identifier. Other tabs refresh after committed writes; the originating tab ignores its own notification. An unsaved editor is never silently replaced by a cross-tab refresh.

### Persistent-storage and quota visibility

Vault requests persistent browser storage only after local Vault adoption/restore and exposes approximate usage/quota information.

Persistence remains an eviction-resistance feature, not a backup promise.

### Offline PWA

The service worker provides a cache-backed application shell for offline cold starts.

Canonical user content remains in IndexedDB/BlobStore rather than Cache Storage.

### Lossless archive and restore

Full Vault Archive version 2 now contains enough information for lossless local recovery:

- active human-readable files
- exact Markdown
- stable Entry/entity/Task IDs
- canonical entities
- canonical Note bodies
- Trash
- local revisions
- recovery drafts
- active attachment bytes
- deleted attachment bytes
- archive checksums

The strict ZIP STORE reader validates structure and CRC before archive-level SHA-256 validation.

Restore refuses identity collisions and reconstructs canonical/compatibility state transactionally.

## Tests added or expanded

`tests/a2-storage.test.mjs` covers:

- schema-v4 stores
- task marker adoption
- recurring-task identity
- duplicate/rekey behavior
- deterministic SHA-256
- archive metadata/checksum validation
- cross-note task identity collision repair
- deleted attachment archive round-trip

`tests/e2e/a2.spec.ts` covers:

- Task identity persistence across reload
- Task identity rekeying on duplication
- cold offline PWA startup
- exporting a full archive and restoring it into a fresh browser profile

## Certification note

The pre-hardening A2 foundation was part of Phase 12 commit:

`79a852b49f8476b3e985b055c167f21981ad827b`

That commit was recorded as certified with:

- **87/87 core tests**
- search benchmark
- graph benchmark
- board benchmark
- Canvas benchmark
- production build
- full then-current Chromium desktop/mobile suite

This A2 completion pass adds further implementation and tests after that baseline. The available GitHub connector does not return push-workflow check status for the newest head, so no newer CI success is asserted here until a visible run confirms it.

## Deferred intentionally

A2 does not attempt to solve A3–A5 concerns:

- backend database
- identity/accounts
- server APIs
- cross-device synchronization
- remote object storage
- remote conflict resolution
- E2EE/key architecture

Those layers must consume the local-first A1/A2 model rather than replace it.

## Next

**Phase A3 — Backend & Deployment Architecture**
