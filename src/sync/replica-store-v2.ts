import { VaultError } from '../domain/errors.js';
import { asCanonicalId, canonicalIdFromEntry, entryIdFromCanonical, newUuidV7 } from '../domain/canonical.js';
import { activeKey, markdownName, validateName } from '../domain/paths.js';
import { validateAttachmentName } from '../media/attachments.js';
import { nextVersion } from '../domain/integrity.js';
import type {
  AccountId,
  AttachmentContent,
  DirtyEntry,
  Entry,
  EntryId,
  LocalRevision,
  MarkdownContent,
  Vault,
  VaultId,
} from '../domain/model.js';
import type { A2Persistence } from '../storage/a2-persistence.js';
import { rekeyTaskIdentityMarkers } from '../tasks/markdown.js';
import { storageDriver, type LocalStorageDriver, type StorageTransaction } from '../storage/driver.js';
import {
  markSyncConflictResolutionInTx,
  openSyncConflictInTx,
  updateSyncConflictInTx,
  upsertSyncConflictInTx,
  type SyncConflictRecordV2,
} from './conflict-store-v2.js';
import { decodeOperationV2, type EncryptedEntityStructural, type NameToken } from './protocol-v2.js';
import type { SyncOutboxRecordV2 } from './local-state-v2.js';
import {
  reconcileSyncEntityV2,
  syncEntityAuthoredEqualV2,
  type SyncEntityStateV2,
} from './reconcile-v2.js';
import type {
  DecryptedAttachmentEntityV2,
  DecryptedSyncEntityV2,
  SyncPlaintextPayloadV1,
} from './serialization-v2.js';
import { localMatchesDecryptedV2 } from './serialization-v2.js';
import type { LocalReplicaEntry } from './replica-store.js';

export interface SyncRemoteShadowV2 {
  protocolVersion: 2;
  entryId: EntryId;
  vaultId: VaultId;
  accountId: AccountId;
  epoch: string;
  entityType: 'folder' | 'note' | 'attachment';
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
  attachmentConflictsPreserved: number;
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
      blobId:remote.blobId,
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
      blobId:remote.blobId,
    },
    observedPayload:structuredClone(remote.payload),
    observedStateSha256:remote.stateHash,
    observedKeyGeneration:remote.keyGeneration,
    updatedAt:new Date().toISOString(),
  };
}

function kindFor(remote:DecryptedSyncEntityV2):Entry['kind']{
  return remote.entityType==='note'?'markdown':remote.entityType==='attachment'?'attachment':'directory';
}

function canonicalName(remote:DecryptedSyncEntityV2):string{
  return remote.entityType==='note'
    ? markdownName(remote.payload.name)
    : remote.entityType==='attachment'
      ? validateAttachmentName(remote.payload.name)
      : validateName(remote.payload.name);
}

async function readLocalInTx(tx:StorageTransaction,entryId:EntryId):Promise<LocalReplicaEntry|null>{
  const entry=await tx.store('entries').get<Entry>(entryId);
  if(!entry) return null;
  const content=entry.kind==='markdown'
    ? await tx.store('contents').get<MarkdownContent>(entryId)
    : undefined;
  const attachment=entry.kind==='attachment'
    ? await tx.store('attachments').get<AttachmentContent>(entryId)
    : undefined;
  if(entry.kind==='markdown' && (!content || content.localVersion!==entry.localVersion)){
    throw new VaultError('CORRUPT','Local Markdown replica is inconsistent.');
  }
  if(entry.kind==='attachment' && (!attachment
    ||attachment.entryId!==entry.id
    ||attachment.vaultId!==entry.vaultId
    ||attachment.size!==attachment.bytes.byteLength)){
    throw new VaultError('CORRUPT','Local attachment replica is inconsistent.');
  }
  return {entry,text:content?.text ?? null,attachment:attachment??null};
}

async function recordCheckpoint(tx:StorageTransaction,local:LocalReplicaEntry):Promise<void>{
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

function localView(local:LocalReplicaEntry|null):LocalReplicaEntry|null{
  return local;
}

function stateFromLocal(local:LocalReplicaEntry):SyncEntityStateV2{
  const entityType=local.entry.kind==='markdown'?'note':local.entry.kind==='directory'?'folder':null;
  if(!entityType) throw new VaultError('UNSUPPORTED','I6 semantic reconciliation applies to Notes and Folders; I7 handles Attachment transport separately.');
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
  if(remote.entityType==='attachment') throw new VaultError('UNSUPPORTED','Attachment state is applied by the I7 binary path.');
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
  if(shadow.entityType==='attachment') throw new VaultError('UNSUPPORTED','Attachment shadows are not semantic I6 merge bases.');
  const parentId=shadow.structural.parentId
    ? entryIdFromCanonical(asCanonicalId('folder',shadow.structural.parentId))
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
  return decodeOperationV2(row.wire).mutations.map(mutation=>{
    switch(mutation.entityType){
      case 'note': return entryIdFromCanonical(asCanonicalId('note',mutation.entityId));
      case 'folder': return entryIdFromCanonical(asCanonicalId('folder',mutation.entityId));
      case 'attachment': return entryIdFromCanonical(asCanonicalId('attachment',mutation.entityId));
      default: throw new VaultError('UNSUPPORTED','Protocol v2 outbox contains an entity type that is not file-backed.');
    }
  });
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

async function ensureDirty(tx:StorageTransaction,local:{entry:Entry}):Promise<void>{
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
  local:LocalReplicaEntry|null,
  pageById:ReadonlyMap<EntryId,DecryptedSyncEntityV2>,
):Promise<LocalReplicaEntry>{
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
  return {entry:updated,text:state.entityType==='note'?state.text:null,attachment:null};
}

async function writeAttachmentState(
  tx:StorageTransaction,
  remote:DecryptedAttachmentEntityV2,
  local:LocalReplicaEntry|null,
  bytes:Uint8Array,
  pageById:ReadonlyMap<EntryId,DecryptedSyncEntityV2>,
):Promise<LocalReplicaEntry>{
  if(bytes.byteLength!==remote.payload.size){
    throw new VaultError('CORRUPT','Hydrated encrypted attachment size does not match authenticated metadata.');
  }
  if(remote.deleted===false&&remote.parentId!==null){
    const existingParent=await tx.store('entries').get<Entry>(remote.parentId);
    const incomingParent=pageById.get(remote.parentId);
    if(!(existingParent&&existingParent.vaultId===remote.vaultId&&existingParent.kind==='directory'&&existingParent.deletedAt===null)
      &&!(incomingParent&&incomingParent.entityType==='folder'&&!incomingParent.deleted)){
      throw new VaultError('INVALID_PARENT','Encrypted attachment references a parent folder that is not locally available.');
    }
  }
  const name=validateAttachmentName(remote.payload.name);
  const key=remote.deleted?undefined:activeKey(remote.vaultId,remote.parentId,name);
  if(key){
    const collision=await tx.store('entries').fromIndex<Entry>('activeKey',key);
    if(collision&&collision.id!==remote.entityId){
      throw new VaultError('COLLISION','Encrypted attachment collides with another local path.');
    }
  }
  if(local&&local.entry.kind!=='attachment') throw new VaultError('PROTOCOL','Protocol v2 entity type is immutable.');
  const localVersion=local?nextVersion(local.entry.localVersion):1;
  const entry:Entry={
    id:remote.entityId,
    vaultId:remote.vaultId,
    parentId:remote.parentId,
    name,
    kind:'attachment',
    createdAt:remote.payload.createdAt,
    updatedAt:remote.payload.updatedAt,
    localVersion,
    deletedAt:remote.payload.deletedAt,
    deletionBatch:null,
    ...(key?{activeKey:key}:{}),
  };
  await tx.store('entries').put(entry);
  await tx.store('contents').delete(remote.entityId);
  const attachment:AttachmentContent={
    entryId:remote.entityId,
    vaultId:remote.vaultId,
    mimeType:remote.payload.mimeType,
    size:remote.payload.size,
    bytes:bytes.slice(),
  };
  await tx.store('attachments').put(attachment);
  return {entry,text:null,attachment};
}

function payloadFromState(state:SyncEntityStateV2):SyncPlaintextPayloadV1{
  const base={
    format:'vault/entity-payload/v1' as const,
    version:1 as const,
    name:state.name,
    createdAt:state.createdAt,
    updatedAt:state.updatedAt,
    deletedAt:state.deletedAt,
  };
  return state.entityType==='note'
    ? {...base,entityType:'note' as const,text:state.text!}
    : {...base,entityType:'folder' as const};
}

function shadowFromConflictRemote(
  accountId:AccountId,
  epoch:string,
  conflict:SyncConflictRecordV2,
):SyncRemoteShadowV2{
  const remote=conflict.remote;
  return {
    protocolVersion:2,
    entryId:remote.entryId,
    vaultId:remote.vaultId,
    accountId,
    epoch,
    entityType:remote.entityType,
    remoteRevision:conflict.remoteRevision,
    remoteSequence:conflict.remoteSequence,
    structural:{
      parentId:remote.parentId?canonicalIdFromEntry('folder',remote.parentId):null,
      nameToken:conflict.remoteNameToken as NameToken,
      deleted:remote.deletedAt!==null,
      blobId:null,
    },
    basePayload:payloadFromState(remote),
    baseStateSha256:conflict.remoteStateSha256,
    encryptionVersion:1,
    keyGeneration:conflict.remoteKeyGeneration,
    updatedAt:new Date().toISOString(),
  };
}

async function conflictSafeName(
  tx:StorageTransaction,
  state:SyncEntityStateV2,
  suffixSeed:string,
):Promise<string>{
  const markdown=state.entityType==='note';
  const source=state.name;
  const stem=markdown&&source.toLowerCase().endsWith('.md')?source.slice(0,-3):source;
  const ext=markdown?'.md':'';
  const compact=suffixSeed.replace(/-/gu,'').slice(0,6)||'copy';
  for(let attempt=1;attempt<=999;attempt++){
    const suffix=attempt===1?` (conflict ${compact})`:` (conflict ${compact} ${attempt})`;
    const candidate=markdown?markdownName(stem+suffix+ext):validateName(stem+suffix);
    const key=activeKey(state.vaultId,state.parentId,candidate);
    const collision=await tx.store('entries').fromIndex<Entry>('activeKey',key);
    if(!collision||collision.id===state.entryId)return candidate;
  }
  throw new VaultError('COLLISION','Vault could not create a conflict-safe copy name.');
}

async function attachmentConflictSafeName(
  tx:StorageTransaction,
  vaultId:VaultId,
  parentId:EntryId|null,
  source:string,
  suffixSeed:string,
  ignoreId?:EntryId,
):Promise<string>{
  const dot=source.lastIndexOf('.');
  const stem=dot>0?source.slice(0,dot):source;
  const ext=dot>0?source.slice(dot):'';
  const compact=suffixSeed.replace(/-/gu,'').slice(0,6)||'copy';
  for(let attempt=1;attempt<=999;attempt++){
    const suffix=attempt===1?` (conflict ${compact})`:` (conflict ${compact} ${attempt})`;
    const candidate=validateAttachmentName(stem+suffix+ext);
    const key=activeKey(vaultId,parentId,candidate);
    const collision=await tx.store('entries').fromIndex<Entry>('activeKey',key);
    if(!collision||collision.id===ignoreId)return candidate;
  }
  throw new VaultError('COLLISION','Vault could not create a conflict-safe attachment name.');
}

async function safeAttachmentCopyParent(
  tx:StorageTransaction,
  local:LocalReplicaEntry,
  pageById:ReadonlyMap<EntryId,DecryptedSyncEntityV2>,
):Promise<EntryId|null>{
  const parentId=local.entry.parentId;
  if(!parentId)return null;
  const incoming=pageById.get(parentId);
  if(incoming?.entityType==='folder'&&incoming.deleted)return null;
  const parent=await tx.store('entries').get<Entry>(parentId);
  return parent&&parent.kind==='directory'&&parent.deletedAt===null&&parent.vaultId===local.entry.vaultId
    ?parentId
    :null;
}

async function preserveLocalAttachmentCopy(
  tx:StorageTransaction,
  local:LocalReplicaEntry,
  pageById:ReadonlyMap<EntryId,DecryptedSyncEntityV2>,
  touched:Set<EntryId>,
):Promise<EntryId|null>{
  if(local.entry.kind!=='attachment'||!local.attachment||local.entry.deletedAt!==null)return null;
  const copyId=newUuidV7() as EntryId;
  const parentId=await safeAttachmentCopyParent(tx,local,pageById);
  const name=await attachmentConflictSafeName(
    tx,local.entry.vaultId,parentId,local.entry.name,copyId,
  );
  const timestamp=new Date().toISOString();
  const entry:Entry={
    ...local.entry,
    id:copyId,
    parentId,
    name,
    createdAt:timestamp,
    updatedAt:timestamp,
    localVersion:1,
    deletedAt:null,
    deletionBatch:null,
    activeKey:activeKey(local.entry.vaultId,parentId,name),
  };
  const attachment:AttachmentContent={
    ...structuredClone(local.attachment),
    entryId:copyId,
    bytes:local.attachment.bytes.slice(),
  };
  await tx.store('entries').put(entry);
  await tx.store('attachments').put(attachment);
  await ensureDirty(tx,{entry});
  touched.add(copyId);
  return copyId;
}

function samePendingEntity(
  rows:readonly SyncOutboxRecordV2[],
  accountId:AccountId,
  entryId:EntryId,
):boolean{
  return rows.some(row=>row.protocolVersion===2&&row.accountId===accountId&&pendingEntityIds(row).includes(entryId));
}

async function cloneActiveSubtreeForKeepBoth(
  tx:StorageTransaction,
  vaultId:VaultId,
  sourceRootId:EntryId,
  copyRootId:EntryId,
  timestamp:string,
  touched:Set<EntryId>,
):Promise<void>{
  const all=await tx.store('entries').allFromIndex<Entry>('vaultId',vaultId);
  const childrenByParent=new Map<EntryId,Entry[]>();
  for(const entry of all){
    if(entry.deletedAt!==null||entry.parentId===null)continue;
    const children=childrenByParent.get(entry.parentId)??[];
    children.push(entry);
    childrenByParent.set(entry.parentId,children);
  }
  for(const children of childrenByParent.values()){
    children.sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  }

  const idMap=new Map<EntryId,EntryId>([[sourceRootId,copyRootId]]);
  const queue:EntryId[]=[sourceRootId];
  const visited=new Set<EntryId>();

  while(queue.length){
    const sourceParentId=queue.shift()!;
    if(visited.has(sourceParentId)) throw new VaultError('CYCLE','Keep Both cannot clone a cyclic local folder tree.');
    visited.add(sourceParentId);
    const copyParentId=idMap.get(sourceParentId);
    if(!copyParentId) throw new VaultError('CORRUPT','Keep Both folder clone lost its parent identity mapping.');

    for(const child of childrenByParent.get(sourceParentId)??[]){
      const cloneId=newUuidV7() as EntryId;
      const key=activeKey(vaultId,copyParentId,child.name);
      const collision=await tx.store('entries').fromIndex<Entry>('activeKey',key);
      if(collision) throw new VaultError('COLLISION','Keep Both folder copy collides with an existing local path.');

      const clone:Entry={
        ...child,
        id:cloneId,
        parentId:copyParentId,
        createdAt:timestamp,
        updatedAt:timestamp,
        localVersion:1,
        deletedAt:null,
        deletionBatch:null,
        activeKey:key,
      };
      await tx.store('entries').put(clone);

      let text:string|null=null;
      if(child.kind==='markdown'){
        const body=await tx.store('contents').get<MarkdownContent>(child.id);
        if(!body) throw new VaultError('CORRUPT','Keep Both cannot clone a Markdown child whose content is missing.');
        text=rekeyTaskIdentityMarkers(body.text).text;
        await tx.store('contents').put({entryId:cloneId,text,localVersion:1} satisfies MarkdownContent);
      }else if(child.kind==='attachment'){
        const attachment=await tx.store('attachments').get<AttachmentContent>(child.id);
        if(!attachment) throw new VaultError('CORRUPT','Keep Both cannot clone an attachment child whose bytes are missing.');
        await tx.store('attachments').put({...structuredClone(attachment),entryId:cloneId} satisfies AttachmentContent);
      }

      await ensureDirty(tx,{entry:clone,text});
      touched.add(cloneId);
      idMap.set(child.id,cloneId);
      if(child.kind==='directory')queue.push(child.id);
    }
  }
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
    return this.driver.transaction(['entries','contents','attachments'],'readonly',async tx=>{
      return readLocalInTx(tx,entryId);
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

  async resolveConflict(input:{
    vaultId:VaultId;
    entryId:EntryId;
    accountId:AccountId;
    epoch:string;
    resolution:'keep-local'|'keep-remote'|'manual'|'keep-both';
    manualText?:string;
    conflictId?:string;
    expectedUpdatedAt?:string;
  }):Promise<{conflict:SyncConflictRecordV2;createdCopyId:EntryId|null}>{
    const {vaultId,entryId,accountId,epoch,resolution}=input;
    const touched=new Set<EntryId>();
    const result=await this.driver.transaction(
      ['vaults','entries','contents','attachments','dirty','outbox','remoteShadows','revisions','syncConflicts'],
      'readwrite',
      async tx=>{
        const vault=await tx.store('vaults').get<Vault>(vaultId);
        if(!vault||vault.mode!=='cloud'||!vault.cloud||vault.cloud.protocolVersion!==2
          ||vault.cloud.accountId!==accountId||vault.cloud.epoch!==epoch){
          throw new VaultError('ACCOUNT_MISMATCH','Conflict resolution no longer matches the active encrypted Vault.');
        }
        const conflict=await openSyncConflictInTx(tx,vaultId,entryId);
        if(!conflict) throw new VaultError('NOT_FOUND','The encrypted synchronization conflict is no longer open.');
        if(conflict.status!=='open'){
          throw new VaultError('STALE_WRITE','This conflict resolution is already waiting for synchronization.');
        }
        if((input.conflictId&&conflict.id!==input.conflictId)
          ||(input.expectedUpdatedAt&&conflict.updatedAt!==input.expectedUpdatedAt)){
          throw new VaultError('STALE_WRITE','The synchronization conflict changed after the resolver opened. Reopen it before choosing a resolution.');
        }
        if(conflict.accountId!==accountId||conflict.epoch!==epoch){
          throw new VaultError('ACCOUNT_MISMATCH','Conflict resolution belongs to another Account/epoch.');
        }

        const currentLocal=await readLocalInTx(tx,entryId);
        if(!currentLocal) throw new VaultError('CORRUPT','The conflicted local entity no longer exists.');
        const currentLocalState=stateFromLocal(currentLocal);
        if(input.expectedUpdatedAt && !syncEntityAuthoredEqualV2(currentLocalState,conflict.local)){
          throw new VaultError('STALE_WRITE','The local entity changed after the resolver opened. Reopen it before choosing a resolution.');
        }
        const refreshed:SyncConflictRecordV2={
          ...conflict,
          local:currentLocalState,
          updatedAt:new Date().toISOString(),
        };
        await updateSyncConflictInTx(tx,refreshed);

        const allOutbox=await tx.store('outbox').allFromIndex<SyncOutboxRecordV2>('vaultId',vaultId);
        await removePendingForEntity(tx,allOutbox,accountId,entryId);

        const sameIdentity=refreshed.remote.entryId===entryId;
        const remoteShadow=shadowFromConflictRemote(accountId,epoch,refreshed);
        const emptyPage=new Map<EntryId,DecryptedSyncEntityV2>();
        let createdCopyId:EntryId|null=null;

        if(resolution==='keep-remote'){
          if(sameIdentity){
            const written=await writeState(tx,refreshed.remote,currentLocal,emptyPage);
            await tx.store('remoteShadows').put(remoteShadow);
            await tx.store('dirty').delete(entryId);
            touched.add(written.entry.id);
          }else{
            // Revert a previously-synced local entity to BASE. A local-only
            // concurrent create is retained as a recoverable local tombstone.
            if(refreshed.base){
              const reverted=await writeState(tx,refreshed.base,currentLocal,emptyPage);
              await tx.store('dirty').delete(entryId);
              touched.add(reverted.entry.id);
            }else{
              const discarded:SyncEntityStateV2={
                ...refreshed.local,
                deletedAt:new Date().toISOString(),
                updatedAt:new Date().toISOString(),
              };
              const reverted=await writeState(tx,discarded,currentLocal,emptyPage);
              await tx.store('dirty').delete(entryId);
              touched.add(reverted.entry.id);
            }
            const existingRemote=await readLocalInTx(tx,refreshed.remote.entryId);
            const remoteWritten=await writeState(tx,refreshed.remote,existingRemote,emptyPage);
            await tx.store('remoteShadows').put(remoteShadow);
            await tx.store('dirty').delete(refreshed.remote.entryId);
            touched.add(remoteWritten.entry.id);
          }
          const resolved=await markSyncConflictResolutionInTx(tx,refreshed,{
            status:'resolved',resolution:'keep-remote',
          });
          return {conflict:resolved,createdCopyId};
        }

        if(resolution==='manual'){
          if(!sameIdentity||refreshed.entityType!=='note'||typeof input.manualText!=='string'){
            throw new VaultError('PROTOCOL','Manual merge currently requires one conflicted Note identity and explicit Markdown.');
          }
          const manualState:SyncEntityStateV2={
            ...refreshed.local,
            text:input.manualText,
            updatedAt:new Date().toISOString(),
          };
          const written=await writeState(tx,manualState,currentLocal,emptyPage);
          await tx.store('remoteShadows').put(remoteShadow);
          await ensureDirty(tx,written);
          touched.add(written.entry.id);
          const pending=await markSyncConflictResolutionInTx(tx,refreshed,{
            status:'resolution-pending',resolution:'manual',resolutionText:input.manualText,
          });
          return {conflict:pending,createdCopyId};
        }

        if(resolution==='keep-local'){
          if(sameIdentity){
            await tx.store('remoteShadows').put(remoteShadow);
            await ensureDirty(tx,currentLocal);
            const pending=await markSyncConflictResolutionInTx(tx,refreshed,{
              status:'resolution-pending',resolution:'keep-local',
            });
            return {conflict:pending,createdCopyId};
          }

          // Different-ID name collision: first move the already-remote entity
          // aside. The local winner remains blocked until that rename's own
          // ordered event is observed, then the next sync pass can create it.
          const remoteExisting=await readLocalInTx(tx,refreshed.remote.entryId);
          const safeRemoteName=await conflictSafeName(tx,refreshed.remote,refreshed.remote.entryId);
          const movedRemote:SyncEntityStateV2={
            ...refreshed.remote,
            name:safeRemoteName,
            updatedAt:new Date().toISOString(),
          };
          const moved=await writeState(tx,movedRemote,remoteExisting,emptyPage);
          await tx.store('remoteShadows').put(remoteShadow);
          await ensureDirty(tx,moved);
          touched.add(moved.entry.id);
          await ensureDirty(tx,currentLocal);
          const pending=await markSyncConflictResolutionInTx(tx,refreshed,{
            status:'resolution-pending',resolution:'keep-local',
          });
          return {conflict:pending,createdCopyId};
        }

        // KEEP BOTH
        if(!sameIdentity){
          const safeLocalName=await conflictSafeName(tx,refreshed.local,entryId);
          const renamedLocal:SyncEntityStateV2={
            ...refreshed.local,
            name:safeLocalName,
            updatedAt:new Date().toISOString(),
          };
          const renamed=await writeState(tx,renamedLocal,currentLocal,emptyPage);
          await ensureDirty(tx,renamed);
          touched.add(renamed.entry.id);

          const remoteExisting=await readLocalInTx(tx,refreshed.remote.entryId);
          const remoteWritten=await writeState(tx,refreshed.remote,remoteExisting,emptyPage);
          await tx.store('remoteShadows').put(remoteShadow);
          await tx.store('dirty').delete(refreshed.remote.entryId);
          touched.add(remoteWritten.entry.id);

          const resolved=await markSyncConflictResolutionInTx(tx,refreshed,{
            status:'resolved',resolution:'keep-both',
          });
          return {conflict:resolved,createdCopyId};
        }

        const localState=refreshed.local;
        const copyId=newUuidV7() as EntryId;
        const safeName=await conflictSafeName(tx,{...localState,entryId:copyId},copyId);
        const timestamp=new Date().toISOString();
        const copyState:SyncEntityStateV2={
          ...localState,
          entryId:copyId,
          name:safeName,
          createdAt:timestamp,
          updatedAt:timestamp,
          text:localState.entityType==='note'
            ? rekeyTaskIdentityMarkers(localState.text!).text
            : null,
        };

        const originalWritten=await writeState(tx,refreshed.remote,currentLocal,emptyPage);
        await tx.store('remoteShadows').put(remoteShadow);
        await tx.store('dirty').delete(entryId);
        touched.add(originalWritten.entry.id);

        const copyWritten=await writeState(tx,copyState,null,emptyPage);
        await ensureDirty(tx,copyWritten);
        touched.add(copyWritten.entry.id);
        createdCopyId=copyId;

        if(copyState.entityType==='folder'){
          await cloneActiveSubtreeForKeepBoth(tx,vaultId,entryId,copyId,timestamp,touched);
        }

        const resolved=await markSyncConflictResolutionInTx(tx,refreshed,{
          status:'resolved',resolution:'keep-both',
        });
        return {conflict:resolved,createdCopyId};
      },
    );

    if(this.a2){
      for(const id of touched){
        try{await this.a2.syncEntry(id);}
        catch(error){await this.a2.markRepairNeeded(error).catch(()=>undefined);}
      }
    }
    return result;
  }

  async applyPage(input:{
    accountId:AccountId;
    epoch:string;
    expectedAfter:string;
    through:string;
    events:readonly DecryptedSyncEntityV2[];
    attachmentBytes?:ReadonlyMap<EntryId,Uint8Array>;
    localAttachmentSha256?:ReadonlyMap<EntryId,string>;
  }):Promise<ApplyEncryptedPageResult>{
    const {accountId,epoch,expectedAfter,through,events,attachmentBytes,localAttachmentSha256}=input;
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
        let attachmentConflictsPreserved=0;
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
            // Keep Local for a different-ID name collision first renames the
            // remote competitor. Observing that exact rename unblocks the local
            // winner for the next synthesis pass.
            const allConflicts=await tx.store('syncConflicts').getAll<SyncConflictRecordV2>();
            for(const related of allConflicts){
              if(related.vaultId!==vaultId
                ||related.status!=='resolution-pending'
                ||related.resolution!=='keep-local'
                ||related.entryId===event.entityId
                ||related.remote.entryId!==event.entityId) continue;
              await markSyncConflictResolutionInTx(tx,related,{
                status:'resolved',
                resolution:'keep-local',
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

          if(event.entityType==='attachment'){
            const bytes=attachmentBytes?.get(event.entityId);
            if(!bytes) throw new VaultError('CORRUPT','Encrypted attachment bytes were not hydrated before canonical apply.');

            const dirty=await tx.store('dirty').get<DirtyEntry>(event.entityId);
            const pending=samePendingEntity(allOutbox,accountId,event.entityId);
            if(dirty||pending){
              if(!local||local.entry.kind!=='attachment'||!local.attachment){
                throw new VaultError('CORRUPT','Dirty encrypted Attachment has no complete local replica.');
              }
              const sameBytes=localAttachmentSha256?.get(event.entityId)===event.payload.plaintextSha256;
              const sameAuthored=sameBytes&&localMatchesDecryptedV2(local,event);
              await removePendingForEntity(tx,allOutbox,accountId,event.entityId);
              if(!sameAuthored){
                await preserveLocalAttachmentCopy(tx,local,pageById,touched);
                attachmentConflictsPreserved++;
              }
            }

            // A different-ID concurrent local create can occupy the remote path.
            // Move that local Attachment aside deterministically, preserving its
            // identity/bytes and keeping it Dirty for the next encrypted push.
            if(!event.deleted){
              const desiredKey=activeKey(event.vaultId,event.parentId,event.payload.name);
              const collision=await tx.store('entries').fromIndex<Entry>('activeKey',desiredKey);
              if(collision&&collision.id!==event.entityId){
                const collisionDirty=await tx.store('dirty').get<DirtyEntry>(collision.id);
                const collisionPending=samePendingEntity(allOutbox,accountId,collision.id);
                if(!collisionDirty&&!collisionPending||collision.kind!=='attachment'){
                  throw new VaultError('COLLISION','Remote encrypted Attachment conflicts with an already-clean local path.');
                }
                const collisionLocal=await readLocalInTx(tx,collision.id);
                if(!collisionLocal?.attachment)throw new VaultError('CORRUPT','Colliding local Attachment bytes are unavailable.');
                await removePendingForEntity(tx,allOutbox,accountId,collision.id);
                const safeName=await attachmentConflictSafeName(
                  tx,collision.vaultId,collision.parentId,collision.name,collision.id,collision.id,
                );
                const moved:Entry={
                  ...collision,
                  name:safeName,
                  updatedAt:new Date().toISOString(),
                  localVersion:nextVersion(collision.localVersion),
                  activeKey:activeKey(collision.vaultId,collision.parentId,safeName),
                };
                await tx.store('entries').put(moved);
                await ensureDirty(tx,{entry:moved});
                touched.add(moved.id);
                attachmentConflictsPreserved++;
              }
            }

            const written=await writeAttachmentState(tx,event,local,bytes,pageById);
            await tx.store('dirty').delete(event.entityId);
            await tx.store('remoteShadows').put(cleanShadow);
            appliedRemoteEntities++;
            touched.add(written.entry.id);
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
          attachmentConflictsPreserved,
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
