export type MarkdownBlockKind =
  | 'frontmatter' | 'heading' | 'paragraph' | 'list' | 'quote' | 'code' | 'table' | 'thematic' | 'blank';

export interface MarkdownBlock {
  kind: MarkdownBlockKind;
  raw: string;
  label: string;
}

export interface ConflictEdit {
  start: number;
  end: number;
  replacement: MarkdownBlock[];
}

export type ConflictChoice = 'local' | 'remote' | 'base' | 'both-local-remote' | 'both-remote-local';

export interface ConflictPlanSegment {
  id: string;
  kind: 'unchanged' | 'auto-local' | 'auto-remote' | 'auto-identical' | 'conflict';
  label: string;
  base: string;
  local: string;
  remote: string;
}

export interface MarkdownConflictPlan {
  segments: ConflictPlanSegment[];
  conflictIds: string[];
  autoMergedText: string | null;
  degraded: boolean;
}

const MAX_LCS_BLOCKS = 450;
const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const TICK = String.fromCharCode(96);

function linesWithEndings(text: string): string[] {
  if (!text) return [];
  const result: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) !== 10) continue;
    result.push(text.slice(start, index + 1));
    start = index + 1;
  }
  if (start < text.length) result.push(text.slice(start));
  return result;
}

function lineBody(line: string): string {
  return line.endsWith(NL) ? line.slice(0, -1) : line;
}

function blank(line: string): boolean {
  return lineBody(line).trim() === '';
}

function leadingTrim(line: string): string {
  return lineBody(line).trimStart();
}

function fence(line: string): { mark: string; length: number } | null {
  const value = leadingTrim(line);
  const mark = value[0];
  if (mark !== TICK && mark !== '~') return null;
  let length = 0;
  while (value[length] === mark) length++;
  return length >= 3 ? { mark, length } : null;
}

function closesFence(line: string, opening: { mark: string; length: number }): boolean {
  const value = lineBody(line).trim();
  let count = 0;
  while (value[count] === opening.mark) count++;
  if (count < opening.length) return false;
  return value.slice(count).trim() === '';
}

function heading(line: string): boolean {
  const value = leadingTrim(line);
  let count = 0;
  while (value[count] === '#') count++;
  return count >= 1 && count <= 6 && value[count] === ' ';
}

function listLine(line: string): boolean {
  const value = leadingTrim(line);
  if (['-', '+', '*'].includes(value[0] ?? '') && value[1] === ' ') return true;
  let index = 0;
  while (index < value.length && value.charCodeAt(index) >= 48 && value.charCodeAt(index) <= 57) index++;
  return index > 0 && (value[index] === '.' || value[index] === ')') && value[index + 1] === ' ';
}

function quoteLine(line: string): boolean {
  return leadingTrim(line).startsWith('>');
}

function thematic(line: string): boolean {
  const value = lineBody(line).trim();
  let compact = '';
  for (const char of value) {
    if (char !== ' ' && char !== TAB) compact += char;
  }
  if (compact.length < 3) return false;
  return ['*', '-', '_'].includes(compact[0] ?? '') && [...compact].every(char => char === compact[0]);
}

function tableSeparator(line: string): boolean {
  let value = lineBody(line).trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);
  const cells = value.split('|').map(cell => cell.trim());
  if (cells.length < 2) return false;
  return cells.every(cell => {
    if (cell.startsWith(':')) cell = cell.slice(1);
    if (cell.endsWith(':')) cell = cell.slice(0, -1);
    return cell.length >= 3 && [...cell].every(char => char === '-');
  });
}

function tableLine(line: string): boolean {
  return line.includes('|') && !blank(line);
}

function firstContent(raw: string): string {
  const line = raw.split(NL).find(value => value.trim())?.trim() ?? '';
  return line.length > 72 ? line.slice(0, 69) + '…' : line;
}

function blockLabel(kind: MarkdownBlockKind, raw: string): string {
  const first = firstContent(raw);
  if (kind === 'frontmatter') return 'YAML frontmatter';
  if (kind === 'code') return first || 'Fenced code';
  if (kind === 'table') return first || 'Markdown table';
  if (kind === 'list') return first || 'List';
  if (kind === 'quote') return first || 'Blockquote';
  if (kind === 'heading') return first || 'Heading';
  if (kind === 'thematic') return 'Thematic break';
  if (kind === 'blank') return 'Spacing';
  return first || 'Paragraph';
}

function consumeTrailingBlanks(lines: string[], index: number): number {
  while (index < lines.length && blank(lines[index]!)) index++;
  return index;
}

export function splitMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = linesWithEndings(text);
  const result: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const start = index;
    let kind: MarkdownBlockKind = 'paragraph';

    if (index === 0 && lineBody(lines[index]!).trim() === '---') {
      kind = 'frontmatter';
      index++;
      while (index < lines.length) {
        const value = lineBody(lines[index]!).trim();
        index++;
        if (value === '---' || value === '...') break;
      }
      index = consumeTrailingBlanks(lines, index);
    } else if (blank(lines[index]!)) {
      kind = 'blank';
      index = consumeTrailingBlanks(lines, index);
    } else {
      const opening = fence(lines[index]!);
      if (opening) {
        kind = 'code';
        index++;
        while (index < lines.length) {
          const value = lines[index]!;
          index++;
          if (closesFence(value, opening)) break;
        }
        index = consumeTrailingBlanks(lines, index);
      } else if (heading(lines[index]!)) {
        kind = 'heading';
        index = consumeTrailingBlanks(lines, index + 1);
      } else if (thematic(lines[index]!)) {
        kind = 'thematic';
        index = consumeTrailingBlanks(lines, index + 1);
      } else if (listLine(lines[index]!)) {
        kind = 'list';
        index++;
        while (index < lines.length && !blank(lines[index]!)) {
          if (heading(lines[index]!) || fence(lines[index]!) || thematic(lines[index]!)) break;
          index++;
        }
        index = consumeTrailingBlanks(lines, index);
      } else if (quoteLine(lines[index]!)) {
        kind = 'quote';
        index++;
        while (index < lines.length && (quoteLine(lines[index]!) || blank(lines[index]!))) index++;
      } else if (
        index + 1 < lines.length
        && tableLine(lines[index]!)
        && tableSeparator(lines[index + 1]!)
      ) {
        kind = 'table';
        index += 2;
        while (index < lines.length && tableLine(lines[index]!)) index++;
        index = consumeTrailingBlanks(lines, index);
      } else {
        kind = 'paragraph';
        index++;
        while (index < lines.length && !blank(lines[index]!)) {
          if (
            heading(lines[index]!)
            || fence(lines[index]!)
            || thematic(lines[index]!)
            || listLine(lines[index]!)
            || quoteLine(lines[index]!)
          ) break;
          index++;
        }
        index = consumeTrailingBlanks(lines, index);
      }
    }

    const raw = lines.slice(start, index).join('');
    result.push({ kind, raw, label: blockLabel(kind, raw) });
  }

  return result;
}

function fallbackEdit(
  base: readonly MarkdownBlock[],
  changed: readonly MarkdownBlock[],
): ConflictEdit[] {
  let prefix = 0;
  while (
    prefix < base.length
    && prefix < changed.length
    && base[prefix]!.raw === changed[prefix]!.raw
  ) prefix++;

  let suffix = 0;
  while (
    suffix < base.length - prefix
    && suffix < changed.length - prefix
    && base[base.length - 1 - suffix]!.raw === changed[changed.length - 1 - suffix]!.raw
  ) suffix++;

  if (prefix === base.length && prefix === changed.length) return [];
  return [{
    start: prefix,
    end: base.length - suffix,
    replacement: changed.slice(prefix, changed.length - suffix),
  }];
}

export function diffMarkdownBlocks(
  base: readonly MarkdownBlock[],
  changed: readonly MarkdownBlock[],
): ConflictEdit[] {
  if (base.length > MAX_LCS_BLOCKS || changed.length > MAX_LCS_BLOCKS) {
    return fallbackEdit(base, changed);
  }

  const baseLength = base.length;
  const changedLength = changed.length;
  const matrix = Array.from(
    { length: baseLength + 1 },
    () => new Uint16Array(changedLength + 1),
  );

  for (let left = baseLength - 1; left >= 0; left--) {
    for (let right = changedLength - 1; right >= 0; right--) {
      matrix[left]![right] = base[left]!.raw === changed[right]!.raw
        ? matrix[left + 1]![right + 1]! + 1
        : Math.max(matrix[left + 1]![right]!, matrix[left]![right + 1]!);
    }
  }

  const matches: { base: number; changed: number }[] = [];
  let left = 0;
  let right = 0;
  while (left < baseLength && right < changedLength) {
    if (base[left]!.raw === changed[right]!.raw) {
      matches.push({ base: left, changed: right });
      left++;
      right++;
      continue;
    }
    if (matrix[left + 1]![right]! >= matrix[left]![right + 1]!) left++;
    else right++;
  }
  matches.push({ base: baseLength, changed: changedLength });

  const edits: ConflictEdit[] = [];
  let baseCursor = 0;
  let changedCursor = 0;
  for (const match of matches) {
    if (match.base > baseCursor || match.changed > changedCursor) {
      edits.push({
        start: baseCursor,
        end: match.base,
        replacement: changed.slice(changedCursor, match.changed),
      });
    }
    baseCursor = match.base + 1;
    changedCursor = match.changed + 1;
  }
  return edits;
}

function overlaps(left: ConflictEdit, right: ConflictEdit): boolean {
  const leftInsert = left.start === left.end;
  const rightInsert = right.start === right.end;
  if (leftInsert && rightInsert) return left.start === right.start;
  if (leftInsert) return left.start >= right.start && left.start <= right.end;
  if (rightInsert) return right.start >= left.start && right.start <= left.end;
  return left.start < right.end && right.start < left.end;
}

interface TaggedEdit extends ConflictEdit {
  side: 'local' | 'remote';
  index: number;
}
interface EditGroup {
  start: number;
  end: number;
  edits: TaggedEdit[];
}

function editGroups(local: ConflictEdit[], remote: ConflictEdit[]): EditGroup[] {
  const pending: TaggedEdit[] = [
    ...local.map((edit, index) => ({ ...edit, side: 'local' as const, index })),
    ...remote.map((edit, index) => ({ ...edit, side: 'remote' as const, index })),
  ].sort((a, b) => a.start - b.start || a.end - b.end || a.side.localeCompare(b.side));

  const groups: EditGroup[] = [];
  for (const edit of pending) {
    let target = groups.find(group => group.edits.some(existing => overlaps(existing, edit)));
    if (!target) {
      target = { start: edit.start, end: edit.end, edits: [] };
      groups.push(target);
    }

    target.edits.push(edit);
    target.start = Math.min(target.start, edit.start);
    target.end = Math.max(target.end, edit.end);

    for (let index = groups.length - 1; index >= 0; index--) {
      const other = groups[index]!;
      if (other === target) continue;
      if (other.edits.some(a => target!.edits.some(b => overlaps(a, b)))) {
        target.edits.push(...other.edits);
        target.start = Math.min(target.start, other.start);
        target.end = Math.max(target.end, other.end);
        groups.splice(index, 1);
      }
    }
  }

  return groups.sort((a, b) => a.start - b.start || a.end - b.end);
}

function variantForGroup(
  base: readonly MarkdownBlock[],
  group: EditGroup,
  side: 'local' | 'remote',
): string {
  const region = base.slice(group.start, group.end).map(block => block.raw);
  const edits = group.edits
    .filter(edit => edit.side === side)
    .sort((a, b) => b.start - a.start || b.end - a.end);

  for (const edit of edits) {
    const at = edit.start - group.start;
    region.splice(
      at,
      edit.end - edit.start,
      ...edit.replacement.map(block => block.raw),
    );
  }

  return region.join('');
}

function joinBlocks(
  blocks: readonly MarkdownBlock[],
  from: number,
  to: number,
): string {
  return blocks.slice(from, to).map(block => block.raw).join('');
}

function segmentLabel(base: readonly MarkdownBlock[], group: EditGroup): string {
  const source = base.slice(group.start, Math.max(group.end, group.start + 1));
  const label = source.find(block => block.kind !== 'blank')?.label;
  if (label) return label;

  const replacement = group.edits
    .flatMap(edit => edit.replacement)
    .find(block => block.kind !== 'blank');
  return replacement?.label ?? 'Inserted content';
}

export function buildMarkdownConflictPlan(
  baseText: string,
  localText: string,
  remoteText: string,
): MarkdownConflictPlan {
  if (localText === remoteText) {
    return {
      segments: [{
        id: 'segment-0',
        kind: 'auto-identical',
        label: 'Identical result',
        base: baseText,
        local: localText,
        remote: remoteText,
      }],
      conflictIds: [],
      autoMergedText: localText,
      degraded: false,
    };
  }

  if (localText === baseText) {
    return {
      segments: [{
        id: 'segment-0',
        kind: 'auto-remote',
        label: 'Remote change',
        base: baseText,
        local: localText,
        remote: remoteText,
      }],
      conflictIds: [],
      autoMergedText: remoteText,
      degraded: false,
    };
  }

  if (remoteText === baseText) {
    return {
      segments: [{
        id: 'segment-0',
        kind: 'auto-local',
        label: 'Local change',
        base: baseText,
        local: localText,
        remote: remoteText,
      }],
      conflictIds: [],
      autoMergedText: localText,
      degraded: false,
    };
  }

  const base = splitMarkdownBlocks(baseText);
  const local = splitMarkdownBlocks(localText);
  const remote = splitMarkdownBlocks(remoteText);
  const degraded = (
    base.length > MAX_LCS_BLOCKS
    || local.length > MAX_LCS_BLOCKS
    || remote.length > MAX_LCS_BLOCKS
  );

  const localEdits = diffMarkdownBlocks(base, local);
  const remoteEdits = diffMarkdownBlocks(base, remote);
  const groups = editGroups(localEdits, remoteEdits);

  const segments: ConflictPlanSegment[] = [];
  const conflictIds: string[] = [];
  let cursor = 0;
  let sequence = 0;

  for (const group of groups) {
    if (group.start > cursor) {
      const raw = joinBlocks(base, cursor, group.start);
      segments.push({
        id: 'segment-' + sequence++,
        kind: 'unchanged',
        label: 'Unchanged',
        base: raw,
        local: raw,
        remote: raw,
      });
    }

    const baseRaw = joinBlocks(base, group.start, group.end);
    const localChanges = group.edits.filter(edit => edit.side === 'local');
    const remoteChanges = group.edits.filter(edit => edit.side === 'remote');
    const localRaw = localChanges.length
      ? variantForGroup(base, group, 'local')
      : baseRaw;
    const remoteRaw = remoteChanges.length
      ? variantForGroup(base, group, 'remote')
      : baseRaw;

    let kind: ConflictPlanSegment['kind'];
    if (localChanges.length && remoteChanges.length) {
      kind = localRaw === remoteRaw ? 'auto-identical' : 'conflict';
    } else {
      kind = localChanges.length ? 'auto-local' : 'auto-remote';
    }

    const id = 'segment-' + sequence++;
    segments.push({
      id,
      kind,
      label: segmentLabel(base, group),
      base: baseRaw,
      local: localRaw,
      remote: remoteRaw,
    });
    if (kind === 'conflict') conflictIds.push(id);
    cursor = Math.max(cursor, group.end);
  }

  if (cursor < base.length) {
    const raw = joinBlocks(base, cursor, base.length);
    segments.push({
      id: 'segment-' + sequence++,
      kind: 'unchanged',
      label: 'Unchanged',
      base: raw,
      local: raw,
      remote: raw,
    });
  }

  const plan: MarkdownConflictPlan = {
    segments,
    conflictIds,
    autoMergedText: null,
    degraded,
  };
  if (!conflictIds.length) {
    plan.autoMergedText = resolveMarkdownConflictPlan(plan, {});
  }
  return plan;
}

function joinBoth(first: string, second: string): string {
  if (!first) return second;
  if (!second) return first;
  if (first.endsWith(NL) || second.startsWith(NL)) return first + second;
  return first + NL + second;
}

export function resolveMarkdownConflictPlan(
  plan: MarkdownConflictPlan,
  choices: Readonly<Record<string, ConflictChoice>>,
): string {
  const output: string[] = [];

  for (const segment of plan.segments) {
    if (segment.kind === 'unchanged') output.push(segment.base);
    else if (segment.kind === 'auto-local') output.push(segment.local);
    else if (segment.kind === 'auto-remote') output.push(segment.remote);
    else if (segment.kind === 'auto-identical') output.push(segment.local);
    else {
      const choice = choices[segment.id];
      if (!choice) throw new Error('Conflict choice is missing for ' + segment.id + '.');

      if (choice === 'local') output.push(segment.local);
      else if (choice === 'remote') output.push(segment.remote);
      else if (choice === 'base') output.push(segment.base);
      else if (choice === 'both-local-remote') {
        output.push(joinBoth(segment.local, segment.remote));
      } else {
        output.push(joinBoth(segment.remote, segment.local));
      }
    }
  }

  return output.join('');
}
