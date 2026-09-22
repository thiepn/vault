import test from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseRealtimeWakeup, realtimeSocketUrl, vaultRealtimeTopic } from '../build/core/cloud/realtime-wakeup.js';

const VAULT='11111111-1111-4111-8111-111111111111';
const EPOCH='22222222-2222-4222-8222-222222222222';

class FakeSocket {
  readyState=0;
  sent=[];
  listeners=new Map();
  addEventListener(type,listener){
    const rows=this.listeners.get(type)??[];
    rows.push(listener); this.listeners.set(type,rows);
  }
  send(value){ this.sent.push(value); }
  close(){
    if(this.readyState===3) return;
    this.readyState=3;
    this.emit('close',{});
  }
  open(){ this.readyState=1; this.emit('open',{}); }
  message(value){ this.emit('message',{data:value}); }
  emit(type,event){ for(const listener of this.listeners.get(type)??[]) listener(event); }
}

test('Phase 17 builds private Vault realtime topics and websocket endpoint',()=>{
  assert.equal(vaultRealtimeTopic(VAULT,EPOCH),`vault:${VAULT}:${EPOCH}`);
  const url=new URL(realtimeSocketUrl({url:'https://project.supabase.co',publishableKey:'sb_publishable_test'}));
  assert.equal(url.protocol,'wss:');
  assert.equal(url.pathname,'/realtime/v1/websocket');
  assert.equal(url.searchParams.get('apikey'),'sb_publishable_test');
  assert.equal(url.searchParams.get('vsn'),'2.0.0');
});

test('Phase 17 joins an authenticated private channel and wakes only for validated sync broadcasts',async()=>{
  const sockets=[];
  const statuses=[];
  const wakes=[];
  const bridge=new SupabaseRealtimeWakeup(
    {url:'https://project.supabase.co',publishableKey:'sb_publishable_test'},
    async()=> 'jwt-token',
    {onStatus:status=>statuses.push(status),onWake:event=>wakes.push(event)},
    ()=>{const socket=new FakeSocket(); sockets.push(socket); return socket;},
  );

  await bridge.subscribe(VAULT,EPOCH);
  assert.equal(sockets.length,1);
  const socket=sockets[0];
  socket.open();
  assert.equal(socket.sent.length,1);
  const join=JSON.parse(socket.sent[0]);
  assert.equal(join[2],`realtime:vault:${VAULT}:${EPOCH}`);
  assert.equal(join[3],'phx_join');
  assert.equal(join[4].config.private,true);
  assert.equal(join[4].access_token,'jwt-token');

  socket.message(JSON.stringify([join[0],join[1],join[2],'phx_reply',{status:'ok',response:{}}]));
  assert.equal(bridge.currentStatus,'connected');

  socket.message(JSON.stringify([
    join[0],'3',join[2],'broadcast',
    {event:'sync_event',type:'broadcast',payload:{
      vaultId:VAULT,sequence:'7',operationId:'33333333-3333-4333-8333-333333333333',
      entryId:'44444444-4444-4444-8444-444444444444',revision:2,deviceId:'55555555-5555-4555-8555-555555555555',
    }},
  ]));
  assert.equal(wakes.length,1);
  assert.equal(wakes[0].sequence,'7');

  socket.message(JSON.stringify([
    join[0],'4',join[2],'broadcast',
    {event:'sync_event',type:'broadcast',payload:{vaultId:VAULT,sequence:'not-a-cursor'}},
  ]));
  socket.message(JSON.stringify([
    join[0],'5','realtime:vault:other','broadcast',
    {event:'sync_event',type:'broadcast',payload:{vaultId:VAULT,sequence:'8'}},
  ]));
  assert.equal(wakes.length,1);
  assert.ok(statuses.includes('connecting'));
  assert.ok(statuses.includes('connected'));

  bridge.stop();
  assert.equal(bridge.currentStatus,'stopped');
});
