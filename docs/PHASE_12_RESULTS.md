# Phase 12 results — Canvas & Spatial Knowledge Workspace

## Status

**Phase 12 is implemented and browser-certified in Chromium.**

Certified Phase 12 code/test head: `6d0227bec229d4b550b51494b959241d961876b6` plus the subsequent synchronized Phase 5 test hardening on the original branch.

Certification run: **35681757888** (CI run #166)

GitHub stopped emitting `pull_request synchronize` CI events for PR #6 during final certification. A temporary certification branch was created from the identical Phase 12 code/test state and differed only by a CI push-trigger line. Run #166 therefore certifies the same Phase 12 implementation and tests that are being merged from PR #6.

## Canonical model

A Canvas is authored content, not a derived visualization.

```text
vault-canvas fenced YAML
        ↓
strict format parser
        ↓
stable nodes / edges / groups / viewport
        ↓
DOM + SVG spatial workspace
        ↓
interaction mutation
        ↓
replace matching Canvas fence
        ↓
SaveCoordinator / version-checked Markdown save
```

Canvas geometry, connections, groups and viewport remain inside the owning Markdown note.

## Canvas document format

Format version 1 supports:

- stable Canvas id
- viewport x/y/zoom
- note cards
- text cards
- media cards
- x/y/width/height geometry
- directed labeled connections
- visual groups

Strict validation rejects:

- invalid YAML
- unsupported versions
- duplicate object ids
- invalid geometry
- missing edge endpoints
- self-connections
- invalid references
- documents above safety limits

Current safety limits:

- **1,000 nodes**
- **2,500 edges**
- **250 groups**
- **2 MB Canvas source**
- zoom **0.1–4**
- bounded coordinates and dimensions

## Spatial workspace

Implemented:

- note cards resolved through Vault's note resolver
- text cards
- attachment/media cards
- image previews
- attachment open navigation
- movable cards
- resizable cards
- movable/resizable groups
- directed SVG connections
- optional connection labels
- connection edit/delete
- item add/edit/delete
- grid snapping
- Alt modifier for free positioning
- empty-space pan
- wheel zoom
- zoom buttons
- Fit
- keyboard pan
- keyboard zoom
- Home-to-fit
- fullscreen expansion
- responsive inspector

## Input resilience

Canvas supports:

- Pointer Events for mouse/touch/pen
- classic desktop mouse fallback
- guarded gesture starts so pointer + mouse event families cannot double-start
- captured move/resize/pan gestures
- deterministic browser-event acceptance coverage

A completed gesture enqueues its canonical Markdown write before subsequent navigation or mode-switch actions, preventing gesture loss when the Canvas widget detaches.

## Persistence

Each Canvas has a stable id.

A mutation serializes the current Canvas document and replaces only the matching `vault-canvas` fence.

Current note:

- uses active `SaveCoordinator`
- updates editor source
- persists canonical Markdown
- rebuilds relevant derived projections without unnecessarily tearing down the active Canvas DOM

Embedded/other note:

- re-reads canonical Markdown
- performs version-checked `saveMarkdown(expectedVersion)`
- rebuilds knowledge/search/graph projections

Canvas Live Preview widgets are keyed by stable Canvas id so their DOM can survive their own source persistence.

## Rendering boundary

Live Preview recognizes only explicit `vault-canvas` fences.

Reading mode:

1. compiles the fence as ordinary code
2. sanitizes the Markdown result
3. recognizes only sanitized `language-vault-canvas` blocks
4. creates controlled DOM/SVG Canvas UI

Canvas YAML is never executed as HTML or JavaScript.

## Desktop and mobile

Desktop acceptance covers:

- resolved note cards
- local image media
- fullscreen expand/collapse
- Fit
- card movement
- persisted geometry
- add text card
- create connection
- add group
- persisted zoom
- note-card navigation
- Reading-mode rendering
- reload persistence

Mobile acceptance covers:

- spatial Canvas rendering
- touch-sized controls
- add text card
- select/edit card
- zoom
- Reading-mode rendering

## Maximum-size Canvas benchmark

Synthetic benchmark document:

- **1,000 nodes**
- **2,000 edges**
- **100 groups**
- **244,147 source bytes**

Measured in CI run **35681757888**:

- parse: **222.5 ms**
- serialize: **75.3 ms**

CI budgets:

- parse < 1,500 ms
- serialize < 1,000 ms

## Reliability certification

Certification run **35681757888** passed:

- locked dependency install
- **73/73 core tests**
- 10,000-note search benchmark
- 10,000-node graph benchmark
- 10,000-note board benchmark
- maximum-size Canvas benchmark
- production TypeScript/Vite build
- Chromium installation
- **24/24 applicable desktop/mobile browser scenarios**
- **24** opposite-project scenarios skipped by design
- **0 failures**

Phase 1–11 applicable browser workflows remained green in the same run.
