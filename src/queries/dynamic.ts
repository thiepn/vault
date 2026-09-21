import type { Entry, EntryId } from '../domain/model.js';
import type { KnowledgePropertyValue, KnowledgeRecord, KnowledgeScalar, KnowledgeTask } from '../knowledge/types.js';
import { parseSearchQuery, type SearchAst, type SearchClause } from '../search/query.js';
import { taskDateState, taskEffectiveDate, type TaskPriority } from '../tasks/markdown.js';

export type DynamicQueryView = 'list' | 'table' | 'tasks';
export type DynamicQueryTaskStatus = 'open' | 'done' | 'all';
export type DynamicQueryTaskDate = 'all' | 'overdue' | 'today' | 'upcoming' | 'undated';
export type DynamicQueryTaskPriority = 'all' | TaskPriority | 'none';
export type DynamicQueryField =
  | 'file'
  | 'path'
  | 'created'
  | 'updated'
  | 'tags'
  | 'aliases'
  | 'tasks'
  | `property:${string}`;

export interface DynamicQuerySort {
  field: 'file' | 'path' | 'created' | 'updated' | `property:${string}`;
  direction: 'asc' | 'desc';
}

export interface DynamicQueryPlan {
  view: DynamicQueryView;
  title: string | null;
  query: string;
  fields: DynamicQueryField[];
  sort: DynamicQuerySort;
  limit: number;
  excludeSelf: boolean;
  taskStatus: DynamicQueryTaskStatus;
  taskDate: DynamicQueryTaskDate;
  taskPriority: DynamicQueryTaskPriority;
}

export interface DynamicQueryNoteRow {
  kind: 'note';
  entryId: EntryId;
  title: string;
  path: string;
  values: Record<string, string>;
}

export interface DynamicQueryTaskRow {
  kind: 'task';
  entryId: EntryId;
  title: string;
  path: string;
  task: KnowledgeTask;
}

export interface DynamicQueryResult {
  plan: DynamicQueryPlan;
  notes: DynamicQueryNoteRow[];
  tasks: DynamicQueryTaskRow[];
  total: number;
  truncated: boolean;
}

export class DynamicQueryError extends Error {
  constructor(message: string, readonly line: number | null = null) {
    super(line === null ? message : `Line ${line}: ${message}`);
    this.name = 'DynamicQueryError';
  }
}

const fold = (value: string): string => value.normalize('NFC').toLocaleLowerCase();
const titleStem = (value: string): string => value.replace(/\.md$/iu, '');

function propertyValues(value: KnowledgePropertyValue | undefined): KnowledgeScalar[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function scalarString(value: KnowledgeScalar): string {
  if (value === null) return 'null';
  return String(value);
}

function scalarQueryValue(value: string): KnowledgeScalar {
  const trimmed = value.trim();
  if (/^true$/iu.test(trimmed)) return true;
  if (/^false$/iu.test(trimmed)) return false;
  if (/^(?:null|~)$/iu.test(trimmed)) return null;
  if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric;
  }
  return trimmed.replace(/^["']|["']$/gu, '');
}

function scalarEqual(left: KnowledgeScalar, right: KnowledgeScalar): boolean {
  if (typeof left === 'number' && typeof right === 'number') return left === right;
  if (typeof left === 'boolean' && typeof right === 'boolean') return left === right;
  if (left === null || right === null) return left === right;
  return fold(String(left)) === fold(String(right));
}

function compareScalar(left: KnowledgeScalar, operator: '>' | '>=' | '<' | '<=', right: KnowledgeScalar): boolean {
  if (typeof left === 'number' && typeof right === 'number') {
    if (operator === '>') return left > right;
    if (operator === '>=') return left >= right;
    if (operator === '<') return left < right;
    return left <= right;
  }
  const comparison = fold(String(left)).localeCompare(fold(String(right)));
  if (operator === '>') return comparison > 0;
  if (operator === '>=') return comparison >= 0;
  if (operator === '<') return comparison < 0;
  return comparison <= 0;
}

function wordTokens(value: string): string[] {
  return [...new Set((fold(value).match(/[\p{L}\p{N}_-]+/gu) ?? []).filter(Boolean))];
}

function propertyValue(record: KnowledgeRecord, name: string): KnowledgePropertyValue | undefined {
  const key = Object.keys(record.properties).find(candidate => fold(candidate) === fold(name));
  return key ? record.properties[key] : undefined;
}

function hasTaskClause(record: KnowledgeRecord, value: Extract<SearchClause, { kind: 'task' }>['value'], today: Date): boolean {
  const tasks = record.tasks;
  if (value === 'any') return tasks.length > 0;
  if (value === 'open') return tasks.some(task => !task.completed);
  if (value === 'done') return tasks.some(task => task.completed);
  if (value === 'recurring') return tasks.some(task => !task.completed && task.recurrence !== null);
  if (value === 'scheduled') return tasks.some(task => !task.completed && task.scheduled !== null);
  if (value === 'due') return tasks.some(task => !task.completed && task.due !== null);
  if (value === 'high' || value === 'medium' || value === 'low') {
    return tasks.some(task => !task.completed && task.priority === value);
  }
  return tasks.some(task => taskDateState(task, today) === value);
}

function searchableValues(entry: Entry, path: string, record: KnowledgeRecord): string[] {
  return [
    titleStem(entry.name),
    path,
    ...record.aliases,
    ...record.headings.map(heading => heading.text),
    record.bodyText,
    ...record.tasks.map(task => task.text),
    ...record.tags,
    ...Object.entries(record.properties).flatMap(([name, value]) => [name, ...propertyValues(value).map(scalarString)]),
  ];
}

function matchesClause(entry: Entry, path: string, record: KnowledgeRecord, clause: SearchClause, today: Date): boolean {
  if (clause.kind === 'tag') {
    const wanted = fold(clause.value.replace(/^#/u, ''));
    return record.tags.some(tag => {
      const candidate = fold(tag);
      return candidate === wanted || candidate.startsWith(wanted + '/');
    });
  }
  if (clause.kind === 'path') return fold(path).includes(fold(clause.value));
  if (clause.kind === 'file') return fold(titleStem(entry.name)).includes(fold(clause.value.replace(/\.md$/iu, '')));
  if (clause.kind === 'task') return hasTaskClause(record, clause.value, today);
  if (clause.kind === 'property') {
    const values = propertyValues(propertyValue(record, clause.name));
    if (clause.operator === 'exists') return values.length > 0;
    const queryValue = scalarQueryValue(clause.value ?? '');
    const operator = clause.operator;
    if (operator === '=') return values.some(value => scalarEqual(value, queryValue));
    if (operator === '!=') return values.length > 0 && values.every(value => !scalarEqual(value, queryValue));
    if (operator === '>' || operator === '>=' || operator === '<' || operator === '<=') {
      return values.some(value => compareScalar(value, operator, queryValue));
    }
    return false;
  }

  const haystacks = searchableValues(entry, path, record);
  const needle = fold(clause.value);
  if (clause.phrase) return haystacks.some(value => fold(value).includes(needle));
  const tokens = wordTokens(clause.value);
  if (!tokens.length) return true;
  const available = new Set(wordTokens(haystacks.join('\n')));
  return tokens.every(token => available.has(token));
}

function matchesAst(entry: Entry, path: string, record: KnowledgeRecord, ast: SearchAst | null, today: Date): boolean {
  if (!ast) return true;
  if (ast.kind === 'clause') return matchesClause(entry, path, record, ast.clause, today);
  if (ast.kind === 'and') return matchesAst(entry, path, record, ast.left, today) && matchesAst(entry, path, record, ast.right, today);
  if (ast.kind === 'or') return matchesAst(entry, path, record, ast.left, today) || matchesAst(entry, path, record, ast.right, today);
  return !matchesAst(entry, path, record, ast.value, today);
}

function parseBoolean(value: string, line: number): boolean {
  const folded = fold(value.trim());
  if (folded === 'true' || folded === 'yes' || folded === '1') return true;
  if (folded === 'false' || folded === 'no' || folded === '0') return false;
  throw new DynamicQueryError('Expected true or false.', line);
}

function validField(raw: string, line: number): DynamicQueryField {
  const value = raw.trim();
  if (value === 'file' || value === 'path' || value === 'created' || value === 'updated' || value === 'tags' || value === 'aliases' || value === 'tasks') return value;
  if (/^property:[A-Za-z0-9_.-]+$/u.test(value)) return value as `property:${string}`;
  throw new DynamicQueryError(`Unsupported field "${value}".`, line);
}

function parseSort(raw: string, line: number): DynamicQuerySort {
  const match = /^(file|path|created|updated|property:[A-Za-z0-9_.-]+)(?:\s+(asc|desc))?$/iu.exec(raw.trim());
  if (!match) throw new DynamicQueryError('Sort must be file, path, created, updated, or property:<name>, optionally followed by asc/desc.', line);
  const field = match[1]!.toLocaleLowerCase() as DynamicQuerySort['field'];
  const direction = (match[2]?.toLocaleLowerCase() ?? 'asc') as 'asc' | 'desc';
  return { field, direction };
}

export function parseDynamicQuery(source: string): DynamicQueryPlan {
  const plan: DynamicQueryPlan = {
    view: 'list',
    title: null,
    query: '',
    fields: ['file', 'path'],
    sort: { field: 'path', direction: 'asc' },
    limit: 50,
    excludeSelf: false,
    taskStatus: 'open',
    taskDate: 'all',
    taskPriority: 'all',
  };

  const seen = new Set<string>();
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const raw = lines[index]!;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('//') || /^#\s/u.test(trimmed)) continue;
    const match = /^([A-Za-z][A-Za-z-]*)\s*:\s*(.*)$/u.exec(trimmed);
    if (!match) throw new DynamicQueryError('Expected "key: value" syntax.', lineNumber);
    const key = match[1]!.toLocaleLowerCase();
    const value = match[2]!.trim();
    if (seen.has(key)) throw new DynamicQueryError(`Duplicate "${key}" setting.`, lineNumber);
    seen.add(key);

    if (key === 'view') {
      const candidate = value.toLocaleLowerCase();
      if (candidate !== 'list' && candidate !== 'table' && candidate !== 'tasks') throw new DynamicQueryError('View must be list, table, or tasks.', lineNumber);
      plan.view = candidate;
    } else if (key === 'title') {
      plan.title = value || null;
    } else if (key === 'query') {
      plan.query = value;
      if (value) {
        try { parseSearchQuery(value); } catch (error) {
          throw new DynamicQueryError(error instanceof Error ? error.message : 'Invalid search query.', lineNumber);
        }
      }
    } else if (key === 'fields') {
      const fields = value.split(',').map(item => item.trim()).filter(Boolean);
      if (!fields.length) throw new DynamicQueryError('Fields cannot be empty.', lineNumber);
      plan.fields = fields.map(field => validField(field, lineNumber));
    } else if (key === 'sort') {
      plan.sort = parseSort(value, lineNumber);
    } else if (key === 'limit') {
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new DynamicQueryError('Limit must be an integer from 1 to 200.', lineNumber);
      plan.limit = limit;
    } else if (key === 'exclude-self') {
      plan.excludeSelf = parseBoolean(value, lineNumber);
    } else if (key === 'task-status') {
      const candidate = value.toLocaleLowerCase();
      if (candidate !== 'open' && candidate !== 'done' && candidate !== 'all') throw new DynamicQueryError('task-status must be open, done, or all.', lineNumber);
      plan.taskStatus = candidate;
    } else if (key === 'task-date') {
      const candidate = value.toLocaleLowerCase();
      if (candidate !== 'all' && candidate !== 'overdue' && candidate !== 'today' && candidate !== 'upcoming' && candidate !== 'undated') throw new DynamicQueryError('task-date must be all, overdue, today, upcoming, or undated.', lineNumber);
      plan.taskDate = candidate;
    } else if (key === 'task-priority') {
      const candidate = value.toLocaleLowerCase();
      if (candidate !== 'all' && candidate !== 'high' && candidate !== 'medium' && candidate !== 'low' && candidate !== 'none') throw new DynamicQueryError('task-priority must be all, high, medium, low, or none.', lineNumber);
      plan.taskPriority = candidate;
    } else {
      throw new DynamicQueryError(`Unknown setting "${key}".`, lineNumber);
    }
  }

  if (plan.view === 'table' && !seen.has('fields')) plan.fields = ['file', 'path', 'tags'];
  return plan;
}

function displayDate(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/u.exec(value);
  return match?.[1] ?? value;
}

function displayProperty(value: KnowledgePropertyValue | undefined): string {
  return propertyValues(value).map(scalarString).join(', ');
}

export function dynamicFieldLabel(field: DynamicQueryField): string {
  if (field.startsWith('property:')) return field.slice('property:'.length);
  return field === 'file' ? 'File' :
    field === 'path' ? 'Path' :
    field === 'created' ? 'Created' :
    field === 'updated' ? 'Updated' :
    field === 'tags' ? 'Tags' :
    field === 'aliases' ? 'Aliases' : 'Tasks';
}

function fieldValue(field: DynamicQueryField, entry: Entry, path: string, record: KnowledgeRecord): string {
  if (field === 'file') return titleStem(entry.name);
  if (field === 'path') return path;
  if (field === 'created') return displayDate(entry.createdAt);
  if (field === 'updated') return displayDate(entry.updatedAt);
  if (field === 'tags') return record.tags.map(tag => '#' + tag).join(', ');
  if (field === 'aliases') return record.aliases.join(', ');
  if (field === 'tasks') {
    const open = record.tasks.filter(task => !task.completed).length;
    return record.tasks.length === open ? String(open) : `${open} open / ${record.tasks.length}`;
  }
  return displayProperty(propertyValue(record, field.slice('property:'.length)));
}

function sortValue(field: DynamicQuerySort['field'], entry: Entry, path: string, record: KnowledgeRecord): KnowledgeScalar {
  if (field === 'file') return titleStem(entry.name);
  if (field === 'path') return path;
  if (field === 'created') return entry.createdAt;
  if (field === 'updated') return entry.updatedAt;
  const value = propertyValue(record, field.slice('property:'.length));
  return propertyValues(value)[0] ?? null;
}

function compareSortValues(left: KnowledgeScalar, right: KnowledgeScalar): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
}

function priorityRank(priority: TaskPriority | null): number {
  return priority === 'high' ? 0 : priority === 'medium' ? 1 : priority === 'low' ? 2 : 3;
}

function matchesTaskFilters(task: KnowledgeTask, plan: DynamicQueryPlan, today: Date): boolean {
  if (plan.taskStatus === 'open' && task.completed) return false;
  if (plan.taskStatus === 'done' && !task.completed) return false;
  if (plan.taskDate !== 'all' && taskDateState(task, today) !== plan.taskDate) return false;
  if (plan.taskPriority !== 'all') {
    if (plan.taskPriority === 'none') {
      if (task.priority !== null) return false;
    } else if (task.priority !== plan.taskPriority) return false;
  }
  return true;
}

export function runDynamicQuery(
  plan: DynamicQueryPlan,
  entries: readonly Entry[],
  records: readonly KnowledgeRecord[],
  options: { currentEntryId?: EntryId; today?: Date; pathOf?: (entryId: EntryId) => string } = {},
): DynamicQueryResult {
  const today = options.today ?? new Date();
  const ast = plan.query ? parseSearchQuery(plan.query) : null;
  const recordById = new Map(records.map(record => [record.entryId, record]));
  const active = entries.filter(entry => entry.kind === 'markdown' && entry.deletedAt === null);
  const pathOf = options.pathOf ?? ((entryId: EntryId) => active.find(entry => entry.id === entryId)?.name ?? String(entryId));
  const candidates = active.flatMap(entry => {
    if (plan.excludeSelf && options.currentEntryId === entry.id) return [];
    const record = recordById.get(entry.id);
    if (!record) return [];
    const path = pathOf(entry.id);
    return matchesAst(entry, path, record, ast, today) ? [{ entry, record, path }] : [];
  });

  if (plan.view === 'tasks') {
    const rows: DynamicQueryTaskRow[] = candidates.flatMap(({ entry, record, path }) =>
      record.tasks
        .filter(task => matchesTaskFilters(task, plan, today))
        .map(task => ({ kind: 'task' as const, entryId: entry.id, title: titleStem(entry.name), path, task })),
    );
    rows.sort((left, right) => {
      if (left.task.completed !== right.task.completed) return left.task.completed ? 1 : -1;
      const leftDate = taskEffectiveDate(left.task) ?? '9999-99-99';
      const rightDate = taskEffectiveDate(right.task) ?? '9999-99-99';
      if (leftDate !== rightDate) return leftDate.localeCompare(rightDate);
      const priority = priorityRank(left.task.priority) - priorityRank(right.task.priority);
      if (priority) return priority;
      return left.path.localeCompare(right.path) || left.task.from - right.task.from;
    });
    const total = rows.length;
    return { plan, notes: [], tasks: rows.slice(0, plan.limit), total, truncated: total > plan.limit };
  }

  candidates.sort((left, right) => {
    const result = compareSortValues(
      sortValue(plan.sort.field, left.entry, left.path, left.record),
      sortValue(plan.sort.field, right.entry, right.path, right.record),
    );
    const directed = plan.sort.direction === 'asc' ? result : -result;
    return directed || left.path.localeCompare(right.path);
  });

  const total = candidates.length;
  const notes = candidates.slice(0, plan.limit).map(({ entry, record, path }): DynamicQueryNoteRow => ({
    kind: 'note',
    entryId: entry.id,
    title: titleStem(entry.name),
    path,
    values: Object.fromEntries(plan.fields.map(field => [field, fieldValue(field, entry, path, record)])),
  }));
  return { plan, notes, tasks: [], total, truncated: total > plan.limit };
}
