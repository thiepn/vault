import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CrdtTextDocument } from '../build/core/collaboration/crdt-text.js';
import {
  CrdtJournalStore,
  crdtJournalRoomKey,
  crdtJournalSessionId,
} from '../build/core/collaboration/crdt-journal.js';
import { SCHEMA_VERSION, STORES } from '../build/core/storage/database.js';

class MemoryStore {
  constructor(data,name){this.data=data;this.name=name;}
  key(value){return value.id;}
  async get(key){return structuredClone(this.data.get(key));}
  async getAll(){return [...this.data.values()].map(value=>structuredClone(value));}
  async fromIndex(index,key){
    return structuredClone([...this.data.values()].find(value=>value[index]===key));
  }
  async allFromIndex(index,key){
    return [...this.data.values()].filter(value=>value[index]===key).map(value=>structuredClone(value));
  }
  async add(value){
    const key=this.key(value);
    if(this.data.has(key)) throw new Error('duplicate '+this.name);
    this.data.set(key,structuredClone(value));
  }
  async put(value){this.data.set(this.key(value),structuredClone(value));}
  async delete(key){this.data.delete(key);}
}
class MemoryDriver {
  constructor(){
    this.stores=new Map([
      ['crdtSessions',new Map()],
      ['crdtUpdates',new Map()],
    ]);
  }
  async transaction(names,mode,body){
    const working=new Map([...this.stores].map(([name,data])=>[
      name,
      mode==='readwrite'&&names.includes(name)
        ? new Map([...data].map(([key,value])=>[key,structuredClone(value)]))
        : data,
    ]));
    const result=await body({store:name=>{
      const data=working.get(name);
      if(!data) throw new Error('unexpected store '+name);
      return new MemoryStore(data,name);
    }});
    if(mode==='readwrite') for(const name of names) this.stores.set(name,working.get(name));
    return result;
  }
}

const VAULT='11111111-1111-4111-8111-111111111111';
const ENTRY='22222222-2222-4222-8222-222222222222';
const OWNER='33333333-3333-4333-8333-333333333333';
const EPOCH='44444444-4444-4444-8444-444444444444';
const SESSION='55555555-5555-4555-8555-555555555555';
const REMOTE_SESSION='66666666-6666-4666-8666-666666666666';
const BASE={
  vaultId:VAULT,
  entryId:ENTRY,
  ownerId:OWNER,
  epoch:EPOCH,
  baseRevision:7,
  baseFingerprint:'deadbeef',
};
const DOC_BASE={entryId:ENTRY,revision:7,fingerprint:'deadbeef',text:'hello'};

test('Phase 23 schema v7 adds dedicated CRDT journal session/update stores',()=>{
  assert.equal(SCHEMA_VERSION,7);
  assert.ok(STORES.includes('crdtSessions'));
  assert.ok(STORES.includes('crdtUpdates'));
});

test('Phase 23 journal room/session identities bind exact canonical base and local session',()=>{
  const room=crdtJournalRoomKey(BASE);
  assert.equal(room,`${VAULT}:${ENTRY}:${EPOCH}:7:deadbeef`);
  assert.equal(crdtJournalSessionId(BASE,SESSION),room+':'+SESSION);
  assert.notEqual(
    crdtJournalRoomKey({...BASE,baseRevision:8}),
    room,
  );
});

test('Phase 23 persists local and remote Yjs updates and replays them into a fresh document',async()=>{
  const driver=new MemoryDriver();
  const journal=new CrdtJournalStore(driver);
  const session=await journal.ensureSession(BASE,SESSION);

  const leftUpdates=[];
  const rightUpdates=[];
  const left=new CrdtTextDocument(DOC_BASE,{onUpdate:update=>leftUpdates.push(update)});
  const right=new CrdtTextDocument(DOC_BASE,{onUpdate:update=>rightUpdates.push(update)});
  left.applyLocalText('hello local');
  right.applyLocalText('remote hello');
  assert.equal(leftUpdates.length,1);
  assert.equal(rightUpdates.length,1);

  await journal.append(session.id,{source:'local',sourceSessionId:SESSION,bytes:leftUpdates[0]});
  await journal.append(session.id,{source:'remote',sourceSessionId:REMOTE_SESSION,bytes:rightUpdates[0]});

  const replay=await journal.replay(BASE);
  assert.equal(replay.sessions.length,1);
  assert.equal(replay.updates.length,2);
  assert.equal(replay.byteSize,replay.updates.reduce((sum,row)=>sum+row.byteLength,0));

  const recovered=new CrdtTextDocument(DOC_BASE);
  for(const update of replay.updates) recovered.applyRemoteUpdate(update.bytes);
  left.applyRemoteUpdate(rightUpdates[0]);
  assert.equal(recovered.value,left.value);
  assert.match(recovered.value,/local/u);
  assert.match(recovered.value,/remote/u);

  recovered.destroy();left.destroy();right.destroy();
});

test('Phase 23 closed local session reopens on the same exact room base',async()=>{
  const driver=new MemoryDriver();
  const journal=new CrdtJournalStore(driver);
  const first=await journal.ensureSession(BASE,SESSION);
  await journal.close(first.id);
  const closed=(await journal.listHistory(VAULT,ENTRY))[0];
  assert.equal(closed.status,'closed');
  const reopened=await journal.ensureSession(BASE,SESSION);
  assert.equal(reopened.id,first.id);
  assert.equal(reopened.status,'active');
  assert.equal(reopened.closedAt,null);
});

test('Phase 23 canonicalized room remains in history but is excluded from crash replay',async()=>{
  const driver=new MemoryDriver();
  const journal=new CrdtJournalStore(driver);
  const session=await journal.ensureSession(BASE,SESSION);
  const updates=[];
  const doc=new CrdtTextDocument(DOC_BASE,{onUpdate:update=>updates.push(update)});
  doc.applyLocalText('hello durable');
  await journal.append(session.id,{source:'local',sourceSessionId:SESSION,bytes:updates[0]});
  await journal.canonicalizeRoom(BASE,8);

  const replay=await journal.replay(BASE);
  assert.equal(replay.sessions.length,0);
  assert.equal(replay.updates.length,0);

  const history=await journal.listHistory(VAULT,ENTRY);
  assert.equal(history.length,1);
  assert.equal(history[0].status,'canonicalized');
  assert.equal(history[0].canonicalRevision,8);
  assert.ok(history[0].canonicalizedAt);
  doc.destroy();
});

test('Phase 23 retention pruning removes only old canonicalized room history',async()=>{
  const driver=new MemoryDriver();
  const journal=new CrdtJournalStore(driver);
  const session=await journal.ensureSession(BASE,SESSION);
  const updates=[];
  const doc=new CrdtTextDocument(DOC_BASE,{onUpdate:update=>updates.push(update)});
  doc.applyLocalText('hello prune');
  await journal.append(session.id,{source:'local',sourceSessionId:SESSION,bytes:updates[0]});
  await journal.canonicalizeRoom(BASE,8);

  const result=await journal.prune(VAULT,Date.now()+31*24*60*60*1000);
  assert.equal(result.sessions,1);
  assert.equal(result.updates,1);
  assert.ok(result.bytes>0);
  assert.equal((await journal.listHistory(VAULT)).length,0);
  doc.destroy();
});

test('Phase 23 rejects oversized journal frames before persistent storage',async()=>{
  const driver=new MemoryDriver();
  const journal=new CrdtJournalStore(driver);
  const session=await journal.ensureSession(BASE,SESSION);
  await assert.rejects(
    ()=>journal.append(session.id,{
      source:'local',
      sourceSessionId:SESSION,
      bytes:new Uint8Array(768*1024+1),
    }),
    error=>error?.code==='PROTOCOL',
  );
});

test('Phase 23 workspace journals local updates before Broadcast and canonicalizes only exact remote text',async()=>{
  const source=await readFile(new URL('../src/app/workspace.ts',import.meta.url),'utf8');
  const appendAt=source.indexOf('await crdtJournal.append');
  const publishAt=source.indexOf('if(publish) crdtRealtime?.publishUpdate(update)',appendAt);
  assert.ok(appendAt>=0);
  assert.ok(publishAt>appendAt);
  assert.match(source,/shadow\.snapshot\.text===journalTextBeforeSync/u);
  assert.match(source,/shadow\.snapshot\.revision>journalBaseBeforeSync\.baseRevision/u);
  assert.match(source,/canonicalizeCrdtJournal/u);
  assert.match(source,/await crdtJournal\.replay\(journalBase\)/u);
});
