export interface TemplateContext {
  title: string;
  date: Date;
}

export interface RenderedTemplate {
  text: string;
  cursorOffset: number | null;
}

const tokenPattern = /\{\{\s*([^{}]+?)\s*\}\}/gu;
const datePatternTokens = ['YYYY', 'YY', 'MM', 'M', 'DD', 'D', 'dddd', 'ddd'] as const;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function englishWeekday(date: Date, style: 'long' | 'short'): string {
  return new Intl.DateTimeFormat('en-US', { weekday: style }).format(date);
}

export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function atLocalNoon(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
}

export function addLocalDays(date: Date, days: number): Date {
  const next = atLocalNoon(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function formatDatePattern(date: Date, pattern: string): string {
  const values: Record<(typeof datePatternTokens)[number], string> = {
    YYYY: String(date.getFullYear()),
    YY: pad(date.getFullYear() % 100),
    MM: pad(date.getMonth() + 1),
    M: String(date.getMonth() + 1),
    DD: pad(date.getDate()),
    D: String(date.getDate()),
    dddd: englishWeekday(date, 'long'),
    ddd: englishWeekday(date, 'short'),
  };
  const expression = new RegExp(datePatternTokens.join('|'), 'gu');
  return pattern.replace(expression, token => values[token as keyof typeof values] ?? token);
}

function formatTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function variable(name: string, context: TemplateContext): string | null {
  const key = name.trim();
  const lower = key.toLocaleLowerCase();
  if (lower === 'title') return context.title;
  if (lower === 'date') return dateKey(context.date);
  if (lower === 'time') return formatTime(context.date);
  if (lower === 'datetime') return `${dateKey(context.date)}T${formatTime(context.date)}`;
  if (lower === 'weekday') return englishWeekday(context.date, 'long');
  if (lower === 'year') return String(context.date.getFullYear());
  if (lower === 'month') return pad(context.date.getMonth() + 1);
  if (lower === 'day') return pad(context.date.getDate());
  if (lower === 'yesterday') return dateKey(addLocalDays(context.date, -1));
  if (lower === 'tomorrow') return dateKey(addLocalDays(context.date, 1));
  if (lower.startsWith('date:')) return formatDatePattern(context.date, key.slice(key.indexOf(':') + 1).trim());
  return null;
}

export function renderTemplate(source: string, context: TemplateContext): RenderedTemplate {
  let cursorOffset: number | null = null;
  let output = '';
  let last = 0;
  for (const match of source.matchAll(tokenPattern)) {
    if (match.index === undefined) continue;
    output += source.slice(last, match.index);
    const raw = match[1] ?? '';
    if (raw.trim().toLocaleLowerCase() === 'cursor') {
      if (cursorOffset === null) cursorOffset = output.length;
    } else {
      const resolved = variable(raw, context);
      output += resolved ?? match[0];
    }
    last = match.index + match[0].length;
  }
  output += source.slice(last);
  return { text: output, cursorOffset };
}

export function safeDailyFilename(date: Date, format = 'YYYY-MM-DD'): string {
  const hasYear = format.includes('YYYY') || format.includes('YY');
  const hasMonth = format.includes('MM') || format.includes('M');
  const hasDay = format.includes('DD') || format.includes('D');
  if (!hasYear || !hasMonth || !hasDay) {
    throw new Error('Daily note format must include year, month and day.');
  }
  const filename = formatDatePattern(date, format).trim();
  if (!filename || /[<>:"\/\\|?*\u0000-\u001F]/u.test(filename) || filename === '.' || filename === '..') {
    throw new Error('Daily note format creates an invalid portable filename.');
  }
  return filename;
}

export function parseDateFilename(filename: string, format = 'YYYY-MM-DD'): Date | null {
  const stem = filename.replace(/\.md$/iu, '');
  const groups: string[] = [];
  let expression = '^';
  for (let index = 0; index < format.length;) {
    const token = datePatternTokens.find(candidate => format.startsWith(candidate, index));
    if (!token) {
      const char = format[index]!;
      expression += char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      index++;
      continue;
    }
    if (token === 'YYYY') { expression += '(\\d{4})'; groups.push('YYYY'); }
    else if (token === 'YY') { expression += '(\\d{2})'; groups.push('YY'); }
    else if (token === 'MM' || token === 'M') { expression += token === 'MM' ? '(\\d{2})' : '(\\d{1,2})'; groups.push('M'); }
    else if (token === 'DD' || token === 'D') { expression += token === 'DD' ? '(\\d{2})' : '(\\d{1,2})'; groups.push('D'); }
    else if (token === 'dddd' || token === 'ddd') expression += '.+?';
    index += token.length;
  }
  expression += '$';
  const match = new RegExp(expression, 'u').exec(stem);
  if (!match) return null;
  let year = 0;
  let month = 1;
  let day = 1;
  groups.forEach((group, index) => {
    const value = Number(match[index + 1]);
    if (group === 'YYYY') year = value;
    else if (group === 'YY') year = 2000 + value;
    else if (group === 'M') month = value;
    else if (group === 'D') day = value;
  });
  if (!year) return null;
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}
