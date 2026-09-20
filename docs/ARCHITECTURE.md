# Vault architecture

## Canonical-data rule
- Markdown = content truth
- IndexedDB repository = local identity/durability truth
- CodeMirror = active editing state
- derived indexes = rebuildable acceleration
- future cloud database = synchronization/remote identity truth

CodeMirror is deliberately not a proprietary note store.

## Phase 1 storage path
UI operation -> repository/service -> IndexedDB transaction containing entry identity/version, exact Markdown text, and local dirty marker.

Stale writes are rejected instead of silently overwriting a competing version. Recovery drafts preserve failed/stale editor text separately from canonical Markdown.

## Phase 2 editor path
CodeMirror transaction -> MarkdownEditor.onChange -> SaveCoordinator -> LocalRepository.saveMarkdown(expectedVersion) -> IndexedDB transaction.

Reading mode is always derived from current Markdown and never becomes canonical state.

## Rendering trust boundary
Untrusted Markdown -> Marked compiler -> KaTeX token rendering -> DOMPurify sanitization -> controlled DOM enhancements (callouts, code highlighting/copy controls, Mermaid strict rendering followed by SVG sanitization).

Raw Markdown cannot directly execute JavaScript in the application origin.

## Live Preview
Live Preview uses CodeMirror's parsed Markdown syntax tree and decorations. Phase 2 keeps source syntax visible. Phase 3 may introduce cursor-aware concealment/widgets together with Wiki links and transclusion, where cursor and selection semantics can be designed coherently.

## File identity
Paths are not permanent identity. Each entry has an immutable UUID. Moving or renaming changes ancestry/name while preserving identity and history.

## Sync boundary
Cloud sync remains inactive. Protocol contracts exist, but there is no active sender/server adoption flow. Future synchronization must be explicit and must never upload a local vault merely because the user signs in.
