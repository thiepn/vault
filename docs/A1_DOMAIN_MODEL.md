# Phase A1 — Canonical Domain & Data Model

Status: **implemented architecture baseline**

Phase A1 defines the semantic model that future storage, backend, account and sync work must preserve.

It does **not** migrate the Phase 1–11 runtime away from its working Markdown-first persistence model. That belongs to A2. The A1 contracts are intentionally introduced above the existing runtime so future migration can happen without re-identifying existing data.

## Implementation

Executable contracts live in:

- \`src/domain/canonical.ts\`
- \`tests/a1-domain.test.mjs\`

The existing Phase 1–11 domain/storage implementation remains active.

## Identity rule

Every canonical entity has a stable globally unique identifier.

New A-series domain entities use offline-generated UUIDv7 IDs.

Existing Vault entry UUIDs remain valid. Notes, folders and attachments already created by the Phase 1–11 runtime are bridged into the canonical domain **without changing their identifier bytes**.

Therefore:

- title is not identity
- filename is not identity
- path is not identity
- folder location is not identity
- external-provider ID is not Vault identity

Moving or renaming an entity must not change its canonical ID.

## Canonical entity types

A1 freezes these first-class persistent concepts:

| Entity | Purpose |
| --- | --- |
| Vault | top-level user data container |
| Note | free-form Markdown-compatible knowledge |
| Folder | hierarchical organization |
| Tag | lightweight categorization |
| PropertyDefinition | typed metadata definition |
| Task | actionable item with independent identity |
| Event | something occurring in time |
| Project | actionable project container |
| Person | person/entity profile |
| Attachment | binary-file metadata with stable identity |
| Capture | raw input saved before processing |
| Collection | static or dynamic grouping/view definition |
| Link | explicit semantic relationship |

The TypeScript discriminant is \`entityType\`.

## Shared entity envelope

Canonical entities share the following conceptual fields:

~~~text
id
entityType
schemaVersion
revision
createdAt
updatedAt
deletedAt
properties
createdByDeviceId?
lastModifiedByDeviceId?
origin?
~~~

Timestamps are stored as explicit semantic fields rather than inferred from filenames or storage insertion order.

## Canonical vs derived state

Canonical state must survive loss of all indexes and projections.

Examples of canonical state:

- note body
- note title
- explicit folder placement
- explicit properties
- explicit tags
- task state
- event times
- project state
- person data
- attachment metadata and eventual attachment bytes
- raw captures
- explicit links
- static collection membership
- dynamic collection definitions

Derived state includes:

- backlinks
- search indexes
- graph layout
- semantic embeddings
- similarity scores
- previews
- counts
- recent-items lists
- rendered query rows
- rendered Kanban lanes

Derived state must remain reconstructable.

## Notes

Notes are Markdown-compatible content entities.

A Note has:

~~~text
id
vaultId
title
body
folderId
aliases
noteKind
dailyDate?
properties
~~~

\`noteKind\` currently supports:

- \`standard\`
- \`daily\`
- \`template\`

Daily Notes reuse the normal Note entity and require a semantic \`dailyDate\`. They are not a second content system.

## Blocks

A1 does not turn every paragraph into a persistent database entity.

Stable block IDs are intended to be created lazily only when something needs to reference a precise block.

The storage representation of block anchors is deferred to A2.

## Folders

Folders form an organizational tree.

Folder hierarchy is structural, not semantic. A folder cannot parent itself and A5 must preserve acyclic hierarchy during sync.

A note's folder can change without affecting note identity.

## Tags

Tags are distinct from both folders and links.

- folder = primary organization
- tag = category
- link = relationship

Tag normalization is deterministic and locale-independent at the domain boundary.

## Typed properties

A1 defines typed property values rather than treating all metadata as arbitrary strings.

Supported semantic value types are:

- text
- number
- boolean
- date
- datetime
- URL
- entity reference
- null
- list of scalar property values

Unknown user-defined properties must remain preservable when A2 defines serialization.

## Tasks

Tasks are first-class domain entities in the permanent architecture.

A Task has independent identity and may reference:

- a Project
- a parent Task
- a source Note
- a source block

Task scheduling and task deadlines are intentionally separate:

- \`scheduledAt\` = intended work time
- \`dueAt\` = deadline

Completion is explicit:

~~~text
status = completed
completedAt = timestamp
~~~

The current Phase 7 runtime still treats Markdown checkboxes as canonical task truth. A2 must define how those readable Markdown tasks project to/from stable Task IDs without breaking the current UX.

## Events

Events remain distinct from Tasks.

Task:

> something to do

Event:

> something happening at a time

External provider identifiers are adapter metadata. Google/other calendar IDs never replace Vault Event IDs.

## Projects

Projects are first-class actionable entities.

The permanent model supports:

- status
- start date
- target date
- parent project
- optional associated long-form Note

Project parent relationships must be acyclic. Missing referenced parents are tolerated as recoverable/orphaned state rather than corrupting the entire Vault.

## People

People are first-class entities with optional structured profile fields and an optional associated Note.

This keeps identity/relationships structured without forcing every person to have a large Markdown document.

## Attachments

Attachment identity is independent of filename.

Canonical attachment metadata includes:

- stable ID
- filename
- media type
- size
- SHA-256 checksum
- optional media dimensions/duration
- optional original filename

A2 decides where bytes live and when checksums are computed.

Existing Phase 9 attachment Entry IDs must be preserved.

## Captures

Raw capture is a first-class entity because capture must be durable before intelligent processing.

Capture processing states:

- unprocessed
- processing
- processed
- failed

Processing failure never deletes \`rawContent\`.

A Capture may reference the entities eventually produced or modified by processing.

## Collections

Collections do not duplicate content.

Two modes are frozen:

### Static

Explicit entity references.

### Dynamic

A stored query whose membership is derived.

Home/dashboard surfaces should be built from these existing entities rather than becoming another canonical content store.

## Links

Canonical Links represent explicit relationships.

Targets may be:

- resolved entity references
- unresolved textual targets

Unresolved Wiki links are valid state and must not be discarded.

Backlinks remain derived from outgoing relationships.

## Explicit vs inferred relationships

A1 deliberately separates them.

Explicit relationship:

> persisted user/authorized relationship

Inferred relationship:

> disposable suggestion produced by semantic similarity, rules or AI

An inferred relationship does not silently become an explicit Link.

## Provenance

The domain supports mutation/source provenance so later history can distinguish:

- user
- system
- automation
- AI
- import
- external integration

Imported/external source identifiers are metadata only.

## Deletion

Normal deletion remains soft deletion through \`deletedAt\`.

A5 must define durable tombstone behavior for synchronized entities.

Permanent purge remains a separate lifecycle operation.

## Revisions and schema versions

These are separate concepts:

- \`revision\`: this entity changed
- \`schemaVersion\`: the serialized/domain format changed

A5 will decide the exact revision/conflict protocol.

## Compatibility with the existing runtime

The current application already has several A1-compatible properties:

- immutable Entry UUIDs
- path-independent note/folder/attachment identity
- Markdown note content
- soft deletion
- version-checked writes
- rebuildable knowledge/search/graph/query/board projections
- attachment IDs independent of filenames

A1 therefore does not replace \`Entry\`, \`MarkdownContent\` or the current IndexedDB schema.

Instead:

~~~text
existing Entry UUID
        |
        v
canonicalIdFromEntry(...)
        |
        v
A1 Note / Folder / Attachment identity
~~~

A2 will decide how canonical domain entities serialize into Markdown, IndexedDB/OPFS and structured records.

## Runtime invariants now executable

\`assertCanonicalEntity\` enforces baseline invariants including:

- valid stable UUID identity
- positive schema/revision values
- valid timestamps
- Daily Note date rules
- typed property validity
- explicit Task completion semantics
- Task self-parent prevention
- Event temporal ordering
- Project self-parent prevention
- attachment checksum/size validity
- Capture result reference validity
- Collection mode consistency
- explicit Link target validity

Additional helpers enforce:

- global ID uniqueness
- indirect Project cycle rejection
- deterministic tag normalization

## Deferred to A2

A1 deliberately does not decide:

- SQLite vs IndexedDB
- OPFS layout
- canonical local serialization
- whether/when Markdown files are materialized
- Task ID serialization inside Markdown
- attachment byte layout
- transactions
- autosave mechanics
- storage quota strategy
- local migration execution
- corruption recovery strategy

## A1 frozen decisions

1. Stable IDs are independent of names and paths.
2. New domain IDs are offline-generatable UUIDv7 values.
3. Existing stable Entry IDs are preserved during migration.
4. Notes are Markdown-compatible content entities.
5. Daily Notes are specialized Notes.
6. Folders, Tags and Links are different concepts.
7. Properties are typed.
8. Explicit and inferred relationships remain separate.
9. Backlinks are derived.
10. Tasks are first-class permanent-domain entities.
11. Scheduled time and due time are separate.
12. Events and Tasks are separate.
13. Projects and People are first-class.
14. Attachments have identity independent of filenames.
15. Raw Captures are first-class and survive processing failure.
16. Collections reference/query existing entities rather than copy them.
17. External-provider identity never replaces Vault identity.
18. Canonical and derived state are explicitly separated.
19. Normal deletion is soft deletion.
20. Persistent structures are revisioned and schema-versioned.
21. Domain meaning remains independent from serialization and storage.

## Acceptance

Phase A1 is accepted when:

- canonical contracts compile under strict TypeScript
- new IDs can be generated offline
- existing Entry IDs bridge without re-identification
- entity invariants are runtime-testable
- global ID uniqueness can be checked
- Project cycles can be detected
- unresolved links remain representable
- Captures remain raw canonical state
- A1 tests run in the normal \`npm test\` contract suite
- no Phase 1–11 storage/runtime behavior is migrated prematurely

## Next

Phase A2 — Local Storage, Serialization & Offline Persistence Architecture.
