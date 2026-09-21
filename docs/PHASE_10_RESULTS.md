# Phase 10 results — Graph View & Knowledge Visualization

## Status

**Phase 10 is implemented and browser-certified in Chromium.**

Certified functional head: `c6075b0378f814f251eb6bb89ba0fa0b73a32bc9`

Certification run: **35666636000** (CI run #112)

## Product model

Phase 10 adds a graph as a disposable projection of existing Vault truth.

```text
active Entry tree + KnowledgeRecord links
                 ↓
       resolved directed graph
                 ↓
 full/local/filter/group projection
                 ↓
 Canvas visualization + DOM node browser
```

No graph database, layout document or persisted edge store is introduced.

## Graph relationships

Nodes represent:

- active Markdown notes
- active attachments

Edges represent resolved:

- Wiki links
- note embeds
- attachment links
- attachment embeds

Repeated references between the same source, target and relationship type are collapsed into a weighted edge.

Unresolved and ambiguous references are reported separately and never converted into guessed edges.

## Full and local graph

Implemented:

- full-vault graph
- local graph centered on the current note or attachment
- 1–4 hop UI depth
- undirected neighborhood traversal for discovery
- original directed relationships preserved in the projected local graph
- automatic refresh after canonical note/link changes

Opening the graph flushes and reindexes the current Markdown note first so newly typed links are represented.

## Search, filters and discovery

Implemented:

- title/path/tag/property search highlighting
- hierarchical tag filtering
- property existence filters
- `key=value` property filters
- `key!=value` property filters
- note/attachment visibility control
- orphan-only discovery
- unresolved-reference diagnostics
- ambiguous-reference diagnostics

Search highlighting preserves the graph topology and current viewport rather than destructively replacing the visible relationship context.

## Grouping

Layout can be grouped by:

- folder
- primary tag
- note vs attachment
- selected property

Grouping affects visualization only and is never written into canonical data.

## Canvas visualization

Implemented a native Canvas renderer with no additional graph framework.

Features:

- deterministic seeded node placement
- cluster-aware starting positions
- degree-scaled note nodes
- visually distinct attachment nodes
- weighted directed edges
- arrowheads
- center/search emphasis
- orphan indicators
- group labels
- pointer and touch panning
- wheel zoom
- zoom buttons
- Fit control
- keyboard pan/zoom/Home-to-fit
- resize handling
- high-DPI rendering with bounded device pixel ratio

Smaller graphs receive a bounded 90-frame spring/collision relaxation pass.

For reduced-motion users or large graphs above the rendering threshold, Vault uses the deterministic static layout immediately instead of continuous animation.

## Accessibility

Canvas is not the only graph interface.

Phase 10 also provides a normal DOM node browser with:

- visible-node count
- note/attachment names
- canonical paths
- connection counts
- search match state
- orphan state
- keyboard-focusable buttons
- direct open navigation

This allows graph navigation without requiring precise Canvas pointer interaction.

## Responsive behavior

Desktop:

- graph reclaims the inspector column
- full canvas-focused layout
- node browser alongside canvas

Mobile:

- graph replaces the document surface
- two-column controls collapse to touch-friendly controls
- canvas and node browser stack vertically
- touch panning and button zoom remain available
- tapping a node opens the underlying note or attachment

## Performance certification

A dedicated synthetic benchmark builds:

- **10,000 nodes**
- **20,000 resolved edges**

Measured in CI run **35666636000**:

- graph construction: **200.7 ms**
- tag/property filtering: **9.4 ms**
- local depth traversal: **7.5 ms**
- property grouping across 10,000 nodes: **2.5 ms**
- filtered nodes in benchmark case: **167**
- local-depth nodes in benchmark case: **25**

CI thresholds are deliberately looser than these measured results to reduce machine-noise flakiness:

- graph build < 2,500 ms
- filter < 300 ms
- local traversal < 300 ms
- grouping < 150 ms

## Reliability certification

Run **35666636000** passed:

- locked dependency installation
- **60/60 core tests**
- 10,000-note search benchmark
- **10,000-node / 20,000-edge graph benchmark**
- production TypeScript/Vite build
- Chromium installation
- **20/20 applicable desktop/mobile browser scenarios**
- **20** opposite-project scenarios skipped by design
- **0 failures**

Phase 1–9 browser workflows remained green in the same run.
