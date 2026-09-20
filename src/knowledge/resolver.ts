import type { Entry, EntryId } from '../domain/model.js';
import { VaultTree } from '../domain/tree.js';
import type { KnowledgeRecord, WikiResolution, WikiSuggestion } from './types.js';

const fold = (value: string): string => value.normalize('NFC').toLocaleLowerCase();
const stem = (name: string): string => name.replace(/\.md$/iu, '');
const withoutExtension = (path: string): string => path.replace(/\.md$/iu, '');

function recordMap(records: readonly KnowledgeRecord[]): Map<EntryId, KnowledgeRecord> {
  return new Map(records.map(record => [record.entryId, record]));
}

export function resolveWikiTarget(
  rawNote: string,
  currentEntryId: EntryId,
  entries: readonly Entry[],
  records: readonly KnowledgeRecord[],
  fragment: { heading: string | null; block: string | null } = { heading: null, block: null },
): WikiResolution {
  const active = entries.filter(entry => entry.kind === 'markdown' && entry.deletedAt === null);
  const byRecord = recordMap(records);
  if (!rawNote.trim()) return active.some(entry => entry.id === currentEntryId)
    ? { status: 'resolved', entryId: currentEntryId, ...fragment }
    : { status: 'unresolved' };

  const query = rawNote.replace(/\.md$/iu, '').replace(/^\.\//, '').trim();
  const q = fold(query);
  const tree = new VaultTree(entries);
  const current = active.find(entry => entry.id === currentEntryId);
  const currentParent = current?.parentId ?? null;
  const scored: Array<{ entryId: EntryId; score: number; path: string }> = [];

  for (const entry of active) {
    const path = withoutExtension(tree.path(entry.id));
    const title = stem(entry.name);
    const aliases = byRecord.get(entry.id)?.aliases ?? [];
    let score = -1;

    if (fold(path) === q) score = 120;
    else if (query.includes('/') && current) {
      const currentPath = withoutExtension(tree.path(current.id));
      const slash = currentPath.lastIndexOf('/');
      const relative = slash >= 0 ? `${currentPath.slice(0, slash)}/${query}` : query;
      if (fold(path) === fold(relative)) score = 115;
    } else if (entry.parentId === currentParent && fold(title) === q) score = 110;
    else if (fold(title) === q) score = 100;
    else if (aliases.some(alias => fold(alias) === q)) score = 95;

    if (score >= 0) scored.push({ entryId: entry.id, score, path });
  }

  if (!scored.length) return { status: 'unresolved' };
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  const best = scored[0]!.score;
  const tied = scored.filter(item => item.score === best);
  if (tied.length > 1) return { status: 'ambiguous', entryIds: tied.map(item => item.entryId) };
  return { status: 'resolved', entryId: scored[0]!.entryId, ...fragment };
}

export function wikiSuggestions(
  query: string,
  currentEntryId: EntryId,
  entries: readonly Entry[],
  records: readonly KnowledgeRecord[],
): WikiSuggestion[] {
  const active = entries.filter(entry => entry.kind === 'markdown' && entry.deletedAt === null);
  const tree = new VaultTree(entries);
  const byRecord = recordMap(records);
  const hash = query.indexOf('#');
  const noteQuery = (hash >= 0 ? query.slice(0, hash) : query).trim();
  const fragmentQuery = hash >= 0 ? query.slice(hash + 1) : null;

  if (fragmentQuery !== null) {
    const resolution = resolveWikiTarget(noteQuery, currentEntryId, entries, records);
    if (resolution.status !== 'resolved') return [];
    const record = byRecord.get(resolution.entryId);
    if (!record) return [];
    const notePrefix = noteQuery || '';
    const blockMode = fragmentQuery.startsWith('^');
    const fq = fold(blockMode ? fragmentQuery.slice(1) : fragmentQuery);
    const headingSuggestions = blockMode ? [] : record.headings
      .filter(heading => fold(heading.text).includes(fq))
      .slice(0, 40)
      .map((heading, index) => ({
        label: `${notePrefix}#${heading.text}`,
        insert: `${notePrefix}#${heading.text}`,
        detail: `Heading · H${heading.depth}`,
        boost: 80 - index,
      }));
    const blockSuggestions = record.blocks
      .filter(block => fold(block.id).includes(fq))
      .slice(0, 30)
      .map((block, index) => ({
        label: `${notePrefix}#^${block.id}`,
        insert: `${notePrefix}#^${block.id}`,
        detail: 'Block',
        boost: 60 - index,
      }));
    return [...headingSuggestions, ...blockSuggestions];
  }

  const q = fold(noteQuery);
  const suggestions: WikiSuggestion[] = [];
  for (const entry of active) {
    const title = stem(entry.name);
    const path = withoutExtension(tree.path(entry.id));
    const aliases = byRecord.get(entry.id)?.aliases ?? [];
    const titleFold = fold(title);
    const pathFold = fold(path);
    let boost = 0;
    if (!q) boost = 20;
    else if (titleFold === q) boost = 99;
    else if (titleFold.startsWith(q)) boost = 85;
    else if (aliases.some(alias => fold(alias) === q)) boost = 82;
    else if (aliases.some(alias => fold(alias).startsWith(q))) boost = 74;
    else if (titleFold.includes(q)) boost = 65;
    else if (pathFold.includes(q)) boost = 55;
    else if (aliases.some(alias => fold(alias).includes(q))) boost = 50;
    else continue;

    const duplicateTitles = active.filter(other => fold(stem(other.name)) === titleFold).length > 1;
    suggestions.push({
      label: title,
      insert: duplicateTitles ? path : title,
      detail: aliases.length ? `${path} · aliases: ${aliases.join(', ')}` : path,
      boost,
    });
    for (const alias of aliases) {
      if (!q || fold(alias).includes(q)) suggestions.push({
        label: alias,
        insert: duplicateTitles ? `${path}|${alias}` : `${title}|${alias}`,
        detail: `Alias · ${path}`,
        boost: Math.max(1, boost - 4),
      });
    }
  }
  return suggestions.sort((a, b) => b.boost - a.boost || a.label.localeCompare(b.label)).slice(0, 60);
}

export function canonicalWikiNote(entryId: EntryId, entries: readonly Entry[]): string {
  const active = entries.filter(entry => entry.kind === 'markdown' && entry.deletedAt === null);
  const target = active.find(entry => entry.id === entryId);
  if (!target) return '';
  const title = stem(target.name);
  const duplicates = active.filter(entry => fold(stem(entry.name)) === fold(title)).length;
  if (duplicates <= 1) return title;
  return withoutExtension(new VaultTree(entries).path(target.id));
}
