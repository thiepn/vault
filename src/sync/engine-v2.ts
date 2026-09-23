import { VaultError } from '../domain/errors.js';
import { newId, type AccountId, type DeviceId, type Entry, type EntryId, type OperationId, type Vault } from '../domain/model.js';
import type { VaultCryptoContext } from '../crypto/context.js';
import { sealOperationV2, type SealedOperationV2, type SyncOperationV2 } from './protocol-v2.js';
import type { SyncLocalStateV2, SyncOutboxRecordV2 } from './local-state-v2.js';
import type { EncryptedReplicaStoreV2 } from './replica-store-v2.js';
import type { LocalRepository } from '../storage/local-repository.js';
import type { SupabaseSyncTransport } from './transport.js';
import { decryptRemoteEntityV2, serializeLocalEntityV2, type DecryptedSyncEntityV2 } from './serialization-v2.js';

export interface EncryptedSyncRunSummaryV2 {
  pulledEvents:number;
  pushedOperations:number;
  observedOwnOperations:number;
  appliedRemoteEntities:number;
  localChangedAfterOwnPush:number;
  deferredAttachments:number;
  outboxRemaining:number;
  cursor:string;
}

export interface EncryptedSyncCryptoResolverV2 {
  active():Promise<VaultCryptoContext>;
  forGeneration(generation:number):Promise<VaultCryptoContext>;
}

type EncryptedTransportV2=Pick<
  SupabaseSyncTransport,
  'pullV2'|'pushV2'|'ackV2'
>;

function requireV2Binding(vault:Vault,accountId:AccountId){
  if(vault.mode!=='cloud'||!vault.cloud) throw new VaultError('PROTOCOL','This Vault has not been adopted for cloud synchronization.');
  if(vault.cloud.protocolVersion!==2) throw new VaultError('PROTOCOL','This Vault is not activated for encrypted Protocol v2 synchronization.');
  if(vault.cloud.accountId!==accountId) throw new VaultError('ACCOUNT_MISMATCH','This Vault is bound to a different AccountId.');
  if((vault.cloud.ownerAccountId??vault.cloud.accountId)!==accountId || (vault.cloud.accessRole??'owner')!=='owner'){
    throw new VaultError('PERMISSION','I5 encrypted synchronization is certified for the canonical Vault owner only.');
  }
  return vault.cloud;
}

function entryDepth(entry:Entry,byId:ReadonlyMap<EntryId,Entry>):number{
  let depth=0;
  let current=entry.parentId;
  const seen=new Set<EntryId>();
  while(current){
    if(seen.has(current)||depth>=255) throw new VaultError('CYCLE','Local folder hierarchy is invalid.');
    seen.add(current);
    const parent=byId.get(current);
    if(!parent) break;
    depth++;
    current=parent.parentId;
  }
  return depth;
}

function retryDelay(attempt:number,random=Math.random()):number{
  const base=Math.min(60_000,500*(2**Math.min(7,Math.max(0,attempt-1))));
  return Math.round(base*(0.75+Math.max(0,Math.min(1,random))*0.5));
}

function conflictError(reason:string):VaultError{
  switch(reason){
    case 'revision':
    case 'exists':
      return new VaultError('MERGE_REQUIRED','The encrypted remote entity changed from the synchronized base. I6 reconciliation is required.');
    case 'name':
      return new VaultError('COLLISION','Encrypted synchronization found a same-folder name collision.');
    case 'parent':
      return new VaultError('INVALID_PARENT','Encrypted synchronization rejected an unavailable parent folder.');
    case 'cycle':
      return new VaultError('CYCLE','Encrypted synchronization rejected a folder cycle.');
    case 'blob':
      return new VaultError('PROTOCOL','Encrypted attachment BlobId is not ready. Attachment replication begins in I7.');
    default:
      return new VaultError('PROTOCOL','Encrypted synchronization rejected incompatible entity state.');
  }
}

export class EncryptedSyncEngineV2 {
  private readonly inFlight=new Map<string,Promise<EncryptedSyncRunSummaryV2>>();

  constructor(
    private readonly transport:EncryptedTransportV2,
    private readonly state:SyncLocalStateV2,
    private readonly replica:EncryptedReplicaStoreV2,
    private readonly repository:Pick<LocalRepository,'listEntries'>,
  ){}

  async sync(
    vault:Vault,
    accountId:AccountId,
    crypto:EncryptedSyncCryptoResolverV2,
  ):Promise<EncryptedSyncRunSummaryV2>{
    const binding=requireV2Binding(vault,accountId);
    const key=`${accountId}:${vault.id}:${binding.epoch}`;
    const existing=this.inFlight.get(key);
    if(existing) return existing;
    const run=this.run(vault,accountId,crypto);
    this.inFlight.set(key,run);
    try{return await run;}
    finally{if(this.inFlight.get(key)===run)this.inFlight.delete(key);}
  }

  private async run(
    vault:Vault,
    accountId:AccountId,
    crypto:EncryptedSyncCryptoResolverV2,
  ):Promise<EncryptedSyncRunSummaryV2>{
    const binding=requireV2Binding(vault,accountId);
    await this.state.assertPendingAccounts(vault.id,accountId);
    const cursor=await this.state.initializeCursor(vault.id,accountId,binding.epoch);
    const summary:EncryptedSyncRunSummaryV2={
      pulledEvents:0,
      pushedOperations:0,
      observedOwnOperations:0,
      appliedRemoteEntities:0,
      localChangedAfterOwnPush:0,
      deferredAttachments:0,
      outboxRemaining:0,
      cursor:cursor.cursor,
    };

    const active=await crypto.active();
    if(active.vaultId!==vault.id) throw new VaultError('ACCOUNT_MISMATCH','Active Vault crypto context belongs to another Vault.');

    let current=await this.pullUntilCaughtUp(vault,accountId,cursor.cursor,active,crypto,summary);

    // Two bounded push cycles are enough to observe an accepted operation and
    // then synthesize one newer edit that happened while that immutable wire was
    // in flight. No unbounded "until stable" loop runs in the foreground.
    for(let pass=0;pass<2;pass++){
      const synthesized=await this.synthesizeDirty(vault,accountId,binding.deviceId,active,summary);
      await this.pushPending(vault,accountId,summary);
      current=await this.pullUntilCaughtUp(vault,accountId,current,active,crypto,summary);
      if(synthesized===0) break;
    }

    summary.cursor=current;
    summary.outboxRemaining=await this.state.count(vault.id,accountId);
    return summary;
  }

  private async decryptPage(
    vault:Vault,
    snapshots:readonly import('./remote-v2.js').EncryptedRemoteSnapshotV2[],
    active:VaultCryptoContext,
    crypto:EncryptedSyncCryptoResolverV2,
  ):Promise<DecryptedSyncEntityV2[]>{
    const byGeneration=new Map<number,VaultCryptoContext>([[active.keyGeneration,active]]);
    const result:DecryptedSyncEntityV2[]=[];
    for(const snapshot of snapshots){
      let context=byGeneration.get(snapshot.payload.keyGeneration);
      if(!context){
        context=await crypto.forGeneration(snapshot.payload.keyGeneration);
        if(context.vaultId!==vault.id||context.keyGeneration!==snapshot.payload.keyGeneration){
          throw new VaultError('ACCOUNT_MISMATCH','Vault key resolver returned the wrong Vault/generation.');
        }
        byGeneration.set(snapshot.payload.keyGeneration,context);
      }
      result.push(await decryptRemoteEntityV2({snapshot,crypto:context}));
    }
    return result;
  }

  private async pullUntilCaughtUp(
    vault:Vault,
    accountId:AccountId,
    after:string,
    active:VaultCryptoContext,
    crypto:EncryptedSyncCryptoResolverV2,
    summary:EncryptedSyncRunSummaryV2,
  ):Promise<string>{
    const binding=requireV2Binding(vault,accountId);
    let current=after;
    for(let pageIndex=0;pageIndex<10_000;pageIndex++){
      const page=await this.transport.pullV2(vault.id,binding.epoch,binding.deviceId,current,500);
      if(page.events.length){
        // Transport validation already checked event/snapshot identity and page
        // contiguity. Decrypt every event before opening the local write tx.
        const decrypted=await this.decryptPage(vault,page.events.map(event=>event.snapshot),active,crypto);
        const applied=await this.replica.applyPage({
          accountId,
          epoch:binding.epoch,
          expectedAfter:current,
          through:page.through,
          events:decrypted,
        });
        current=applied.cursor;
        summary.pulledEvents+=page.events.length;
        summary.observedOwnOperations+=applied.observedOwnOperations;
        summary.appliedRemoteEntities+=applied.appliedRemoteEntities;
        summary.localChangedAfterOwnPush+=applied.localChangedAfterOwnPush;

        // Acknowledgement is operational metadata. Local canonical state/cursor
        // are already durable; an ack network failure must not roll them back.
        await this.transport.ackV2(vault.id,binding.epoch,binding.deviceId,current).catch(()=>undefined);
      }
      if(current===page.highWatermark) return current;
      if(page.through===page.after) throw new VaultError('PROTOCOL','Protocol v2 pull made no cursor progress.');
      current=page.through;
    }
    throw new VaultError('PROTOCOL','Protocol v2 pull exceeded the page safety limit.');
  }

  private async synthesizeDirty(
    vault:Vault,
    accountId:AccountId,
    deviceId:DeviceId,
    active:VaultCryptoContext,
    summary:EncryptedSyncRunSummaryV2,
  ):Promise<number>{
    const binding=requireV2Binding(vault,accountId);
    const dirty=await this.replica.listDirty(vault.id);
    if(!dirty.length) return 0;

    const entries=await this.repository.listEntries(vault.id,true);
    const byId=new Map(entries.map(entry=>[entry.id,entry]));
    dirty.sort((a,b)=>{
      const ea=byId.get(a.entryId);
      const eb=byId.get(b.entryId);
      const da=ea?entryDepth(ea,byId):0;
      const db=eb?entryDepth(eb,byId):0;
      const deletedA=ea?.deletedAt!==null||a.intent==='trash';
      const deletedB=eb?.deletedAt!==null||b.intent==='trash';
      if(deletedA!==deletedB) return deletedA?1:-1;
      if(deletedA&&deletedB) return db-da||a.changedAt.localeCompare(b.changedAt);
      return da-db||a.changedAt.localeCompare(b.changedAt);
    });

    let count=0;
    for(const item of dirty){
      const entry=byId.get(item.entryId);
      if(!entry) continue;
      if(entry.kind==='attachment'){
        summary.deferredAttachments++;
        continue;
      }
      if(await this.state.pendingForEntity(vault.id,accountId,item.entryId).then(rows=>rows.length>0)) continue;

      const local=await this.replica.read(item.entryId);
      if(!local) continue;
      const shadow=await this.replica.shadow(item.entryId,accountId,binding.epoch);
      const candidate=await serializeLocalEntityV2({
        local,
        crypto:active,
        baseRemoteRevision:shadow?.remoteRevision ?? null,
      });

      // Encryption happens outside IndexedDB. Re-read the canonical local entry
      // before sealing so a concurrent edit can never be represented by stale
      // ciphertext queued under the newer local state.
      const latest=await this.replica.read(item.entryId);
      if(!latest||latest.entry.localVersion!==candidate.localVersion) continue;

      if(shadow&&candidate.stateHash===shadow.baseStateSha256){
        await this.replica.clearDirty(item.entryId);
        continue;
      }

      const operation:SyncOperationV2={
        protocolVersion:2,
        operationId:newId<'operation'>() as OperationId,
        accountId,
        vaultId:vault.id,
        deviceId,
        mutations:[candidate.mutation],
      };
      await this.state.enqueue(await sealOperationV2(operation));
      count++;
    }
    return count;
  }

  private async pushPending(
    vault:Vault,
    accountId:AccountId,
    summary:EncryptedSyncRunSummaryV2,
  ):Promise<void>{
    requireV2Binding(vault,accountId);
    const rows=await this.state.pending(vault.id,accountId);
    for(const row of rows){
      // Accepted rows wait for their ordered pull event. Re-pushing them is
      // unnecessary; a lost *push response* never sets acceptedAt, so that case
      // still retries exact immutable bytes.
      if(row.acceptedAt) continue;
      try{
        const sealed:SealedOperationV2={
          protocolVersion:2,
          operationId:row.id,
          accountId:row.accountId,
          vaultId:row.vaultId,
          wire:row.wire,
          sha256:row.sha256,
        };
        const result=await this.transport.pushV2(sealed);
        if(result.status==='conflict') throw conflictError(result.reason);

        const decoded=JSON.parse(row.wire) as SyncOperationV2;
        if(decoded.mutations.length!==1||result.snapshots.length!==1
          ||result.snapshots[0]?.entityId!==decoded.mutations[0]?.entityId){
          throw new VaultError('PROTOCOL','Protocol v2 push acknowledgement does not match the queued one-entity operation.');
        }
        await this.state.markAccepted(row.id,result.through);
        summary.pushedOperations++;
      }catch(error){
        if(error instanceof VaultError && [
          'ACCOUNT_MISMATCH','PERMISSION','PROTOCOL','COLLISION','INVALID_PARENT','CYCLE','MERGE_REQUIRED'
        ].includes(error.code)) throw error;
        const attempt=row.attempt+1;
        await this.state.markAttempt(
          row.id,
          attempt,
          new Date(Date.now()+retryDelay(attempt)).toISOString(),
        );
        throw error;
      }
    }
  }
}
