# Phase 11 acceptance — Kanban & Structured Board Views

## Result

**ACCEPTED — Markdown-native Kanban boards are browser-certified.**

## Acceptance criteria

- board definitions remain canonical Markdown text
- cards remain canonical Markdown notes
- no proprietary board/card database is introduced
- explicit `vault-board` fences parse strictly
- board queries reuse the existing search/query grammar
- writable lanes are backed by one frontmatter property
- configured lane order is deterministic
- configured lane labels work
- unexpected property values remain visible
- uncategorized notes are surfaced by default
- uncategorized lane can be disabled
- hidden-card counts remain accurate
- card fields can show tags/properties/task counts/dates
- board sorting reuses existing deterministic dynamic-query semantics
- board limits prevent unbounded rendering
- Live Preview board widgets work
- board source stays directly editable
- Reading-mode board rendering occurs after sanitization
- board source never executes HTML/JavaScript
- desktop drag/drop moves cards
- mobile/keyboard lane selectors move cards
- card moves update canonical YAML
- card moves use version-checked writes
- currently open card notes use SaveCoordinator
- frontmatter property key casing is preserved
- moving to uncategorized deletes the grouping property
- knowledge/search projections refresh after a move
- graph projection invalidates after board-driven property changes
- board card navigation opens the underlying note
- desktop horizontal lanes are usable
- mobile horizontal lanes remain touch-usable
- standard and compact board layouts work
- reload preserves lane membership because it comes from Markdown
- 10,000-note board projection stays within CI performance budget
- Phase 1–10 regressions remain green
- production TypeScript/Vite build passes

## Certification

Functional certification head:

`8d8addc174d10711342a57c822fbb81b389588c8`

CI run **35674301834**:

- **66 core tests passed**
- 10k search benchmark passed
- 10k graph benchmark passed
- 10k board benchmark passed
  - 10,000 notes
  - 500 shown cards
  - 5 projected lanes
  - **69.5 ms**
- production build passed
- **22 applicable Chromium desktop/mobile scenarios passed**
- **22 opposite-device scenarios skipped by design**
- **0 failures**

## Release boundary

Phase 11 deliberately does not create an independent issue tracker, board database or hidden card-order store.

Arbitrary within-lane manual ordering is not stored separately from Markdown in this phase. Cards use deterministic configured sorting. A later phase may add an explicit Markdown/frontmatter-backed ordering scheme if needed without weakening the canonical-data model.
