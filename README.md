# Vault

**Vault** is a browser-first, local-first Markdown knowledge system.

Markdown remains canonical while Vault adds professional browser tooling around it.

The repository currently includes browser-certified:

- **Phase 1 — Vault & File System**
- **Phase 2 — Professional Markdown Editor**
- **Phase 3 — Linked Knowledge System**
- **Phase 4 — Index + Search Engine**
- **Phase 5 — Properties & Metadata**
- **Phase 6 — Templates, Daily Notes & Calendar**
- **Phase 7 — Tasks & Task Management**
- **Phase 8 — Queries & Dynamic Views**
- **Phase 9 — Attachments, Images & Media**
- **Phase 10 — Graph View & Knowledge Visualization**
- **Phase 11 — Kanban & Structured Board Views**
- **Phase 12 — Canvas & Spatial Knowledge Workspace**
- **Phase 13 — Obsidian Import, Migration & Interoperability**
- **Phase 14 — Cloud Accounts, Device Identity & Sync Foundation**
- **Phase 15 — Remote Replication, Conflict Resolution & Attachment Sync**
- **Phase 16 — Continuous/Background Sync, Advanced Conflict Resolution & Sync Hardening**
- **Phase 17 — Realtime Sync Wakeups & Connection Resilience**
- **Phase 18 — Shared Vaults, Membership & Permission Architecture**
- **Phase 19 — Live Presence & Collaborative Session Foundation**
- **Phase 20 — Live CRDT Text Co-Editing & Shared Undo Foundation**
- **Phase 21 — Best-Effort Closed-App Replication & Background Sync**
- **Phase 22 — Semantic/Block-Aware Interactive Conflict Resolution**
- **Phase 23 — Durable CRDT Collaboration Journal & Session Recovery**

## Permanent architecture program

The Phase 1–23 product now runs on the **A1/A2 permanent local foundation**.

**A1 — Canonical Domain & Data Model** defines stable first-class identities/contracts for Notes, Folders, Tasks, Events, Projects, People, Attachments, Captures, Collections and explicit Links. New A-series entities use offline UUIDv7 IDs while existing Entry UUIDs are preserved.

**A2 — Local Storage, Serialization & Offline Persistence** is implemented with:

- IndexedDB schema v7 as the transactional local persistence layer
- canonical `entities` and split `noteBodies` stores alongside compatibility stores
- stable hidden IDs for Markdown-embedded tasks
- content-addressed SHA-256 attachment blobs
- OPFS-preferred blob persistence with IndexedDB fallback
- migration/repair state plus Web Locks coordination
- BroadcastChannel invalidation
- persistent-storage requests and quota/health support
- full-fidelity Vault archives with checksums
- service-worker application-shell caching and cold offline PWA startup
- worker-readable `backgroundRuntime` plus staged `remoteInbox` stores for best-effort closed-app replication
- persistent `conflicts` store for unresolved/resolved Markdown conflict metadata and snapshots
- bounded `crdtSessions` + `crdtUpdates` stores for exact-base live-collaboration replay/history
- compatibility mirroring so Phase 1–15 behavior remains available during the canonical-storage transition

See `docs/A1_DOMAIN_MODEL.md`, `docs/A2_STORAGE_ARCHITECTURE.md`, and the ADRs under `docs/adr/`.

## Current capabilities

### Vault and files

- multiple local vaults and nested folders
- immutable file/folder UUIDs
- create, rename, move, drag/drop and recursive duplicate
- Trash/restore
- IndexedDB persistence
- autosave version checks, recovery drafts and checkpoints
- Markdown ZIP/recovery export
- desktop/mobile shell

### Markdown editor

- CodeMirror 6
- Source, Live Preview and Reading modes
- undo/redo, multi-cursor and find/replace
- formatting controls and keyboard shortcuts
- GFM tables, highlighted code, KaTeX, callouts and Mermaid
- sanitized Reading mode

### Linked knowledge

- Wiki links, aliases, heading/block links
- note/heading/block embeds
- autocomplete
- backlinks and unlinked mentions
- outline navigation
- unresolved-note creation
- parsed link maintenance after rename/move

### Search

- dedicated Web Worker index
- full-text, phrase and Boolean search
- file/path/tag/property/task filters
- nested tags and property comparisons
- Quick Switcher
- exact source offsets
- incremental reconciliation and worker recovery
- 10,000-note CI benchmark

### Visual Properties

- canonical YAML frontmatter
- text, number, boolean, date, scalar list, tags and null
- visual add/edit/rename/delete
- comment/order and LF/CRLF preservation for supported edits
- complex YAML source fallback

### Templates, Daily Notes & Calendar

- ordinary Markdown templates
- default/folder-specific/Daily templates
- date/time/title/cursor template variables
- configurable Daily Notes folder/template/filename
- Previous / Today / Next navigation
- Monday-first calendar
- Daily Note/date-property markers
- mobile Calendar workflow

### Tasks

Tasks stay ordinary Markdown checkboxes.

Example:

```markdown
- [ ] Ship report @scheduled(2026-09-22) @due(2026-09-25) @priority(high)
- [ ] Weekly review @due(2026-09-21) @repeat(weekly)
```

Supported task metadata:

- `@scheduled(YYYY-MM-DD)`
- `@due(YYYY-MM-DD)`
- `@priority(high|medium|low)`
- `@repeat(daily|weekly|monthly|yearly)`
- `@repeat(every 2d)`, `every 2w`, `every 2m`, `every 2y`
- `@done(YYYY-MM-DD)` written when a task is completed

Task management includes:

- vault-wide Tasks tab
- open/done/all filtering
- overdue/today/upcoming/undated filtering
- priority filtering
- grouping by date, note or priority
- task-text filtering
- inline checkbox/text/scheduled/due/priority/recurrence editing
- jump to source task in CodeMirror
- add a task to the current note
- recurring completion that preserves the completed occurrence and inserts the next open occurrence
- Calendar task markers
- Calendar task completion
- extended search filters including `task:overdue`, `task:today`, `task:recurring`, `task:high`
- desktop and mobile task workflows

### Queries & Dynamic Views

Queries are stored directly in Markdown fenced blocks and evaluated against rebuildable vault projections.

```vault-query
view: table
title: Active projects
query: tag:#project AND property:status=active
fields: file, path, tags, property:status
sort: updated desc
limit: 25
exclude-self: true
```

Supported views:

- `list` — compact linked note results
- `table` — selected file/property/tag/task-count columns
- `tasks` — live task rows backed by canonical Markdown checkboxes

Query definitions support:

- the existing text/phrase/Boolean search language
- tag, file, path, property and task clauses
- deterministic sorting and result limits
- property columns
- current-note exclusion
- task status/date/priority row filters
- source-note navigation
- Live Preview result widgets alongside directly editable Markdown query definitions
- Reading-mode rendering
- task completion directly from dynamic task views
- responsive desktop/mobile rendering

Dynamic views do not persist result rows. They are recomputed from Markdown-derived knowledge records.

### Canvas & Spatial Knowledge Workspace

Spatial canvases are authored directly inside Markdown with a strict `vault-canvas` YAML document.

```vault-canvas
version: 1
id: canvas-project
viewport: { x: 80, y: 80, zoom: 1 }
nodes:
  - id: note-alpha
    type: note
    target: Projects/Alpha
    x: 0
    y: 0
    width: 260
    height: 160
  - id: text-question
    type: text
    text: What connects these ideas?
    x: 340
    y: 0
    width: 260
    height: 160
edges:
  - id: edge-alpha-question
    from: note-alpha
    to: text-question
    label: motivates
groups: []
```

Canvas capabilities include:

- note cards resolved against the vault
- text cards
- local media cards
- movable and resizable cards
- visual groups
- directed labeled connections
- add/edit/delete workflows
- pan, zoom and Fit
- persisted viewport
- grid snapping with Alt for free positioning
- keyboard pan/zoom
- desktop mouse and Pointer Event gestures
- touch-compatible pointer interaction
- Live Preview Canvas widgets
- Reading-mode Canvas rendering after sanitization
- fullscreen workspace expansion
- stale-safe Markdown fence persistence
- reload-safe geometry and connections
- automatic cleanup when a rendered Canvas detaches
- maximum-size Canvas performance certification

Unlike Graph coordinates, Canvas geometry is authored user content. Node positions, sizes, groups, edges and viewport are therefore stored in the Markdown document and exported with the vault.



### Graph View & Knowledge Visualization

The Graph is rebuilt from active vault entries and the derived knowledge index. It does not store a second relationship database.

Graph capabilities include:

- full-vault graph
- local graph centered on the current note or attachment
- configurable 1–4 hop local depth
- directed Wiki-link and embed relationships
- attachment link/embed relationships
- repeated-reference edge weighting
- unresolved/ambiguous reference diagnostics
- orphan-note and orphan-attachment discovery
- title/path/tag/property search highlighting
- tag filtering
- property filtering such as `status=active`
- note/attachment filtering
- folder, primary-tag, kind and property grouping
- click/tap-to-open navigation
- wheel, keyboard and button zoom
- drag/touch panning
- accessible visible-node browser
- reduced-motion static layout
- automatic static-layout fallback for large graphs
- dedicated 10,000-node performance certification

Graph coordinates, grouping and filter state are presentation-only. Relationships are recomputed from Markdown references and attachment paths.

### Kanban & Structured Board Views

Boards are saved as ordinary fenced Markdown definitions and project cards remain ordinary Markdown notes.

```vault-board
title: Project board
query: tag:#project
group-by: property:status
columns: backlog=Backlog, todo=To do, doing=Doing, done=Done
card-fields: tags, property:priority, updated
sort: updated desc
limit: 200
exclude-self: true
```

Board capabilities include:

- existing Boolean/tag/property/task query grammar
- property-backed Kanban lanes
- configured lane order and labels
- automatically surfaced unexpected property values
- optional uncategorized lane
- card metadata fields
- deterministic card sorting
- Live Preview board widgets
- Reading-mode board rendering
- desktop drag/drop lane moves
- touch/keyboard lane selectors
- click-to-open cards
- compact board layout
- responsive horizontal lanes
- version-checked YAML updates on card movement
- safe handling when the moved card is the currently open note
- 10,000-card projection benchmark

Moving a card changes the configured frontmatter property on the underlying note. The board itself stores no card positions, copies, or proprietary task records.

### Attachments, Images & Media

Attachments are first-class local vault entries with stable IDs and binary payloads stored separately from note text.

Supported workflows include:

- file picker upload
- clipboard paste into the Markdown editor
- drag/drop files into the editor
- configurable dedicated attachment folder
- optional “beside current note” placement
- automatic collision-safe filenames
- Obsidian-style `![[path/file.png]]` media embeds
- `[[path/file.pdf]]` file links
- image, audio and video rendering in Reading mode
- PDF/other-file download cards
- dedicated attachment preview screen
- attachment library with reference counts
- unreferenced/orphan detection
- rename/move reference rewriting
- attachment and attachment-folder duplication
- Trash/restore through the normal vault lifecycle
- Markdown ZIP export with original binary bytes
- recovery backups containing attachment payloads

Individual browser-stored attachments are currently limited to 128 MB. The existing in-memory ZIP exporter remains capped at 512 MB.

### Obsidian Import, Migration & Interoperability

Vault can migrate an external Obsidian-style vault without making external files a second source of truth.

Import workflows:

- **Import Obsidian ZIP** — accepts standard ZIP STORE and DEFLATE entries
- **Import Obsidian folder** — uses browser folder selection and preserves the external tree
- import always creates a **new local Vault**; existing Vaults are never merged or overwritten
- migration preview reports notes, attachments, folders, converted Canvas files, ignored config, renamed paths and compatibility warnings before commit
- `.obsidian` configuration is detected/reported but not imported as executable configuration
- community plugin names are detected when available and shown in the report
- `.git`, `.trash`, `__MACOSX` and common system files are excluded
- invalid `.canvas` files are preserved as ordinary attachments instead of discarded

Migration behavior:

- Markdown/frontmatter source remains text
- attachments preserve exact bytes
- non-portable filenames are repaired deterministically
- case/name collisions receive stable suffixes rather than overwriting files
- Wiki links and standard Markdown links are rewritten when a migrated path changes
- relative `.` / `..` Markdown paths are normalized only when they stay inside the imported vault
- imported Markdown tasks gain Vault's hidden stable task IDs
- the whole external tree commits as one new-vault IndexedDB transaction
- after commit, A2 canonical mirrors are rebuilt from the imported canonical files

Obsidian JSON Canvas files are converted into ordinary Markdown notes containing `vault-canvas` documents:

- text cards map to Vault text cards
- file-note cards map to Vault note cards
- attachment cards map to media cards
- groups map to visual groups
- supported directed edges and labels are preserved
- web-link/unsupported cards are preserved as readable text with explicit migration warnings

**Export Obsidian-compatible ZIP** keeps the canonical Markdown/attachment tree and additionally emits `.canvas` companion files for valid Vault Canvas blocks. Vault-only query/board fences remain readable Markdown code because Obsidian has no native equivalent.

The interoperability layer has explicit safety limits: 20,000 ZIP entries, 512 MB archive/expanded content, 128 MB per file and no encrypted/multi-disk/ZIP64 imports in this release.
### Cloud Accounts, Device Identity & Sync Foundation

Phase 14 adds Vault's first production cloud identity layer without changing its local-first ownership model.

Core guarantees:

- signing in **does not upload any local Vault**
- each Vault stays `local` until the user explicitly enables cloud foundation for that Vault
- adoption preserves the existing Vault UUID rather than cloning/rekeying it
- signing out removes the browser auth session but **does not delete local Vault data or the local cloud binding**
- one browser installation keeps a stable random DeviceId across reloads/sign-outs
- the server scopes that DeviceId by account, allowing the same installation to sign into different accounts safely
- device labels are intentionally coarse (Windows/Android/iOS/etc.), not fingerprinting identifiers
- a provider-independent AccountId is mapped to the Supabase Auth user ID
- each adopted Vault receives one immutable synchronization epoch and protocol version
- local sync cursors are account/epoch-bound and monotonic
- local outbox operations are immutable/idempotent exact-byte envelopes with SHA-256 integrity

Authentication/UI:

- email/password sign-in and account creation
- refresh-token session maintenance
- Google OAuth browser handoff/callback plumbing
- account/device Cloud panel on desktop and mobile
- remote adopted-Vault metadata list
- revocation of other devices
- explicit per-Vault adoption
- offline-safe session handling: network failure does not silently erase an expired stored session
- local sign-out succeeds even when the network is unavailable

Backend:

- Supabase/Postgres tables for provider-independent accounts, devices and adopted Vault metadata
- default-deny Row Level Security scoped to the authenticated user
- immutable device/Vault identity guards
- irreversible device revocation and remote-Vault disable semantics
- no service-role or secret key enters the browser

**Phase 14 does not sync note or attachment contents yet.** It establishes the authenticated account/device/Vault identity, cursor and outbox foundations that Phase 15 will use for real remote replication and conflict handling.
### Remote Replication, Conflict Resolution & Attachment Sync

Phase 15 turns the Phase 14 identity/outbox foundation into explicit cross-device content synchronization.

Synchronization remains local-first:

- local editing never waits for the network
- only explicitly cloud-adopted Vaults can synchronize
- **Sync now** is an explicit user action in this phase
- every run pulls ordered remote events before synthesizing/pushing local dirty state
- one second pull/synthesize/push pass catches races created during the first pass
- account, Vault epoch and DeviceId mismatches fail closed

Canonical remote content:

- folders and stable entry identity
- Markdown text
- move/rename state
- Trash/restore state
- attachment metadata
- attachment binary payloads through a private content-addressed Supabase Storage bucket

Replication protocol:

- immutable operation IDs and exact JSON wire payloads
- SHA-256 operation integrity
- idempotent push retry
- per-Vault PostgreSQL-bigint-compatible ordered event cursor
- strict runtime validation of every page, event, snapshot and push acknowledgement
- remote tables are not directly writable/readable by the browser; authenticated RPCs are the mutation/read boundary

Conflict handling is deliberately conservative:

- clean remote updates apply to the canonical local entry
- identical local/remote state reconciles without creating a conflict
- concurrent Markdown edits preserve the local side as a separate `conflict` copy, then apply the remote canonical version
- a local delete racing a remote edit preserves a conflict copy and reapplies the local delete intent
- remote path collisions fail closed and require an explicit rename rather than guessing
- already-synchronized attachment bytes are immutable in-place; duplicate the attachment to preserve a changed binary version

Attachments use content-addressed blob identity:

- SHA-256 is calculated locally
- blob upload happens before the attachment create operation
- retries verify an already-existing remote blob instead of overwriting it
- downloaded bytes are verified against SHA-256 and expected size before becoming canonical locally
- a second device can reconstruct notes, folders and attachments from the remote event stream and private blob bucket

The Cloud panel displays the current cursor, pull/push counts, preserved conflicts, uploaded/downloaded blobs and queued operation count.

Phase 15 established explicit/manual replication. Phase 16 builds continuous hardened scheduling and conservative three-way Markdown merging on top of this protocol.

### Continuous/Background Sync, Advanced Conflict Resolution & Sync Hardening

Phase 16 makes adopted Vaults synchronize opportunistically while Vault is open without weakening local-first behavior.

Continuous synchronization:

- coalesces local-save, startup, reconnect, focus, visibility, cross-tab and periodic wakeups
- runs at most one replication pass per account/Vault/epoch inside a workspace
- uses Web Locks when available to avoid duplicate multi-tab sync loops
- retains **Sync now** as an explicit control/recovery path
- backs off transient failures with jitter instead of retry storms
- avoids background refresh while the Markdown editor has focused or unsaved work

Advanced Markdown conflict handling:

- the last verified remote shadow is used as the three-way merge base
- unchanged-side and identical edits resolve automatically
- clearly non-overlapping line-region edits merge automatically and are re-pushed through the normal immutable outbox
- overlapping edits, local structural changes, delete races and path collisions retain Phase 15 conflict-copy/collision behavior
- Vault never inserts conflict-marker text into canonical Markdown automatically

Browser background execution remains best-effort. Timers may be throttled or suspended by the browser, and Phase 16 does not claim guaranteed synchronization after the PWA is fully terminated.

See docs/PHASE16_SYNC_HARDENING.md.

### Realtime Sync Wakeups & Connection Resilience

Phase 17 adds a private authenticated Supabase Realtime wake path on top of the existing canonical event log.

- every committed `vault_sync_events` row emits a tiny database-originated `sync_event` Broadcast
- channel topics include both Vault ID and synchronization epoch
- Realtime RLS permits authenticated Vault members to receive that Vault/epoch topic; membership revocation is rechecked by canonical sync/Storage authorization
- the browser validates protocol/topic/payload before waking the Phase 16 coordinator
- Realtime carries only event identity metadata; Markdown text, paths and attachment bytes stay on the normal RPC/Storage path
- WebSocket heartbeat, token refresh and bounded reconnect are handled without making Realtime authoritative
- the 30-second scheduler, focus/reconnect wakeups and **Sync now** remain complete fallbacks if the socket is unavailable

This gives near-immediate cross-device convergence while Vault is open without introducing a second data model or live collaborative editing semantics.

See docs/PHASE17_REALTIME_WAKEUPS.md.

### Shared Vaults, Membership & Permission Architecture

Phase 18 adds deliberate multi-user Vault access without replacing Vault's local-first replication model.

Access model:

- every cloud Vault has exactly one canonical **owner**
- owners can create revocable one-time invitations for **editor** or **viewer** access
- editors can pull and publish normal Vault mutations through the existing protocol-v1 event stream
- viewers can pull and navigate the full Vault but cannot create, edit, move, trash, restore, change tasks/properties/boards/Canvas state, or upload attachments
- role changes are reconciled from the server into each local cloud binding; revoked replicas remain locally readable but cannot synchronize
- a viewer with pre-existing unsynchronized local writes fails closed instead of discarding or publishing them

Security and data ownership:

- membership is enforced server-side in Postgres RPCs, Storage RLS and Realtime RLS; browser UI state is not the security boundary
- canonical sync rows and blob paths remain owned by the original Vault owner, so sharing never clones, migrates or re-owns history
- collaborator actor/account IDs are recorded separately for audit provenance
- owner/editor writes still require an active DeviceId belonging to the authenticated actor
- invitation secrets are random one-time tokens; only their SHA-256 hashes are stored server-side
- removing a member blocks subsequent RPC/Storage access without deleting the member's already-downloaded local replica

Phase 18 intentionally does **not** add CRDT editing, cursor presence, simultaneous character-level collaboration or guaranteed synchronization while the browser/PWA is terminated. Realtime remains only a wakeup accelerator; the ordered event log and conflict engine remain authoritative.

See `docs/PHASE_18_ACCEPTANCE.md` and `docs/PHASE_18_RESULTS.md`.

### Live Presence & Collaborative Session Foundation

Phase 19 adds private, ephemeral collaboration awareness without changing canonical note ownership or synchronization.

- active Vault members join a separate private `vault-collab:<vault>:<epoch>` Realtime channel
- Supabase Presence carries only slow-changing session state: authenticated user/device/session UUIDs, membership role, active EntryId and editor mode
- cursor/selection offsets use throttled Broadcast rather than Presence, so cursor movement does not flood Presence synchronization
- no email address, note title/path, Markdown text, selection text or attachment bytes are sent through the collaboration channel
- remote cursor decorations render only while both sessions are on the same note **and** their lightweight Markdown fingerprints match
- cursor decorations expire locally after 8 seconds and disappear immediately after local text diverges
- owner, editor and viewer members may publish ephemeral presence/cursor metadata; Phase 18 still controls all canonical write permissions
- the existing `vault:<vault>:<epoch>` Realtime sync-wakeup channel remains separate and authoritative content continues to move only through the ordered sync RPC/Storage path

Presence metadata is advisory UI state, never an authorization source. Realtime RLS authorizes the private channel from server-side active membership. Because Realtime authorization is cached for a live channel connection, membership revocation becomes effective for the collaboration channel on reauthorization/reconnect; Vault's canonical sync/Storage authorization remains independently enforced and does not rely on Presence.

Phase 19 does **not** implement CRDT/OT text merging, simultaneous character-level editing, shared undo history or conflict-free live document mutation.

See `docs/PHASE19_COLLABORATION_PRESENCE.md` and `docs/PHASE_19_ACCEPTANCE.md`.

### Live CRDT Text Co-Editing & Shared Undo Foundation

Phase 20 adds simultaneous Markdown co-editing for active **owner/editor** members while preserving Vault's existing canonical local-first architecture.

- each active Markdown note uses an isolated private `vault-edit:<vault>:<epoch>:<entry>` Broadcast room
- Yjs `Y.Text` provides conflict-free character-level convergence between active editors
- a live room starts only from an exact verified remote-shadow base with no local dirty/outbox state
- independently opened editors apply an identical isolated canonical seed update while retaining unique live Yjs client IDs
- late joiners synchronize missing Yjs state using state vectors and an elected active room leader
- one deterministic session is the **canonical writer**; it alone feeds converged text into SaveCoordinator and the protocol-v1 sync outbox
- followers keep local recovery drafts instead of generating competing canonical dirty writes
- tasks, properties, Kanban moves, Canvas fence persistence and current-note link conversion use the same active CRDT document as normal typing
- Ctrl/Cmd+Z uses an origin-scoped Yjs UndoManager during live editing, so remote collaborators' operations are not undone by local undo
- a canonical sync push rebases the live room on the new remote revision
- incompatible-base replacement is accepted only when the receiving CRDT session has not generated local edits; otherwise Vault preserves recovery data and stops live editing

Yjs Broadcast frames can encode actual Markdown text/deltas and are treated as private note content. Supabase Realtime RLS therefore permits the CRDT room only to active `owner`/`editor` memberships. Viewers remain read-only and do not receive live-text updates.

Yjs is an **ephemeral collaboration layer**, not a second durable note database. Canonical Markdown remains in LocalRepository/IndexedDB, and durable cloud history remains in Vault's existing ordered sync event log.

See `docs/PHASE20_CRDT_EDITING.md` and `docs/PHASE_20_ACCEPTANCE.md`.

### Best-Effort Closed-App Replication & Background Sync

Phase 21 extends Vault's replication transport into the service worker where the browser exposes Background Sync / Periodic Background Sync.

- durable local saves can seal the existing protocol-v1 outbox and request one-shot `vault-background-sync`
- optional `vault-periodic-sync` registration is requested with a 12-hour minimum interval hint
- the worker can refresh the same end-user Supabase session, upload referenced attachment blobs, and submit already-sealed outbox operations
- successful worker pushes **do not** delete outbox rows; foreground sync later correlates the authoritative server event, records the remote shadow, advances the applied cursor, and acknowledges the operation
- the worker may pull ordered remote events, but writes them only to the schema-v5 `remoteInbox` staging store
- the worker never writes canonical Markdown/content stores, never advances `syncCursors`, and never performs conflict resolution
- foreground SyncEngine consumes staged inbox events before its next network pull and applies the normal Phase 15/16 conflict rules
- worker completion/error messages wake the existing foreground SyncCoordinator when a Vault window is open
- explicit sign-out clears worker-readable auth runtime

Background Sync is a **best-effort browser capability**. A successful registration means Vault asked the browser to run the task; it does not guarantee execution time, frequency, or cross-browser support. Unsupported browsers continue using normal foreground, realtime, focus/online/visibility, and explicit Sync paths.

See `docs/PHASE21_BACKGROUND_REPLICATION.md`, `docs/PHASE_21_ACCEPTANCE.md`, and `docs/PHASE_21_RESULTS.md`.

### Semantic/Block-Aware Interactive Conflict Resolution

Phase 22 turns preserved Markdown conflict copies into an explicit, durable resolution workflow without weakening Vault's conservative sync rules.

- Markdown conflicts with a verified remote shadow persist immutable **base / local / remote** snapshots in the schema-v6 `conflicts` store
- conflict metadata points to both the canonical note and the preserved local conflict copy
- Markdown is split into bounded semantic blocks: frontmatter, headings, paragraphs, lists, blockquotes, fenced code, tables, thematic breaks and spacing
- one-sided or identical block edits are merged automatically in the resolver plan
- genuinely overlapping regions require an explicit choice: **local**, **remote**, **base**, **both local→remote**, or **both remote→local**
- the resolver shows the three variants and a complete resolution preview before applying
- the canonical note may be overwritten only if it still matches the captured remote snapshot (or already matches the chosen resolution)
- if the canonical note changed after capture, Vault refuses the resolution instead of overwriting newer work
- an untouched preserved local copy is moved to Trash after resolution; an edited conflict copy is retained
- resolved records keep their original snapshots and chosen `resolutionText` for audit/backup history
- full Vault snapshots/archives include conflict metadata
- very large notes degrade to a conservative coarse conflict region instead of unbounded block-LCS work

Structural/path/delete races and non-Markdown conflicts still use the existing conservative conflict-copy workflow; Phase 22 does not guess semantics where it lacks a safe Markdown base.

See `docs/PHASE22_INTERACTIVE_CONFLICTS.md`, `docs/PHASE_22_ACCEPTANCE.md`, and `docs/PHASE_22_RESULTS.md`.

### Durable CRDT Collaboration Journal & Session Recovery

Phase 23 makes Phase 20 live collaboration recoverable across reload/crash without turning Yjs into a second canonical note database.

- schema-v7 `crdtSessions` stores exact canonical-base/session metadata including immutable base Markdown
- schema-v7 `crdtUpdates` stores bounded Yjs update bytes for local replay
- local Yjs updates are persisted **before** Broadcast to peers
- remote/sync-response updates are journaled before local application
- replay runs only when Vault verifies the exact same Vault/Entry/epoch/revision/fingerprint base
- retained updates are applied to a fresh seeded Y.Doc before the Realtime edit room joins
- follower edits can survive reload even when they were never written into canonical `contents`
- a room is marked canonicalized only after the verified remote shadow advances to the exact converged Yjs Markdown
- canonicalized rooms are excluded from automatic crash replay but remain inspectable until bounded retention pruning
- `Collab history` reconstructs retained sessions read-only and can download or save the replayed Markdown as a **new note**
- history recovery never overwrites the canonical note
- individual updates are capped at 768 KiB; one active local journal session at 16 MiB
- canonicalized history is retained for up to 30 days and pruned toward a 64 MiB per-Vault budget

The CRDT journal is auxiliary local recovery/history state. Canonical Markdown remains `contents`/SaveCoordinator, and durable cloud history remains the protocol-v1 ordered remote event log.

See `docs/PHASE23_CRDT_JOURNAL.md`, `docs/PHASE_23_ACCEPTANCE.md`, and `docs/PHASE_23_RESULTS.md`.

## Canonical data

```text
CodeMirror / Properties / Templates / Tasks / Query definitions
                 ↓
          Markdown + YAML
                 ↓
          SaveCoordinator
                 ↓
          LocalRepository
                 ↓
             IndexedDB
                 │
                 └─ binary attachment store

Markdown
   ├─→ linked-knowledge index
   ├─→ search worker index
   ├─→ calendar projection
   ├─→ task projection
   ├─→ dynamic query projection
   ├─→ knowledge graph projection
   └─→ Kanban board projection
```

Daily Notes, templates, query definitions, boards and canvases remain Markdown-authored concepts. Embedded tasks remain readable Markdown checkboxes but now carry stable hidden A2 task IDs and are mirrored as first-class Task entities. Attachment metadata is canonical structured state while binary payloads are content-addressed and prefer OPFS with IndexedDB fallback. Query, graph, board and canvas render state remains disposable projection state.

## Not implemented yet

- global cross-user undo timeline
- guaranteed cross-browser closed-app execution / exact background-sync scheduling

## Development

Requires Node 22.12+.

```bash
npm ci
npm test
npm run benchmark:search
npm run benchmark:interop
npm run benchmark:sync-foundation
npm run benchmark:replication
npm run benchmark:sync-hardening
npm run benchmark:realtime-wakeup
npm run benchmark:collaboration
npm run benchmark:crdt
npm run benchmark:conflicts
npm run benchmark:journal
npm run build
npm run test:e2e
```

CI runs strict TypeScript, all core contracts including background-replication, persistent-conflict and CRDT-journal safety, search/graph/board/Canvas/Obsidian-migration/sync/realtime/presence/CRDT/conflict-planner/journal-replay performance gates, production Vite build and real Chromium desktop/mobile acceptance.

## Product identity

- Product: **Vault**
- Repository: **thiepn/vault**
- Package: **@thiepn/vault**
- Current package version: **0.23.0-phase23**

Vault does not use Obsidian proprietary source code, assets, branding or plugin runtime.
