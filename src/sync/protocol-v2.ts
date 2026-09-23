import { VaultError } from '../domain/errors.js';
import {
  CANONICAL_ENTITY_TYPES,
  type CanonicalEntityId,
  type CanonicalEntityType,
} from '../domain/canonical.js';
import type { AccountId, DeviceId, OperationId, VaultId } from '../domain/model.js';

export const PROTOCOL_V2_VERSION = 2 as const;
export const ENTITY_ENCRYPTION_VERSION = 1 as const;
export const ENTITY_ENCRYPTION_ALGORITHM = 'A256GCM' as const;

export type CursorV2 = string;
export type RemoteRevision = string;

declare const nameTokenBrand: unique symbol;
declare const remoteBlobIdBrand: unique symbol;

export type NameToken = string & { readonly [nameTokenBrand]: true };
export type RemoteBlobId = string & { readonly [remoteBlobIdBrand]: true };

export interface EncryptedEntityStructural {
  parentId: CanonicalEntityId | null;
  nameToken: NameToken | null;
  deleted: boolean;
  blobId: RemoteBlobId | null;
}

export interface EncryptedPayloadV1 {
  encryptionVersion: typeof ENTITY_ENCRYPTION_VERSION;
  keyGeneration: number;
  algorithm: typeof ENTITY_ENCRYPTION_ALGORITHM;
  nonce: string;
  ciphertext: string;
}

export interface EncryptedEntityMutation {
  kind: 'put';
  entityId: CanonicalEntityId;
  entityType: CanonicalEntityType;
  baseRemoteRevision: RemoteRevision | null;
  schemaVersion: number;
  structural: EncryptedEntityStructural;
  payload: EncryptedPayloadV1;
}

export interface SyncOperationV2 {
  protocolVersion: typeof PROTOCOL_V2_VERSION;
  operationId: OperationId;
  accountId: AccountId;
  vaultId: VaultId;
  deviceId: DeviceId;
  mutations: readonly EncryptedEntityMutation[];
}

export interface SealedOperationV2 {
  protocolVersion: typeof PROTOCOL_V2_VERSION;
  operationId: OperationId;
  accountId: AccountId;
  vaultId: VaultId;
  wire: string;
  sha256: string;
}

export interface SyncEventV2 {
  sequence: CursorV2;
  operationId: OperationId;
  entityId: CanonicalEntityId;
  entityType: CanonicalEntityType;
  remoteRevision: RemoteRevision;
  kind: 'put';
}

export interface ChangePageV2 {
  protocolVersion: typeof PROTOCOL_V2_VERSION;
  vaultId: VaultId;
  epoch: string;
  after: CursorV2;
  through: CursorV2;
  highWatermark: CursorV2;
  events: readonly SyncEventV2[];
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha256HexPattern = /^[0-9a-f]{64}$/u;
const opaqueHmacPattern = /^[A-Za-z0-9_-]{43}$/u;
const noncePattern = /^[A-Za-z0-9_-]{16}$/u;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;
const maxCiphertextChars = 24 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uuidValue(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new VaultError('PROTOCOL', label + ' contains an unsupported field: ' + key + '.');
  }
  for (const key of keys) {
    if (!(key in value)) throw new VaultError('PROTOCOL', label + ' is missing required field: ' + key + '.');
  }
}

function pgBigint(value: unknown, label: string, allowZero = true): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value) || value.length > 19) {
    throw new VaultError('PROTOCOL', label + ' is invalid.');
  }
  const parsed = BigInt(value);
  if ((!allowZero && parsed === 0n) || parsed > 9223372036854775807n) {
    throw new VaultError('PROTOCOL', label + ' exceeds the supported PostgreSQL bigint range.');
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new VaultError('PROTOCOL', label + ' must be a positive safe integer.');
  }
  return value;
}

function canonicalType(value: unknown): value is CanonicalEntityType {
  return typeof value === 'string' && (CANONICAL_ENTITY_TYPES as readonly string[]).includes(value);
}

function opaqueToken(value: unknown, label: string): string {
  if (typeof value !== 'string' || !opaqueHmacPattern.test(value)) {
    throw new VaultError('PROTOCOL', label + ' must be a 32-byte base64url token without padding.');
  }
  return value;
}

function validateStructural(value: unknown): EncryptedEntityStructural {
  if (!record(value)) throw new VaultError('PROTOCOL', 'Encrypted entity structural metadata is invalid.');
  exactKeys(value, ['parentId', 'nameToken', 'deleted', 'blobId'], 'Encrypted entity structural metadata');
  if (value.parentId !== null && !uuidValue(value.parentId)) throw new VaultError('PROTOCOL', 'Encrypted entity parentId is invalid.');
  if (value.nameToken !== null) opaqueToken(value.nameToken, 'NameToken');
  if (typeof value.deleted !== 'boolean') throw new VaultError('PROTOCOL', 'Encrypted entity deleted flag is invalid.');
  if (value.blobId !== null) opaqueToken(value.blobId, 'BlobId');
  return {
    parentId: value.parentId as CanonicalEntityId | null,
    nameToken: value.nameToken as NameToken | null,
    deleted: value.deleted,
    blobId: value.blobId as RemoteBlobId | null,
  };
}

function validatePayload(value: unknown): EncryptedPayloadV1 {
  if (!record(value)) throw new VaultError('PROTOCOL', 'Encrypted entity payload is invalid.');
  exactKeys(value, ['encryptionVersion', 'keyGeneration', 'algorithm', 'nonce', 'ciphertext'], 'Encrypted entity payload');
  if (value.encryptionVersion !== ENTITY_ENCRYPTION_VERSION || value.algorithm !== ENTITY_ENCRYPTION_ALGORITHM) {
    throw new VaultError('PROTOCOL', 'Unsupported entity encryption suite.');
  }
  const keyGeneration = positiveInteger(value.keyGeneration, 'Key generation');
  if (typeof value.nonce !== 'string' || !noncePattern.test(value.nonce)) {
    throw new VaultError('PROTOCOL', 'AES-GCM nonce must be exactly 12 bytes encoded as unpadded base64url.');
  }
  if (typeof value.ciphertext !== 'string'
    || value.ciphertext.length < 22
    || value.ciphertext.length > maxCiphertextChars
    || !base64UrlPattern.test(value.ciphertext)) {
    throw new VaultError('PROTOCOL', 'Encrypted entity ciphertext is invalid or exceeds the synchronization limit.');
  }
  return {
    encryptionVersion: ENTITY_ENCRYPTION_VERSION,
    keyGeneration,
    algorithm: ENTITY_ENCRYPTION_ALGORITHM,
    nonce: value.nonce,
    ciphertext: value.ciphertext,
  };
}

export function validateEncryptedEntityMutationV2(value: unknown): EncryptedEntityMutation {
  if (!record(value)) throw new VaultError('PROTOCOL', 'Encrypted entity mutation is invalid.');
  exactKeys(
    value,
    ['kind', 'entityId', 'entityType', 'baseRemoteRevision', 'schemaVersion', 'structural', 'payload'],
    'Encrypted entity mutation',
  );
  if (value.kind !== 'put' || !uuidValue(value.entityId) || !canonicalType(value.entityType)) {
    throw new VaultError('PROTOCOL', 'Encrypted entity mutation identity or type is invalid.');
  }
  const baseRemoteRevision = value.baseRemoteRevision === null
    ? null
    : pgBigint(value.baseRemoteRevision, 'Base remote revision', false);
  return {
    kind: 'put',
    entityId: value.entityId as CanonicalEntityId,
    entityType: value.entityType,
    baseRemoteRevision,
    schemaVersion: positiveInteger(value.schemaVersion, 'Entity schema version'),
    structural: validateStructural(value.structural),
    payload: validatePayload(value.payload),
  };
}

/**
 * Protocol v2 is deliberately strict and ciphertext-only. Unknown fields are
 * rejected so plaintext compatibility fields such as name/text/mimeType/sha256
 * cannot accidentally leak into the production wire contract.
 */
export function validateOperationV2(value: unknown): asserts value is SyncOperationV2 {
  if (!record(value)) throw new VaultError('PROTOCOL', 'Invalid Protocol v2 operation envelope.');
  exactKeys(value, ['protocolVersion', 'operationId', 'accountId', 'vaultId', 'deviceId', 'mutations'], 'Protocol v2 operation');
  if (value.protocolVersion !== PROTOCOL_V2_VERSION
    || !uuidValue(value.operationId)
    || !uuidValue(value.accountId)
    || !uuidValue(value.vaultId)
    || !uuidValue(value.deviceId)
    || !Array.isArray(value.mutations)
    || value.mutations.length < 1
    || value.mutations.length > 1000) {
    throw new VaultError('PROTOCOL', 'Invalid Protocol v2 operation envelope.');
  }
  const seen = new Set<string>();
  for (const raw of value.mutations) {
    const mutation = validateEncryptedEntityMutationV2(raw);
    if (seen.has(mutation.entityId)) throw new VaultError('PROTOCOL', 'One Protocol v2 operation cannot mutate an entity more than once.');
    seen.add(mutation.entityId);
  }
}

export function decodeOperationV2(wire: string): SyncOperationV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(wire) as unknown;
  } catch {
    throw new VaultError('PROTOCOL', 'Invalid Protocol v2 operation JSON.');
  }
  validateOperationV2(parsed);
  return parsed;
}

export async function sealOperationV2(operation: SyncOperationV2): Promise<SealedOperationV2> {
  validateOperationV2(operation);
  const wire = JSON.stringify(operation);
  const snapshot = decodeOperationV2(wire);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(wire)));
  const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  return Object.freeze({
    protocolVersion: PROTOCOL_V2_VERSION,
    operationId: snapshot.operationId,
    accountId: snapshot.accountId,
    vaultId: snapshot.vaultId,
    wire,
    sha256,
  });
}

export function validateSealedOperationV2(value: SealedOperationV2): void {
  if (value.protocolVersion !== PROTOCOL_V2_VERSION
    || !uuidValue(value.operationId)
    || !uuidValue(value.accountId)
    || !uuidValue(value.vaultId)
    || !sha256HexPattern.test(value.sha256)) {
    throw new VaultError('PROTOCOL', 'Invalid sealed Protocol v2 operation.');
  }
  const decoded = decodeOperationV2(value.wire);
  if (decoded.operationId !== value.operationId || decoded.accountId !== value.accountId || decoded.vaultId !== value.vaultId) {
    throw new VaultError('PROTOCOL', 'Sealed Protocol v2 identity does not match its immutable wire bytes.');
  }
}

export function assertAccountV2(operation: Pick<SealedOperationV2, 'accountId'>, accountId: AccountId): void {
  if (operation.accountId !== accountId) {
    throw new VaultError('ACCOUNT_MISMATCH', 'This queued Protocol v2 operation belongs to a different Vault account.');
  }
}

export function validatePageV2(value: unknown, expected: { vaultId: VaultId; epoch: string; after: CursorV2 }): ChangePageV2 {
  if (!record(value)) throw new VaultError('PROTOCOL', 'Invalid Protocol v2 change page.');
  exactKeys(value, ['protocolVersion', 'vaultId', 'epoch', 'after', 'through', 'highWatermark', 'events'], 'Protocol v2 change page');
  if (value.protocolVersion !== PROTOCOL_V2_VERSION
    || value.vaultId !== expected.vaultId
    || value.epoch !== expected.epoch
    || value.after !== expected.after
    || !uuidValue(value.epoch)
    || !Array.isArray(value.events)
    || value.events.length > 1000) {
    throw new VaultError('PROTOCOL', 'Protocol v2 change page does not match this Vault, protocol or synchronization epoch.');
  }

  const highWatermark = BigInt(pgBigint(value.highWatermark, 'High watermark'));
  let previous = BigInt(pgBigint(value.after, 'Page cursor'));
  if (highWatermark < previous) throw new VaultError('PROTOCOL', 'Protocol v2 server cursor moved backwards.');
  const events: SyncEventV2[] = [];

  for (const raw of value.events) {
    if (!record(raw)) throw new VaultError('PROTOCOL', 'Invalid Protocol v2 synchronization event.');
    exactKeys(raw, ['sequence', 'operationId', 'entityId', 'entityType', 'remoteRevision', 'kind'], 'Protocol v2 synchronization event');
    if (!uuidValue(raw.operationId)
      || !uuidValue(raw.entityId)
      || !canonicalType(raw.entityType)
      || raw.kind !== 'put') {
      throw new VaultError('PROTOCOL', 'Invalid Protocol v2 synchronization event identity.');
    }
    const sequence = pgBigint(raw.sequence, 'Event sequence');
    const next = BigInt(sequence);
    if (next !== previous + 1n || next > highWatermark) {
      throw new VaultError('PROTOCOL', 'Protocol v2 change page contains a gap, duplicate or out-of-range event.');
    }
    events.push({
      sequence,
      operationId: raw.operationId as OperationId,
      entityId: raw.entityId as CanonicalEntityId,
      entityType: raw.entityType,
      remoteRevision: pgBigint(raw.remoteRevision, 'Remote revision', false),
      kind: 'put',
    });
    previous = next;
  }

  const through = pgBigint(value.through, 'Page through cursor');
  if (BigInt(through) !== previous) throw new VaultError('PROTOCOL', 'Protocol v2 page cursor would skip changes.');
  if (!events.length && previous !== highWatermark) throw new VaultError('PROTOCOL', 'An empty Protocol v2 page cannot skip unseen changes.');

  return {
    protocolVersion: PROTOCOL_V2_VERSION,
    vaultId: expected.vaultId,
    epoch: expected.epoch,
    after: expected.after,
    through,
    highWatermark: highWatermark.toString(),
    events,
  };
}
