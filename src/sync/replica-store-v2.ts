import { VaultError } from '../domain/errors.js';
import { canonicalIdFromEntry, entryIdFromCanonical } from '../domain/canonical.js';
import { activeKey, markdownName, validateName } from '../domain/paths.js';
import { nextVersion } from '../domain/integrity.js';
import type {
  AccountId,
  DirtyEntry,
  Entry,
  EntryId,
  LocalRevision,
  MarkdownContent,
  Vault,
  VaultId,
} from '../domain/model.js';
import type { A2Persistence } from '../storage/a2-persistence.js';
import { storageDriver, type LocalStorageDriver, type StorageTransaction } from '../storage/driver.js';
import {
  markSyncConflictResolutionInTx,
  openSyncConflictInTx,
  updateSyncConflictInTx,
  upsertSyncConflictInTx,
  type SyncConflictRecordV2,
} from './conflict-store-v2.js';
import { decodeOperationV2, type EncryptedEntityStructural } from './protocol-v2.js';
import type { SyncOutboxRecordV2 } from './local-state-v2.js';
import {
  reconcileSyncEntityV2,
  type SyncEntityStateV2,
} from './reconcile-v2.js';
import type { DecryptedSyncEntityV2, SyncPlaintextPayloadV1 } from './serialization-v2.js';
import { localMatchesDecryptedV2 } from './serialization-v2.js';

export interface SyncRemoteShadowV2 {
  protocolVersion: 2;
  entryId: EntryId;
  vaultId: VaultId;
  accountId: AccountId;
  epoch: string;
  entityType: 'folder' | 'note';
  /** Last clean merge base. Never overwritten merely because a conflict was observed. */
  remoteRevision: string;
  remoteSequence: string;
  structural: EncryptedEntityStructural;
  basePayload: SyncPlaintextPayloadV1;
  baseStateSha256: string;
  encryptionVersion: 1;
  keyGeneration: number;
  /** Latest remote state seen while a conflict is open. */
  observedRemoteRevision?: string;
  observedRemoteSequence?: string;
  observedStructural?: EncryptedEntityStructural;
  observedPayload?: SyncPlaintextPayloadV1;
  observedStateSha256?: string;
  observedKeyGeneration?: number;
  updatedAt: string;
}

export interface ApplyEncryptedPageResult {
  observedOwnOperations: number;
  appliedRemoteEntities: number;
  localChangedAfterOwnPush: number;
  conflictsCaptured: number;
  autoMergedEntities: number;
  cursor: string;
}

function shadowFor(accountId:AccountId,epoch:string,remote:DecryptedSyncEntityV2):SyncRemoteShadowV2{
  return {
    protocolVersion:2,
    entryId:remote.entityId,
    vaultId:remote.vaultId,
    accountId,
    epoch,
    entityType:remote.entityType,
    remoteRevision:remote.remoteRevision,
    remoteSequence:remote.sequence,
    structural:{
      parentId:remote.parentId ? canonicalIdFromEntry('folder',remote.parentId) : null,
      nameToken:remote.nameToken,
      deleted:remote.deleted,
      blobId:null,
    },
    basePayload:structuredClone(remote.payload),
    baseStateSha256:remote.stateHash,
    encryptionVersion:1,
    keyGeneration:remote.keyGeneration,
    updatedAt:new Date().toISOString(),
  };
}

function observedShadow(base:SyncRemoteShadowV2,remote:DecryptedSyncEntityV2):SyncRemoteShadowV2{
  return {
    ...base,
    observedRemoteRevision:remote.remoteRevision,
    observedRemoteSequence:remote.sequence,
    observedStructural:{
      parentId:remote.parentId ? canonicalIdFromEntry('folder',remote.parentId) : null,
      nameToken:remote.nameToken,
      deleted:remote.deleted,
      blobId:null,
    },
    observedPayload:structuredClone(remote.payload),
    observedStateSha256:remote.stateHash,
    observedKeyGeneration:remote.keyGeneration,
    updatedAt:new Date().toISOString(),
  };
}

function kindFor(remote:DecryptedSyncEntityV2):Entry['kind']{
  return remote.entityType==='note'?'markdown':'directory';
}

function canonicalName(remote:DecryptedSyncEntityV2):string{
  return remote.entityType==='note' ? markdownName(remote.payload.name) : validateName(remote.payload.name);
}

async function readLocalInTx(tx:StorageTransaction,entryId:EntryId):Promise<{entry:Entry;text:string|null}|null>{
  const entry=await tx.store('entries').get<Entry>(entryId);
  if(!entry) return null;
  const content=entry.kind==='markdown'
    ? await tx.store('contents').get<MarkdownContent>(entryId)
    : undefined;
  if(entry.kind==='markdown' && (!content || content.localVersion!==entry.localVersion)){
    throw new VaultError('CORRUPT','Local Markdown replica is inconsistent.');
  }
  return {entry,text:content?.text ?? null};
}

async function recordCheckpoint(tx:StorageTransaction,local:{entry:Entry;text:string|null}):Promise<void>{
  if(local.entry.kind!=='markdown'||local.text===null) return;
  const id=`${local.entry.id}:${local.entry.localVersion}:checkpoint`;
  if(await tx.store('revisions').get(id)) return;
  await tx.store('revisions').add({
    id,
    entryId:local.entry.id,
    vaultId:local.entry.vaultId,
    text:local.text,
    localVersion:local.entry.localVersion,
    createdAt:new Date().toISOString(),
    reason:'checkpoint',
  } satisfies LocalRevision);
}

function localView(local:{entry:Entry;text:string|null}|null){
  if(!local) return null;
  return {entry:local.entry,text:local.text,attachment:null};
}

function stateFromLocal(local:{entry:Entry;text:string|null}):SyncEntityStateV2{
  const entityType=local.entry.kind==='markdown'?'note':local.entry.kind==='directory'?'folder':null;
  if(!entityType) throw new VaultError('UNSUPPORTED','I6 reconciles Notes and Folders only.');
  if(entityType==='note'&&local.text===null) throw new VaultError('CORRUPT','Local Note is missing Markdown.');
  return {
    entryId:local.entry.id,
    vaultId:local.entry.vaultId,
    entityType,
    parentId:local.entry.parentId,
    name:local.entry.name,
    createdAt:local.entry.createdAt,
    updatedAt:local.entry.updatedAt,
    deletedAt:local.entry.deletedAt,
    text:entityType==='note'?local.text:null,
  };
}

function stateFromRemote(remote:DecryptedSyncEntityV2):SyncEntityStateV2{
  return {
    entryId:remote.entityId,
    vaultId:remote.vaultId,
    entityType:remote.entityType,
    parentId:remote.parentId,
    name:remote.payload.name,
    createdAt:remote.payload.createdAt,
    updatedAt:remote.payload.updatedAt,
    deletedAt:remote.payload.deletedAt,
    text:remote.entityType==='note'?remote.payload.text:null,
  };
}

function stateFromShadow(shadow:SyncRemoteShadowV2):SyncEntityStateV2{
  const parentId=shadow.structural.parentId
    ? entryIdFromCanonical(shadow.structural.parentId)
    : null;
  return {
    entryId:shadow.entryId,
    vaultId:shadow.vaultId,
    entityType:shadow.entityType,
    parentId,
    name:shadow.basePayload.name,
    createdAt:shadow.basePayload.createdAt,
    updatedAt:shadow.basePayload.updatedAt,
    deletedAt:shadow.basePayload.deletedAt,
    text:shadow.entityType==='note'?(shadow.basePayload as Extract<SyncPlaintextPayloadV1,{entityType:'note'}>).text:null,
  };
}

function pendingEntityIds(row:SyncOutboxRecordV2):EntryId[]{
  if(row.protocolVersion!==2) return [];
  return decodeOperationV2(row.wire).mutations.map(mutation=>entryIdFromCanonical(mutation.entityId));
}

async function removePendingForEntity(
  tx:StorageTransaction,
  rows:readonly SyncOutboxRecordV2[],
  accountId:AccountId,
  entryId:EntryId,
):Promise<number>{
  let removed=0;
  for(const row of rows){
    if(row.protocolVersion!==2||row.accountId!==accountId) continue;
    if(!pendingEntityIds(row).includes(entryId)) continue;
    await tx.store('outbox').delete(row.id);
    removed++;
  }
  return removed;
}

async function ensureDirty(tx:StorageTransaction,local:{entry:Entry;text:string|null}):Promise<void>{
  const existing=await tx.store('dirty').get<DirtyEntry>(local.entry.id);
  if(existing&&existing.localVersion===local.entry.localVersion) return;
  await tx.store('dirty').put({
    entryId:local.entry.id,
    vaultId:local.entry.vaultId,
    localVersion:local.entry.localVersion,
    changedAt:local.entry.updatedAt,
    intent:local.entry.deletedAt?'trash':'upsert',
  } satisfies DirtyEntry);
}

async function remoteShadowInTx(
  tx:StorageTransaction,
  entryId:EntryId,
  accountId:AccountId,
  epoch:string,
):Promise<SyncRemoteShadowV2|null>{
  const row=await tx.store('remoteShadows').get<SyncRemoteShadowV2>(entryId);
  if(!row)return null;
  if(row.protocolVersion!==2||row.accountId!==accountId||row.epoch!==epoch){
    throw new VaultError('ACCOUNT_MISMATCH','Protocol v2 merge base belongs to another Account/epoch.');
  }
  return row;
}

async function assertParentAvailable(
  tx:StorageTransaction,
  state:SyncEntityStateV2,
  pageById:ReadonlyMap<EntryId,DecryptedSyncEntityV2>,
):Promise<void>{
  if(state.deletedAt!==null||state.parentId===null)return;
  const existing=await tx.store('entries').get<Entry>(state.parentId);
  if(existing&&existing.vaultId===state.vaultId&&existing.kind==='directory'&&existing.deletedAt===null)return;
  const incoming=pageById.get(state.parentId);
  if(incoming&&incoming.entityType==='folder'&&!incoming.deleted)return;
  throw new VaultError('INVALID_PARENT','Merged encrypted state references a parent folder that is not locally available.');
}

async function pathCollision(
  tx:StorageTransaction,
  state:SyncEntityStateV2,
):Promise<Entry|null>{
  if(state.deletedAt!==null)return null;
  const key=activeKey(state.vaultId,state.parentId,state.name);
  const collision=await tx.store('entries').fromIndex<Entry>('activeKey',key);
  return collision&&collision.id!==state.entryId?collision:null;
}

async function writeState(
  tx:StorageTransaction,
  state:SyncEntityStateV2,
  local:{entry:Entry;text:string|null}|null,
  pageById:ReadonlyMap<EntryId,DecryptedSyncEntityV2>,
):Promise<{entry:Entry;text:string|null}>{
  await assertParentAvailable(tx,state,pageById);
  const collision=await pathCollision(tx,state);
  if(collision) throw new VaultError('COLLISION','Merged encrypted state collides with another local path.');

  if(local) await recordCheckpoint(tx,local);
  const kind:Entry['kind']=state.entityType==='note'?'markdown':'directory';
  if(local&&local.entry.kind!==kind) throw new VaultError('PROTOCOL','Protocol v2 entity type is immutable.');
  const localVersion=local?nextVersion(local.entry.localVersion):1;
  const key=state.deletedAt===null?activeKey(state.vaultId,state.parentId,state.name):undefined;
  const updated:Entry={
    id:state.entryId,
    vaultId:state.vaultId,
    parentId:state.parentId,
    name:state.name,
    kind,
    createdAt:state.createdAt,
    updatedAt:state.updatedAt,
    localVersion,
    deletedAt:state.deletedAt,
    deletionBatch:null,
    ...(key?{activeKey:key}:{}),
  };
  await tx.store('entries').put(updated);
  if(state.entityType==='note'){
    await tx.store('contents').put({
      entryId:state.entryId,
      text:state.text!,
      localVersion,
    } satisfies MarkdownContent);
  }else{
    await tx.store('contents').delete(state.entryId);
  }
  await tx.store('attachments').delete(state.entryId);
  return {entry:updated,text:state.entityType==='note'?state.text:null};
}

function samePendingEntity(
  rows:readonly SyncOutboxRecordV2[],
  accountId:AccountId,
  entryId:EntryId,
):boolean{
  return rows.some(row=>row.protocolVersion===2&&row.accountId===accountId&&pendingEntityIds(row).includes(entryId));
}

export class EncryptedReplicaStoreV2 {
  private readonly driver:LocalStorageDriver;

  constructor(
    database:IDBDatabase|LocalStorageDriver,
    private readonly a2?:Pick<A2Persistence,'syncEntry'|'markRepairNeeded'>,
  ){
    this.driver=storageDriver(database);
  }

  async shadow(entryId:EntryId,accountId:AccountId,epoch:string):Promise<SyncRemoteShadowV2|null>{
    const row=await this.driver.transaction(
      ['remoteShadows'],
      'readonly',
      tx=>tx.store('remoteShadows').get<SyncRemoteShadowV2>(entryId),
    );
    if(!row) return null;
    if(row.protocolVersion!==2) throw new VaultError('PROTOCOL','Legacy remote shadow cannot be used by Protocol v2.');
    if(row.accountId!==accountId) throw new VaultError('ACCOUNT_MISMATCH','Protocol v2 remote shadow belongs to another Account.');
    if(row.epoch!==epoch) throw new VaultError('PROTOCOL','Protocol v2 remote shadow belongs to another synchronization epoch.');
    if(row.entryId!==entryId) throw new VaultError('CORRUPT','Protocol v2 remote shadow identity is inconsistent.');
    return row;
  }

  async read(entryId:EntryId):Promise<import('./replica-store.js').LocalReplicaEntry|null>{
    return this.driver.transaction(['entries','contents'],'readonly',async tx=>{
      const local=await readLocalInTx(tx,entryId);
      return local ? {entry:local.entry,text:local.text,attachment:null} : null;
    });
  }

  async listDirty(vaultId:VaultId):Promise<DirtyEntry[]>{
    return this.driver.transaction(['dirty'],'readonly',tx=>tx.store('dirty').allFromIndex<DirtyEntry>('vaultId',vaultId));
  }

  async clearDirty(entryId:EntryId):Promise<void>{
    await this.driver.transaction(['dirty'],'readwrite',tx=>tx.store('dirty').delete(entryId));
  }

  async matches(remote:DecryptedSyncEntityV2):Promise<boolean>{
    return localMatchesDecryptedV2(await this.read(remote.entityId),remote);
  }

  /**
   * Conflicted entities remain editable. Before synthesis we refresh LOCAL in
   * the conflict record and tell the engine to block outbound operations only
   * for that entity.
   */
  async refreshConflictLocal(
    vaultId:VaultId,
    entryId:EntryId,
    accountId:AccountId,
    epoch:string,
  ):Promise<boolean>{
    return this.driver.transaction(['entries','contents','syncConflicts'],'readwrite',async tx=>{
      const conflict=await openSyncConflictInTx(tx,vaultId,entryId);
      if(!conflict)return false;
      if(conflict.accountId!==accountId||conflict.epoch!==epoch){
        throw new VaultError('ACCOUNT_MISMATCH','Protocol v2 conflict belongs to another Account/epoch.');
      }
      const local=await readLocalInTx(tx,entryId);
      if(!local) throw new VaultError('CORRUPT','Conflicted local entity disappeared.');
      const updated:SyncConflictRecordV2={
        ...conflict,
        local:stateFromLocal(local),
        updatedAt:new Date().toISOString(),
      };
      await updateSyncConflictInTx(tx,updated);
      return true;
    });
  }

  async applyPage(input:{
    accountId:AccountId;
    epoch:string;
    expectedAfter:string;
    through:string;
    events:readonly DecryptedSyncEntityV2[];
  }):Promise<ApplyEncryptedPageResult>{
    const {accountId,epoch,expectedAfter,through,events}=input;
    if(!events.length) throw new VaultError('PROTOCOL','Protocol v2 pull page cannot be empty.');
    const vaultId=events[0]!.vaultId;
    for(const event of events){
      if(event.vaultId!==vaultId) throw new VaultError('PROTOCOL','Protocol v2 pull page crosses Vault identity.');
    }

    const pageById=new Map<EntryId,DecryptedSyncEntityV2>();
    for(const event of events) pageById.set(event.entityId,event);
    const touched=new Set<EntryId>();

    const result=await this.driver.transaction(
      ['vaults','entries','contents','attachments','dirty','outbox','remoteShadows','syncCursors','revisions','syncConflicts'],
      'readwrite',
      async tx=>{
        const vault=await tx.store('vaults').get<Vault>(vaultId);
        if(!vault||vault.mode!=='cloud'||!vault.cloud||vault.cloud.protocolVersion!==2){
          throw new VaultError('PROTOCOL','Local Vault is not activated for Protocol v2.');
        }
        if(vault.cloud.accountId!==accountId||vault.cloud.epoch!==epoch){
          throw new VaultError('ACCOUNT_MISMATCH','Protocol v2 local Vault binding does not match this Account/epoch.');
        }

        const cursor=await tx.store('syncCursors').get<{
          protocolVersion:number;vaultId:VaultId;accountId:AccountId;epoch:string;cursor:string;
        }>(vaultId);
        if(!cursor||cursor.protocolVersion!==2||cursor.accountId!==accountId||cursor.epoch!==epoch||cursor.cursor!==expectedAfter){
          throw new VaultError('STALE_WRITE','Protocol v2 local cursor changed before the remote page could be committed.');
        }

        const allOutbox=await tx.store('outbox').allFromIndex<SyncOutboxRecordV2>('vaultId',vaultId);
        const ownByOperation=new Map<string,SyncOutboxRecordV2>();
        for(const row of allOutbox){
          if(row.protocolVersion===2&&row.accountId===accountId) ownByOperation.set(row.id,row);
        }

        // I5/I6 synthesizes exactly one mutation per operation. An own event
        // that appears in this page must therefore be complete.
        for(const [operationId,row] of ownByOperation){
          const pageEvents=events.filter(event=>event.operationId===operationId);
          if(!pageEvents.length) continue;
          const decoded=decodeOperationV2(row.wire);
          if(decoded.mutations.length!==pageEvents.length){
            throw new VaultError('PROTOCOL','Protocol v2 pull page would observe only part of a queued local operation.');
          }
        }

        let appliedRemoteEntities=0;
        let localChangedAfterOwnPush=0;
        let conflictsCaptured=0;
        let autoMergedEntities=0;
        const observedOwn=new Set<string>();

        for(const event of events){
          const local=await readLocalInTx(tx,event.entityId);
          const cleanShadow=shadowFor(accountId,epoch,event);
          const own=ownByOperation.get(event.operationId);

          if(own){
            observedOwn.add(event.operationId);
            await tx.store('remoteShadows').put(cleanShadow);
            const conflict=await openSyncConflictInTx(tx,vaultId,event.entityId);
            if(conflict?.status==='resolution-pending'){
              await markSyncConflictResolutionInTx(tx,conflict,{
                status:'resolved',
                resolution:conflict.resolution!,
                resolutionText:conflict.resolutionText,
              });
            }
            if(localMatchesDecryptedV2(localView(local),event)){
              await tx.store('dirty').delete(event.entityId);
            }else{
              localChangedAfterOwnPush++;
            }
            touched.add(event.entityId);
            continue;
          }

          const remoteState=stateFromRemote(event);

          // Same-folder concurrent creates have different EntityIds. The remote
          // winner cannot be inserted under IndexedDB's activeKey while the
          // local create still exists, so capture the collision against the
          // local entity and preserve the complete remote state in the conflict.
          const collision=await pathCollision(tx,remoteState);
          if(collision&&collision.id!==event.entityId){
            const collisionLocal=await readLocalInTx(tx,collision.id);
            if(!collisionLocal) throw new VaultError('CORRUPT','Path collision entry disappeared during reconciliation.');
            const collisionDirty=await tx.store('dirty').get<DirtyEntry>(collision.id);
            const collisionPending=samePendingEntity(allOutbox,accountId,collision.id);
            if(!collisionDirty&&!collisionPending){
              throw new VaultError('COLLISION','Remote encrypted state conflicts with an already-clean local path.');
            }
            const collisionShadow=await remoteShadowInTx(tx,collision.id,accountId,epoch);
            await removePendingForEntity(tx,allOutbox,accountId,collision.id);
            await ensureDirty(tx,collisionLocal);
            await upsertSyncConflictInTx(tx,{
              vaultId,
              entryId:collision.id,
              accountId,
              epoch,
              entityType:collisionLocal.entry.kind==='markdown'?'note':'folder',
              kind:'name',
              baseRevision:collisionShadow?.remoteRevision??null,
              remoteRevision:event.remoteRevision,
              remoteSequence:event.sequence,
              remoteNameToken:event.nameToken,
              remoteKeyGeneration:event.keyGeneration,
              remoteStateSha256:event.stateHash,
              base:collisionShadow?stateFromShadow(collisionShadow):null,
              local:stateFromLocal(collisionLocal),
              remote:remoteState,
              source:'pull',
            });
            conflictsCaptured++;
            continue;
          }

          const openConflict=local
            ? await openSyncConflictInTx(tx,vaultId,event.entityId)
            : null;
          if(openConflict){
            if(openConflict.accountId!==accountId||openConflict.epoch!==epoch){
              throw new VaultError('ACCOUNT_MISMATCH','Protocol v2 conflict belongs to another Account/epoch.');
            }
            const currentLocal=local!;
            await upsertSyncConflictInTx(tx,{
              vaultId,
              entryId:event.entityId,
              accountId,
              epoch,
              entityType:event.entityType,
              kind:openConflict.kind,
              baseRevision:openConflict.baseRevision,
              remoteRevision:event.remoteRevision,
              remoteSequence:event.sequence,
              remoteNameToken:event.nameToken,
              remoteKeyGeneration:event.keyGeneration,
              remoteStateSha256:event.stateHash,
              base:openConflict.base,
              local:stateFromLocal(currentLocal),
              remote:remoteState,
              markdownConflictIds:openConflict.markdownConflictIds,
              source:'pull',
            });
            const baseShadow=await remoteShadowInTx(tx,event.entityId,accountId,epoch);
            if(baseShadow) await tx.store('remoteShadows').put(observedShadow(baseShadow,event));
            await removePendingForEntity(tx,allOutbox,accountId,event.entityId);
            await ensureDirty(tx,currentLocal);
            conflictsCaptured++;
            continue;
          }

          const dirty=await tx.store('dirty').get<DirtyEntry>(event.entityId);
          const pending=samePendingEntity(allOutbox,accountId,event.entityId);
          if(!dirty&&!pending){
            const written=await writeState(tx,remoteState,local,pageById);
            await tx.store('dirty').delete(event.entityId);
            await tx.store('remoteShadows').put(cleanShadow);
            appliedRemoteEntities++;
            touched.add(written.entry.id);
            continue;
          }

          if(!local) throw new VaultError('CORRUPT','Protocol v2 dirty/pending entity has no local canonical state.');
          const baseShadow=await remoteShadowInTx(tx,event.entityId,accountId,epoch);
          const localState=stateFromLocal(local);

          // A foreign event on this entity proves any still-pending operation
          // based on the old Shadow was rejected: if it had been accepted first,
          // its own ordered event would already have appeared before this one.
          await removePendingForEntity(tx,allOutbox,accountId,event.entityId);

          if(!baseShadow){
            await ensureDirty(tx,local);
            await upsertSyncConflictInTx(tx,{
              vaultId,
              entryId:event.entityId,
              accountId,
              epoch,
              entityType:event.entityType,
              kind:'concurrent-create',
              baseRevision:null,
              remoteRevision:event.remoteRevision,
              remoteSequence:event.sequence,
              remoteNameToken:event.nameToken,
              remoteKeyGeneration:event.keyGeneration,
              remoteStateSha256:event.stateHash,
              base:null,
              local:localState,
              remote:remoteState,
              source:'pull',
            });
            conflictsCaptured++;
            continue;
          }

          const baseState=stateFromShadow(baseShadow);
          const reconciliation=reconcileSyncEntityV2(baseState,localState,remoteState);

          if(reconciliation.kind==='conflict'){
            await ensureDirty(tx,local);
            await tx.store('remoteShadows').put(observedShadow(baseShadow,event));
            await upsertSyncConflictInTx(tx,{
              vaultId,
              entryId:event.entityId,
              accountId,
              epoch,
              entityType:event.entityType,
              kind:reconciliation.conflictKind,
              baseRevision:baseShadow.remoteRevision,
              remoteRevision:event.remoteRevision,
              remoteSequence:event.sequence,
              remoteNameToken:event.nameToken,
              remoteKeyGeneration:event.keyGeneration,
              remoteStateSha256:event.stateHash,
              base:reconciliation.base,
              local:reconciliation.local,
              remote:reconciliation.remote,
              markdownConflictIds:reconciliation.markdownConflictIds,
              source:'pull',
            });
            conflictsCaptured++;
            continue;
          }

          if(reconciliation.kind==='local'){
            await tx.store('remoteShadows').put(cleanShadow);
            await ensureDirty(tx,local);
            continue;
          }

          const written=await writeState(tx,reconciliation.state,local,pageById);
          await tx.store('remoteShadows').put(cleanShadow);
          touched.add(written.entry.id);

          if(reconciliation.kind==='merged'){
            await ensureDirty(tx,written);
            autoMergedEntities++;
          }else{
            await tx.store('dirty').delete(event.entityId);
            appliedRemoteEntities++;
          }
        }

        for(const operationId of observedOwn){
          await tx.store('outbox').delete(operationId);
        }

        await tx.store('syncCursors').put({
          protocolVersion:2,
          vaultId,
          accountId,
          epoch,
          cursor:through,
          updatedAt:new Date().toISOString(),
        });

        return {
          observedOwnOperations:observedOwn.size,
          appliedRemoteEntities,
          localChangedAfterOwnPush,
          conflictsCaptured,
          autoMergedEntities,
          cursor:through,
        };
      },
    );

    if(this.a2){
      for(const entryId of touched){
        try{ await this.a2.syncEntry(entryId); }
        catch(error){ await this.a2.markRepairNeeded(error).catch(()=>undefined); }
      }
    }
    return result;
  }
}
