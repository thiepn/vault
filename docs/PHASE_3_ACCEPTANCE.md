# Phase 3 acceptance

## Result

**ACCEPTED — linked knowledge is browser-certified in Chromium after the final locked-dependency gate.**

## Acceptance criteria

Phase 3 requires:

- Wiki links resolve deterministically
- aliases participate in resolution/autocomplete
- heading and block links resolve
- unresolved links remain useful and can create notes
- embeds preserve Markdown portability
- recursive embeds cannot loop forever
- backlinks come from parsed links rather than text guesses
- unlinked mentions exclude actual Wiki-link ranges
- unlinked mention conversion edits canonical Markdown
- note/folder moves preserve stable IDs
- optional automatic link updates rewrite parsed references only
- outline navigation is tied to parsed headings
- Source/Live Preview/Reading continue to round-trip canonical Markdown
- Phase 1/2 regression suites remain green
- desktop/mobile Chromium acceptance passes

## Browser-certified workflows

The Playwright suite covers:

1. Phase 1 desktop lifecycle and native IndexedDB reload
2. Phase 1 mobile lifecycle
3. Phase 2 rich Markdown editor/rendering
4. Phase 2 mobile editor
5. aliases and linked mentions
6. outline navigation/current section
7. backlinks and unlinked mentions
8. block transclusion
9. reading-mode Wiki navigation
10. Wiki autocomplete
11. unlinked-mention conversion
12. automatic link rewrite after target rename
13. unresolved-link creation
14. mobile Knowledge drawer
15. mobile Wiki navigation

## Phase boundary

**Phase 4 — Index + Search Engine** should build on the Phase 3 knowledge records rather than introduce another parser. It should add worker-backed indexing, vault-wide search syntax, tags/properties indexing and the quick switcher while preserving the same note/file identities.
