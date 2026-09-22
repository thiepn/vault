# ADR-001 — Canonical domain identity and storage independence

Status: **Accepted**

Date: 2026-09-22

## Context

Vault already has a working Markdown-first Phase 1–11 runtime:

- stable Entry UUIDs
- IndexedDB persistence
- Markdown/YAML canonical note state
- attachment records
- derived task/search/calendar/query/graph/board projections

The permanent PKM architecture now needs first-class concepts such as Tasks, Events, Projects, People and Captures without invalidating the existing runtime or coupling those concepts to one storage engine.

The system must also preserve existing note/folder/attachment identities when later storage migrations occur.

## Decision

Vault adopts a storage-independent canonical domain layer.

Every first-class canonical entity receives a globally unique stable ID independent from:

- title
- filename
- path
- folder location
- external-provider identifier
- database row position

New A-series IDs use offline-generated UUIDv7 values.

Existing valid Entry UUIDs remain valid canonical IDs and must be reused when an existing Note, Folder or Attachment is projected/migrated into the new domain.

The following are frozen first-class canonical concepts:

- Vault
- Note
- Folder
- Tag
- PropertyDefinition
- Task
- Event
- Project
- Person
- Attachment
- Capture
- Collection
- Link

Canonical domain meaning is explicitly separated from:

1. serialization
2. local physical storage
3. remote/backend storage
4. derived indexes and UI projections

## Consequences

### Positive

- rename/move operations never redefine identity
- A2 can change serialization/storage without redefining the domain
- A3/A5 can add backend/sync without making the server the conceptual source of identity
- existing Phase 1–11 user data does not need re-identification
- external calendar/AI/integration providers remain replaceable
- derived indexes can be deleted and rebuilt
- future import/export can preserve IDs

### Cost

- A2 must define a bridge between readable Markdown and structured first-class entities such as Tasks
- some permanent-domain concepts temporarily coexist with older runtime projections
- migration code must preserve unknown fields and existing IDs
- sync cannot simply use filenames/paths as keys

## Explicit non-decisions

ADR-001 does not choose:

- IndexedDB vs SQLite
- OPFS strategy
- backend/database provider
- account provider
- sync algorithm
- CRDT vs operation log
- Task serialization format
- attachment byte layout

Those decisions are deferred to later A-series phases.

## Enforcement

Executable contracts:

- \`src/domain/canonical.ts\`

Contract tests:

- \`tests/a1-domain.test.mjs\`

Detailed architecture:

- \`docs/A1_DOMAIN_MODEL.md\`

Any future implementation that replaces stable entity identity with a path, filename, external-provider ID or database sequence violates this ADR.
