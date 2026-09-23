import { VaultError } from '../domain/errors.js';
import type { EntryId, VaultId } from '../domain/model.js';
import { storageDriver, type LocalStorageDriver } from '../storage/driver.js';

export type CollaborationHistoryKind='edit'|'revert';

export interface PendingCollaborationHistory {
  id:string;
  vaultId:VaultId;
  entryId:EntryId;
  authUserId:string;
  epoch:string;
  deviceId:string;
  sessionId:string;
  baseRevision:number;
  baseFingerprint:string;
  kind:CollaborationHistoryKind;
  revertsHistoryId:string|null;
  beforeText:string;
  afterText:string;
  updateBase64:string;
  createdAt:string;
  attempt:number;
  nextAttemptAt:string;
}

const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function validate(record:PendingCollaborationHistory):void{
  if(!UUID_PATTERN.test(record.id)||!UUID_PATTERN.test(record.entryId)||!UUID_PATTERN.test(record.vaultId)
    ||!UUID_PATTERN.test(record.authUserId)||!UUID_PATTERN.test(record.deviceId)||!UUID_PATTERN.test(record.sessionId)
    ||!UUID_PATTERN.test(record.epoch)) throw new VaultError('CORRUPT','Collaboration history identity is invalid.');
  if(!Number.isSafeInteger(record.baseRevision)||record.baseRevision<1
    ||!/^[0-9a-f]{8}$/u.test(record.baseFingerprint)) throw new VaultError('CORRUPT','Collaboration history base is invalid.');
  if(record.kind!=='edit'&&record.kind!=='revert') throw new VaultError('CORRUPT','Collaboration history kind is invalid.');
  if(record.kind==='revert' ? !record.revertsHistoryId || !UUID_PATTERN.test(record.revertsHistoryId) : record.revertsHistoryId!==null){
    throw new VaultError('CORRUPT','Collaboration revert target is invalid.');
  }
  if(typeof record.beforeText!=='string'||typeof record.afterText!=='string'||record.beforeText===record.afterText){
    throw new VaultError('CORRUPT','Collaboration history text transition is invalid.');
  }
  if(record.beforeText.length>2_097_152||record.afterText.length>2_097_152){
    throw new VaultError('CORRUPT','Collaboration history text exceeds the supported size.');
  }
  if(typeof record.updateBase64!=='string'||!record.updateBase64||record.updateBase64.length>1_048_584){
    throw new VaultError('CORRUPT','Collaboration history update payload is invalid.');
  }
  if(!Number.isFinite(Date.parse(record.createdAt))||!Number.isFinite(Date.parse(record.nextAttemptAt))
    ||!Number.isSafeInteger(record.attempt)||record.attempt<0){
    throw new VaultError('CORRUPT','Collaboration history retry metadata is invalid.');
  }
}

export class CollaborationHistoryOutbox {
  private readonly driver:LocalStorageDriver;
  constructor(database:IDBDatabase|LocalStorageDriver){this.driver=storageDriver(database);}

  async enqueue(record:PendingCollaborationHistory):Promise<void>{
    validate(record);
    await this.driver.transaction(['collabHistoryOutbox'],'readwrite',async tx=>{
      const store=tx.store('collabHistoryOutbox');
      const existing=await store.get<PendingCollaborationHistory>(record.id);
      if(existing){
        validate(existing);
        if(JSON.stringify(existing)!==JSON.stringify(record)) throw new VaultError('PROTOCOL','Collaboration history identity was reused with different content.');
        return;
      }
      await store.add(structuredClone(record));
    });
  }

  async list(vaultId:VaultId,entryId?:EntryId):Promise<PendingCollaborationHistory[]>{
    const rows=entryId
      ? await this.driver.transaction(['collabHistoryOutbox'],'readonly',tx=>tx.store('collabHistoryOutbox').allFromIndex<PendingCollaborationHistory>('entryId',entryId))
      : await this.driver.transaction(['collabHistoryOutbox'],'readonly',tx=>tx.store('collabHistoryOutbox').allFromIndex<PendingCollaborationHistory>('vaultId',vaultId));
    const filtered=rows.filter(row=>row.vaultId===vaultId);
    for(const row of filtered) validate(row);
    return filtered.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
  }

  async remove(id:string):Promise<void>{
    await this.driver.transaction(['collabHistoryOutbox'],'readwrite',tx=>tx.store('collabHistoryOutbox').delete(id));
  }

  async markAttempt(id:string,attempt:number,nextAttemptAt:string):Promise<void>{
    await this.driver.transaction(['collabHistoryOutbox'],'readwrite',async tx=>{
      const store=tx.store('collabHistoryOutbox');
      const row=await store.get<PendingCollaborationHistory>(id);
      if(!row) return;
      const updated={...row,attempt,nextAttemptAt};
      validate(updated);
      await store.put(updated);
    });
  }
}
