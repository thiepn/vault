import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMarkdownConflictPlan,
  resolveMarkdownConflictPlan,
  splitMarkdownBlocks,
} from '../build/core/sync/conflict-resolution.js';

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
