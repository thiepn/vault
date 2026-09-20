# Vault

**Vault** is a browser-first, local-first Markdown knowledge system.

The goal is an original web application with linked Markdown notes, cross-device synchronization, tasks, queries, calendar, graph, Canvas, mobile/PWA support, and ordinary Markdown portability. The repository currently includes the browser-certified **Phase 1 file system** and **Phase 2 professional Markdown editor**.

## Current capabilities

### Vault and file system
- multiple local vaults and nested folders
- stable immutable file/folder IDs
- create, edit, rename, move and recursively duplicate
- drag/drop movement and collision-safe names
- collapsible/filterable/sortable explorer
- Trash and restore
- local IndexedDB persistence
- autosave version checks, recovery drafts and checkpoints
- Markdown ZIP and recovery export
- responsive desktop/mobile shell

### Markdown editor
- CodeMirror 6
- Source mode
- syntax-tree-driven Live Preview foundation
- Reading mode
- GFM Markdown rendering
- undo/redo and editor history
- find/replace
- multi-cursor and standard CodeMirror editing
- word wrap, indentation and syntax highlighting
- optional line numbers
- word/character/selection/line/column statistics
- desktop formatting shortcuts and mobile toolbar
- headings, lists, tasks, quotes and links
- fenced code with highlighting and copy control
- GFM tables
- KaTeX inline/block mathematics
- callouts
- Mermaid diagrams loaded on demand

### Rendering security
Reading mode never treats note HTML as trusted application code. The pipeline is Markdown -> Marked/KaTeX -> DOMPurify -> controlled callout/code/Mermaid enhancements. Script elements, inline event handlers, iframes, objects, embeds and forms are not trusted. Mermaid uses strict security and its SVG output is sanitized before insertion.

## Data model
Markdown remains canonical. CodeMirror transactions feed the existing SaveCoordinator, which writes through LocalRepository into IndexedDB. The editor is not a second database, and changing editor mode never creates a proprietary alternate note representation.

## Deliberately not implemented yet
- Wiki links/backlinks/transclusion
- full-text worker indexing/search
- visual YAML properties
- templates/daily notes/calendar/tasks
- cloud accounts and cross-device synchronization
- attachment management
- graph/local graph
- Kanban
- Canvas
- PWA cold-start/offline shell
- external Markdown/Obsidian import

## Development

Requires Node 22.12+.

    npm ci
    npm test
    npm run build
    npm run test:e2e

GitHub CI uses the committed lockfile, strict TypeScript, the production Vite build, and real Chromium desktop/mobile acceptance against native IndexedDB.

See `docs/ARCHITECTURE.md`, `docs/PHASE_1_RESULTS.md`, `docs/PHASE_2_RESULTS.md`, and `docs/PHASE_2_ACCEPTANCE.md`.

## Product identity
- Product: **Vault**
- Repository: **thiepn/vault**
- Package: **@thiepn/vault**

Vault does not use Obsidian branding, proprietary source code/assets, or the Obsidian third-party plugin runtime.
