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

## Permanent architecture program

The Phase 1–15 product now runs on the **A1/A2 permanent local foundation**.

**A1 — Canonical Domain & Data Model** defines stable first-class identities/contracts for Notes, Folders, Tasks, Events, Projects, People, Attachments, Captures, Collections and explicit Links. New A-series entities use offline UUIDv7 IDs while existing Entry UUIDs are preserved.

**A2 — Local Storage, Serialization & Offline Persistence** is implemented with:

- IndexedDB schema v4 as the transactional local persistence layer
- canonical `entities` and split `noteBodies` stores alongside compatibility stores
- stable hidden IDs for Markdown-embedded tasks
- content-addressed SHA-256 attachment blobs
- OPFS-preferred blob persistence with IndexedDB fallback
- migration/repair state plus Web Locks coordination
- BroadcastChannel invalidation
- persistent-storage requests and quota/health support
- full-fidelity Vault archives with checksums
- service-worker application-shell caching and cold offline PWA startup
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

Phase 15 does not claim real-time/background synchronization or automatic diff3 text merging. Those are later hardening/workflow layers.
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

- continuous/background sync scheduling
- automatic diff3 merge for independently edited Markdown regions

## Development

Requires Node 22.12+.

```bash
npm ci
npm test
npm run benchmark:search
npm run benchmark:interop
npm run benchmark:sync-foundation
npm run benchmark:replication
npm run build
npm run test:e2e
```

CI runs strict TypeScript, all core contracts, search/graph/board/Canvas/Obsidian-migration/sync-foundation/remote-replication performance gates, production Vite build and real Chromium desktop/mobile acceptance.

## Product identity

- Product: **Vault**
- Repository: **thiepn/vault**
- Package: **@thiepn/vault**
- Current package version: **0.15.0-phase15**

Vault does not use Obsidian proprietary source code, assets, branding or plugin runtime.
