import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { validateOperation, validatePage, sealOperation } from '../build/core/sync/protocol.js';

const vaultId=crypto.randomUUID();
const deviceId=crypto.randomUUID();
const ownerId=crypto.randomUUID();
const epoch=crypto.randomUUID();

const operations=Array.from({length:10_000},(_,index)=>({
  protocolVersion:1,
  id:crypto.randomUUID(),
  vaultId,
  deviceId,
  ownerId,
  mutations:[{
    kind:'create',
    entryId:crypto.randomUUID(),
    parentId:null,
    name:`Note ${String(index).padStart(5,'0')}.md`,
    entryKind:'markdown',
    text:`# Note ${index}`,
  }],
}));

const validateStart=performance.now();
for(const operation of operations) validateOperation(operation);
const validateMs=performance.now()-validateStart;

let after='0';
let sequence=0;
const pages=[];
for(let pageIndex=0;pageIndex<100;pageIndex++){
  const events=[];
  for(let index=0;index<100;index++){
    sequence++;
    const operation=operations[sequence-1];
    events.push({
      sequence:String(sequence),
      operationId:operation.id,
      entryId:operation.mutations[0].entryId,
      revision:1,
      kind:'create',
    });
  }
  pages.push({protocolVersion:1,vaultId,epoch,after,through:String(sequence),highWatermark:String(sequence),events});
  after=String(sequence);
}
const pageStart=performance.now();
after='0';
for(const page of pages) after=validatePage(page,{vaultId,epoch,after});
const pageMs=performance.now()-pageStart;
assert.equal(after,'10000');

const sealStart=performance.now();
const sealed=await Promise.all(operations.slice(0,1000).map(operation=>sealOperation(operation)));
const sealMs=performance.now()-sealStart;
assert.equal(new Set(sealed.map(item=>item.sha256)).size,1000);

assert.ok(validateMs<1000,`10k operation validation took ${validateMs.toFixed(1)} ms`);
assert.ok(pageMs<500,`10k event page validation took ${pageMs.toFixed(1)} ms`);
assert.ok(sealMs<2500,`1k operation sealing took ${sealMs.toFixed(1)} ms`);

console.log(JSON.stringify({
  operations:operations.length,
  events:sequence,
  sealed:sealed.length,
  validateMs:Number(validateMs.toFixed(1)),
  pageMs:Number(pageMs.toFixed(1)),
  sealMs:Number(sealMs.toFixed(1)),
},null,2));
