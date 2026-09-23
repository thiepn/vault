import { VaultError } from '../domain/errors.js';
import { nameKey, validateName } from '../domain/paths.js';
import type { CanonicalEntityType } from '../domain/canonical.js';
import type { VaultId } from '../domain/model.js';
import {
  base64UrlEncode,
  canonicalContext,
  canonicalUuid,
} from './encoding.js';
import {
  deriveAes256GcmKey,
  deriveHmacSha256Key,
  randomBytes,
  signHmacSha256,
} from './primitives.js';
import type { NameToken, RemoteBlobId } from '../sync/protocol-v2.js';

export const VMK_BYTES = 32;

export function generateVaultMasterKey(): Uint8Array {
  return randomBytes(VMK_BYTES);
}

export function assertVaultMasterKey(vmk: Uint8Array): void {
  if (!(vmk instanceof Uint8Array) || vmk.byteLength !== VMK_BYTES) {
    throw new VaultError('PROTOCOL', 'Vault Master Key must be exactly 256 bits.');
  }
}

function generation(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new VaultError('PROTOCOL', 'Vault key generation must be a positive integer.');
  return value;
}

function kdfSalt(vaultId: VaultId, keyGeneration: number): Uint8Array {
  return canonicalContext([
    'vault/hkdf-salt/v1',
    canonicalUuid(vaultId, 'VaultId'),
    generation(keyGeneration),
  ]);
}

export async function deriveEntityKey(input: {
  vmk: Uint8Array;
  vaultId: VaultId;
  entityId: string;
  entityType: CanonicalEntityType;
  keyGeneration: number;
}): Promise<CryptoKey> {
  assertVaultMasterKey(input.vmk);
  const vaultId = canonicalUuid(input.vaultId, 'VaultId');
  const entityId = canonicalUuid(input.entityId, 'EntityId');
  const keyGeneration = generation(input.keyGeneration);
  return deriveAes256GcmKey(
    input.vmk,
    kdfSalt(input.vaultId, keyGeneration),
    canonicalContext([
      'vault/entity-key/v1',
      vaultId,
      entityId,
      input.entityType,
      keyGeneration,
    ]),
  );
}

export async function deriveNameTokenKey(input: {
  vmk: Uint8Array;
  vaultId: VaultId;
  keyGeneration: number;
}): Promise<CryptoKey> {
  assertVaultMasterKey(input.vmk);
  const vaultId = canonicalUuid(input.vaultId, 'VaultId');
  const keyGeneration = generation(input.keyGeneration);
  return deriveHmacSha256Key(
    input.vmk,
    kdfSalt(input.vaultId, keyGeneration),
    canonicalContext(['vault/name-token-key/v1', vaultId, keyGeneration]),
  );
}

export async function createNameToken(input: {
  vmk: Uint8Array;
  vaultId: VaultId;
  parentId: string | null;
  name: string;
  keyGeneration: number;
}): Promise<NameToken> {
  const vaultId = canonicalUuid(input.vaultId, 'VaultId');
  const parent = input.parentId === null ? 'root' : canonicalUuid(input.parentId, 'ParentId');
  const normalized = nameKey(validateName(input.name));
  const key = await deriveNameTokenKey(input);
  const digest = await signHmacSha256(
    key,
    canonicalContext(['vault/name-token/v1', vaultId, parent, normalized]),
  );
  return base64UrlEncode(digest) as NameToken;
}

export async function deriveBlobIdKey(input: {
  vmk: Uint8Array;
  vaultId: VaultId;
  keyGeneration: number;
}): Promise<CryptoKey> {
  assertVaultMasterKey(input.vmk);
  const vaultId = canonicalUuid(input.vaultId, 'VaultId');
  const keyGeneration = generation(input.keyGeneration);
  return deriveHmacSha256Key(
    input.vmk,
    kdfSalt(input.vaultId, keyGeneration),
    canonicalContext(['vault/blob-id-key/v1', vaultId, keyGeneration]),
  );
}

export async function createBlobId(input: {
  vmk: Uint8Array;
  vaultId: VaultId;
  plaintextSha256: Uint8Array;
  keyGeneration: number;
}): Promise<RemoteBlobId> {
  if (!(input.plaintextSha256 instanceof Uint8Array) || input.plaintextSha256.byteLength !== 32) {
    throw new VaultError('PROTOCOL', 'BlobId requires the raw 32-byte plaintext SHA-256 digest.');
  }
  const key = await deriveBlobIdKey(input);
  const digest = await signHmacSha256(key, input.plaintextSha256);
  return base64UrlEncode(digest) as RemoteBlobId;
}
