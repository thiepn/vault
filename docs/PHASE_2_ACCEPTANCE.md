# Phase 2 acceptance

## Result
**ACCEPTED — browser-certified in Chromium with a reproducible locked dependency graph.**

## Acceptance criteria
- Phase 1 storage regressions remain green
- CodeMirror is the actual editing surface
- Markdown remains canonical
- Source mode round-trips Markdown
- Live Preview adds semantic presentation without breaking editing
- Reading mode renders rich Markdown
- autosave uses the existing durability pipeline
- history and find/replace work
- headings, lists, links, code, tables, math and callouts are usable
- mobile editing remains usable
- unsafe note HTML cannot execute script
- production TypeScript/Vite build succeeds
- Chromium desktop/mobile acceptance succeeds
- CI installs from the committed package-lock with npm ci

## Verified browser behaviors
1. Phase 1 desktop file lifecycle and IndexedDB reload
2. Phase 1 mobile file lifecycle
3. Phase 2 desktop CodeMirror editing
4. Source / Live Preview / Reading switching
5. search and replace panel
6. line-number persistence
7. rich reading-mode rendering
8. KaTeX
9. code highlighting
10. callouts
11. Mermaid
12. XSS sanitization
13. formatting commands
14. Markdown persistence through reload
15. mobile toolbar and mode switching

## Phase boundary
Wiki-link completion, backlinks, block links, embeds and automatic link updating belong to **Phase 3 — Linked Knowledge System**.
