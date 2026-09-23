# Phase 22 — Semantic/Block-Aware Interactive Conflict Resolution

Phase 22 adds a durable, explicit user decision layer on top of Vault's existing conservative conflict-copy behavior.

## Resolution pipeline

```text
remote event / push conflict
        │
        ▼
Phase 16 three-way merge attempt
        │
        ├─ safe auto-merge ──► canonical Markdown
        │
        └─ conflict
              │
              ├─ duplicate/preserve local copy
              ├─ apply remote canonical snapshot
              └─ record immutable conflict metadata
                         │
                         ▼
                 Phase 22 resolver
                         │
             block-aware semantic plan
                         │
            explicit overlapping choices
                         │
                 resolution preview
                         │
                 stale-safety check
                         │
                         ▼
                 canonical local save
                         │
             ordinary protocol-v1 sync
```

## Why remote remains canonical at conflict capture

Phase 15 already guarantees that a conflict never silently overwrites local work: the local version is duplicated first, then the server's ordered remote snapshot becomes canonical. Phase 22 preserves that invariant. The resolver is a later, explicit local edit against the known remote canonical snapshot.

## Persistent conflict record

The schema-v6 `conflicts` store keeps:

- canonical EntryId;
- preserved local-copy EntryId;
- base and remote revisions;
- immutable base/local/remote Markdown snapshots;
- owner/epoch and pull/push source;
- open/resolved status;
- resolution text and timestamps.

The record is audit metadata, not a second canonical note. Canonical content remains in `contents`/LocalRepository.

## Markdown block model

The planner groups exact source text into pragmatic semantic blocks rather than parsing to a lossy rendered AST. Supported categories are:

- YAML frontmatter;
- ATX headings;
- paragraphs;
- list regions;
- blockquotes;
- fenced code blocks;
- Markdown tables;
- thematic breaks;
- whitespace blocks.

Each block retains its raw Markdown. A bounded LCS compares base→local and base→remote block sequences. One-sided edits are auto-resolved; overlapping edit groups become explicit decisions.

## Degraded mode

LCS is deliberately bounded at 450 blocks per side. Larger inputs use a prefix/suffix coarse edit region. This sacrifices fine-grained suggestions rather than risking a quadratic UI stall.

## Apply semantics

Before Apply, Vault rebuilds the resolution from the current stored conflict record and user choices. It then reads the canonical note fresh.

Apply is accepted only if canonical text still equals the captured remote text or already equals the proposed resolution. Any other current text means newer work exists; Vault rejects with `STALE_WRITE`.

After a successful save the conflict record becomes resolved. The preserved local copy is trashed only when its text is still exactly the captured local snapshot; otherwise it is kept.

## Interaction with CRDT and background replication

Active Phase 20 CRDT state is finalized before resolver writes. The resolution then becomes a normal local canonical edit.

Phase 21's service worker never resolves conflict records. It can only transport sealed operations and stage remote events; foreground SyncEngine and the resolver remain authoritative for conflict application.
