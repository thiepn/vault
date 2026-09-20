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

Phase 3 introduced a versioned **derived** `knowledge` store in IndexedDB. Each record is keyed by immutable note ID and contains only data reconstructable from Markdown:

- aliases
- headings
- block IDs
- Wiki-link references and exact source ranges
- tags
- structured properties
- tasks
- search-safe body/source text

```text
canonical Markdown
→ parser
→ KnowledgeRecord
→ IndexedDB knowledge store + in-memory cache
→ autocomplete / resolution / backlinks / outline / unlinked mentions
```

If the derived store is stale or absent, it is rebuilt from current Markdown files. Deleting it must never lose user-authored information.

## Phase 4 search/index path

Search runs outside the main UI thread:

```text
canonical Markdown + stable file metadata
→ SearchInput
→ SearchIndexClient
→ dedicated module Web Worker
→ SearchEngine
   ├─ token inverted index
   ├─ nested tag index
   ├─ property-name index
   ├─ parsed query evaluator
   ├─ result scorer/snippet builder
   ├─ facet builder
   └─ Quick Switcher ranker
→ typed worker response
→ UI
```

The worker receives batches of rebuild/upsert/remove/metadata-update commands. Normal edits are incrementally reindexed instead of forcing a full vault rebuild.

A full rebuild is still available and is used when:

- entering a new vault
- the index is missing
- derived state may have drifted
- the worker crashes and is restarted
- the user explicitly requests a rebuild

The client rejects pending requests when a worker dies, restarts it up to a bounded number of attempts, and requests a deterministic rebuild from canonical local data.

## Search query model

The query parser produces an explicit AST rather than using ad-hoc string matching.

Supported query concepts include:

- ordinary full-text terms
- exact quoted phrases
- implicit and explicit `AND`
- `OR`
- `NOT`
- `-term` negation
- `tag:#math`
- `path:University`
- `file:Analysis`
- `task:open|done|any`
- `property:name`
- `property:name=value`
- `property:rating>=4`

Structured filters narrow candidate sets through dedicated indexes/metadata before ranking.

## Search source offsets

Body, heading and task matches keep UTF-16 source offsets aligned with canonical Markdown. Search results can therefore reveal the exact location in CodeMirror without converting Markdown into another storage format.

## Quick Switcher

Quick Switcher ranks immutable note IDs using:

1. exact title match
2. title prefix/substring/fuzzy match
3. alias match
4. path match
5. recent-note boost

Opening a result still resolves through the normal repository/file identity path.

## Performance boundary

The committed Phase 4 benchmark constructs and indexes **10,000 synthetic notes** and exercises text, phrase, tag, property, task/path and Quick Switcher queries.

The benchmark is a CI regression gate, not a claim that all 10k-note vault workloads have identical performance. Browser/device/storage differences still matter.

## Wiki-link resolution

Resolution remains deterministic:

1. explicit vault path
2. relative explicit path
3. exact title in the current folder
4. exact vault-wide title
5. exact alias
6. ambiguous/unresolved result instead of guessing

Duplicate titles are disambiguated with paths.

## Rename/move link maintenance

Automatic link maintenance is enabled per vault by default and can be disabled.

Before a note/folder path changes, Vault snapshots the old entry graph and derived records. After the stable IDs are moved, it rewrites only parsed Wiki references that previously resolved to affected entry IDs. It does not perform global string replacement.

## File identity

Paths are not permanent identity. Each entry has an immutable UUID. Moving or renaming changes ancestry/name while preserving identity and history.

## Sync boundary

Cloud sync remains inactive. Protocol contracts exist, but there is no active sender/server adoption flow. Future synchronization must be explicit and must never upload a local vault merely because the user signs in.
