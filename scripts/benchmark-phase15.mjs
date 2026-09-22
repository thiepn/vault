import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { validateRemotePage } from '../build/core/sync/remote-types.js';

const vaultId='11111111-1111-4111-8111-111111111111';
const epoch='22222222-2222-4222-8222-222222222222';
const deviceId='33333333-3333-4333-8333-333333333333';
const TOTAL=10_000;
const PAGE=1_000;

const events=Array.from({length:TOTAL},(_,index)=>{
  const entryId=(index+1).toString(16).padStart(12,'0');
  const operationId=(index+20_001).toString(16).padStart(12,'0');
  return {
    sequence:String(index+1),
    operationId:`44444444-4444-4444-8444-${operationId}`,
    entryId:`55555555-5555-4555-8555-${entryId}`,
    revision:1,
    kind:'create',
    deviceId,
    snapshot:{
      entryId:`55555555-5555-4555-8555-${entryId}`,
      vaultId,
      parentId:null,
      name:`Note ${index}.md`,
      kind:'markdown',
      revision:1,
      deletedAt:null,
      updatedAt:'2026-09-22T12:00:00.000Z',
      updatedByDevice:deviceId,
      text:`# Note ${index}\n\nSynthetic replication payload.`,
      attachmentSha256:null,
      attachmentMimeType:null,
      attachmentSize:null,
    },
  };
});

let after='0';
const start=performance.now();
for(let offset=0;offset<TOTAL;offset+=PAGE){
  const pageEvents=events.slice(offset,offset+PAGE);
  const through=pageEvents.at(-1).sequence;
  const page=validateRemotePage({
    protocolVersion:1,
    vaultId,
    epoch,
    after,
    through,
    highWatermark:String(TOTAL),
    events:pageEvents,
  },{vaultId,epoch,after});
  assert.equal(page.events.length,PAGE);
  after=page.through;
}
const elapsedMs=performance.now()-start;
assert.equal(after,String(TOTAL));
assert.ok(elapsedMs<1_500,`10k remote event validation took ${elapsedMs.toFixed(1)} ms (limit 1500 ms)`);

console.log(JSON.stringify({
  events:TOTAL,
  pages:TOTAL/PAGE,
  elapsedMs:Number(elapsedMs.toFixed(1)),
},null,2));
