# Phase 9 acceptance — Attachments, Images & Media

## Result

**ACCEPTED — local binary attachments and media workflows are browser-certified.**

## Acceptance criteria

- Markdown remains canonical note text
- attachment bytes are never encoded into canonical Markdown
- attachments use stable vault entry IDs
- binary payloads persist in a dedicated IndexedDB store
- schema migration preserves existing Phase 1–8 data
- file picker upload works
- clipboard paste works
- editor drag/drop works
- dedicated attachment-folder placement works
- note-folder placement works
- filenames remain portable and Wiki-reference safe
- images/audio/video produce readable Markdown embeds
- other files produce readable Markdown links
- Reading mode resolves attachments through controlled post-sanitization DOM
- local object URLs are lifecycle-managed
- attachment library lists active media
- reference counts and unreferenced/orphan detection work
- attachment preview works on desktop and mobile
- rename/move preserves attachment identity
- rename/move rewrites inbound attachment references
- moved folders update descendant attachment references
- duplication preserves exact attachment bytes
- recursive folder duplication preserves nested attachment bytes
- Trash/restore works through the normal entry lifecycle
- ZIP export contains active attachment bytes at canonical paths
- recovery backup contains attachment payloads
- Phase 1–8 core/browser regressions remain green
- production TypeScript/Vite build passes

## Certification

Functional certification run **35660411148** on `b468dd6ed9559efe452408e5ae5110a53187045e`:

- 55 core tests passed
- 10k search benchmark passed
- production build passed
- 18 matching Chromium scenarios passed
- 18 project-specific scenarios skipped by design
- 0 failures

## Release boundary

Phase 9 deliberately does not introduce cloud media synchronization, remote object storage, or external vault import. Those require later sync/import architecture rather than weakening the local attachment model.
