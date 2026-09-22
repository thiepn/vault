import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { SupabaseRealtimeWakeup } from '../build/core/cloud/realtime-wakeup.js';

const VAULT='11111111-1111-4111-8111-111111111111';
const EPOCH='22222222-2222-4222-8222-222222222222';

class FakeSocket {
  readyState=0;
  sent=[];
  listeners=new Map();
  addEventListener(type,listener){ const rows=this.listeners.get(type)??[]; rows.push(listener); this.listeners.set(type,rows); }
  send(value){ this.sent.push(value); }
  close(){ if(this.readyState===3)return; this.readyState=3; this.emit('close',{}); }
  open(){ this.readyState=1; this.emit('open',{}); }
  message(value){ this.emit('message',{data:value}); }
  emit(type,event){ for(const listener of this.listeners.get(type)??[]) listener(event); }
}

const sockets=[];
let wakes=0;
const bridge=new SupabaseRealtimeWakeup(
  {url:'https://project.supabase.co',publishableKey:'sb_publishable_test'},
  async()=> 'jwt-token',
  {onWake:()=>{wakes++;}},
  ()=>{const socket=new FakeSocket(); sockets.push(socket); return socket;},
);
await bridge.subscribe(VAULT,EPOCH);
const socket=sockets[0];
socket.open();
const join=JSON.parse(socket.sent[0]);
socket.message(JSON.stringify([join[0],join[1],join[2],'phx_reply',{status:'ok',response:{}}]));

const frame=JSON.stringify([
  join[0],'3',join[2],'broadcast',
  {event:'sync_event',type:'broadcast',payload:{
    vaultId:VAULT,sequence:'987654321',operationId:'33333333-3333-4333-8333-333333333333',
    entryId:'44444444-4444-4444-8444-444444444444',revision:9,deviceId:'55555555-5555-4555-8555-555555555555',
  }},
]);

const iterations=50_000;
const started=performance.now();
for(let index=0;index<iterations;index++) socket.message(frame);
const elapsed=performance.now()-started;
bridge.stop();

assert.equal(wakes,iterations);
const budgetMs=2_500;
assert.ok(elapsed<budgetMs,`Realtime wake dispatch exceeded ${budgetMs} ms: ${elapsed.toFixed(1)} ms`);
console.log(`Phase 17 realtime wake benchmark: ${iterations.toLocaleString()} validated frames in ${elapsed.toFixed(1)} ms`);
