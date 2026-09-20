import type { EntryId, VaultId } from '../domain/model.js';
import type { KnowledgeBlock, KnowledgeHeading, KnowledgeRecord, WikiReference } from './types.js';

interface Range { from: number; to: number }

function frontmatterRange(text: string): Range | null {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return null;
  const pattern = /^(?:---\r?\n)([\s\S]*?)(?:\r?\n---)(?:\r?\n|$)/;
  const match = pattern.exec(text);
  return match ? { from: 0, to: match[0].length } : null;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function aliasesFromFrontmatter(text: string, range: Range | null): string[] {
  if (!range) return [];
  const source = text.slice(range.from, range.to)
    .replace(/^---\r?\n/, '')
    .replace(/\r?\n---(?:\r?\n)?$/, '');
  const lines = source.split(/\r?\n/);
  const aliases: string[] = [];
  let collecting = false;
  for (const line of lines) {
    const key = /^\s*(aliases?|alias)\s*:\s*(.*)$/i.exec(line);
    if (key) {
      collecting = true;
      const value = key[2]!.trim();
      if (!value) continue;
      if (value.startsWith('[') && value.endsWith(']')) {
        for (const item of value.slice(1, -1).split(',')) {
          const alias = unquote(item);
          if (alias) aliases.push(alias);
        }
      } else {
        const alias = unquote(value);
        if (alias) aliases.push(alias);
      }
      continue;
    }
    if (collecting) {
      const item = /^\s*-\s+(.+?)\s*$/.exec(line);
      if (item) {
        const alias = unquote(item[1]!);
        if (alias) aliases.push(alias);
        continue;
      }
      if (/^\S/.test(line)) collecting = false;
    }
  }
  return [...new Set(aliases.map(alias => alias.trim()).filter(Boolean))];
}

function ignoredRanges(text: string, frontmatter: Range | null): Range[] {
  const ranges: Range[] = [];
  if (frontmatter) ranges.push(frontmatter);

  const rows: Array<{ from: number; raw: string; line: string }> = [];
  let from = 0;
  while (from <= text.length) {
    const newline = text.indexOf('\n', from);
    const end = newline < 0 ? text.length : newline + 1;
    const raw = text.slice(from, end);
    rows.push({ from, raw, line: raw.replace(/\r?\n$/, '') });
    if (newline < 0) break;
    from = end;
  }

  let fence: { char: '`' | '~'; size: number; from: number } | null = null;
  for (const row of rows) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(row.line);
    if (!fence && open) {
      fence = { char: open[1]![0] as '`' | '~', size: open[1]!.length, from: row.from };
      continue;
    }
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence.char}{${fence.size},}\\s*$`).exec(row.line);
      if (close) {
        ranges.push({ from: fence.from, to: row.from + row.raw.length });
        fence = null;
      }
    }
  }
  if (fence) ranges.push({ from: fence.from, to: text.length });

  let pos = 0;
  while (pos < text.length) {
    if (ranges.some(range => pos >= range.from && pos < range.to)) { pos++; continue; }
    if (text[pos] !== '`') { pos++; continue; }
    let size = 1;
    while (text[pos + size] === '`') size++;
    const marker = '`'.repeat(size);
    const end = text.indexOf(marker, pos + size);
    if (end < 0) { pos += size; continue; }
    ranges.push({ from: pos, to: end + size });
    pos = end + size;
  }
  for (const match of text.matchAll(/<!--[\s\S]*?-->/g)) {
    if (match.index !== undefined) ranges.push({ from: match.index, to: match.index + match[0].length });
  }
  return ranges.sort((a, b) => a.from - b.from);
}

function inside(ranges: readonly Range[], position: number): boolean {
  return ranges.some(range => position >= range.from && position < range.to);
}

function splitTarget(value: string): { note: string; heading: string | null; block: string | null } {
  const hash = value.indexOf('#');
  if (hash < 0) return { note: value.trim(), heading: null, block: null };
  const note = value.slice(0, hash).trim();
  const fragment = value.slice(hash + 1).trim();
  if (fragment.startsWith('^')) return { note, heading: null, block: fragment.slice(1).trim() || null };
  return { note, heading: fragment || null, block: null };
}

export function parseWikiReferences(text: string, ignored = ignoredRanges(text, frontmatterRange(text))): WikiReference[] {
  const references: WikiReference[] = [];
  for (let cursor = 0; cursor < text.length - 1;) {
    const open = text.indexOf('[[', cursor);
    if (open < 0) break;
    if (inside(ignored, open)) { cursor = open + 2; continue; }
    const embed = open > 0 && text[open - 1] === '!' && !inside(ignored, open - 1);
    const from = embed ? open - 1 : open;
    const close = text.indexOf(']]', open + 2);
    if (close < 0 || inside(ignored, close)) { cursor = open + 2; continue; }
    const innerFrom = open + 2;
    const innerTo = close;
    const inner = text.slice(innerFrom, innerTo);
    if (inner.includes('\n') || inner.includes('\r')) { cursor = close + 2; continue; }
    const pipe = inner.indexOf('|');
    const targetRaw = pipe >= 0 ? inner.slice(0, pipe) : inner;
    const targetText = targetRaw.trim();
    if (!targetText) { cursor = close + 2; continue; }
    const aliasRaw = pipe >= 0 ? inner.slice(pipe + 1) : '';
    const alias = pipe >= 0 ? aliasRaw.trim() || null : null;
    const targetLeading = targetRaw.length - targetRaw.trimStart().length;
    const aliasLeading = aliasRaw.length - aliasRaw.trimStart().length;
    const aliasFrom = pipe >= 0 && alias ? innerFrom + pipe + 1 + aliasLeading : null;
    const parts = splitTarget(targetText);
    references.push({
      raw: text.slice(from, close + 2),
      from,
      to: close + 2,
      innerFrom: innerFrom + targetLeading,
      innerTo,
      aliasFrom,
      pipeFrom: pipe >= 0 ? innerFrom + pipe : null,
      embed,
      targetText,
      note: parts.note,
      heading: parts.heading,
      block: parts.block,
      alias,
    });
    cursor = close + 2;
  }
  return references;
}

function lineRanges(text: string): Array<{ from: number; to: number; text: string }> {
  const rows: Array<{ from: number; to: number; text: string }> = [];
  let from = 0;
  while (from <= text.length) {
    const newline = text.indexOf('\n', from);
    const end = newline < 0 ? text.length : newline;
    rows.push({ from, to: end, text: text.slice(from, end).replace(/\r$/, '') });
    if (newline < 0) break;
    from = newline + 1;
  }
  return rows;
}

function parseHeadingsAndBlocks(text: string, ignored: readonly Range[]): { headings: KnowledgeHeading[]; blocks: KnowledgeBlock[] } {
  const headings: KnowledgeHeading[] = [];
  const blocks: KnowledgeBlock[] = [];
  for (const line of lineRanges(text)) {
    if (inside(ignored, line.from)) continue;
    const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line.text);
    if (heading) {
      const body = heading[2]!.trim();
      if (body) headings.push({ depth: heading[1]!.length, text: body, from: line.from, to: line.to, lineFrom: line.from, lineTo: line.to });
    }
    const block = /(?:^|\s)\^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\s*$/.exec(line.text);
    if (block) blocks.push({ id: block[1]!, from: line.from, to: line.to });
  }
  return { headings, blocks };
}

function makeSearchText(text: string, ignored: readonly Range[], links: readonly WikiReference[]): string {
  const chars = [...text];
  for (const range of [...ignored, ...links.map(link => ({ from: link.from, to: link.to }))]) {
    for (let index = range.from; index < range.to; index++) {
      if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
    }
  }
  return chars.join('');
}

export function parseKnowledge(input: {
  entryId: EntryId;
  vaultId: VaultId;
  localVersion: number;
  text: string;
}): KnowledgeRecord {
  const frontmatter = frontmatterRange(input.text);
  const ignored = ignoredRanges(input.text, frontmatter);
  const links = parseWikiReferences(input.text, ignored);
  const structure = parseHeadingsAndBlocks(input.text, ignored);
  return {
    entryId: input.entryId,
    vaultId: input.vaultId,
    localVersion: input.localVersion,
    aliases: aliasesFromFrontmatter(input.text, frontmatter),
    headings: structure.headings,
    blocks: structure.blocks,
    links,
    searchText: makeSearchText(input.text, ignored, links),
  };
}
