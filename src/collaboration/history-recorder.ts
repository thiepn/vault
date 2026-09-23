import * as Y from 'yjs';
import type { EntryId, VaultId } from '../domain/model.js';
import { bytesToBase64 } from './crdt-text.js';
import { CollaborationHistoryOutbox, type CollaborationHistoryKind, type PendingCollaborationHistory } from './history-outbox.js';

export interface LocalCrdtTransaction {
  beforeText:string;
  afterText:string;
  updates:readonly Uint8Array[];
}

export interface CollaborationHistoryRecorderContext {
  vaultId:VaultId;
  entryId:EntryId;
  authUserId:string;
  epoch:string;
  deviceId:string;
  sessionId:string;
  baseRevision:number;
  baseFingerprint:string;
}

export interface CollaborationHistoryRecordMeta {
  kind?:CollaborationHistoryKind;
  revertsHistoryId?:string|null;
}

interface Batch {
  id:string;
  beforeText:string;
  afterText:string;
  updates:Uint8Array[];
  kind:CollaborationHistoryKind;
  revertsHistoryId:string|null;
  createdAt:string;
  startedAt:number;
}

const IDLE_MS=1_200;
const MAX_BATCH_MS=30_000;

export class CollaborationHistoryRecorder {
  private batch:Batch|null=null;
  private timer:ReturnType<typeof setTimeout>|null=null;
  private chain=Promise.resolve();

  constructor(
    private readonly context:CollaborationHistoryRecorderContext,
    private readonly outbox:CollaborationHistoryOutbox,
    private readonly onQueued?:(record:PendingCollaborationHistory)=>void|Promise<void>,
  ){}

  record(transaction:LocalCrdtTransaction,meta:CollaborationHistoryRecordMeta={}):void{
    if(transaction.beforeText===transaction.afterText||!transaction.updates.length) return;
    const kind=meta.kind??'edit';
    const revertsHistoryId=kind==='revert' ? meta.revertsHistoryId??null : null;
    const now=Date.now();
    const compatible=this.batch
      && this.batch.kind===kind
      && this.batch.revertsHistoryId===revertsHistoryId
      && this.batch.afterText===transaction.beforeText
      && now-this.batch.startedAt<MAX_BATCH_MS;

    if(!compatible) this.queueCurrent();
    if(!this.batch){
      this.batch={
        id:crypto.randomUUID(),
        beforeText:transaction.beforeText,
        afterText:transaction.afterText,
        updates:transaction.updates.map(update=>update.slice()),
        kind,
        revertsHistoryId,
        createdAt:new Date().toISOString(),
        startedAt:now,
      };
    }else{
      this.batch.afterText=transaction.afterText;
      this.batch.updates.push(...transaction.updates.map(update=>update.slice()));
    }
    this.arm();
  }

  flush():Promise<void>{
    this.queueCurrent();
    return this.chain;
  }

  private arm():void{
    if(this.timer!==null) clearTimeout(this.timer);
    this.timer=setTimeout(()=>{
      this.timer=null;
      this.queueCurrent();
    },IDLE_MS);
  }

  private queueCurrent():void{
    if(this.timer!==null) clearTimeout(this.timer);
    this.timer=null;
    const batch=this.batch;
    this.batch=null;
    if(!batch) return;
    const update=Y.mergeUpdates(batch.updates);
    const record:PendingCollaborationHistory={
      id:batch.id,
      vaultId:this.context.vaultId,
      entryId:this.context.entryId,
      authUserId:this.context.authUserId,
      epoch:this.context.epoch,
      deviceId:this.context.deviceId,
      sessionId:this.context.sessionId,
      baseRevision:this.context.baseRevision,
      baseFingerprint:this.context.baseFingerprint,
      kind:batch.kind,
      revertsHistoryId:batch.revertsHistoryId,
      beforeText:batch.beforeText,
      afterText:batch.afterText,
      updateBase64:bytesToBase64(update),
      createdAt:batch.createdAt,
      attempt:0,
      nextAttemptAt:batch.createdAt,
    };
    this.chain=this.chain.then(async()=>{
      await this.outbox.enqueue(record);
      await this.onQueued?.(record);
    });
  }
}
