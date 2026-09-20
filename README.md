# Vault

**Vault** is a browser-first, local-first Markdown knowledge system.

The long-term product goal is an original web application with linked Markdown notes, cloud synchronization, tasks, queries, calendar, graph, Canvas, mobile/PWA support, and open-data portability. The current repository is intentionally earlier than that: it contains the **Phase 1 vault + file-system foundation**.

## Phase 1

Implemented:

- multiple local vaults
- create and rename vaults
- nested folders
- Markdown notes with stable immutable IDs
- local IndexedDB persistence
- create, edit, rename and move notes/folders
- recursive folder duplication
- deterministic collision-safe copy names
- collapsible/filterable/sortable explorer
- folders-first preference
- drag/drop moves
- per-vault explorer preferences
- Trash and recursive restore
- local revision checkpoints
- recovery drafts for stale/deleted/failed writes
- local-change indicators for later cloud sync
- active-vault Markdown ZIP export
- recovery JSON export
- Unicode filenames
- responsive desktop/mobile shell

Markdown text is canonical note content. Paths are derived from stable file IDs and parent relationships; a rename or move does not change file identity.

## Not Phase 1

The following are intentionally not claimed yet:

- CodeMirror 6 / professional editor
- Live Preview and Reading mode
- Wiki links and backlinks
- full-text indexing/search
- properties/frontmatter UI
- templates/daily notes/calendar/tasks
- accounts and cross-device synchronization
- conflict merge UI
- attachments
- graph/local graph
- Kanban
- Canvas
- PWA cold-start/offline shell
- Markdown/Obsidian vault import

Those are subsequent roadmap phases.

## Architecture

```text
UI
↓
Workspace / commands
↓
VaultRepository + FileRepository + RevisionRepository
↓
LocalRepository
↓
IndexedDB transaction driver
```

Important invariants:

- Markdown content, file version and local dirty state commit together.
- Stale writes never silently overwrite the winning version.
- Failed/stale/deleted-note edits are preserved as recovery drafts when storage is available.
- File and folder IDs remain stable across rename/move.
- Active sibling names are collision checked.
- Folder cycles and cross-vault ancestry are rejected.
- Derived indexes remain rebuildable from canonical Markdown.
- Signing in later must not automatically adopt/upload a local vault.

See `docs/ARCHITECTURE.md` and `docs/PHASE_1_RESULTS.md`.

## Development

Requires Node 22.12+.

```bash
npm install
npm test
npm run build
npm run dev
```

The first two commands validate the Phase 1 core and repository contract; the production build validates the React/Vite shell.

## Product identity

- Product: **Vault**
- Repository: **thiepn/vault**
- Package: **@thiepn/vault**

No Obsidian branding, source code, proprietary assets, or third-party plugin runtime is used.
