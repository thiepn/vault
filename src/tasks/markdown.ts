import { VaultError } from '../domain/errors.js';
import { newCanonicalId } from '../domain/canonical.js';

export type TaskPriority = 'high' | 'medium' | 'low';

export interface ParsedTaskLine {
  raw: string;
  text: string;
  completed: boolean;
  from: number;
  to: number;
  due: string | null;
  scheduled: string | null;
  priority: TaskPriority | null;
  recurrence: string | null;
  completedOn: string | null;
}

export interface TaskPatch {
  text?: string;
  completed?: boolean;
  due?: string | null;
  scheduled?: string | null;
  priority?: TaskPriority | null;
  recurrence?: string | null;
}

export interface TaskMutation {
  text: string;
  recurringTaskInserted: boolean;
}

const tokenPattern = /@(due|scheduled|priority|repeat|done)\(([^)\r\n]+)\)/giu;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const taskIdentityPattern = /\s*<!--\s*vault:task=([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\s*-->\s*$/iu;

export function taskIdentityFromRaw(raw: string): string | null {
  return taskIdentityPattern.exec(raw)?.[1]?.toLowerCase() ?? null;
}

function stripTaskIdentity(body: string): string {
  return body.replace(taskIdentityPattern, '').trimEnd();
}

export interface TaskIdentityReconciliation {
  text: string;
  changed: boolean;
  taskIds: string[];
}

export function ensureTaskIdentityMarkers(
  source: string,
  options: { completeLinesOnly?: boolean; rekey?: boolean; idFactory?: () => string } = {},
): TaskIdentityReconciliation {
  const completeLinesOnly = options.completeLinesOnly ?? false;
  const rekey = options.rekey ?? false;
  const idFactory = options.idFactory ?? (() => newCanonicalId('task'));
  const output: string[] = [];
  const taskIds: string[] = [];
  let cursor = 0;
  let inFrontmatter = source.startsWith('---\n') || source.startsWith('---\r\n');
  let frontmatterFirst = inFrontmatter;
  let fence: { char: '`' | '~'; size: number } | null = null;

  while (cursor < source.length) {
    const newline = source.indexOf('\n', cursor);
    const ended = newline >= 0;
    const end = ended ? newline : source.length;
    const rawSlice = source.slice(cursor, end);
    const cr = rawSlice.endsWith('\r') ? '\r' : '';
    const line = cr ? rawSlice.slice(0, -1) : rawSlice;
    let nextLine = line;

    if (inFrontmatter) {
      if (frontmatterFirst) {
        frontmatterFirst = false;
      } else if (line === '---') {
        inFrontmatter = false;
      }
    } else {
      const fenceToken = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        const escaped = fence.char === '`' ? '`' : '~';
        const close = new RegExp('^ {0,3}' + escaped + '{' + fence.size + ',}\\s*$').exec(line);
        if (close) fence = null;
      } else if (fenceToken) {
        fence = { char: fenceToken[1]![0] as '`' | '~', size: fenceToken[1]!.length };
      } else if (!completeLinesOnly || ended) {
        const parsed = parseTaskLine(line);
        if (parsed) {
          const existing = taskIdentityFromRaw(line);
          const identity = rekey || !existing ? idFactory() : existing;
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(identity)) {
            throw new VaultError('CORRUPT', 'Task identity factory returned an invalid UUID.');
          }
          taskIds.push(identity.toLowerCase());
          if (rekey || !existing) {
            const trailing = /[ \t]*$/u.exec(existing ? line.replace(taskIdentityPattern, '') : line)?.[0] ?? '';
            const stripped = existing ? line.replace(taskIdentityPattern, '') : line;
            const base = trailing.length ? stripped.slice(0, -trailing.length) : stripped;
            nextLine = `${base} <!-- vault:task=${identity.toLowerCase()} -->${trailing}`;
          }
        }
      }
    }

    output.push(nextLine, cr, ended ? '\n' : '');
    cursor = ended ? newline + 1 : source.length;
  }

  if (source.length === 0) return { text: source, changed: false, taskIds };
  const text = output.join('');
  return { text, changed: text !== source, taskIds };
}

export function rekeyTaskIdentityMarkers(source: string): TaskIdentityReconciliation {
  return ensureTaskIdentityMarkers(source, { rekey: true });
}

function localDateKey(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function isTaskDate(value: string | null | undefined): value is string {
  if (!value || !datePattern.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year!, month! - 1, day!, 12, 0, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month! - 1 && date.getDate() === day;
}

export function normalizeRecurrence(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = value.trim().toLocaleLowerCase().replace(/\s+/gu, ' ');
  if (['daily', 'weekly', 'monthly', 'yearly'].includes(raw)) return raw;
  const match = /^every\s+(\d+)\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)$/u.exec(raw);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isInteger(amount) || amount < 1 || amount > 999) return null;
  const unit = match[2]![0]!;
  return `every ${amount}${unit}`;
}

function normalizePriority(value: string): TaskPriority | null {
  const priority = value.trim().toLocaleLowerCase();
  return priority === 'high' || priority === 'medium' || priority === 'low' ? priority : null;
}

function metadataFromBody(body: string): {
  text: string;
  due: string | null;
  scheduled: string | null;
  priority: TaskPriority | null;
  recurrence: string | null;
  completedOn: string | null;
} {
  let due: string | null = null;
  let scheduled: string | null = null;
  let priority: TaskPriority | null = null;
  let recurrence: string | null = null;
  let completedOn: string | null = null;

  const text = stripTaskIdentity(body).replace(tokenPattern, (whole, rawName: string, rawValue: string) => {
    const name = rawName.toLocaleLowerCase();
    const value = rawValue.trim();
    if (name === 'due' && isTaskDate(value)) { due = value; return ''; }
    if (name === 'scheduled' && isTaskDate(value)) { scheduled = value; return ''; }
    if (name === 'done' && isTaskDate(value)) { completedOn = value; return ''; }
    if (name === 'priority') {
      const parsed = normalizePriority(value);
      if (parsed) { priority = parsed; return ''; }
      return whole;
    }
    if (name === 'repeat') {
      const parsed = normalizeRecurrence(value);
      if (parsed) { recurrence = parsed; return ''; }
      return whole;
    }
    return whole;
  }).replace(/\s{2,}/gu, ' ').trim();

  return { text, due, scheduled, priority, recurrence, completedOn };
}

export function parseTaskLine(line: string, from = 0): ParsedTaskLine | null {
  const match = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*?)(\s*)$/u.exec(line);
  if (!match) return null;
  const body = metadataFromBody(match[4]!);
  return {
    raw: line,
    completed: match[2]!.toLocaleLowerCase() === 'x',
    from,
    to: from + line.length,
    ...body,
  };
}

function taskPrefix(raw: string): { before: string; after: string } {
  const match = /^(\s*[-*+]\s+\[)[ xX](\]\s+)/u.exec(raw);
  if (!match) throw new VaultError('CORRUPT', 'The task line no longer has valid Markdown task syntax.');
  return { before: match[1]!, after: match[2]! };
}

function formatTask(
  source: ParsedTaskLine,
  values: {
    text: string;
    completed: boolean;
    due: string | null;
    scheduled: string | null;
    priority: TaskPriority | null;
    recurrence: string | null;
    completedOn: string | null;
  },
  taskId: string | null = taskIdentityFromRaw(source.raw),
): string {
  const prefix = taskPrefix(source.raw);
  const tokens: string[] = [];
  if (values.scheduled) tokens.push(`@scheduled(${values.scheduled})`);
  if (values.due) tokens.push(`@due(${values.due})`);
  if (values.priority) tokens.push(`@priority(${values.priority})`);
  if (values.recurrence) tokens.push(`@repeat(${values.recurrence})`);
  if (values.completedOn) tokens.push(`@done(${values.completedOn})`);
  const body = [values.text.trim(), ...tokens].filter(Boolean).join(' ');
  const identity = taskId ? ` <!-- vault:task=${taskId} -->` : '';
  return `${prefix.before}${values.completed ? 'x' : ' '}${prefix.after}${body}${identity}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0, 12, 0, 0, 0).getDate();
}

function addMonths(date: Date, months: number): Date {
  const day = date.getDate();
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1, 12, 0, 0, 0);
  target.setDate(Math.min(day, daysInMonth(target.getFullYear(), target.getMonth())));
  return target;
}

function advanceDate(value: string | null, recurrence: string): string | null {
  if (!value || !isTaskDate(value)) return value;
  const [year, month, day] = value.split('-').map(Number);
  let date = new Date(year!, month! - 1, day!, 12, 0, 0, 0);
  let amount = 1;
  let unit = recurrence;
  const custom = /^every\s+(\d+)([dwmy])$/u.exec(recurrence);
  if (custom) {
    amount = Number(custom[1]);
    unit = custom[2]!;
  } else if (recurrence === 'daily') unit = 'd';
  else if (recurrence === 'weekly') unit = 'w';
  else if (recurrence === 'monthly') unit = 'm';
  else if (recurrence === 'yearly') unit = 'y';

  if (unit === 'd') date.setDate(date.getDate() + amount);
  else if (unit === 'w') date.setDate(date.getDate() + amount * 7);
  else if (unit === 'm') date = addMonths(date, amount);
  else if (unit === 'y') date = addMonths(date, amount * 12);
  return localDateKey(date);
}

function locateTask(source: string, task: Pick<ParsedTaskLine, 'from' | 'to' | 'raw'>): {
  from: number;
  to: number;
  rawSlice: string;
  parsed: ParsedTaskLine;
} {
  const directSlice = source.slice(task.from, task.to);
  const directRaw = directSlice.replace(/\r$/u, '');
  if (directRaw === task.raw) {
    const parsed = parseTaskLine(task.raw, task.from);
    if (!parsed) throw new VaultError('CORRUPT', 'The task line is no longer valid.');
    return { from: task.from, to: task.to, rawSlice: directSlice, parsed };
  }

  const candidates: Array<{ from: number; to: number; rawSlice: string; parsed: ParsedTaskLine }> = [];
  let from = 0;
  while (from <= source.length) {
    const newline = source.indexOf('\n', from);
    const end = newline < 0 ? source.length : newline;
    const rawSlice = source.slice(from, end);
    const raw = rawSlice.replace(/\r$/u, '');
    if (raw === task.raw) {
      const parsed = parseTaskLine(raw, from);
      if (parsed) candidates.push({ from, to: from + raw.length, rawSlice: source.slice(from, from + raw.length), parsed });
    }
    if (newline < 0) break;
    from = newline + 1;
  }
  if (candidates.length !== 1) {
    throw new VaultError('STALE_WRITE', 'The task moved or changed. Refresh the Tasks view before editing it.');
  }
  return candidates[0]!;
}

export function updateTaskMarkdown(
  source: string,
  task: Pick<ParsedTaskLine, 'from' | 'to' | 'raw'>,
  patch: TaskPatch,
  now = new Date(),
): TaskMutation {
  const located = locateTask(source, task);
  const current = located.parsed;
  const recurrence = patch.recurrence === undefined ? current.recurrence : normalizeRecurrence(patch.recurrence);
  if (patch.recurrence && recurrence === null) throw new VaultError('CORRUPT', 'Use daily, weekly, monthly, yearly, or every Nd/Nw/Nm/Ny.');

  const due = patch.due === undefined ? current.due : patch.due;
  const scheduled = patch.scheduled === undefined ? current.scheduled : patch.scheduled;
  if (due !== null && !isTaskDate(due)) throw new VaultError('CORRUPT', 'Due date must use YYYY-MM-DD.');
  if (scheduled !== null && !isTaskDate(scheduled)) throw new VaultError('CORRUPT', 'Scheduled date must use YYYY-MM-DD');

  const nextCompleted = patch.completed ?? current.completed;
  const newlyCompleted = !current.completed && nextCompleted;
  const completedOn = nextCompleted ? (current.completedOn ?? localDateKey(now)) : null;
  const values = {
    text: patch.text === undefined ? current.text : patch.text.trim(),
    completed: nextCompleted,
    due,
    scheduled,
    priority: patch.priority === undefined ? current.priority : patch.priority,
    recurrence,
    completedOn,
  };
  if (!values.text) throw new VaultError('CORRUPT', 'Task text cannot be empty.');

  const formatted = formatTask(current, values);
  let replacement = formatted;
  let recurringTaskInserted = false;

  if (newlyCompleted && recurrence) {
    const inheritedIdentity = taskIdentityFromRaw(current.raw);
    const nextLine = formatTask(current, {
      ...values,
      completed: false,
      completedOn: null,
      due: advanceDate(due, recurrence),
      scheduled: advanceDate(scheduled, recurrence),
    }, inheritedIdentity ? newCanonicalId('task') : null);
    const lineEnding = source.includes('\r\n') ? '\r\n' : '\n';
    replacement = formatted + lineEnding + nextLine;
    recurringTaskInserted = true;
  }

  return {
    text: source.slice(0, located.from) + replacement + source.slice(located.to),
    recurringTaskInserted,
  };
}

export function taskEffectiveDate(task: Pick<ParsedTaskLine, 'due' | 'scheduled'>): string | null {
  return task.due ?? task.scheduled;
}

export function taskDateState(task: Pick<ParsedTaskLine, 'due' | 'scheduled' | 'completed'>, today = new Date()): 'overdue' | 'today' | 'upcoming' | 'undated' | 'done' {
  if (task.completed) return 'done';
  const value = taskEffectiveDate(task);
  if (!value) return 'undated';
  const todayKey = localDateKey(today);
  if (value < todayKey) return 'overdue';
  if (value === todayKey) return 'today';
  return 'upcoming';
}
