import test from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '../build/core/domain/model.js';
import { LocalRepository } from '../build/core/storage/local-repository.js';
import { ensureDeviceId, defaultDeviceLabel } from '../build/core/cloud/device.js';
import { SupabaseRestAuth } from '../build/core/cloud/auth-rest.js';
import { SupabaseCloudRegistry } from '../build/core/cloud/supabase-registry.js';
import { CloudFoundation } from '../build/core/cloud/foundation.js';
import { SyncLocalState } from '../build/core/sync/local-state.js';
import { sealOperation } from '../build/core/sync/protocol.js';

class MemoryStorage {
  constructor() { this.data=new Map(); }
  getItem(key){ return this.data.get(key) ?? null; }
  setItem(key,value){ this.data.set(key,String(value)); }
}

class MemoryStore {
  constructor(data,name){ this.data=data; this.name=name; }
  key(value){
    if (this.name==='vaults') return value.id;
    if (this.name==='outbox') return value.id;
    if (this.name==='syncCursors') return value.vaultId;
    return value.id ?? value.entryId ?? value.key;
  }
  async get(key){ return structuredClone(this.data.get(key)); }
  async getAll(){ return [...this.data.values()].map(structuredClone); }
  async fromIndex(index,key){ return [...this.data.values()].find(v=>v[index]===key); }
  async allFromIndex(index,key){ return [...this.data.values()].filter(v=>v[index]===key).map(structuredClone); }
  async add(value){ const key=this.key(value); if(this.data.has(key)) throw new Error('duplicate'); this.data.set(key,structuredClone(value)); }
  async put(value){ this.data.set(this.key(value),structuredClone(value)); }
  async delete(key){ this.data.delete(key); }
}

class MemoryDriver {
  constructor(){
    this.stores=new Map(['vaults','entries','contents','attachments','dirty','revisions','drafts','outbox','syncCursors'].map(name=>[name,new Map()]));
  }
  async transaction(names,mode,body){
    const working=new Map([...this.stores].map(([name,data])=>[
      name,
      mode==='readwrite' && names.includes(name)
        ? new Map([...data].map(([key,value])=>[key,structuredClone(value)]))
        : data
    ]));
    const result=await body({store:name=>new MemoryStore(working.get(name),name)});
    if(mode==='readwrite') for(const name of names) this.stores.set(name,working.get(name));
    return result;
  }
}

const config={url:'https://example.supabase.co',publishableKey:'sb_publishable_test_public_key'};

test('Phase 14 keeps a stable random DeviceId and uses coarse non-identifying labels',()=>{
  const storage=new MemoryStorage();
  const first=ensureDeviceId(storage);
  const second=ensureDeviceId(storage);
  assert.equal(first,second);
  assert.match(first,/^[0-9a-f-]{36}$/);
  assert.equal(defaultDeviceLabel('Mozilla Android','Linux arm'),'Android browser');
  assert.equal(defaultDeviceLabel('Mozilla','Win32'),'Windows browser');
});

test('Supabase REST auth signs in, refreshes an expired session, resolves identity, and signs out locally',async()=>{
  const storage=new MemoryStorage();
  const userId=crypto.randomUUID();
  const calls=[];
  const request=async(url,init={})=>{
    calls.push({url:String(url),init});
    if(String(url).includes('grant_type=password')){
      return new Response(JSON.stringify({access_token:'access-1',refresh_token:'refresh-1',expires_in:0}),{status:200,headers:{'content-type':'application/json'}});
    }
    if(String(url).includes('grant_type=refresh_token')){
      return new Response(JSON.stringify({access_token:'access-2',refresh_token:'refresh-2',expires_in:3600}),{status:200,headers:{'content-type':'application/json'}});
    }
    if(String(url).endsWith('/auth/v1/user')){
      assert.equal(new Headers(init.headers).get('authorization'),'Bearer access-2');
      return new Response(JSON.stringify({id:userId,email:'person@example.com'}),{status:200,headers:{'content-type':'application/json'}});
    }
    if(String(url).includes('/auth/v1/logout?scope=local')) return new Response(null,{status:204});
    throw new Error('unexpected request '+url);
  };
  const auth=new SupabaseRestAuth(config,storage,request);
  await auth.signIn('person@example.com','very-long-password');
  assert.deepEqual(await auth.identity(),{userId,email:'person@example.com'});
  assert.equal(await auth.accessToken(),'access-2');
  await auth.signOut();
  assert.equal(await auth.identity(),null);
  assert.ok(calls.some(call=>call.url.includes('scope=local')));
});

test('Supabase REST auth supports Google authorize URL and implicit browser callback adoption',async()=>{
  const storage=new MemoryStorage();
  const auth=new SupabaseRestAuth(config,storage,async()=>{ throw new Error('network not expected'); });
  const url=new URL(auth.googleAuthorizeUrl('https://vault.example/app'));
  assert.equal(url.pathname,'/auth/v1/authorize');
  assert.equal(url.searchParams.get('provider'),'google');
  assert.equal(url.searchParams.get('redirect_to'),'https://vault.example/app');
  assert.equal(auth.consumeImplicitOAuthRedirect('https://vault.example/app#access_token=a&refresh_token=r&expires_in=3600'),true);
  assert.equal(await auth.accessToken(),'a');
});

test('cloud registry sends authenticated RLS requests for account, device and Vault adoption',async()=>{
  const userId=crypto.randomUUID();
  const accountId=crypto.randomUUID();
  const deviceId=crypto.randomUUID();
  const vaultId=crypto.randomUUID();
  const epoch=crypto.randomUUID();
  const calls=[];
  const request=async(url,init={})=>{
    const u=String(url); calls.push({u,init});
    const auth=new Headers(init.headers).get('authorization');
    assert.equal(auth,'Bearer session-token');
    assert.equal(new Headers(init.headers).get('apikey'),config.publishableKey);
    if(u.includes('vault_accounts?on_conflict=')) return Response.json([{id:accountId,auth_user_id:userId,created_at:'2026-09-22T00:00:00.000Z'}],{status:201});
    if(u.includes('vault_cloud_devices?on_conflict=')) return Response.json([{id:deviceId,account_id:accountId,auth_user_id:userId,label:'Web browser',platform:'web',created_at:'2026-09-22T00:00:00.000Z',last_seen_at:'2026-09-22T00:00:00.000Z',revoked_at:null}],{status:201});
    if(u.includes('vault_cloud_vaults?on_conflict=')) return Response.json([{id:vaultId,account_id:accountId,auth_user_id:userId,name:'Cloud',epoch,protocol_version:1,created_at:'2026-09-22T00:00:00.000Z',updated_at:'2026-09-22T00:00:00.000Z',disabled_at:null}],{status:201});
    throw new Error('unexpected '+u);
  };
  const registry=new SupabaseCloudRegistry(config,async()=> 'session-token',request);
  const account=await registry.ensureAccount({userId,email:null});
  assert.equal(account.id,accountId);
  const device=await registry.registerDevice(account,deviceId,'Web browser');
  assert.equal(device.id,deviceId);
  const remote=await registry.adoptVault(account,vaultId,'Cloud');
  assert.equal(remote.epoch,epoch);
  assert.equal(calls.length,3);
});

test('local Vault adoption is explicit, UUID preserving, idempotent for one account, and rejects rebinding',async()=>{
  const driver=new MemoryDriver();
  const repo=new LocalRepository(driver);
  const vault=await repo.createVault('Local');
  assert.equal(vault.mode,'local');
  const accountId=crypto.randomUUID();
  const authUserId=crypto.randomUUID();
  const deviceId=crypto.randomUUID();
  const binding={accountId,authUserId,projectRef:'project',remoteVaultId:vault.id,epoch:crypto.randomUUID(),protocolVersion:1,deviceId,adoptedAt:new Date().toISOString()};
  const cloud=await repo.adoptCloud(vault.id,binding);
  assert.equal(cloud.mode,'cloud');
  assert.equal(cloud.id,vault.id);
  assert.equal((await repo.adoptCloud(vault.id,binding)).cloud.epoch,binding.epoch);
  await assert.rejects(()=>repo.adoptCloud(vault.id,{...binding,accountId:crypto.randomUUID()}),/different cloud account/);
  await assert.rejects(()=>repo.adoptCloud(vault.id,{...binding,remoteVaultId:crypto.randomUUID()}),/preserve the Vault UUID/);
});

test('CloudFoundation signs in/registers a device and adopts only after explicit request',async()=>{
  const driver=new MemoryDriver();
  const repo=new LocalRepository(driver);
  const vault=await repo.createVault('Private');
  const storage=new MemoryStorage();
  const userId=crypto.randomUUID();
  const accountId=crypto.randomUUID();
  const epoch=crypto.randomUUID();
  const fakeAuth={
    async identity(){return {userId,email:'p@example.com'};},
    async signIn(){},
    async signUp(){return {signedIn:true};},
    async signOut(){},
    googleAuthorizeUrl(){return 'https://example.invalid';},
    consumeImplicitOAuthRedirect(){return false;}
  };
  const fakeRegistry={
    async ensureAccount(){return {id:accountId,authUserId:userId,createdAt:new Date().toISOString()};},
    async registerDevice(account,deviceId){return {id:deviceId,accountId:account.id,authUserId:userId,label:'Web browser',platform:'web',createdAt:new Date().toISOString(),lastSeenAt:new Date().toISOString(),revokedAt:null};},
    async listVaults(){return [];},
    async adoptVault(account,vaultId,name){return {id:vaultId,accountId:account.id,authUserId:userId,name,epoch,protocolVersion:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),disabledAt:null};},
    async listDevices(){return [];},
    async revokeDevice(){}
  };
  const foundation=new CloudFoundation(fakeAuth,fakeRegistry,repo,storage,'https://project.supabase.co');
  assert.equal((await repo.listVaults())[0].mode,'local');
  const adopted=await foundation.adoptVault(vault);
  assert.equal(adopted.mode,'cloud');
  assert.equal(adopted.cloud.epoch,epoch);
});

test('sync outbox is immutable/idempotent and owner-bound',async()=>{
  const driver=new MemoryDriver();
  const state=new SyncLocalState(driver);
  const ownerId=crypto.randomUUID();
  const vaultId=newId();
  const deviceId=newId();
  const operation={protocolVersion:1,id:newId(),vaultId,deviceId,ownerId,mutations:[{kind:'create',entryId:newId(),parentId:null,name:'Note.md',entryKind:'markdown',text:'# Note'}]};
  const sealed=await sealOperation(operation);
  const first=await state.enqueue(sealed);
  const second=await state.enqueue(sealed);
  assert.equal(first.sha256,second.sha256);
  assert.equal((await state.pending(vaultId,ownerId)).length,1);
  await state.assertPendingOwners(vaultId,ownerId);
  await assert.rejects(()=>state.assertPendingOwners(vaultId,crypto.randomUUID()),/different account/);
  const tampered={...sealed,wire:sealed.wire.replace('# Note','# Other')};
  await assert.rejects(()=>state.enqueue(tampered),/does not match|different bytes|Invalid/);
  await state.acknowledge(sealed.id);
  assert.equal(await state.count(vaultId),0);
});

test('sync cursor is owner/epoch bound and never moves backward',async()=>{
  const driver=new MemoryDriver();
  const state=new SyncLocalState(driver);
  const vaultId=newId();
  const ownerId=crypto.randomUUID();
  const epoch=crypto.randomUUID();
  assert.equal((await state.initializeCursor(vaultId,ownerId,epoch)).cursor,'0');
  assert.equal((await state.advanceCursor(vaultId,ownerId,epoch,'5')).cursor,'5');
  await assert.rejects(()=>state.advanceCursor(vaultId,ownerId,epoch,'4'),/cannot move backwards/);
  await assert.rejects(()=>state.advanceCursor(vaultId,ownerId,crypto.randomUUID(),'6'),/epoch changed/);
  await assert.rejects(()=>state.cursor(vaultId,crypto.randomUUID()),/another account/);
});
