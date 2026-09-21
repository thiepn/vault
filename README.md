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

## Canonical data

```text
CodeMirror / Properties / Templates / Tasks UI
                 ↓
          Markdown + YAML
                 ↓
          SaveCoordinator
                 ↓
          LocalRepository
                 ↓
             IndexedDB

Markdown
   ├─→ linked-knowledge index
   ├─→ search worker index
   ├─→ calendar projection
   └─→ task projection
```

Tasks, Daily Notes and templates are files/text—not proprietary application records.

## Not implemented yet

- Dataview-like query blocks/dynamic views
- cloud accounts and cross-device sync
- attachments
- graph/local graph visualization
- Kanban
- Canvas
- PWA cold-start/offline shell
- external Markdown/Obsidian import

## Development

Requires Node 22.12+.

```bash
npm ci
npm test
npm run benchmark:search
npm run build
npm run test:e2e
```

CI runs strict TypeScript, all core contracts, the 10k search benchmark, production Vite build and real Chromium desktop/mobile acceptance.

## Product identity

- Product: **Vault**
- Repository: **thiepn/vault**
- Package: **@thiepn/vault**
- Current package version: **0.7.0-phase7**

Vault does not use Obsidian proprietary source code, assets, branding or plugin runtime.
