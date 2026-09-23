import { VaultError } from '../domain/errors.js';
import type { CanonicalEntityType } from '../domain/canonical.js';
import type { VaultId } from '../domain/model.js';
import {
  AES_GCM_NONCE_BYTES,
  aes256GcmDecrypt,
  aes256GcmEncrypt,
  randomBytes,
} from './primitives.js';
import {
  base64UrlDecode,
  base64UrlEncode,
  canonicalContext,
  canonicalUuid,
} from './encoding.js';
import { assertVaultMasterKey, deriveEntityKey } from './keys.js';
import {
  ENTITY_ENCRYPTION_ALGORITHM,
  ENTITY_ENCRYPTION_VERSION,
  type EncryptedPayloadV1,
  type NameToken,
  type RemoteBlobId,
} from '../sync/protocol-v2.js';

export interface EntityAadMetadataV1 {
  vaultId: VaultId;
  entityId: string;
  entityType: CanonicalEntityType;
  schemaVersion: number;
  keyGeneration: number;
  parentId: string | null;
  nameToken: NameToken | null;
  deleted: boolean;
  blobId: RemoteBlobId | null;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new VaultError('PROTOCOL', label + ' must be a positive safe integer.');
  return value;
}

export function entityAadV1(metadata: EntityAadMetadataV1): Uint8Array {
  return canonicalContext([
    'vault/entity-aad/v1',
    canonicalUuid(metadata.vaultId, 'VaultId'),
    canonicalUuid(metadata.entityId, 'EntityId'),
    metadata.entityType,
    positiveInteger(metadata.schemaVersion, 'Entity schema version'),
    positiveInteger(metadata.keyGeneration, 'Key generation'),
    metadata.parentId === null ? 'root' : canonicalUuid(metadata.parentId, 'ParentId'),
    metadata.nameToken ?? '',
    metadata.deleted,
    metadata.blobId ?? '',
  ]);
}

export async function encryptEntityPayloadV1(input: {
  vmk: Uint8Array;
  metadata: EntityAadMetadataV1;
  plaintext: Uint8Array;
}): Promise<EncryptedPayloadV1> {
  assertVaultMasterKey(input.vmk);
  if (!(input.plaintext instanceof Uint8Array)) throw new VaultError('PROTOCOL', 'Entity plaintext must be binary bytes.');
  const key = await deriveEntityKey({
    vmk: input.vmk,
    vaultId: input.metadata.vaultId,
    entityId: input.metadata.entityId,
    entityType: input.metadata.entityType,
    keyGeneration: input.metadata.keyGeneration,
  });
  const nonce = randomBytes(AES_GCM_NONCE_BYTES);
  const ciphertext = await aes256GcmEncrypt(key, nonce, input.plaintext, entityAadV1(input.metadata));
  return {
    encryptionVersion: ENTITY_ENCRYPTION_VERSION,
    keyGeneration: input.metadata.keyGeneration,
    algorithm: ENTITY_ENCRYPTION_ALGORITHM,
    nonce: base64UrlEncode(nonce),
    ciphertext: base64UrlEncode(ciphertext),
  };
}

export async function decryptEntityPayloadV1(input: {
  vmk: Uint8Array;
  metadata: EntityAadMetadataV1;
  payload: EncryptedPayloadV1;
}): Promise<Uint8Array> {
  assertVaultMasterKey(input.vmk);
  if (input.payload.encryptionVersion !== ENTITY_ENCRYPTION_VERSION
    || input.payload.algorithm !== ENTITY_ENCRYPTION_ALGORITHM
    || input.payload.keyGeneration !== input.metadata.keyGeneration) {
    throw new VaultError('PROTOCOL', 'Encrypted entity payload does not match the expected crypto suite or key generation.');
  }
  const nonce = base64UrlDecode(input.payload.nonce);
  if (nonce.byteLength !== AES_GCM_NONCE_BYTES) throw new VaultError('PROTOCOL', 'Encrypted entity nonce length is invalid.');
  const ciphertext = base64UrlDecode(input.payload.ciphertext);
  const key = await deriveEntityKey({
    vmk: input.vmk,
    vaultId: input.metadata.vaultId,
    entityId: input.metadata.entityId,
    entityType: input.metadata.entityType,
    keyGeneration: input.metadata.keyGeneration,
  });
  return aes256GcmDecrypt(key, nonce, ciphertext, entityAadV1(input.metadata));
}
