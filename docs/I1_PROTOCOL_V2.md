# I1 — Protocol v2 & Encrypted Sync Contract

Status: implemented contract layer; production v2 content ingestion remains deliberately disabled.

## What changed

- Added a clean Protocol v2 wire contract in `src/sync/protocol-v2.ts`.
- Protocol v2 mutations are ciphertext-first desired-state `put` mutations.
- The v2 operation envelope binds `AccountId`, `VaultId`, `DeviceId` and immutable operation bytes.
- Remote revisions and Vault cursors are PostgreSQL bigint strings, never JavaScript numbers.
- Runtime validation is strict: unknown fields are rejected. Plaintext compatibility fields such as `name`, `text`, `mimeType` and plaintext SHA-256 cannot be inserted into v2 wire payloads.
- Added AccountId-bound Protocol v2 outbox/cursor state in `src/sync/local-state-v2.ts`.
- Added the clean-break migration required by A9: only a zero-cursor Vault with no queued operations and no remote shadows can migrate from v1 local sync identity to v2. Existing sealed v1 wire is never edited.
- Added backend capability negotiation. The I1 SQL migration advertises the v2 contract but reports `acceptingContent=false`.
- Added regression tests for ciphertext-only validation, exact sealed identity, bigint cursors, AccountId isolation and migration refusal.

## Deliberate compatibility boundary

The existing Phase 15–22 replication runtime remains Protocol v1 while I2/I3/I4 are incomplete. I1 does not convert active plaintext replication into a partially encrypted mixed protocol.

Protocol v2 content must remain disabled until all of the following are present:

1. I2 Crypto Suite 1.
2. I3 device keys, Recovery Secret and VMK envelopes.
3. I4 encrypted server state/RPCs.

At that point the runtime can switch as one clean transition.

## Security invariant

Protocol v2 never has plaintext fields for filenames, Markdown, MIME types or plaintext blob hashes. Structural server-visible metadata is limited to stable IDs, entity type, parent ID, NameToken, deletion state, BlobId, revisions and encrypted payload framing.
