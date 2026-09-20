# Phase 3 results — linked knowledge system

## Status

**Phase 3 is implemented and browser-certified in Chromium.**

Phase 3 turns Vault from a Markdown editor into a linked-note knowledge system while keeping Markdown as the canonical source.

## Implemented

### Wiki-link parser and resolver

- `[[Note]]`
- `[[Note|Displayed text]]`
- `[[Note#Heading]]`
- `[[Note#^block-id]]`
- `[[#Current heading]]`
- note/heading/block embeds via `![[...]]`
- YAML `aliases` / `alias` extraction
- duplicate-title path disambiguation
- code/frontmatter/comment exclusion
- Unicode-safe source offsets

### Editor integration

- CodeMirror `[[` autocomplete
- alias suggestions
- heading suggestions
- block-ID suggestions
- resolved / ambiguous / unresolved styling
- cursor-aware Wiki syntax concealment
- embed badge in Live Preview
- Ctrl/Cmd-click navigation
- unresolved-link note creation

### Knowledge navigation

- backlinks
- grouped source-note backlink presentation
- unlinked mentions
- one-click conversion from an unlinked mention into a Wiki link
- outline panel
- current-section highlighting
- mobile Knowledge drawer

### Transclusion

- entire-note embeds
- heading embeds
- block embeds
- nested-embed source context
- cycle detection
- depth limit
- navigational embed labels

### Link maintenance

- parsed inbound-link rewrite after note rename
- parsed inbound-link rewrite after note move
- folder-move propagation to descendant note paths
- explicit alias preservation
- implicit alias preservation through generated display aliases
- per-vault automatic-update toggle

## Derived index

IndexedDB schema 2 adds a `knowledge` object store.

The store is not canonical. It contains parsed metadata and source ranges only, can be pruned/rebuilt, and is refreshed from canonical Markdown versions.

The current implementation runs this Phase 3 index locally. Phase 4 can move heavier indexing/search work into Web Workers without changing link semantics or Markdown storage.

## Reliability work during Phase 3

The implementation caught and corrected several issues before certification:

- ambiguous backlink test/UI handling
- mobile Knowledge control targeting
- technical fragment syntax leaking into embed labels
- alias-display behavior during automatic link updates
- Unicode source offsets for unlinked mentions
- repeated Wiki parsing during cursor movement
- source-generation corruption around regex escaping

The final source avoids backslash-fragile generated escaping in the unlinked-mention path.

## Verification

The Phase 3 browser suite exercises:

- aliases
- Wiki resolution
- headings and blocks
- backlinks
- unlinked mentions
- outline navigation
- reading-mode Wiki links
- block transclusion
- `[[` autocomplete
- one-click unlinked-link conversion
- rename-driven inbound link rewriting
- unresolved-link note creation
- mobile Knowledge drawer
- mobile Wiki-link navigation

Phase 1 and Phase 2 browser regressions remain in the same suite.

## Deferred to Phase 4+

- worker-backed global full-text search
- tags/property indexes and search syntax
- quick switcher
- broader large-vault performance certification
- visual graph view
- cloud synchronization
