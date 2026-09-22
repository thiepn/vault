import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { compareVersions } from '../build/core/sync/merge.js';

const lines=Array.from({length:20_000},(_,index)=>`line ${index}\n`);
const base=lines.join('');
const local=[...lines]; local[250]='line 250 local\n';
const remote=[...lines]; remote[19_500]='line 19500 remote\n';
const localText=local.join('');
const remoteText=remote.join('');

const started=performance.now();
for(let index=0;index<250;index++){
  const merged=compareVersions(base,localText,remoteText);
  assert.equal(merged.kind,'resolved');
  assert.ok(merged.text.includes('line 250 local\n'));
  assert.ok(merged.text.includes('line 19500 remote\n'));
}
const elapsed=performance.now()-started;
const budgetMs=4_000;
assert.ok(elapsed<budgetMs,`Phase 16 merge benchmark exceeded ${budgetMs} ms: ${elapsed.toFixed(1)} ms`);
console.log(`Phase 16 sync hardening benchmark: 250 merges of 20k-line Markdown in ${elapsed.toFixed(1)} ms`);
