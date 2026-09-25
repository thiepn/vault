# I6 — Multi-Device Merge & Conflict Resolution

Status: release candidate pending exact-head CI.

## Scope

I6 replaces I5's temporary `MERGE_REQUIRED` stop with durable, deterministic Protocol-v2 reconciliation for encrypted Notes and Folders.

The server remains ciphertext-only. All BASE / LOCAL / REMOTE comparison and conflict resolution happens after authenticated decryption on the client.

## Reconciliation model

Every remote change is evaluated against:

- **BASE** — the last clean synchronized state;
- **LOCAL** — the current authored local state;
- **REMOTE** — the newly observed authenticated remote state.

The reconciler never uses timestamps as a conflict winner.

Safe one-sided changes converge directly. Independent Markdown and structural edits merge. Ambiguous authored changes become a durable conflict record.

## Markdown

For Notes:

- non-overlapping Markdown block edits auto-merge;
- overlapping blocks become explicit conflict regions;
- YAML/frontmatter overlap is never silently semantically guessed;
- canonical Markdown never receives textual conflict markers;
- merged Markdown preserves stable embedded Task identities.

## Structural state

Name, parent and deletion state are reconciled separately from Markdown.

I6 handles:

- rename + body edit;
- move + body edit;
- divergent rename;
- divergent move;
- delete/edit races;
- same-ID concurrent creation;
- different-ID same-name creation collisions.

Folder cycles and invalid parents continue to fail closed.

## Durable conflict state

Schema v7 adds `syncConflicts`, separate from the legacy Protocol-v1 Phase-22 conflict store.

An unresolved record preserves:

- immutable original BASE;
- latest LOCAL snapshot;
- latest REMOTE snapshot;
- remote revision/sequence;
- NameToken and key generation;
- state hash;
- conflict kind and Markdown conflict IDs.

A later remote event may refresh REMOTE, but it does not rewrite BASE.

The pull cursor advances atomically with conflict capture. One conflicted entity is outbound-blocked without freezing unrelated entities or the whole Vault.

## Resolution

The browser resolver supports:

- **Keep mine**
- **Use remote**
- **Keep both**
- **Manual Markdown merge**

Resolution transactions remove obsolete queued wire for that entity before writing the chosen state.

Keep Local and Manual become `resolution-pending` until the resulting encrypted write is observed back through the ordered Protocol-v2 event stream. They cannot be treated as resolved merely because a local transaction succeeded.

Keep Both creates a new UUIDv7 identity where required and rekeys embedded Task IDs so the two Notes cannot alias the same first-class Tasks.

Different-ID name collisions stage a safe rename when necessary before the local winner is allowed to synchronize.

## Stale resolver safety

The UI submits the conflict ID and exact `updatedAt` snapshot it displayed.

If LOCAL or REMOTE changed after the dialog opened, the resolution transaction rejects with `STALE_WRITE`. The user must reopen the resolver and make the decision against the new state.

This prevents a visually stale decision from overwriting unseen work.

## Archive and recovery

Full Vault archives include Protocol-v2 conflict records.

Validation rejects malformed conflict identity, scope, revision, cryptographic metadata or state. Unresolved BASE / LOCAL / REMOTE snapshots round-trip through the verified archive format.

## Performance

CI includes a deterministic 10,000-reconciliation benchmark for disjoint concurrent Markdown edits.

The benchmark must produce:

- 10,000 successful auto-merges;
- zero unexplained conflicts;
- no conflict markers in canonical output;
- completion inside the configured regression budget.

## Browser acceptance

Chromium desktop/mobile acceptance verifies that an IndexedDB-backed Protocol-v2 Vault can:

- surface encrypted conflicts in the global conflict indicator;
- render BASE / Mine / Remote regions;
- execute Keep Remote;
- retire the conflict locally when appropriate;
- perform a manual Markdown decision;
- keep manual/local resolution conflict-blocked while awaiting its ordered encrypted event.

## Release invariant

> No authenticated concurrent authored state is silently discarded. Safe changes converge automatically; ambiguous changes remain explicit and recoverable until a user resolves them.

## Deferred scope

I6 still synchronizes only Notes and Folders.

Encrypted Attachment entities and blob bytes remain I7. Cross-Account E2EE sharing, Protocol-v2 realtime collaboration and encrypted background parity remain later architecture work.
