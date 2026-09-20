# Vault architecture

## Canonical-data rule

- Markdown = content truth
- IndexedDB repository = local identity/durability truth
- CodeMirror = active editing state
- knowledge/search indexes = rebuildable acceleration
- future cloud database = synchronization/remote identity truth

No editor view or derived index is a proprietary note store.

## Local write path

```text
CodeMirror transaction
→ MarkdownEditor.onChange
→ SaveCoordinator
→ LocalRepository.saveMarkdown(expectedVersion)
→ IndexedDB transaction
```

The same transaction boundary protects entry version, exact Markdown and the local dirty marker. Stale writes are rejected and preserved separately rather than silently overwriting canonical content.

## Reading trust boundary

```text
untrusted Markdown
→ Markdown/Wiki compilation
→ KaTeX
→ DOMPurify
→ controlled callout/code/Mermaid/Wiki enhancements
```

Raw note HTML is not allowed to execute application-origin JavaScript.

## Phase 3 linked-knowledge path

Phase 3 introduces a versioned **derived** `knowledge` store in IndexedDB. Each record is keyed by immutable note ID and contains only data reconstructable from Markdown:

- aliases
- headings
- block IDs
- Wiki-link references and exact source ranges
- search-safe plain text

```text
canonical Markdown
→ parser
→ KnowledgeRecord
→ IndexedDB knowledge store + in-memory cache
→ autocomplete / resolution / backlinks / outline / unlinked mentions
```

If the derived store is stale or absent, it is rebuilt from the current Markdown files. Deleting it must never lose user-authored information.

## Wiki-link resolution

Resolution is deterministic:

1. explicit vault path
2. relative explicit path
3. exact title in the current folder
4. exact vault-wide title
5. exact alias
6. ambiguous/unresolved result instead of guessing

Duplicate titles are disambiguated with paths.

Heading and block fragments resolve only after the target note identity is resolved.

## Live Preview links

CodeMirror parses ordinary Markdown while a separate Wiki-link plugin tracks `[[...]]` source ranges.

When the cursor is outside a Wiki link, delimiters/target syntax may be concealed and the visible label is decorated according to resolution state. When the cursor enters the link, source syntax is revealed so editing remains predictable.

Ctrl/Cmd-click follows the parsed reference. Autocomplete uses CodeMirror's completion system rather than a custom floating DOM implementation.

## Transclusion

Reading mode resolves `![[Note]]`, `![[Note#Heading]]`, and `![[Note#^block]]` from canonical Markdown.

Nested embeds carry their own source-note context. A stack of immutable entry IDs prevents recursive cycles, and a depth cap protects rendering from pathological chains.

## Rename/move link maintenance

Automatic link maintenance is enabled per vault by default and can be disabled.

Before a note/folder path changes, Vault snapshots the old entry graph and derived records. After the stable IDs are moved, it rewrites only parsed Wiki references that previously resolved to affected entry IDs. It does not perform global string replacement.

Explicit aliases are preserved. Implicit alias-based links gain a display alias if necessary so visible prose does not unexpectedly change.

## File identity

Paths are not permanent identity. Each entry has an immutable UUID. Moving or renaming changes ancestry/name while preserving identity and history.

## Sync boundary

Cloud sync remains inactive. Protocol contracts exist, but there is no active sender/server adoption flow. Future synchronization must be explicit and must never upload a local vault merely because the user signs in.
