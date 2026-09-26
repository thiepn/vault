import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VaultCryptoContext } from '../build/core/crypto/context.js';
import { encryptBlobPayloadV1, decryptBlobPayloadV1, encryptedBlobCiphertextSize } from '../build/core/crypto/blob.js';
import { sha256 } from '../build/core/crypto/primitives.js';
import { bytesToHex } from '../build/core/crypto/encoding.js';
import { serializeLocalEntityV2, decryptRemoteEntityV2 } from '../build/core/sync/serialization-v2.js';
import { EncryptedReplicaStoreV2 } from '../build/core/sync/replica-store-v2.js';
import { SyncLocalStateV2 } from '../build/core/sync/local-state-v2.js';
import { EncryptedSyncEngineV2 } from '../build/core/sync/engine-v2.js';
import { decodeOperationV2 } from '../build/core/sync/protocol-v2.js';
import { SupabaseSyncTransport } from '../build/core/sync/transport.js';
import { LocalRepository } from '../build/core/storage/local-repository.js';

const accountId='11111111-1111-4111-8111-111111111111';
const vaultId='22222222-2222-4222-8222-222222222222';
const deviceId='33333333-3333-4333-8333-333333333333';
const epoch='44444444-4444-4444-8444-444444444444';
const authUserId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function clone(value){return value===undefined?undefined:structuredClone(value);}
function keyFor(store,value){
  switch(store){
    case 'vaults': case 'entries': case 'outbox': case 'revisions': case 'drafts':
    case 'migrationState': case 'backgroundRuntime': case 'remoteInbox': case 'conflicts':
    case 'syncConflicts': case 'entities': return value.id;
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
  if(index==='vaultEntry') return [value.vaultId,value.entryId];
  return value[index];
}
class MemoryStore{
  constructor(data,name){this.data=data;this.name=name;}
  async get(key){return clone(this.data.get(key));}
  async getAll(){return [...this.data.values()].map(clone);}
  async fromIndex(index,key){
    const value=[...this.data.values()].find(row=>{
      const actual=indexValue(row,index);
      return Array.isArray(actual)?JSON.stringify(actual)===JSON.stringify(key):actual===key;
    });
    return clone(value);
  }
  async allFromIndex(index,key){
    return [...this.data.values()].filter(row=>{
      const actual=indexValue(row,index);
      return Array.isArray(actual)?JSON.stringify(actual)===JSON.stringify(key):actual===key;
    }).map(clone);
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
  const at='2026-09-25T12:00:00.000Z';
  return {
    id:vaultId,name:'Encrypted attachments',createdAt:at,updatedAt:at,mode:'cloud',
    cloud:{
      accountId,authUserId,ownerAccountId:accountId,ownerAuthUserId:authUserId,
      accessRole:'owner',projectRef:'test',remoteVaultId:vaultId,epoch,
      protocolVersion:2,deviceId,adoptedAt:at,
    },
  };
}

class FakeBlobServer{
  constructor(){
    this.events=[];
    this.next=1n;
    this.revisions=new Map();
    this.accepted=new Map();
    this.objects=new Map();
    this.ready=new Set();
    this.uploadCalls=0;
    this.downloadCalls=0;
    this.pushedWires=[];
    this.failAfterUploadOnce=false;
  }
  blobKey(blobId,keyGeneration){return keyGeneration+':'+blobId;}
  async prepareBlobV2(vault,device,blobId,keyGeneration,ciphertextSize){
    assert.equal(vault,vaultId);assert.equal(device,deviceId);
    const key=this.blobKey(blobId,keyGeneration);
    const existing=this.objects.get(key);
    if(existing){
      assert.equal(existing.byteLength,ciphertextSize);
      this.ready.add(key);
      return {status:'ready',bucket:'vault-e2ee-blobs',path:`${vaultId}/${keyGeneration}/${blobId}`,blobId,keyGeneration,ciphertextSize};
    }
    return {status:'upload',bucket:'vault-e2ee-blobs',path:`${vaultId}/${keyGeneration}/${blobId}`,blobId,keyGeneration,ciphertextSize};
  }
  async uploadEncryptedBlobV2(descriptor,bytes){
    this.uploadCalls++;
    const key=this.blobKey(descriptor.blobId,descriptor.keyGeneration);
    if(this.objects.has(key))return 'exists';
    this.objects.set(key,bytes.slice());
    if(this.failAfterUploadOnce){
      this.failAfterUploadOnce=false;
      throw new Error('simulated lost encrypted blob upload response');
    }
    return 'uploaded';
  }
  async commitBlobV2(vault,device,blobId,keyGeneration,ciphertextSize){
    assert.equal(vault,vaultId);assert.equal(device,deviceId);
    const key=this.blobKey(blobId,keyGeneration);
    const bytes=this.objects.get(key);
    assert.ok(bytes);assert.equal(bytes.byteLength,ciphertextSize);
    this.ready.add(key);
    return {status:'ready',bucket:'vault-e2ee-blobs',path:`${vaultId}/${keyGeneration}/${blobId}`,blobId,keyGeneration,ciphertextSize};
  }
  async downloadEncryptedBlobV2(vault,blobId,keyGeneration){
    assert.equal(vault,vaultId);
    this.downloadCalls++;
    const bytes=this.objects.get(this.blobKey(blobId,keyGeneration));
    if(!bytes)throw new Error('missing blob');
    return bytes.slice();
  }
  async pushV2(sealed){
    const replay=this.accepted.get(sealed.operationId);
    if(replay)return clone(replay.result);
    const operation=decodeOperationV2(sealed.wire);
    this.pushedWires.push(sealed.wire);
    const snapshots=[];
    for(const mutation of operation.mutations){
      if(mutation.entityType==='attachment'){
        const key=this.blobKey(mutation.structural.blobId,mutation.payload.keyGeneration);
        if(!this.ready.has(key))return {status:'conflict',reason:'blob',entityId:mutation.entityId,current:null};
      }
      const current=this.revisions.get(mutation.entityId)??0n;
      if(mutation.baseRemoteRevision===null){
        if(current!==0n)return {status:'conflict',reason:'exists',entityId:mutation.entityId,current:null};
      }else if(BigInt(mutation.baseRemoteRevision)!==current){
        return {status:'conflict',reason:'revision',entityId:mutation.entityId,current:null};
      }
      const revision=current+1n;
      const sequence=this.next++;
      this.revisions.set(mutation.entityId,revision);
      const snapshot={
        entityId:mutation.entityId,vaultId:operation.vaultId,entityType:mutation.entityType,
        remoteRevision:String(revision),sequence:String(sequence),schemaVersion:mutation.schemaVersion,
        structural:clone(mutation.structural),payload:clone(mutation.payload),
        operationId:operation.operationId,updatedByDevice:operation.deviceId,
        updatedAt:'2026-09-25T12:01:00.000Z',
      };
      snapshots.push(snapshot);
      this.events.push({
        sequence:String(sequence),operationId:operation.operationId,entityId:mutation.entityId,
        entityType:mutation.entityType,remoteRevision:String(revision),kind:'put',snapshot,
      });
    }
    const result={
      status:'ok',operationId:operation.operationId,
      firstSequence:snapshots[0].sequence,through:snapshots.at(-1).sequence,snapshots,
    };
    this.accepted.set(operation.operationId,{result:clone(result)});
    return result;
  }
  async pullV2(vault,remoteEpoch,device,after,limit=500){
    assert.equal(vault,vaultId);assert.equal(remoteEpoch,epoch);assert.equal(device,deviceId);
    const selected=this.events.filter(event=>BigInt(event.sequence)>BigInt(after)).slice(0,limit);
    return {
      protocolVersion:2,vaultId,epoch,after,
      through:selected.at(-1)?.sequence??after,
      highWatermark:String(this.next-1n),events:clone(selected),
    };
  }
  async ackV2(){}
}

test('I7 binary blob envelope authenticates Vault, BlobId, generation and ciphertext',async()=>{
  const vmk=Uint8Array.from({length:32},(_,i)=>i);
  const context=new VaultCryptoContext(vaultId,1,vmk);
  vmk.fill(0);
  try{
    const plaintext=new TextEncoder().encode('opaque attachment bytes');
    const digest=await sha256(plaintext);
    const blobId=await context.blobId(digest);
    const envelope=await context.encryptBlob(blobId,plaintext);
    assert.equal(envelope.byteLength,encryptedBlobCiphertextSize(plaintext.byteLength));
    assert.equal(new TextDecoder().decode(envelope.slice(0,4)),'VBLB');
    assert.notEqual(bytesToHex(envelope).includes(bytesToHex(plaintext)),true);
    assert.deepEqual([...await context.decryptBlob(blobId,envelope)],[...plaintext]);

    const tampered=envelope.slice();
    tampered.at(-1);
    tampered[tampered.length-1]^=1;
    await assert.rejects(()=>context.decryptBlob(blobId,tampered),/failed authentication/);

    const other=new VaultCryptoContext('99999999-9999-4999-8999-999999999999',1,Uint8Array.from({length:32},(_,i)=>i));
    try{await assert.rejects(()=>other.decryptBlob(blobId,envelope),/failed authentication/);}
    finally{other.destroy();}
  }finally{context.destroy();}
});

test('I7 Attachment entity keeps filename MIME plaintext hash and bytes out of wire',async()=>{
  const driver=new MemoryDriver();
  driver.stores.get('vaults').set(vaultId,cloudVault());
  const repository=new LocalRepository(driver);
  const bytes=new TextEncoder().encode('TOP SECRET BINARY');
  const entry=await repository.createAttachment(vaultId,null,'private document.pdf','application/pdf',bytes);
  const local=await new EncryptedReplicaStoreV2(driver).read(entry.id);
  const context=VaultCryptoContext.generate(vaultId,1);
  try{
    const serialized=await serializeLocalEntityV2({local,crypto:context,baseRemoteRevision:null});
    assert.equal(serialized.plaintext.entityType,'attachment');
    assert.equal(serialized.plaintext.name,'private document.pdf');
    assert.equal(serialized.plaintext.mimeType,'application/pdf');
    assert.equal(serialized.plaintext.size,bytes.byteLength);
    assert.equal(serialized.blob.plaintextSha256,await (async()=>bytesToHex(await sha256(bytes)))());
    assert.match(serialized.mutation.structural.blobId,/^[A-Za-z0-9_-]{43}$/u);

    const wire=JSON.stringify(serialized.mutation);
    assert.equal(wire.includes('private document.pdf'),false);
    assert.equal(wire.includes('application/pdf'),false);
    assert.equal(wire.includes(serialized.blob.plaintextSha256),false);
    assert.equal(wire.includes('TOP SECRET BINARY'),false);

    const snapshot={
      entityId:serialized.mutation.entityId,vaultId,entityType:'attachment',
      remoteRevision:'1',sequence:'1',schemaVersion:1,
      structural:serialized.mutation.structural,payload:serialized.mutation.payload,
      operationId:'55555555-5555-4555-8555-555555555555',updatedByDevice:deviceId,
      updatedAt:'2026-09-25T12:01:00.000Z',
    };
    const opened=await decryptRemoteEntityV2({snapshot,crypto:context});
    assert.equal(opened.entityType,'attachment');
    assert.equal(opened.payload.name,'private document.pdf');
    assert.equal(opened.payload.mimeType,'application/pdf');
    assert.equal(opened.payload.plaintextSha256,serialized.blob.plaintextSha256);
    assert.equal(opened.blobId,serialized.blob.blobId);
  }finally{context.destroy();}
});

test('I7 engine uploads ciphertext before entity push and another device hydrates exact plaintext',async()=>{
  const firstDriver=new MemoryDriver();
  firstDriver.stores.get('vaults').set(vaultId,cloudVault());
  const firstRepo=new LocalRepository(firstDriver);
  const source=Uint8Array.from([0,1,2,3,250,251,252,253]);
  const attachment=await firstRepo.createAttachment(vaultId,null,'photo.bin','application/octet-stream',source);
  const firstState=new SyncLocalStateV2(firstDriver);
  await firstState.initializeCursor(vaultId,accountId,epoch);
  const server=new FakeBlobServer();
  const context=VaultCryptoContext.generate(vaultId,1);
  try{
    const firstEngine=new EncryptedSyncEngineV2(
      server,firstState,new EncryptedReplicaStoreV2(firstDriver),firstRepo,
    );
    const first=await firstEngine.sync(cloudVault(),accountId,{
      active:async()=>context,forGeneration:async()=>context,
    });
    assert.equal(first.uploadedBlobs,1);
    assert.equal(first.pushedOperations,1);
    assert.equal(first.outboxRemaining,0);
    assert.equal(firstDriver.stores.get('dirty').size,0);
    assert.equal(server.objects.size,1);
    const stored=[...server.objects.values()][0];
    assert.notDeepEqual([...stored],[...source]);

    const operation=decodeOperationV2(server.pushedWires[0]);
    assert.equal(operation.mutations[0].entityType,'attachment');
    assert.ok(operation.mutations[0].structural.blobId);
    assert.equal(JSON.stringify(operation).includes('photo.bin'),false);

    const secondDriver=new MemoryDriver();
    secondDriver.stores.get('vaults').set(vaultId,cloudVault());
    const secondRepo=new LocalRepository(secondDriver);
    const secondState=new SyncLocalStateV2(secondDriver);
    await secondState.initializeCursor(vaultId,accountId,epoch);
    const secondEngine=new EncryptedSyncEngineV2(
      server,secondState,new EncryptedReplicaStoreV2(secondDriver),secondRepo,
    );
    const second=await secondEngine.sync(cloudVault(),accountId,{
      active:async()=>context,forGeneration:async()=>context,
    });
    assert.equal(second.downloadedBlobs,1);
    assert.equal(second.cursor,'1');
    const hydrated=await secondRepo.read(attachment.id);
    assert.equal(hydrated.entry.name,'photo.bin');
    assert.equal(hydrated.attachment.mimeType,'application/octet-stream');
    assert.deepEqual([...hydrated.attachment.bytes],[...source]);
  }finally{context.destroy();}
});

test('I7 lost upload response recovers idempotently from immutable existing ciphertext',async()=>{
  const driver=new MemoryDriver();
  driver.stores.get('vaults').set(vaultId,cloudVault());
  const repository=new LocalRepository(driver);
  await repository.createAttachment(
    vaultId,null,'retry.bin','application/octet-stream',Uint8Array.from([9,8,7,6,5]),
  );
  const state=new SyncLocalStateV2(driver);
  await state.initializeCursor(vaultId,accountId,epoch);
  const server=new FakeBlobServer();
  server.failAfterUploadOnce=true;
  const context=VaultCryptoContext.generate(vaultId,1);
  const engine=new EncryptedSyncEngineV2(server,state,new EncryptedReplicaStoreV2(driver),repository);
  try{
    await assert.rejects(
      ()=>engine.sync(cloudVault(),accountId,{active:async()=>context,forGeneration:async()=>context}),
      /lost encrypted blob upload response/,
    );
    assert.equal(server.objects.size,1);
    assert.equal(server.events.length,0);

    const summary=await engine.sync(cloudVault(),accountId,{
      active:async()=>context,forGeneration:async()=>context,
    });
    assert.equal(summary.pushedOperations,1);
    assert.equal(server.uploadCalls,1);
    assert.equal(server.events.length,1);
  }finally{context.destroy();}
});

test('I7 large ciphertext uses 6 MiB TUS chunks and resumes from the server offset',async()=>{
  const chunkBytes=6*1024*1024;
  const bytes=Uint8Array.from({length:chunkBytes+12345},(_,index)=>(index*17+3)&255);
  const blobId='B'.repeat(43);
  const descriptor={
    status:'upload',
    bucket:'vault-e2ee-blobs',
    path:`${vaultId}/1/${blobId}`,
    blobId,
    keyGeneration:1,
    ciphertextSize:bytes.byteLength,
  };
  let serverOffset=0;
  let interrupted=false;
  let headCalls=0;
  const patchOffsets=[];
  const urls=[];

  const fakeFetch=async(input,init={})=>{
    const url=String(input);
    const method=init.method??'GET';
    const headers=new Headers(init.headers);
    urls.push(url);

    if(method==='POST'){
      assert.equal(url,'https://bskfihouwdogrunnglbg.storage.supabase.co/storage/v1/upload/resumable');
      assert.equal(headers.get('Tus-Resumable'),'1.0.0');
      assert.equal(headers.get('Upload-Length'),String(bytes.byteLength));
      assert.equal(headers.get('x-upsert'),'false');
      const metadata=headers.get('Upload-Metadata');
      assert.match(metadata,/bucketName /u);
      assert.match(metadata,/objectName /u);
      assert.equal(metadata.includes('secret'),false);
      return new Response(null,{
        status:201,
        headers:{Location:'/storage/v1/upload/resumable/session-1'},
      });
    }

    if(method==='HEAD'){
      headCalls++;
      assert.equal(headers.get('Tus-Resumable'),'1.0.0');
      return new Response(null,{status:200,headers:{'Upload-Offset':String(serverOffset)}});
    }

    if(method==='PATCH'){
      const offset=Number(headers.get('Upload-Offset'));
      patchOffsets.push(offset);
      assert.equal(headers.get('Content-Type'),'application/offset+octet-stream');
      if(offset===chunkBytes&&!interrupted){
        interrupted=true;
        throw new Error('simulated transient chunk interruption');
      }
      assert.equal(offset,serverOffset);
      const body=init.body;
      assert.ok(body instanceof Blob);
      serverOffset+=(await body.arrayBuffer()).byteLength;
      return new Response(null,{status:204,headers:{'Upload-Offset':String(serverOffset)}});
    }

    throw new Error('unexpected TUS request '+method+' '+url);
  };

  const transport=new SupabaseSyncTransport(
    {url:'https://bskfihouwdogrunnglbg.supabase.co',publishableKey:'publishable-test'},
    async()=> 'access-token',
    fakeFetch,
  );
  const result=await transport.uploadEncryptedBlobV2(descriptor,bytes);
  assert.equal(result,'uploaded');
  assert.equal(serverOffset,bytes.byteLength);
  assert.equal(headCalls,1);
  assert.deepEqual(patchOffsets,[0,chunkBytes,chunkBytes]);
  assert.equal(urls.some(url=>url.includes('.storage.supabase.co')),true);
});

test('I7 READY blob reuse is authenticated before a new Attachment entity may reference it',async()=>{
  const driver=new MemoryDriver();
  driver.stores.get('vaults').set(vaultId,cloudVault());
  const repository=new LocalRepository(driver);
  await repository.createAttachment(
    vaultId,null,'dedup.bin','application/octet-stream',Uint8Array.from([2,4,6,8]),
  );
  const state=new SyncLocalStateV2(driver);
  await state.initializeCursor(vaultId,accountId,epoch);
  const server=new FakeBlobServer();
  const context=VaultCryptoContext.generate(vaultId,1);
  const engine=new EncryptedSyncEngineV2(server,state,new EncryptedReplicaStoreV2(driver),repository);
  try{
    // Seed a valid immutable object, then corrupt it while leaving the backend's
    // READY registry intact. A later deduplicating push must fail closed.
    const local=await new EncryptedReplicaStoreV2(driver).read(
      [...driver.stores.get('entries').values()].find(entry=>entry.kind==='attachment').id,
    );
    const serialized=await serializeLocalEntityV2({local,crypto:context,baseRemoteRevision:null});
    const envelope=await context.encryptBlob(serialized.blob.blobId,serialized.blob.bytes);
    const key=server.blobKey(serialized.blob.blobId,context.keyGeneration);
    const corrupt=envelope.slice();
    corrupt[corrupt.length-1]^=1;
    server.objects.set(key,corrupt);
    server.ready.add(key);

    await assert.rejects(
      ()=>engine.sync(cloudVault(),accountId,{
        active:async()=>context,forGeneration:async()=>context,
      }),
      /failed authentication/,
    );
    assert.equal(server.events.length,0);
    assert.equal(await state.count(vaultId,accountId),0);
    assert.equal(driver.stores.get('dirty').size,1);
  }finally{context.destroy();}
});

test('I7 concurrent Attachment metadata changes preserve local bytes as a conflict-safe copy and advance',async()=>{
  const driver=new MemoryDriver();
  driver.stores.get('vaults').set(vaultId,cloudVault());
  const repository=new LocalRepository(driver);
  const source=Uint8Array.from([4,5,6,7]);
  const entry=await repository.createAttachment(vaultId,null,'Base.bin','application/octet-stream',source);
  const state=new SyncLocalStateV2(driver);
  await state.initializeCursor(vaultId,accountId,epoch);
  const server=new FakeBlobServer();
  const context=VaultCryptoContext.generate(vaultId,1);
  const replica=new EncryptedReplicaStoreV2(driver);
  try{
    await new EncryptedSyncEngineV2(server,state,replica,repository).sync(
      cloudVault(),accountId,{active:async()=>context,forGeneration:async()=>context},
    );
    const clean=await repository.read(entry.id);
    await repository.move(entry.id,null,'Mine.bin',clean.entry.localVersion);

    const shadow=await replica.shadow(entry.id,accountId,epoch);
    assert.ok(shadow);
    const digestHex=bytesToHex(await sha256(source));
    const remote={
      entityId:entry.id,vaultId,entityType:'attachment',
      remoteRevision:'2',sequence:'2',schemaVersion:1,parentId:null,
      nameToken:shadow.structural.nameToken,blobId:shadow.structural.blobId,
      deleted:false,keyGeneration:1,
      payload:{
        ...shadow.basePayload,
        entityType:'attachment',
        name:'Remote.bin',
        updatedAt:'2026-09-25T12:05:00.000Z',
        mimeType:'application/octet-stream',
        size:source.byteLength,
        plaintextSha256:digestHex,
      },
      operationId:'77777777-7777-4777-8777-777777777777',
      updatedByDevice:'88888888-8888-4888-8888-888888888888',
      updatedAt:'2026-09-25T12:05:00.000Z',
      stateHash:'b'.repeat(64),
    };
    const applied=await replica.applyPage({
      accountId,epoch,expectedAfter:'1',through:'2',events:[remote],
      attachmentBytes:new Map([[entry.id,source]]),
      localAttachmentSha256:new Map([[entry.id,digestHex]]),
    });
    assert.equal(applied.attachmentConflictsPreserved,1);
    assert.equal(applied.cursor,'2');

    const canonical=await repository.read(entry.id);
    assert.equal(canonical.entry.name,'Remote.bin');
    assert.deepEqual([...canonical.attachment.bytes],[...source]);

    const all=await repository.listEntries(vaultId,true);
    const copy=all.find(item=>item.id!==entry.id&&item.kind==='attachment'&&item.name.includes('conflict'));
    assert.ok(copy);
    assert.match(copy.name,/Mine \(conflict /u);
    assert.deepEqual([...(await repository.read(copy.id)).attachment.bytes],[...source]);
    assert.ok(driver.stores.get('dirty').has(copy.id));
    assert.equal(driver.stores.get('dirty').has(entry.id),false);
  }finally{context.destroy();}
});

test('I7 corrupt remote ciphertext fails before cursor advance or local canonical apply',async()=>{
  const sourceDriver=new MemoryDriver();
  sourceDriver.stores.get('vaults').set(vaultId,cloudVault());
  const sourceRepo=new LocalRepository(sourceDriver);
  const entry=await sourceRepo.createAttachment(
    vaultId,null,'corrupt.bin','application/octet-stream',Uint8Array.from([1,3,3,7]),
  );
  const sourceState=new SyncLocalStateV2(sourceDriver);
  await sourceState.initializeCursor(vaultId,accountId,epoch);
  const server=new FakeBlobServer();
  const context=VaultCryptoContext.generate(vaultId,1);
  try{
    await new EncryptedSyncEngineV2(
      server,sourceState,new EncryptedReplicaStoreV2(sourceDriver),sourceRepo,
    ).sync(cloudVault(),accountId,{active:async()=>context,forGeneration:async()=>context});

    const key=[...server.objects.keys()][0];
    const corrupt=server.objects.get(key).slice();
    corrupt[corrupt.length-1]^=1;
    server.objects.set(key,corrupt);

    const targetDriver=new MemoryDriver();
    targetDriver.stores.get('vaults').set(vaultId,cloudVault());
    const targetRepo=new LocalRepository(targetDriver);
    const targetState=new SyncLocalStateV2(targetDriver);
    await targetState.initializeCursor(vaultId,accountId,epoch);
    const targetEngine=new EncryptedSyncEngineV2(
      server,targetState,new EncryptedReplicaStoreV2(targetDriver),targetRepo,
    );

    await assert.rejects(
      ()=>targetEngine.sync(cloudVault(),accountId,{active:async()=>context,forGeneration:async()=>context}),
      /failed authentication/,
    );
    assert.equal((await targetState.cursor(vaultId,accountId)).cursor,'0');
    await assert.rejects(()=>targetRepo.read(entry.id),error=>error?.code==='NOT_FOUND');
  }finally{context.destroy();}
});

test('I7 backend contract isolates opaque ciphertext objects from legacy attachment storage',()=>{
  const sql=readFileSync(new URL('../backend/supabase/i7_encrypted_blobs.sql',import.meta.url),'utf8');
  assert.match(sql,/vault-e2ee-blobs/u);
  assert.match(sql,/public\.vault_sync_prepare_blob_v2/u);
  assert.match(sql,/public\.vault_sync_commit_blob_v2/u);
  assert.ok(sql.includes("p_blob_id !~ '^[A-Za-z0-9_-]{43}$'"));
  assert.match(sql,/p_key_generation<>v_active_generation/u);
  assert.match(sql,/v_object_size is distinct from p_ciphertext_size/u);
  assert.match(sql,/state='ready'/u);
  assert.match(sql,/protocol_version=2/u);
  assert.match(sql,/storage\.foldername\(storage\.objects\.name\)/u);
  assert.match(sql,/storage\.allow_any_operation\(array\['object\.get_authenticated','object\.get_authenticated_info'\]\)/u);
  assert.doesNotMatch(sql,/for update\s+to authenticated/iu);
  assert.doesNotMatch(sql,/for delete\s+to authenticated/iu);

  const lifecycle=readFileSync(new URL('../backend/supabase/i7_blob_lifecycle.sql',import.meta.url),'utf8');
  assert.match(lifecycle,/state='orphaned'/u);
  assert.match(lifecycle,/state in \('ready','orphaned'\)/u);
  assert.match(lifecycle,/entity_heads_blob_lifecycle_v2/u);
  assert.doesNotMatch(lifecycle,/delete from storage\.objects/iu);
});
