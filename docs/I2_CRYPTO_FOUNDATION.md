# I2 — Cryptographic Foundation

Status: implemented cryptographic foundation; raw VMK persistence remains deliberately deferred to I3.

## Crypto Suite 1

Vault's first encrypted-sync suite is now implemented under `src/crypto`:

- 256-bit random Vault Master Keys via `crypto.getRandomValues`
- HKDF-SHA-256 for domain-separated derived keys
- AES-256-GCM with random 96-bit nonces and 128-bit authentication tags
- HMAC-SHA-256 for opaque NameTokens and BlobIds
- strict unpadded base64url wire encoding
- canonical UTF-8 JSON-array context encoding
- per-entity non-extractable AES keys
- non-extractable HMAC keys
- authenticated structural entity metadata
- ephemeral `VaultCryptoContext`

## Domain separation

All cryptographic contexts are versioned. Current domains include:

- `vault/hkdf-salt/v1`
- `vault/entity-key/v1`
- `vault/entity-aad/v1`
- `vault/name-token-key/v1`
- `vault/name-token/v1`
- `vault/blob-id-key/v1`

IDs are canonical lowercase UUID strings before entering cryptographic contexts.

## NameToken

NameToken deliberately reuses the existing portable path semantics:

1. `validateName` performs NFC normalization and portable filename validation.
2. `nameKey` performs locale-independent ASCII A-Z → a-z folding.
3. HMAC context includes VaultId, parent/root and normalized name key.

This means Turkish/browser locale cannot silently change collision identity.

Tokens are key-generation scoped. A future VMK rotation therefore must re-tokenize active names as part of the rotation transition before new-generation writes are allowed; I3 owns that lifecycle.

## BlobId

The server never receives the local plaintext SHA-256 identity. Instead:

`BlobId = HMAC(K_blob_id, rawPlaintextSha256Digest)`

where `K_blob_id` is derived from the Vault VMK/generation. Equal bytes deduplicate inside the same Vault generation while identical bytes in another Vault do not expose the same identifier.

## Entity AAD

AES-GCM authenticates:

`["vault/entity-aad/v1", VaultId, EntityId, EntityType, schemaVersion, keyGeneration, ParentId-or-root, NameToken-or-empty, DeletedFlag, BlobId-or-empty]`

Changing server-visible structure without re-encrypting therefore causes authentication failure.

## Compatibility

A2's `sha256Hex` export remains intact, but the implementation now lives in the crypto foundation. Local attachment bytes remain plaintext under the existing A7 local-device threat model.

## Tests

The I2 suite includes:

- RFC 5869 HKDF-SHA-256 vector
- RFC 4231 HMAC-SHA-256 vector
- established AES-256-GCM all-zero vector
- Vault-specific golden NameToken/BlobId/AAD/ciphertext vectors
- NFC and ASCII-only case-folding behavior
- cross-Vault BlobId unlinkability
- structural AAD tamper rejection
- fresh entity nonces
- VMK context destruction behavior

I3 is responsible for persistent non-extractable Device keys, VMK envelopes, Recovery Secret handling and durable key distribution.
