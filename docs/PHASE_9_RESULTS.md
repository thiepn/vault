# Phase 9 results — Attachments, Images & Media

## Status

**Phase 9 is implemented and browser-certified in Chromium.**

Certified functional head: `b468dd6ed9559efe452408e5ae5110a53187045e`

Certification run: **35660411148**

## Storage model

Phase 9 introduces first-class attachment entries without putting binary data into Markdown.

```text
Entry(kind=attachment)
├─ immutable entry UUID
├─ vault / folder / filename metadata
└─ IndexedDB attachment payload
   ├─ MIME type
   ├─ byte length
   └─ binary bytes
```

The IndexedDB schema advances to **v3** with a dedicated `attachments` store.

Notes remain ordinary Markdown. Attachment references remain readable and portable:

```markdown
![[Attachments/photo.png]]
[[Attachments/report.pdf]]
```

## Input workflows

Implemented:

- file picker upload
- multi-file upload
- clipboard file paste into the editor
- drag/drop files onto the editor
- automatic root `Attachments` folder
- configurable explicit attachment folder
- optional placement beside the current note
- collision-safe filenames
- Wiki-safe filename validation
- 128 MB per-file browser storage guard

Images, audio and video are inserted as embeds. Other file types are inserted as ordinary attachment links.

## Media rendering

Reading mode resolves attachment references after Markdown sanitization.

Implemented rendering:

- images through controlled `img` elements
- audio through controlled `audio` elements
- video through controlled `video` elements
- PDF and arbitrary files through local download/open cards
- explicit warnings for ambiguous or unavailable attachment targets

Blob/object URLs are generated from local IndexedDB bytes, cached by immutable attachment ID for the session, and revoked when appropriate.

## Attachment library

The Media panel provides:

- vault-wide attachment listing
- canonical vault paths
- reference counts
- unreferenced/orphan detection
- direct attachment opening
- responsive mobile controls
- attachment-location settings

Opening an attachment provides a dedicated preview surface with MIME type, size and download action.

## File lifecycle

Attachments participate in the normal Vault file model:

- rename
- move
- drag/drop folder movement
- duplicate
- recursive folder duplicate
- Trash
- restore
- stable immutable IDs

Renaming or moving an attachment rewrites inbound `[[...]]` / `![[...]]` references using the same stale-safe Markdown save path as other canonical edits.

Moving a folder applies reference maintenance to descendant attachments as well.

## Export and recovery

Active-vault ZIP export now includes:

- Markdown notes
- empty folders
- attachment files with their original binary bytes
- original vault-relative paths

Recovery snapshot format advances to **v2** and contains attachment payloads as base64 so the JSON recovery backup remains self-contained.

The existing in-memory ZIP release limit remains 512 MB.

## Reliability

Phase 9 explicitly tests:

- byte-exact attachment storage
- MIME inference
- safe filenames
- attachment duplication
- recursive folder duplication with media
- snapshot serialization
- ZIP source byte preservation
- attachment path resolution
- orphan/reference counting
- inbound-reference rewriting after rename/move
- stable file sorting with the new third entry kind
- desktop upload → embed → preview → rename rewrite workflow
- mobile media-library and attachment-preview workflow

## Certification

Run **35660411148** passed:

- locked dependency installation
- **55/55 core tests**
- 10,000-note search benchmark
- production Vite build
- **18/18 matching Chromium scenarios**
- **18** opposite-project scenarios skipped by design
- **0 failures**

Benchmark snapshot:

- 10k index build: **578 ms**
- worst tested query: **180.2 ms**
- Quick Switcher: **15.8 ms**
