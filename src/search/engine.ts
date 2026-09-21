import { parseKnowledge } from '../knowledge/parser.js';
import { taskDateState } from '../tasks/markdown.js';
import type { EntryId } from '../domain/model.js';
import type { KnowledgePropertyValue, KnowledgeScalar } from '../knowledge/types.js';
import { parseSearchQuery, positiveClauses, type SearchAst, type SearchClause } from './query.js';
import type {
  PropertyFacet,
  QuickSwitchResult,
  SearchDocument,
  SearchFacets,
  SearchInput,
  SearchMatch,
  SearchMetadataUpdate,
  SearchResult,
  SearchStats,
  TagFacet,
} from './types.js';

const fold = (value: string): string => value.normalize('NFC').toLocaleLowerCase();
const titleStem = (value: string): string => value.replace(/\.md$/iu, '');

function wordTokens(value: string): string[] {
  return [...new Set((fold(value).match(/[\p{L}\p{N}_-]+/gu) ?? []).filter(Boolean))];
}

function tagKeys(value: string): string[] {
  const parts = value.replace(/^#/u, '').split('/').map(part => fold(part.trim())).filter(Boolean);
  const keys: string[] = [];
  for (let index = 1; index <= parts.length; index++) keys.push(parts.slice(0, index).join('/'));
  return keys;
}

function propertyValues(value: KnowledgePropertyValue | undefined): KnowledgeScalar[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function stringValue(value: KnowledgeScalar): string {
  if (value === null) return 'null';
  return String(value);
}

function escapeLiteral(value: string): string {
  const slash = String.fromCharCode(92);
  const special = new Set(['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', slash]);
  return [...value].map(character => special.has(character) ? slash + character : character).join('');
}

function literalMatches(source: string, needle: string, limit = 20): Array<{ from: number; to: number }> {
  if (!needle) return [];
  const expression = new RegExp(escapeLiteral(needle), 'giu');
  const matches: Array<{ from: number; to: number }> = [];
  for (const match of source.matchAll(expression)) {
    if (match.index === undefined) continue;
    matches.push({ from: match.index, to: match.index + match[0].length });
    if (matches.length >= limit) break;
  }
  return matches;
}

function setIntersection(left: Set<EntryId>, right: Set<EntryId>): Set<EntryId> {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  const result = new Set<EntryId>();
  for (const value of small) if (large.has(value)) result.add(value);
  return result;
}

function setUnion(left: Set<EntryId>, right: Set<EntryId>): Set<EntryId> {
  return new Set([...left, ...right]);
}

function fuzzyScore(query: string, value: string): number {
  const q = fold(query);
  const candidate = fold(value);
  if (!q) return 1;
  if (candidate === q) return 120;
  if (candidate.startsWith(q)) return 100 - Math.min(25, candidate.length - q.length);
  const direct = candidate.indexOf(q);
  if (direct >= 0) return 80 - Math.min(30, direct);
  let qIndex = 0;
  let first = -1;
  let gaps = 0;
  for (let index = 0; index < candidate.length && qIndex < q.length; index++) {
    if (candidate[index] === q[qIndex]) {
      if (first < 0) first = index;
      qIndex++;
    } else if (qIndex > 0) gaps++;
  }
  if (qIndex !== q.length) return -1;
  return Math.max(1, 55 - Math.min(35, gaps) - Math.min(10, first));
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

export function buildSearchDocument(input: SearchInput): SearchDocument {
  return {
    entryId: input.entryId,
    vaultId: input.vaultId,
    localVersion: input.localVersion,
    title: input.title,
    path: input.path,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    knowledge: parseKnowledge({
      entryId: input.entryId,
      vaultId: input.vaultId,
      localVersion: input.localVersion,
      text: input.text,
    }),
  };
}

export class SearchEngine {
  private documents = new Map<EntryId, SearchDocument>();
  private documentTokens = new Map<EntryId, Set<string>>();
  private inverted = new Map<string, Set<EntryId>>();
  private tags = new Map<string, Set<EntryId>>();
  private propertyNames = new Map<string, Set<EntryId>>();

  clear(): void {
    this.documents.clear();
    this.documentTokens.clear();
    this.inverted.clear();
    this.tags.clear();
    this.propertyNames.clear();
  }

  upsertInput(input: SearchInput): SearchDocument {
    const document = buildSearchDocument(input);
    this.upsert(document);
    return document;
  }

  upsert(document: SearchDocument): void {
    this.remove(document.entryId);
    this.documents.set(document.entryId, document);
    const searchable = [
      document.title,
      document.path,
      ...document.knowledge.aliases,
      ...document.knowledge.headings.map(heading => heading.text),
      document.knowledge.bodyText,
      ...document.knowledge.tags,
      ...document.knowledge.tasks.map(task => task.text),
      ...Object.entries(document.knowledge.properties).flatMap(([name, value]) => [name, ...propertyValues(value).map(stringValue)]),
    ].join('\n');
    const tokens = new Set(wordTokens(searchable));
    this.documentTokens.set(document.entryId, tokens);
    for (const token of tokens) {
      const bucket = this.inverted.get(token) ?? new Set<EntryId>();
      bucket.add(document.entryId);
      this.inverted.set(token, bucket);
    }
    for (const tag of document.knowledge.tags) {
      for (const key of tagKeys(tag)) {
        const bucket = this.tags.get(key) ?? new Set<EntryId>();
        bucket.add(document.entryId);
        this.tags.set(key, bucket);
      }
    }
    for (const name of Object.keys(document.knowledge.properties)) {
      const key = fold(name);
      const bucket = this.propertyNames.get(key) ?? new Set<EntryId>();
      bucket.add(document.entryId);
      this.propertyNames.set(key, bucket);
    }
  }

  updateMetadata(update: SearchMetadataUpdate): void {
    const current = this.documents.get(update.entryId);
    if (!current) return;
    this.upsert({ ...current, ...update });
  }

  remove(entryId: EntryId): void {
    const current = this.documents.get(entryId);
    if (!current) return;
    this.documents.delete(entryId);
    for (const token of this.documentTokens.get(entryId) ?? []) {
      const bucket = this.inverted.get(token);
      bucket?.delete(entryId);
      if (bucket?.size === 0) this.inverted.delete(token);
    }
    this.documentTokens.delete(entryId);
    for (const tag of current.knowledge.tags) {
      for (const key of tagKeys(tag)) {
        const bucket = this.tags.get(key);
        bucket?.delete(entryId);
        if (bucket?.size === 0) this.tags.delete(key);
      }
    }
    for (const name of Object.keys(current.knowledge.properties)) {
      const key = fold(name);
      const bucket = this.propertyNames.get(key);
      bucket?.delete(entryId);
      if (bucket?.size === 0) this.propertyNames.delete(key);
    }
  }

  search(query: string, limit = 100): SearchResult[] {
    const ast = parseSearchQuery(query);
    if (!ast) return [];
    const candidates = this.evaluate(ast);
    const clauses = positiveClauses(ast);
    return [...candidates]
      .map(entryId => this.documents.get(entryId))
      .filter((document): document is SearchDocument => document !== undefined)
      .map(document => this.resultFor(document, clauses))
      .sort((a, b) => b.score - a.score || b.matchCount - a.matchCount || a.path.localeCompare(b.path))
      .slice(0, Math.max(1, Math.min(limit, 500)));
  }

  quickSwitch(query: string, recent: readonly EntryId[] = [], limit = 50): QuickSwitchResult[] {
    const recentScore = new Map(recent.map((entryId, index) => [entryId, Math.max(0, 35 - index)]));
    const results: QuickSwitchResult[] = [];
    for (const document of this.documents.values()) {
      const title = titleStem(document.title);
      let best = fuzzyScore(query, title);
      let alias: string | null = null;
      for (const candidate of document.knowledge.aliases) {
        const score = fuzzyScore(query, candidate);
        if (score > best) { best = score; alias = candidate; }
      }
      best = Math.max(best, fuzzyScore(query, document.path) - 8);
      if (best < 0) continue;
      results.push({ entryId: document.entryId, title, path: document.path, alias, score: best + (recentScore.get(document.entryId) ?? 0) });
    }
    return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
  }

  facets(): SearchFacets {
    const tags: TagFacet[] = [...this.tags.entries()].map(([tag, entries]) => ({ tag, count: entries.size }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    const properties: PropertyFacet[] = [...this.propertyNames.entries()].map(([name, entries]) => ({ name, count: entries.size }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return { tags, properties };
  }

  stats(): SearchStats {
    return { documents: this.documents.size, tokens: this.inverted.size, tags: this.tags.size, properties: this.propertyNames.size };
  }

  private allIds(): Set<EntryId> {
    return new Set(this.documents.keys());
  }

  private evaluate(ast: SearchAst): Set<EntryId> {
    if (ast.kind === 'clause') return this.evaluateClause(ast.clause);
    if (ast.kind === 'and') return setIntersection(this.evaluate(ast.left), this.evaluate(ast.right));
    if (ast.kind === 'or') return setUnion(this.evaluate(ast.left), this.evaluate(ast.right));
    const result = this.allIds();
    for (const entryId of this.evaluate(ast.value)) result.delete(entryId);
    return result;
  }

  private evaluateClause(clause: SearchClause): Set<EntryId> {
    if (clause.kind === 'tag') return new Set(this.tags.get(fold(clause.value.replace(/^#/u, ''))) ?? []);
    if (clause.kind === 'path') {
      const value = fold(clause.value);
      return new Set([...this.documents.values()].filter(document => fold(document.path).includes(value)).map(document => document.entryId));
    }
    if (clause.kind === 'file') {
      const value = fold(clause.value.replace(/\.md$/iu, ''));
      return new Set([...this.documents.values()].filter(document => fold(titleStem(document.title)).includes(value)).map(document => document.entryId));
    }
    if (clause.kind === 'task') {
      return new Set([...this.documents.values()].filter(document => {
        const tasks = document.knowledge.tasks;
        if (clause.value === 'any') return tasks.length > 0;
        if (clause.value === 'open') return tasks.some(task => !task.completed);
        if (clause.value === 'done') return tasks.some(task => task.completed);
        if (clause.value === 'recurring') return tasks.some(task => !task.completed && task.recurrence !== null);
        if (clause.value === 'scheduled') return tasks.some(task => !task.completed && task.scheduled !== null);
        if (clause.value === 'due') return tasks.some(task => !task.completed && task.due !== null);
        if (clause.value === 'high' || clause.value === 'medium' || clause.value === 'low') {
          return tasks.some(task => !task.completed && task.priority === clause.value);
        }
        return tasks.some(task => taskDateState(task) === clause.value);
      }).map(document => document.entryId));
    }
    if (clause.kind === 'property') {
      const key = fold(clause.name);
      const ids = this.propertyNames.get(key) ?? new Set<EntryId>();
      const operator = clause.operator;
      if (operator === 'exists') return new Set(ids);
      const queryValue = scalarQueryValue(clause.value ?? '');
      return new Set([...ids].filter(entryId => {
        const document = this.documents.get(entryId);
        if (!document) return false;
        const actualName = Object.keys(document.knowledge.properties).find(name => fold(name) === key);
        const values = propertyValues(actualName ? document.knowledge.properties[actualName] : undefined);
        if (operator === '=') return values.some(value => scalarEqual(value, queryValue));
        if (operator === '!=') return values.length > 0 && values.every(value => !scalarEqual(value, queryValue));
        if (operator === '>' || operator === '>=' || operator === '<' || operator === '<=') {
          return values.some(value => compareScalar(value, operator, queryValue));
        }
        return false;
      }));
    }
    const tokens = wordTokens(clause.value);
    let candidate: Set<EntryId> | null = null;
    for (const token of tokens) {
      const bucket = new Set(this.inverted.get(token) ?? []);
      candidate = candidate === null ? bucket : setIntersection(candidate, bucket);
      if (candidate.size === 0) break;
    }
    candidate ??= this.allIds();
    const needle = fold(clause.value);
    return new Set([...candidate].filter(entryId => {
      const document = this.documents.get(entryId);
      if (!document) return false;
      if (!clause.phrase && tokens.length > 0) return true;
      return this.haystacks(document).some(value => fold(value).includes(needle));
    }));
  }

  private haystacks(document: SearchDocument): string[] {
    return [
      titleStem(document.title), document.path, ...document.knowledge.aliases,
      ...document.knowledge.headings.map(heading => heading.text), document.knowledge.bodyText,
      ...document.knowledge.tasks.map(task => task.text), ...document.knowledge.tags,
      ...Object.entries(document.knowledge.properties).flatMap(([name, value]) => [name, ...propertyValues(value).map(stringValue)]),
    ];
  }

  private resultFor(document: SearchDocument, clauses: readonly SearchClause[]): SearchResult {
    let score = 0;
    let matchCount = 0;
    const matches: SearchMatch[] = [];
    for (const clause of clauses) {
      if (clause.kind === 'text') {
        const title = titleStem(document.title);
        const needle = clause.value;
        const foldedNeedle = fold(needle);
        if (fold(title) === foldedNeedle) score += 120;
        else if (fold(title).startsWith(foldedNeedle)) score += 80;
        else if (fold(title).includes(foldedNeedle)) score += 55;
        if (fold(document.path).includes(foldedNeedle)) {
          score += 24;
          matches.push({ field: 'path', from: null, to: null, text: document.path });
        }
        for (const alias of document.knowledge.aliases) {
          if (fold(alias) === foldedNeedle) { score += 70; matches.push({ field: 'alias', from: null, to: null, text: alias }); }
          else if (fold(alias).includes(foldedNeedle)) {
            score += 30;
            matches.push({ field: 'alias', from: null, to: null, text: alias });
          }
        }
        for (const heading of document.knowledge.headings) {
          if (fold(heading.text).includes(foldedNeedle)) {
            score += 28;
            matches.push({ field: 'heading', from: heading.from, to: heading.to, text: heading.text });
          }
        }
        const bodyMatches = literalMatches(document.knowledge.bodyText, needle, 20);
        matchCount += bodyMatches.length;
        if (bodyMatches.length) {
          score += 18 + Math.min(30, bodyMatches.length * 3);
          for (const match of bodyMatches.slice(0, 6)) {
            matches.push({ field: 'body', from: match.from, to: match.to, text: document.knowledge.bodyText.slice(match.from, match.to) });
          }
        }
        for (const tag of document.knowledge.tags) {
          if (fold(tag).includes(foldedNeedle)) {
            score += 22;
            matches.push({ field: 'tag', from: null, to: null, text: '#' + tag });
          }
        }
        for (const task of document.knowledge.tasks) {
          if (fold(task.text).includes(foldedNeedle)) {
            score += 20;
            matches.push({ field: 'task', from: task.from, to: task.to, text: task.text });
          }
        }
        for (const [name, property] of Object.entries(document.knowledge.properties)) {
          const values = propertyValues(property);
          if (fold(name).includes(foldedNeedle) || values.some(value => fold(stringValue(value)).includes(foldedNeedle))) {
            score += 18;
            matches.push({ field: 'property', from: null, to: null, text: name });
          }
        }
      } else if (clause.kind === 'tag' && document.knowledge.tags.some(tag => fold(tag) === fold(clause.value.replace(/^#/u, '')))) {
        score += 25;
        matches.push({ field: 'tag', from: null, to: null, text: '#' + clause.value.replace(/^#/u, '') });
      } else if (clause.kind === 'property') {
        score += 20;
        matches.push({ field: 'property', from: null, to: null, text: clause.name });
      } else if (clause.kind === 'task') {
        score += 16;
        const task = document.knowledge.tasks.find(item => clause.value === 'any' || (clause.value === 'open' ? !item.completed : item.completed));
        if (task) matches.push({ field: 'task', from: task.from, to: task.to, text: task.text });
      } else if (clause.kind === 'path') score += 12;
      else if (clause.kind === 'file') score += 18;
    }
    const bodyMatch = matches.find(match => match.field === 'body' && match.from !== null);
    const fallbackTask = matches.find(match => match.field === 'task' && match.from !== null);
    const position = bodyMatch?.from ?? fallbackTask?.from ?? null;
    return {
      entryId: document.entryId,
      title: titleStem(document.title),
      path: document.path,
      score,
      snippet: this.snippet(document.knowledge.bodyText, position),
      matchCount: Math.max(matchCount, matches.length ? 1 : 0),
      matches: matches.slice(0, 12),
    };
  }

  private snippet(source: string, position: number | null): string {
    const anchor = position ?? source.search(/\S/u);
    if (anchor < 0) return '';
    let start = source.lastIndexOf('\n', anchor);
    start = start < 0 ? Math.max(0, anchor - 70) : start + 1;
    let end = source.indexOf('\n', anchor);
    end = end < 0 ? Math.min(source.length, anchor + 160) : end;
    const line = source.slice(start, end).replace(/\s+/gu, ' ').trim();
    if (line.length <= 190) return line;
    const local = Math.max(0, anchor - start);
    const from = Math.max(0, local - 65);
    const to = Math.min(line.length, from + 170);
    return (from > 0 ? '…' : '') + line.slice(from, to) + (to < line.length ? '…' : '');
  }
}
