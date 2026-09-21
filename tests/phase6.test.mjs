import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addLocalDays,
  dateKey,
  formatDatePattern,
  parseDateFilename,
  renderTemplate,
  safeDailyFilename,
} from '../build/core/planning/templates.js';
import {
  buildCalendarMonth,
  dailyDateForEntry,
  dailyEntryForDate,
  dateAssociations,
} from '../build/core/planning/calendar.js';
import { parseKnowledge } from '../build/core/knowledge/parser.js';

const vaultId = '11111111-1111-4111-8111-111111111111';
const now = '2026-09-21T10:00:00.000Z';

function note(id, name, parentId = null) {
  return { id, vaultId, parentId, name, kind: 'markdown', createdAt: now, updatedAt: now, localVersion: 1, deletedAt: null, deletionBatch: null, activeKey: id };
}

test('Phase 6 template engine expands deterministic variables and cursor', () => {
  const date = new Date(2026, 8, 21, 13, 5, 0, 0);
  const rendered = renderTemplate([
    '# {{title}}',
    '{{date}} {{time}} {{weekday}}',
    '{{yesterday}} -> {{tomorrow}}',
    '{{date:DD.MM.YYYY}}',
    '{{cursor}}body',
    '{{unknown}}',
  ].join('\n'), { title: 'Meeting', date });

  assert.equal(rendered.text.includes('# Meeting'), true);
  assert.equal(rendered.text.includes('2026-09-21 13:05 Monday'), true);
  assert.equal(rendered.text.includes('2026-09-20 -> 2026-09-22'), true);
  assert.equal(rendered.text.includes('21.09.2026'), true);
  assert.equal(rendered.text.includes('{{cursor}}'), false);
  assert.equal(rendered.text.includes('{{unknown}}'), true);
  assert.equal(rendered.cursorOffset, rendered.text.indexOf('body'));
});

test('date formatting and filename parsing round-trip supported formats', () => {
  const date = new Date(2026, 8, 21, 12, 0, 0, 0);
  assert.equal(dateKey(date), '2026-09-21');
  assert.equal(formatDatePattern(date, 'YYYY.MM.DD ddd'), '2026.09.21 Mon');
  assert.equal(safeDailyFilename(date, 'YYYY-MM-DD'), '2026-09-21');

  const parsed = parseDateFilename('2026-09-21.md', 'YYYY-MM-DD');
  assert.ok(parsed);
  assert.equal(dateKey(parsed), '2026-09-21');

  const parsedWithWeekday = parseDateFilename('2026.09.21 Mon.md', 'YYYY.MM.DD ddd');
  assert.ok(parsedWithWeekday);
  assert.equal(dateKey(parsedWithWeekday), '2026-09-21');

  assert.throws(() => safeDailyFilename(date, 'YYYY/MM/DD'));
});

test('local day navigation stays on calendar dates', () => {
  const march28 = new Date(2026, 2, 28, 12, 0, 0, 0);
  const next = addLocalDays(march28, 1);
  const again = addLocalDays(next, 1);
  assert.deepEqual([next.getFullYear(), next.getMonth(), next.getDate()], [2026, 2, 29]);
  assert.deepEqual([again.getFullYear(), again.getMonth(), again.getDate()], [2026, 2, 30]);
});

test('calendar associates every date-valued YAML property', () => {
  const records = [
    parseKnowledge({ entryId: 'a', vaultId, localVersion: 1, text: '---\ndue: 2026-09-21\n---\n# A' }),
    parseKnowledge({ entryId: 'b', vaultId, localVersion: 1, text: '---\ndates: [2026-09-21, 2026-09-22]\n---\n# B' }),
  ];
  const map = dateAssociations(records);
  assert.deepEqual([...map.get('2026-09-21') ?? []].sort(), ['a', 'b']);
  assert.deepEqual([...map.get('2026-09-22') ?? []], ['b']);
});

test('daily note identity is folder plus formatted filename', () => {
  const entries = [
    note('root-daily', '2026-09-21.md', null),
    note('folder-daily', '2026-09-21.md', 'daily'),
  ];
  const date = new Date(2026, 8, 21, 12, 0, 0, 0);
  assert.equal(dailyEntryForDate(date, entries, 'daily', 'YYYY-MM-DD')?.id, 'folder-daily');
  assert.equal(dailyEntryForDate(date, entries, null, 'YYYY-MM-DD')?.id, 'root-daily');
  assert.equal(dateKey(dailyDateForEntry(entries[1], 'daily', 'YYYY-MM-DD')), '2026-09-21');
  assert.equal(dailyDateForEntry(entries[0], 'daily', 'YYYY-MM-DD'), null);
});

test('calendar month is Monday-first, marks daily notes, today and associated notes', () => {
  const entries = [
    note('daily', '2026-09-21.md', 'daily-folder'),
    note('event', 'Event.md', null),
  ];
  const records = [
    parseKnowledge({ entryId: 'daily', vaultId, localVersion: 1, text: '---\ndate: 2026-09-21\n---\n# Daily' }),
    parseKnowledge({ entryId: 'event', vaultId, localVersion: 1, text: '---\ndue: 2026-09-21\n---\n# Event' }),
  ];
  const month = buildCalendarMonth(2026, 8, entries, records, {
    dailyFolderId: 'daily-folder',
    dailyFormat: 'YYYY-MM-DD',
    today: new Date(2026, 8, 21, 12, 0, 0, 0),
  });
  assert.equal(month.days.length, 42);
  assert.equal(month.days[0].date.getDay(), 1);
  const day = month.days.find(item => item.key === '2026-09-21');
  assert.ok(day);
  assert.equal(day.isToday, true);
  assert.equal(day.dailyEntryId, 'daily');
  assert.deepEqual(day.associatedEntryIds, ['event']);
});
