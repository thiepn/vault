import { VaultError } from '../domain/errors.js';
import type { PublicBackendConfig } from '../services/runtime-config.js';
import type { VaultId } from '../domain/model.js';
import type { RemoteReplicationEvent } from './remote-types.js';
import { storageDriver, type LocalStorageDriver } from '../storage/driver.js';

export interface BackgroundAuthSession {
  accessToken:string;
  refreshToken:string;
  expiresAt:number;
}

export interface BackgroundRuntimeRecord {
  id:'runtime';
  databaseName:string;
  config:PublicBackendConfig;
  authUserId:string;
  session:BackgroundAuthSession;
  updatedAt:string;
}

export type BackgroundSyncCapability='unsupported'|'available'|'registered';

export interface BackgroundStatusRecord {
  id:'status';
  capability:BackgroundSyncCapability;
  lastAttemptAt:string|null;
  lastSuccessAt:string|null;
  lastError:string|null;
  stagedEvents:number;
  pushedOperations:number;
  updatedAt:string;
}

export interface StagedRemoteEventRecord {
  id:string;
  vaultId:VaultId;
  ownerId:string;
  epoch:string;
  sequence:string;
  event:RemoteReplicationEvent;
  stagedAt:string;
}

function validDate(value:string|null):boolean{
  return value===null || Number.isFinite(Date.parse(value));
}

export class BackgroundReplicationState {
  private readonly driver:LocalStorageDriver;
  constructor(database:IDBDatabase|LocalStorageDriver){
    this.driver=storageDriver(database);
  }

  async putRuntime(record:BackgroundRuntimeRecord):Promise<void>{
    if(record.id!=='runtime' || !record.databaseName || !record.authUserId
      || !record.session.accessToken || !record.session.refreshToken
      || !Number.isFinite(record.session.expiresAt) || record.session.expiresAt<=0
      || !Number.isFinite(Date.parse(record.updatedAt))) {
      throw new VaultError('PROTOCOL','Background replication runtime is invalid.');
    }
    await this.driver.transaction(['backgroundRuntime'],'readwrite',tx=>tx.store('backgroundRuntime').put(structuredClone(record)));
  }

  async clearRuntime():Promise<void>{
    await this.driver.transaction(['backgroundRuntime'],'readwrite',tx=>tx.store('backgroundRuntime').delete('runtime'));
  }

  async runtime():Promise<BackgroundRuntimeRecord|null>{
    return this.driver.transaction(['backgroundRuntime'],'readonly',async tx=>{
      const row=await tx.store('backgroundRuntime').get<BackgroundRuntimeRecord>('runtime');
      return row ? structuredClone(row) : null;
    });
  }

  async putStatus(record:BackgroundStatusRecord):Promise<void>{
    if(record.id!=='status' || !['unsupported','available','registered'].includes(record.capability)
      || !validDate(record.lastAttemptAt) || !validDate(record.lastSuccessAt)
      || !(record.lastError===null || typeof record.lastError==='string')
      || !Number.isSafeInteger(record.stagedEvents) || record.stagedEvents<0
      || !Number.isSafeInteger(record.pushedOperations) || record.pushedOperations<0
      || !Number.isFinite(Date.parse(record.updatedAt))) {
      throw new VaultError('PROTOCOL','Background replication status is invalid.');
    }
    await this.driver.transaction(['backgroundRuntime'],'readwrite',tx=>tx.store('backgroundRuntime').put(structuredClone(record)));
  }

  async status():Promise<BackgroundStatusRecord|null>{
    return this.driver.transaction(['backgroundRuntime'],'readonly',async tx=>{
      const row=await tx.store('backgroundRuntime').get<BackgroundStatusRecord>('status');
      if(!row) return null;
      if(!['unsupported','available','registered'].includes(row.capability)
        || !validDate(row.lastAttemptAt) || !validDate(row.lastSuccessAt)
        || !(row.lastError===null || typeof row.lastError==='string')
        || !Number.isSafeInteger(row.stagedEvents) || row.stagedEvents<0
        || !Number.isSafeInteger(row.pushedOperations) || row.pushedOperations<0
        || !Number.isFinite(Date.parse(row.updatedAt))) {
        throw new VaultError('CORRUPT','Background replication status is invalid.');
      }
      return structuredClone(row);
    });
  }

  async staged(vaultId:VaultId,ownerId:string,epoch:string):Promise<StagedRemoteEventRecord[]>{
    const rows=await this.driver.transaction(['remoteInbox'],'readonly',tx=>tx.store('remoteInbox').allFromIndex<StagedRemoteEventRecord>('vaultId',vaultId));
    return rows
      .filter(row=>row.ownerId===ownerId && row.epoch===epoch)
      .sort((a,b)=>{
        const left=BigInt(a.sequence), right=BigInt(b.sequence);
        return left<right ? -1 : left>right ? 1 : 0;
      });
  }

  async removeStaged(id:string):Promise<void>{
    await this.driver.transaction(['remoteInbox'],'readwrite',tx=>tx.store('remoteInbox').delete(id));
  }
}
