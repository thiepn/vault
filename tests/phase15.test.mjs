import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalRepository } from '../build/core/storage/local-repository.js';
import { SyncLocalState } from '../build/core/sync/local-state.js';
import { SyncReplicaStore } from '../build/core/sync/replica-store.js';
import { SyncEngine } from '../build/core/sync/engine.js';
import { decodeOperation, sealOperation } from '../build/core/sync/protocol.js';
import { validateRemotePage, validateRemoteSnapshot } from '../build/core/sync/remote-types.js';
import { sha256Hex } from '../build/core/storage/blob-store.js';

class MemoryStore {
  constructor(data,name){ this.data=data; this.name=name; }
  key(value){
    if(this.name==='vaults'||this.name==='entries'||this.name==='outbox') return value.id;
    if(this.name==='contents'||this.name==='attachments'||this.name==='dirty'||this.name==='remoteShadows') return value.entryId;
    if(this.name==='syncCursors') return value.vaultId;
    if(this.name==='revisions'||this.name==='drafts') return value.id;
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

function cloneSnapshot(value){ return structuredClone(value); }

class FakeRemote {
  constructor(vaultId,epoch){
    this.vaultId=vaultId;
    this.epoch=epoch;
    this.entries=new Map();
    this.events=[];
    this.operations=new Map();
    this.blobs=new Map();
    this.uploadCount=0;
    this.downloadCount=0;
    this.onPushCommitted=null;
  }
  emit(operationId,deviceId,kind,snapshot){
    const sequence=String(this.events.length+1);
    this.events.push({
      sequence,operationId,entryId:snapshot.entryId,revision:snapshot.revision,kind,deviceId,snapshot:cloneSnapshot(snapshot),
    });
    return sequence;
  }
  async pull(vaultId,epoch,after,limit=500){
    assert.equal(vaultId,this.vaultId);
    assert.equal(epoch,this.epoch);
    const start=Number(after);
    const selected=this.events.slice(start,start+limit);
    const through=selected.length ? selected[selected.length-1].sequence : after;
    return {
      protocolVersion:1,vaultId,epoch,after,through,
      highWatermark:String(this.events.length),
      events:cloneSnapshot(selected),
    };
  }
  async uploadBlob(ownerId,vaultId,sha256,mimeType,bytes){
    assert.equal(vaultId,this.vaultId);
    assert.equal(await sha256Hex(bytes),sha256);
    this.blobs.set(ownerId+'/'+vaultId+'/'+sha256,{bytes:bytes.slice(),mimeType});
    this.uploadCount++;
  }
  async downloadBlob(ownerId,vaultId,sha256){
    const row=this.blobs.get(ownerId+'/'+vaultId+'/'+sha256);
    if(!row) throw new Error('missing fake remote blob');
    this.downloadCount++;
    return row.bytes.slice();
  }
  conflict(entryId,reason='revision'){
    const current=this.entries.get(entryId);
    return {status:'conflict',reason,entryId,current:current?cloneSnapshot(current):null};
  }
  async push(sealed){
    const operation=decodeOperation(sealed.wire);
    assert.equal(operation.vaultId,this.vaultId);
    const existing=this.operations.get(operation.id);
    if(existing){
      assert.equal(existing.sha256,sealed.sha256);
      return cloneSnapshot(existing.result);
    }
    const snapshots=[];
    let through=String(this.events.length);
    for(const mutation of operation.mutations){
      let current=this.entries.get(mutation.entryId);
      if(mutation.kind==='create'){
        if(current) return this.conflict(mutation.entryId,'exists');
        if(mutation.parentId){
          const parent=this.entries.get(mutation.parentId);
          if(!parent || parent.kind!=='directory' || parent.deletedAt!==null) return this.conflict(mutation.entryId,'path');
        }
        if([...this.entries.values()].some(row=>row.deletedAt===null && row.parentId===mutation.parentId && row.name.toLowerCase()===mutation.name.toLowerCase())){
          return this.conflict(mutation.entryId,'path');
        }
        let attachmentSha256=null,attachmentMimeType=null,attachmentSize=null;
        if(mutation.entryKind==='attachment'){
          const ref=mutation.attachment;
          const blob=this.blobs.get(operation.ownerId+'/'+operation.vaultId+'/'+ref.sha256);
          if(!blob) throw new Error('blob not uploaded before create');
          attachmentSha256=ref.sha256; attachmentMimeType=ref.mimeType; attachmentSize=ref.size;
        }
        current={
          entryId:mutation.entryId,vaultId:this.vaultId,parentId:mutation.parentId,name:mutation.name,
          kind:mutation.entryKind,revision:1,deletedAt:null,updatedAt:iso(),updatedByDevice:operation.deviceId,
          text:mutation.entryKind==='markdown'?mutation.text:null,
          attachmentSha256,attachmentMimeType,attachmentSize,
        };
      } else {
        if(!current || current.revision!==mutation.baseRevision) return this.conflict(mutation.entryId,'revision');
        current={...current,revision:current.revision+1,updatedAt:iso(),updatedByDevice:operation.deviceId};
        if(mutation.kind==='write') current.text=mutation.text;
        if(mutation.kind==='move'){ current.parentId=mutation.parentId; current.name=mutation.name; }
        if(mutation.kind==='trash') current.deletedAt=iso();
        if(mutation.kind==='restore') current.deletedAt=null;
      }
      this.entries.set(mutation.entryId,cloneSnapshot(current));
      through=this.emit(operation.id,operation.deviceId,mutation.kind,current);
      snapshots.push(cloneSnapshot(current));
    }
    const result={status:'ok',operationId:operation.id,through,snapshots};
    this.operations.set(operation.id,{sha256:sealed.sha256,result:cloneSnapshot(result)});
    if(this.onPushCommitted){
      const hook=this.onPushCommitted;
      this.onPushCommitted=null;
      await hook(operation,result);
    }
    return result;
  }
  remoteWrite(entryId,text,deviceId=crypto.randomUUID()){
    const current=this.entries.get(entryId);
    if(!current || current.kind!=='markdown') throw new Error('remote note missing');
    const snapshot={...current,text,revision:current.revision+1,updatedAt:iso(),updatedByDevice:deviceId};
    this.entries.set(entryId,cloneSnapshot(snapshot));
    this.emit(crypto.randomUUID(),deviceId,'write',snapshot);
    return snapshot;
  }
}

async function makeCloudVault(driver,{vaultId=null,ownerId=crypto.randomUUID(),deviceId=crypto.randomUUID(),epoch=crypto.randomUUID(),name='Cloud'}={}){
  const repo=new LocalRepository(driver);
  let vault;
  if(vaultId){
    vault={
      id:vaultId,name,createdAt:iso(),updatedAt:iso(),mode:'cloud',
      cloud:{accountId:crypto.randomUUID(),authUserId:ownerId,projectRef:'test',remoteVaultId:vaultId,epoch,protocolVersion:1,deviceId,adoptedAt:iso()},
    };
    await driver.transaction(['vaults'],'readwrite',tx=>tx.store('vaults').add(vault));
  } else {
    const local=await repo.createVault(name);
    vault=await repo.adoptCloud(local.id,{
      accountId:crypto.randomUUID(),authUserId:ownerId,projectRef:'test',remoteVaultId:local.id,epoch,protocolVersion:1,deviceId,adoptedAt:iso(),
    });
  }
  const state=new SyncLocalState(driver);
  const replica=new SyncReplicaStore(driver);
  const remote=null;
  return {repo,vault,state,replica,ownerId,deviceId,epoch,remote};
}

test('Phase 15 validates remote snapshots/pages and attachment operation envelopes',async()=>{
  const vaultId=crypto.randomUUID();
  const deviceId=crypto.randomUUID();
  const entryId=crypto.randomUUID();
  const snapshot={
    entryId,vaultId,parentId:null,name:'pic.png',kind:'attachment',revision:1,deletedAt:null,
    updatedAt:iso(),updatedByDevice:deviceId,text:null,
    attachmentSha256:'a'.repeat(64),attachmentMimeType:'image/png',attachmentSize:3,
  };
  assert.equal(validateRemoteSnapshot(snapshot,vaultId).attachmentSize,3);
  assert.throws(()=>validateRemoteSnapshot({...snapshot,attachmentSha256:'bad'},vaultId),/attachment metadata/);
  const operation={
    protocolVersion:1,id:crypto.randomUUID(),vaultId,deviceId,ownerId:crypto.randomUUID(),
    mutations:[{kind:'create',entryId,parentId:null,name:'pic.png',entryKind:'attachment',text:'',attachment:{sha256:'a'.repeat(64),mimeType:'image/png',size:3}}],
  };
  const sealed=await sealOperation(operation);
  assert.equal(decodeOperation(sealed.wire).mutations[0].entryKind,'attachment');
  assert.throws(()=>validateRemotePage({
    protocolVersion:1,vaultId,epoch:crypto.randomUUID(),after:'0',through:'2',highWatermark:'2',
    events:[{sequence:'2',operationId:operation.id,entryId,revision:1,kind:'create',deviceId,snapshot}],
  },{vaultId,epoch:crypto.randomUUID(),after:'0'}),/does not match|gap/);
});

test('Phase 15 initial local note upload is pull-before-push and leaves no dirty/outbox residue',async()=>{
  const driver=new MemoryDriver();
  const context=await makeCloudVault(driver);
  const note=await context.repo.createEntry(context.vault.id,null,'First','markdown','# First');
  const remote=new FakeRemote(context.vault.id,context.epoch);
  const engine=new SyncEngine(remote,context.state,context.replica,context.repo);
  const summary=await engine.sync(context.vault,context.ownerId);
  assert.equal(remote.entries.get(note.id).text,'# First');
  assert.equal(summary.pushedOperations,1);
  assert.equal(summary.pulledEvents,1);
  assert.equal(await context.state.count(context.vault.id),0);
  assert.equal(await context.state.isDirty(note.id),false);
  assert.equal((await context.state.cursor(context.vault.id,context.ownerId)).cursor,'1');
});

test('Phase 15 clean remote Markdown edit is pulled into canonical local note',async()=>{
  const driver=new MemoryDriver();
  const context=await makeCloudVault(driver);
  const note=await context.repo.createEntry(context.vault.id,null,'Shared','markdown','local v1');
  const remote=new FakeRemote(context.vault.id,context.epoch);
  const engine=new SyncEngine(remote,context.state,context.replica,context.repo);
  await engine.sync(context.vault,context.ownerId);
  remote.remoteWrite(note.id,'remote v2');
  const summary=await engine.sync(context.vault,context.ownerId);
  assert.equal((await context.repo.read(note.id)).content.text,'remote v2');
  assert.equal(summary.pulledEvents,1);
  assert.equal(await context.state.isDirty(note.id),false);
});

test('Phase 15 concurrent Markdown edit preserves the local side as a conflict copy',async()=>{
  const driver=new MemoryDriver();
  const context=await makeCloudVault(driver);
  const note=await context.repo.createEntry(context.vault.id,null,'Conflict','markdown','base');
  const remote=new FakeRemote(context.vault.id,context.epoch);
  const engine=new SyncEngine(remote,context.state,context.replica,context.repo);
  await engine.sync(context.vault,context.ownerId);
  const current=await context.repo.read(note.id);
  await context.repo.saveMarkdown(note.id,'local concurrent',current.entry.localVersion);
  remote.remoteWrite(note.id,'remote concurrent');
  const summary=await engine.sync(context.vault,context.ownerId);
  const entries=await context.repo.listEntries(context.vault.id);
  const notes=[];
  for(const entry of entries.filter(e=>e.kind==='markdown')){
    notes.push({entry,text:(await context.repo.read(entry.id)).content.text});
  }
  assert.equal((await context.repo.read(note.id)).content.text,'remote concurrent');
  assert.ok(notes.some(item=>item.entry.id!==note.id && /conflict/u.test(item.entry.name) && item.text==='local concurrent'));
  assert.equal(summary.conflictsPreserved,1);
  assert.equal(await context.state.count(context.vault.id),0);
});

test('Phase 15 newer local edit after an old push is not misclassified as remote conflict',async()=>{
  const driver=new MemoryDriver();
  const context=await makeCloudVault(driver);
  const note=await context.repo.createEntry(context.vault.id,null,'Race','markdown','v1');
  const remote=new FakeRemote(context.vault.id,context.epoch);
  const engine=new SyncEngine(remote,context.state,context.replica,context.repo);
  remote.onPushCommitted=async()=>{
    const current=await context.repo.read(note.id);
    await context.repo.saveMarkdown(note.id,'v2 after push',current.entry.localVersion);
  };
  const summary=await engine.sync(context.vault,context.ownerId);
  assert.equal(remote.entries.get(note.id).text,'v2 after push');
  assert.equal((await context.repo.read(note.id)).content.text,'v2 after push');
  assert.equal(summary.conflictsPreserved,0);
  assert.equal(await context.state.count(context.vault.id),0);
});

test('Phase 15 attachment blob uploads once and downloads onto another clean device',async()=>{
  const driver1=new MemoryDriver();
  const context1=await makeCloudVault(driver1);
  const attachment=await context1.repo.createAttachment(context1.vault.id,null,'pixel.bin','application/octet-stream',Uint8Array.from([1,2,3,4]));
  const remote=new FakeRemote(context1.vault.id,context1.epoch);
  const engine1=new SyncEngine(remote,context1.state,context1.replica,context1.repo);
  await engine1.sync(context1.vault,context1.ownerId);
  assert.equal(remote.uploadCount,1);
  assert.equal(remote.entries.get(attachment.id).attachmentSize,4);

  const driver2=new MemoryDriver();
  const context2=await makeCloudVault(driver2,{
    vaultId:context1.vault.id,
    ownerId:context1.ownerId,
    deviceId:crypto.randomUUID(),
    epoch:context1.epoch,
    name:'Cloud',
  });
  const engine2=new SyncEngine(remote,context2.state,context2.replica,context2.repo);
  const summary=await engine2.sync(context2.vault,context2.ownerId);
  const bytes=await context2.repo.readAttachment(attachment.id);
  assert.deepEqual([...bytes.bytes],[1,2,3,4]);
  assert.equal(summary.downloadedBlobs,1);
  assert.equal(remote.downloadCount,1);
});
