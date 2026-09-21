# Phase 6 acceptance — Templates, Daily Notes & Calendar

## Result

**ACCEPTED — Markdown-native templates, Daily Notes and Calendar are browser-certified.**

## Acceptance criteria

- templates are ordinary Markdown files
- template settings store IDs/config only, never template bodies
- variables expand deterministically
- unknown variables are preserved
- cursor marker never becomes persisted metadata
- note creation supports default/folder/explicit templates
- Daily Notes use folder + filename format identity
- Daily format contains year/month/day and produces portable names
- opening the same date reuses its existing Daily Note
- previous/today/next navigation works
- Calendar is derived from Daily filenames and YAML date properties
- calendar does not become an event database
- mobile and desktop workflows pass
- Phases 1–5 remain green

## Certification

Run **35599689278** on functional head `9cee802067eb94be2801e8dcad9e0f56c1bbe219`:

- 35 core tests passed
- 10k benchmark passed
- production build passed
- 12 Chromium scenarios passed
- 12 project-specific scenarios skipped by design
- 0 failures

## Next boundary

The next product layer can build advanced tasks/query views on top of existing Markdown tasks, properties, search and date infrastructure without creating a proprietary task database.
