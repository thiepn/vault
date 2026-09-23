import { performance } from 'node:perf_hooks';
import { CrdtTextDocument } from '../build/core/collaboration/crdt-text.js';

const base={entryId:'11111111-1111-4111-8111-111111111111',revision:1,fingerprint:'811c9dc5',text:''};
const leftUpdates=[];
const rightUpdates=[];
const left=new CrdtTextDocument(base,{onUpdate:update=>leftUpdates.push(update)});
const right=new CrdtTextDocument(base,{onUpdate:update=>rightUpdates.push(update)});

const edits=2500;
let leftText='';
let rightText='';
let start=performance.now();
for(let i=0;i<edits;i++){
  leftText+=String.fromCharCode(97+(i%26));
  left.applyLocalText(leftText);
  rightText=String.fromCharCode(65+(i%26))+rightText;
  right.applyLocalText(rightText);
}
const editMs=performance.now()-start;

start=performance.now();
for(const update of leftUpdates) right.applyRemoteUpdate(update);
for(const update of rightUpdates) left.applyRemoteUpdate(update);
const mergeMs=performance.now()-start;

if(left.value!==right.value) throw new Error('CRDT peers did not converge.');
if(left.value.length!==edits*2) throw new Error('CRDT benchmark lost text.');
if(editMs>3000) throw new Error(`CRDT edit benchmark exceeded 3000 ms: ${editMs.toFixed(1)} ms`);
if(mergeMs>3000) throw new Error(`CRDT merge benchmark exceeded 3000 ms: ${mergeMs.toFixed(1)} ms`);

console.log(JSON.stringify({
  localEdits:edits*2,
  updates:leftUpdates.length+rightUpdates.length,
  characters:left.value.length,
  editMs:Number(editMs.toFixed(1)),
  mergeMs:Number(mergeMs.toFixed(1)),
}));
left.destroy();right.destroy();
