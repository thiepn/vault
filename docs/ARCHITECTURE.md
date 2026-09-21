# Vault architecture

## Canonical-data rule

- Markdown + YAML frontmatter = authored content/metadata truth
- Markdown checkbox lines = task truth
- IndexedDB repository = local identity/durability truth
- CodeMirror = active editing state
- template configuration = stable IDs/settings only
- knowledge/search indexes = rebuildable acceleration
- calendar/tasks views = derived projections
- future cloud database = synchronization/remote identity truth

No UI projection is a proprietary note/task store.

## Local write path

```text
CodeMirror / Properties / template generation / task mutation
→ canonical Markdown string
→ SaveCoordinator or version-checked LocalRepository.saveMarkdown
→ IndexedDB
→ derived knowledge/search/calendar/task refresh
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

## Knowledge index

The derived knowledge record stores aliases, headings, block IDs, links, tags, properties and parsed task projections. Its version advances when parser semantics change; it remains reconstructable from Markdown.

## Search

Search runs in a dedicated module Web Worker. Phase 7 extends structured task filters with open/done, overdue/today/upcoming/undated, recurring, scheduled, due and priority categories.

## Calendar

Calendar date cells combine:

- Daily Note identity
- YAML date-property associations
- open task scheduled/due dates

Completed tasks are not projected as active calendar tasks.

## Rendering trust boundary

Untrusted Markdown is compiled/sanitized before controlled rendering enhancements. Task controls operate on parsed source lines rather than rendered HTML.

## File identity

Paths are not permanent identity. Files/folders use immutable UUIDs.

## Sync boundary

Cloud sync remains inactive. Future sync must synchronize canonical Markdown/stable metadata, not derived task/search/calendar projections.
