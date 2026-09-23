import { performance } from 'node:perf_hooks';
import { CrdtTextDocument } from '../build/core/collaboration/crdt-text.js';
import { CrdtJournalStore } from '../build/core/collaboration/crdt-journal.js';

class Store {
  constructor(data){this.data=data;}
  async get(key){return structuredClone(this.data.get(key));}
  async getAll(){return [...this.data.values()].map(value=>structuredClone(value));}
  async fromIndex(index,key){return structuredClone([...this.data.values()].find(value=>value[index]===key));}
  async allFromIndex(index,key){return [...this.data.values()].filter(value=>value[index]===key).map(value=>structuredClone(value));}
  async add(value){if(this.data.has(value.id))throw new Error('duplicate');this.data.set(value.id,structuredClone(value));}
  async put(value){this.data.set(value.id,structuredClone(value));}
  async delete(key){this.data.delete(key);}
}
class Driver {
  constructor(){this.stores=new Map([['crdtSessions',new Map()],['crdtUpdates',new Map()]]);}
  async transaction(names,mode,body){
    const working=new Map([...this.stores].map(([name,data])=>[
      name,
      mode==='readwrite'&&names.includes(name)?new Map([...data].map(([key,value])=>[key,structuredClone(value)])):data,
    ]));
    const result=await body({store:name=>new Store(working.get(name))});
    if(mode==='readwrite')for(const name of names)this.stores.set(name,working.get(name));
    return result;
  }
}

const VAULT='11111111-1111-4111-8111-111111111111';
const ENTRY='22222222-2222-4222-8222-222222222222';
const OWNER='33333333-3333-4333-8333-333333333333';
const EPOCH='44444444-4444-4444-8444-444444444444';
const SESSION='55555555-5555-4555-8555-555555555555';
const base={
  vaultId:VAULT,entryId:ENTRY,ownerId:OWNER,epoch:EPOCH,
  baseRevision:1,baseFingerprint:'811c9dc5',baseText:'',
};
const docBase={entryId:ENTRY,revision:1,fingerprint:'811c9dc5',text:''};

const driver=new Driver();
const journal=new CrdtJournalStore(driver);
const session=await journal.ensureSession(base,SESSION);
const updates=[];
const source=new CrdtTextDocument(docBase,{onUpdate:update=>updates.push(update)});
let text='';
const count=1500;

const generationStart=performance.now();
for(let i=0;i<count;i++){
  text+=String.fromCharCode(97+(i%26));
  source.applyLocalText(text);
}
const generationMs=performance.now()-generationStart;
if(updates.length!==count) throw new Error('Unexpected Yjs update count.');

const appendStart=performance.now();
for(const update of updates){
  await journal.append(session.id,{source:'local',sourceSessionId:SESSION,bytes:update});
}
const appendMs=performance.now()-appendStart;

const loadStart=performance.now();
const replay=await journal.replay(base);
const recovered=new CrdtTextDocument(docBase);
for(const update of replay.updates) recovered.applyRemoteUpdate(update.bytes);
const replayMs=performance.now()-loadStart;

if(recovered.value!==source.value) throw new Error('Journal replay did not reconstruct the live document.');
if(replay.updates.length!==count) throw new Error('Journal replay lost updates.');
if(generationMs>1500) throw new Error(`Journal source generation exceeded 1500 ms: ${generationMs.toFixed(1)} ms`);
if(appendMs>2500) throw new Error(`Journal append benchmark exceeded 2500 ms: ${appendMs.toFixed(1)} ms`);
if(replayMs>1500) throw new Error(`Journal replay benchmark exceeded 1500 ms: ${replayMs.toFixed(1)} ms`);

console.log(JSON.stringify({
  updates:count,
  characters:recovered.value.length,
  bytes:replay.byteSize,
  generationMs:Number(generationMs.toFixed(1)),
  appendMs:Number(appendMs.toFixed(1)),
  replayMs:Number(replayMs.toFixed(1)),
}));
source.destroy();recovered.destroy();
