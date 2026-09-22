import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LocalRepository } from '../build/core/storage/local-repository.js';
import { SyncLocalState } from '../build/core/sync/local-state.js';
import { SyncReplicaStore } from '../build/core/sync/replica-store.js';
import { SyncEngine } from '../build/core/sync/engine.js';
import { SupabaseCloudRegistry } from '../build/core/cloud/supabase-registry.js';
import { cloudBindingCanRead, cloudBindingCanWrite, cloudOwnerAuthUserId, effectiveCloudRole } from '../build/core/cloud/access.js';

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

const actor='11111111-1111-4111-8111-111111111111';
const actorAccount='22222222-2222-4222-8222-222222222222';
const owner='33333333-3333-4333-8333-333333333333';
const ownerAccount='44444444-4444-4444-8444-444444444444';
const device='55555555-5555-4555-8555-555555555555';
const epoch='66666666-6666-4666-8666-666666666666';
const remoteDevice='77777777-7777-4777-8777-777777777777';
const operation='88888888-8888-4888-8888-888888888888';
const entryId='99999999-9999-4999-8999-999999999999';
const iso='2026-09-22T20:00:00.000Z';

function binding(vaultId,role){
  return {
    accountId:actorAccount,
    authUserId:actor,
    ownerAccountId:ownerAccount,
    ownerAuthUserId:owner,
    accessRole:role,
    projectRef:'project',
    remoteVaultId:vaultId,
    epoch,
    protocolVersion:1,
    deviceId:device,
    adoptedAt:iso,
  };
}

test('Phase 18 resolves legacy bindings as owners and explicit shared roles correctly',()=>{
  const legacy={accountId:actorAccount,authUserId:actor,projectRef:'p',remoteVaultId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',epoch,protocolVersion:1,deviceId:device,adoptedAt:iso};
  assert.equal(effectiveCloudRole(legacy),'owner');
  assert.equal(cloudBindingCanWrite(legacy),true);
  assert.equal(cloudOwnerAuthUserId(legacy),actor);
  assert.equal(cloudBindingCanRead({...legacy,accessRole:'viewer'}),true);
  assert.equal(cloudBindingCanWrite({...legacy,accessRole:'viewer'}),false);
  assert.equal(cloudBindingCanRead({...legacy,accessRole:'revoked'}),false);
});

test('Phase 18 viewer replicas are locally read-only and become writable after an editor role refresh',async()=>{
  const driver=new MemoryDriver();
  const repo=new LocalRepository(driver);
  const local=await repo.createVault('Shared');
  const note=await repo.createEntry(local.id,null,'Note','markdown','# original');
  let vault=await repo.adoptCloud(local.id,binding(local.id,'viewer'));

  await assert.rejects(()=>repo.saveMarkdown(note.id,'# viewer edit',note.localVersion),error=>error?.code==='PERMISSION');
  await assert.rejects(()=>repo.createEntry(vault.id,null,'Blocked','markdown','# no'),error=>error?.code==='PERMISSION');
  await assert.rejects(()=>repo.trash(note.id,note.localVersion),error=>error?.code==='PERMISSION');
  assert.equal((await repo.read(note.id)).content.text,'# original');

  vault=await repo.updateCloudAccess(vault.id,{accessRole:'editor',ownerAccountId:ownerAccount,ownerAuthUserId:owner});
  assert.equal(vault.cloud.accessRole,'editor');
  const updated=await repo.saveMarkdown(note.id,'# editor edit',note.localVersion);
  assert.equal((await repo.read(updated.id)).content.text,'# editor edit');
});

test('Phase 18 refuses to rebind one local replica across authenticated accounts',async()=>{
  const driver=new MemoryDriver();
  const repo=new LocalRepository(driver);
  const vaultId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await repo.createCloudReplica('Shared',binding(vaultId,'editor'));
  const otherBinding={
    ...binding(vaultId,'editor'),
    accountId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    authUserId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    deviceId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  };
  await assert.rejects(
    ()=>repo.createCloudReplica('Shared',otherBinding),
    error=>error?.code==='COLLISION' && /another account/u.test(error.message),
  );
});

test('Phase 18 viewer sync pulls canonical changes but never pushes',async()=>{
  const driver=new MemoryDriver();
  const repo=new LocalRepository(driver);
  const local=await repo.createVault('Viewer');
  const vault=await repo.adoptCloud(local.id,binding(local.id,'viewer'));
  const state=new SyncLocalState(driver);
  const replica=new SyncReplicaStore(driver);
  let pushes=0;
  const snapshot={
    entryId,
    vaultId:vault.id,
    parentId:null,
    name:'Shared.md',
    kind:'markdown',
    revision:1,
    deletedAt:null,
    updatedAt:iso,
    updatedByDevice:remoteDevice,
    text:'# shared',
    attachmentSha256:null,
    attachmentMimeType:null,
    attachmentSize:null,
  };
  const transport={
    async pull(vaultId,requestEpoch,after){
      assert.equal(vaultId,vault.id);
      assert.equal(requestEpoch,epoch);
      if(after==='0') return {
        protocolVersion:1,vaultId:vault.id,epoch,after:'0',through:'1',highWatermark:'1',
        events:[{sequence:'1',operationId:operation,entryId,revision:1,kind:'create',deviceId:remoteDevice,snapshot}],
      };
      return {protocolVersion:1,vaultId:vault.id,epoch,after,through:after,highWatermark:after,events:[]};
    },
    async push(){ pushes++; throw new Error('viewer push must not occur'); },
    async uploadBlob(){ throw new Error('unexpected upload'); },
    async downloadBlob(){ throw new Error('unexpected download'); },
  };
  const engine=new SyncEngine(transport,state,replica,repo);
  const result=await engine.sync(vault,actor);
  assert.equal(result.pulledEvents,1);
  assert.equal(result.pushedOperations,0);
  assert.equal(pushes,0);
  assert.equal((await repo.read(entryId)).content.text,'# shared');
});

test('Phase 18 cloud registry uses membership RPCs and preserves owner identity for shared Vaults',async()=>{
  const config={url:'https://example.supabase.co',publishableKey:'sb_publishable_test'};
  const vaultId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const rows=[{
    id:vaultId,account_id:actorAccount,auth_user_id:actor,
    owner_account_id:ownerAccount,owner_auth_user_id:owner,access_role:'viewer',
    name:'Shared',epoch,protocol_version:1,created_at:iso,updated_at:iso,disabled_at:null,
  }];
  const calls=[];
  const request=async(url,init={})=>{
    const u=String(url); calls.push({u,init});
    assert.equal(new Headers(init.headers).get('authorization'),'Bearer token');
    if(u.endsWith('/rpc/vault_accessible_vaults')) return Response.json(rows);
    if(u.endsWith('/rpc/vault_share_create_invite')){
      const body=JSON.parse(init.body);
      assert.equal(body.p_role,'editor');
      return Response.json({vaultId,role:'editor',token:'a'.repeat(64),expiresAt:'2026-09-23T20:00:00.000Z'});
    }
    if(u.endsWith('/rpc/vault_share_accept_invite')) return Response.json(rows[0]);
    throw new Error('unexpected '+u);
  };
  const registry=new SupabaseCloudRegistry(config,async()=> 'token',request);
  const account={id:actorAccount,authUserId:actor,createdAt:iso};
  const listed=await registry.listVaults(account);
  assert.equal(listed[0].accessRole,'viewer');
  assert.equal(listed[0].ownerAuthUserId,owner);
  assert.equal((await registry.createInvite(vaultId,'editor')).token,'a'.repeat(64));
  assert.equal((await registry.acceptInvite('a'.repeat(64))).ownerAccountId,ownerAccount);
  assert.equal(calls.length,3);
});

test('Phase 18 SQL keeps owner-scoped canonical history while authorizing members by role',async()=>{
  const sql=await readFile(new URL('../backend/supabase/phase18_shared_vaults.sql',import.meta.url),'utf8');
  assert.match(sql,/create table if not exists public\.vault_memberships/u);
  assert.match(sql,/role in \('owner','editor','viewer'\)/u);
  assert.match(sql,/m\.role in \('owner','editor'\)/u);
  assert.match(sql,/v_blob_path:=v_owner_auth_user_id::text/u);
  assert.match(sql,/vault_share_accept_invite/u);
  assert.match(sql,/vault_realtime_sync_read/u);
  assert.match(sql,/actor_auth_user_id/u);
  assert.doesNotMatch(sql,/where v\.id=p_vault_id\s+and v\.auth_user_id=v_uid\s+and v\.epoch=p_epoch/u);
});
