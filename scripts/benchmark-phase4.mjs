import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { SearchEngine } from '../build/core/search/engine.js';

const engine = new SearchEngine();
const vaultId = 'benchmark-vault';
const count = 10_000;
const start = performance.now();

for (let index = 0; index < count; index++) {
  const subject = index % 20;
  const rating = index % 6;
  engine.upsertInput({
    entryId: 'note-' + index,
    vaultId,
    localVersion: 1,
    title: 'Note ' + index + '.md',
    path: 'University/Subject-' + subject + '/Note ' + index + '.md',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-09-20T12:00:00.000Z',
    text: [
      '---',
      'tags: [benchmark, subject/' + subject + ']',
      'status: ' + (index % 3 === 0 ? 'active' : 'reference'),
      'rating: ' + rating,
      '---',
      '# Note ' + index,
      'This synthetic note discusses continuity theorem number ' + index + ' and subject ' + subject + '.',
      index % 4 === 0 ? '- [ ] Review theorem ' + index : '- [x] Reviewed theorem ' + index,
    ].join('\n'),
  });
}

const indexedMs = performance.now() - start;
assert.equal(engine.stats().documents, count);

const queries = [
  'continuity theorem',
  'tag:#subject/7',
  'property:status=reference property:rating>=4',
  'task:open path:Subject-4',
  '"continuity theorem" NOT tag:#subject/3',
];

const queryTimes = [];
for (const query of queries) {
  const before = performance.now();
  const results = engine.search(query, 100);
  queryTimes.push(performance.now() - before);
  assert.ok(results.length > 0, 'Expected results for: ' + query);
}

const quickStart = performance.now();
const quick = engine.quickSwitch('Note 9999', [], 20);
const quickMs = performance.now() - quickStart;
assert.equal(quick[0]?.entryId, 'note-9999');

const worstQueryMs = Math.max(...queryTimes);
assert.ok(indexedMs < 20_000, '10k indexing exceeded 20s: ' + indexedMs.toFixed(1) + 'ms');
assert.ok(worstQueryMs < 1_000, 'Search query exceeded 1s: ' + worstQueryMs.toFixed(1) + 'ms');
assert.ok(quickMs < 1_000, 'Quick Switcher exceeded 1s: ' + quickMs.toFixed(1) + 'ms');

console.log(JSON.stringify({
  documents: count,
  indexedMs: Number(indexedMs.toFixed(1)),
  queryMs: queryTimes.map(value => Number(value.toFixed(1))),
  worstQueryMs: Number(worstQueryMs.toFixed(1)),
  quickMs: Number(quickMs.toFixed(1)),
  stats: engine.stats(),
}));
