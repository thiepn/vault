# Phase 2 results — professional Markdown editor

## Status
**Phase 2 is implemented and browser-certified in Chromium.**

Phase 2 replaces the Phase 1 textarea workbench with CodeMirror 6 while retaining the accepted repository and IndexedDB durability model.

## Editing
- CodeMirror 6
- Source mode, Live Preview foundation and Reading mode
- Markdown language support and syntax highlighting
- undo/redo, search/replace, multi-cursor and standard CodeMirror editing
- line wrapping and optional line numbers
- Markdown formatting commands, shortcuts and mobile toolbar
- word/character/selection/line/column statistics

## Live Preview foundation
Semantic decorations come from CodeMirror's incremental Markdown syntax tree for headings, bold, emphasis, inline code, links, blockquotes and fenced code. Syntax intentionally stays visible/editable; concealment and Wiki-link widgets belong in Phase 3.

## Reading mode
- GFM Markdown via Marked
- GFM tables
- KaTeX math
- highlighted fenced code and copy control
- normal/collapsible callouts
- Mermaid diagrams
- safe external links
- responsive images

Mermaid is dynamically imported only when a rendered note contains a Mermaid block.

## Security
Marked output is sanitized with DOMPurify before entering the application DOM. Browser acceptance verifies that scripts and inline event-handler attributes do not survive and a test XSS payload does not execute. Mermaid uses strict security and its SVG is sanitized.

## Persistence
CodeMirror document transactions feed the existing SaveCoordinator. Markdown remains canonical. Mode switching creates no proprietary representation. Reading mode flushes pending local changes before rendering.

## Verification
The green Phase 2 certification run passed strict core TypeScript compilation, 11 committed Node tests with 0 failures, the React/Vite production build, Phase 1 desktop/mobile regressions, the Phase 2 desktop rich editor/rendering workflow, and the Phase 2 mobile editor workflow.

The desktop browser test covers Live Preview decoration, search, line-number persistence, Reading mode, tables, KaTeX, callouts, code highlighting, Mermaid, XSS sanitization, Source round-trip, formatting commands and IndexedDB persistence through reload.

## Bundle note
Mermaid is a substantial optional dependency and is dynamically imported. Broader bundle optimization remains a later performance-hardening concern rather than changing Phase 2 editor semantics.

## Deferred to later phases
- Wiki links/backlinks/transclusion
- syntax-concealing linked-note Live Preview
- worker search/indexing
- properties, tasks, calendar and templates
- cloud synchronization
- attachments
- graph, Kanban and Canvas
