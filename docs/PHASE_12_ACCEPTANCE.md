# Phase 12 acceptance — Canvas & Spatial Knowledge Workspace

## Result

**ACCEPTED — Markdown-backed spatial Canvas is browser-certified.**

## Acceptance criteria

- Canvas remains authored Markdown content
- no separate whiteboard database is introduced
- explicit `vault-canvas` fences parse strictly
- stable Canvas ids are required
- stable node/edge/group ids are required
- note cards resolve against Vault notes
- media cards resolve against Vault attachments
- text cards store plain authored text
- note cards can open their source note
- media cards can open their attachment
- card movement works
- card resizing works
- visual groups work
- group movement works
- group resizing works
- directed connections work
- connection labels work
- connection deletion works
- deleting a node removes incident connections
- add/edit/delete workflows work
- grid snapping works
- free positioning modifier works
- pan works
- wheel/button zoom works
- Fit works
- keyboard pan/zoom works
- fullscreen expansion works
- mobile controls remain touch-usable
- Canvas viewport persists
- Canvas geometry persists
- connections persist
- groups persist
- reload restores authored Canvas state
- Live Preview Canvas works
- Canonical source remains directly editable
- Reading-mode Canvas renders after sanitization
- embedded Canvas owner context is preserved
- Canvas YAML never executes HTML/JavaScript
- current-note edits use SaveCoordinator
- non-current/embedded Canvas edits use stale-write protection
- persistence is enqueued before navigation/mode-switch actions
- active Canvas widgets are not torn down by their own save
- detached Canvas views clean up observers/listeners
- Pointer Events work for touch/pen/mouse
- classic mouse fallback works
- event-family double starts are guarded
- source safety limits fail closed
- maximum-size Canvas parse/serialize stays within CI budgets
- Phase 1–11 regressions remain green
- production TypeScript/Vite build passes

## Certification

CI run **35681757888**:

- **73 core tests passed**
- 10k search benchmark passed
- 10k graph benchmark passed
- 10k board benchmark passed
- maximum-size Canvas benchmark passed
  - 1,000 nodes
  - 2,000 edges
  - 100 groups
  - 244,147 bytes
  - **222.5 ms parse**
  - **75.3 ms serialize**
- production build passed
- **24 applicable Chromium desktop/mobile scenarios passed**
- **24 opposite-device scenarios skipped by design**
- **0 failures**

The certification branch contained the identical Phase 12 implementation/tests plus only a temporary CI push-trigger line because GitHub was no longer generating synchronize runs for the original PR.

## Release boundary

Phase 12 deliberately keeps the spatial document inside Markdown.

A future sync implementation should synchronize the Markdown note containing the Canvas and referenced attachment bytes. It should not introduce a second independently synchronized Canvas geometry database.
