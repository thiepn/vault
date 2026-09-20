# Vault

**Vault** is a browser-first, local-first Markdown knowledge system.

The goal is an original web application with Obsidian-style linked knowledge, cross-device synchronization, tasks, queries, calendar, graph, Canvas, mobile/PWA support, and ordinary Markdown portability.

The repository currently includes the browser-certified **Phase 1 file system**, **Phase 2 professional Markdown editor**, and **Phase 3 linked knowledge system**.

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

## Data model

Markdown remains canonical.

```text
CodeMirror
→ SaveCoordinator
→ LocalRepository
→ IndexedDB canonical Markdown

Markdown
→ Knowledge parser/index
→ derived aliases/headings/blocks/links/backlinks
```

The Phase 3 knowledge index is disposable and rebuildable. It never becomes the only copy of a link, alias, heading, block, or note.

## Rendering security

Reading mode does not trust raw note HTML. Markdown is compiled, sanitized with DOMPurify, then enhanced through controlled callout/code/Mermaid/Wiki-link handling. Mermaid uses strict security and its SVG is sanitized.

## Deliberately not implemented yet

- Phase 4 worker-backed global full-text search/index UI
- tag browser and property indexing UI
- quick switcher
- visual YAML properties
- templates/daily notes/calendar/tasks
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
npm run build
npm run test:e2e
```

GitHub CI uses the committed lockfile, strict TypeScript, the production Vite build, and real Chromium desktop/mobile acceptance against native IndexedDB.

See:

- `docs/ARCHITECTURE.md`
- `docs/PHASE_1_RESULTS.md`
- `docs/PHASE_2_RESULTS.md`
- `docs/PHASE_3_RESULTS.md`
- `docs/PHASE_3_ACCEPTANCE.md`

## Product identity

- Product: **Vault**
- Repository: **thiepn/vault**
- Package: **@thiepn/vault**

Vault does not use Obsidian branding, proprietary source code/assets, or the Obsidian third-party plugin runtime.
