# Phase 11 results — Kanban & Structured Board Views

## Status

**Phase 11 is implemented and browser-certified in Chromium.**

Certified functional head: `8d8addc174d10711342a57c822fbb81b389588c8`

Certification run: **35674301834** (CI run #123)

## Canonical model

Board definitions are ordinary Markdown fences:

```markdown
```vault-board
title: Project board
query: tag:#project
group-by: property:status
columns: backlog=Backlog, todo=To do, doing=Doing, done=Done
card-fields: tags, property:priority, updated
sort: updated desc
limit: 200
exclude-self: true
```
```

Cards are active Markdown notes selected by the existing query engine. There is no board/card database.

A card's lane comes from one frontmatter property such as:

```yaml
status: doing
```

Moving the card writes that canonical YAML property.

## Board projection

Implemented:

- strict `vault-board` parser
- existing Boolean query language
- tag/property/task query clauses
- property-backed grouping
- stable configured lane order
- lane labels
- automatic lanes for unexpected property values
- optional uncategorized lane
- configurable uncategorized label
- card metadata fields
- deterministic sorting
- 1–500 card result limit
- self-exclusion
- standard and compact layouts

Unexpected property values are surfaced instead of silently hiding notes.

## Card movement

Desktop:

- HTML drag/drop between lanes
- visual drop target
- automatic board refresh

Touch/keyboard:

- per-card lane selector
- same canonical mutation path as drag/drop

For non-open notes, a lane move:

1. re-reads canonical Markdown
2. preserves the existing frontmatter property key spelling
3. edits YAML through the frontmatter round-trip model
4. calls `saveMarkdown(expectedVersion)`
5. rebuilds knowledge/search projections
6. refreshes board/query/graph consumers

If the card is the current open note, the move goes through its active `SaveCoordinator` so editor state cannot diverge from durable Markdown.

Property resolution is case-insensitive but mutation preserves the existing key casing. For example, `Status: todo` becomes `Status: doing`, not a duplicate lowercase `status` property.

## Live Preview

Explicit `vault-board` fences receive a CodeMirror block widget.

The canonical board definition remains editable. Moving the cursor into the board fence removes the rendered widget so the source can be edited normally.

The board widget can:

- open cards
- drag cards
- use lane selectors
- update after card-property mutations

## Reading mode

Board fences are first compiled as code and pass through the normal Markdown sanitizer.

Only sanitized `language-vault-board` code blocks are then replaced with controlled board DOM.

Board source never becomes executable HTML or JavaScript.

Embedded notes preserve their source-entry context.

## Responsive UI

Desktop:

- horizontal Kanban lanes
- drag/drop
- lane counts
- card metadata chips
- compact layout option

Mobile:

- scroll-snapped horizontal lanes
- touch-sized cards
- touch-friendly lane selectors
- card open navigation without drag precision requirements

## Performance

Dedicated benchmark input:

- **10,000 Markdown notes**
- project/tag properties on all notes
- four configured status lanes
- 500-card render limit

Measured in CI run **35674301834**:

- board projection: **69.5 ms**
- candidate notes: **10,000**
- rendered cards: **500**
- projected lanes: **5** including the empty default uncategorized lane

CI threshold: **< 750 ms**.

## Reliability certification

Run **35674301834** passed:

- locked dependency installation
- **66/66 core tests**
- 10,000-note search benchmark
- 10,000-node graph benchmark
- **10,000-card board benchmark**
- production TypeScript/Vite build
- Chromium installation
- **22/22 applicable desktop/mobile browser scenarios**
- **22** opposite-project scenarios skipped by design
- **0 failures**

The same browser run kept Phase 1–10 workflows green.
