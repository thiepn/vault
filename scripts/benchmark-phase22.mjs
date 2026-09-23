import { performance } from 'node:perf_hooks';
import { buildMarkdownConflictPlan, resolveMarkdownConflictPlan } from '../build/core/sync/conflict-resolution.js';

const sections=140;
const expectedSemanticBlocks=sections*3;
const base=[];
for(let i=0;i<sections;i++){
  base.push('# Section '+i,'','Paragraph '+i+'.','','- item '+i,'- item '+(i+1),'');
}
const baseText=base.join('\n')+'\n';

const localLines=baseText.split('\n');
const remoteLines=baseText.split('\n');
for(let i=0;i<sections;i+=5){
  const marker='Paragraph '+i+'.';
  const li=localLines.indexOf(marker);
  if(li>=0) localLines[li]='Paragraph '+i+' local.';
}
for(let i=2;i<sections;i+=5){
  const marker='Paragraph '+i+'.';
  const ri=remoteLines.indexOf(marker);
  if(ri>=0) remoteLines[ri]='Paragraph '+i+' remote.';
}
for(let i=4;i<sections;i+=25){
  const marker='Paragraph '+i+'.';
  const li=localLines.indexOf(marker);
  const ri=remoteLines.indexOf(marker);
  if(li>=0) localLines[li]='Paragraph '+i+' local overlap.';
  if(ri>=0) remoteLines[ri]='Paragraph '+i+' remote overlap.';
}
const localText=localLines.join('\n');
const remoteText=remoteLines.join('\n');

const start=performance.now();
const plan=buildMarkdownConflictPlan(baseText,localText,remoteText);
const planMs=performance.now()-start;

if(plan.degraded) throw new Error('Conflict benchmark unexpectedly entered degraded mode.');
if(plan.segments.length<50) throw new Error('Conflict planner produced too few semantic segments.');
if(plan.conflictIds.length<1) throw new Error('Conflict benchmark did not produce overlapping conflicts.');

const choices=Object.fromEntries(plan.conflictIds.map(id=>[id,'local']));
const resolveStart=performance.now();
const resolved=resolveMarkdownConflictPlan(plan,choices);
const resolveMs=performance.now()-resolveStart;

if(!resolved.includes('local overlap')) throw new Error('Conflict resolution lost selected local text.');
if(planMs>2500) throw new Error(`Conflict planning exceeded 2500 ms: ${planMs.toFixed(1)} ms`);
if(resolveMs>250) throw new Error(`Conflict resolution exceeded 250 ms: ${resolveMs.toFixed(1)} ms`);

console.log(JSON.stringify({
  semanticBlocks:expectedSemanticBlocks,
  segments:plan.segments.length,
  conflicts:plan.conflictIds.length,
  degraded:plan.degraded,
  planMs:Number(planMs.toFixed(1)),
  resolveMs:Number(resolveMs.toFixed(1)),
}));
