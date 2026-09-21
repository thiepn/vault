# Vault architecture

## Canonical-data rule

- Markdown + YAML frontmatter = authored content/metadata truth
- IndexedDB repository = local identity/durability truth
- CodeMirror = active editing state
- template configuration = stable IDs/settings only
- knowledge/search indexes = rebuildable acceleration
- calendar view = derived navigation
- future cloud database = synchronization/remote identity truth

No editor view, Properties panel, template system, calendar, or derived index is a proprietary note store.

## Local write path

```text
CodeMirror / Visual Properties / generated template text
→ canonical Markdown string
→ SaveCoordinator
→ LocalRepository.saveMarkdown(expectedVersion)
→ IndexedDB transaction
```

Stale writes are rejected rather than silently overwriting canonical content.

## Phase 5 — Properties

Visual Properties edits the YAML document inside the note.

```text
Markdown
→ frontmatter envelope
→ YAML Document AST
→ typed visual controls
→ targeted YAML mutation
→ same Markdown body
→ normal save path
```

Supported visual values are strings, finite numbers, booleans, dates, nulls and scalar lists. Complex nested YAML remains source-editable rather than being flattened.

## Phase 6 — Templates

Template source is a normal Markdown file identified by immutable entry ID.

Settings may store:

- Templates folder ID
- default template ID
- Daily Notes folder ID
- Daily Note template ID
- Daily filename format
- folder-ID → template-ID mapping

They do **not** store template bodies.

```text
template Markdown
→ variable expansion
→ ordinary Markdown text
→ create note / insert at CodeMirror selection
```

Unknown template variables remain unchanged. `{{cursor}}` is removed from output and represented only as an ephemeral editor cursor offset.

A configured template is not recursively applied to files created inside the Templates folder.

## Daily Note identity

A Daily Note is identified by:

1. configured Daily Notes folder ID
2. configured filename date pattern
3. the resulting Markdown filename

The default format is `YYYY-MM-DD`.

Formats must include year, month and day and must generate a portable filename. This prevents multiple dates from collapsing onto the same note.

Daily creation is idempotent at the UI layer: if the expected file already exists, Vault opens it instead of creating a duplicate.

## Calendar derivation

The Calendar does not own events.

It combines:

- Daily Note filenames from the configured Daily folder
- any exact `YYYY-MM-DD` scalar/list values found in parsed YAML properties

```text
Markdown files + derived KnowledgeRecord properties
→ date association map
→ Monday-first 42-cell calendar month
→ Daily Note + associated-note markers
```

Clicking an empty calendar date creates/opens that date's Daily Note. Clicking an existing date opens the same canonical Daily Note.

## Linked knowledge

The versioned derived `knowledge` store contains aliases, headings, block IDs, Wiki references, tags, properties and tasks. It is reconstructable from Markdown.

## Search

Search is performed in a dedicated module Web Worker over disposable indexes. Edits, property changes, note creation and metadata moves are incrementally reconciled.

## Rendering trust boundary

```text
untrusted Markdown
→ Markdown/Wiki compilation
→ KaTeX
→ DOMPurify
→ controlled enhancements
```

Raw note HTML is not trusted application code.

## File identity

Paths are not permanent identity. Files/folders use immutable UUIDs. Rename/move changes path metadata while keeping identity/history.

## Sync boundary

Cloud sync remains inactive. Future sync must synchronize canonical notes and stable metadata, not derived search/calendar/index state.
