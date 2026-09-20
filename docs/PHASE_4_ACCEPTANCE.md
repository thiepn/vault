# Phase 4 acceptance

## Result

**ACCEPTED — worker-backed index/search is browser-certified in Chromium and performance-certified at 10,000 synthetic notes.**

## Acceptance criteria

Phase 4 requires:

- search/index computation is off the main UI thread
- Markdown remains canonical
- indexes are rebuildable
- text/title/path/alias search works
- phrases and Boolean logic work
- tags are indexed, including nested prefixes
- properties are indexed and support comparisons
- tasks are searchable by state
- results expose useful match metadata
- body matches preserve canonical source offsets
- search opens the correct note/location
- edits update the index incrementally
- create/delete/rename/move reconcile correctly
- rebuilds cannot silently discard edits made during the build
- worker crashes are recoverable
- Quick Switcher supports titles, aliases, paths and recency
- Search/Tags UI works on desktop and mobile
- Phase 1–3 regressions remain green
- production build passes
- 10k benchmark passes

## Browser-certified workflows

The Playwright suite verifies:

1. Phase 1 desktop file lifecycle
2. Phase 1 mobile file lifecycle
3. Phase 2 desktop Markdown editor/rendering
4. Phase 2 mobile editor
5. Phase 3 desktop linked knowledge
6. Phase 3 mobile linked knowledge
7. Phase 4 desktop worker search
8. full-text and phrase queries
9. structured tag/property/task filters
10. Boolean negation
11. tag/property facet navigation
12. Quick Switcher alias lookup
13. incremental search after editing
14. path/filename filters
15. manual index rebuild
16. Phase 4 mobile search
17. Phase 4 mobile tag navigation

## Performance gate

The certification benchmark builds 10,000 synthetic documents and exercises multiple search classes plus Quick Switcher.

Measured on the final certification environment:

- build: **521.4 ms**
- worst tested query: **176.6 ms**
- Quick Switcher: **18.2 ms**

CI guardrails remain deliberately conservative to reduce environment-specific flakiness.

## Canonical-data guarantee

Deleting the worker/index state must not delete or mutate Markdown.

The index may always be reconstructed from:

- stable file metadata
- canonical Markdown contents
- the shared knowledge parser

## Next architectural boundary

A later phase should add higher-level product features without replacing this search architecture. In particular:

- visual properties should write Markdown frontmatter, then reindex
- task/calendar features should parse/write Markdown tasks/properties
- graph views should derive from Phase 3 links
- cloud sync should synchronize canonical files/metadata, not worker index state
