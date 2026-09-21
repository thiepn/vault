# Phase 6 results — Templates, Daily Notes & Calendar

## Status

**Phase 6 is implemented and browser-certified in Chromium.**

Certified functional head: `9cee802067eb94be2801e8dcad9e0f56c1bbe219`

Certification run: **35599689278**

## Templates

Templates are ordinary Markdown notes under a configurable Templates folder.

Implemented variables:

- `{{title}}`
- `{{date}}`
- `{{time}}`
- `{{datetime}}`
- `{{weekday}}`
- `{{year}}`
- `{{month}}`
- `{{day}}`
- `{{yesterday}}`
- `{{tomorrow}}`
- `{{date:<pattern>}}`
- `{{cursor}}`

Implemented workflows:

- explicit "create from template"
- insert template into current editor selection
- default vault template
- folder-specific template
- dedicated Daily Note template
- cursor placement without storing cursor metadata

## Daily Notes

- configurable folder
- configurable template
- configurable filename date format
- default `YYYY-MM-DD`
- format validation requires year/month/day
- portable filename validation
- open existing daily file instead of duplicating
- automatic default Markdown body when no template is configured
- Previous / Today / Next navigation
- document-bar Daily navigation
- `Ctrl/Cmd + Shift + D` shortcut

## Calendar

- Monday-first calendar
- fixed 42-cell month view
- previous/next month
- today marker
- Daily Note marker
- associated-note marker/count
- association from any exact YYYY-MM-DD YAML property value
- click a date to open/create its Daily Note
- list associated notes for selected date
- desktop sidebar Calendar tab
- mobile Calendar workflow

## Reliability fixes during certification

- settings changes capture their selected value before async persistence
- invalid Daily filename formats are rejected
- template cursor positions survive create/open
- property edits are serialized without destroying adjacent in-progress controls
- drag/drop accepts browser DataTransfer payloads
- drag state is cleared on successful drop even if the source node is replaced
- legacy drag/drop test now targets the exact destination shell

## Certification

Final functional run **35599689278** passed:

- locked dependency installation
- **35/35** core tests
- 10,000-note search benchmark
- production Vite build
- **12/12** matching Chromium scenarios
- **12** opposite-project skips by design
- **0 failures**

Benchmark snapshot:

- 10k index build: **504.3 ms**
- worst tested query: **168.4 ms**
- Quick Switcher: **19.2 ms**
- Vite build: **1.45 s**
