# Phase 7 results — Tasks & Task Management

## Status

**Phase 7 is implemented and browser-certified in Chromium.**

Certified functional head: `63144f1e8b1acfc8af317b970c4c0a71c6b7f5a3`

Certification run: **35603605922**

## Markdown task model

Phase 7 extends ordinary Markdown checkboxes with optional readable metadata:

```markdown
- [ ] Ship report @scheduled(2026-09-22) @due(2026-09-25) @priority(high)
- [ ] Weekly review @due(2026-09-21) @repeat(weekly)
```

Supported metadata:

- scheduled date
- due date
- high/medium/low priority
- daily/weekly/monthly/yearly recurrence
- bounded every-N day/week/month/year recurrence
- completion date

Invalid metadata is not silently converted into canonical task metadata.

## Tasks view

Implemented:

- vault-wide task aggregation
- default open-task view
- open/done/all status filters
- overdue/today/upcoming/undated filters
- priority filters
- task-text/path filter
- grouping by date/note/priority/none
- summary counts
- task source path
- inline text editing
- checkbox completion
- scheduled date editing
- due date editing
- priority editing
- recurrence editing
- source-note navigation/reveal
- add task to current Markdown note
- responsive mobile task controls

## Recurring tasks

When an incomplete recurring task is completed, Vault:

- preserves the completed occurrence
- records `@done(...)`
- creates the next unchecked occurrence immediately below
- advances scheduled and due dates
- preserves priority and recurrence
- clamps month/year advancement at valid month ends

No background scheduler or recurrence database is introduced.

## Search integration

Structured search now understands:

- `task:open`
- `task:done`
- `task:any`
- `task:overdue`
- `task:today`
- `task:upcoming`
- `task:undated`
- `task:recurring`
- `task:scheduled`
- `task:due`
- `task:high`
- `task:medium`
- `task:low`

## Calendar integration

Open task scheduled/due dates appear on Calendar cells. Selected-day Calendar details can display and complete those tasks directly. Completed tasks are excluded from active task markers.

## Reliability

Task writes are source-verified and version-checked.

The mutation path refuses ambiguous/stale task locations instead of updating a similarly worded line.

CRLF task notes are round-tripped correctly.

## Certification

Run **35603605922** passed:

- locked dependency installation
- **42/42** core tests
- 10,000-note search benchmark
- production Vite build
- **14/14** matching Chromium scenarios
- **14** opposite-project skips by design
- **0 failures**

Benchmark snapshot:

- 10k index build: **536.5 ms**
- worst tested query: **195.1 ms**
- Quick Switcher: **13.3 ms**
