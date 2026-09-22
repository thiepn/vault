export type TextMerge =
  | { kind: 'resolved'; text: string; reason: 'identical' | 'local-unchanged' | 'remote-unchanged' | 'non-overlapping' }
  | { kind: 'conflict'; base: string; local: string; remote: string };

interface EditSpan {
  start: number;
  end: number;
  replacement: string[];
}

function lineTokens(text: string): string[] {
  if (!text) return [];
  return text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
}

function editSpan(base: readonly string[], changed: readonly string[]): EditSpan | null {
  let prefix = 0;
  const maxPrefix = Math.min(base.length, changed.length);
  while (prefix < maxPrefix && base[prefix] === changed[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < base.length - prefix
    && suffix < changed.length - prefix
    && base[base.length - 1 - suffix] === changed[changed.length - 1 - suffix]
  ) suffix++;

  if (prefix === base.length && prefix === changed.length) return null;
  return {
    start: prefix,
    end: base.length - suffix,
    replacement: changed.slice(prefix, changed.length - suffix),
  };
}

function overlaps(left: EditSpan, right: EditSpan): boolean {
  const leftInsert = left.start === left.end;
  const rightInsert = right.start === right.end;
  if (leftInsert && rightInsert) return left.start === right.start;
  if (leftInsert) return left.start >= right.start && left.start <= right.end;
  if (rightInsert) return right.start >= left.start && right.start <= left.end;
  return left.start < right.end && right.start < left.end;
}

function applySpan(lines: string[], span: EditSpan): void {
  lines.splice(span.start, span.end - span.start, ...span.replacement);
}

/**
 * Conservative diff3 for Markdown text.
 *
 * Phase 16 automatically combines independent edits when each side's change can
 * be represented as one contiguous line span and those spans do not overlap.
 * Anything ambiguous remains a conflict; Vault never emits conflict markers into
 * canonical Markdown automatically.
 */
export function compareVersions(base: string, local: string, remote: string): TextMerge {
  if (local === remote) return { kind: 'resolved', text: local, reason: 'identical' };
  if (local === base) return { kind: 'resolved', text: remote, reason: 'local-unchanged' };
  if (remote === base) return { kind: 'resolved', text: local, reason: 'remote-unchanged' };

  const baseLines = lineTokens(base);
  const localSpan = editSpan(baseLines, lineTokens(local));
  const remoteSpan = editSpan(baseLines, lineTokens(remote));
  if (!localSpan || !remoteSpan || overlaps(localSpan, remoteSpan)) {
    return { kind: 'conflict', base, local, remote };
  }

  const merged = [...baseLines];
  const ordered = [localSpan, remoteSpan].sort((a, b) => b.start - a.start || b.end - a.end);
  for (const span of ordered) applySpan(merged, span);
  return { kind: 'resolved', text: merged.join(''), reason: 'non-overlapping' };
}
