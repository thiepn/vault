import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  sealOperationV2,
  validateOperationV2,
} from '../build/core/sync/protocol-v2.js';
import {
  validateBootstrapDescriptorV2,
  validateBootstrapPageV2,
  validateEncryptedPushResultV2,
  validateEncryptedRemotePageV2,
  validateEncryptedRemoteSnapshotV2,
} from '../build/core/sync/remote-v2.js';

const accountId='11111111-1111-4111-8111-111111111111';
const vaultId='22222222-2222-4222-8222-222222222222';
const deviceId='33333333-3333-4333-8333-333333333333';
const epoch='44444444-4444-4444-8444-444444444444';
const folderA='55555555-5555-4555-8555-555555555555';
const folderB='66666666-6666-4666-8666-666666666666';
const noteA='77777777-7777-4777-8777-777777777777';
const noteB='88888888-8888-4888-8888-888888888888';

const token=value=>value.repeat(43);
const now=()=>new Date().toISOString();

function payload(cipher='AAAAAAAAAAAAAAAAAAAAAA',generation=1){
  return {
    encryptionVersion:1,
    keyGeneration:generation,
    algorithm:'A256GCM',
    nonce:'AAAAAAAAAAAAAAAA',
    ciphertext:cipher,
  };
}

function put(entityId,entityType,options={}){
  return {
    kind:'put',
    entityId,
    entityType,
    baseRemoteRevision:options.baseRemoteRevision ?? null,
    schemaVersion:options.schemaVersion ?? 1,
    structural:{
      parentId:options.parentId ?? null,
      nameToken:options.nameToken === undefined
        ? (['note','folder','attachment'].includes(entityType) ? token(entityId===noteB?'B':'A') : null)
        : options.nameToken,
      deleted:options.deleted ?? false,
      blobId:options.blobId ?? null,
    },
    payload:payload(options.ciphertext ?? 'AAAAAAAAAAAAAAAAAAAAAA',options.keyGeneration ?? 1),
  };
}

async function operation(mutations,id=crypto.randomUUID()){
  const value={
    protocolVersion:2,
    operationId:id,
    accountId,
    vaultId,
    deviceId,
    mutations,
  };
  validateOperationV2(value);
  return sealOperationV2(value);
}

function clone(value){ return structuredClone(value); }

class Conflict extends Error {
  constructor(reason,entityId,current){
    super('conflict: '+reason);
    this.reason=reason;
    this.entityId=entityId;
    this.current=current;
  }
}

class ReferenceEncryptedServer {
  constructor(){
    this.activeGeneration=1;
    this.nextSequence=1n;
    this.heads=new Map();
    this.versions=new Map();
    this.operations=new Map();
    this.events=[];
    this.readyBlobs=new Set();
  }

  snapshot(head){
    return {
      entityId:head.entityId,
      vaultId,
      entityType:head.entityType,
      remoteRevision:String(head.remoteRevision),
      sequence:String(head.sequence),
      schemaVersion:head.schemaVersion,
      structural:clone(head.structural),
      payload:clone(head.payload),
      operationId:head.operationId,
      updatedByDevice:head.updatedByDevice,
      updatedAt:head.updatedAt,
    };
  }

  finalMap(proposed){
    const final=new Map([...this.heads].map(([id,row])=>[id,clone(row)]));
    for(const row of proposed) final.set(row.entityId,clone(row));
    return final;
  }

  validateFinal(proposed){
    const final=this.finalMap(proposed);
    for(const row of final.values()){
      if(row.structural.deleted) continue;
      const fs=['folder','note','attachment'].includes(row.entityType);
      if(fs && !row.structural.nameToken) throw new Error('NameToken required');
      if(!fs && (row.structural.parentId!==null||row.structural.nameToken!==null)) throw new Error('structured metadata leak');
      if(row.structural.parentId){
        const parent=final.get(row.structural.parentId);
        if(!parent||parent.entityType!=='folder'||parent.structural.deleted) throw new Conflict('parent',row.entityId,this.heads.get(row.entityId)?this.snapshot(this.heads.get(row.entityId)):null);
      }
      if(row.entityType==='attachment'){
        if(!row.structural.blobId||!this.readyBlobs.has(row.structural.blobId+'/'+row.payload.keyGeneration)) {
          throw new Conflict('blob',row.entityId,null);
        }
      }else if(row.structural.blobId!==null){
        throw new Error('non attachment blob');
      }
    }

    for(const row of final.values()){
      if(row.structural.deleted||!['folder','note','attachment'].includes(row.entityType)) continue;
      const path=new Set([row.entityId]);
      let parentId=row.structural.parentId;
      while(parentId){
        if(path.has(parentId)) throw new Conflict('cycle',row.entityId,this.heads.get(row.entityId)?this.snapshot(this.heads.get(row.entityId)):null);
        path.add(parentId);
        parentId=final.get(parentId)?.structural.parentId ?? null;
      }
    }

    const names=new Map();
    for(const row of final.values()){
      if(row.structural.deleted||!row.structural.nameToken) continue;
      const key=(row.structural.parentId??'<root>')+'/'+row.structural.nameToken;
      const prior=names.get(key);
      if(prior&&prior!==row.entityId) throw new Conflict('name',row.entityId,this.heads.get(row.entityId)?this.snapshot(this.heads.get(row.entityId)):null);
      names.set(key,row.entityId);
    }
  }

  async push(sealed){
    const existing=this.operations.get(sealed.operationId);
    if(existing){
      if(existing.sha256!==sealed.sha256||existing.wire!==sealed.wire) throw new Error('operation ID reused');
      return clone(existing.result);
    }
    const operation=JSON.parse(sealed.wire);
    validateOperationV2(operation);
    assert.equal(operation.accountId,accountId);
    assert.equal(operation.vaultId,vaultId);
    assert.equal(operation.deviceId,deviceId);

    const proposed=[];
    for(const mutation of operation.mutations){
      if(mutation.payload.keyGeneration!==this.activeGeneration) throw new Error('stale key generation');
      const current=this.heads.get(mutation.entityId);
      let revision;
      if(mutation.baseRemoteRevision===null){
        if(current) throw new Conflict('exists',mutation.entityId,this.snapshot(current));
        revision=1n;
      }else{
        if(!current||BigInt(mutation.baseRemoteRevision)!==current.remoteRevision) {
          throw new Conflict('revision',mutation.entityId,current?this.snapshot(current):null);
        }
        if(current.entityType!==mutation.entityType) throw new Conflict('type',mutation.entityId,this.snapshot(current));
        revision=current.remoteRevision+1n;
      }
      proposed.push({
        entityId:mutation.entityId,
        entityType:mutation.entityType,
        remoteRevision:revision,
        schemaVersion:mutation.schemaVersion,
        structural:clone(mutation.structural),
        payload:clone(mutation.payload),
      });
    }

    this.validateFinal(proposed);

    const first=this.nextSequence;
    const snapshots=[];
    for(const proposedState of proposed){
      const sequence=this.nextSequence++;
      const row={
        ...clone(proposedState),
        sequence,
        operationId:operation.operationId,
        updatedByDevice:operation.deviceId,
        updatedAt:now(),
      };
      this.heads.set(row.entityId,row);
      const versionKey=row.entityId+'/'+row.remoteRevision;
      this.versions.set(versionKey,clone(row));
      const snapshot=this.snapshot(row);
      snapshots.push(snapshot);
      this.events.push({
        sequence:String(sequence),
        operationId:operation.operationId,
        entityId:row.entityId,
        entityType:row.entityType,
        remoteRevision:String(row.remoteRevision),
        kind:'put',
        snapshot,
      });
    }
    const result={
      status:'ok',
      operationId:operation.operationId,
      firstSequence:String(first),
      through:String(this.nextSequence-1n),
      snapshots,
    };
    this.operations.set(operation.operationId,{sha256:sealed.sha256,wire:sealed.wire,result:clone(result)});
    return result;
  }

  pull(after,limit=500){
    const start=BigInt(after);
    const selected=this.events.filter(event=>BigInt(event.sequence)>start).slice(0,limit);
    return {
      protocolVersion:2,
      vaultId,
      epoch,
      after:String(after),
      through:selected.at(-1)?.sequence ?? String(after),
      highWatermark:String(this.nextSequence-1n),
      events:clone(selected),
    };
  }

  bootstrap(){
    return {
      protocolVersion:2,
      vaultId,
      epoch,
      snapshotSequence:String(this.nextSequence-1n),
      entityCount:this.heads.size,
    };
  }

  bootstrapPage(snapshotSequence,afterEntityId=null,limit=250){
    const h=BigInt(snapshotSequence);
    const latest=new Map();
    for(const row of this.versions.values()){
      if(row.sequence>h) continue;
      const prior=latest.get(row.entityId);
      if(!prior||row.sequence>prior.sequence) latest.set(row.entityId,row);
    }
    const eligible=[...latest.values()]
      .filter(row=>afterEntityId===null||row.entityId>afterEntityId)
      .sort((a,b)=>a.entityId.localeCompare(b.entityId));
    const selected=eligible.slice(0,limit);
    const hasMore=eligible.length>limit;
    return {
      protocolVersion:2,
      vaultId,
      epoch,
      snapshotSequence:String(snapshotSequence),
      afterEntityId,
      nextAfterEntityId:hasMore ? selected.at(-1)?.entityId ?? null : null,
      done:!hasMore,
      items:selected.map(row=>this.snapshot(row)),
    };
  }
}

test('I4 encrypted remote response contracts reject event/snapshot disagreement',async()=>{
  const server=new ReferenceEncryptedServer();
  const sealed=await operation([put(noteA,'note')]);
  const result=await server.push(sealed);
  assert.equal(validateEncryptedPushResultV2(result,{operationId:sealed.operationId,vaultId}).status,'ok');

  const page=server.pull('0');
  assert.equal(validateEncryptedRemotePageV2(page,{vaultId,epoch,after:'0'}).events.length,1);

  const tampered=clone(page);
  tampered.events[0].snapshot.entityId=noteB;
  assert.throws(
    ()=>validateEncryptedRemotePageV2(tampered,{vaultId,epoch,after:'0'}),
    /does not match its immutable entity version/,
  );
});

test('I4 accepted OperationId is exactly idempotent and different immutable bytes are rejected',async()=>{
  const server=new ReferenceEncryptedServer();
  const id=crypto.randomUUID();
  const first=await operation([put(noteA,'note')],id);
  const one=await server.push(first);
  const two=await server.push(first);
  assert.deepEqual(two,one);
  assert.equal(server.events.length,1);

  const changed=await operation([put(noteB,'note')],id);
  await assert.rejects(()=>server.push(changed),/operation ID reused/);
  assert.equal(server.events.length,1);
});

test('I4 CAS failure is all-or-none for a multi-entity operation',async()=>{
  const server=new ReferenceEncryptedServer();
  await server.push(await operation([put(noteA,'note'),put(noteB,'note')]));
  const before=clone([...server.heads.values()]);
  const beforeEvents=server.events.length;

  await assert.rejects(
    ()=>server.push(await operation([
      put(noteA,'note',{baseRemoteRevision:'1',ciphertext:'BBBBBBBBBBBBBBBBBBBBBB'}),
      put(noteB,'note',{baseRemoteRevision:'99',ciphertext:'CCCCCCCCCCCCCCCCCCCCCC'}),
    ])),
    error=>error instanceof Conflict&&error.reason==='revision',
  );

  assert.deepEqual([...server.heads.values()],before);
  assert.equal(server.events.length,beforeEvents);
});

test('I4 validates final hierarchy, allowing parent/child creation independent of mutation order',async()=>{
  const server=new ReferenceEncryptedServer();
  const sealed=await operation([
    put(noteA,'note',{parentId:folderA,nameToken:token('N')}),
    put(folderA,'folder',{nameToken:token('F')}),
  ]);
  const result=await server.push(sealed);
  assert.equal(result.snapshots.length,2);
  assert.equal(server.heads.get(noteA).structural.parentId,folderA);

  await server.push(await operation([put(folderB,'folder',{nameToken:token('G')})]));
  await assert.rejects(
    ()=>server.push(await operation([
      put(folderA,'folder',{baseRemoteRevision:'1',parentId:folderB,nameToken:token('F')}),
      put(folderB,'folder',{baseRemoteRevision:'1',parentId:folderA,nameToken:token('G')}),
    ])),
    error=>error instanceof Conflict&&error.reason==='cycle',
  );
});

test('I4 NameToken uniqueness is final-state based and tombstones release names',async()=>{
  const server=new ReferenceEncryptedServer();
  await server.push(await operation([put(noteA,'note',{nameToken:token('X')})]));
  await assert.rejects(
    ()=>server.push(await operation([put(noteB,'note',{nameToken:token('X')})])),
    error=>error instanceof Conflict&&error.reason==='name',
  );

  await server.push(await operation([put(noteA,'note',{
    baseRemoteRevision:'1',
    nameToken:token('X'),
    deleted:true,
    ciphertext:'BBBBBBBBBBBBBBBBBBBBBB',
  })]));
  await server.push(await operation([put(noteB,'note',{nameToken:token('X')})]));
  assert.equal(server.heads.get(noteB).structural.deleted,false);
});

test('I4 entity type is immutable after first accepted version',async()=>{
  const server=new ReferenceEncryptedServer();
  await server.push(await operation([put(folderA,'folder')]));
  await assert.rejects(
    ()=>server.push(await operation([put(folderA,'note',{baseRemoteRevision:'1'})])),
    error=>error instanceof Conflict&&error.reason==='type',
  );
});

test('I4 stale key generation cannot create future canonical ciphertext',async()=>{
  const server=new ReferenceEncryptedServer();
  server.activeGeneration=2;
  await assert.rejects(
    ()=>server.push(await operation([put(noteA,'note',{keyGeneration:1})])),
    /stale key generation/,
  );
  const accepted=await server.push(await operation([put(noteA,'note',{keyGeneration:2})]));
  assert.equal(accepted.snapshots[0].payload.keyGeneration,2);
});

test('I4 event stream is contiguous and pull pages carry immutable version snapshots',async()=>{
  const server=new ReferenceEncryptedServer();
  await server.push(await operation([put(noteA,'note'),put(noteB,'note')]));
  await server.push(await operation([put(noteA,'note',{
    baseRemoteRevision:'1',
    ciphertext:'BBBBBBBBBBBBBBBBBBBBBB',
  })]));
  assert.deepEqual(server.events.map(event=>event.sequence),['1','2','3']);

  const page=validateEncryptedRemotePageV2(server.pull('1',2),{vaultId,epoch,after:'1'});
  assert.equal(page.through,'3');
  assert.equal(page.events[1].snapshot.remoteRevision,'2');
  assert.equal(page.events[1].snapshot.payload.ciphertext,'BBBBBBBBBBBBBBBBBBBBBB');
});

test('I4 bootstrap remains an exact as-of high-watermark snapshot while later writes continue',async()=>{
  const server=new ReferenceEncryptedServer();
  await server.push(await operation([put(noteA,'note'),put(noteB,'note')]));
  const descriptor=validateBootstrapDescriptorV2(server.bootstrap(),vaultId,epoch);
  assert.equal(descriptor.snapshotSequence,'2');

  await server.push(await operation([put(noteA,'note',{
    baseRemoteRevision:'1',
    ciphertext:'BBBBBBBBBBBBBBBBBBBBBB',
  })]));

  const page=validateBootstrapPageV2(server.bootstrapPage(descriptor.snapshotSequence,null,250),{
    vaultId,
    epoch,
    snapshotSequence:descriptor.snapshotSequence,
    afterEntityId:null,
  });
  const oldNote=page.items.find(item=>item.entityId===noteA);
  assert.equal(oldNote.remoteRevision,'1');
  assert.equal(oldNote.payload.ciphertext,'AAAAAAAAAAAAAAAAAAAAAA');
});

test('I4 bootstrap validator enforces strict EntityId keyset order and fixed high watermark',async()=>{
  const server=new ReferenceEncryptedServer();
  await server.push(await operation([put(noteA,'note'),put(noteB,'note')]));
  const descriptor=server.bootstrap();
  const page=server.bootstrapPage(descriptor.snapshotSequence,null,1);
  assert.equal(validateBootstrapPageV2(page,{
    vaultId,epoch,snapshotSequence:descriptor.snapshotSequence,afterEntityId:null,
  }).done,false);

  const bad=clone(page);
  bad.items[0].sequence='3';
  assert.throws(()=>validateBootstrapPageV2(bad,{
    vaultId,epoch,snapshotSequence:descriptor.snapshotSequence,afterEntityId:null,
  }),/newer than its snapshot/);
});

test('I4 SQL keeps canonical content private/ciphertext-only and implements the full server contract',()=>{
  const sql=readFileSync(new URL('../backend/supabase/i4_encrypted_remote_state.sql',import.meta.url),'utf8');

  for(const table of [
    'sync_v2_vault_state',
    'entity_heads',
    'entity_versions',
    'accepted_operations',
    'sync_events',
    'device_vault_state',
    'blob_refs',
  ]){
    assert.match(sql,new RegExp(String.raw`create table if not exists vault_private\\.${table}\\s*\\(`,'iu'));
    assert.match(sql,new RegExp(String.raw`revoke all on vault_private\\.${table} from public,anon,authenticated`,'iu'));
  }

  for(const rpc of [
    'vault_sync_upgrade_v2',
    'vault_sync_push_v2',
    'vault_sync_pull_v2',
    'vault_sync_ack_v2',
    'vault_sync_begin_bootstrap_v2',
    'vault_sync_bootstrap_page_v2',
  ]){
    assert.match(sql,new RegExp(String.raw`create\\s+or\\s+replace\\s+function\\s+public\\.${rpc}\\s*\\(`,'iu'));
  }

  const tables=sql.slice(
    sql.indexOf('create table if not exists vault_private.sync_v2_vault_state'),
    sql.indexOf('-- ---------------------------------------------------------------------------\n-- Shared helpers'),
  );
  assert.doesNotMatch(tables,/markdown_text|blob_sha256|mime_type|original_filename|plaintext/iu);
  assert.match(tables,/ciphertext text not null/iu);
  assert.match(tables,/name_token text null/iu);
  assert.match(tables,/blob_id text null/iu);
});

test('I4 SQL recomputes exact wire digest and serializes each Vault before idempotency/CAS work',()=>{
  const sql=readFileSync(new URL('../backend/supabase/i4_encrypted_remote_state.sql',import.meta.url),'utf8');
  const pushStart=sql.indexOf('create or replace function public.vault_sync_push_v2');
  const pushEnd=sql.indexOf('-- ---------------------------------------------------------------------------\n-- Pull / acknowledgement',pushStart);
  const push=sql.slice(pushStart,pushEnd);
  assert.match(push,/extensions\.digest\(convert_to\(p_wire,'UTF8'\),'sha256'\)/u);
  assert.match(push,/from vault_private\.sync_v2_vault_state s[\s\S]*for update/iu);
  assert.match(push,/select \* into v_existing_operation[\s\S]*return v_existing_operation\.result/iu);
  assert.ok(push.indexOf('All checks passed')<push.indexOf('insert into vault_private.entity_heads'));
});

test('I4 SQL clean-break upgrade refuses any accepted v1 content/history',()=>{
  const sql=readFileSync(new URL('../backend/supabase/i4_encrypted_remote_state.sql',import.meta.url),'utf8');
  const start=sql.indexOf('create or replace function public.vault_sync_upgrade_v2');
  const end=sql.indexOf('-- ---------------------------------------------------------------------------\n-- Protocol v2 push',start);
  const upgrade=sql.slice(start,end);
  assert.match(upgrade,/public\.vault_sync_entries/iu);
  assert.match(upgrade,/public\.vault_sync_operations/iu);
  assert.match(upgrade,/public\.vault_sync_events/iu);
  assert.match(upgrade,/c\.next_sequence>1/iu);
  assert.match(upgrade,/set_config\('vault\.protocol_upgrade','2',true\)/u);
});

test('I4 SQL bootstrap reconstructs immutable state as-of H rather than reading current heads',()=>{
  const sql=readFileSync(new URL('../backend/supabase/i4_encrypted_remote_state.sql',import.meta.url),'utf8');
  const start=sql.indexOf('create or replace function public.vault_sync_bootstrap_page_v2');
  const bootstrap=sql.slice(start);
  assert.match(bootstrap,/from vault_private\.entity_versions v/iu);
  assert.match(bootstrap,/v\.sequence<=v_snapshot/iu);
  assert.match(bootstrap,/distinct on \(v\.entity_id\)/iu);
  assert.match(bootstrap,/p_after_entity_id is null or v\.entity_id>p_after_entity_id/iu);
});
