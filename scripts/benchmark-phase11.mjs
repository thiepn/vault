import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { parseBoard, runBoard } from '../build/core/boards/kanban.js';

const COUNT = 10_000;
const vaultId = '11111111-1111-4111-8111-111111111111';
const now = '2026-09-22T00:00:00.000Z';
const statuses = ['backlog','todo','doing','done'];

const entries = Array.from({ length: COUNT }, (_, index) => ({
  id: `note-${index}`,
  vaultId,
  parentId: null,
  name: `Project ${String(index).padStart(5,'0')}.md`,
  kind: 'markdown',
  createdAt: now,
  updatedAt: now,
  localVersion: 1,
  deletedAt: null,
  deletionBatch: null,
  activeKey: `entry-${index}`,
}));

const records = entries.map((entry, index) => ({
  entryId: entry.id,
  vaultId,
  localVersion: 1,
  indexVersion: 5,
  aliases: [],
  tags: ['project', `team/${index % 10}`],
  properties: {
    status: statuses[index % statuses.length],
    priority: index % 3 === 0 ? 'high' : index % 3 === 1 ? 'medium' : 'low',
  },
  tasks: [],
  headings: [],
  blocks: [],
  links: [],
  searchText: `Project ${index}`,
  bodyText: `Project ${index}`,
}));

const plan = parseBoard([
  'query: tag:#project',
  'group-by: property:status',
  'columns: backlog, todo, doing, done',
  'card-fields: property:priority, tags',
  'sort: file asc',
  'limit: 500',
].join('\n'));

const start = performance.now();
const result = runBoard(plan, entries, records, { pathOf:id => id });
const elapsed = performance.now() - start;

assert.equal(result.total, COUNT);
assert.equal(result.shown, 500);
assert.equal(result.truncated, true);
assert.deepEqual(result.columns.map(column => column.cards.length), [125,125,125,125,0]);
assert.ok(elapsed < 750, `10k board projection took ${elapsed.toFixed(1)} ms (limit 750 ms)`);

console.log(JSON.stringify({
  notes: COUNT,
  shown: result.shown,
  lanes: result.columns.length,
  elapsedMs: Number(elapsed.toFixed(1)),
}, null, 2));
