# I4 — Encrypted Remote State & PostgreSQL Sync Core

Status: implemented server contract. The existing production browser sync engine remains Protocol v1 until I5.

## Purpose

I4 creates the server-side half of Protocol v2 without giving the browser a partially migrated content-sync path.

The server stores only ciphertext and bounded structural metadata. It does not store canonical filenames, Markdown, YAML, MIME types, plaintext attachment hashes, search text, or embeddings.

## Private state

All Protocol v2 content tables live under `vault_private` and grant no direct access to `anon` or `authenticated`:

- `sync_v2_vault_state` — Vault epoch and next contiguous event sequence.
- `entity_heads` — current encrypted desired state.
- `entity_versions` — immutable full encrypted versions.
- `accepted_operations` — exact accepted wire bytes, digest and idempotent result.
- `sync_events` — ordered per-Vault event stream.
- `device_vault_state` — advisory Device acknowledgement state.
- `blob_refs` — opaque BlobId metadata reserved for I7 transfer lifecycle.

RLS remains enabled as defense in depth even though direct browser grants are revoked.

## Clean Protocol v1 → v2 transition

`vault_sync_upgrade_v2` changes a Vault from Protocol 1 to 2 only when:

1. the caller is the canonical Vault owner;
2. the Device is authorized;
3. I3 key readiness is complete;
4. the Vault has no accepted Protocol-v1 entries, operations or events;
5. the Protocol-v1 counter has never progressed beyond its empty baseline.

Existing plaintext Protocol-v1 history is never reinterpreted as Protocol v2.

The Phase-14 Vault-update trigger is redefined so a protocol change is accepted only from this controlled RPC via a transaction-local guard.

## Push

`vault_sync_push_v2(p_wire text, p_sha256 text)`:

1. recomputes SHA-256 over the **exact UTF-8 wire string**;
2. parses/validates the strict Protocol-v2 envelope independently of the client;
3. resolves JWT → AccountId and validates Device/Vault authorization;
4. locks the per-Vault `sync_v2_vault_state` row;
5. returns an existing accepted result for the same OperationId + exact bytes;
6. rejects OperationId reuse with different bytes;
7. validates every mutation and CAS base revision without writing;
8. validates the operation's **final state** for parent availability, folder cycles and active sibling NameToken uniqueness;
9. requires future writes to use the server-active VMK generation;
10. validates attachment BlobIds against a READY opaque BlobRef;
11. allocates one contiguous Vault sequence per mutation;
12. writes the head, immutable version and event atomically;
13. records the accepted operation/result.

Any exception rolls back the entire operation.

## Structural metadata

Server-visible entity state is limited to:

- VaultId / EntityId / EntityType
- parent EntityId where applicable
- opaque NameToken
- deleted flag
- opaque BlobId
- schema/encryption/key generation
- remote revision / Vault sequence
- ciphertext size/bytes
- operation/device/timing metadata

NameToken is required only for filesystem-like `note`, `folder` and `attachment` entities. Other canonical structured entities cannot expose filesystem parent/name metadata.

## Pull and acknowledgement

`vault_sync_pull_v2` returns strict contiguous events after a string cursor. Each event joins its exact immutable `entity_versions` row, making every page self-contained.

Pulling does not acknowledge. `vault_sync_ack_v2` is separate, monotonic and advisory. I5 is responsible for acknowledging only after a page has been durably applied locally.

## Bootstrap

`vault_sync_begin_bootstrap_v2` fixes a high watermark H.

`vault_sync_bootstrap_page_v2` reconstructs the latest version of each entity with `sequence <= H`, ordered by EntityId keyset pagination. Writes after H may continue and are later consumed from H+1 through the normal event stream.

No long-running PostgreSQL snapshot transaction is required because immutable versions retain the required history.

## History

I4 intentionally provides no automatic pruning of:

- entity versions
- accepted operations
- sync events
- tombstones

Compaction requires a later explicitly audited retention/checkpoint design.

## E2EE sharing boundary

I3 currently restricts VMK lineage to the canonical Vault owner. I4 uses that same boundary. Existing Phase-18 Protocol-v1 sharing remains separate; cross-Account E2EE collaboration is not silently enabled by I4.

## Deliberate activation boundary

The I1 capabilities RPC continues to report `acceptingContent=false`.

I4 proves and installs the encrypted server core, but it does **not** switch the current Phase15–22 client engine. I5 will add encrypted serialization/decryption, RemoteShadow v2 and the one-Device pull/push loop before Protocol-v2 browser content is enabled.
