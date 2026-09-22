# Vault architecture

## Canonical-data rule

- exact Markdown + YAML frontmatter = authored Note content/metadata truth
- stable `Entry`/A1 entity UUIDs = identity truth; paths and titles are mutable
- embedded Markdown tasks carry hidden stable Task IDs and are reconciled with first-class `TaskEntity` records
- IndexedDB schema v4 = transactional structured local durability
- `noteBodies` = split canonical Markdown-body mirror keyed by stable Note ID
- OPFS-preferred / IndexedDB-fallback BlobStore = content-addressed binary payload durability
- CodeMirror = active editing state only
- revisions/recovery drafts = recoverability state
- knowledge/search indexes = rebuildable acceleration
- calendar/query/graph/board views = derived projections
- Canvas geometry = authored Markdown content, not a separate Canvas database
- Cache Storage = application shell only, never canonical user data
- future cloud database = synchronization/remote replication, not local ownership truth

No visual projection is a proprietary knowledge store. Derived indexes may be deleted and rebuilt. Browser storage is durable local state but is never treated as the only backup.

## A-series permanent architecture

### A1 — Canonical Domain & Data Model

A1 is implemented in `src/domain/canonical.ts`. Canonical identity is independent of title, filename, path, device and external-provider IDs. New A-series entities use offline UUIDv7 IDs; existing valid Entry UUIDs are preserved during migration.

Permanent domain types include Notes, Folders, Tags, typed Properties, Tasks, Events, Projects, People, Attachments, Captures, Collections and explicit Links. Explicit relationships remain distinct from inferred/AI relationships.

See `docs/A1_DOMAIN_MODEL.md` and `docs/adr/001-canonical-domain-model.md`.

### A2 — Local Storage, Serialization & Offline Persistence

A2 is implemented as an additive compatibility migration rather than a rewrite of the Phase 1–12 runtime.

```text
CodeMirror / commands
        ↓
version-checked A2LocalRepository
        ├── legacy Entry + Markdown compatibility stores
        ├── canonical entities + noteBodies
        └── content-addressed BlobStore
                 ├── OPFS preferred
                 └── IndexedDB fallback
```

Key A2 rules:

- IndexedDB remains the transactional database; SQLite/WASM is not required.
- schema v4 adds `entities`, `noteBodies`, `blobPayloads` and `migrationState` without deleting legacy stores.
- Notes retain exact Markdown text.
- Markdown task checkboxes gain hidden `<!-- vault:task=<uuid> -->` identities and corresponding first-class Task records.
- duplicate/pasted task identities are deterministically rekeyed; A2 migration v2 repairs historical collisions including Trash.
- attachment bytes are SHA-256 content-addressed and prefer OPFS, with IndexedDB fallback.
- Web Locks serialize migration-class work; BroadcastChannel propagates cross-tab invalidation with per-session loop prevention.
- stale editor writes remain version-checked and recovery drafts prevent silent loss.
- `navigator.storage.persist()` is requested only after Vault adoption; usage/quota health is inspectable.
- full Vault archives contain stable IDs, canonical entities, exact Markdown, Trash/recovery metadata and deleted attachment payloads, with SHA-256 checksums.
- restore rejects collisions and reconstructs canonical + compatibility state atomically.
- Service Worker/Cache Storage provide an offline application shell while user data stays outside Cache Storage.

See `docs/A2_STORAGE_ARCHITECTURE.md` and `docs/adr/002-local-storage-and-offline-persistence.md`.

## Local write path

```text
CodeMirror / Properties / template generation / task mutation / query definition editing
→ canonical Markdown string
→ SaveCoordinator or version-checked LocalRepository.saveMarkdown
→ IndexedDB
→ derived knowledge/search/calendar/task/query refresh
```

Stale writes fail instead of silently mutating the wrong source.

## Properties

Visual Properties edits YAML frontmatter through a round-trip YAML document model. Complex YAML that cannot be represented faithfully stays source-editable.

## Templates and Daily Notes

Template source is an ordinary Markdown file referenced by stable ID. Daily Note identity is configured folder ID + filename date pattern. Calendar state is derived from Daily filenames and YAML dates.

## Phase 7 — Task projection

A task is a Markdown list checkbox plus optional readable metadata tokens:

```markdown
- [ ] Task text @scheduled(2026-09-22) @due(2026-09-25) @priority(high) @repeat(weekly)
```

The parser produces a rebuildable task projection containing:

- original raw task line
- source UTF-16 range
- clean display text
- completed state
- scheduled date
- due date
- priority
- recurrence
- completion date

```text
Markdown task line
→ task parser
→ KnowledgeTask
├─→ Tasks view
├─→ Search Worker
└─→ Calendar date projection
```

### Task mutations

Every task control retains canonical source identity as:

- note UUID
- source range
- original raw task line

Before mutation, Vault re-reads the canonical Markdown and verifies the referenced task. If offsets no longer match, it may relocate only when the exact raw line has one unambiguous match. Otherwise the mutation fails as stale.

For the currently open note, task edits go through its active `SaveCoordinator`. Other notes use `LocalRepository.saveMarkdown(expectedVersion)`.

### Recurrence

Completing a recurring task:

1. marks the current occurrence complete
2. writes `@done(<local date>)`
3. preserves that completed Markdown line
4. inserts a new unchecked occurrence immediately below it
5. advances scheduled/due dates according to recurrence

Supported recurrences are daily, weekly, monthly, yearly and bounded `every Nd/Nw/Nm/Ny` intervals. Month/year advancement clamps end-of-month dates instead of overflowing into the following month.

There is no recurrence scheduler/database.

## Phase 8 — Query projection

A dynamic view is authored as a fenced Markdown block:

````markdown
```vault-query
view: table
query: tag:#project AND property:status=active
fields: file, path, property:status
sort: updated desc
limit: 25
```
````

The fenced source is canonical. Parsed plans and rendered rows are not stored.

```text
vault-query fence
→ strict query-plan parser
→ existing search/property/task semantics
→ KnowledgeRecord + active Entry metadata
→ list / table / task projection
├─→ CodeMirror Live Preview widget
└─→ detached Reading-mode DOM
```

The query executor reads only active Markdown entries and their rebuildable knowledge records. It supports list, table and task projections, property fields, deterministic sort/limit behavior and current-note exclusion.

Task query rows preserve the same source identity used by the Phase 7 Tasks panel. Completing a task from a query result therefore re-reads and version-checks the source Markdown before mutation.

### Rendering boundary

In Live Preview, Vault parses only explicit `vault-query` fences. The Markdown definition remains directly editable, while an inactive fence gets a CodeMirror block widget immediately after it with the live result. Moving the selection into the fence temporarily removes that widget so editing is not visually obstructed.

In Reading mode, query fences are first compiled as ordinary fenced code by the Markdown renderer. After DOM sanitization, Vault recognizes only `language-vault-query` blocks and replaces them with controlled DOM created through `document.createElement` / `textContent`. Query source never becomes executable HTML or JavaScript.

Embedded Reading-mode notes preserve source-entry context, so `exclude-self` and related source-sensitive behavior refers to the embedded note rather than the outer document.

## Phase 9 — Attachment and media boundary

Attachments use the same immutable entry identity and folder tree as notes, but their bytes live in the schema-v3 `attachments` object store:

```text
Entry(kind=attachment)
├─ stable entry UUID
├─ vault/folder/name metadata
└─ AttachmentContent
   ├─ MIME type
   ├─ byte length
   └─ Uint8Array payload
```

Notes reference attachments with readable Wiki-style paths such as `![[Attachments/photo.png]]` or `[[Attachments/report.pdf]]`. Resolution considers full vault paths, paths relative to the source note, same-folder filenames and unambiguous vault-wide filenames.

Renaming or moving an attachment re-resolves existing references against the old tree and rewrites them to the new canonical path. Moving a folder applies the same rule to all descendant attachments.

Reading-mode rendering never trusts attachment markup as HTML. The sanitized Markdown surface contains controlled placeholders; Vault then resolves those placeholders and constructs image/audio/video/file elements with DOM APIs and local object URLs.

Object URLs are cached by stable attachment ID for the session and revoked on deletion or workspace disposal.

Attachment exports preserve the original bytes and vault paths. Recovery snapshot format v2 serializes binary payloads as base64 so the JSON backup remains self-contained.

## Phase 10 — Knowledge graph projection

The graph is reconstructed from active `Entry` metadata plus `KnowledgeRecord.links`. It introduces no graph tables, graph documents or persistent layout state.

```text
Markdown + attachment paths
        ↓
KnowledgeRecord links + active Entry tree
        ↓
resolved directed relationships
        ↓
full/local/filter/group projection
        ↓
Canvas visualization + accessible node browser
```

Graph nodes are active Markdown notes and attachments. Edges are directed resolved references and retain whether the source was a normal link, note embed, attachment link or attachment embed. Repeated identical source/target/type references are collapsed into one weighted visual edge while preserving the reference count.

Unresolved and ambiguous references never create guessed edges; they are counted separately for diagnostics.

### Local graph

Local mode performs an undirected breadth-first traversal over the resolved relationship topology while preserving the original directed edges in the resulting projection. Depth is bounded to prevent accidental unbounded local expansion.

### Filters and grouping

Search highlighting and tag/property/kind/orphan filters operate on disposable `GraphNode` projections. Grouping by folder, primary tag, node kind or property affects layout only.

### Rendering and large vaults

The Canvas renderer starts from deterministic clustered positions. Smaller graphs receive bounded frame-by-frame link/collision relaxation. Reduced-motion users and graphs above the large-vault threshold use the deterministic static layout immediately instead of running continuous physics.

Search-only changes preserve the current viewport and positions rather than restarting layout.

The canvas is paired with ordinary DOM controls and a keyboard-accessible node browser so graph navigation does not depend on pointer precision or Canvas accessibility.

### Canonical boundary

Graph coordinates, zoom/pan state, groups, filters, orphan views and highlighted search matches are not canonical or synchronized data. Future cloud sync should continue synchronizing Markdown, stable entry metadata and attachment payloads only.

## Phase 11 — Kanban board projection

A board definition is canonical Markdown source inside a `vault-board` fence. Cards are not board records: they are active Markdown notes selected through the existing query grammar.

```text
vault-board fence
      ↓
strict board-plan parser
      ↓
existing dynamic-query semantics
      ↓
KnowledgeRecord properties + active Entry metadata
      ↓
property-backed columns and note cards
      ├─→ Live Preview widget
      └─→ sanitized Reading-mode board
```

### Lane identity

Writable boards require `group-by: property:<name>`. This is deliberate: a lane move has one unambiguous canonical mutation—set or delete that frontmatter property on the card note.

Configured columns define stable order and optional display labels. Property values not listed in the definition are surfaced as additional lanes rather than hiding notes. Notes without the grouping property appear in the uncategorized lane unless explicitly disabled.

### Card moves

A desktop drag/drop move and a touch/keyboard lane-selector move use the same mutation path.

For another note:

1. re-read its canonical Markdown
2. modify YAML through the round-trip frontmatter model
3. call `saveMarkdown(expectedVersion)`
4. rebuild knowledge/search projections
5. refresh the visible board

For the currently open note, the mutation goes through its active `SaveCoordinator` so CodeMirror state and durable Markdown cannot diverge.

No lane membership database exists.

### Rendering boundary

In Live Preview, only explicit `vault-board` fences produce board widgets. The source definition remains editable and becomes active when the cursor moves into it.

In Reading mode, the fence is first compiled and sanitized as ordinary code. Vault then replaces only `language-vault-board` blocks with controlled DOM. Board definitions are never evaluated as HTML or JavaScript.

### Performance boundary

Board projection reuses the indexed knowledge records and dynamic-query engine. CI includes a 10,000-note board projection benchmark with a bounded result limit to prevent a single view from rendering an unbounded number of cards.

Board lanes, rendered cards, drag state and scroll position are presentation state only. Future sync must continue to synchronize canonical Markdown/frontmatter, not board projections.

## Phase 12 — Spatial Canvas document boundary

Canvas is intentionally different from the derived Graph.

Graph layout is disposable presentation state. A Canvas is an authored spatial document, so its geometry and relationships are part of the Markdown note.

```text
vault-canvas fenced YAML
        ↓
strict Canvas parser
        ↓
stable node / edge / group ids
        ↓
DOM + SVG spatial workspace
        ↓
gesture/edit mutation
        ↓
replace only this Canvas fence
        ↓
SaveCoordinator / version-checked repository write
```

### Canonical document

Format version 1 stores:

- Canvas id
- persisted viewport x/y/zoom
- note, text and media cards
- card x/y/width/height
- directed labeled edges
- visual groups and group geometry

The parser fails closed for malformed YAML, duplicate ids, invalid geometry, missing edge targets, self-edges, oversized documents and unsupported format versions.

Current safety limits:

- 1,000 nodes
- 2,500 edges
- 250 groups
- 2 MB Canvas source
- bounded coordinates and object dimensions
- viewport zoom 0.1–4

### References

Note cards contain vault note targets and resolve using the existing Wiki-note resolver.

Media cards contain vault attachment targets and resolve through the existing attachment subsystem. Binary bytes remain in the Phase 9 attachment store and are not copied into Canvas YAML.

Text cards store plain text inside the Canvas document.

### Persistence

Every Canvas has a stable id. Mutations replace only the YAML body of the matching `vault-canvas` fence.

For the currently open note, persistence goes through the active `SaveCoordinator`. For an embedded Canvas owned by another note, Vault performs a version-checked `saveMarkdown(expectedVersion)`.

Live Preview widgets preserve their DOM across their own canonical source saves, keyed by stable Canvas id. This avoids tearing down an in-progress gesture when geometry is persisted.

Gesture persistence is enqueued immediately before later navigation/mode-switch actions, so a completed drag cannot be lost when the widget detaches.

### Rendering

Live Preview recognizes only explicit `vault-canvas` fences.

Reading mode first renders and sanitizes the fence as code. Only sanitized `language-vault-canvas` blocks are then replaced with controlled DOM/SVG.

No Canvas YAML is executed as HTML or JavaScript.

### Interaction

The spatial engine uses native DOM/SVG rather than a third-party whiteboard framework.

Supported interaction includes:

- card/group move
- card/group resize
- empty-space pan
- wheel/button zoom
- Fit
- keyboard pan/zoom
- desktop classic-mouse fallback
- Pointer Events for mouse/touch/pen
- grid snapping
- fullscreen expansion
- note/attachment open navigation
- connection creation/edit/delete

The classic mouse path and Pointer Events path share the same geometry/persistence model and are guarded against double-starts.

### Export/sync boundary

Canvas source remains ordinary Markdown text, so existing Markdown ZIP and recovery export automatically preserve Canvas documents.

Future sync should synchronize the Markdown containing the Canvas. It must not introduce a second whiteboard database or separately synchronized geometry record.


## Phase 13 — Obsidian migration & interoperability boundary

External vaults are migration inputs, not mounted canonical storage.

```text
Obsidian ZIP / browser folder selection
        ↓
safe archive/folder ingestion
        ↓
migration planner + compatibility report
        ├── portable path mapping
        ├── Wiki/Markdown link rewriting
        ├── JSON Canvas conversion
        └── warnings / ignored configuration
        ↓
single new-Vault local transaction
        ↓
legacy compatibility stores
        ↓
A2 canonical mirror rebuild
```

### Source isolation

Migration always creates a new Vault identity. Phase 13 does not merge an external folder into an existing Vault and does not retain a live filesystem mount.

This is deliberate:

- existing local Vaults cannot be overwritten by import
- imported file/path identity cannot collide with current Vault identity
- external changes after import cannot mutate canonical local data implicitly
- migration can fail before commit without leaving a half-imported Vault

### ZIP trust boundary

The general migration ZIP reader is separate from the stricter Vault-archive restore reader.

Migration ZIP supports:

- normal STORE entries
- DEFLATE entries through the browser `DecompressionStream`
- UTF-8 names, with explicit fallback warning for archives that omit the UTF-8 flag

It rejects path traversal, absolute paths, duplicate/case-colliding paths, encrypted entries, multi-disk ZIPs, ZIP64, unsupported compression methods, CRC mismatch and central/local-header disagreement.

Current migration limits are 20,000 entries, 512 MB archive bytes, 512 MB total expanded bytes and 128 MB per file.

### Portable path planning

External paths are planned before local storage is mutated.

For each path segment Vault preserves portable NFC-normalized names, repairs unsupported names deterministically, resolves case-insensitive sibling collisions with numeric suffixes, builds a complete source-path → target-path map, then rewrites resolvable Wiki and Markdown links against that map.

Relative Markdown links normalize `.` and `..` only while remaining inside the imported root. Ambiguous basename references remain unchanged rather than being guessed.

Link fallback lookup uses prebuilt filename/note-stem indexes, avoiding a full-path scan per link on large imports.

### Configuration and plugins

`.obsidian` is not copied into the canonical Vault as executable application configuration. The migration report records ignored configuration files and lists detected community plugin IDs when `community-plugins.json` is present.

Plugin-specific syntax inside Markdown is preserved as source. Dataview fences remain readable text but Vault does not execute the Obsidian plugin runtime.

### JSON Canvas conversion

Valid `.canvas` JSON documents are converted to Markdown notes containing canonical `vault-canvas` YAML.

Supported mappings include text node → text card, Markdown file node → note card, attachment file node → media card, group node → Canvas group, supported directed edge → Vault edge, and edge label → Vault edge label.

Unsupported/link-only constructs are preserved as readable text where possible and reported as compatibility warnings. Invalid JSON Canvas files remain attachment files instead of being discarded.

### Atomic commit

`commitObsidianMigration` constructs fresh Vault/Entry IDs and all compatibility records before opening one read-write transaction across the local Vault stores.

The transaction writes the new Vault, directory/file entries, Markdown contents, attachment payloads and dirty/local-change records. If any write fails, the transaction rolls back as one unit.

Imported Markdown task lines are reconciled with one shared Task-ID set so existing unique Vault task IDs can survive while collisions/new tasks receive stable IDs.

After the interoperable file transaction succeeds, A2 canonical stores are rebuilt from the new Vault tree. A mirror failure marks A2 repair-needed without corrupting the already-durable interoperable source files.

### Obsidian-oriented export

Normal Vault Markdown export remains unchanged. The explicit Obsidian export exports the active Markdown/attachment tree, parses valid `vault-canvas` fences, emits adjacent JSON `.canvas` companion files, and leaves the original Markdown source unchanged.

Vault-specific query/board fences have no native Obsidian equivalent and therefore remain Markdown code instead of being silently transformed.

### Performance boundary

CI includes a 10,000-source-file migration-planning benchmark containing 8,000 Markdown notes, 1,800 attachments, 200 JSON Canvas files, 8,000 Wiki-link rewrites and 8,000 Markdown-link rewrites.

The benchmark certifies planning/conversion independently from browser IndexedDB write throughput.

## Phase 14 — Cloud account, device and sync-foundation boundary

Phase 14 introduces remote identity/metadata, but local storage remains canonical ownership.

```text
browser local Vault
      │
      ├── explicit user adoption only
      ↓
provider-independent AccountId
      ↓
stable account-scoped DeviceId
      ↓
remote Cloud Vault registry
      ├── same Vault UUID
      ├── immutable sync epoch
      └── protocol version 1

local writes
      ↓
immutable local outbox + monotonic cursor state
      ↓
(Phase 15 remote operation replication)
```

### Authentication boundary

Vault uses the public Supabase project origin/publishable key in the browser. Authentication is performed through Supabase Auth REST endpoints with the user's bearer session; no service-role/secret key is shipped to the client.

Implemented browser auth behavior includes:

- email/password sign-in
- account creation
- access-token refresh using a durable refresh token
- user identity lookup
- local-scope sign-out
- Google social-login authorize/callback plumbing for the client-only browser flow

Stored sessions are project-scoped. Expired-session refresh failures caused by offline/network/server errors do not erase the stored refresh token. An explicit invalid/rejected refresh token does clear the session. Local sign-out clears browser credentials even when remote logout cannot be reached.

Phase 14 does not claim end-to-end encryption and does not store user passwords itself.

### Account identity

Supabase Auth user IDs are authentication-provider identities, not permanent Vault domain identity.

`vault_accounts` maps the current Auth user to a provider-independent AccountId. Cloud Vault bindings store both IDs so account/provider mismatches fail closed.

### Device identity

Each browser installation receives one random stable DeviceId in localStorage. The label is intentionally coarse and derived only from broad platform/user-agent categories.

The server primary identity is `(account_id, device_id)`, allowing one browser installation to sign out and later use a different account without colliding with another account's device row.

Device revocation is irreversible through normal authenticated updates. The active device cannot revoke itself through the Vault UI; local sign-out is used instead.

### Explicit Vault adoption

Login never changes a Vault's local/cloud mode.

A Vault moves from `local` to `cloud` only through an explicit user action. Adoption:

1. requires a signed-in account and registered non-revoked device
2. registers the existing Vault UUID remotely
3. receives an immutable remote epoch
4. initializes the local account/epoch cursor at `0`
5. writes a `CloudVaultBinding` into the existing local Vault record

Re-adoption with the same binding is idempotent. Attempted account/epoch/device rebinding fails as an account/protocol mismatch.

Signing out never clears the local Vault or its cloud binding.

### Supabase/RLS backend

Phase 14 deploys three public RLS tables:

- `vault_accounts`
- `vault_cloud_devices`
- `vault_cloud_vaults`

Anonymous access is revoked. Authenticated policies enforce `auth.uid() = auth_user_id` for every allowed select/insert/update path. Composite foreign keys bind device/Vault rows to the provider-independent account mapping.

Private trigger functions guard immutable identity fields, synchronization epochs/protocol versions and irreversible revocation/disable transitions.

### Local replication foundation

`SyncLocalState` uses the existing IndexedDB `outbox` and `syncCursors` stores.

Outbox records contain the exact canonical operation wire bytes and SHA-256 digest. Enqueue is idempotent for identical bytes and rejects operation-ID reuse with different bytes. Pending operations are account-bound.

Cursor state is keyed by Vault UUID and additionally bound to authenticated owner ID and remote epoch. Cursors are decimal PostgreSQL-bigint-compatible strings and can never move backward.

The outbox/cursor layer does not upload content in Phase 14; it exists so Phase 15 can implement pull-before-push remote replication without changing local identity semantics.

### Failure boundary

- network/auth failure cannot block local editing
- opening Vault does not require a cloud request
- signing in does not enqueue or upload existing local content
- signing out leaves local canonical data intact
- account, owner or epoch mismatch fails closed before replication
- full remote note/attachment content replication and conflict application remain Phase 15

### Backend implementation source

The deployable Supabase schema is retained in `backend/supabase/phase14_cloud_foundation.sql`. The live THIEPN Core project has the Phase 14 tables, RLS policies, immutability triggers and foreign-key covering indexes applied.

## Phase 15 — Remote replication & conflict boundary

Phase 15 synchronizes only canonical authored/file state. Derived indexes and views remain local rebuildable projections.

```text
local canonical change
        ↓
legacy/A2 local persistence + dirty marker
        ↓
operation synthesis against last remote shadow
        ↓
immutable outbox envelope + SHA-256
        ↓
pull remote ordered events first
        ↓
authenticated push RPC
        ↓
remote revision snapshot + ordered event
        ↓
pull/apply/advance local cursor
```

### Server authority

The live THIEPN Core Phase 15 backend contains:

- `vault_sync_entries` — current per-entry remote snapshot/revision
- `vault_sync_operations` — exact immutable accepted operation envelopes/results
- `vault_sync_events` — append-only ordered Vault event stream
- `vault_sync_counters` — per-Vault sequence allocator
- private Storage bucket `vault-sync` — content-addressed attachment bytes

Direct browser access to the four synchronization tables is revoked and RLS policies deny direct authenticated table access. Browser replication uses only the explicitly granted authenticated RPC surface plus private Storage object policies.

`vault_sync_pull` and `vault_sync_push` are intentionally `SECURITY DEFINER` functions. They use an empty `search_path`, are revoked from `public`/`anon`, granted only to `authenticated`, and independently verify `auth.uid()`, provider-independent account mapping, Vault ownership/epoch/protocol state, and non-revoked DeviceId before reading or mutating replication state.

The Supabase security advisor therefore reports the generic warning that authenticated users can execute these two SECURITY DEFINER functions. This is the intended API design rather than accidental table privilege escalation; direct content tables remain inaccessible.

### Remote revision model

Every remote entry snapshot contains stable Entry/Vault identity, parent/name/kind, monotonically increasing integer revision, deleted state, updater DeviceId and canonical content metadata.

For Markdown, the snapshot contains exact Markdown text. For attachments it contains SHA-256, MIME type and byte length; binary data remains in the private content-addressed Storage bucket.

Server mutations are revision checked:

- `create` requires a previously unused entry identity/path
- `write`, `move`, `trash`, and `restore` require the exact current `baseRevision`
- accepted mutation increments the remote revision and emits exactly one ordered event
- operation ID reuse with identical wire/hash returns the original result
- operation ID reuse with different bytes fails

### Pull-before-push client algorithm

A manual Phase 15 sync run performs:

1. validate account/Vault/epoch/device binding and pending-operation ownership
2. pull and fully validate ordered pages until the local cursor reaches the high-water mark
3. apply clean remote snapshots and materialize conflicts conservatively
4. synthesize immutable operations from local dirty state versus remote shadows
5. upload required attachment blobs before their create operation
6. push eligible outbox operations
7. pull their ordered server events and acknowledge only after observing them
8. repeat synthesis/push/pull once to capture edits/conflict copies created during the first pass

Every page is validated before application for protocol/vault/epoch identity, strictly contiguous event sequence, cursor consistency, snapshot identity and revision consistency.

### Remote shadows

`remoteShadows` store the last accepted remote snapshot for each local Entry. They are owner/epoch bound and are used to distinguish:

- a true remote concurrent change
- the ordered event for this device's own just-pushed operation
- an older historical event already subsumed by a newer acknowledged snapshot
- a local dirty entry that has converged exactly to remote state

Remote shadows are synchronization metadata, not authored truth.

### Conflict preservation

Phase 15 never silently resolves two divergent Markdown bodies.

When a remote snapshot arrives while the same local entry is dirty/pending and the states do not match, Vault preserves one side as a separate conflict copy and makes the ordered remote snapshot canonical at the original stable Entry ID.

A local-delete/remote-edit race restores/applies the remote canonical entry, preserves it as a conflict copy, then reapplies the local delete intent against the new remote base.

Path collisions fail closed with `COLLISION`; the user must choose a rename. Phase 15 deliberately does not invent names for remote canonical entries.

Phase 15 uses conservative whole-file conflict preservation rather than diff3. Automatic non-overlapping text merge is intentionally deferred.

### Attachment replication

Attachment create operations reference `{sha256, mimeType, size}` rather than carrying bytes inside the JSON operation.

Before the create operation is accepted:

1. the browser hashes local bytes
2. uploads them to `vault-sync/<auth-user-id>/<vault-id>/<sha256>`
3. server RPC verifies that object exists
4. remote entry snapshot records the immutable blob metadata

On another device, Vault downloads only when local bytes for that hash are absent/different, then verifies exact SHA-256 and byte length before committing them locally.

Already-synchronized attachment byte mutation is rejected locally. A changed binary should be duplicated as a new attachment identity so both versions remain explicit.

### Local-first failure boundary

- network failure never blocks ordinary local editing
- only explicitly adopted cloud Vaults participate
- account/device/epoch mismatch stops sync before mutation
- outbox retry uses exact immutable bytes
- cursor only advances after each remote event is durably applied
- A2 mirror failure marks repair-needed without discarding the compatibility-store canonical content
- signing out keeps local canonical content and cloud binding intact

Phase 15 synchronization is explicit/manual (`Sync now`). Background scheduling/realtime notifications and richer merge UX are later phases.

### Backend implementation source

Deployable SQL is retained in:

- `backend/supabase/phase15_remote_replication.sql`
- `backend/supabase/phase15_remote_replication_hardening.sql`

THIEPN Core has both Phase 15 migrations applied, the private `vault-sync` bucket configured, authenticated-only RPC execution grants, RLS/direct-access denial on replication tables, and owner/Vault-scoped Storage policies.
## Knowledge index

The derived knowledge record stores aliases, headings, block IDs, links, tags, properties and parsed task projections. Its version advances when parser semantics change; it remains reconstructable from Markdown.

## Search

Search runs in a dedicated module Web Worker. Phase 7 extends structured task filters with open/done, overdue/today/upcoming/undated, recurring, scheduled, due and priority categories. Phase 8 reuses the same query grammar for dynamic views rather than introducing a competing filter language.

## Calendar

Calendar date cells combine:

- Daily Note identity
- YAML date-property associations
- open task scheduled/due dates

Completed tasks are not projected as active calendar tasks.

## Rendering trust boundary

Untrusted Markdown is compiled/sanitized before controlled rendering enhancements. Task controls operate on parsed source lines rather than rendered HTML. Dynamic query results are also constructed as controlled DOM after sanitization.

## File identity

Paths are not permanent identity. Files/folders use immutable UUIDs.

## Sync boundary

Phase 15 synchronizes canonical Markdown, stable file metadata and attachment payloads through the explicit Phase 14 account/device/Vault boundary. Derived task/search/calendar/query/graph/board projections remain local rebuildable state and are never replicated as authoritative records.
