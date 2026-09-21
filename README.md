# Vault

**Vault** is a browser-first, local-first Markdown knowledge system.

Vault keeps ordinary Markdown as the source of truth while providing a serious browser application around it.

The repository currently includes browser-certified:

- **Phase 1 — Vault & File System**
- **Phase 2 — Professional Markdown Editor**
- **Phase 3 — Linked Knowledge System**
- **Phase 4 — Index + Search Engine**
- **Phase 5 — Properties & Metadata**
- **Phase 6 — Templates, Daily Notes & Calendar**

## Current capabilities

### Vault and files

- multiple local vaults
- nested folders
- stable immutable file/folder IDs
- create, edit, rename, move and recursively duplicate
- drag/drop movement
- Trash and restore
- IndexedDB persistence
- autosave version checks
- recovery drafts and checkpoints
- Markdown ZIP / recovery export
- responsive desktop/mobile shell

### Markdown editor

- CodeMirror 6
- Source, Live Preview and Reading modes
- undo/redo, multi-cursor, find/replace
- syntax highlighting and formatting controls
- GFM tables
- fenced code highlighting
- KaTeX math
- callouts
- Mermaid
- sanitized Reading mode

### Linked knowledge

- Wiki links and aliases
- heading and block links
- embedded notes/headings/blocks
- note/alias/heading/block autocomplete
- backlinks
- unlinked mentions
- outline navigation
- automatic parsed-link maintenance on rename/move
- unresolved-note creation
- cycle/depth-safe transclusion

### Search

- dedicated Web Worker index
- full-text and phrase search
- Boolean AND / OR / NOT
- file/path/tag/property/task filters
- nested tags
- property comparisons
- result snippets and exact source offsets
- tag/property facets
- Quick Switcher
- incremental index maintenance
- worker recovery/rebuild
- 10,000-note CI benchmark

### Visual Properties

- YAML frontmatter remains canonical
- visual add/edit/rename/delete
- text, number, boolean, date, list, tags and null
- comment/order preservation for supported edits
- LF/CRLF preservation
- complex YAML read-only fallback
- Source-mode escape hatch
- automatic knowledge/search reindex

### Templates

Templates are ordinary Markdown notes stored in a configured Templates folder.

Supported variables include:

- `{{title}}`
- `{{date}}`
- `{{time}}`
- `{{datetime}}`
- `{{weekday}}`
- `{{year}}`, `{{month}}`, `{{day}}`
- `{{yesterday}}`, `{{tomorrow}}`
- `{{date:YYYY-MM-DD}}` and other supported date patterns
- `{{cursor}}`

Templates can be:

- inserted into an existing note
- used explicitly when creating a note
- configured as the vault default
- configured per destination folder
- configured specifically for Daily Notes

### Daily Notes & Calendar

- configurable Daily Notes folder
- configurable Daily Note template
- configurable filename format
- collision-safe requirement that formats contain year/month/day
- previous / today / next navigation
- `Ctrl/Cmd + Shift + D` opens today's Daily Note
- auto-open existing daily file or create it
- default Markdown Daily Note when no template is selected
- Monday-first 6-week calendar
- markers for existing Daily Notes
- markers/counts for notes carrying any `YYYY-MM-DD` YAML property
- calendar → Daily Note navigation
- desktop and mobile Calendar workflows

## Canonical data

```text
CodeMirror / Visual Properties / Templates
        ↓
ordinary Markdown + YAML
        ↓
SaveCoordinator
        ↓
LocalRepository
        ↓
IndexedDB

Markdown
   ├─→ linked-knowledge index
   └─→ search worker index
```

Templates and Daily Notes are files, not proprietary records. Calendar/search/knowledge structures are derived or configuration-only and can be rebuilt from canonical notes.

## Not implemented yet

- advanced task-management UI
- Dataview-like query language/views
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

CI runs strict TypeScript, all core contracts, the 10k search benchmark, the production Vite build, and real Chromium desktop/mobile acceptance.

See `docs/ARCHITECTURE.md` and the phase result/acceptance documents under `docs/`.

## Product identity

- Product: **Vault**
- Repository: **thiepn/vault**
- Package: **@thiepn/vault**
- Current package version: **0.6.0-phase6**

Vault does not use Obsidian proprietary source code, assets, branding, or plugin runtime.
