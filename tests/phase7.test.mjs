import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKnowledge } from '../build/core/knowledge/parser.js';
import {
  normalizeRecurrence,
  parseTaskLine,
  taskDateState,
  updateTaskMarkdown,
} from '../build/core/tasks/markdown.js';
import { SearchEngine } from '../build/core/search/engine.js';
import { parseSearchQuery } from '../build/core/search/query.js';
import { buildCalendarMonth } from '../build/core/planning/calendar.js';

const vaultId = '11111111-1111-4111-8111-111111111111';
const now = '2026-09-21T10:00:00.000Z';

function note(id, name, parentId = null) {
  return { id, vaultId, parentId, name, kind: 'markdown', createdAt: now, updatedAt: now, localVersion: 1, deletedAt: null, deletionBatch: null, activeKey: id };
}

test('Phase 7 parser keeps task truth in Markdown while extracting metadata', () => {
  const source = [
    '# Work',
    '- [ ] Ship report @scheduled(2026-09-20) @due(2026-09-21) @priority(high) @repeat(weekly)',
    '- [x] Archived task @done(2026-09-19)',
    '```md',
    '- [ ] ignored in code @due(2026-09-21)',
    '```',
  ].join('\n');
  const record = parseKnowledge({ entryId: 'work', vaultId, localVersion: 1, text: source });
  assert.equal(record.tasks.length, 2);
  assert.deepEqual(record.tasks[0], {
    raw: '- [ ] Ship report @scheduled(2026-09-20) @due(2026-09-21) @priority(high) @repeat(weekly)',
    text: 'Ship report',
    completed: false,
    from: source.indexOf('- [ ] Ship'),
    to: source.indexOf('- [ ] Ship') + '- [ ] Ship report @scheduled(2026-09-20) @due(2026-09-21) @priority(high) @repeat(weekly)'.length,
    due: '2026-09-21',
    scheduled: '2026-09-20',
    priority: 'high',
    recurrence: 'weekly',
    completedOn: null,
  });
  assert.equal(record.tasks[1].completed, true);
  assert.equal(record.tasks[1].completedOn, '2026-09-19');
});

test('task edits rewrite one Markdown line and preserve CRLF', () => {
  const source = '# Tasks\r\n- [ ] Write draft @due(2026-09-25)\r\nTail\r\n';
  const task = parseTaskLine('- [ ] Write draft @due(2026-09-25)', '# Tasks\r\n'.length);
  assert.ok(task);
  const mutation = updateTaskMarkdown(source, task, {
    text: 'Write final draft',
    scheduled: '2026-09-22',
    due: '2026-09-26',
    priority: 'medium',
  }, new Date(2026, 8, 21, 12));
  assert.equal(
    mutation.text,
    '# Tasks\r\n- [ ] Write final draft @scheduled(2026-09-22) @due(2026-09-26) @priority(medium)\r\nTail\r\n',
  );
  assert.equal(mutation.recurringTaskInserted, false);
});

test('completing a recurring task preserves history and creates the next occurrence', () => {
  const source = '- [ ] Review metrics @scheduled(2026-09-20) @due(2026-09-21) @priority(high) @repeat(weekly)\n';
  const task = parseTaskLine(source.trimEnd(), 0);
  assert.ok(task);
  const mutation = updateTaskMarkdown(source, task, { completed: true }, new Date(2026, 8, 21, 12));
  assert.equal(mutation.recurringTaskInserted, true);
  assert.equal(mutation.text, [
    '- [x] Review metrics @scheduled(2026-09-20) @due(2026-09-21) @priority(high) @repeat(weekly) @done(2026-09-21)',
    '- [ ] Review metrics @scheduled(2026-09-27) @due(2026-09-28) @priority(high) @repeat(weekly)',
    '',
  ].join('\n'));
});

test('monthly recurrence clamps end-of-month dates', () => {
  const source = '- [ ] Month end @due(2026-01-31) @repeat(monthly)';
  const task = parseTaskLine(source, 0);
  assert.ok(task);
  const mutation = updateTaskMarkdown(source, task, { completed: true }, new Date(2026, 0, 31, 12));
  assert.match(mutation.text, /@due\(2026-02-28\)/u);
});

test('task recurrence and date-state validation is deterministic', () => {
  assert.equal(normalizeRecurrence('Every 2 weeks'), 'every 2w');
  assert.equal(normalizeRecurrence('monthly'), 'monthly');
  assert.equal(normalizeRecurrence('sometimes'), null);
  assert.equal(taskDateState({ completed: false, due: '2026-09-20', scheduled: null }, new Date(2026, 8, 21, 12)), 'overdue');
  assert.equal(taskDateState({ completed: false, due: null, scheduled: '2026-09-21' }, new Date(2026, 8, 21, 12)), 'today');
  assert.equal(taskDateState({ completed: false, due: '2026-09-22', scheduled: null }, new Date(2026, 8, 21, 12)), 'upcoming');
  assert.equal(taskDateState({ completed: false, due: null, scheduled: null }, new Date(2026, 8, 21, 12)), 'undated');
});

test('search task filters understand task-management metadata', () => {
  const engine = new SearchEngine();
  const text = [
    '- [ ] Late task @due(2020-01-01) @priority(high)',
    '- [ ] Repeat me @repeat(daily)',
    '- [x] Done one @done(2026-09-20)',
  ].join('\n');
  engine.upsertInput({
    entryId: 'tasks',
    vaultId,
    localVersion: 1,
    title: 'Tasks.md',
    path: 'Tasks.md',
    createdAt: now,
    updatedAt: now,
    text,
  });
  for (const query of ['task:overdue', 'task:recurring', 'task:high', 'task:open', 'task:done']) {
    assert.deepEqual(engine.search(query).map(result => result.entryId), ['tasks'], query);
  }
  assert.deepEqual(parseSearchQuery('task:today'), { kind: 'clause', clause: { kind: 'task', value: 'today' } });
});

test('calendar exposes open scheduled and due tasks without creating event records', () => {
  const entries = [note('tasks', 'Tasks.md')];
  const record = parseKnowledge({
    entryId: 'tasks',
    vaultId,
    localVersion: 1,
    text: [
      '- [ ] Due @due(2026-09-21)',
      '- [ ] Scheduled @scheduled(2026-09-21)',
      '- [x] Completed @due(2026-09-21)',
    ].join('\n'),
  });
  const month = buildCalendarMonth(2026, 8, entries, [record], {
    dailyFolderId: null,
    dailyFormat: 'YYYY-MM-DD',
    today: new Date(2026, 8, 21, 12),
  });
  const day = month.days.find(item => item.key === '2026-09-21');
  assert.ok(day);
  assert.deepEqual(day.tasks.map(task => task.text).sort(), ['Due', 'Scheduled']);
});
