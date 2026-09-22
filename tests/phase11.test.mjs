import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKnowledge } from '../build/core/knowledge/parser.js';
import { parseBoard, runBoard } from '../build/core/boards/kanban.js';
import { parseBoardFences } from '../build/core/editor/board-preview.js';

const vaultId = '11111111-1111-4111-8111-111111111111';
const now = '2026-09-22T00:00:00.000Z';

function entry(id, name) {
  return {
    id, vaultId, parentId:null, name, kind:'markdown',
    createdAt:now, updatedAt:now, localVersion:1,
    deletedAt:null, deletionBatch:null, activeKey:id,
  };
}

function record(e, text) {
  return parseKnowledge({ entryId:e.id, vaultId, localVersion:1, text });
}

test('Phase 11 parses a property-backed board definition', () => {
  const plan = parseBoard([
    'title: Projects',
    'query: tag:#project AND NOT property:archived=true',
    'group-by: property:status',
    'columns: backlog=Backlog, todo=To do, doing=Doing, done=Done',
    'card-fields: tags, property:priority, updated',
    'sort: property:priority asc',
    'limit: 300',
    'exclude-self: true',
    'uncategorized-label: Inbox',
    'layout: compact',
  ].join('\n'));

  assert.equal(plan.title, 'Projects');
  assert.equal(plan.groupProperty, 'status');
  assert.deepEqual(plan.columns.map(column => [column.value,column.label]), [
    ['backlog','Backlog'],['todo','To do'],['doing','Doing'],['done','Done'],
  ]);
  assert.equal(plan.limit, 300);
  assert.equal(plan.excludeSelf, true);
  assert.equal(plan.uncategorizedLabel, 'Inbox');
  assert.equal(plan.layout, 'compact');
});

test('board parser rejects non-property grouping and duplicate columns', () => {
  assert.throws(() => parseBoard('group-by: tag\n'), /group-by must be property/);
  assert.throws(() => parseBoard('columns: todo=To do, TODO=Again\n'), /Duplicate column value/);
  assert.throws(() => parseBoard('layout: grid\n'), /layout must be kanban or compact/);
});

test('board projection filters notes, preserves configured lane order and surfaces unexpected values', () => {
  const dashboard = entry('dashboard','Dashboard.md');
  const backlog = entry('backlog','Backlog.md');
  const doing = entry('doing','Doing.md');
  const review = entry('review','Review.md');
  const loose = entry('loose','Loose.md');
  const nonproject = entry('other','Other.md');
  const entries = [dashboard,backlog,doing,review,loose,nonproject];
  const records = [
    record(dashboard,'# Dashboard'),
    record(backlog,'---\ntags: [project]\nstatus: backlog\npriority: high\n---\n# Backlog'),
    record(doing,'---\ntags: [project]\nstatus: doing\n---\n# Doing'),
    record(review,'---\ntags: [project]\nstatus: review\n---\n# Review'),
    record(loose,'---\ntags: [project]\n---\n# Loose'),
    record(nonproject,'---\nstatus: backlog\n---\n# Other'),
  ];

  const plan = parseBoard([
    'query: tag:#project',
    'group-by: property:status',
    'columns: backlog=Backlog, todo=To do, doing=Doing, done=Done',
    'exclude-self: true',
  ].join('\n'));
  const result = runBoard(plan, entries, records, {
    currentEntryId:dashboard.id,
    pathOf:id => entries.find(item => item.id === id)?.name ?? id,
  });

  assert.deepEqual(result.columns.map(column => column.label), ['Backlog','To do','Doing','Done','review','Uncategorized']);
  assert.deepEqual(result.columns.map(column => column.cards.map(card => card.entryId)), [
    ['backlog'],[],['doing'],[],['review'],['loose'],
  ]);
  assert.equal(result.total, 4);
  assert.equal(result.shown, 4);
});

test('board can hide uncategorized notes without misreporting visible card count', () => {
  const assigned = entry('assigned','Assigned.md');
  const loose = entry('loose','Loose.md');
  const entries = [assigned,loose];
  const records = [
    record(assigned,'---\nstatus: todo\n---'),
    record(loose,'# Loose'),
  ];
  const plan = parseBoard([
    'group-by: property:status',
    'columns: todo, done',
    'show-uncategorized: false',
  ].join('\n'));
  const result = runBoard(plan, entries, records);
  assert.equal(result.total, 2);
  assert.equal(result.shown, 1);
  assert.equal(result.columns.length, 2);
});

test('board query and card fields reuse dynamic query semantics', () => {
  const high = entry('high','High.md');
  const low = entry('low','Low.md');
  const entries = [high,low];
  const records = [
    record(high,'---\ntags: [project/math]\nstatus: todo\npriority: high\n---\n- [ ] Ship'),
    record(low,'---\ntags: [project]\nstatus: done\npriority: low\n---'),
  ];
  const plan = parseBoard([
    'query: tag:#project AND property:priority=high AND task:open',
    'group-by: property:status',
    'columns: todo, done',
    'card-fields: property:priority, tasks, tags',
  ].join('\n'));
  const result = runBoard(plan, entries, records);
  assert.equal(result.total, 1);
  const card = result.columns[0].cards[0];
  assert.equal(card.entryId, high.id);
  assert.equal(card.values['property:priority'], 'high');
  assert.equal(card.values.tasks, '1');
  assert.match(card.values.tags, /#project\/math/);
});

test('Live Preview fence parser recognizes explicit vault-board fences only', () => {
  const source = [
    '# Board',
    '',
    '```vault-board',
    'group-by: property:status',
    'columns: todo, done',
    '```',
    '',
    '~~~VAULT-BOARD',
    'columns: backlog',
    '~~~',
    '',
    '```js',
    'vault-board',
    '```',
  ].join('\n');
  const fences = parseBoardFences(source);
  assert.equal(fences.length, 2);
  assert.match(fences[0].source, /property:status/);
  assert.equal(fences[1].source, 'columns: backlog');
});
