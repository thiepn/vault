# Phase 1 acceptance

Phase 1 is accepted as a **source implementation** when create/switch vault, nested folder/file lifecycle, local Markdown persistence, move/rename/duplicate, Trash/restore and recovery behavior are implemented behind repository contracts and automated tests pass.

It is **browser certified** only after Chromium verifies the committed production build against native IndexedDB. The acceptance suite covers desktop persistence through reload, nested create/edit/duplicate/rename/Trash/restore, vault rename, drag/drop movement, filtering, and a mobile create/edit/reload workflow.

CI intentionally installs a real Chromium runtime rather than replacing IndexedDB with a test double for this gate.

No cloud synchronization, account, CodeMirror, search/index, backlink, task, graph or Canvas functionality belongs to Phase 1.
