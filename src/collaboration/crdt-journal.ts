import { VaultError } from '../domain/errors.js';
import type { EntryId, VaultId } from '../domain/model.js';
import { storageDriver, type LocalStorageDriver } from '../storage/driver.js';

export type CrdtJournalSource='local'|'remote'|'sync';
export type CrdtJournalSessionStatus='active'|'closed'|'canonicalized';

export interface CrdtJournalBase {
  vaultId:VaultId;
  entryId:EntryId;
  ownerId:string;
  epoch:string;
  baseRevision:number;
  baseFingerprint:string;
  baseText:string;
}

export interface CrdtJournalSession extends CrdtJournalBase {
  id:string;
  roomKey:string;
  localSessionId:string;
  status:CrdtJournalSessionStatus;
  startedAt:string;
  updatedAt:string;
  closedAt:string|null;
  canonicalRevision:number|null;
  canonicalizedAt:string|null;
  updateCount:number;
  byteSize:number;
}

export interface CrdtJournalUpdate {
  id:string;
  roomKey:string;
  sessionId:string;
  vaultId:VaultId;
  entryId:EntryId;
  source:CrdtJournalSource;
  sourceSessionId:string;
  bytes:Uint8Array;
  byteLength:number;
  createdAt:string;
}

export interface CrdtJournalAppend {
  source:CrdtJournalSource;
  sourceSessionId:string;
  bytes:Uint8Array;
}

export interface CrdtJournalReplay {
  sessions:CrdtJournalSession[];
  updates:CrdtJournalUpdate[];
  byteSize:number;
}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FP=/^[0-9a-f]{8}$/u;
const MAX_UPDATE_BYTES=768*1024;
const MAX_ACTIVE_ROOM_BYTES=16*1024*1024;
const DEFAULT_RETENTION_MS=30*24*60*60*1000;
const DEFAULT_MAX_VAULT_BYTES=64*1024*1024;

function validDate(value:string|null):boolean{
  return value===null || Number.isFinite(Date.parse(value));
}

function validateBase(base:CrdtJournalBase):void{
  if(!UUID.test(base.vaultId)||!UUID.test(base.entryId)||!UUID.test(base.ownerId)||!UUID.test(base.epoch)){
    throw new VaultError('PROTOCOL','CRDT journal identity is invalid.');
  }
  if(!Number.isSafeInteger(base.baseRevision)||base.baseRevision<1||!FP.test(base.baseFingerprint)||typeof base.baseText!=='string'){
    throw new VaultError('PROTOCOL','CRDT journal canonical base is invalid.');
  }
}

function validateSession(session:CrdtJournalSession):void{
  validateBase(session);
  if(!session.id||session.id.length>320||!session.roomKey||session.roomKey.length>260||!UUID.test(session.localSessionId)){
    throw new VaultError('CORRUPT','CRDT journal session identity is invalid.');
  }
  if(!['active','closed','canonicalized'].includes(session.status)
    ||!validDate(session.startedAt)||!validDate(session.updatedAt)||!validDate(session.closedAt)||!validDate(session.canonicalizedAt)
    ||!(session.canonicalRevision===null||(Number.isSafeInteger(session.canonicalRevision)&&session.canonicalRevision>=1))
    ||!Number.isSafeInteger(session.updateCount)||session.updateCount<0
    ||!Number.isSafeInteger(session.byteSize)||session.byteSize<0){
    throw new VaultError('CORRUPT','CRDT journal session metadata is invalid.');
  }
}

function validateUpdate(update:CrdtJournalUpdate):void{
  if(!update.id||update.id.length>100||!update.roomKey||update.roomKey.length>260||!update.sessionId||update.sessionId.length>320
    ||!UUID.test(update.vaultId)||!UUID.test(update.entryId)||!UUID.test(update.sourceSessionId)
    ||!['local','remote','sync'].includes(update.source)
    ||!(update.bytes instanceof Uint8Array)
    ||!Number.isSafeInteger(update.byteLength)||update.byteLength!==update.bytes.byteLength||update.byteLength<=0||update.byteLength>MAX_UPDATE_BYTES
    ||!Number.isFinite(Date.parse(update.createdAt))){
    throw new VaultError('CORRUPT','CRDT journal update is invalid.');
  }
}

export function crdtJournalRoomKey(base:CrdtJournalBase):string{
  validateBase(base);
  return [
    base.vaultId,
    base.entryId,
    base.epoch.toLowerCase(),
    String(base.baseRevision),
    base.baseFingerprint,
  ].join(':');
}

export function crdtJournalSessionId(base:CrdtJournalBase,localSessionId:string):string{
  if(!UUID.test(localSessionId)) throw new VaultError('PROTOCOL','CRDT journal local session identity is invalid.');
  return crdtJournalRoomKey(base)+':'+localSessionId.toLowerCase();
}

export class CrdtJournalStore {
  private readonly driver:LocalStorageDriver;
  constructor(database:IDBDatabase|LocalStorageDriver){
    this.driver=storageDriver(database);
  }

  async ensureSession(base:CrdtJournalBase,localSessionId:string):Promise<CrdtJournalSession>{
    validateBase(base);
    if(!UUID.test(localSessionId)) throw new VaultError('PROTOCOL','CRDT journal local session identity is invalid.');
    const roomKey=crdtJournalRoomKey(base);
    const id=crdtJournalSessionId(base,localSessionId);
    return this.driver.transaction(['crdtSessions'],'readwrite',async tx=>{
      const previous=await tx.store('crdtSessions').get<CrdtJournalSession>(id);
      if(previous){
        validateSession(previous);
        if(previous.roomKey!==roomKey||previous.baseText!==base.baseText||previous.status==='canonicalized') {
          throw new VaultError('PROTOCOL','CRDT journal session identity cannot be reused for another canonical state.');
        }
        if(previous.status==='closed'){
          const reopened={...previous,status:'active' as const,closedAt:null,updatedAt:new Date().toISOString()};
          await tx.store('crdtSessions').put(reopened);
          return reopened;
        }
        return previous;
      }
      const timestamp=new Date().toISOString();
      const session:CrdtJournalSession={
        ...base,
        id,
        roomKey,
        localSessionId:localSessionId.toLowerCase(),
        status:'active',
        startedAt:timestamp,
        updatedAt:timestamp,
        closedAt:null,
        canonicalRevision:null,
        canonicalizedAt:null,
        updateCount:0,
        byteSize:0,
      };
      validateSession(session);
      await tx.store('crdtSessions').add(session);
      return session;
    });
  }

  async append(sessionId:string,input:CrdtJournalAppend):Promise<CrdtJournalUpdate>{
    if(!sessionId||sessionId.length>320||!UUID.test(input.sourceSessionId)
      ||!['local','remote','sync'].includes(input.source)
      ||!(input.bytes instanceof Uint8Array)||input.bytes.byteLength<=0||input.bytes.byteLength>MAX_UPDATE_BYTES){
      throw new VaultError('PROTOCOL','CRDT journal append is invalid.');
    }
    return this.driver.transaction(['crdtSessions','crdtUpdates'],'readwrite',async tx=>{
      const session=await tx.store('crdtSessions').get<CrdtJournalSession>(sessionId);
      if(!session) throw new VaultError('NOT_FOUND','CRDT journal session is unavailable.');
      validateSession(session);
      if(session.status!=='active') throw new VaultError('STALE_WRITE','CRDT journal session is no longer active.');
      if(session.byteSize+input.bytes.byteLength>MAX_ACTIVE_ROOM_BYTES){
        throw new VaultError('STORAGE','Live collaboration journal exceeded its 16 MiB safety limit. Synchronize or reopen the note before continuing live editing.');
      }
      const timestamp=new Date().toISOString();
      const update:CrdtJournalUpdate={
        id:crypto.randomUUID(),
        roomKey:session.roomKey,
        sessionId:session.id,
        vaultId:session.vaultId,
        entryId:session.entryId,
        source:input.source,
        sourceSessionId:input.sourceSessionId.toLowerCase(),
        bytes:input.bytes.slice(),
        byteLength:input.bytes.byteLength,
        createdAt:timestamp,
      };
      validateUpdate(update);
      await tx.store('crdtUpdates').add(update);
      const next:CrdtJournalSession={
        ...session,
        updateCount:session.updateCount+1,
        byteSize:session.byteSize+update.byteLength,
        updatedAt:timestamp,
      };
      await tx.store('crdtSessions').put(next);
      return update;
    });
  }

  async replay(base:CrdtJournalBase):Promise<CrdtJournalReplay>{
    const roomKey=crdtJournalRoomKey(base);
    const [sessions,updates]=await this.driver.transaction(['crdtSessions','crdtUpdates'],'readonly',async tx=>[
      await tx.store('crdtSessions').allFromIndex<CrdtJournalSession>('roomKey',roomKey),
      await tx.store('crdtUpdates').allFromIndex<CrdtJournalUpdate>('roomKey',roomKey),
    ]);
    for(const session of sessions) validateSession(session);
    for(const update of updates) validateUpdate(update);
    const activeSessions=sessions.filter(session=>
      session.status!=='canonicalized'
      && session.vaultId===base.vaultId
      && session.entryId===base.entryId
      && session.ownerId===base.ownerId
      && session.epoch===base.epoch
      && session.baseRevision===base.baseRevision
      && session.baseFingerprint===base.baseFingerprint
      && session.baseText===base.baseText
    );
    const activeIds=new Set(activeSessions.map(session=>session.id));
    const activeUpdates=updates
      .filter(update=>activeIds.has(update.sessionId))
      .sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
    return {
      sessions:activeSessions.sort((a,b)=>a.startedAt.localeCompare(b.startedAt)||a.id.localeCompare(b.id)),
      updates:activeUpdates,
      byteSize:activeUpdates.reduce((total,update)=>total+update.byteLength,0),
    };
  }

  async close(sessionId:string):Promise<void>{
    await this.driver.transaction(['crdtSessions'],'readwrite',async tx=>{
      const session=await tx.store('crdtSessions').get<CrdtJournalSession>(sessionId);
      if(!session) return;
      validateSession(session);
      if(session.status!=='active') return;
      const timestamp=new Date().toISOString();
      await tx.store('crdtSessions').put({...session,status:'closed',closedAt:timestamp,updatedAt:timestamp});
    });
  }

  async canonicalizeRoom(base:CrdtJournalBase,canonicalRevision:number):Promise<void>{
    if(!Number.isSafeInteger(canonicalRevision)||canonicalRevision<=base.baseRevision){
      throw new VaultError('PROTOCOL','CRDT journal canonical revision must advance the room base.');
    }
    const roomKey=crdtJournalRoomKey(base);
    await this.driver.transaction(['crdtSessions'],'readwrite',async tx=>{
      const sessions=await tx.store('crdtSessions').allFromIndex<CrdtJournalSession>('roomKey',roomKey);
      const timestamp=new Date().toISOString();
      for(const session of sessions){
        validateSession(session);
        if(session.status==='canonicalized' || session.baseText!==base.baseText
          || session.ownerId!==base.ownerId || session.epoch!==base.epoch) continue;
        await tx.store('crdtSessions').put({
          ...session,
          status:'canonicalized',
          canonicalRevision,
          canonicalizedAt:timestamp,
          closedAt:session.closedAt??timestamp,
          updatedAt:timestamp,
        });
      }
    });
  }

  async listHistory(vaultId:VaultId,entryId?:EntryId):Promise<CrdtJournalSession[]>{
    const rows=await this.driver.transaction(['crdtSessions'],'readonly',tx=>
      tx.store('crdtSessions').allFromIndex<CrdtJournalSession>(entryId?'entryId':'vaultId',entryId??vaultId)
    );
    const filtered=entryId?rows.filter(row=>row.vaultId===vaultId):rows;
    for(const row of filtered) validateSession(row);
    return filtered.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
  }

  async replaySession(sessionId:string):Promise<CrdtJournalUpdate[]>{
    const session=await this.driver.transaction(['crdtSessions'],'readonly',tx=>tx.store('crdtSessions').get<CrdtJournalSession>(sessionId));
    if(!session) throw new VaultError('NOT_FOUND','CRDT collaboration session was not found.');
    validateSession(session);
    const [sessions,rows]=await this.driver.transaction(['crdtSessions','crdtUpdates'],'readonly',async tx=>[
      await tx.store('crdtSessions').allFromIndex<CrdtJournalSession>('roomKey',session.roomKey),
      await tx.store('crdtUpdates').allFromIndex<CrdtJournalUpdate>('roomKey',session.roomKey),
    ]);
    for(const candidate of sessions) validateSession(candidate);
    for(const row of rows) validateUpdate(row);
    const compatibleIds=new Set(sessions
      .filter(candidate=>
        candidate.baseText===session.baseText
        && candidate.ownerId===session.ownerId
        && candidate.epoch===session.epoch
        && candidate.baseRevision===session.baseRevision
        && candidate.baseFingerprint===session.baseFingerprint
      )
      .map(candidate=>candidate.id));
    return rows
      .filter(row=>compatibleIds.has(row.sessionId))
      .sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
  }

  async prune(
    vaultId:VaultId,
    nowMs=Date.now(),
    retentionMs=DEFAULT_RETENTION_MS,
    maxVaultBytes=DEFAULT_MAX_VAULT_BYTES,
  ):Promise<{sessions:number;updates:number;bytes:number}>{
    const sessions=await this.driver.transaction(['crdtSessions'],'readonly',tx=>tx.store('crdtSessions').allFromIndex<CrdtJournalSession>('vaultId',vaultId));
    const updates=await this.driver.transaction(['crdtUpdates'],'readonly',tx=>tx.store('crdtUpdates').allFromIndex<CrdtJournalUpdate>('vaultId',vaultId));
    for(const session of sessions) validateSession(session);
    for(const update of updates) validateUpdate(update);

    const updateBytes=new Map<string,number>();
    for(const update of updates) updateBytes.set(update.sessionId,(updateBytes.get(update.sessionId)??0)+update.byteLength);
    const total=updates.reduce((sum,row)=>sum+row.byteLength,0);
    let remaining=total;
    const deletable=sessions
      .filter(session=>session.status==='canonicalized')
      .sort((a,b)=>(a.canonicalizedAt??a.updatedAt).localeCompare(b.canonicalizedAt??b.updatedAt));

    const remove=new Set<string>();
    for(const session of deletable){
      const age=nowMs-Date.parse(session.canonicalizedAt??session.updatedAt);
      if(age<=retentionMs && remaining<=maxVaultBytes) continue;
      remove.add(session.id);
      remaining-=updateBytes.get(session.id)??0;
    }
    if(!remove.size) return {sessions:0,updates:0,bytes:0};

    let removedUpdates=0;
    let removedBytes=0;
    await this.driver.transaction(['crdtSessions','crdtUpdates'],'readwrite',async tx=>{
      for(const update of updates){
        if(!remove.has(update.sessionId)) continue;
        await tx.store('crdtUpdates').delete(update.id);
        removedUpdates++;
        removedBytes+=update.byteLength;
      }
      for(const id of remove) await tx.store('crdtSessions').delete(id);
    });
    return {sessions:remove.size,updates:removedUpdates,bytes:removedBytes};
  }
}
