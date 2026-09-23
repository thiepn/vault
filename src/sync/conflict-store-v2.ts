import { VaultError } from '../domain/errors.js';
import { isUuidV7, newUuidV7 } from '../domain/canonical.js';
import type { AccountId, EntryId, VaultId } from '../domain/model.js';
import type { StorageTransaction } from '../storage/driver.js';
import { storageDriver, type LocalStorageDriver } from '../storage/driver.js';
import type { SyncConflictKindV2, SyncEntityStateV2 } from './reconcile-v2.js';

export type SyncConflictStatusV2='open'|'resolution-pending'|'resolved';
export type SyncConflictResolutionV2='keep-local'|'keep-remote'|'manual'|'keep-both';

export interface SyncConflictRecordV2 {
  protocolVersion:2;
  id:string;
  vaultId:VaultId;
  entryId:EntryId;
  accountId:AccountId;
  epoch:string;
  entityType:'note'|'folder';
  kind:SyncConflictKindV2;
  status:SyncConflictStatusV2;
  baseRevision:string|null;
  remoteRevision:string;
  base:SyncEntityStateV2|null;
  local:SyncEntityStateV2;
  remote:SyncEntityStateV2;
  markdownConflictIds:readonly string[];
  source:'pull'|'push';
  resolution:SyncConflictResolutionV2|null;
  resolutionText:string|null;
  createdAt:string;
  updatedAt:string;
  resolvedAt:string|null;
}

function revision(value:string|null,label:string,allowNull=false):void{
  if(value===null&&allowNull)return;
  if(typeof value!=='string'||!/^[1-9][0-9]*$/u.test(value)||BigInt(value)>9223372036854775807n){
    throw new VaultError('CORRUPT',label+' is invalid.');
  }
}

function validateState(state:SyncEntityStateV2,label:string):void{
  if(!state||typeof state!=='object'||!state.entryId||!state.vaultId) throw new VaultError('CORRUPT',label+' identity is invalid.');
  if(state.entityType!=='note'&&state.entityType!=='folder') throw new VaultError('CORRUPT',label+' entity type is invalid.');
  if(typeof state.name!=='string'||typeof state.createdAt!=='string'||typeof state.updatedAt!=='string'){
    throw new VaultError('CORRUPT',label+' metadata is invalid.');
  }
  if(state.deletedAt!==null&&typeof state.deletedAt!=='string') throw new VaultError('CORRUPT',label+' deletion state is invalid.');
  if(state.entityType==='note'&&typeof state.text!=='string') throw new VaultError('CORRUPT',label+' Markdown is missing.');
  if(state.entityType==='folder'&&state.text!==null) throw new VaultError('CORRUPT',label+' folder unexpectedly contains Markdown.');
}

export function validateSyncConflictV2(record:SyncConflictRecordV2):void{
  if(record.protocolVersion!==2||!isUuidV7(record.id)) throw new VaultError('CORRUPT','Protocol v2 conflict identity is invalid.');
  if(!record.vaultId||!record.entryId||!record.accountId||!record.epoch) throw new VaultError('CORRUPT','Protocol v2 conflict scope is invalid.');
  if(!['open','resolution-pending','resolved'].includes(record.status)) throw new VaultError('CORRUPT','Protocol v2 conflict status is invalid.');
  if(!['markdown','structure','delete-edit','name','parent','concurrent-create'].includes(record.kind)){
    throw new VaultError('CORRUPT','Protocol v2 conflict kind is invalid.');
  }
  revision(record.baseRevision,'Protocol v2 conflict base revision',true);
  revision(record.remoteRevision,'Protocol v2 conflict remote revision');
  validateState(record.local,'Conflict LOCAL');
  validateState(record.remote,'Conflict REMOTE');
  if(record.base)validateState(record.base,'Conflict BASE');
  if(record.local.entryId!==record.entryId||record.local.vaultId!==record.vaultId){
    throw new VaultError('CORRUPT','Protocol v2 conflict LOCAL identity is inconsistent.');
  }
  if(record.base&&record.base.entryId!==record.entryId) throw new VaultError('CORRUPT','Protocol v2 conflict BASE identity is inconsistent.');
  if(record.status==='resolved'&&!record.resolvedAt) throw new VaultError('CORRUPT','Resolved Protocol v2 conflict is missing resolution time.');
}

async function rowsForEntry(tx:StorageTransaction,vaultId:VaultId,entryId:EntryId):Promise<SyncConflictRecordV2[]>{
  const rows=await tx.store('syncConflicts').getAll<SyncConflictRecordV2>();
  return rows.filter(row=>row.vaultId===vaultId&&row.entryId===entryId);
}

export async function openSyncConflictInTx(
  tx:StorageTransaction,
  vaultId:VaultId,
  entryId:EntryId,
):Promise<SyncConflictRecordV2|null>{
  const rows=await rowsForEntry(tx,vaultId,entryId);
  const open=rows.filter(row=>row.status==='open'||row.status==='resolution-pending');
  if(open.length>1)throw new VaultError('CORRUPT','More than one unresolved Protocol v2 conflict exists for this entity.');
  if(!open.length)return null;
  validateSyncConflictV2(open[0]!);
  return open[0]!;
}

export interface UpsertSyncConflictV2 {
  vaultId:VaultId;
  entryId:EntryId;
  accountId:AccountId;
  epoch:string;
  entityType:'note'|'folder';
  kind:SyncConflictKindV2;
  baseRevision:string|null;
  remoteRevision:string;
  base:SyncEntityStateV2|null;
  local:SyncEntityStateV2;
  remote:SyncEntityStateV2;
  markdownConflictIds?:readonly string[];
  source:'pull'|'push';
}

export async function upsertSyncConflictInTx(
  tx:StorageTransaction,
  input:UpsertSyncConflictV2,
):Promise<SyncConflictRecordV2>{
  const existing=await openSyncConflictInTx(tx,input.vaultId,input.entryId);
  const timestamp=new Date().toISOString();
  if(existing){
    if(existing.accountId!==input.accountId||existing.epoch!==input.epoch||existing.entityType!==input.entityType){
      throw new VaultError('ACCOUNT_MISMATCH','Existing Protocol v2 conflict belongs to another synchronization identity.');
    }
    // BASE is intentionally immutable for the lifetime of an unresolved conflict.
    const updated:SyncConflictRecordV2={
      ...existing,
      kind:input.kind,
      local:structuredClone(input.local),
      remote:structuredClone(input.remote),
      remoteRevision:input.remoteRevision,
      markdownConflictIds:[...(input.markdownConflictIds??[])],
      source:input.source,
      status:'open',
      resolution:null,
      resolutionText:null,
      resolvedAt:null,
      updatedAt:timestamp,
    };
    validateSyncConflictV2(updated);
    await tx.store('syncConflicts').put(updated);
    return updated;
  }
  const record:SyncConflictRecordV2={
    protocolVersion:2,
    id:newUuidV7(),
    vaultId:input.vaultId,
    entryId:input.entryId,
    accountId:input.accountId,
    epoch:input.epoch,
    entityType:input.entityType,
    kind:input.kind,
    status:'open',
    baseRevision:input.baseRevision,
    remoteRevision:input.remoteRevision,
    base:input.base?structuredClone(input.base):null,
    local:structuredClone(input.local),
    remote:structuredClone(input.remote),
    markdownConflictIds:[...(input.markdownConflictIds??[])],
    source:input.source,
    resolution:null,
    resolutionText:null,
    createdAt:timestamp,
    updatedAt:timestamp,
    resolvedAt:null,
  };
  validateSyncConflictV2(record);
  await tx.store('syncConflicts').add(record);
  return record;
}

export class SyncConflictStoreV2 {
  private readonly driver:LocalStorageDriver;
  constructor(database:IDBDatabase|LocalStorageDriver){this.driver=storageDriver(database);}

  async get(id:string):Promise<SyncConflictRecordV2|null>{
    const row=await this.driver.transaction(['syncConflicts'],'readonly',tx=>tx.store('syncConflicts').get<SyncConflictRecordV2>(id));
    if(!row)return null;
    validateSyncConflictV2(row);
    return row;
  }

  async openForEntry(vaultId:VaultId,entryId:EntryId):Promise<SyncConflictRecordV2|null>{
    return this.driver.transaction(['syncConflicts'],'readonly',tx=>openSyncConflictInTx(tx,vaultId,entryId));
  }

  async listOpen(vaultId:VaultId):Promise<SyncConflictRecordV2[]>{
    const rows=await this.driver.transaction(
      ['syncConflicts'],'readonly',
      tx=>tx.store('syncConflicts').allFromIndex<SyncConflictRecordV2>('vaultId',vaultId),
    );
    const result=rows.filter(row=>row.status!=='resolved');
    for(const row of result)validateSyncConflictV2(row);
    return result.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
  }
}
