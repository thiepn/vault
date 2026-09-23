import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VaultCryptoContext } from '../build/core/crypto/context.js';
import { createNameToken } from '../build/core/crypto/keys.js';
import { generateVaultMasterKey } from '../build/core/crypto/keys.js';
import { serializeLocalEntityV2, decryptRemoteEntityV2 } from '../build/core/sync/serialization-v2.js';
import { EncryptedReplicaStoreV2 } from '../build/core/sync/replica-store-v2.js';
import { SyncLocalStateV2 } from '../build/core/sync/local-state-v2.js';
import { EncryptedSyncEngineV2 } from '../build/core/sync/engine-v2.js';
import { ProtocolV2Activation } from '../build/core/sync/activation-v2.js';
import { decodeOperationV2 } from '../build/core/sync/protocol-v2.js';
import { LocalRepository } from '../build/core/storage/local-repository.js';
import { legacyPlaintextCloudChannelAllowed } from '../build/core/cloud/access.js';

const accountId='11111111-1111-4111-8111-111111111111';
const vaultId='22222222-2222-4222-8222-222222222222';
const deviceId='33333333-3333-4333-8333-333333333333';
const epoch='44444444-4444-4444-8444-444444444444';
const authUserId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const noteId='55555555-5555-4555-8555-555555555555';

function keyFor(store,value){
  switch(store){
    case 'vaults': case 'entries': case 'outbox': case 'revisions': case 'drafts':
    case 'migrationState': case 'backgroundRuntime': case 'remoteInbox': case 'conflicts':
    case 'entities': return value.id;
    case 'contents': case 'attachments': return value.entryId;
    case 'dirty': return value.entryId;
    case 'settings': return value.key;
    case 'remoteShadows': return value.entryId;
    case 'syncCursors': return value.vaultId;
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
  return value[index];
}
class MemoryStore{
  constructor(data,name){this.data=data;this.name=name;}
  async get(key){const v=this.data.get(key);return v===undefined?undefined:structuredClone(v);}
  async getAll(){return [...this.data.values()].map(v=>structuredClone(v));}
  async fromIndex(index,key){
    const v=[...this.data.values()].find(row=>indexValue(row,index)===key);
    return v===undefined?undefined:structuredClone(v);
  }
  async allFromIndex(index,key){
    return [...this.data.values()].filter(row=>indexValue(row,index)===key).map(v=>structuredClone(v));
  }
  async add(value){
    const key=keyFor(this.name,value);
    if(this.data.has(key)) throw new Error('duplicate '+this.name+' '+key);
    if(this.name==='entries'&&value.activeKey){
      const collision=[...this.data.values()].find(row=>row.activeKey===value.activeKey);
      if(collision) throw new Error('duplicate activeKey');
    }
    this.data.set(key,structuredClone(value));
  }
  async put(value){
    const key=keyFor(this.name,value);
    if(this.name==='entries'&&value.activeKey){
      const collision=[...this.data.entries()].find(([id,row])=>id!==key&&row.activeKey===value.activeKey);
      if(collision) throw new Error('duplicate activeKey');
    }
    this.data.set(key,structuredClone(value));
  }
  async delete(key){this.data.delete(key);}
}
class MemoryDriver{
  constructor(){
    this.stores=new Map([
      'vaults','entries','contents','attachments','dirty','outbox','revisions','drafts',
      'settings','remoteShadows','syncCursors','knowledge','entities','noteBodies',
      'blobPayloads','migrationState','backgroundRuntime','remoteInbox','conflicts',
    ].map(name=>[name,new Map()]));
  }
  async transaction(names,mode,body){
    const working=new Map([...this.stores].map(([name,data])=>[
      name,
      mode==='readwrite'&&names.includes(name)
        ? new Map([...data].map(([key,value])=>[key,structuredClone(value)]))
        : data,
    ]));
    const result=await body({store:name=>new MemoryStore(working.get(name),name)});
    if(mode==='readwrite') for(const name of names)this.stores.set(name,working.get(name));
    return result;
  }
}

function cloudVault(protocolVersion=2){
  const createdAt='2026-09-23T12:00:00.000Z';
  return {
    id:vaultId,
    name:'Encrypted',
    createdAt,
    updatedAt:createdAt,
    mode:'cloud',
    cloud:{
      accountId,
      authUserId,
      ownerAccountId:accountId,
      ownerAuthUserId:authUserId,
      accessRole:'owner',
      projectRef:'test-project',
      remoteVaultId:vaultId,
      epoch,
      protocolVersion,
      deviceId,
      adoptedAt:createdAt,
    },
  };
}
function localNote(text='first'){
  const at='2026-09-23T12:00:00.000Z';
  return {
    entry:{
      id:noteId,
      vaultId,
      parentId:null,
      name:'Secret.md',
      kind:'markdown',
      createdAt:at,
      updatedAt:at,
      localVersion:1,
      deletedAt:null,
      deletionBatch:null,
      activeKey:`${vaultId}/root/secret.md`,
    },
    text,
    attachment:null,
  };
}

class FakeEncryptedServer{
  constructor(){
    this.events=[];
    this.next=1n;
    this.revisions=new Map();
    this.accepted=new Map();
    this.pushedWires=[];
    this.afterFirstAccept=null;
  }
  async pushV2(sealed){
    const replay=this.accepted.get(sealed.operationId);
    if(replay){
      if(replay.sha256!==sealed.sha256||replay.wire!==sealed.wire) throw new Error('operation identity reused');
      return structuredClone(replay.result);
    }
    const operation=decodeOperationV2(sealed.wire);
    this.pushedWires.push(sealed.wire);
    const snapshots=[];
    for(const mutation of operation.mutations){
      if(mutation.structural.parentId && !this.revisions.has(mutation.structural.parentId)){
        return {status:'conflict',reason:'parent',entityId:mutation.entityId,current:null};
      }
      const current=this.revisions.get(mutation.entityId) ?? 0n;
      if(mutation.baseRemoteRevision===null){
        if(current!==0n)return {status:'conflict',reason:'exists',entityId:mutation.entityId,current:null};
      }else if(BigInt(mutation.baseRemoteRevision)!==current){
        return {status:'conflict',reason:'revision',entityId:mutation.entityId,current:null};
      }
      const revision=current+1n;
      this.revisions.set(mutation.entityId,revision);
      const sequence=this.next++;
      const snapshot={
        entityId:mutation.entityId,
        vaultId:operation.vaultId,
        entityType:mutation.entityType,
        remoteRevision:String(revision),
        sequence:String(sequence),
        schemaVersion:mutation.schemaVersion,
        structural:structuredClone(mutation.structural),
        payload:structuredClone(mutation.payload),
        operationId:operation.operationId,
        updatedByDevice:operation.deviceId,
        updatedAt:new Date().toISOString(),
      };
      snapshots.push(snapshot);
      this.events.push({
        sequence:String(sequence),
        operationId:operation.operationId,
        entityId:mutation.entityId,
        entityType:mutation.entityType,
        remoteRevision:String(revision),
        kind:'put',
        snapshot,
      });
    }
    const result={
      status:'ok',
      operationId:operation.operationId,
      firstSequence:snapshots[0].sequence,
      through:snapshots.at(-1).sequence,
      snapshots,
    };
    this.accepted.set(operation.operationId,{wire:sealed.wire,sha256:sealed.sha256,result:structuredClone(result)});
    if(this.afterFirstAccept){
      const hook=this.afterFirstAccept;
      this.afterFirstAccept=null;
      await hook();
    }
    return result;
  }
  async pullV2(vault,remoteEpoch,device,after,limit=500){
    assert.equal(vault,vaultId); assert.equal(remoteEpoch,epoch); assert.equal(device,deviceId);
    const selected=this.events.filter(event=>BigInt(event.sequence)>BigInt(after)).slice(0,limit);
    return {
      protocolVersion:2,
      vaultId,
      epoch,
      after,
      through:selected.at(-1)?.sequence ?? after,
      highWatermark:String(this.next-1n),
      events:structuredClone(selected),
    };
  }
  async ackV2(vault,remoteEpoch,device,through){
    assert.equal(vault,vaultId); assert.equal(remoteEpoch,epoch); assert.equal(device,deviceId);
    this.lastAck=through;
  }
}

test('I5 serializer round-trips exact Markdown and authenticates server-visible structure',async()=>{
  const context=VaultCryptoContext.generate(vaultId,1);
  try{
    const local=localNote('# exact\r\nMarkdown  ');
    const serialized=await serializeLocalEntityV2({local,crypto:context,baseRemoteRevision:null});
    assert.equal(serialized.plaintext.text,'# exact\r\nMarkdown  ');
    assert.equal(serialized.mutation.structural.parentId,null);
    assert.equal(serialized.mutation.structural.blobId,null);

    const snapshot={
      entityId:serialized.mutation.entityId,
      vaultId,
      entityType:'note',
      remoteRevision:'1',
      sequence:'1',
      schemaVersion:serialized.mutation.schemaVersion,
      structural:serialized.mutation.structural,
      payload:serialized.mutation.payload,
      operationId:'66666666-6666-4666-8666-666666666666',
      updatedByDevice:deviceId,
      updatedAt:'2026-09-23T12:01:00.000Z',
    };
    const opened=await decryptRemoteEntityV2({snapshot,crypto:context});
    assert.equal(opened.payload.text,'# exact\r\nMarkdown  ');
    assert.equal(opened.payload.name,'Secret.md');

    const tampered=structuredClone(snapshot);
    tampered.structural.deleted=true;
    await assert.rejects(()=>decryptRemoteEntityV2({snapshot:tampered,crypto:context}),/failed authentication/);
  }finally{context.destroy();}
});

test('I5 decrypt recomputes NameToken after authentication and rejects a key-holder mismatch',async()=>{
  const vmk=generateVaultMasterKey();
  const context=new VaultCryptoContext(vaultId,1,vmk);
  vmk.fill(0);
  try{
    const local=localNote('body');
    const valid=await serializeLocalEntityV2({local,crypto:context,baseRemoteRevision:null});
    const wrongToken=await context.nameToken(null,'Different.md');
    const payload=await context.encryptEntity({
      entityId:noteId,
      entityType:'note',
      schemaVersion:1,
      parentId:null,
      nameToken:wrongToken,
      deleted:false,
      blobId:null,
      plaintext:new TextEncoder().encode(JSON.stringify(valid.plaintext)),
    });
    const snapshot={
      entityId:noteId,vaultId,entityType:'note',remoteRevision:'1',sequence:'1',schemaVersion:1,
      structural:{parentId:null,nameToken:wrongToken,deleted:false,blobId:null},
      payload,
      operationId:'66666666-6666-4666-8666-666666666666',
      updatedByDevice:deviceId,
      updatedAt:'2026-09-23T12:01:00.000Z',
    };
    await assert.rejects(()=>decryptRemoteEntityV2({snapshot,crypto:context}),/NameToken does not match/);
  }finally{context.destroy();}
});

test('I5 one-device sync keeps a newer edit dirty after first acceptance and sends revision 2',async()=>{
  const driver=new MemoryDriver();
  driver.stores.get('vaults').set(vaultId,cloudVault(2));
  const repository=new LocalRepository(driver);
  const note=await repository.createEntry(vaultId,null,'Secret.md','markdown','first');
  assert.equal(note.localVersion,1);

  const state=new SyncLocalStateV2(driver);
  await state.initializeCursor(vaultId,accountId,epoch);
  const replica=new EncryptedReplicaStoreV2(driver);
  const server=new FakeEncryptedServer();
  server.afterFirstAccept=async()=>{
    const latest=await repository.read(note.id);
    await repository.saveMarkdown(note.id,'second',latest.entry.localVersion);
  };
  const context=VaultCryptoContext.generate(vaultId,1);
  const engine=new EncryptedSyncEngineV2(server,state,replica,repository);
  try{
    const summary=await engine.sync(cloudVault(2),accountId,{
      active:async()=>context,
      forGeneration:async generation=>{
        assert.equal(generation,1);
        return context;
      },
    });
    assert.equal(summary.pushedOperations,2);
    assert.equal(summary.observedOwnOperations,2);
    assert.equal(summary.localChangedAfterOwnPush,1);
    assert.equal(summary.cursor,'2');
    assert.equal(summary.outboxRemaining,0);
    assert.equal(await state.count(vaultId,accountId),0);
    assert.equal(driver.stores.get('dirty').size,0);
    assert.equal((await repository.read(note.id)).content.text,'second');
    assert.equal(server.revisions.get(note.id),2n);
    assert.equal(server.lastAck,'2');

    for(const wire of server.pushedWires){
      const parsed=JSON.parse(wire);
      assert.equal('name' in parsed.mutations[0],false);
      assert.equal('text' in parsed.mutations[0],false);
      assert.equal(JSON.stringify(parsed).includes('Secret.md'),false);
      assert.equal(JSON.stringify(parsed).includes('first'),false);
      assert.equal(JSON.stringify(parsed).includes('second'),false);
    }
  }finally{context.destroy();}
});

test('I5 push order is dependency-safe even when the durable outbox returns child before parent',async()=>{
  const driver=new MemoryDriver();
  driver.stores.get('vaults').set(vaultId,cloudVault(2));
  const repository=new LocalRepository(driver);
  const folder=await repository.createEntry(vaultId,null,'Folder','directory');
  const note=await repository.createEntry(vaultId,folder.id,'Child.md','markdown','child');

  class ReversePendingState extends SyncLocalStateV2 {
    async pending(...args){
      return (await super.pending(...args)).reverse();
    }
  }
  const state=new ReversePendingState(driver);
  await state.initializeCursor(vaultId,accountId,epoch);
  const replica=new EncryptedReplicaStoreV2(driver);
  const server=new FakeEncryptedServer();
  const context=VaultCryptoContext.generate(vaultId,1);
  const engine=new EncryptedSyncEngineV2(server,state,replica,repository);
  try{
    const summary=await engine.sync(cloudVault(2),accountId,{
      active:async()=>context,
      forGeneration:async()=>context,
    });
    assert.equal(summary.pushedOperations,2);
    assert.equal(server.revisions.get(folder.id),1n);
    assert.equal(server.revisions.get(note.id),1n);
    const first=decodeOperationV2(server.pushedWires[0]);
    const second=decodeOperationV2(server.pushedWires[1]);
    assert.equal(first.mutations[0].entityId,folder.id);
    assert.equal(second.mutations[0].entityId,note.id);
  }finally{context.destroy();}
});

test('I5 foreign encrypted change racing dirty local work fails closed without cursor advance',async()=>{
  const driver=new MemoryDriver();
  driver.stores.get('vaults').set(vaultId,cloudVault(2));
  const repository=new LocalRepository(driver);
  const note=await repository.createEntry(vaultId,null,'Secret.md','markdown','local');
  const state=new SyncLocalStateV2(driver);
  await state.initializeCursor(vaultId,accountId,epoch);
  const replica=new EncryptedReplicaStoreV2(driver);
  const context=VaultCryptoContext.generate(vaultId,1);
  try{
    const local=await replica.read(note.id);
    const encrypted=await serializeLocalEntityV2({local:{...local,text:'remote'},crypto:context,baseRemoteRevision:null});
    const snapshot={
      entityId:encrypted.mutation.entityId,
      vaultId,
      entityType:'note',
      remoteRevision:'1',
      sequence:'1',
      schemaVersion:1,
      structural:encrypted.mutation.structural,
      payload:encrypted.mutation.payload,
      operationId:'99999999-9999-4999-8999-999999999999',
      updatedByDevice:'88888888-8888-4888-8888-888888888888',
      updatedAt:'2026-09-23T12:05:00.000Z',
    };
    const opened=await decryptRemoteEntityV2({snapshot,crypto:context});
    await assert.rejects(()=>replica.applyPage({
      accountId,epoch,expectedAfter:'0',through:'1',events:[opened],
    }),error=>error?.code==='MERGE_REQUIRED');
    assert.equal((await state.cursor(vaultId,accountId)).cursor,'0');
    assert.equal((await repository.read(note.id)).content.text,'local');
    assert.equal(driver.stores.get('dirty').size,1);
  }finally{context.destroy();}
});

test('I5 activation upgrades server before local cursor/binding and is retry-safe',async()=>{
  const order=[];
  const vault=cloudVault(1);
  const state={
    async assertCanMigrateEmptyV1State(){order.push('preflight');},
    async migrateEmptyV1State(){order.push('local-cursor');return {cursor:'0'};},
  };
  const transport={
    async capabilities(){
      order.push('capabilities');
      return {
        contractVersion:1,
        protocolVersions:[1,2],
        encryptedContentV2:{contractAvailable:true,acceptingContent:true},
        maxMutations:1000,maxPageEvents:1000,
      };
    },
    async upgradeV2(id,device){
      order.push('server');
      assert.equal(id,vaultId);assert.equal(device,deviceId);
      return {vaultId,epoch,protocolVersion:2};
    },
  };
  const vaults={
    async updateCloudProtocol(id,version){
      order.push('binding');
      assert.equal(id,vaultId);assert.equal(version,2);
      return {...vault,cloud:{...vault.cloud,protocolVersion:2}};
    },
  };
  const activation=new ProtocolV2Activation(
    transport,state,vaults,
    async()=>({
      vaultId,deviceId,keyGeneration:1,deviceEnvelope:true,recoveryEnvelope:true,
      deviceAuthorized:true,ready:true,
    }),
  );
  const result=await activation.activate(vault,accountId);
  assert.equal(result.vault.cloud.protocolVersion,2);
  assert.deepEqual(order,['capabilities','preflight','server','local-cursor','binding']);
});


test('I5 capability migration enables ciphertext ingestion only after client cutover',()=>{
  const sql=readFileSync(new URL('../backend/supabase/i5_enable_encrypted_content.sql',import.meta.url),'utf8');
  assert.match(sql,/'acceptingContent', true/u);
  assert.match(sql,/'contractAvailable', true/u);
  assert.match(sql,/grant execute on function public\.vault_sync_capabilities_v2\(\) to authenticated/iu);
  assert.doesNotMatch(sql,/name text|markdown_text|mime_type|blob_sha256/iu);
});


test('I5 canonical owner is never eligible for a legacy plaintext cloud channel',()=>{
  const ownerV1=cloudVault(1).cloud;
  const ownerV2=cloudVault(2).cloud;
  const sharedV1={...ownerV1,accessRole:'editor',ownerAccountId:'99999999-9999-4999-8999-999999999999'};
  assert.equal(legacyPlaintextCloudChannelAllowed(ownerV1),false);
  assert.equal(legacyPlaintextCloudChannelAllowed(ownerV2),false);
  assert.equal(legacyPlaintextCloudChannelAllowed(sharedV1),true);
});
