import { VaultError } from '../domain/errors.js';
import { activeKey, markdownName, validateName } from '../domain/paths.js';
import { nextVersion } from '../domain/integrity.js';
import type {
  AccountId,
  DirtyEntry,
  Entry,
  EntryId,
  LocalRevision,
  MarkdownContent,
  OperationId,
  Vault,
  VaultId,
} from '../domain/model.js';
import type { A2Persistence } from '../storage/a2-persistence.js';
import { storageDriver, type LocalStorageDriver, type StorageTransaction } from '../storage/driver.js';
import { decodeOperationV2, type EncryptedEntityStructural } from './protocol-v2.js';
import type { SyncOutboxRecordV2 } from './local-state-v2.js';
import type { DecryptedSyncEntityV2, SyncPlaintextPayloadV1 } from './serialization-v2.js';
import { localMatchesDecryptedV2 } from './serialization-v2.js';

export interface SyncRemoteShadowV2 {
  protocolVersion: 2;
  entryId: EntryId;
  vaultId: VaultId;
  accountId: AccountId;
  epoch: string;
  entityType: 'folder' | 'note';
  remoteRevision: string;
  remoteSequence: string;
  structural: EncryptedEntityStructural;
  basePayload: SyncPlaintextPayloadV1;
  baseStateSha256: string;
  encryptionVersion: 1;
  keyGeneration: number;
  updatedAt: string;
}

export interface ApplyEncryptedPageResult {
  observedOwnOperations: number;
  appliedRemoteEntities: number;
  localChangedAfterOwnPush: number;
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
      parentId:remote.parentId,
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

    const touched=new Set<EntryId>();
    const result=await this.driver.transaction(
      ['vaults','entries','contents','attachments','dirty','outbox','remoteShadows','syncCursors','revisions'],
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

        // I5 synthesizes exactly one mutation per operation. Refuse to observe a
        // partial own operation if future code ever violates that invariant.
        for(const [operationId,row] of ownByOperation){
          const pageEvents=events.filter(event=>event.operationId===operationId);
          if(!pageEvents.length) continue;
          const decoded=decodeOperationV2(row.wire);
          if(decoded.mutations.length!==pageEvents.length){
            throw new VaultError('PROTOCOL','Protocol v2 pull page would observe only part of a queued local operation.');
          }
        }

        for(const event of events){
          if(ownByOperation.has(event.operationId)) continue;
          const dirty=await tx.store('dirty').get<DirtyEntry>(event.entityId);
          const pending=allOutbox.some(row=>{
            if(row.protocolVersion!==2||row.accountId!==accountId) return false;
            return decodeOperationV2(row.wire).mutations.some(mutation=>mutation.entityId===event.entityId);
          });
          if(dirty||pending){
            throw new VaultError('MERGE_REQUIRED','A remote encrypted change raced local work. I6 conflict reconciliation is required before this page can advance.');
          }
        }

        let appliedRemoteEntities=0;
        let localChangedAfterOwnPush=0;
        const observedOwn=new Set<string>();

        for(const event of events){
          const local=await readLocalInTx(tx,event.entityId);
          const shadow=shadowFor(accountId,epoch,event);

          if(ownByOperation.has(event.operationId)){
            observedOwn.add(event.operationId);
            await tx.store('remoteShadows').put(shadow);
            if(localMatchesDecryptedV2(localView(local),event)){
              await tx.store('dirty').delete(event.entityId);
            }else{
              localChangedAfterOwnPush++;
            }
            touched.add(event.entityId);
            continue;
          }

          const name=canonicalName(event);
          const expectedKind=kindFor(event);
          if(local && (local.entry.vaultId!==vaultId||local.entry.kind!==expectedKind)){
            throw new VaultError('PROTOCOL','Remote encrypted entity identity conflicts with another local entry kind or Vault.');
          }
          if(event.parentId){
            const parent=events.find(candidate=>candidate.entityId===event.parentId);
            if(parent){
              if(parent.entityType!=='folder'||parent.deleted){
                throw new VaultError('INVALID_PARENT','Remote page references a deleted/non-folder parent.');
              }
            }else{
              const existingParent=await tx.store('entries').get<Entry>(event.parentId);
              if(!existingParent||existingParent.vaultId!==vaultId||existingParent.kind!=='directory'||existingParent.deletedAt!==null){
                throw new VaultError('INVALID_PARENT','Remote page references a folder that is not locally available.');
              }
            }
          }

          const key=event.deleted ? undefined : activeKey(vaultId,event.parentId,name);
          if(key){
            const collision=await tx.store('entries').fromIndex<Entry>('activeKey',key);
            if(collision&&collision.id!==event.entityId){
              throw new VaultError('COLLISION','Remote encrypted change collides with an existing local path.');
            }
          }

          if(local) await recordCheckpoint(tx,local);
          const localVersion=local ? nextVersion(local.entry.localVersion) : 1;
          const updated:Entry={
            id:event.entityId,
            vaultId,
            parentId:event.parentId,
            name,
            kind:expectedKind,
            createdAt:event.payload.createdAt,
            updatedAt:event.payload.updatedAt,
            localVersion,
            deletedAt:event.payload.deletedAt,
            deletionBatch:null,
            ...(key?{activeKey:key}:{}),
          };
          await tx.store('entries').put(updated);
          if(event.entityType==='note'){
            await tx.store('contents').put({
              entryId:event.entityId,
              text:event.payload.text,
              localVersion,
            } satisfies MarkdownContent);
          }else{
            await tx.store('contents').delete(event.entityId);
          }
          await tx.store('attachments').delete(event.entityId);
          await tx.store('dirty').delete(event.entityId);
          await tx.store('remoteShadows').put(shadow);
          appliedRemoteEntities++;
          touched.add(event.entityId);
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
