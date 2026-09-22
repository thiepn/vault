# Vault architecture

## Canonical-data rule

- Markdown + YAML frontmatter = authored content/metadata truth
- Markdown checkbox lines = task truth
- IndexedDB repository = local identity/durability truth
- CodeMirror = active editing state
- template configuration = stable IDs/settings only
- knowledge/search indexes = rebuildable acceleration
- calendar/tasks/query/graph/board views = derived projections
- Canvas geometry = authored Markdown content, not a derived projection
- attachment store = local binary payload truth keyed by stable entry ID
- future cloud database = synchronization/remote identity truth

No UI projection is a proprietary note/task/query-result store. Binary files are intentionally not encoded into Markdown; Markdown stores readable attachment references while IndexedDB owns the local bytes.

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

Cloud sync remains inactive. Future sync must synchronize canonical Markdown, stable entry metadata and attachment payloads, not derived task/search/calendar/query projections.
