# I7 — Encrypted Attachments & Blob Transport

Status: release candidate pending exact-head certification.

## Scope

I7 extends Protocol v2 from Notes/Folders to binary Attachments without exposing attachment content or descriptive metadata to the backend.

The backend may observe only the minimum routing/integrity metadata required by the frozen Protocol-v2 contract:

- VaultId
- Attachment EntityId
- parent EntityId
- opaque NameToken
- opaque generation-scoped BlobId
- deletion flag
- key generation
- ciphertext byte length
- synchronization revisions / sequence / operation identity

The backend does **not** receive:

- attachment filename
- MIME type
- plaintext SHA-256
- plaintext byte length
- plaintext attachment bytes

Filename, MIME type, plaintext size and plaintext SHA-256 live inside authenticated entity ciphertext.

## Blob identity

BlobId is:

- HMAC-derived from the raw plaintext SHA-256;
- keyed by the Vault Master Key;
- scoped to VaultId and VMK generation;
- stable for identical bytes inside the same Vault generation;
- unlinkable across unrelated Vaults or key generations.

The plaintext SHA-256 remains local/authenticated plaintext and is never used as a remote object path.

## Blob encryption

Each object uses a binary `VBLB` v1 envelope:

- magic/version/suite header;
- fresh 96-bit AES-GCM nonce;
- AES-256-GCM ciphertext + authentication tag.

The blob encryption key is HKDF-derived from:

- VMK;
- VaultId;
- BlobId;
- key generation.

AAD binds VaultId + BlobId + key generation. Moving ciphertext between Vaults, generations or BlobIds fails authentication.

## Upload lifecycle

Attachment publication is ordered:

1. Serialize local Attachment metadata into encrypted entity plaintext.
2. Compute local plaintext SHA-256.
3. Derive opaque BlobId.
4. Encrypt bytes locally.
5. Call `vault_sync_prepare_blob_v2`.
6. If absent, upload immutable ciphertext to the private `vault-e2ee-blobs` bucket.
7. Call `vault_sync_commit_blob_v2`.
8. Only after BlobId is READY may the Attachment entity mutation be pushed.
9. The server independently rejects Attachment entity mutations whose BlobId is not READY for the active key generation.

A blob upload can therefore never become a canonical Attachment merely because the object exists.

### Large / resumable uploads

Ciphertext objects up to 6 MiB use the immutable standard Storage upload path.

Larger ciphertext uses Supabase TUS through the direct `<project>.storage.supabase.co` hostname:

- fixed 6 MiB chunks;
- `x-upsert: false`;
- a unique TUS upload URL;
- HEAD `Upload-Offset` recovery after an interrupted PATCH;
- bounded retry/recovery attempts;
- immutable-path collision falls back to authenticated existing-object verification.

A failed resumable upload never creates the canonical Attachment entity until the object is complete and the READY commit succeeds.

## Idempotency and deduplication

The object key is:

`<VaultId>/<keyGeneration>/<BlobId>`

Uploads do not use Storage upsert.

If a lost response or another authorized device already created the same immutable object:

- prepare returns READY or the upload returns an exists conflict;
- the client downloads the existing ciphertext;
- authenticates/decrypts it;
- verifies plaintext size + SHA-256 against the local Attachment;
- only then reuses the blob.

Backend READY state is never trusted as proof of plaintext correctness by itself.

## Download / hydration

For a remote Attachment event:

1. Authenticate/decrypt the encrypted entity payload.
2. Recompute NameToken.
3. Recompute BlobId from authenticated plaintext SHA-256.
4. Reject mismatched structure before downloading.
5. Download the private ciphertext object.
6. Authenticate/decrypt the blob envelope.
7. Validate browser attachment size limits.
8. Verify exact plaintext byte length.
9. Verify plaintext SHA-256.
10. Only then enter the IndexedDB write transaction.
11. Write Entry + Attachment bytes + RemoteShadow + cursor atomically.

A missing/corrupt/wrong-key object therefore cannot advance the synchronization cursor.

## Local reuse

If a local Attachment already has:

- the authenticated remote MIME type;
- authenticated remote byte length;
- matching plaintext SHA-256;

its existing local bytes are reused without another network download.

## Concurrent Attachment changes

I7 does not force binary Attachments through the Markdown/structural I6 conflict record model.

When a foreign Attachment event races dirty/pending local authored state:

- the remote canonical Attachment is allowed to advance;
- local Attachment bytes/metadata are preserved as a conflict-safe local copy;
- that copy receives a new UUIDv7 identity and remains Dirty for a later encrypted push;
- the cursor continues instead of deadlocking on binary conflict semantics.

For different-ID same-name Attachment races, the dirty local Attachment is moved to a deterministic conflict-safe name before the remote identity is applied.

This is intentionally conservative: preserve both authored states rather than guess a binary winner.

## Storage boundary

I7 uses a new private bucket:

`vault-e2ee-blobs`

It does not reuse the legacy `vault-sync` attachment namespace.

Storage policies permit only authenticated canonical owners of active Protocol-v2 Vaults to read/upload objects under their own VaultId path.

No client UPDATE or DELETE policy exists for encrypted blobs.

## Blob lifecycle

`vault_private.blob_refs.state` is used as:

- `pending` — descriptor registered but object not yet committed;
- `ready` — immutable ciphertext object is valid for entity references;
- `orphaned` — no current entity head references the blob.

Physical deletion is intentionally deferred.

Immutable entity history and fixed-snapshot bootstrap can still reference an older BlobId after it leaves current `entity_heads`. Deleting its object immediately could corrupt recovery/bootstrap. A future history-retention/GC protocol may physically remove orphaned ciphertext only after proving no retained version or active bootstrap reader can need it.

## VMK generations

BlobId, encryption key and Storage path all include/derive from the active key generation.

The backend rejects blob preparation/commit for stale generations.

Older-generation ciphertext remains readable only by a device that can resolve the corresponding historical VMK generation.

## Privacy boundary

Protocol-v2 Attachment entity wire and Storage paths must never contain:

- filename
- MIME type
- plaintext hash
- plaintext bytes
- user-selected folder names

The Storage object's content type is always `application/octet-stream`.

## Performance

CI includes an encrypted blob benchmark that repeatedly encrypts and decrypts tens of MiB using the real browser-compatible Web Crypto path and verifies every round trip.

The binary envelope intentionally avoids base64 encoding of large attachment bytes.

## Browser acceptance

The production-style browser test:

- creates a local Attachment;
- activates E2EE;
- uploads only ciphertext;
- verifies object path/wire do not contain Attachment plaintext metadata;
- removes the local Attachment replica;
- rewinds only the test cursor;
- downloads/authenticates/decrypts the remote ciphertext;
- restores exact original bytes into IndexedDB.

## Release invariant

> A Protocol-v2 Attachment is canonical only when both its encrypted metadata and its opaque ciphertext blob authenticate to the same Vault, BlobId and key generation, and downloaded plaintext exactly matches the authenticated size and SHA-256.

## Deferred scope

I7 remains owner-only because Protocol-v2 cross-Account key distribution is not yet implemented.

Physical orphan garbage collection is deliberately deferred until the history/bootstrap retention model can prove deletion safety.
