# Phase 12 results — Canvas & Spatial Knowledge Workspace

## Status

**Phase 12 is implemented, rebased onto the current A1/A2 mainline, and browser-certified in Chromium.**

Authoritative integration branch: `phase-12-spatial-canvas-integration`

Certification run: **35686226952** (CI run #207)

## Canonical model

A Canvas is authored data stored inside ordinary Markdown:

```markdown
```vault-canvas
version: 1
id: canvas-project
viewport: { x: 80, y: 80, zoom: 1 }
nodes:
  - id: note-alpha
    type: note
    target: Projects/Alpha
    x: 0
    y: 0
    width: 260
    height: 160
edges: []
groups: []
```
```

Unlike Graph layout, Canvas geometry is not disposable presentation state. Card positions, sizes, connections, groups and viewport are user-authored spatial content and therefore remain in the Markdown file.

## A1/A2 integration

Phase 12 was originally developed against the Phase 11 baseline. During development, `main` gained the A1 canonical-domain and A2 storage/PWA architecture.

The final integration branch was recreated from the newer `main` and semantically merged the Canvas system without replacing:

- A2Persistence
- A2LocalRepository
- stable canonical IDs
- task identity normalization
- storage repair/health behavior
- full-vault archive support
- newer PWA/domain architecture

Canvas writes now flow through the same A2-backed repository and SaveCoordinator used by the rest of Vault.

## Canvas format

Version 1 supports:

- persisted viewport x/y/zoom
- note cards
- plain text cards
- attachment/media cards
- card x/y/width/height
- directed labeled edges
- visual groups with geometry

Safety limits:

- 1,000 nodes
- 2,500 edges
- 250 groups
- 2 MB Canvas source
- bounded coordinates/object dimensions
- viewport zoom from 0.1 to 4

The parser rejects malformed YAML, duplicate IDs, missing edge endpoints, self-edges, invalid geometry and unsupported versions.

## Spatial interaction

Implemented:

- card move
- card resize
- group move
- group resize
- empty-space pan
- wheel zoom
- toolbar zoom
- Fit
- keyboard pan/zoom
- grid snapping
- Alt/free positioning
- fullscreen expansion
- selection/inspection
- add/edit/delete note cards
- add/edit/delete text cards
- add/edit/delete media cards
- directed connections
- connection labels
- connection deletion
- note/attachment open navigation

Desktop interaction supports both Pointer Events and classic mouse-event fallback paths with a double-start guard. Touch/pen interaction uses Pointer Events.

## Persistence behavior

Each Canvas has a stable Canvas ID.

A mutation replaces only the YAML body of that matching `vault-canvas` fence.

For a Canvas in the currently open note:

- SaveCoordinator owns persistence
- Canvas source updates do not rebuild the active widget mid-gesture
- completed gestures are enqueued before later mode/navigation actions

For a Canvas rendered from another embedded note:

- the owner note is resolved from source context
- the repository performs a version-checked Markdown save
- search, knowledge and graph projections refresh afterward

The final browser acceptance verifies visual drag movement and the corresponding persisted YAML geometry independently.

## Rendering boundary

Live Preview:

- recognizes explicit `vault-canvas` fences
- keeps canonical source directly editable
- keys rendered widgets by stable Canvas ID

Reading mode:

1. renders the fence as ordinary code
2. sanitizes the Markdown
3. recognizes only `language-vault-canvas` blocks
4. constructs controlled DOM/SVG

Canvas YAML never executes as HTML or JavaScript.

## Performance certification

Maximum-size synthetic Canvas:

- **1,000 nodes**
- **2,000 edges**
- **100 groups**
- source size: **244,147 bytes**

Measured in CI run **35686226952**:

- parse: **204.0 ms**
- serialize: **70.9 ms**

Other current-main performance gates in the same run:

- 10,000-note search worst query: **133.5 ms**
- 10,000-node / 20,000-edge graph build: **159.8 ms**
- graph filter: **6.8 ms**
- local graph traversal: **6.8 ms**
- graph grouping: **2.4 ms**
- 10,000-note board projection: **64.4 ms**

## Reliability certification

CI run **35686226952** passed:

- locked dependency installation
- **87/87 core tests**
- 10k search benchmark
- 10k graph benchmark
- 10k board benchmark
- maximum-size Canvas benchmark
- production TypeScript/Vite build
- Chromium installation
- **26/26 applicable desktop/mobile browser scenarios**
- **26** opposite-project scenarios skipped by design
- **0 failures**

This includes the newer A1/A2 tests and browser workflows in addition to Phase 1–12 regressions.
