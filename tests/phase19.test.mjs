import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SupabaseCollaborationRealtime,
  validateCollaborationCursor,
  validateCollaborationPresence,
  vaultCollaborationTopic,
} from '../build/core/cloud/collaboration-realtime.js';

const VAULT='11111111-1111-4111-8111-111111111111';
const EPOCH='22222222-2222-4222-8222-222222222222';
const USER='33333333-3333-4333-8333-333333333333';
const DEVICE='44444444-4444-4444-8444-444444444444';
const SESSION='55555555-5555-4555-8555-555555555555';
const OTHER_USER='66666666-6666-4666-8666-666666666666';
const OTHER_DEVICE='77777777-7777-4777-8777-777777777777';
const OTHER_SESSION='88888888-8888-4888-8888-888888888888';
const ENTRY='99999999-9999-4999-8999-999999999999';
const NOW='2026-09-22T21:30:00.000Z';

class FakeSocket {
  readyState=0;
  sent=[];
  listeners=new Map();
  addEventListener(type,listener){
    const rows=this.listeners.get(type)??[];
    rows.push(listener);
    this.listeners.set(type,rows);
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

function presence(overrides={}){
  return {
    version:1,vaultId:VAULT,userId:OTHER_USER,deviceId:OTHER_DEVICE,sessionId:OTHER_SESSION,
    role:'editor',entryId:ENTRY,mode:'live',onlineAt:NOW,...overrides,
  };
}

function cursor(overrides={}){
  return {
    version:1,vaultId:VAULT,entryId:ENTRY,userId:OTHER_USER,deviceId:OTHER_DEVICE,sessionId:OTHER_SESSION,
    position:4,from:2,to:7,documentFingerprint:'deadbeef',at:NOW,...overrides,
  };
}

test('Phase 19 collaboration topics and ephemeral payload validators fail closed',()=>{
  assert.equal(vaultCollaborationTopic(VAULT,EPOCH),`vault-collab:${VAULT}:${EPOCH}`);
  assert.equal(validateCollaborationPresence(presence(),VAULT)?.role,'editor');
  assert.equal(validateCollaborationPresence(presence({role:'revoked'}),VAULT),null);
  assert.equal(validateCollaborationPresence(presence({entryId:'not-a-uuid'}),VAULT),null);
  assert.equal(validateCollaborationCursor(cursor(),VAULT)?.documentFingerprint,'deadbeef');
  assert.equal(validateCollaborationCursor(cursor({documentFingerprint:'bad'}),VAULT),null);
  assert.equal(validateCollaborationCursor(cursor({position:99}),VAULT),null);
  assert.throws(()=>vaultCollaborationTopic('bad',EPOCH),/Invalid collaboration Vault identity/u);
});

test('Phase 19 joins a private Presence channel, tracks context, applies state/diffs and validates cursors',async()=>{
  const sockets=[];
  const statuses=[];
  const presenceSnapshots=[];
  const cursors=[];
  const bridge=new SupabaseCollaborationRealtime(
    {url:'https://project.supabase.co',publishableKey:'sb_publishable_test'},
    async()=> 'jwt-token',
    {
      onStatus:status=>statuses.push(status),
      onPresence:participants=>presenceSnapshots.push([...participants]),
      onCursor:value=>cursors.push(value),
    },
    ()=>{const socket=new FakeSocket(); sockets.push(socket); return socket;},
  );

  await bridge.subscribe({
    vaultId:VAULT,epoch:EPOCH,userId:USER,deviceId:DEVICE,sessionId:SESSION,
    role:'owner',entryId:ENTRY,mode:'live',
  });
  assert.equal(sockets.length,1);
  const socket=sockets[0];
  socket.open();
  const join=JSON.parse(socket.sent[0]);
  assert.equal(join[2],`realtime:vault-collab:${VAULT}:${EPOCH}`);
  assert.equal(join[3],'phx_join');
  assert.equal(join[4].config.private,true);
  assert.equal(join[4].config.presence.enabled,true);
  assert.equal(join[4].config.presence.key,SESSION);
  assert.equal(join[4].config.broadcast.self,false);

  socket.message(JSON.stringify([join[0],join[1],join[2],'phx_reply',{status:'ok',response:{}}]));
  assert.equal(bridge.currentStatus,'connected');
  const initialTrack=JSON.parse(socket.sent[1]);
  assert.equal(initialTrack[3],'presence');
  assert.equal(initialTrack[4].event,'track');
  assert.equal(initialTrack[4].payload.userId,USER);
  assert.equal(initialTrack[4].payload.entryId,ENTRY);

  socket.message(JSON.stringify([
    null,null,join[2],'presence_state',{
      [OTHER_SESSION]:{metas:[{phx_ref:'p1',...presence()}]},
    },
  ]));
  assert.equal(bridge.participants.length,1);
  assert.equal(bridge.participants[0].sessionId,OTHER_SESSION);
  assert.equal(presenceSnapshots.at(-1)[0].userId,OTHER_USER);

  bridge.updateContext({role:'owner',entryId:null,mode:'none'});
  const contextTrack=JSON.parse(socket.sent.at(-1));
  assert.equal(contextTrack[3],'presence');
  assert.equal(contextTrack[4].payload.entryId,null);
  assert.equal(contextTrack[4].payload.mode,'none');

  const secondSession='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  socket.message(JSON.stringify([
    null,null,join[2],'presence_diff',{
      joins:{[secondSession]:{metas:[{phx_ref:'p2',...presence({sessionId:secondSession,role:'viewer'})}]}},
      leaves:{},
    },
  ]));
  assert.equal(bridge.participants.length,2);
  socket.message(JSON.stringify([
    null,null,join[2],'presence_diff',{
      joins:{},
      leaves:{[OTHER_SESSION]:{metas:[{phx_ref:'p1'}]}},
    },
  ]));
  assert.equal(bridge.participants.length,1);
  assert.equal(bridge.participants[0].sessionId,secondSession);

  socket.message(JSON.stringify([
    null,null,join[2],'broadcast',{event:'cursor',type:'broadcast',payload:cursor()},
  ]));
  assert.equal(cursors.length,1);
  assert.equal(cursors[0].from,2);

  socket.message(JSON.stringify([
    null,null,join[2],'broadcast',{event:'cursor',type:'broadcast',payload:cursor({documentFingerprint:'wrong'})},
  ]));
  socket.message(JSON.stringify([
    null,null,'realtime:vault-collab:other','broadcast',{event:'cursor',type:'broadcast',payload:cursor()},
  ]));
  socket.message(JSON.stringify([
    null,null,join[2],'broadcast',{event:'cursor',type:'broadcast',payload:cursor({sessionId:SESSION,userId:USER,deviceId:DEVICE})},
  ]));
  assert.equal(cursors.length,1);

  bridge.publishCursor({
    entryId:ENTRY,position:3,from:3,to:3,documentFingerprint:'cafebabe',
  });
  const outgoing=JSON.parse(socket.sent.at(-1));
  assert.equal(outgoing[3],'broadcast');
  assert.equal(outgoing[4].event,'cursor');
  assert.equal(outgoing[4].payload.documentFingerprint,'cafebabe');

  assert.ok(statuses.includes('connecting'));
  assert.ok(statuses.includes('connected'));
  bridge.stop();
  assert.equal(bridge.currentStatus,'stopped');
});

test('Phase 19 workspace renders cursor offsets only when the Markdown fingerprint matches',async()=>{
  const source=await readFile(new URL('../src/app/workspace.ts',import.meta.url),'utf8');
  assert.match(source,/cursor\.documentFingerprint !== editorStats\.documentFingerprint/u);
  assert.match(source,/participant\.entryId !== selected\.id/u);
  assert.match(source,/Date\.parse\(cursor\.at\) < cutoff/u);
});

test('Phase 19 SQL authorizes only active Vault members on the isolated collaboration topic',async()=>{
  const sql=await readFile(new URL('../backend/supabase/phase19_collaboration_presence.sql',import.meta.url),'utf8');
  assert.match(sql,/vault_realtime_collaboration_read/u);
  assert.match(sql,/vault_realtime_collaboration_write/u);
  assert.match(sql,/extension in \('broadcast','presence'\)/u);
  assert.match(sql,/split_part\(\(select realtime\.topic\(\)\),':',1\)='vault-collab'/u);
  assert.match(sql,/m\.auth_user_id=\(select auth\.uid\(\)\)/u);
  assert.match(sql,/m\.revoked_at is null/u);
  assert.match(sql,/v\.epoch::text=split_part/u);
  assert.doesNotMatch(sql,/vault_sync_push|markdown_text|storage\.objects/u);
});
