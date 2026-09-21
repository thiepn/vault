# Phase 10 acceptance — Graph View & Knowledge Visualization

## Result

**ACCEPTED — full/local knowledge graph visualization is browser-certified.**

## Acceptance criteria

- graph is a derived projection, not canonical data
- no proprietary graph database or stored edge model is introduced
- active Markdown notes become graph nodes
- active attachments may become graph nodes
- resolved Wiki links become directed edges
- note embeds remain distinguishable from normal links
- attachment links/embeds remain distinguishable
- repeated references produce weighted relationships
- unresolved references do not create guessed edges
- ambiguous references do not create guessed edges
- full-vault graph works
- local graph works
- local depth is bounded and configurable
- local traversal includes incoming and outgoing neighbors
- original edge direction is preserved
- current Markdown is flushed/reindexed before opening Graph
- graph refreshes after canonical knowledge changes
- title/path/tag/property search highlighting works
- hierarchical tag filtering works
- property existence/equality/inequality filtering works
- attachments can be included/excluded
- orphan-only discovery works
- grouping by folder works
- grouping by primary tag works
- grouping by note/attachment kind works
- grouping by property works
- search-only changes preserve viewport/layout context
- deterministic layout is available
- weighted directed edges render
- node size reflects connectivity
- note and attachment nodes are visually distinct
- orphan nodes are identifiable
- drag/touch pan works
- wheel/button zoom works
- Fit works
- keyboard Canvas navigation works
- reduced-motion users do not require animated physics
- large graphs automatically avoid continuous simulation
- accessible DOM node navigation exists alongside Canvas
- graph node navigation opens the canonical note/attachment
- desktop Graph uses the main content width
- mobile Graph remains touch-usable
- hidden-note destructive shortcuts are blocked while Graph is open
- graph coordinates/filter/group state are not synchronized or persisted as authored truth
- 10,000-node graph construction stays within CI performance budget
- Phase 1–9 core and browser regressions remain green
- production TypeScript/Vite build passes

## Certification

Functional certification head:

`c6075b0378f814f251eb6bb89ba0fa0b73a32bc9`

CI run **35666636000**:

- **60 core tests passed**
- 10k search benchmark passed
- 10k graph benchmark passed
  - 10,000 nodes
  - 20,000 edges
  - 200.7 ms build
  - 9.4 ms filter
  - 7.5 ms local traversal
  - 2.5 ms grouping
- production build passed
- **20 applicable Chromium desktop/mobile scenarios passed**
- **20 project-specific opposite-device scenarios skipped by design**
- **0 failures**

## Release boundary

Phase 10 deliberately does not persist graph coordinates or introduce cloud-synchronized visualization state.

Later phases may add higher-level surfaces such as Kanban, Canvas/spatial documents, PWA/offline hardening or external Markdown/Obsidian import, but they must continue to respect the same canonical Markdown/stable-file boundary.
