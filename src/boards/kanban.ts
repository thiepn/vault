import type { Entry, EntryId } from '../domain/model.js';
import type { KnowledgePropertyValue, KnowledgeRecord, KnowledgeScalar } from '../knowledge/types.js';
import {
  dynamicFieldLabel,
  runDynamicQuery,
  type DynamicQueryField,
  type DynamicQueryPlan,
  type DynamicQuerySort,
} from '../queries/dynamic.js';
import { parseSearchQuery } from '../search/query.js';

export type BoardLayout = 'kanban' | 'compact';

export interface BoardColumnSpec {
  value: string;
  label: string;
}

export interface BoardPlan {
  title: string | null;
  query: string;
  groupProperty: string;
  columns: BoardColumnSpec[];
  cardFields: DynamicQueryField[];
  sort: DynamicQuerySort;
  limit: number;
  excludeSelf: boolean;
  showUncategorized: boolean;
  uncategorizedLabel: string;
  layout: BoardLayout;
}

export interface BoardCard {
  entryId: EntryId;
  title: string;
  path: string;
  columnValue: string | null;
  values: Record<string, string>;
}

export interface BoardColumn {
  value: string | null;
  label: string;
  cards: BoardCard[];
  configured: boolean;
}

export interface BoardResult {
  plan: BoardPlan;
  columns: BoardColumn[];
  total: number;
  shown: number;
  truncated: boolean;
}

export class BoardError extends Error {
  constructor(message: string, readonly line: number | null = null) {
    super(line === null ? message : `Line ${line}: ${message}`);
    this.name = 'BoardError';
  }
}

const fold = (value: string): string => value.normalize('NFC').toLocaleLowerCase();

function parseBoolean(value: string, line: number): boolean {
  const folded = fold(value.trim());
  if (folded === 'true' || folded === 'yes' || folded === '1') return true;
  if (folded === 'false' || folded === 'no' || folded === '0') return false;
  throw new BoardError('Expected true or false.', line);
}

function validField(raw: string, line: number): DynamicQueryField {
  const value = raw.trim();
  if (
    value === 'file' || value === 'path' || value === 'created' || value === 'updated'
    || value === 'tags' || value === 'aliases' || value === 'tasks'
  ) return value;
  if (/^property:[A-Za-z0-9_.-]+$/u.test(value)) return value as `property:${string}`;
  throw new BoardError(`Unsupported card field "${value}".`, line);
}

function parseSort(raw: string, line: number): DynamicQuerySort {
  const match = /^(file|path|created|updated|property:[A-Za-z0-9_.-]+)(?:\s+(asc|desc))?$/iu.exec(raw.trim());
  if (!match) throw new BoardError('Sort must be file, path, created, updated, or property:<name>, optionally followed by asc/desc.', line);
  return {
    field: match[1]!.toLocaleLowerCase() as DynamicQuerySort['field'],
    direction: (match[2]?.toLocaleLowerCase() ?? 'asc') as 'asc' | 'desc',
  };
}

function parseColumns(raw: string, line: number): BoardColumnSpec[] {
  const values = raw.split(',').map(item => item.trim()).filter(Boolean);
  if (!values.length) throw new BoardError('Columns cannot be empty.', line);
  const columns: BoardColumnSpec[] = [];
  const keys = new Set<string>();
  for (const item of values) {
    const equals = item.indexOf('=');
    const value = (equals >= 0 ? item.slice(0, equals) : item).trim();
    const label = (equals >= 0 ? item.slice(equals + 1) : item).trim();
    if (!value) throw new BoardError('Each column requires a non-empty property value.', line);
    const key = fold(value);
    if (keys.has(key)) throw new BoardError(`Duplicate column value "${value}".`, line);
    keys.add(key);
    columns.push({ value, label: label || value });
  }
  return columns;
}

export function parseBoard(source: string): BoardPlan {
  const plan: BoardPlan = {
    title: null,
    query: '',
    groupProperty: 'status',
    columns: [],
    cardFields: ['tags', 'property:priority', 'updated'],
    sort: { field: 'updated', direction: 'desc' },
    limit: 200,
    excludeSelf: true,
    showUncategorized: true,
    uncategorizedLabel: 'Uncategorized',
    layout: 'kanban',
  };

  const seen = new Set<string>();
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const trimmed = lines[index]!.trim();
    if (!trimmed || trimmed.startsWith('//') || /^#\s/u.test(trimmed)) continue;
    const match = /^([A-Za-z][A-Za-z-]*)\s*:\s*(.*)$/u.exec(trimmed);
    if (!match) throw new BoardError('Expected "key: value" syntax.', lineNumber);
    const key = match[1]!.toLocaleLowerCase();
    const value = match[2]!.trim();
    if (seen.has(key)) throw new BoardError(`Duplicate "${key}" setting.`, lineNumber);
    seen.add(key);

    if (key === 'title') {
      plan.title = value || null;
    } else if (key === 'query') {
      plan.query = value;
      if (value) {
        try { parseSearchQuery(value); } catch (error) {
          throw new BoardError(error instanceof Error ? error.message : 'Invalid search query.', lineNumber);
        }
      }
    } else if (key === 'group-by') {
      const group = /^property:([A-Za-z0-9_.-]+)$/u.exec(value);
      if (!group) throw new BoardError('group-by must be property:<name> so lane moves can update canonical YAML.', lineNumber);
      plan.groupProperty = group[1]!;
    } else if (key === 'columns') {
      plan.columns = parseColumns(value, lineNumber);
    } else if (key === 'card-fields') {
      const fields = value.split(',').map(item => item.trim()).filter(Boolean);
      if (!fields.length) throw new BoardError('card-fields cannot be empty.', lineNumber);
      plan.cardFields = fields.map(field => validField(field, lineNumber));
    } else if (key === 'sort') {
      plan.sort = parseSort(value, lineNumber);
    } else if (key === 'limit') {
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new BoardError('limit must be an integer from 1 to 500.', lineNumber);
      plan.limit = limit;
    } else if (key === 'exclude-self') {
      plan.excludeSelf = parseBoolean(value, lineNumber);
    } else if (key === 'show-uncategorized') {
      plan.showUncategorized = parseBoolean(value, lineNumber);
    } else if (key === 'uncategorized-label') {
      if (!value) throw new BoardError('uncategorized-label cannot be empty.', lineNumber);
      plan.uncategorizedLabel = value;
    } else if (key === 'layout') {
      const layout = value.toLocaleLowerCase();
      if (layout !== 'kanban' && layout !== 'compact') throw new BoardError('layout must be kanban or compact.', lineNumber);
      plan.layout = layout;
    } else {
      throw new BoardError(`Unknown setting "${key}".`, lineNumber);
    }
  }
  return plan;
}

function propertyValue(record: KnowledgeRecord, name: string): KnowledgePropertyValue | undefined {
  const key = Object.keys(record.properties).find(candidate => fold(candidate) === fold(name));
  return key ? record.properties[key] : undefined;
}

function scalarString(value: KnowledgeScalar): string {
  return value === null ? 'null' : String(value);
}

function firstPropertyString(value: KnowledgePropertyValue | undefined): string | null {
  if (value === undefined) return null;
  const scalar = Array.isArray(value) ? value[0] : value;
  if (scalar === undefined || scalar === null || String(scalar).trim() === '') return null;
  return scalarString(scalar).trim();
}

function queryPlan(plan: BoardPlan): DynamicQueryPlan {
  const fields = [...new Set<DynamicQueryField>(['file', 'path', ...plan.cardFields])];
  return {
    view: 'list',
    title: plan.title,
    query: plan.query,
    fields,
    sort: plan.sort,
    limit: plan.limit,
    excludeSelf: plan.excludeSelf,
    taskStatus: 'open',
    taskDate: 'all',
    taskPriority: 'all',
  };
}

export function runBoard(
  plan: BoardPlan,
  entries: readonly Entry[],
  records: readonly KnowledgeRecord[],
  options: { currentEntryId?: EntryId; pathOf?: (entryId: EntryId) => string } = {},
): BoardResult {
  const result = runDynamicQuery(queryPlan(plan), entries, records, options);
  const recordsById = new Map(records.map(record => [record.entryId, record]));
  const configuredByKey = new Map(plan.columns.map(column => [fold(column.value), column]));
  const dynamicValues = new Map<string, string>();
  const cards: BoardCard[] = result.notes.map(row => {
    const record = recordsById.get(row.entryId);
    const columnValue = record ? firstPropertyString(propertyValue(record, plan.groupProperty)) : null;
    if (columnValue && !configuredByKey.has(fold(columnValue))) dynamicValues.set(fold(columnValue), columnValue);
    return {
      entryId: row.entryId,
      title: row.title,
      path: row.path,
      columnValue,
      values: row.values,
    };
  });

  const columns: BoardColumn[] = plan.columns.map(column => ({
    value: column.value,
    label: column.label,
    cards: [],
    configured: true,
  }));

  for (const value of [...dynamicValues.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))) {
    columns.push({ value, label: value, cards: [], configured: false });
  }
  if (plan.showUncategorized) {
    columns.push({ value: null, label: plan.uncategorizedLabel, cards: [], configured: false });
  }

  const byValue = new Map(columns.filter(column => column.value !== null).map(column => [fold(column.value!), column]));
  const uncategorized = columns.find(column => column.value === null);
  for (const card of cards) {
    const column = card.columnValue ? byValue.get(fold(card.columnValue)) : uncategorized;
    if (column) column.cards.push(card);
  }

  return {
    plan,
    columns,
    total: result.total,
    shown: cards.length,
    truncated: result.truncated,
  };
}

export function boardFieldLabel(field: DynamicQueryField): string {
  return dynamicFieldLabel(field);
}

export function boardMoveValue(column: BoardColumn): string | null {
  return column.value;
}
