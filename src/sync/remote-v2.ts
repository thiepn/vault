import { VaultError } from '../domain/errors.js';
import {
  CANONICAL_ENTITY_TYPES,
  type CanonicalEntityId,
  type CanonicalEntityType,
} from '../domain/canonical.js';
import type { DeviceId, OperationId, VaultId } from '../domain/model.js';
import {
  PROTOCOL_V2_VERSION,
  validateEncryptedEntityMutationV2,
  type CursorV2,
  type EncryptedEntityStructural,
  type EncryptedPayloadV1,
  type RemoteRevision,
} from './protocol-v2.js';

export interface EncryptedRemoteSnapshotV2 {
  entityId: CanonicalEntityId;
  vaultId: VaultId;
  entityType: CanonicalEntityType;
  remoteRevision: RemoteRevision;
  sequence: CursorV2;
  schemaVersion: number;
  structural: EncryptedEntityStructural;
  payload: EncryptedPayloadV1;
  operationId: OperationId;
  updatedByDevice: DeviceId;
  updatedAt: string;
}

export interface EncryptedRemoteEventV2 {
  sequence: CursorV2;
  operationId: OperationId;
  entityId: CanonicalEntityId;
  entityType: CanonicalEntityType;
  remoteRevision: RemoteRevision;
  kind: 'put';
  snapshot: EncryptedRemoteSnapshotV2;
}

export interface EncryptedRemotePageV2 {
  protocolVersion: typeof PROTOCOL_V2_VERSION;
  vaultId: VaultId;
  epoch: string;
  after: CursorV2;
  through: CursorV2;
  highWatermark: CursorV2;
  events: readonly EncryptedRemoteEventV2[];
}

export interface EncryptedPushSuccessV2 {
  status: 'ok';
  operationId: OperationId;
  firstSequence: CursorV2;
  through: CursorV2;
  snapshots: readonly EncryptedRemoteSnapshotV2[];
}

export type EncryptedConflictReasonV2 =
  | 'revision'
  | 'exists'
  | 'name'
  | 'parent'
  | 'cycle'
  | 'blob'
  | 'type';

export interface EncryptedPushConflictV2 {
  status: 'conflict';
  reason: EncryptedConflictReasonV2;
  entityId: CanonicalEntityId;
  current: EncryptedRemoteSnapshotV2 | null;
}

export type EncryptedPushResultV2 = EncryptedPushSuccessV2 | EncryptedPushConflictV2;

export interface BootstrapDescriptorV2 {
  protocolVersion: typeof PROTOCOL_V2_VERSION;
  vaultId: VaultId;
  epoch: string;
  snapshotSequence: CursorV2;
  entityCount: number;
}

export interface BootstrapPageV2 {
  protocolVersion: typeof PROTOCOL_V2_VERSION;
  vaultId: VaultId;
  epoch: string;
  snapshotSequence: CursorV2;
  afterEntityId: CanonicalEntityId | null;
  nextAfterEntityId: CanonicalEntityId | null;
  done: boolean;
  items: readonly EncryptedRemoteSnapshotV2[];
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const cursorPattern = /^(0|[1-9][0-9]*)$/u;
const maxBigint = 9223372036854775807n;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new VaultError('PROTOCOL', label + ' contains unsupported field: ' + key + '.');
  }
  for (const key of keys) {
    if (!(key in value)) throw new VaultError('PROTOCOL', label + ' is missing required field: ' + key + '.');
  }
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new VaultError('PROTOCOL', label + ' is invalid.');
  return value;
}

function cursor(value: unknown, label: string, allowZero = true): string {
  if (typeof value !== 'string' || !cursorPattern.test(value) || value.length > 19) {
    throw new VaultError('PROTOCOL', label + ' is invalid.');
  }
  const parsed = BigInt(value);
  if ((!allowZero && parsed === 0n) || parsed > maxBigint) throw new VaultError('PROTOCOL', label + ' exceeds PostgreSQL bigint.');
  return value;
}

function entityType(value: unknown): CanonicalEntityType {
  if (typeof value !== 'string' || !(CANONICAL_ENTITY_TYPES as readonly string[]).includes(value)) {
    throw new VaultError('PROTOCOL', 'Encrypted remote entity type is invalid.');
  }
  return value as CanonicalEntityType;
}

function safePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new VaultError('PROTOCOL', label + ' must be a positive safe integer.');
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new VaultError('PROTOCOL', label + ' is invalid.');
  return value;
}

export function validateEncryptedRemoteSnapshotV2(
  value: unknown,
  expectedVaultId?: VaultId,
): EncryptedRemoteSnapshotV2 {
  if (!record(value)) throw new VaultError('PROTOCOL', 'Encrypted remote snapshot is invalid.');
  exactKeys(
    value,
    [
      'entityId',
      'vaultId',
      'entityType',
      'remoteRevision',
      'sequence',
      'schemaVersion',
      'structural',
      'payload',
      'operationId',
      'updatedByDevice',
      'updatedAt',
    ],
    'Encrypted remote snapshot',
  );
  const vaultId = uuid(value.vaultId, 'Encrypted remote VaultId') as VaultId;
  if (expectedVaultId !== undefined && vaultId !== expectedVaultId) {
    throw new VaultError('PROTOCOL', 'Encrypted remote snapshot belongs to another Vault.');
  }
  const type = entityType(value.entityType);
  const revision = cursor(value.remoteRevision, 'Encrypted remote revision', false);
  const schemaVersion = safePositiveInteger(value.schemaVersion, 'Encrypted remote schema version');
  const mutation = validateEncryptedEntityMutationV2({
    kind: 'put',
    entityId: value.entityId,
    entityType: type,
    baseRemoteRevision: revision,
    schemaVersion,
    structural: value.structural,
    payload: value.payload,
  });
  return {
    entityId: mutation.entityId,
    vaultId,
    entityType: type,
    remoteRevision: revision,
    sequence: cursor(value.sequence, 'Encrypted remote sequence', false),
    schemaVersion,
    structural: mutation.structural,
    payload: mutation.payload,
    operationId: uuid(value.operationId, 'Encrypted remote operationId') as OperationId,
    updatedByDevice: uuid(value.updatedByDevice, 'Encrypted remote DeviceId') as DeviceId,
    updatedAt: timestamp(value.updatedAt, 'Encrypted remote updatedAt'),
  };
}

export function validateEncryptedRemotePageV2(
  value: unknown,
  expected: { vaultId: VaultId; epoch: string; after: CursorV2 },
): EncryptedRemotePageV2 {
  if (!record(value)) throw new VaultError('PROTOCOL', 'Encrypted remote page is invalid.');
  exactKeys(value, ['protocolVersion', 'vaultId', 'epoch', 'after', 'through', 'highWatermark', 'events'], 'Encrypted remote page');
  if (value.protocolVersion !== PROTOCOL_V2_VERSION
    || value.vaultId !== expected.vaultId
    || value.epoch !== expected.epoch
    || value.after !== expected.after
    || !uuidPattern.test(String(value.epoch))
    || !Array.isArray(value.events)
    || value.events.length > 1000) {
    throw new VaultError('PROTOCOL', 'Encrypted remote page does not match this Vault, epoch or protocol.');
  }
  const highWatermark = BigInt(cursor(value.highWatermark, 'Encrypted remote high watermark'));
  let previous = BigInt(cursor(value.after, 'Encrypted remote page cursor'));
  if (highWatermark < previous) throw new VaultError('PROTOCOL', 'Encrypted remote high watermark moved backwards.');
  const events: EncryptedRemoteEventV2[] = [];
  for (const raw of value.events) {
    if (!record(raw)) throw new VaultError('PROTOCOL', 'Encrypted remote event is invalid.');
    exactKeys(raw, ['sequence', 'operationId', 'entityId', 'entityType', 'remoteRevision', 'kind', 'snapshot'], 'Encrypted remote event');
    if (raw.kind !== 'put') throw new VaultError('PROTOCOL', 'Encrypted remote event kind is invalid.');
    const sequence = cursor(raw.sequence, 'Encrypted remote event sequence', false);
    const next = BigInt(sequence);
    if (next !== previous + 1n || next > highWatermark) {
      throw new VaultError('PROTOCOL', 'Encrypted remote page contains a gap, duplicate or out-of-range event.');
    }
    const snapshot = validateEncryptedRemoteSnapshotV2(raw.snapshot, expected.vaultId);
    const operationId = uuid(raw.operationId, 'Encrypted remote event operationId') as OperationId;
    const entityId = uuid(raw.entityId, 'Encrypted remote event EntityId') as CanonicalEntityId;
    const type = entityType(raw.entityType);
    const remoteRevision = cursor(raw.remoteRevision, 'Encrypted remote event revision', false);
    if (snapshot.sequence !== sequence
      || snapshot.operationId !== operationId
      || snapshot.entityId !== entityId
      || snapshot.entityType !== type
      || snapshot.remoteRevision !== remoteRevision) {
      throw new VaultError('PROTOCOL', 'Encrypted remote event does not match its immutable entity version.');
    }
    events.push({
      sequence,
      operationId,
      entityId,
      entityType: type,
      remoteRevision,
      kind: 'put',
      snapshot,
    });
    previous = next;
  }
  const through = cursor(value.through, 'Encrypted remote through cursor');
  if (BigInt(through) !== previous) throw new VaultError('PROTOCOL', 'Encrypted remote page cursor would skip changes.');
  if (!events.length && previous !== highWatermark) throw new VaultError('PROTOCOL', 'Empty encrypted remote page cannot skip unseen changes.');
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

export function validateEncryptedPushResultV2(
  value: unknown,
  expected: { operationId: OperationId; vaultId: VaultId },
): EncryptedPushResultV2 {
  if (!record(value) || typeof value.status !== 'string') throw new VaultError('PROTOCOL', 'Encrypted push result is invalid.');
  if (value.status === 'conflict') {
    exactKeys(value, ['status', 'reason', 'entityId', 'current'], 'Encrypted push conflict');
    const reasons: readonly EncryptedConflictReasonV2[] = ['revision', 'exists', 'name', 'parent', 'cycle', 'blob', 'type'];
    if (!reasons.includes(value.reason as EncryptedConflictReasonV2)) throw new VaultError('PROTOCOL', 'Encrypted push conflict reason is invalid.');
    return {
      status: 'conflict',
      reason: value.reason as EncryptedConflictReasonV2,
      entityId: uuid(value.entityId, 'Encrypted conflict EntityId') as CanonicalEntityId,
      current: value.current === null ? null : validateEncryptedRemoteSnapshotV2(value.current, expected.vaultId),
    };
  }
  exactKeys(value, ['status', 'operationId', 'firstSequence', 'through', 'snapshots'], 'Encrypted push result');
  if (value.status !== 'ok' || value.operationId !== expected.operationId || !Array.isArray(value.snapshots) || value.snapshots.length < 1) {
    throw new VaultError('PROTOCOL', 'Encrypted push acknowledgement is invalid.');
  }
  const firstSequence = cursor(value.firstSequence, 'Encrypted push first sequence', false);
  const through = cursor(value.through, 'Encrypted push through sequence', false);
  if (BigInt(through) < BigInt(firstSequence)) throw new VaultError('PROTOCOL', 'Encrypted push sequence range is invalid.');
  const snapshots = value.snapshots.map(raw => validateEncryptedRemoteSnapshotV2(raw, expected.vaultId));
  if (snapshots[0]?.sequence !== firstSequence || snapshots.at(-1)?.sequence !== through) {
    throw new VaultError('PROTOCOL', 'Encrypted push acknowledgement sequence range does not match its snapshots.');
  }
  return {
    status: 'ok',
    operationId: expected.operationId,
    firstSequence,
    through,
    snapshots,
  };
}

export function validateBootstrapDescriptorV2(
  value: unknown,
  expectedVaultId: VaultId,
  expectedEpoch: string,
): BootstrapDescriptorV2 {
  if (!record(value)) throw new VaultError('PROTOCOL', 'Encrypted bootstrap descriptor is invalid.');
  exactKeys(value, ['protocolVersion', 'vaultId', 'epoch', 'snapshotSequence', 'entityCount'], 'Encrypted bootstrap descriptor');
  if (value.protocolVersion !== PROTOCOL_V2_VERSION || value.vaultId !== expectedVaultId || value.epoch !== expectedEpoch) {
    throw new VaultError('PROTOCOL', 'Encrypted bootstrap descriptor does not match this Vault.');
  }
  if (typeof value.entityCount !== 'number' || !Number.isSafeInteger(value.entityCount) || value.entityCount < 0) {
    throw new VaultError('PROTOCOL', 'Encrypted bootstrap entity count is invalid.');
  }
  return {
    protocolVersion: PROTOCOL_V2_VERSION,
    vaultId: expectedVaultId,
    epoch: expectedEpoch,
    snapshotSequence: cursor(value.snapshotSequence, 'Encrypted bootstrap snapshot sequence'),
    entityCount: value.entityCount,
  };
}

export function validateBootstrapPageV2(
  value: unknown,
  expected: { vaultId: VaultId; epoch: string; snapshotSequence: CursorV2; afterEntityId: CanonicalEntityId | null },
): BootstrapPageV2 {
  if (!record(value)) throw new VaultError('PROTOCOL', 'Encrypted bootstrap page is invalid.');
  exactKeys(
    value,
    ['protocolVersion', 'vaultId', 'epoch', 'snapshotSequence', 'afterEntityId', 'nextAfterEntityId', 'done', 'items'],
    'Encrypted bootstrap page',
  );
  if (value.protocolVersion !== PROTOCOL_V2_VERSION
    || value.vaultId !== expected.vaultId
    || value.epoch !== expected.epoch
    || value.snapshotSequence !== expected.snapshotSequence
    || value.afterEntityId !== expected.afterEntityId
    || typeof value.done !== 'boolean'
    || !Array.isArray(value.items)
    || value.items.length > 1000) {
    throw new VaultError('PROTOCOL', 'Encrypted bootstrap page does not match its fixed snapshot.');
  }
  const items = value.items.map(raw => validateEncryptedRemoteSnapshotV2(raw, expected.vaultId));
  let previous = expected.afterEntityId as string | null;
  for (const item of items) {
    if (BigInt(item.sequence) > BigInt(expected.snapshotSequence)) {
      throw new VaultError('PROTOCOL', 'Encrypted bootstrap page contains a version newer than its snapshot high watermark.');
    }
    if (previous !== null && item.entityId <= previous) {
      throw new VaultError('PROTOCOL', 'Encrypted bootstrap page is not in strict EntityId keyset order.');
    }
    previous = item.entityId;
  }
  const nextAfterEntityId = value.nextAfterEntityId === null
    ? null
    : uuid(value.nextAfterEntityId, 'Encrypted bootstrap next EntityId') as CanonicalEntityId;
  if (items.length === 0 && nextAfterEntityId !== null) {
    throw new VaultError('PROTOCOL', 'Empty encrypted bootstrap page cannot advance its EntityId cursor.');
  }
  if (value.done) {
    if (nextAfterEntityId !== null) {
      throw new VaultError('PROTOCOL', 'Completed encrypted bootstrap page must clear its next cursor.');
    }
  } else {
    if (items.length === 0 || nextAfterEntityId !== items.at(-1)?.entityId) {
      throw new VaultError('PROTOCOL', 'Incomplete encrypted bootstrap page must continue from its final returned entity.');
    }
  }
  return {
    protocolVersion: PROTOCOL_V2_VERSION,
    vaultId: expected.vaultId,
    epoch: expected.epoch,
    snapshotSequence: expected.snapshotSequence,
    afterEntityId: expected.afterEntityId,
    nextAfterEntityId,
    done: value.done,
    items,
  };
}
