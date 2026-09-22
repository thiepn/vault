import { VaultError } from '../domain/errors.js';
import type { DeviceId, EntryId, OperationId, VaultId } from '../domain/model.js';
import { PROTOCOL_VERSION, type Cursor, type Mutation } from './protocol.js';

export interface RemoteEntrySnapshot {
  entryId: EntryId;
  vaultId: VaultId;
  parentId: EntryId | null;
  name: string;
  kind: 'directory' | 'markdown' | 'attachment';
  revision: number;
  deletedAt: string | null;
  updatedAt: string;
  updatedByDevice: DeviceId;
  text: string | null;
  attachmentSha256: string | null;
  attachmentMimeType: string | null;
  attachmentSize: number | null;
}

export interface RemoteReplicationEvent {
  sequence: Cursor;
  operationId: OperationId;
  entryId: EntryId;
  revision: number;
  kind: Mutation['kind'];
  deviceId: DeviceId;
  snapshot: RemoteEntrySnapshot;
}

export interface RemoteReplicationPage {
  protocolVersion: typeof PROTOCOL_VERSION;
  vaultId: VaultId;
  epoch: string;
  after: Cursor;
  through: Cursor;
  highWatermark: Cursor;
  events: RemoteReplicationEvent[];
}

export interface RemotePushSuccess {
  status: 'ok';
  operationId: OperationId;
  through: Cursor;
  snapshots: RemoteEntrySnapshot[];
}

export interface RemotePushConflict {
  status: 'conflict';
  reason: 'revision' | 'exists' | 'path';
  entryId: EntryId;
  current: RemoteEntrySnapshot | null;
}

export type RemotePushResult = RemotePushSuccess | RemotePushConflict;

const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const hashPattern=/^[0-9a-f]{64}$/u;
const record=(value:unknown): value is Record<string,unknown> => typeof value==='object' && value!==null && !Array.isArray(value);

function safeRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new VaultError('PROTOCOL','Remote revision is invalid.');
  return value;
}
function nullableString(value: unknown): string|null {
  if (value===null) return null;
  if (typeof value!=='string') throw new VaultError('PROTOCOL','Remote snapshot string field is invalid.');
  return value;
}
function cursor(value: unknown): Cursor {
  if (typeof value!=='string' || !/^(0|[1-9][0-9]*)$/u.test(value) || BigInt(value)>9223372036854775807n) {
    throw new VaultError('PROTOCOL','Remote cursor is invalid.');
  }
  return value;
}

export function validateRemoteSnapshot(value: unknown, expectedVaultId?: VaultId): RemoteEntrySnapshot {
  if (!record(value)
    || typeof value.entryId!=='string' || !uuidPattern.test(value.entryId)
    || typeof value.vaultId!=='string' || !uuidPattern.test(value.vaultId)
    || (value.parentId!==null && (typeof value.parentId!=='string' || !uuidPattern.test(value.parentId)))
    || typeof value.name!=='string' || value.name.length<1 || value.name.length>240
    || !['directory','markdown','attachment'].includes(String(value.kind))
    || typeof value.updatedAt!=='string' || !Number.isFinite(Date.parse(value.updatedAt))
    || typeof value.updatedByDevice!=='string' || !uuidPattern.test(value.updatedByDevice)
    || !(value.deletedAt===null || (typeof value.deletedAt==='string' && Number.isFinite(Date.parse(value.deletedAt))))) {
    throw new VaultError('PROTOCOL','Remote entry snapshot is invalid.');
  }
  if (expectedVaultId && value.vaultId!==expectedVaultId) throw new VaultError('PROTOCOL','Remote entry belongs to another Vault.');
  const kind=value.kind as RemoteEntrySnapshot['kind'];
  const text=nullableString(value.text);
  const attachmentSha256=nullableString(value.attachmentSha256);
  const attachmentMimeType=nullableString(value.attachmentMimeType);
  const attachmentSize=value.attachmentSize===null ? null : value.attachmentSize;
  if (kind==='markdown' && text===null) throw new VaultError('PROTOCOL','Remote Markdown entry has no text.');
  if (kind!=='markdown' && text!==null) throw new VaultError('PROTOCOL','Non-Markdown remote entry contains text.');
  if (kind==='attachment') {
    if (!attachmentSha256 || !hashPattern.test(attachmentSha256) || !attachmentMimeType
      || typeof attachmentSize!=='number' || !Number.isSafeInteger(attachmentSize) || attachmentSize<0 || attachmentSize>134217728) {
      throw new VaultError('PROTOCOL','Remote attachment metadata is invalid.');
    }
  } else if (attachmentSha256!==null || attachmentMimeType!==null || attachmentSize!==null) {
    throw new VaultError('PROTOCOL','Non-attachment remote entry contains attachment metadata.');
  }
  return {
    entryId:value.entryId as EntryId,
    vaultId:value.vaultId as VaultId,
    parentId:value.parentId as EntryId|null,
    name:value.name,
    kind,
    revision:safeRevision(value.revision),
    deletedAt:value.deletedAt as string|null,
    updatedAt:value.updatedAt,
    updatedByDevice:value.updatedByDevice as DeviceId,
    text,
    attachmentSha256,
    attachmentMimeType,
    attachmentSize:attachmentSize as number|null,
  };
}

export function validateRemotePage(value: unknown, expected:{vaultId:VaultId;epoch:string;after:Cursor}): RemoteReplicationPage {
  if (!record(value) || value.protocolVersion!==PROTOCOL_VERSION || value.vaultId!==expected.vaultId
    || value.epoch!==expected.epoch || value.after!==expected.after || !Array.isArray(value.events) || value.events.length>1000) {
    throw new VaultError('PROTOCOL','Remote replication page does not match the local Vault cursor.');
  }
  const highWatermark=cursor(value.highWatermark);
  let previous=BigInt(cursor(value.after));
  const events:RemoteReplicationEvent[]=[];
  for(const raw of value.events){
    if(!record(raw) || typeof raw.operationId!=='string' || !uuidPattern.test(raw.operationId)
      || typeof raw.entryId!=='string' || !uuidPattern.test(raw.entryId)
      || typeof raw.deviceId!=='string' || !uuidPattern.test(raw.deviceId)
      || !['create','write','move','trash','restore'].includes(String(raw.kind))) {
      throw new VaultError('PROTOCOL','Remote replication event is invalid.');
    }
    const sequence=cursor(raw.sequence);
    const seq=BigInt(sequence);
    if(seq!==previous+1n || seq>BigInt(highWatermark)) throw new VaultError('PROTOCOL','Remote replication page contains a gap or duplicate.');
    const snapshot=validateRemoteSnapshot(raw.snapshot,expected.vaultId);
    if(snapshot.entryId!==raw.entryId || snapshot.revision!==safeRevision(raw.revision)) throw new VaultError('PROTOCOL','Remote event does not match its snapshot.');
    events.push({
      sequence,
      operationId:raw.operationId as OperationId,
      entryId:raw.entryId as EntryId,
      revision:snapshot.revision,
      kind:raw.kind as Mutation['kind'],
      deviceId:raw.deviceId as DeviceId,
      snapshot,
    });
    previous=seq;
  }
  const through=cursor(value.through);
  if(BigInt(through)!==previous) throw new VaultError('PROTOCOL','Remote page cursor would skip changes.');
  if(!events.length && BigInt(through)!==BigInt(highWatermark)) throw new VaultError('PROTOCOL','Empty remote page cannot skip unseen changes.');
  return {
    protocolVersion:PROTOCOL_VERSION,
    vaultId:expected.vaultId,
    epoch:expected.epoch,
    after:expected.after,
    through,
    highWatermark,
    events,
  };
}

export function validatePushResult(value: unknown, expected:{operationId:OperationId;vaultId:VaultId}): RemotePushResult {
  if(!record(value) || typeof value.status!=='string') throw new VaultError('PROTOCOL','Remote push result is invalid.');
  if(value.status==='conflict'){
    if(!['revision','exists','path'].includes(String(value.reason))
      || typeof value.entryId!=='string' || !uuidPattern.test(value.entryId)) throw new VaultError('PROTOCOL','Remote conflict response is invalid.');
    return {
      status:'conflict',
      reason:value.reason as RemotePushConflict['reason'],
      entryId:value.entryId as EntryId,
      current:value.current===null ? null : validateRemoteSnapshot(value.current,expected.vaultId),
    };
  }
  if(value.status!=='ok' || value.operationId!==expected.operationId || !Array.isArray(value.snapshots)) {
    throw new VaultError('PROTOCOL','Remote push acknowledgement is invalid.');
  }
  return {
    status:'ok',
    operationId:expected.operationId,
    through:cursor(value.through),
    snapshots:value.snapshots.map(snapshot=>validateRemoteSnapshot(snapshot,expected.vaultId)),
  };
}
