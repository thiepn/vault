import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMarkdownConflictPlan,
  resolveMarkdownConflictPlan,
  splitMarkdownBlocks,
} from '../build/core/sync/conflict-resolution.js';
import { MarkdownConflictStore, markdownConflictId } from '../build/core/sync/conflict-store.js';

const NL=String.fromCharCode(10);
const TICK=String.fromCharCode(96);
const lines=(...values)=>values.join(NL)+(values.length?NL:'');

test('Phase 22 Markdown blocks round-trip frontmatter, headings, lists, code and tables',()=>{
  const source=[
    '---','status: draft','---','',
    '# Heading','',
    'Paragraph one.','',
    '- first','- second','',
    TICK+TICK+TICK+'ts','const x = 1;',TICK+TICK+TICK,'',
    '| A | B |','| --- | --- |','| 1 | 2 |','',
  ].join(NL);
  const blocks=splitMarkdownBlocks(source);
  assert.equal(blocks.map(block=>block.raw).join(''),source);
  assert.deepEqual(blocks.map(block=>block.kind),['frontmatter','heading','paragraph','list','code','table']);
});

test('Phase 22 block-aware plan auto-merges independent semantic regions',()=>{
  const base=lines('# Note','','Alpha paragraph.','','Omega paragraph.');
  const local=lines('# Note','','Alpha local.','','Omega paragraph.');
  const remote=lines('# Note','','Alpha paragraph.','','Omega remote.');
  const plan=buildMarkdownConflictPlan(base,local,remote);
  assert.deepEqual(plan.conflictIds,[]);
  assert.equal(plan.autoMergedText,lines('# Note','','Alpha local.','','Omega remote.'));
});

test('Phase 22 overlapping paragraph edits become an explicit conflict region',()=>{
  const base=lines('# Note','','Shared paragraph.','','Tail.');
  const local=lines('# Note','','Local paragraph.','','Tail.');
  const remote=lines('# Note','','Remote paragraph.','','Tail.');
  const plan=buildMarkdownConflictPlan(base,local,remote);
  assert.equal(plan.conflictIds.length,1);
  const segment=plan.segments.find(item=>item.id===plan.conflictIds[0]);
  assert.equal(segment?.kind,'conflict');
  assert.match(segment?.label??'',/Shared paragraph/u);
  assert.equal(segment?.local,lines('Local paragraph.',''));
  assert.equal(segment?.remote,lines('Remote paragraph.',''));
});

test('Phase 22 conflict choices resolve local, remote, base and explicit both order',()=>{
  const base=lines('Before.','','Shared.','','After.');
  const local=lines('Before.','','Local.','','After.');
  const remote=lines('Before.','','Remote.','','After.');
  const plan=buildMarkdownConflictPlan(base,local,remote);
  const id=plan.conflictIds[0];
  assert.ok(id);
  assert.equal(resolveMarkdownConflictPlan(plan,{[id]:'local'}),local);
  assert.equal(resolveMarkdownConflictPlan(plan,{[id]:'remote'}),remote);
  assert.equal(resolveMarkdownConflictPlan(plan,{[id]:'base'}),base);
  const both=resolveMarkdownConflictPlan(plan,{[id]:'both-local-remote'});
  assert.match(both,/Local/u);
  assert.match(both,/Remote/u);
  assert.ok(both.indexOf('Local')<both.indexOf('Remote'));
});

test('Phase 22 identical edits are never presented as a conflict',()=>{
  const base=lines('Base.');
  const changed=lines('Changed.');
  const plan=buildMarkdownConflictPlan(base,changed,changed);
  assert.deepEqual(plan.conflictIds,[]);
  assert.equal(plan.autoMergedText,changed);
});


class ConflictMemoryStore {
  constructor(data,name){this.data=data;this.name=name;}
  async get(key){return structuredClone(this.data.get(key));}
  async getAll(){return [...this.data.values()].map(value=>structuredClone(value));}
  async allFromIndex(index,key){
    return [...this.data.values()].filter(value=>value[index]===key).map(value=>structuredClone(value));
  }
  async add(value){
    const key=value.id;
    if(this.data.has(key)) throw new Error('duplicate conflict');
    this.data.set(key,structuredClone(value));
  }
  async put(value){this.data.set(value.id,structuredClone(value));}
  async delete(key){this.data.delete(key);}
}
class ConflictMemoryDriver {
  constructor(){this.data=new Map();}
  async transaction(_names,mode,body){
    const working=mode==='readwrite'
      ? new Map([...this.data].map(([key,value])=>[key,structuredClone(value)]))
      : this.data;
    const result=await body({store:name=>{
      if(name!=='conflicts') throw new Error('unexpected store '+name);
      return new ConflictMemoryStore(working,name);
    }});
    if(mode==='readwrite') this.data=working;
    return result;
  }
}

test('Phase 22 conflict store is idempotent for the same remote revision and immutable across different snapshots',async()=>{
  const driver=new ConflictMemoryDriver();
  const store=new MarkdownConflictStore(driver);
  const input={
    vaultId:'11111111-1111-4111-8111-111111111111',
    entryId:'22222222-2222-4222-8222-222222222222',
    conflictEntryId:'33333333-3333-4333-8333-333333333333',
    ownerId:'44444444-4444-4444-8444-444444444444',
    epoch:'55555555-5555-4555-8555-555555555555',
    baseRevision:4,
    remoteRevision:5,
    baseText:lines('Base.'),
    localText:lines('Local.'),
    remoteText:lines('Remote.'),
    source:'pull',
  };
  const first=await store.record(input);
  const second=await store.record(input);
  assert.equal(first.id,markdownConflictId(input.entryId,input.remoteRevision));
  assert.deepEqual(second,first);
  await assert.rejects(
    ()=>store.record({...input,remoteText:lines('Different remote.')}),
    error=>error?.code==='PROTOCOL',
  );
});

test('Phase 22 resolving a conflict preserves its snapshots and removes it from the open queue',async()=>{
  const driver=new ConflictMemoryDriver();
  const store=new MarkdownConflictStore(driver);
  const input={
    vaultId:'11111111-1111-4111-8111-111111111111',
    entryId:'22222222-2222-4222-8222-222222222222',
    conflictEntryId:'33333333-3333-4333-8333-333333333333',
    ownerId:'44444444-4444-4444-8444-444444444444',
    epoch:'55555555-5555-4555-8555-555555555555',
    baseRevision:8,
    remoteRevision:9,
    baseText:lines('Base.'),
    localText:lines('Local.'),
    remoteText:lines('Remote.'),
    source:'push',
  };
  const created=await store.record(input);
  assert.equal((await store.listOpen(input.vaultId)).length,1);
  const resolved=await store.resolve(created.id,lines('Resolved.'));
  assert.equal(resolved.status,'resolved');
  assert.equal(resolved.resolutionText,lines('Resolved.'));
  assert.equal(resolved.baseText,input.baseText);
  assert.equal(resolved.localText,input.localText);
  assert.equal(resolved.remoteText,input.remoteText);
  assert.equal((await store.listOpen(input.vaultId)).length,0);
  assert.equal((await store.get(created.id))?.status,'resolved');
});
