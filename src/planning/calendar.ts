import type { Entry, EntryId } from '../domain/model.js';
import type { KnowledgeRecord, KnowledgePropertyValue } from '../knowledge/types.js';
import { addLocalDays, dateKey, parseDateFilename, safeDailyFilename } from './templates.js';

export interface CalendarDay {
  date: Date;
  key: string;
  inMonth: boolean;
  isToday: boolean;
  dailyEntryId: EntryId | null;
  associatedEntryIds: EntryId[];
}

export interface CalendarMonth {
  year: number;
  month: number;
  label: string;
  days: CalendarDay[];
}

export interface CalendarOptions {
  dailyFolderId: EntryId | null;
  dailyFormat: string;
  today?: Date;
}

const dateValuePattern = /^\d{4}-\d{2}-\d{2}$/u;

function scalarDates(value: KnowledgePropertyValue): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((item): item is string => typeof item === 'string' && dateValuePattern.test(item));
}

export function dateAssociations(records: readonly KnowledgeRecord[]): Map<string, Set<EntryId>> {
  const map = new Map<string, Set<EntryId>>();
  for (const record of records) {
    for (const value of Object.values(record.properties)) {
      for (const key of scalarDates(value)) {
        const bucket = map.get(key) ?? new Set<EntryId>();
        bucket.add(record.entryId);
        map.set(key, bucket);
      }
    }
  }
  return map;
}

export function dailyEntryForDate(
  date: Date,
  entries: readonly Entry[],
  dailyFolderId: EntryId | null,
  dailyFormat: string,
): Entry | undefined {
  const expected = `${safeDailyFilename(date, dailyFormat)}.md`;
  return entries.find(entry =>
    entry.kind === 'markdown'
    && entry.deletedAt === null
    && entry.parentId === dailyFolderId
    && entry.name === expected
  );
}

export function dailyDateForEntry(entry: Entry, dailyFolderId: EntryId | null, dailyFormat: string): Date | null {
  if (entry.kind !== 'markdown' || entry.deletedAt !== null || entry.parentId !== dailyFolderId) return null;
  return parseDateFilename(entry.name, dailyFormat);
}

export function buildCalendarMonth(
  year: number,
  month: number,
  entries: readonly Entry[],
  records: readonly KnowledgeRecord[],
  options: CalendarOptions,
): CalendarMonth {
  const first = new Date(year, month, 1, 12, 0, 0, 0);
  const start = addLocalDays(first, -((first.getDay() + 6) % 7));
  const todayKey = dateKey(options.today ?? new Date());
  const associations = dateAssociations(records);
  const days: CalendarDay[] = [];
  for (let index = 0; index < 42; index++) {
    const date = addLocalDays(start, index);
    const key = dateKey(date);
    const daily = dailyEntryForDate(date, entries, options.dailyFolderId, options.dailyFormat);
    const associated = [...(associations.get(key) ?? new Set<EntryId>())]
      .filter(entryId => entryId !== daily?.id);
    days.push({
      date,
      key,
      inMonth: date.getMonth() === month,
      isToday: key === todayKey,
      dailyEntryId: daily?.id ?? null,
      associatedEntryIds: associated,
    });
  }
  return {
    year,
    month,
    label: new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(first),
    days,
  };
}
