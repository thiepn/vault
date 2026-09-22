import { VaultError } from '../domain/errors.js';
import { newId, type DeviceId, type EntryId, type OperationId, type Vault } from '../domain/model.js';
import type { SyncLocalState } from './local-state.js';
import type { SyncReplicaStore } from './replica-store.js';
import { sealOperation, type Mutation, type Operation, type SealedOperation } from './protocol.js';

export interface PendingBlobUpload {
  entryId: EntryId;
  sha256: string;
  mimeType: string;
  size: number;
  bytes: Uint8Array;
}

export interface SynthesizedOperation {
  sealed: SealedOperation;
  entryId: EntryId;
  blobs: PendingBlobUpload[];
}

export async function synthesizeEntryOperation(input:{
  vault: Vault;
  ownerId: string;
  deviceId: DeviceId;
  entryId: EntryId;
  state: SyncLocalState;
  replica: SyncReplicaStore;
}):Promise<SynthesizedOperation|null>{
  const {vault,ownerId,deviceId,entryId,state,replica}=input;
  if(vault.mode!=='cloud' || !vault.cloud) throw new VaultError('PROTOCOL','Only an adopted cloud Vault can synthesize remote operations.');
  if(vault.cloud.authUserId!==ownerId || vault.cloud.deviceId!==deviceId) throw new VaultError('ACCOUNT_MISMATCH','Cloud binding does not match the active account/device.');

  const local=await replica.read(entryId);
  if(!local || local.entry.vaultId!==vault.id) return null;

  const pending=await state.pendingForEntry(vault.id,ownerId,entryId);
  if(pending.length) return null;

  const shadow=await state.shadow(entryId,ownerId,vault.cloud.epoch);
  const mutations:Mutation[]=[];
  const blobs:PendingBlobUpload[]=[];

  if(!shadow){
    let attachment:Mutation extends infer _ ? never : never;
    let attachmentRef: import('./protocol.js').RemoteAttachmentRef|undefined;
    if(local.entry.kind==='attachment'){
      const blob=await replica.localAttachmentHash(entryId);
      attachmentRef={sha256:blob.sha256,mimeType:blob.mimeType,size:blob.size};
      blobs.push({entryId,sha256:blob.sha256,mimeType:blob.mimeType,size:blob.size,bytes:blob.bytes});
    }
    mutations.push({
      kind:'create',
      entryId,
      parentId:local.entry.parentId,
      name:local.entry.name,
      entryKind:local.entry.kind,
      text:local.entry.kind==='markdown' ? local.text ?? '' : '',
      ...(attachmentRef ? {attachment:attachmentRef} : {}),
    });
    if(local.entry.deletedAt!==null) mutations.push({kind:'trash',entryId,baseRevision:1});
  } else {
    const remote=shadow.snapshot;
    if(remote.kind!==local.entry.kind) throw new VaultError('PROTOCOL','Local entry kind differs from its last synchronized remote state.');
    let revision=remote.revision;

    if(remote.deletedAt!==null && local.entry.deletedAt===null){
      mutations.push({kind:'restore',entryId,baseRevision:revision});
      revision++;
    }

    if(remote.parentId!==local.entry.parentId || remote.name!==local.entry.name){
      mutations.push({kind:'move',entryId,baseRevision:revision,parentId:local.entry.parentId,name:local.entry.name});
      revision++;
    }

    if(local.entry.kind==='markdown' && remote.text!==local.text){
      mutations.push({kind:'write',entryId,baseRevision:revision,text:local.text ?? ''});
      revision++;
    }

    if(local.entry.kind==='attachment'){
      const blob=await replica.localAttachmentHash(entryId);
      if(remote.attachmentSha256!==blob.sha256 || remote.attachmentMimeType!==blob.mimeType || remote.attachmentSize!==blob.size){
        throw new VaultError('STALE_WRITE','Attachment bytes changed after synchronization. Duplicate the attachment to preserve both versions before syncing.');
      }
    }

    if(remote.deletedAt===null && local.entry.deletedAt!==null){
      mutations.push({kind:'trash',entryId,baseRevision:revision});
      revision++;
    }
  }

  if(!mutations.length) return null;
  const operation:Operation={
    protocolVersion:1,
    id:newId<'operation'>() as OperationId,
    vaultId:vault.id,
    deviceId,
    ownerId,
    mutations,
  };
  return {sealed:await sealOperation(operation),entryId,blobs};
}
