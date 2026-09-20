# Vault

**Vault** is a browser-first, local-first Markdown knowledge system.

The goal is an original web application with linked Markdown notes, cross-device synchronization, tasks, queries, calendar, graph, Canvas, mobile/PWA support, and ordinary Markdown portability.

The repository currently includes the browser-certified **Phase 1 file system**, **Phase 2 professional Markdown editor**, **Phase 3 linked knowledge system**, and **Phase 4 index + search engine**.

## Current capabilities

### Vault and file system

- multiple local vaults and nested folders
- stable immutable file/folder IDs
- create, edit, rename, move and recursively duplicate
- drag/drop movement and collision-safe names
- collapsible/filterable/sortable explorer
- Trash and restore
- native IndexedDB persistence
- autosave version checks, recovery drafts and checkpoints
- Markdown ZIP and recovery export
- responsive desktop/mobile shell

### Markdown editor

- CodeMirror 6
- Source, Live Preview and Reading modes
- syntax-tree-driven live formatting
- undo/redo, find/replace and multi-cursor editing
- word wrap, indentation and syntax highlighting
- line numbers and document/cursor statistics
- desktop formatting shortcuts and mobile toolbar
- GFM tables
- highlighted fenced code
- KaTeX mathematics
- callouts
- Mermaid diagrams loaded on demand
- sanitized reading-mode HTML

### Linked knowledge

- Wiki links: `[[Note]]`
- aliases: `[[Note|label]]`
- heading links: `[[Note#Heading]]`
- block links: `[[Note#^block-id]]`
- current-note fragments
- embedded notes/headings/blocks with `![[...]]`
- cycle/depth-safe transclusion
- `[[` autocomplete for notes, aliases, headings and blocks
- duplicate-title/path disambiguation
- cursor-aware Live Preview concealment for Wiki-link syntax
- Ctrl/Cmd-click Wiki navigation
- resolved / ambiguous / unresolved link states
- create-a-note flow for unresolved links
- backlinks
- unlinked mentions with one-click link conversion
- outline navigation and current-section highlighting
- automatic parsed-link updates after note/folder rename or move
- per-vault toggle for automatic link updates
- mobile Knowledge drawer

### Index + search

- dedicated Web Worker search/index engine
- vault-wide full-text search
- phrase search
- Boolean `AND` / `OR` / `NOT`
- negative terms with `-`
- filename filters: `file:`
- path filters: `path:`
- tag filters: `tag:`
- nested tag-prefix matching
- property existence/comparison filters: `property:`
- numeric/string/boolean property comparisons
- task filters: `task:open`, `task:done`, `task:any`
- indexed titles, paths, aliases, headings, body text, tags, properties and tasks
- highlighted search snippets
- exact source offsets for opening matches
- tag/property facets
- Quick Switcher with title/alias/path fuzzy ranking and recency
- incremental index updates after edits, rename, move and deletion
- rebuild/reconciliation after concurrent changes
- worker crash restart/rebuild handling
- mobile Search/Tags navigation
- 10,000-note performance certification

## Data model

Markdown remains canonical.

```text
CodeMirror
→ SaveCoordinator
→ LocalRepository
→ IndexedDB canonical Markdown

Markdown
→ Knowledge parser
→ derived knowledge records
→ Search Worker
→ disposable full-text/facet indexes
```

The knowledge and search indexes are acceleration layers. They can be discarded and rebuilt from canonical Markdown and stable file metadata.

## Rendering security

Reading mode does not trust raw note HTML. Markdown is compiled, sanitized with DOMPurify, then enhanced through controlled callout/code/Mermaid/Wiki-link handling. Mermaid uses strict security and its SVG is sanitized.

## Deliberately not implemented yet

- visual YAML properties editor
- templates/daily notes/calendar
- advanced task management
- cloud accounts and cross-device synchronization
- attachment management
- graph/local graph visualization
- Kanban
- Canvas
- PWA cold-start/offline shell
- external Markdown/Obsidian vault import

## Development

Requires Node 22.12+.

```bash
npm ci
npm test
npm run benchmark:search
npm run build
npm run test:e2e
```

GitHub CI uses the committed lockfile, strict TypeScript, the 10k search benchmark, the production Vite build, and real Chromium desktop/mobile acceptance against native IndexedDB.

See:

- `docs/ARCHITECTURE.md`
- `docs/PHASE_1_RESULTS.md`
- `docs/PHASE_2_RESULTS.md`
- `docs/PHASE_3_RESULTS.md`
- `docs/PHASE_4_RESULTS.md`
- `docs/PHASE_4_ACCEPTANCE.md`

## Product identity

- Product: **Vault**
- Repository: **thiepn/vault**
- Package: **@thiepn/vault**

Vault does not use Obsidian branding, proprietary source code/assets, or the Obsidian third-party plugin runtime.
