import test from 'node:test';
import assert from 'node:assert/strict';
import { VaultCryptoContext } from '../build/core/crypto/context.js';
import { sha256 } from '../build/core/crypto/primitives.js';
import { EncryptedSyncEngineV2 } from '../build/core/sync/engine-v2.js';
import { SyncLocalStateV2 } from '../build/core/sync/local-state-v2.js';
import { EncryptedReplicaStoreV2 } from '../build/core/sync/replica-store-v2.js';
import { LocalRepository } from '../build/core/storage/local-repository.js';

const vaultId='22222222-2222-4222-8222-222222222222';
const accountId='11111111-1111-4111-8111-111111111111';
const authUserId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deviceId='33333333-3333-4333-8333-333333333333';
const epoch='44444444-4444-4444-8444-444444444444';
const folderId='019c0000-0000-7000-8000-000000000100';
const noteId='019c0000-0000-7000-8000-000000000001';
const attachmentId='019c0000-0000-7000-8000-000000000002';
const now='2026-09-26T02:00:00.000Z';

function clone(value){return value===undefined?undefined:structuredClone(value);}
function keyFor(store,value){
  switch(store){
    case 'vaults': case 'entries': case 'outbox': case 'revisions': case 'drafts':
    case 'migrationState': case 'backgroundRuntime': case 'remoteInbox': case 'conflicts':
    case 'syncConflicts': case 'entities': return value.id;
    case 'syncBootstrap': return value.vaultId;
    case 'contents': case 'attachments': case 'dirty': case 'remoteShadows': return value.entryId;
    case 'syncCursors': return value.vaultId;
    case 'settings': return value.key;
    case 'noteBodies': return value.noteId;
    case 'blobPayloads': return value.hash;
    case 'knowledge': return value.entryId;
    default: return value.id ?? value.key;
  }
}
function indexValue(value,index){
  if(index==='vaultId') return value.vaultId;
  if(index==='activeKey') return value.activeKey;
  if(index==='entryId') return value.entryId;
  if(index==='sourceNoteId') return value.sourceNoteId;
  if(index==='entityType') return value.entityType;
  if(index==='status') return value.status;
  if(index==='accountId') return value.accountId;
  if(index==='vaultEntry') return [value.vaultId,value.entryId];
  return value[index];
}
class MemoryStore{
  constructor(data,name){this.data=data;this.name=name;}
  async get(key){return clone(this.data.get(key));}
  async getAll(){return [...this.data.values()].map(value=>clone(value));}
  async fromIndex(index,key){
    const row=[...this.data.values()].find(value=>{
      const actual=indexValue(value,index);
      return Array.isArray(actual)?JSON.stringify(actual)===JSON.stringify(key):actual===key;
    });
    return clone(row);
  }
  async allFromIndex(index,key){
    return [...this.data.values()].filter(value=>{
      const actual=indexValue(value,index);
      return Array.isArray(actual)?JSON.stringify(actual)===JSON.stringify(key):actual===key;
    }).map(value=>clone(value));
  }
  async add(value){
    const key=keyFor(this.name,value);
    if(this.data.has(key))throw new Error('duplicate '+this.name);
    if(this.name==='entries'&&value.activeKey){
      const collision=[...this.data.values()].find(row=>row.activeKey===value.activeKey);
      if(collision)throw new Error('duplicate activeKey');
    }
    this.data.set(key,clone(value));
  }
  async put(value){
    const key=keyFor(this.name,value);
    if(this.name==='entries'&&value.activeKey){
      const collision=[...this.data.entries()].find(([id,row])=>id!==key&&row.activeKey===value.activeKey);
      if(collision)throw new Error('duplicate activeKey');
    }
    this.data.set(key,clone(value));
  }
  async delete(key){this.data.delete(key);}
}
class MemoryDriver{
  constructor(){
    this.stores=new Map([
      'vaults','entries','contents','attachments','dirty','outbox','revisions','drafts','settings',
      'remoteShadows','syncCursors','knowledge','entities','noteBodies','blobPayloads','migrationState',
      'backgroundRuntime','remoteInbox','conflicts','syncConflicts','syncBootstrap',
    ].map(name=>[name,new Map()]));
  }
  async transaction(names,mode,body){
    const working=new Map([...this.stores].map(([name,data])=>[
      name,
      mode==='readwrite'&&names.includes(name)
        ?new Map([...data].map(([key,value])=>[key,clone(value)]))
        :data,
    ]));
    const result=await body({store:name=>new MemoryStore(working.get(name),name)});
    if(mode==='readwrite')for(const name of names)this.stores.set(name,working.get(name));
    return result;
  }
}
function cloudVault(){
  return {
    id:vaultId,name:'Fresh encrypted Vault',createdAt:now,updatedAt:now,mode:'cloud',
    cloud:{
      accountId,authUserId,ownerAccountId:accountId,ownerAuthUserId:authUserId,
      accessRole:'owner',projectRef:'test',remoteVaultId:vaultId,epoch,
      protocolVersion:2,deviceId,adoptedAt:now,
    },
  };
}

async function encryptedSnapshot(input){
  const {
    context,entityId,entityType,parentId=null,name,sequence,remoteRevision='1',
    text=null,mimeType='application/octet-stream',bytes=null,updatedAt=now,
  }=input;
  const canonicalParent=parentId;
  const nameToken=await context.nameToken(canonicalParent,name);
  let blobId=null;
  let payload;
  if(entityType==='note'){
    payload={format:'vault/entity-payload/v1',version:1,entityType:'note',name,createdAt:now,updatedAt,deletedAt:null,text};
  }else if(entityType==='folder'){
    payload={format:'vault/entity-payload/v1',version:1,entityType:'folder',name,createdAt:now,updatedAt,deletedAt:null};
  }else{
    const digest=await sha256(bytes);
    blobId=await context.blobId(digest);
    const hash=[...digest].map(byte=>byte.toString(16).padStart(2,'0')).join('');
    payload={
      format:'vault/entity-payload/v1',version:1,entityType:'attachment',name,
      createdAt:now,updatedAt,deletedAt:null,mimeType,size:bytes.byteLength,plaintextSha256:hash,
    };
  }
  const encrypted=await context.encryptEntity({
    entityId,entityType,schemaVersion:1,parentId:canonicalParent,nameToken,deleted:false,blobId,
    plaintext:new TextEncoder().encode(JSON.stringify(payload)),
  });
  return {
    snapshot:{
      entityId,vaultId,entityType,remoteRevision:String(remoteRevision),sequence:String(sequence),
      schemaVersion:1,
      structural:{parentId:canonicalParent,nameToken,deleted:false,blobId},
      payload:encrypted,
      operationId:'55555555-5555-4555-8555-'+String(sequence).padStart(12,'0'),
      updatedByDevice:'66666666-6666-4666-8666-666666666666',
      updatedAt,
    },
    blobId,
    plaintextBytes:bytes,
  };
}

class BootstrapTransport{
  constructor({bootstrapItems,liveEvents=[],blobObjects=new Map(),failBootstrapCall=null}){
    this.bootstrapItems=[...bootstrapItems].sort((a,b)=>a.entityId.localeCompare(b.entityId));
    this.liveEvents=liveEvents;
    this.blobObjects=blobObjects;
    this.snapshotSequence=String(Math.max(0,...bootstrapItems.map(item=>Number(item.sequence))));
    this.failBootstrapCall=failBootstrapCall;
    this.bootstrapCalls=0;
    this.beginCalls=0;
    this.downloads=0;
    this.acks=[];
  }
  async beginBootstrapV2(vault,remoteEpoch,device){
    assert.equal(vault,vaultId);assert.equal(remoteEpoch,epoch);assert.equal(device,deviceId);
    this.beginCalls++;
    return {protocolVersion:2,vaultId,epoch,snapshotSequence:this.snapshotSequence,entityCount:this.bootstrapItems.length};
  }
  async bootstrapPageV2(vault,remoteEpoch,device,snapshotSequence,afterEntityId){
    assert.equal(vault,vaultId);assert.equal(remoteEpoch,epoch);assert.equal(device,deviceId);
    assert.equal(snapshotSequence,this.snapshotSequence);
    this.bootstrapCalls++;
    if(this.failBootstrapCall===this.bootstrapCalls){
      this.failBootstrapCall=null;
      throw new Error('simulated bootstrap transport interruption');
    }
    const remaining=this.bootstrapItems.filter(item=>afterEntityId===null||item.entityId>afterEntityId);
    const items=remaining.slice(0,1);
    const more=remaining.length>items.length;
    return {
      protocolVersion:2,vaultId,epoch,snapshotSequence,
      afterEntityId,
      nextAfterEntityId:more?items.at(-1).entityId:null,
      done:!more,
      items:clone(items),
    };
  }
  async pullV2(vault,remoteEpoch,device,after,limit=500){
    assert.equal(vault,vaultId);assert.equal(remoteEpoch,epoch);assert.equal(device,deviceId);
    const selected=this.liveEvents.filter(event=>BigInt(event.sequence)>BigInt(after)).slice(0,limit);
    const high=this.liveEvents.length
      ?this.liveEvents.at(-1).sequence
      :this.snapshotSequence;
    return {
      protocolVersion:2,vaultId,epoch,after,
      through:selected.at(-1)?.sequence??after,
      highWatermark:high,
      events:clone(selected),
    };
  }
  async ackV2(vault,remoteEpoch,device,through){
    assert.equal(vault,vaultId);assert.equal(remoteEpoch,epoch);assert.equal(device,deviceId);
    this.acks.push(through);
  }
  async downloadEncryptedBlobV2(vault,blobId,keyGeneration){
    assert.equal(vault,vaultId);
    this.downloads++;
    const value=this.blobObjects.get(keyGeneration+':'+blobId);
    if(!value)throw new Error('missing encrypted blob');
    return value.slice();
  }
  async pushV2(){throw new Error('unexpected push during clean bootstrap');}
  async prepareBlobV2(){throw new Error('unexpected prepare during clean bootstrap');}
  async commitBlobV2(){throw new Error('unexpected commit during clean bootstrap');}
  async uploadEncryptedBlobV2(){throw new Error('unexpected upload during clean bootstrap');}
}

async function fixture(){
  const context1=VaultCryptoContext.generate(vaultId,1);
  const context2=VaultCryptoContext.generate(vaultId,2);
  const attachmentBytes=Uint8Array.from([7,8,9,10,11]);
  const noteBase=await encryptedSnapshot({
    context:context2,entityId:noteId,entityType:'note',parentId:folderId,name:'Note.md',
    sequence:1,text:'# base\n',
  });
  const attachment=await encryptedSnapshot({
    context:context1,entityId:attachmentId,entityType:'attachment',parentId:folderId,name:'old.bin',
    sequence:2,bytes:attachmentBytes,
  });
  const folder=await encryptedSnapshot({
    context:context2,entityId:folderId,entityType:'folder',parentId:null,name:'Folder',
    sequence:3,
  });
  const noteLive=await encryptedSnapshot({
    context:context2,entityId:noteId,entityType:'note',parentId:folderId,name:'Note.md',
    sequence:4,remoteRevision:'2',text:'# live after H\n',updatedAt:'2026-09-26T02:05:00.000Z',
  });
  const blobs=new Map();
  blobs.set('1:'+attachment.blobId,await context1.encryptBlob(attachment.blobId,attachmentBytes));
  return {
    context1,context2,attachmentBytes,blobs,
    bootstrapItems:[noteBase.snapshot,attachment.snapshot,folder.snapshot],
    liveEvents:[{
      sequence:'4',operationId:noteLive.snapshot.operationId,entityId:noteId,entityType:'note',
      remoteRevision:'2',kind:'put',snapshot:noteLive.snapshot,
    }],
  };
}

test('I8 fresh Device bootstraps fixed H across child-before-parent pages, historical keys and Attachment bytes, then tails H+1',async()=>{
  const fx=await fixture();
  const driver=new MemoryDriver();
  driver.stores.get('vaults').set(vaultId,cloudVault());
  const repository=new LocalRepository(driver);
  const state=new SyncLocalStateV2(driver);
  const replica=new EncryptedReplicaStoreV2(driver);
  const transport=new BootstrapTransport({
    bootstrapItems:fx.bootstrapItems,liveEvents:fx.liveEvents,blobObjects:fx.blobs,
  });
  const engine=new EncryptedSyncEngineV2(transport,state,replica,repository);
  try{
    const summary=await engine.sync(cloudVault(),accountId,{
      active:async()=>fx.context2,
      forGeneration:async generation=>generation===1?fx.context1:fx.context2,
    });
    assert.equal(summary.bootstrapSnapshot,'3');
    assert.equal(summary.bootstrappedEntities,3);
    assert.equal(summary.bootstrapResumed,false);
    assert.equal(summary.pulledEvents,1);
    assert.equal(summary.cursor,'4');
    assert.equal(transport.downloads,1);
    assert.equal(transport.beginCalls,1);

    const bootstrap=await state.bootstrap(vaultId,accountId);
    assert.equal(bootstrap.status,'complete');
    assert.equal(bootstrap.appliedCount,3);
    assert.equal(bootstrap.snapshotSequence,'3');
    assert.equal((await state.cursor(vaultId,accountId)).cursor,'4');

    const folder=await repository.read(folderId);
    const note=await repository.read(noteId);
    const attachment=await repository.read(attachmentId);
    assert.equal(folder.entry.kind,'directory');
    assert.equal(note.content.text,'# live after H\n');
    assert.equal(attachment.entry.parentId,folderId);
    assert.deepEqual([...attachment.attachment.bytes],[...fx.attachmentBytes]);
    assert.equal(driver.stores.get('dirty').size,0);
    assert.equal(driver.stores.get('outbox').size,0);
  }finally{
    fx.context1.destroy();fx.context2.destroy();
  }
});

test('I8 interrupted bootstrap resumes the same fixed snapshot without reapplying durable pages',async()=>{
  const fx=await fixture();
  const driver=new MemoryDriver();
  driver.stores.get('vaults').set(vaultId,cloudVault());
  const repository=new LocalRepository(driver);
  const state=new SyncLocalStateV2(driver);
  const replica=new EncryptedReplicaStoreV2(driver);
  const transport=new BootstrapTransport({
    bootstrapItems:fx.bootstrapItems,liveEvents:fx.liveEvents,blobObjects:fx.blobs,failBootstrapCall:2,
  });
  const engine=new EncryptedSyncEngineV2(transport,state,replica,repository);
  const resolver={active:async()=>fx.context2,forGeneration:async generation=>generation===1?fx.context1:fx.context2};
  try{
    await assert.rejects(()=>engine.sync(cloudVault(),accountId,resolver),/bootstrap transport interruption/);
    const failed=await state.bootstrap(vaultId,accountId);
    assert.equal(failed.status,'failed');
    assert.equal(failed.snapshotSequence,'3');
    assert.equal(failed.appliedCount,1);
    assert.equal((await state.cursor(vaultId,accountId)).cursor,'0');
    assert.equal((await repository.listEntries(vaultId,true)).length,1);

    const summary=await engine.sync(cloudVault(),accountId,resolver);
    assert.equal(summary.bootstrapResumed,true);
    assert.equal(summary.bootstrapSnapshot,'3');
    assert.equal(summary.cursor,'4');
    assert.equal(transport.beginCalls,1);
    assert.equal((await repository.listEntries(vaultId,true)).length,3);
    assert.equal((await state.bootstrap(vaultId,accountId)).status,'complete');
  }finally{
    fx.context1.destroy();fx.context2.destroy();
  }
});

test('I8 corrupt historical Attachment ciphertext fails before bootstrap progress or live cursor can advance',async()=>{
  const fx=await fixture();
  const attachmentOnly=[fx.bootstrapItems.find(item=>item.entityId===attachmentId)];
  const key='1:'+attachmentOnly[0].structural.blobId;
  const corrupt=fx.blobs.get(key).slice();
  corrupt[corrupt.length-1]^=1;
  const blobs=new Map([[key,corrupt]]);
  const driver=new MemoryDriver();
  driver.stores.get('vaults').set(vaultId,cloudVault());
  const repository=new LocalRepository(driver);
  const state=new SyncLocalStateV2(driver);
  const replica=new EncryptedReplicaStoreV2(driver);
  const transport=new BootstrapTransport({bootstrapItems:attachmentOnly,blobObjects:blobs});
  const engine=new EncryptedSyncEngineV2(transport,state,replica,repository);
  try{
    await assert.rejects(
      ()=>engine.sync(cloudVault(),accountId,{
        active:async()=>fx.context2,
        forGeneration:async generation=>generation===1?fx.context1:fx.context2,
      }),
      /failed authentication/,
    );
    assert.equal((await state.cursor(vaultId,accountId)).cursor,'0');
    assert.equal((await state.bootstrap(vaultId,accountId)).status,'failed');
    assert.equal((await state.bootstrap(vaultId,accountId)).appliedCount,0);
    assert.equal((await repository.listEntries(vaultId,true)).length,0);
  }finally{
    fx.context1.destroy();fx.context2.destroy();
  }
});
