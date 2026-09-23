# I3 — Device Keys, Recovery Secret & Key Distribution

Status: implemented key-distribution foundation. Protocol v2 canonical content remains disabled until I4.

## Device identity

Each `(AccountId, DeviceId)` has its own RSA-OAEP 3072-bit SHA-256 key pair.

- the private CryptoKey is non-extractable;
- the public SPKI is exportable;
- fingerprint = SHA-256(SPKI), encoded as unpadded base64url;
- silent replacement of a registered public key is rejected;
- browser persistence uses a separate IndexedDB keyring and structured-clones the non-extractable private CryptoKey.

Device identity is deliberately distinct from an Auth session.

## Device VMK envelope

A Vault Master Key generation is wrapped to a Device with RSA-OAEP. The OAEP label is:

`["vault/device-vmk-envelope/v1", AccountId, VaultId, DeviceId, keyGeneration, publicKeyFingerprint]`

Changing any bound identity makes decryption fail.

## Recovery Secret

The Account recovery credential is a random 256-bit value that never goes to the server.

Human representation:

- version prefix `VLT1`;
- uppercase base32;
- checksum;
- grouped for transcription/printing.

Every retained Vault VMK generation receives an AES-256-GCM Recovery envelope derived from the Recovery Secret using versioned Account/Vault/generation context.

The backend stores only ciphertext and a generation-scoped possession verifier; it does not store the Recovery Secret.

## READY gate

Encrypted Vault key state is READY only when the server can prove that the active generation has all of:

1. an envelope for the current authorized Device;
2. a Recovery envelope;
3. active Device-Vault authorization.

The server now stores `vault_private.vault_key_state.active_generation` explicitly. Active generation is never inferred from the maximum envelope visible to a particular Device.

## New Device approval

A new Device:

1. registers its immutable public key;
2. creates a time-limited access request;
3. an already-authorized Device verifies the target key/fingerprint;
4. the trusted Device wraps **every retained VMK generation** to the target;
5. the target decrypts the active generation and returns a VMK-derived confirmation HMAC;
6. only then does the server authorize the Device for the Vault.

This allows the new Device to read old unchanged content/history after future rotations.

## Recovery

A replacement Device can recover without an old Device private key:

1. retrieve all Recovery envelopes for the Vault;
2. decrypt all generations locally using the Recovery Secret;
3. wrap each generation to the replacement Device;
4. submit generation-scoped possession proofs;
5. server verifies complete generation coverage before authorizing the Device.

Wrong Recovery Secrets fail locally during AES-GCM authentication.

## VMK rotation

VMK rotation is one server transaction:

- active generation must still equal N;
- new generation must be N+1;
- every currently authorized, non-revoked Device in the current Account must receive a new envelope;
- a Recovery envelope/proof for the new generation must be included;
- only after all inserts succeed does `active_generation` advance.

Old generations remain retained for old content/history. Revoked Devices are excluded.

Cross-Account E2EE sharing is deliberately not activated by I3; Protocol v2 content remains disabled and that broader sharing model requires explicit follow-up rather than weakening key isolation.

## Recovery Secret rotation

Recovery Secret rotation does **not** re-encrypt canonical content.

The current authorized Device opens every retained Device envelope locally, generates a new random Recovery Secret, re-wraps every VMK generation, and replaces all Recovery envelopes/proofs atomically. Old Recovery Secret possession then no longer opens the current server Recovery envelopes.

## Server boundary

Sensitive key tables live under `vault_private`, have RLS enabled as defense in depth, and grant no direct access to `anon` or `authenticated`.

Public RPCs are narrowly scoped `SECURITY DEFINER` functions with an empty `search_path`; every RPC resolves `auth.uid()` to AccountId and checks membership/Device authorization before touching private rows.

## Deliberate boundary

I3 does not:

- upload canonical Note/Attachment plaintext;
- enable Protocol v2 content ingestion;
- place a server master decryption key anywhere;
- persist raw VMKs in ordinary Settings;
- place private Device keys or the Recovery Secret in Vault archives.

I4 is the next gate: encrypted remote entity heads, immutable versions, operation idempotency and ordered event history.
