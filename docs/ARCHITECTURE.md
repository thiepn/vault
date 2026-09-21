# Vault architecture

## Canonical-data rule

- Markdown + YAML frontmatter = authored content/metadata truth
- Markdown checkbox lines = task truth
- IndexedDB repository = local identity/durability truth
- CodeMirror = active editing state
- template configuration = stable IDs/settings only
- knowledge/search indexes = rebuildable acceleration
- calendar/tasks/query views = derived projections
- future cloud database = synchronization/remote identity truth

No UI projection is a proprietary note/task/query-result store.

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

Cloud sync remains inactive. Future sync must synchronize canonical Markdown/stable metadata, not derived task/search/calendar/query projections.
