import { Document, isMap, isSeq, isScalar, parseDocument } from 'yaml';
import { VaultError } from '../domain/errors.js';
import type { KnowledgePropertyValue, KnowledgeScalar } from '../knowledge/types.js';

export type PropertyKind = 'text' | 'number' | 'checkbox' | 'date' | 'list' | 'tags' | 'null' | 'unsupported';

export interface VisualProperty {
  name: string;
  kind: PropertyKind;
  value: KnowledgePropertyValue | Record<string, unknown>;
  editable: boolean;
  summary: string;
}

export interface FrontmatterView {
  status: 'none' | 'valid' | 'invalid' | 'unsupported-root';
  properties: VisualProperty[];
  message: string | null;
  lineEnding: '\n' | '\r\n';
  bodyOffset: number;
}

interface Envelope {
  status: 'none' | 'valid' | 'invalid';
  yaml: string;
  body: string;
  lineEnding: '\n' | '\r\n';
  end: number;
  message: string | null;
}

const propertyNamePattern = /^[A-Za-z0-9_.-]+$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

function envelope(source: string): Envelope {
  const lineEnding: '\n' | '\r\n' = source.includes('\r\n') ? '\r\n' : '\n';
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) {
    return { status: 'none', yaml: '', body: source, lineEnding, end: 0, message: null };
  }
  const match = /^(?:---\r?\n)([\s\S]*?)(?:\r?\n---)(?:\r?\n|$)/u.exec(source);
  if (!match) {
    return {
      status: 'invalid',
      yaml: '',
      body: source,
      lineEnding,
      end: 0,
      message: 'Frontmatter starts with --- but has no valid closing --- delimiter.',
    };
  }
  const full = match[0];
  const yaml = match[1] ?? '';
  return {
    status: 'valid',
    yaml,
    body: source.slice(full.length),
    lineEnding,
    end: full.length,
    message: null,
  };
}

function parseYamlDocument(source: string): { doc: Document; message: string | null } {
  const doc = parseDocument(source, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
    keepSourceTokens: true,
  });
  if (doc.errors.length) {
    return { doc, message: doc.errors.map(error => error.message).join('; ') };
  }
  return { doc, message: null };
}

function scalarSummary(value: KnowledgeScalar): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  return String(value);
}

function plainValue(value: unknown): KnowledgeScalar | KnowledgeScalar[] | Record<string, unknown> {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const simple = value.every(item => item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean');
    return simple ? value as KnowledgeScalar[] : { complex: value } as unknown as Record<string, unknown>;
  }
  return value && typeof value === 'object' ? value as Record<string, unknown> : String(value);
}

function kindFor(name: string, value: KnowledgeScalar | KnowledgeScalar[] | Record<string, unknown>): PropertyKind {
  if (Array.isArray(value)) return /^(?:tags?|aliases?)$/iu.test(name) && /^tags?$/iu.test(name) ? 'tags' : 'list';
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'checkbox';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return datePattern.test(value) ? 'date' : 'text';
  return 'unsupported';
}

function summaryFor(value: KnowledgeScalar | KnowledgeScalar[] | Record<string, unknown>): string {
  if (Array.isArray(value)) return value.map(scalarSummary).join(', ');
  if (value && typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return '[complex YAML]'; }
  }
  return scalarSummary(value as KnowledgeScalar);
}

export function validatePropertyName(raw: string): string {
  const name = raw.trim();
  if (!name || !propertyNamePattern.test(name)) {
    throw new VaultError('INVALID_NAME', 'Property names may contain letters, numbers, underscore, dot and hyphen.');
  }
  return name;
}

export function inspectFrontmatter(source: string): FrontmatterView {
  const env = envelope(source);
  if (env.status === 'none') return { status: 'none', properties: [], message: null, lineEnding: env.lineEnding, bodyOffset: 0 };
  if (env.status === 'invalid') return { status: 'invalid', properties: [], message: env.message, lineEnding: env.lineEnding, bodyOffset: 0 };

  const parsed = parseYamlDocument(env.yaml);
  if (parsed.message) return { status: 'invalid', properties: [], message: parsed.message, lineEnding: env.lineEnding, bodyOffset: env.end };
  const js = parsed.doc.toJS({ mapAsMap: false, maxAliasCount: 100 });
  if (js !== null && (typeof js !== 'object' || Array.isArray(js))) {
    return {
      status: 'unsupported-root',
      properties: [],
      message: 'Visual Properties requires frontmatter to be a top-level YAML mapping.',
      lineEnding: env.lineEnding,
      bodyOffset: env.end,
    };
  }

  const values = (js ?? {}) as Record<string, unknown>;
  const properties = Object.entries(values).map(([name, raw]): VisualProperty => {
    const value = plainValue(raw);
    const kind = kindFor(name, value);
    return { name, kind, value, editable: kind !== 'unsupported', summary: summaryFor(value) };
  });
  return { status: 'valid', properties, message: null, lineEnding: env.lineEnding, bodyOffset: env.end };
}

function documentForMutation(source: string): { doc: Document; env: Envelope } {
  const env = envelope(source);
  if (env.status === 'invalid') throw new VaultError('CORRUPT', env.message ?? 'Frontmatter is invalid.');
  if (env.status === 'none') return { doc: new Document({}), env };
  const parsed = parseYamlDocument(env.yaml);
  if (parsed.message) throw new VaultError('CORRUPT', `Frontmatter is invalid: ${parsed.message}`);
  if (parsed.doc.contents !== null && !isMap(parsed.doc.contents)) {
    throw new VaultError('UNSUPPORTED', 'Visual Properties can only edit top-level YAML mappings. Open Source mode for this frontmatter.');
  }
  return { doc: parsed.doc, env };
}

function serialize(doc: Document, env: Envelope): string {
  let yaml = doc.toString({ lineWidth: 0 }).trimEnd();
  if (yaml === '{}' || yaml === '') return env.body;
  if (env.lineEnding === '\r\n') yaml = yaml.replace(/\n/gu, '\r\n');
  return `---${env.lineEnding}${yaml}${env.lineEnding}---${env.lineEnding}${env.body}`;
}

function ensureSimpleValue(value: KnowledgePropertyValue): KnowledgePropertyValue {
  const values = Array.isArray(value) ? value : [value];
  if (!values.every(item => item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')) {
    throw new VaultError('UNSUPPORTED', 'Visual Properties only writes scalar values and scalar lists.');
  }
  return value;
}

export function setFrontmatterProperty(source: string, rawName: string, value: KnowledgePropertyValue): string {
  const name = validatePropertyName(rawName);
  const { doc, env } = documentForMutation(source);
  doc.set(name, ensureSimpleValue(value));
  return serialize(doc, env);
}

export function deleteFrontmatterProperty(source: string, rawName: string): string {
  const name = validatePropertyName(rawName);
  const { doc, env } = documentForMutation(source);

  if (isMap(doc.contents)) {
    const pair = doc.contents.items.find(item => isScalar(item.key) && String(item.key.value) === name);
    if (pair && isScalar(pair.key)) {
      const index = doc.contents.items.indexOf(pair);
      const commentBefore = pair.key.commentBefore;
      const spaceBefore = pair.key.spaceBefore;
      const next = doc.contents.items[index + 1];

      if ((commentBefore || spaceBefore) && next && isScalar(next.key)) {
        if (commentBefore) next.key.commentBefore = [commentBefore, next.key.commentBefore].filter(Boolean).join('\n');
        if (spaceBefore) next.key.spaceBefore = true;
      } else if (commentBefore || spaceBefore) {
        if (commentBefore) doc.commentBefore = [doc.commentBefore, commentBefore].filter(Boolean).join('\n');
      }
    }
  }

  doc.delete(name);
  return serialize(doc, env);
}

export function renameFrontmatterProperty(source: string, rawOldName: string, rawNewName: string): string {
  const oldName = validatePropertyName(rawOldName);
  const newName = validatePropertyName(rawNewName);
  if (oldName === newName) return source;

  const { doc, env } = documentForMutation(source);
  if (!isMap(doc.contents)) throw new VaultError('UNSUPPORTED', 'Visual Properties requires a top-level YAML mapping.');
  if (doc.has(newName)) throw new VaultError('COLLISION', `A property named "${newName}" already exists.`);

  const pair = doc.contents.items.find(item => isScalar(item.key) && String(item.key.value) === oldName);
  if (!pair) throw new VaultError('NOT_FOUND', `Property "${oldName}" no longer exists.`);

  const previousKey = pair.key;
  const nextKey = doc.createNode(newName);
  if (isScalar(previousKey) && isScalar(nextKey)) {
    if (previousKey.commentBefore !== undefined) nextKey.commentBefore = previousKey.commentBefore;
    if (previousKey.comment !== undefined) nextKey.comment = previousKey.comment;
    if (previousKey.spaceBefore !== undefined) nextKey.spaceBefore = previousKey.spaceBefore;
  }
  pair.key = nextKey;
  return serialize(doc, env);
}

export function valueForKind(kind: Exclude<PropertyKind, 'unsupported'>, raw: string, checked = false): KnowledgePropertyValue {
  switch (kind) {
    case 'text':
      return raw;
    case 'number': {
      const value = Number(raw.trim());
      if (!Number.isFinite(value)) throw new VaultError('CORRUPT', 'Enter a valid finite number.');
      return value;
    }
    case 'checkbox':
      return checked;
    case 'date': {
      const value = raw.trim();
      if (!datePattern.test(value)) throw new VaultError('CORRUPT', 'Use a date in YYYY-MM-DD format.');
      const parsed = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        throw new VaultError('CORRUPT', 'Enter a real calendar date in YYYY-MM-DD format.');
      }
      return value;
    }
    case 'list':
      return raw.split(',').map(value => value.trim()).filter(Boolean);
    case 'tags':
      return raw.split(',').map(value => value.trim().replace(/^#/u, '')).filter(Boolean);
    case 'null':
      return null;
  }
}

export function rawValueForProperty(property: VisualProperty): string {
  if (Array.isArray(property.value)) return property.value.map(scalarSummary).join(', ');
  if (property.value === null) return '';
  if (typeof property.value === 'object') return property.summary;
  return String(property.value);
}
