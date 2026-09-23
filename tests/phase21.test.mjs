import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LocalRepository } from '../build/core/storage/local-repository.js';
import { SyncLocalState } from '../build/core/sync/local-state.js';
import { SyncReplicaStore } from '../build/core/sync/replica-store.js';
import { SyncEngine } from '../build/core/sync/engine.js';
import { BackgroundReplicationState } from '../build/core/sync/background-state.js';

class MemoryStore {
  constructor(data,name){this.data=data;this.name=name;}
  key(value){
    if(this.name==='vaults'||this.name==='entries'||this.name==='outbox'||this.name==='backgroundRuntime'||this.name==='remoteInbox') return value.id;
    if(this.name==='contents'||this.name==='attachments'||this.name==='dirty'||this.name==='remoteShadows') return value.entryId;
    if(this.name==='syncCursors') return value.vaultId;
    return value.id??value.entryId??value.key;
  }
  async get(key){return structuredClone(this.data.get(key));}
  async getAll(){return [...this.data.values()].map(value=>structuredClone(value));}
  async fromIndex(index,key){return structuredClone([...this.data.values()].find(value=>JSON.stringify(value[index])===JSON.stringify(key)));}
  async allFromIndex(index,key){return [...this.data.values()].filter(value=>JSON.stringify(value[index])===JSON.stringify(key)).map(value=>structuredClone(value));}
  async add(value){const key=this.key(value);if(this.data.has(key))throw new Error('duplicate '+this.name);this.data.set(key,structuredClone(value));}
  async put(value){this.data.set(this.key(value),structuredClone(value));}
  async delete(key){this.data.delete(key);}
}
class MemoryDriver {
  constructor(){
    this.stores=new Map([
      'vaults','entries','contents','attachments','dirty','outbox','revisions','drafts',
      'remoteShadows','syncCursors','backgroundRuntime','remoteInbox',
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
    if(mode==='readwrite') for(const name of names) this.stores.set(name,working.get(name));
    return result;
  }
}

const USER='11111111-1111-4111-8111-111111111111';
const ACCOUNT='22222222-2222-4222-8222-222222222222';
const DEVICE='33333333-3333-4333-8333-333333333333';
const EPOCH='44444444-4444-4444-8444-444444444444';
const REMOTE_DEVICE='55555555-5555-4555-8555-555555555555';
const OP='66666666-6666-4666-8666-666666666666';
const ENTRY='77777777-7777-4777-8777-777777777777';
const NOW='2026-09-23T02:30:00.000Z';

function binding(vaultId){
  return {
    accountId:ACCOUNT,authUserId:USER,ownerAccountId:ACCOUNT,ownerAuthUserId:USER,accessRole:'owner',
    projectRef:'project',remoteVaultId:vaultId,epoch:EPOCH,protocolVersion:1,deviceId:DEVICE,adoptedAt:NOW,
  };
}

test('Phase 21 foreground preparation seals dirty Markdown without network I/O',async()=>{
  const driver=new MemoryDriver();
  const repo=new LocalRepository(driver);
  let vault=await repo.createVault('Background');
  await repo.createEntry(vault.id,null,'Queued','markdown','# queued');
  vault=await repo.adoptCloud(vault.id,binding(vault.id));
  const state=new SyncLocalState(driver);
  const background=new BackgroundReplicationState(driver);
  let network=0;
  const transport={
    async pull(){network++;throw new Error('prepare must not pull');},
    async push(){network++;throw new Error('prepare must not push');},
    async uploadBlob(){network++;},
    async downloadBlob(){network++;throw new Error('unexpected');},
  };
  const engine=new SyncEngine(transport,state,new SyncReplicaStore(driver),repo,background);
  const count=await engine.prepareBackground(vault,USER);
  assert.equal(count,1);
  assert.equal(network,0);
  assert.equal(await state.count(vault.id),1);
});

test('Phase 21 foreground SyncEngine consumes staged worker events before network pull',async()=>{
  const driver=new MemoryDriver();
  const repo=new LocalRepository(driver);
  const vaultId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const vault=await repo.createCloudReplica('Remote',binding(vaultId));
  const state=new SyncLocalState(driver);
  const background=new BackgroundReplicationState(driver);
  const snapshot={
    entryId:ENTRY,vaultId,parentId:null,name:'Background.md',kind:'markdown',revision:1,deletedAt:null,
    updatedAt:NOW,updatedByDevice:REMOTE_DEVICE,text:'# staged',attachmentSha256:null,attachmentMimeType:null,attachmentSize:null,
  };
  const event={sequence:'1',operationId:OP,entryId:ENTRY,revision:1,kind:'create',deviceId:REMOTE_DEVICE,snapshot};
  await driver.transaction(['remoteInbox'],'readwrite',tx=>tx.store('remoteInbox').put({
    id:vaultId+':1',vaultId,ownerId:USER,epoch:EPOCH,sequence:'1',event,stagedAt:NOW,
  }));

  let pulledAfter=null;
  const transport={
    async pull(id,epoch,after){
      pulledAfter=after;
      return {protocolVersion:1,vaultId:id,epoch,after,through:after,highWatermark:after,events:[]};
    },
    async push(){throw new Error('no push expected');},
    async uploadBlob(){throw new Error('no upload expected');},
    async downloadBlob(){throw new Error('no download expected');},
  };
  const engine=new SyncEngine(transport,state,new SyncReplicaStore(driver),repo,background);
  const result=await engine.sync(vault,USER);
  assert.equal(result.pulledEvents,1);
  assert.equal(result.cursor,'1');
  assert.equal(pulledAfter,'1');
  assert.equal((await repo.read(ENTRY)).content.text,'# staged');
  assert.equal((await background.staged(vault.id,USER,EPOCH)).length,0);
});

test('Phase 21 background runtime stores user credentials/config separately from canonical notes',async()=>{
  const driver=new MemoryDriver();
  const background=new BackgroundReplicationState(driver);
  const record={
    id:'runtime',databaseName:'vault:local',
    config:{url:'https://project.supabase.co',publishableKey:'sb_publishable_test'},
    authUserId:USER,
    session:{accessToken:'access',refreshToken:'refresh',expiresAt:2_000_000_000},
    updatedAt:NOW,
  };
  await background.putRuntime(record);
  assert.deepEqual(await background.runtime(),record);
  await background.putStatus({
    id:'status',capability:'registered',lastAttemptAt:NOW,lastSuccessAt:null,lastError:null,
    stagedEvents:2,pushedOperations:1,updatedAt:NOW,
  });
  assert.equal((await background.status()).stagedEvents,2);
  await background.clearRuntime();
  assert.equal(await background.runtime(),null);
});

test('Phase 21 schema v5 has dedicated worker runtime and staged inbox stores',async()=>{
  const source=await readFile(new URL('../src/storage/database.ts',import.meta.url),'utf8');
  assert.match(source,/SCHEMA_VERSION = 5/u);
  assert.match(source,/'backgroundRuntime'/u);
  assert.match(source,/'remoteInbox'/u);
  assert.match(source,/inbox\.createIndex\('vaultId'/u);
});

test('Phase 21 service worker stages transport state but never mutates canonical Markdown/cursor/outbox',async()=>{
  const source=await readFile(new URL('../public/sw.js',import.meta.url),'utf8');
  assert.match(source,/addEventListener\('sync'/u);
  assert.match(source,/vault-background-sync/u);
  assert.match(source,/addEventListener\('periodicsync'/u);
  assert.match(source,/vault_sync_push/u);
  assert.match(source,/vault_sync_pull/u);
  assert.match(source,/remoteInbox/u);
  assert.match(source,/BACKGROUND_SYNC_COMPLETE/u);
  assert.doesNotMatch(source,/objectStore\(['"]contents['"]\)\.put/u);
  assert.doesNotMatch(source,/objectStore\(['"]syncCursors['"]\)\.put/u);
  assert.doesNotMatch(source,/deleteOne\(database,\s*['"]outbox['"]/u);
  assert.doesNotMatch(source,/service_role|sb_secret_/u);
});
