# Vault architecture — Phase 1

## Source of truth

| Concern | Authority |
|---|---|
| Note contents | exact Markdown text in `contents` |
| File/folder identity | immutable entry UUID |
| Location | derived from `parentId + name` |
| Unsynced local intent | dirty marker |
| Checkpoints | local revisions |
| Failed/stale edit safety | recovery drafts |
| Explorer preferences | settings |

A path is not identity. Moving `Study/Analysis.md` to `University/Analysis.md` keeps the same entry ID.

## Local write transaction

```text
editor memory
→ expected-version check
→ IndexedDB transaction
   ├─ entry metadata/version
   ├─ Markdown text
   └─ dirty marker
→ transaction completes
→ UI may say “Saved locally”
```

The UI distinguishes a local save from future cloud synchronization.

## Safety invariants

- No overwrite on active sibling-name collision.
- Parent folders must be live directories in the same vault.
- A directory cannot be moved into itself or a descendant.
- Canonical Markdown content version must equal the owning entry version.
- Stale writes are rejected and preserved as recovery drafts where possible.
- Trash removes the active sibling key and keeps a tombstone/deletion batch.
- Restore is transactional and collision checked.
- Recursive duplication copies exact Markdown text into new identities.
- Derived paths are validated against the complete ancestry.

## Local storage

Phase 1 uses IndexedDB for canonical Markdown plus metadata so a normal note write has one transactional durability boundary. OPFS is deferred until binary attachment work requires it.

The storage driver is intentionally narrow. Production uses native IndexedDB; tests may use a transaction-compatible in-memory driver, but those tests are not evidence of browser durability.

## Sync boundary

Sync protocol contracts exist, but no sender, server mutation RPC, remote adoption flow or realtime channel is active. A future sync implementation must preserve these rules:

- explicit account/vault adoption
- immutable sealed operation bytes
- idempotent operation IDs
- per-vault ordered delta cursor
- revision-based conflicts
- no trust in client timestamps
- realtime as notification only, never authority

## Phase boundary

Phase 2 replaces the textarea with the professional Markdown editor/rendering pipeline. It should build on these repository contracts rather than move canonical note state into React.
