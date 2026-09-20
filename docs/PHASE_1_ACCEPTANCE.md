# Phase 1 acceptance

## Result

**ACCEPTED — browser-certified in Chromium.**

The committed production build satisfies the Phase 1 gate for the local vault and file-system foundation.

## Accepted behavior

- create, switch and rename vaults
- create nested folders and Markdown notes
- persist Markdown locally through refresh/reopen
- rename and move files/folders while preserving immutable IDs
- recursively duplicate folders
- collision-safe duplicate naming
- Trash and restore
- stale/deleted-write recovery preservation
- explorer collapse/filter/sort controls
- drag/drop movement
- responsive mobile shell
- local export/recovery foundations

## Browser gate

Chromium acceptance executes against the production Vite build with native IndexedDB, not an in-memory database replacement.

The certified CI flow validates:

1. production dependencies install
2. core TypeScript compiles
3. repository/contract tests pass
4. Vite production build succeeds
5. Chromium is installed
6. desktop lifecycle survives reload
7. mobile create/edit/reload survives reload

## Phase boundary

No cloud synchronization, account, CodeMirror, search/index, backlink, task, graph, Kanban or Canvas functionality belongs to Phase 1.

Phase 2 can now build the professional Markdown editor/rendering layer on top of the accepted repository contracts.
