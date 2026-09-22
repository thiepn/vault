import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { SupabaseCollaborationRealtime } from '../build/core/cloud/collaboration-realtime.js';

const VAULT='11111111-1111-4111-8111-111111111111';
const EPOCH='22222222-2222-4222-8222-222222222222';
const USER='33333333-3333-4333-8333-333333333333';
const DEVICE='44444444-4444-4444-8444-444444444444';
const SESSION='55555555-5555-4555-8555-555555555555';
const OTHER_USER='66666666-6666-4666-8666-666666666666';
const OTHER_DEVICE='77777777-7777-4777-8777-777777777777';
const OTHER_SESSION='88888888-8888-4888-8888-888888888888';
const ENTRY='99999999-9999-4999-8999-999999999999';

class FakeSocket {
  readyState=0;
  sent=[];
  listeners=new Map();
  addEventListener(type,listener){const rows=this.listeners.get(type)??[];rows.push(listener);this.listeners.set(type,rows);}
  send(value){this.sent.push(value);}
  close(){if(this.readyState===3)return;this.readyState=3;this.emit('close',{});}
  open(){this.readyState=1;this.emit('open',{});}
  message(value){this.emit('message',{data:value});}
  emit(type,event){for(const listener of this.listeners.get(type)??[])listener(event);}
}

const sockets=[];
let cursors=0;
const bridge=new SupabaseCollaborationRealtime(
  {url:'https://project.supabase.co',publishableKey:'sb_publishable_test'},
  async()=> 'jwt-token',
  {onCursor:()=>{cursors++;}},
  ()=>{const socket=new FakeSocket();sockets.push(socket);return socket;},
);
await bridge.subscribe({
  vaultId:VAULT,epoch:EPOCH,userId:USER,deviceId:DEVICE,sessionId:SESSION,
  role:'editor',entryId:ENTRY,mode:'live',
});
const socket=sockets[0];
socket.open();
const join=JSON.parse(socket.sent[0]);
socket.message(JSON.stringify([join[0],join[1],join[2],'phx_reply',{status:'ok',response:{}}]));

const frame=JSON.stringify([
  null,null,join[2],'broadcast',
  {event:'cursor',type:'broadcast',payload:{
    version:1,vaultId:VAULT,entryId:ENTRY,userId:OTHER_USER,deviceId:OTHER_DEVICE,sessionId:OTHER_SESSION,
    position:12,from:10,to:14,documentFingerprint:'deadbeef',at:'2026-09-22T21:30:00.000Z',
  }},
]);

const iterations=50_000;
const started=performance.now();
for(let index=0;index<iterations;index++) socket.message(frame);
const elapsed=performance.now()-started;
bridge.stop();

assert.equal(cursors,iterations);
const budgetMs=2_500;
assert.ok(elapsed<budgetMs,`Collaboration cursor dispatch exceeded ${budgetMs} ms: ${elapsed.toFixed(1)} ms`);
console.log(`Phase 19 collaboration benchmark: ${iterations.toLocaleString()} validated cursor frames in ${elapsed.toFixed(1)} ms`);
