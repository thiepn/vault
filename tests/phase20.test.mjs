import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CrdtTextDocument,
  base64ToBytes,
  bytesToBase64,
  canonicalSeedUpdate,
} from '../build/core/collaboration/crdt-text.js';
import {
  SupabaseCrdtRealtime,
  vaultCrdtTopic,
} from '../build/core/cloud/crdt-realtime.js';

const VAULT='11111111-1111-4111-8111-111111111111';
const EPOCH='22222222-2222-4222-8222-222222222222';
const ENTRY='33333333-3333-4333-8333-333333333333';
const SESSION='44444444-4444-4444-8444-444444444444';
const OTHER_SESSION='55555555-5555-4555-8555-555555555555';
const BASE={entryId:ENTRY,revision:7,fingerprint:'deadbeef',text:'hello'};

class FakeSocket {
  readyState=0;
  sent=[];
  listeners=new Map();
  addEventListener(type,listener){
    const rows=this.listeners.get(type)??[];
    rows.push(listener);
    this.listeners.set(type,rows);
  }
  send(value){this.sent.push(value);}
  close(){
    if(this.readyState===3) return;
    this.readyState=3;
    this.emit('close',{});
  }
  open(){this.readyState=1;this.emit('open',{});}
  message(value){this.emit('message',{data:value});}
  emit(type,event){for(const listener of this.listeners.get(type)??[]) listener(event);}
}

test('Phase 20 canonical Yjs seed update is deterministic without reusing live client IDs',()=>{
  const first=canonicalSeedUpdate(BASE);
  const second=canonicalSeedUpdate(BASE);
  assert.deepEqual(first,second);

  const a=new CrdtTextDocument(BASE);
  const b=new CrdtTextDocument(BASE);
  assert.equal(a.value,'hello');
  assert.equal(b.value,'hello');
  assert.notEqual(a.doc.clientID,b.doc.clientID);
  a.destroy(); b.destroy();
});

test('Phase 20 concurrent text edits converge after exchanging Yjs updates',()=>{
  const aUpdates=[]; const bUpdates=[];
  const a=new CrdtTextDocument(BASE,{onUpdate:update=>aUpdates.push(update)});
  const b=new CrdtTextDocument(BASE,{onUpdate:update=>bUpdates.push(update)});

  a.applyLocalText('hello A');
  b.applyLocalText('B hello');
  assert.equal(aUpdates.length,1);
  assert.equal(bUpdates.length,1);

  a.applyRemoteUpdate(bUpdates[0]);
  b.applyRemoteUpdate(aUpdates[0]);
  assert.equal(a.value,b.value);
  assert.equal(a.value,'B hello A');

  a.destroy(); b.destroy();
});

test('Phase 20 shared undo reverts only this editor local origin, never a remote edit',()=>{
  const bUpdates=[];
  const a=new CrdtTextDocument(BASE);
  const b=new CrdtTextDocument(BASE,{onUpdate:update=>bUpdates.push(update)});

  a.applyLocalText('hello local');
  b.applyLocalText('remote hello');
  a.applyRemoteUpdate(bUpdates[0]);
  assert.match(a.value,/local/u);
  assert.match(a.value,/remote/u);

  assert.equal(a.undo(),true);
  assert.doesNotMatch(a.value,/local/u);
  assert.match(a.value,/remote/u);
  assert.equal(a.redo(),true);
  assert.match(a.value,/local/u);
  assert.match(a.value,/remote/u);

  a.destroy(); b.destroy();
});

test('Phase 20 late joiner catches up by Yjs state vector without a second canonical store',()=>{
  const leader=new CrdtTextDocument(BASE);
  const joiner=new CrdtTextDocument(BASE);
  leader.applyLocalText('hello from leader');
  const missing=leader.stateUpdate(joiner.stateVector());
  joiner.applyRemoteUpdate(missing);
  assert.equal(joiner.value,leader.value);

  const reverse=joiner.stateUpdate(leader.stateVector());
  assert.ok(reverse.byteLength>0);
  leader.applyRemoteUpdate(reverse);
  assert.equal(joiner.value,leader.value);
  leader.destroy(); joiner.destroy();
});

test('Phase 20 CRDT binary transport encoding round-trips and rejects oversized input',()=>{
  const bytes=new Uint8Array([0,1,2,3,250,251,252,253,254,255]);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)),bytes);
  assert.throws(()=>base64ToBytes('A'.repeat(2_000_000),32),/Invalid CRDT binary payload|exceeds/u);
});

test('Phase 20 private realtime transport joins per-note room and validates update/sync messages',async()=>{
  const sockets=[];
  const statuses=[];
  const updates=[];
  const requests=[];
  const responses=[];
  let connected=0;
  const bridge=new SupabaseCrdtRealtime(
    {url:'https://project.supabase.co',publishableKey:'sb_publishable_test'},
    async()=> 'jwt-token',
    {
      onStatus:s=>statuses.push(s),
      onConnected:()=>connected++,
      onUpdate:value=>updates.push(value),
      onSyncRequest:value=>requests.push(value),
      onSyncResponse:value=>responses.push(value),
    },
    ()=>{const socket=new FakeSocket();sockets.push(socket);return socket;},
  );

  await bridge.subscribe({
    vaultId:VAULT,epoch:EPOCH,entryId:ENTRY,sessionId:SESSION,
    role:'editor',baseRevision:7,baseFingerprint:'deadbeef',
  });
  assert.equal(vaultCrdtTopic(VAULT,EPOCH,ENTRY),`vault-edit:${VAULT}:${EPOCH}:${ENTRY}`);
  const socket=sockets[0];
  socket.open();
  const join=JSON.parse(socket.sent[0]);
  assert.equal(join[2],`realtime:vault-edit:${VAULT}:${EPOCH}:${ENTRY}`);
  assert.equal(join[3],'phx_join');
  assert.equal(join[4].config.private,true);
  assert.equal(join[4].config.presence.enabled,false);

  socket.message(JSON.stringify([join[0],join[1],join[2],'phx_reply',{status:'ok',response:{}}]));
  assert.equal(bridge.currentStatus,'connected');
  assert.equal(connected,1);

  const update=new Uint8Array([1,2,3,4]);
  bridge.publishUpdate(update);
  let outgoing=JSON.parse(socket.sent.at(-1));
  assert.equal(outgoing[4].event,'crdt-update');
  assert.equal(outgoing[4].payload.baseRevision,7);

  const requestId=bridge.requestSync(new Uint8Array([9,8,7]));
  assert.match(requestId,/^[0-9a-f-]{36}$/u);
  outgoing=JSON.parse(socket.sent.at(-1));
  assert.equal(outgoing[4].event,'crdt-sync-request');

  socket.message(JSON.stringify([null,null,join[2],'broadcast',{
    type:'broadcast',event:'crdt-update',payload:{
      version:1,sessionId:OTHER_SESSION,baseRevision:7,baseFingerprint:'deadbeef',
      update:bytesToBase64(update),
    },
  }]));
  assert.equal(updates.length,1);
  assert.deepEqual(updates[0].update,update);

  const remoteRequest='66666666-6666-4666-8666-666666666666';
  socket.message(JSON.stringify([null,null,join[2],'broadcast',{
    type:'broadcast',event:'crdt-sync-request',payload:{
      version:1,requestId:remoteRequest,sessionId:OTHER_SESSION,
      baseRevision:7,baseFingerprint:'deadbeef',stateVector:bytesToBase64(new Uint8Array([5])),
    },
  }]));
  assert.equal(requests.length,1);
  bridge.respondSync(requests[0],new Uint8Array([6,7]),false);
  outgoing=JSON.parse(socket.sent.at(-1));
  assert.equal(outgoing[4].event,'crdt-sync-response');
  assert.equal(outgoing[4].payload.targetSessionId,OTHER_SESSION);

  socket.message(JSON.stringify([null,null,join[2],'broadcast',{
    type:'broadcast',event:'crdt-sync-response',payload:{
      version:1,requestId,sessionId:OTHER_SESSION,targetSessionId:SESSION,
      baseRevision:7,baseFingerprint:'deadbeef',replace:false,update:bytesToBase64(new Uint8Array([8])),
    },
  }]));
  assert.equal(responses.length,1);
  assert.deepEqual(responses[0].update,new Uint8Array([8]));

  socket.message(JSON.stringify([null,null,join[2],'broadcast',{
    type:'broadcast',event:'crdt-update',payload:{
      version:1,sessionId:OTHER_SESSION,baseRevision:7,baseFingerprint:'bad',
      update:bytesToBase64(update),
    },
  }]));
  assert.equal(updates.length,1);
  assert.ok(statuses.includes('connected'));
  bridge.stop();
});

test('Phase 20 viewer cannot open a live text room',async()=>{
  const bridge=new SupabaseCrdtRealtime(
    {url:'https://project.supabase.co',publishableKey:'sb_publishable_test'},
    async()=> 'jwt',
    {},
    ()=>new FakeSocket(),
  );
  await assert.rejects(()=>bridge.subscribe({
    vaultId:VAULT,epoch:EPOCH,entryId:ENTRY,sessionId:SESSION,
    role:'viewer',baseRevision:7,baseFingerprint:'deadbeef',
  }),error=>error?.code==='PERMISSION');
});

test('Phase 20 workspace keeps one canonical writer while followers preserve recovery drafts',async()=>{
  const source=await readFile(new URL('../src/app/workspace.ts',import.meta.url),'utf8');
  assert.match(source,/crdtLeaderSession===storageSessionId/u);
  assert.match(source,/queueCrdtRecovery\(text\)/u);
  assert.match(source,/persistCrdtRecoveryNow/u);
  assert.match(source,/syncState\.shadow/u);
  assert.match(source,/syncState\.pendingForEntry/u);
  assert.match(source,/shadow\.snapshot\.text!==current/u);
});

test('Phase 20 SQL allows only active owner/editor memberships on isolated per-note edit topics',async()=>{
  const sql=await readFile(new URL('../backend/supabase/phase20_crdt_editing.sql',import.meta.url),'utf8');
  assert.match(sql,/vault_realtime_crdt_read/u);
  assert.match(sql,/vault_realtime_crdt_write/u);
  assert.match(sql,/extension='broadcast'/u);
  assert.match(sql,/split_part\(\(select realtime\.topic\(\)\),':',1\)='vault-edit'/u);
  assert.match(sql,/m\.role in \('owner','editor'\)/u);
  assert.match(sql,/m\.revoked_at is null/u);
  assert.match(sql,/v\.epoch::text=split_part/u);
  assert.doesNotMatch(sql,/role in \('owner','editor','viewer'\)/u);
  assert.doesNotMatch(sql,/markdown_text|storage\.objects/u);
});
