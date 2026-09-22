# Phase 12 acceptance — Canvas & Spatial Knowledge Workspace

## Result

**ACCEPTED — Markdown-backed spatial Canvas is certified on the current A1/A2 mainline.**

## Acceptance criteria

- Canvas documents remain inside canonical Markdown
- Canvas geometry is treated as authored content
- no separate whiteboard database is introduced
- strict versioned Canvas parser exists
- stable Canvas/node/edge/group IDs are preserved
- malformed/unsafe Canvas source fails closed
- note cards resolve through Vault knowledge resolution
- media cards reuse the attachment subsystem
- text cards remain plain text
- card move persists authored x/y coordinates
- card resize persists dimensions
- group move/resize persists geometry
- directed connections persist
- connection labels persist
- deleting a node removes incident edges
- pan/zoom/Fit work
- viewport is persisted
- keyboard pan/zoom works
- desktop classic mouse gestures work
- Pointer Events support mouse/touch/pen
- gesture paths cannot double-start
- grid snapping works
- fullscreen expansion works
- Live Preview Canvas widgets work
- active widgets survive their own canonical saves
- Canvas source remains directly editable
- Reading-mode Canvas renders only after sanitization
- Canvas source never executes HTML/JavaScript
- current-note Canvas saves use SaveCoordinator
- embedded/other-note Canvas saves are version checked
- completed gestures enqueue persistence before later navigation
- note/media open navigation works
- mobile controls remain usable
- reload preserves Canvas geometry/connections
- existing Markdown ZIP/recovery export naturally preserves Canvas source
- Canvas integrates with A2LocalRepository/A2Persistence
- A1/A2 canonical/storage tests remain green
- maximum-size Canvas stays inside performance budget
- Phase 1–11 browser regressions remain green
- production TypeScript/Vite build passes

## Certification

Authoritative integration CI: **run 35686226952 / #207**

- **87 core tests passed**
- 10k search benchmark passed
- 10k graph benchmark passed
- 10k board benchmark passed
- max Canvas benchmark passed:
  - 1,000 nodes
  - 2,000 edges
  - 100 groups
  - 244,147-byte source
  - **204.0 ms parse**
  - **70.9 ms serialize**
- production build passed
- **26 applicable Chromium desktop/mobile scenarios passed**
- **26 opposite-device scenarios skipped by design**
- **0 failures**

## Release boundary

Phase 12 does not introduce collaborative cursors, multiplayer editing, freehand drawing, arbitrary rich-object plugins or a proprietary binary Canvas format.

Future Canvas extensions must continue to preserve:

1. canonical Markdown ownership,
2. stable object identity,
3. A2 version/repair semantics,
4. safe sanitized rendering,
5. exportability without a hidden database.
