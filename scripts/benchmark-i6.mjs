import { performance } from 'node:perf_hooks';
import { reconcileSyncEntityV2 } from '../build/core/sync/reconcile-v2.js';

const vaultId='22222222-2222-4222-8222-222222222222';
const noteId='55555555-5555-4555-8555-555555555555';
const at='2026-09-23T12:00:00.000Z';

function state(text){
  return {
    entryId:noteId,vaultId,entityType:'note',parentId:null,name:'Bench.md',
    createdAt:at,updatedAt:at,deletedAt:null,text,
  };
}
const paragraphs=Array.from({length:24},(_,i)=>`paragraph ${i} baseline text\n`);
const baseText=paragraphs.join('\n');
const base=state(baseText);
const iterations=10_000;
let conflicts=0;
let merged=0;
const started=performance.now();
for(let i=0;i<iterations;i++){
  const local=[...paragraphs];
  const remote=[...paragraphs];
  local[i%8]=`local ${i}\n`;
  remote[16+(i%8)]=`remote ${i}\n`;
  const result=reconcileSyncEntityV2(base,state(local.join('\n')),state(remote.join('\n')));
  if(result.kind==='conflict')conflicts++;
  if(result.kind==='merged')merged++;
}
const elapsed=performance.now()-started;
console.log(JSON.stringify({
  reconciliations:iterations,
  autoMerged:merged,
  conflicts,
  elapsedMs:Number(elapsed.toFixed(1)),
},null,2));
if(conflicts!==0)throw new Error(`I6 disjoint benchmark produced ${conflicts} conflicts`);
if(merged!==iterations)throw new Error(`I6 expected ${iterations} merged results, got ${merged}`);
if(elapsed>12_000)throw new Error(`I6 reconciliation benchmark regression: ${elapsed.toFixed(1)}ms`);
