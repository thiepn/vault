import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKnowledge } from '../build/core/knowledge/parser.js';
import { parseDynamicQuery, runDynamicQuery } from '../build/core/queries/dynamic.js';

const vaultId = '11111111-1111-4111-8111-111111111111';
const now = '2026-09-21T10:00:00.000Z';

function note(id, name, updatedAt = now) {
  return {
    id,
    vaultId,
    parentId: null,
    name,
    kind: 'markdown',
    createdAt: now,
    updatedAt,
    localVersion: 1,
    deletedAt: null,
    deletionBatch: null,
    activeKey: id,
  };
}

function record(entry, text) {
  return parseKnowledge({
    entryId: entry.id,
    vaultId,
    localVersion: entry.localVersion,
    text,
  });
}

test('Phase 8 parses strict Markdown-native dynamic query definitions', () => {
  const plan = parseDynamicQuery([
    'view: table',
    'title: Active projects',
    'query: tag:#project AND property:status=active',
    'fields: file, path, property:score, tags',
    'sort: property:score desc',
    'limit: 12',
    'exclude-self: yes',
  ].join('\n'));

  assert.equal(plan.view, 'table');
  assert.equal(plan.title, 'Active projects');
  assert.equal(plan.query, 'tag:#project AND property:status=active');
  assert.deepEqual(plan.fields, ['file', 'path', 'property:score', 'tags']);
  assert.deepEqual(plan.sort, { field: 'property:score', direction: 'desc' });
  assert.equal(plan.limit, 12);
  assert.equal(plan.excludeSelf, true);

  assert.throws(() => parseDynamicQuery('view: cards'), /View must be list, table, or tasks/u);
  assert.throws(() => parseDynamicQuery('limit: 0'), /1 to 200/u);
  assert.throws(() => parseDynamicQuery('mystery: value'), /Unknown setting/u);
  assert.throws(() => parseDynamicQuery('query: (tag:#work'), /closing parenthesis/iu);
});

test('dynamic table queries reuse search semantics and sort property values deterministically', () => {
  const alpha = note('alpha', 'Alpha.md', '2026-09-20T08:00:00.000Z');
  const bravo = note('bravo', 'Bravo.md', '2026-09-21T08:00:00.000Z');
  const archive = note('archive', 'Archive.md', '2026-09-19T08:00:00.000Z');
  const entries = [alpha, bravo, archive];
  const records = [
    record(alpha, '---\ntags: [project/math]\nstatus: active\nscore: 3\n---\n# Alpha'),
    record(bravo, '---\ntags: [project]\nstatus: active\nscore: 9\n---\n# Bravo'),
    record(archive, '---\ntags: [project]\nstatus: archived\nscore: 100\n---\n# Archive'),
  ];

  const plan = parseDynamicQuery([
    'view: table',
    'query: tag:#project AND property:status=active',
    'fields: file, property:score, tags',
    'sort: property:score desc',
    'limit: 1',
  ].join('\n'));

  const result = runDynamicQuery(plan, entries, records, { pathOf: id => `Folder/${entries.find(entry => entry.id === id).name}` });
  assert.equal(result.total, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0].title, 'Bravo');
  assert.equal(result.notes[0].values['property:score'], '9');
  assert.equal(result.notes[0].values.tags, '#project');
});

test('dynamic list queries support Boolean NOT, phrases, hierarchy and exclude-self', () => {
  const dashboard = note('dashboard', 'Dashboard.md');
  const math = note('math', 'Linear Algebra.md');
  const reading = note('reading', 'Reading.md');
  const entries = [dashboard, math, reading];
  const records = [
    record(dashboard, '# Dashboard'),
    record(math, '---\ntags: [study/math]\n---\n# Linear Algebra\nSpectral theorem notes'),
    record(reading, '---\ntags: [study/books]\n---\n# Reading\nSpectral theorem overview'),
  ];

  const plan = parseDynamicQuery([
    'view: list',
    'query: tag:#study AND "spectral theorem" NOT tag:#study/books',
    'exclude-self: true',
  ].join('\n'));

  const result = runDynamicQuery(plan, entries, records, {
    currentEntryId: dashboard.id,
    pathOf: id => entries.find(entry => entry.id === id).name,
  });
  assert.deepEqual(result.notes.map(row => row.title), ['Linear Algebra']);
});

test('dynamic task views filter canonical Markdown task projections without a task database', () => {
  const work = note('work', 'Work.md');
  const personal = note('personal', 'Personal.md');
  const entries = [work, personal];
  const records = [
    record(work, [
      '---',
      'tags: [work]',
      '---',
      '- [ ] Late critical @due(2026-09-20) @priority(high)',
      '- [ ] Today normal @due(2026-09-21) @priority(medium)',
      '- [x] Done critical @due(2026-09-20) @priority(high) @done(2026-09-20)',
    ].join('\n')),
    record(personal, [
      '---',
      'tags: [personal]',
      '---',
      '- [ ] Personal late @due(2026-09-20) @priority(high)',
    ].join('\n')),
  ];

  const plan = parseDynamicQuery([
    'view: tasks',
    'query: tag:#work',
    'task-status: open',
    'task-date: overdue',
    'task-priority: high',
    'limit: 20',
  ].join('\n'));

  const result = runDynamicQuery(plan, entries, records, {
    today: new Date(2026, 8, 21, 12),
    pathOf: id => entries.find(entry => entry.id === id).name,
  });
  assert.equal(result.total, 1);
  assert.equal(result.tasks[0].entryId, work.id);
  assert.equal(result.tasks[0].task.text, 'Late critical');
  assert.equal(result.tasks[0].task.raw, '- [ ] Late critical @due(2026-09-20) @priority(high)');
});

test('dynamic task query clauses select candidate notes while task row filters select rows', () => {
  const recurring = note('recurring', 'Recurring.md');
  const plain = note('plain', 'Plain.md');
  const entries = [recurring, plain];
  const records = [
    record(recurring, '- [ ] Weekly review @due(2026-09-21) @repeat(weekly)\n- [ ] Other task'),
    record(plain, '- [ ] One-off'),
  ];
  const plan = parseDynamicQuery([
    'view: tasks',
    'query: task:recurring',
    'task-status: open',
  ].join('\n'));
  const result = runDynamicQuery(plan, entries, records, {
    today: new Date(2026, 8, 21, 12),
    pathOf: id => entries.find(entry => entry.id === id).name,
  });
  assert.deepEqual(result.tasks.map(row => row.task.text), ['Weekly review', 'Other task']);
});
