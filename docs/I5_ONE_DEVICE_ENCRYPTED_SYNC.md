# I5 — Client Push/Pull & One-Device Encrypted Synchronization

Status: implementation release candidate.

## Scope

I5 is the first browser path that can move canonical Vault content through Protocol v2.

Certified sync roots in I5:

- Folders
- Markdown Notes, including exact Markdown/YAML source

Deliberately not yet synchronized:

- Attachment bytes or Attachment entities — I7
- second-device encrypted bootstrap — I8
- multi-device divergent edits and durable merge conflicts — I6
- cross-Account encrypted sharing

## Activation

A local Vault remains local until the user explicitly adopts it.

For the canonical owner, a newly cloud-linked Protocol v1 Vault is **not permitted to upload canonical plaintext**. The UI enters an encryption-pending state:

1. Generate a random Recovery Secret locally.
2. Display the human Recovery Code.
3. Require the user to confirm it was saved.
4. Initialize the I3 Device + Recovery envelopes.
5. Verify I3 READY.
6. Run the clean I4 v1 → v2 server upgrade.
7. Convert the zero local sync cursor from auth-user identity to AccountId.
8. Persist the local cloud binding as Protocol v2.

No canonical content is uploaded during setup. The user still presses **Sync now** for the first encrypted upload.

The I5 capability migration changes `vault_sync_capabilities_v2().encryptedContentV2.acceptingContent` from false to true only after this client path is shipped.

## Plaintext boundary

The Protocol v2 serializer places the actual filename, timestamps and exact Markdown inside AES-256-GCM ciphertext.

Server-visible structure is limited to the frozen A7 metadata:

- EntityId / EntityType
- parent EntityId
- opaque NameToken
- deleted flag
- revisions / sequence
- encryption/key generation
- ciphertext framing

On decrypt, the client recomputes NameToken from the decrypted filename + authenticated parent and rejects a mismatch.

## Push

Each I5 client operation contains one entity mutation.

A dirty Note/Folder is:

1. read with its localVersion;
2. deterministically serialized;
3. encrypted outside the IndexedDB write transaction;
4. re-read;
5. discarded if localVersion changed during encryption;
6. sealed as immutable Protocol v2 wire and queued.

The server result does **not** clear the outbox or dirty state.

A successful push only marks the immutable outbox row accepted. Its ordered event must later be pulled.

A lost push response therefore safely retries the exact same wire/OperationId and receives the I4 idempotent result.

## Pull / observation

Every transport page is structurally validated and every ciphertext is authenticated/decrypted before the local write transaction starts.

The page then commits in one IndexedDB transaction:

- canonical Entry/Markdown state
- local checkpoint where needed
- RemoteShadow v2
- own-operation observation/removal
- Dirty clearing where safe
- Protocol v2 cursor

For an own event:

- Shadow always advances to the accepted server state;
- if local state still equals that accepted plaintext, Dirty is cleared;
- if the user edited again after the push, canonical local state is preserved and remains Dirty.

That newer edit is synthesized against the newly observed remote revision on the next bounded pass.

Remote apply has a dedicated path and never creates another Dirty record.

## One-device conflict boundary

I5 does not silently overwrite a local dirty entity with an unexpected foreign event.

If a non-own remote event touches an entity with local Dirty state or a pending operation, the page fails closed with:

`MERGE_REQUIRED`

The cursor does not advance past that page.

I6 replaces this temporary fail-closed boundary with durable BASE/LOCAL/REMOTE reconciliation and conflict resolution.

## Attachments

Attachment dirty records remain local and are counted as deferred.

They are never serialized through legacy v1 from an owner Vault and are never placed into Protocol v2 pretending that blob replication exists.

I7 owns encrypted blob upload, hydration and Attachment entity activation.

## Legacy isolation

The legacy Protocol v1 implementation remains in the codebase for compatibility and regression coverage.

For the canonical owner:

- no v1 automatic background staging after I5;
- the Cloud UI requires E2EE setup before first sync;
- v2 Vaults do not subscribe to the old plaintext realtime/collaboration/CRDT channels.

## Release claim

After I5:

> Vault supports explicit-owner, one-device, end-to-end encrypted Note and Folder replication using Protocol v2. A newer local edit made after server acceptance is preserved and synchronized as a later revision; unexpected foreign divergence is never silently overwritten.
