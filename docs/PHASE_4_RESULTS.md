# Phase 4 results — index + search engine

## Status

**Phase 4 is implemented and browser-certified in Chromium.**

Phase 4 adds a worker-backed vault-wide search/index system on top of the accepted Phase 1–3 storage, editor and linked-knowledge foundations.

## Implemented

### Worker-backed index

- dedicated module Web Worker
- typed request/response protocol
- batched full rebuilds
- incremental note upserts
- batched removals
- metadata-only updates after path/title changes
- worker restart handling
- deterministic rebuild after worker failure
- progress/status reporting

### Indexed content

The search engine indexes:

- note body text
- filenames/titles
- paths
- aliases
- headings
- tags
- nested tag prefixes
- YAML/frontmatter properties
- task text/state

The underlying parser preserves canonical Markdown source offsets.

### Query language

Supported:

- ordinary full-text terms
- quoted phrases
- `AND`
- `OR`
- `NOT`
- `-term`
- `tag:#name`
- `path:value`
- `file:value`
- `task:open`
- `task:done`
- `task:any`
- `property:name`
- property equality/inequality
- numeric/string/boolean property comparisons

Examples:

```text
"uniform continuity"
tag:#math -tag:#archive
property:status=active
property:rating>=4
task:open path:University
(continuity OR compactness) NOT tag:#archive
```

### Search experience

- Files / Search / Tags sidebar navigation
- result score ordering
- contextual snippets
- safe highlighted terms
- exact source-range navigation
- tag facets
- property facets
- nested tag navigation
- index status/progress
- manual rebuild action
- desktop/mobile responsive behavior

### Quick Switcher

- `Ctrl/Cmd+O`
- touch-visible launcher
- title fuzzy matching
- alias matching
- path matching
- recent-note boost
- keyboard up/down/Enter/Escape navigation

### Incremental consistency

Phase 4 handles:

- edits made after initial indexing
- edits that happen while a full rebuild is in progress
- rename/move metadata changes
- deleted notes
- newly created notes
- worker restarts
- explicit rebuilds

The UI never treats the worker index as canonical note data.

## Reliability fixes made during certification

The Phase 4 hardening sequence caught and fixed:

- partial alias matches that ranked correctly but did not explain the match
- edits racing an in-progress full rebuild
- active query results not refreshing after incremental reindex
- search worker restart/rebuild recovery
- hidden mobile sidebar tab navigation
- desktop/mobile test helpers racing drawer transitions
- search-result highlighting without unsafe HTML
- structured property comparison narrowing
- exact source-range navigation
- mobile Quick Switcher discoverability
- stale path-filter test expectations

## Performance certification

Final CI benchmark on 10,000 synthetic notes:

```text
documents:      10,000
index build:    521.4 ms
worst query:    176.6 ms
quick switcher: 18.2 ms
tokens:         10,041
tag keys:       22
properties:     3
```

The committed guardrails are intentionally looser than the measured result:

- 10k indexing < 20 seconds
- each tested search query < 1 second
- Quick Switcher query < 1 second

This benchmark is a regression gate, not a universal device-performance guarantee.

## Final verification

Final green CI run: **35540471195**

The run passed:

- locked dependency install
- strict core TypeScript
- 22 Node contract tests
- 10k search benchmark
- React/Vite production build
- Phase 1 desktop/mobile Chromium regressions
- Phase 2 desktop/mobile Chromium regressions
- Phase 3 desktop/mobile Chromium regressions
- Phase 4 desktop worker-search workflow
- Phase 4 mobile search/tag workflow

Playwright result:

- **8 passed**
- **8 intentionally skipped** because each desktop/mobile scenario only runs in its matching project
- **0 failed**

## Phase boundary

Phase 4 does not introduce a second content store or cloud search service.

Markdown remains canonical and all search/index state is disposable.

Later phases can add higher-level features—properties UI, tasks/calendar, graph, cloud sync—on top of the same stable file IDs and derived index contracts.
