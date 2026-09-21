# Phase 7 acceptance — Tasks & Task Management

## Result

**ACCEPTED — Markdown-native task management is browser-certified.**

## Acceptance criteria

- Markdown checkbox lines remain task truth
- no task database is introduced
- source ranges/raw lines are retained for safe edits
- task text/checkbox/date/priority/recurrence edits rewrite canonical Markdown
- stale/ambiguous task mutations fail
- completion date is recorded
- recurring completion preserves history and creates the next occurrence
- month/year recurrence handles end-of-month dates
- vault-wide task filtering/grouping works
- task search filters work
- Calendar derives task markers from open scheduled/due tasks
- source-note navigation works
- desktop and mobile workflows pass
- Phases 1–6 regressions remain green

## Certification

Run **35603605922** on `63144f1e8b1acfc8af317b970c4c0a71c6b7f5a3`:

- 42 core tests passed
- 10k benchmark passed
- production build passed
- 14 matching Chromium scenarios passed
- 14 project-specific scenarios skipped by design
- 0 failures

## Next boundary

The task/property/search foundation is now strong enough for **Queries & Dynamic Views**: saved Markdown-native queries that render lists, tables and task views without creating another canonical data store.
