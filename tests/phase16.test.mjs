import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalRepository } from '../build/core/storage/local-repository.js';
import { SyncLocalState } from '../build/core/sync/local-state.js';
import { SyncReplicaStore } from '../build/core/sync/replica-store.js';
import { SyncEngine } from '../build/core/sync/engine.js';
import { compareVersions } from '../build/core/sync/merge.js';
import { SyncCoordinator } from '../build/core/sync/coordinator.js';
import { decodeOperation } from '../build/core/sync/protocol.js';

class MemoryStore {
  constructor(data,name){ this.data=data; this.name=name; }
  key(value){
    if(this.name==='vaults'||this.name==='entries'||this.name==='outbox') return value.id;
    if(this.name==='contents'||this.name==='attachments'||this.name==='dirty'||this.name==='remoteShadows') return value.entryId;
    if(this.name==='syncCursors') return value.vaultId;
    return value.id ?? value.entryId ?? value.key;
  }
  async get(key){ return structuredClone(this.data.get(key)); }
  async getAll(){ return [...this.data.values()].map(value=>structuredClone(value)); }
  async fromIndex(index,key){ return structuredClone([...this.data.values()].find(value=>value[index]===key)); }
  async allFromIndex(index,key){ return [...this.data.values()].filter(value=>value[index]===key).map(value=>structuredClone(value)); }
  async add(value){ const key=this.key(value); if(this.data.has(key)) throw new Error('duplicate '+this.name); this.data.set(key,structuredClone(value)); }
  async put(value){ this.data.set(this.key(value),structuredClone(value)); }
  async delete(key){ this.data.delete(key); }
}
class MemoryDriver {
  constructor(){
    this.stores=new Map(['vaults','entries','contents','attachments','dirty','outbox','revisions','drafts','remoteShadows','syncCursors'].map(name=>[name,new Map()]));
  }
  async transaction(names,mode,body){
    const working=new Map([...this.stores].map(([name,data])=>[
      name,
      mode==='readwrite' && names.includes(name)
        ? new Map([...data].map(([key,value])=>[key,structuredClone(value)]))
        : data,
    ]));
    const result=await body({store:name=>new MemoryStore(working.get(name),name)});
    if(mode==='readwrite') for(const name of names) this.stores.set(name,working.get(name));
    return result;
  }
}
const iso=()=>new Date().toISOString();

class MarkdownRemote {
  constructor(vaultId,epoch){
    this.vaultId=vaultId; this.epoch=epoch; this.entries=new Map(); this.events=[]; this.operations=new Map();
  }
  emit(operationId,deviceId,kind,snapshot){
    const sequence=String(this.events.length+1);
    this.events.push({sequence,operationId,entryId:snapshot.entryId,revision:snapshot.revision,kind,deviceId,snapshot:structuredClone(snapshot)});
  }
  async pull(vaultId,epoch,after,limit=500){
    assert.equal(vaultId,this.vaultId); assert.equal(epoch,this.epoch);
    const selected=this.events.slice(Number(after),Number(after)+limit);
    const through=selected.length ? selected[selected.length-1].sequence : after;
    return {protocolVersion:1,vaultId,epoch,after,through,highWatermark:String(this.events.length),events:structuredClone(selected)};
  }
  async uploadBlob(){ throw new Error('unexpected blob upload'); }
  async downloadBlob(){ throw new Error('unexpected blob download'); }
  async push(sealed){
    const op=decodeOperation(sealed.wire);
    const previous=this.operations.get(op.id);
    if(previous) return structuredClone(previous);
    const snapshots=[];
    let through=String(this.events.length);
    for(const mutation of op.mutations){
      let current=this.entries.get(mutation.entryId);
      if(mutation.kind==='create'){
        if(current) return {status:'conflict',reason:'exists',entryId:mutation.entryId,current:structuredClone(current)};
        current={
          entryId:mutation.entryId,vaultId:this.vaultId,parentId:mutation.parentId,name:mutation.name,
          kind:mutation.entryKind,revision:1,deletedAt:null,updatedAt:iso(),updatedByDevice:op.deviceId,
          text:mutation.text,attachmentSha256:null,attachmentMimeType:null,attachmentSize:null,
        };
      } else {
        if(!current || current.revision!==mutation.baseRevision) return {status:'conflict',reason:'revision',entryId:mutation.entryId,current:current?structuredClone(current):null};
        current={...current,revision:current.revision+1,updatedAt:iso(),updatedByDevice:op.deviceId};
        if(mutation.kind==='write') current.text=mutation.text;
        if(mutation.kind==='move'){ current.parentId=mutation.parentId; current.name=mutation.name; }
        if(mutation.kind==='trash') current.deletedAt=iso();
        if(mutation.kind==='restore') current.deletedAt=null;
      }
      this.entries.set(mutation.entryId,structuredClone(current));
      this.emit(op.id,op.deviceId,mutation.kind,current);
      through=String(this.events.length);
      snapshots.push(structuredClone(current));
    }
    const result={status:'ok',operationId:op.id,through,snapshots};
    this.operations.set(op.id,structuredClone(result));
    return result;
  }
  remoteWrite(entryId,text){
    const current=this.entries.get(entryId);
    const snapshot={...current,text,revision:current.revision+1,updatedAt:iso(),updatedByDevice:crypto.randomUUID()};
    this.entries.set(entryId,structuredClone(snapshot));
    this.emit(crypto.randomUUID(),snapshot.updatedByDevice,'write',snapshot);
  }
}

async function cloudContext(){
  const driver=new MemoryDriver();
  const repo=new LocalRepository(driver);
  const local=await repo.createVault('Cloud');
  const ownerId=crypto.randomUUID(), deviceId=crypto.randomUUID(), epoch=crypto.randomUUID();
  const vault=await repo.adoptCloud(local.id,{
    accountId:crypto.randomUUID(),authUserId:ownerId,projectRef:'test',remoteVaultId:local.id,
    epoch,protocolVersion:1,deviceId,adoptedAt:iso(),
  });
  const state=new SyncLocalState(driver);
  const replica=new SyncReplicaStore(driver);
  const remote=new MarkdownRemote(vault.id,epoch);
  const engine=new SyncEngine(remote,state,replica,repo);
  return {repo,vault,ownerId,remote,engine};
}

test('Phase 16 diff3 merges independent Markdown regions and rejects overlapping edits',()=>{
  const base='# Note\n\nAlpha\n\nOmega\n';
  const merged=compareVersions(base,'# Note\n\nAlpha local\n\nOmega\n','# Note\n\nAlpha\n\nOmega remote\n');
  assert.equal(merged.kind,'resolved');
  assert.equal(merged.reason,'non-overlapping');
  assert.equal(merged.text,'# Note\n\nAlpha local\n\nOmega remote\n');
  assert.equal(compareVersions(base,'# Note\n\nAlpha local\n\nOmega\n','# Note\n\nAlpha remote\n\nOmega\n').kind,'conflict');
});

test('Phase 16 concurrent independent edits converge without a conflict copy',async()=>{
  const c=await cloudContext();
  const note=await c.repo.createEntry(c.vault.id,null,'Shared','markdown','one\ntwo\nthree\n');
  await c.engine.sync(c.vault,c.ownerId);
  const current=await c.repo.read(note.id);
  await c.repo.saveMarkdown(note.id,'one local\ntwo\nthree\n',current.entry.localVersion);
  c.remote.remoteWrite(note.id,'one\ntwo\nthree remote\n');
  const summary=await c.engine.sync(c.vault,c.ownerId);
  assert.equal(summary.autoMergedMarkdown,1);
  assert.equal(summary.conflictsPreserved,0);
  assert.equal((await c.repo.read(note.id)).content.text,'one local\ntwo\nthree remote\n');
  assert.equal(c.remote.entries.get(note.id).text,'one local\ntwo\nthree remote\n');
  const entries=await c.repo.listEntries(c.vault.id);
  assert.equal(entries.filter(entry=>/conflict/u.test(entry.name)).length,0);
});

test('Phase 16 overlapping Markdown edits still preserve a conflict copy',async()=>{
  const c=await cloudContext();
  const note=await c.repo.createEntry(c.vault.id,null,'Overlap','markdown','same\n');
  await c.engine.sync(c.vault,c.ownerId);
  const current=await c.repo.read(note.id);
  await c.repo.saveMarkdown(note.id,'local\n',current.entry.localVersion);
  c.remote.remoteWrite(note.id,'remote\n');
  const summary=await c.engine.sync(c.vault,c.ownerId);
  assert.equal(summary.autoMergedMarkdown,0);
  assert.equal(summary.conflictsPreserved,1);
  assert.equal((await c.repo.read(note.id)).content.text,'remote\n');
  const entries=await c.repo.listEntries(c.vault.id);
  assert.equal(entries.filter(entry=>/conflict/u.test(entry.name)).length,1);
});

test('Phase 16 sync coordinator coalesces requests and never overlaps runs',async()=>{
  let runs=0, active=0, maxActive=0;
  let release;
  const gate=new Promise(resolve=>{ release=resolve; });
  const coordinator=new SyncCoordinator({
    eligible:()=>true,
    key:()=> 'account:vault:epoch',
    intervalMs:60_000,
    debounceMs:0,
    lock:async (_key,body)=>({acquired:true,value:await body()}),
    run:async()=>{
      runs++; active++; maxActive=Math.max(maxActive,active);
      if(runs===1) await gate;
      active--;
    },
  });
  coordinator.start();
  coordinator.request('local-change',0);
  await new Promise(resolve=>setTimeout(resolve,10));
  coordinator.request('online',0);
  coordinator.request('focus',0);
  release();
  await new Promise(resolve=>setTimeout(resolve,30));
  coordinator.stop();
  assert.equal(maxActive,1);
  assert.equal(runs,2);
});
