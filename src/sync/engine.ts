import { VaultError } from '../domain/errors.js';
import type { DeviceId, Entry, EntryId, Vault } from '../domain/model.js';
import type { LocalRepository } from '../storage/local-repository.js';
import { decodeOperation, retryDelay, type SealedOperation } from './protocol.js';
import type { SyncLocalState, SyncOutboxRecord } from './local-state.js';
import type { RemoteEntrySnapshot, RemoteReplicationEvent } from './remote-types.js';
import type { SyncReplicaStore } from './replica-store.js';
import type { SupabaseSyncTransport } from './transport.js';
import { synthesizeEntryOperation } from './synthesize.js';
import { compareVersions } from './merge.js';

export interface SyncRunSummary {
  pulledEvents: number;
  pushedOperations: number;
  conflictsPreserved: number;
  autoMergedMarkdown: number;
  uploadedBlobs: number;
  downloadedBlobs: number;
  outboxRemaining: number;
  cursor: string;
}

function requireBinding(vault: Vault, ownerId: string): NonNullable<Vault['cloud']> {
  if(vault.mode!=='cloud' || !vault.cloud) throw new VaultError('PROTOCOL','This Vault has not been adopted for cloud synchronization.');
  if(vault.cloud.authUserId!==ownerId) throw new VaultError('ACCOUNT_MISMATCH','This Vault is bound to a different signed-in account.');
  return vault.cloud;
}

function depth(entry:Entry,byId:ReadonlyMap<EntryId,Entry>):number{
  let result=0;
  let current=entry.parentId;
  const seen=new Set<EntryId>();
  while(current){
    if(seen.has(current)||result>255) throw new VaultError('CYCLE','Local folder hierarchy is invalid.');
    seen.add(current);
    const parent=byId.get(current);
    if(!parent) break;
    result++;
    current=parent.parentId;
  }
  return result;
}

function conflictName(name:string):string{
  const suffix=crypto.randomUUID().slice(0,8);
  const dot=name.lastIndexOf('.');
  if(dot>0){
    const base=name.slice(0,dot);
    const extension=name.slice(dot);
    return `${base} conflict ${suffix}${extension}`;
  }
  return `${name} conflict ${suffix}`;
}

export class SyncEngine {
  private readonly inFlight = new Map<string, Promise<SyncRunSummary>>();

  constructor(
    private readonly transport:Pick<SupabaseSyncTransport,'pull'|'push'|'uploadBlob'|'downloadBlob'>,
    private readonly state:SyncLocalState,
    private readonly replica:SyncReplicaStore,
    private readonly repository:LocalRepository,
  ) {}

  async sync(vault:Vault,ownerId:string):Promise<SyncRunSummary>{
    const binding=requireBinding(vault,ownerId);
    const key=`${ownerId}:${vault.id}:${binding.epoch}`;
    const existing=this.inFlight.get(key);
    if(existing) return existing;
    const run=this.runSync(vault,ownerId);
    this.inFlight.set(key,run);
    try{
      return await run;
    } finally {
      if(this.inFlight.get(key)===run) this.inFlight.delete(key);
    }
  }

  private async runSync(vault:Vault,ownerId:string):Promise<SyncRunSummary>{
    const binding=requireBinding(vault,ownerId);
    await this.state.assertPendingOwners(vault.id,ownerId);
    let cursor=await this.state.initializeCursor(vault.id,ownerId,binding.epoch);
    const summary:SyncRunSummary={
      pulledEvents:0,
      pushedOperations:0,
      conflictsPreserved:0,
      autoMergedMarkdown:0,
      uploadedBlobs:0,
      downloadedBlobs:0,
      outboxRemaining:0,
      cursor:cursor.cursor,
    };

    cursor=await this.pullUntilCaughtUp(vault,ownerId,cursor.cursor,summary);
    await this.synthesizeDirty(vault,ownerId,binding.deviceId);
    await this.pushPending(vault,ownerId,summary);
    cursor=await this.pullUntilCaughtUp(vault,ownerId,(await this.state.cursor(vault.id,ownerId))?.cursor ?? cursor.cursor,summary);

    // One second synthesis/push pass picks up conflict copies or local edits that
    // remained dirty after an older queued operation was acknowledged.
    await this.synthesizeDirty(vault,ownerId,binding.deviceId);
    await this.pushPending(vault,ownerId,summary);
    cursor=await this.pullUntilCaughtUp(vault,ownerId,(await this.state.cursor(vault.id,ownerId))?.cursor ?? cursor.cursor,summary);

    summary.cursor=cursor.cursor;
    summary.outboxRemaining=await this.state.count(vault.id);
    return summary;
  }

  private async pullUntilCaughtUp(vault:Vault,ownerId:string,after:string,summary:SyncRunSummary){
    const binding=requireBinding(vault,ownerId);
    let current=after;
    for(let pageIndex=0;pageIndex<10_000;pageIndex++){
      const page=await this.transport.pull(vault.id,binding.epoch,current,500);
      for(const event of page.events){
        await this.applyRemoteEvent(vault,ownerId,event,summary);
        current=event.sequence;
        await this.state.advanceCursor(vault.id,ownerId,binding.epoch,current);
        summary.pulledEvents++;
      }
      if(current===page.highWatermark){
        return await this.state.advanceCursor(vault.id,ownerId,binding.epoch,current);
      }
      if(page.through===page.after) throw new VaultError('PROTOCOL','Remote synchronization made no cursor progress.');
      current=page.through;
    }
    throw new VaultError('PROTOCOL','Remote synchronization exceeded the page safety limit.');
  }

  private async applyRemoteEvent(vault:Vault,ownerId:string,event:RemoteReplicationEvent,summary:SyncRunSummary):Promise<void>{
    const binding=requireBinding(vault,ownerId);
    const pending=await this.state.pendingForEntry(vault.id,ownerId,event.entryId);
    const own=pending.find(row=>row.id===event.operationId);
    if(own){
      await this.replica.recordShadow(ownerId,binding.epoch,event.snapshot);
      await this.replica.clearDirtyIfMatched(event.snapshot);
      await this.state.acknowledge(own.id);
      return;
    }

    const known=await this.state.shadow(event.entryId,ownerId,binding.epoch);
    if(known && event.snapshot.revision <= known.snapshot.revision){
      // A push conflict/ack may have already incorporated a newer snapshot than
      // this historical event. Do not replay the same conflict or downgrade the
      // remote shadow; cursor advancement still happens in the caller.
      if(event.snapshot.revision===known.snapshot.revision){
        await this.replica.clearDirtyIfMatched(event.snapshot);
      }
      return;
    }

    const dirty=await this.state.isDirty(event.entryId);
    if(dirty || pending.length){
      if(await this.replica.matches(event.snapshot)){
        await this.replica.recordShadow(ownerId,binding.epoch,event.snapshot);
        await this.replica.clearDirtyIfMatched(event.snapshot);
        await this.state.dropEntryOperations(vault.id,ownerId,event.entryId);
        return;
      }
      if(await this.tryMergeMarkdown(vault,ownerId,event.snapshot,summary)) return;
      await this.preserveConflictAndApply(vault,ownerId,event.snapshot,summary);
      return;
    }

    await this.applySnapshot(vault,ownerId,event.snapshot,summary);
  }

  private async tryMergeMarkdown(vault:Vault,ownerId:string,snapshot:RemoteEntrySnapshot,summary:SyncRunSummary):Promise<boolean>{
    const binding=requireBinding(vault,ownerId);
    if(snapshot.kind!=='markdown' || snapshot.text===null || snapshot.deletedAt!==null) return false;

    const baseRecord=await this.state.shadow(snapshot.entryId,ownerId,binding.epoch);
    if(!baseRecord || baseRecord.snapshot.kind!=='markdown' || baseRecord.snapshot.text===null || baseRecord.snapshot.deletedAt!==null) return false;

    const local=await this.replica.read(snapshot.entryId);
    if(!local || local.entry.kind!=='markdown' || local.text===null || local.entry.deletedAt!==null) return false;

    // Phase 16 only auto-merges text. A simultaneous local move/rename remains
    // structural intent and is preserved rather than guessed.
    const base=baseRecord.snapshot;
    if(local.entry.parentId!==base.parentId || local.entry.name!==base.name) return false;

    const merged=compareVersions(base.text!,local.text,snapshot.text);
    if(merged.kind==='conflict') return false;

    await this.state.dropEntryOperations(vault.id,ownerId,snapshot.entryId);
    await this.applySnapshot(vault,ownerId,snapshot,summary);

    if(merged.text!==snapshot.text){
      const applied=await this.replica.read(snapshot.entryId);
      if(!applied || applied.entry.kind!=='markdown' || applied.entry.deletedAt!==null){
        throw new VaultError('STALE_WRITE','Merged Markdown could not be materialized safely.');
      }
      await this.repository.saveMarkdown(applied.entry.id,merged.text,applied.entry.localVersion);
      summary.autoMergedMarkdown++;
    }
    return true;
  }

  private async preserveConflictAndApply(vault:Vault,ownerId:string,snapshot:RemoteEntrySnapshot,summary:SyncRunSummary):Promise<void>{
    const binding=requireBinding(vault,ownerId);
    const local=await this.replica.read(snapshot.entryId);
    if(!local){
      await this.applySnapshot(vault,ownerId,snapshot,summary);
      return;
    }
    await this.state.dropEntryOperations(vault.id,ownerId,snapshot.entryId);

    if(local.entry.deletedAt===null){
      const duplicate=await this.repository.duplicate(local.entry.id,local.entry.localVersion);
      await this.repository.move(duplicate.id,duplicate.parentId,conflictName(duplicate.name),duplicate.localVersion);
      await this.applySnapshot(vault,ownerId,snapshot,summary);
      summary.conflictsPreserved++;
      return;
    }

    // A local delete raced a remote edit. Restore the remote canonical entry,
    // preserve that remote version as a conflict copy, then re-apply the local
    // delete intent against the new remote base.
    await this.applySnapshot(vault,ownerId,snapshot,summary);
    const restored=await this.replica.read(snapshot.entryId);
    if(!restored || restored.entry.deletedAt!==null) throw new VaultError('STALE_WRITE','Concurrent delete conflict could not be materialized safely.');
    const duplicate=await this.repository.duplicate(restored.entry.id,restored.entry.localVersion);
    await this.repository.move(duplicate.id,duplicate.parentId,conflictName(duplicate.name),duplicate.localVersion);
    await this.repository.trash(restored.entry.id,restored.entry.localVersion);
    await this.replica.recordShadow(ownerId,binding.epoch,snapshot);
    summary.conflictsPreserved++;
  }

  private async applySnapshot(vault:Vault,ownerId:string,snapshot:RemoteEntrySnapshot,summary:SyncRunSummary):Promise<void>{
    const binding=requireBinding(vault,ownerId);
    const previous=await this.state.shadow(snapshot.entryId,ownerId,binding.epoch);
    let bytes:Uint8Array|undefined;
    if(await this.replica.needsAttachmentBytes(snapshot,previous)){
      if(snapshot.attachmentSha256===null) throw new VaultError('PROTOCOL','Remote attachment has no blob identity.');
      bytes=await this.transport.downloadBlob(ownerId,vault.id,snapshot.attachmentSha256);
      summary.downloadedBlobs++;
    }
    await this.replica.apply(ownerId,binding.epoch,snapshot,bytes);
  }

  private async synthesizeDirty(vault:Vault,ownerId:string,deviceId:DeviceId):Promise<void>{
    const dirty=await this.replica.listDirty(vault.id);
    if(!dirty.length) return;
    const entries=await this.repository.listEntries(vault.id,true);
    const byId=new Map(entries.map(entry=>[entry.id,entry]));
    dirty.sort((a,b)=>{
      const ea=byId.get(a.entryId); const eb=byId.get(b.entryId);
      const da=ea ? depth(ea,byId) : 0; const db=eb ? depth(eb,byId) : 0;
      const trashA=a.intent==='trash'; const trashB=b.intent==='trash';
      if(trashA!==trashB) return trashA ? 1 : -1;
      if(trashA && trashB) return db-da || a.changedAt.localeCompare(b.changedAt);
      return da-db || a.changedAt.localeCompare(b.changedAt);
    });

    for(const item of dirty){
      const synthesized=await synthesizeEntryOperation({
        vault,ownerId,deviceId,entryId:item.entryId,state:this.state,replica:this.replica,
      });
      if(!synthesized){
        if(!(await this.state.pendingForEntry(vault.id,ownerId,item.entryId)).length){
          const shadow=requireBinding(vault,ownerId);
          const remote=await this.state.shadow(item.entryId,ownerId,shadow.epoch);
          if(remote && await this.replica.matches(remote.snapshot)) await this.state.clearDirty(item.entryId);
        }
        continue;
      }
      await this.state.enqueue(synthesized.sealed);
    }
  }

  private async uploadReferencedBlobs(vault:Vault,ownerId:string,row:SyncOutboxRecord,summary:SyncRunSummary):Promise<void>{
    const operation=decodeOperation(row.wire);
    for(const mutation of operation.mutations){
      if(mutation.kind!=='create' || mutation.entryKind!=='attachment' || !mutation.attachment) continue;
      const local=await this.replica.localAttachmentHash(mutation.entryId);
      if(local.sha256!==mutation.attachment.sha256 || local.size!==mutation.attachment.size) {
        throw new VaultError('STALE_WRITE','Queued attachment bytes no longer match the sealed operation.');
      }
      await this.transport.uploadBlob(ownerId,vault.id,local.sha256,local.mimeType,local.bytes);
      summary.uploadedBlobs++;
    }
  }

  private async pushPending(vault:Vault,ownerId:string,summary:SyncRunSummary):Promise<void>{
    const binding=requireBinding(vault,ownerId);
    const rows=await this.state.pending(vault.id,ownerId);
    for(const row of rows){
      try{
        await this.uploadReferencedBlobs(vault,ownerId,row,summary);
        const sealed:SealedOperation={id:row.id,vaultId:row.vaultId,ownerId:row.ownerId,wire:row.wire,sha256:row.sha256};
        const result=await this.transport.push(sealed);
        if(result.status==='conflict'){
          if(result.reason==='path' || !result.current || result.current.entryId!==result.entryId){
            throw new VaultError('COLLISION','Remote synchronization found a path conflict. Rename one local item before syncing again.');
          }
          if(!await this.tryMergeMarkdown(vault,ownerId,result.current,summary)){
            await this.preserveConflictAndApply(vault,ownerId,result.current,summary);
          }
          await this.state.acknowledge(row.id);
          continue;
        }
        for(const snapshot of result.snapshots){
          await this.replica.recordShadow(ownerId,binding.epoch,snapshot);
          await this.replica.clearDirtyIfMatched(snapshot);
        }
        // Keep the immutable outbox operation until its ordered server event is
        // pulled. This makes retries idempotent and lets a newer local edit be
        // distinguished from a true remote conflict with our own just-pushed event.
        summary.pushedOperations++;
      } catch(error){
        if(error instanceof VaultError && ['ACCOUNT_MISMATCH','PROTOCOL','COLLISION','STALE_WRITE'].includes(error.code)) throw error;
        const attempt=row.attempt+1;
        const next=new Date(Date.now()+retryDelay(attempt,Math.random())).toISOString();
        await this.state.markAttempt(row.id,attempt,next);
        throw error;
      }
    }
  }
}
