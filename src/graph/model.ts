import type { Entry, EntryId } from '../domain/model.js';
import { VaultTree } from '../domain/tree.js';
import type { KnowledgePropertyValue, KnowledgeRecord, WikiReference } from '../knowledge/types.js';

export type GraphNodeKind = 'note' | 'attachment';
export type GraphEdgeKind = 'link' | 'embed' | 'attachment-link' | 'attachment-embed';
export type GraphGroupMode = 'none' | 'folder' | 'tag' | 'kind' | 'property';

export interface GraphNode {
  id: EntryId;
  kind: GraphNodeKind;
  label: string;
  path: string;
  folder: string;
  tags: string[];
  properties: Record<string, KnowledgePropertyValue>;
  createdAt: string;
  updatedAt: string;
  inDegree: number;
  outDegree: number;
  degree: number;
  orphan: boolean;
}

export interface GraphEdge {
  id: string;
  source: EntryId;
  target: EntryId;
  kind: GraphEdgeKind;
  weight: number;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolvedReferences: number;
  ambiguousReferences: number;
}

export interface GraphFilter {
  search?: string;
  tag?: string;
  property?: string;
  kinds?: readonly GraphNodeKind[];
  orphanOnly?: boolean;
}

interface GraphResolutionIndex {
  entriesById: Map<EntryId, Entry>;
  paths: Map<EntryId, string>;
  notePaths: Map<string, EntryId[]>;
  noteTitles: Map<string, EntryId[]>;
  noteAliases: Map<string, EntryId[]>;
  noteSiblingTitles: Map<string, EntryId[]>;
  attachmentPaths: Map<string, EntryId[]>;
  attachmentNames: Map<string, EntryId[]>;
  attachmentSiblingNames: Map<string, EntryId[]>;
}

type TargetResolution =
  | { status: 'resolved'; entryId: EntryId }
  | { status: 'ambiguous'; entryIds: EntryId[] }
  | { status: 'unresolved' };

const fold = (value: string): string => value.normalize('NFC').toLocaleLowerCase();
const stem = (name: string): string => name.replace(/\.md$/iu, '');
const withoutMarkdownExtension = (path: string): string => path.replace(/\.md$/iu, '');

function parentKey(parentId: EntryId | null, name: string): string {
  return `${parentId ?? 'root'}\u0000${fold(name)}`;
}

function pushMap(map: Map<string, EntryId[]>, key: string, id: EntryId): void {
  const values = map.get(key);
  if (values) values.push(id);
  else map.set(key, [id]);
}

function uniqueResolution(ids: readonly EntryId[] | undefined): TargetResolution {
  if (!ids?.length) return { status: 'unresolved' };
  const unique = [...new Set(ids)];
  return unique.length === 1
    ? { status: 'resolved', entryId: unique[0]! }
    : { status: 'ambiguous', entryIds: unique };
}

function buildResolutionIndex(entries: readonly Entry[], records: readonly KnowledgeRecord[]): GraphResolutionIndex {
  const active = entries.filter(entry => entry.deletedAt === null);
  const tree = new VaultTree(entries);
  const paths = new Map<EntryId, string>();
  const entriesById = new Map<EntryId, Entry>();
  const notePaths = new Map<string, EntryId[]>();
  const noteTitles = new Map<string, EntryId[]>();
  const noteAliases = new Map<string, EntryId[]>();
  const noteSiblingTitles = new Map<string, EntryId[]>();
  const attachmentPaths = new Map<string, EntryId[]>();
  const attachmentNames = new Map<string, EntryId[]>();
  const attachmentSiblingNames = new Map<string, EntryId[]>();
  const recordsById = new Map(records.map(record => [record.entryId, record]));

  for (const entry of active) {
    entriesById.set(entry.id, entry);
    const path = tree.path(entry.id);
    paths.set(entry.id, path);
    if (entry.kind === 'markdown') {
      const title = stem(entry.name);
      pushMap(notePaths, fold(withoutMarkdownExtension(path)), entry.id);
      pushMap(noteTitles, fold(title), entry.id);
      pushMap(noteSiblingTitles, parentKey(entry.parentId, title), entry.id);
      for (const alias of recordsById.get(entry.id)?.aliases ?? []) {
        const normalized = alias.trim();
        if (normalized) pushMap(noteAliases, fold(normalized), entry.id);
      }
    } else if (entry.kind === 'attachment') {
      pushMap(attachmentPaths, fold(path), entry.id);
      pushMap(attachmentNames, fold(entry.name), entry.id);
      pushMap(attachmentSiblingNames, parentKey(entry.parentId, entry.name), entry.id);
    }
  }

  return {
    entriesById,
    paths,
    notePaths,
    noteTitles,
    noteAliases,
    noteSiblingTitles,
    attachmentPaths,
    attachmentNames,
    attachmentSiblingNames,
  };
}

function sourceRelativePath(index: GraphResolutionIndex, sourceId: EntryId, query: string, stripMarkdown: boolean): string | null {
  const sourcePath = index.paths.get(sourceId);
  if (!sourcePath) return null;
  const normalizedSource = stripMarkdown ? withoutMarkdownExtension(sourcePath) : sourcePath;
  const slash = normalizedSource.lastIndexOf('/');
  return slash >= 0 ? `${normalizedSource.slice(0, slash)}/${query}` : query;
}

function resolveNoteTarget(rawNote: string, sourceEntryId: EntryId, index: GraphResolutionIndex): TargetResolution {
  const query = rawNote.replace(/\.md$/iu, '').replace(/^\.\//u, '').trim();
  if (!query) {
    const source = index.entriesById.get(sourceEntryId);
    return source?.kind === 'markdown' ? { status: 'resolved', entryId: sourceEntryId } : { status: 'unresolved' };
  }

  const q = fold(query);
  const exactPath = uniqueResolution(index.notePaths.get(q));
  if (exactPath.status !== 'unresolved') return exactPath;

  if (query.includes('/')) {
    const relative = sourceRelativePath(index, sourceEntryId, query, true);
    if (relative) {
      const resolved = uniqueResolution(index.notePaths.get(fold(relative)));
      if (resolved.status !== 'unresolved') return resolved;
    }
  }

  const source = index.entriesById.get(sourceEntryId);
  const sibling = uniqueResolution(index.noteSiblingTitles.get(parentKey(source?.parentId ?? null, query)));
  if (sibling.status !== 'unresolved') return sibling;

  const title = uniqueResolution(index.noteTitles.get(q));
  if (title.status !== 'unresolved') return title;

  return uniqueResolution(index.noteAliases.get(q));
}

function resolveAttachmentTarget(rawTarget: string, sourceEntryId: EntryId, index: GraphResolutionIndex): TargetResolution {
  const query = rawTarget.replace(/^\.\//u, '').trim();
  if (!query) return { status: 'unresolved' };
  const q = fold(query);

  const exactPath = uniqueResolution(index.attachmentPaths.get(q));
  if (exactPath.status !== 'unresolved') return exactPath;

  if (query.includes('/')) {
    const relative = sourceRelativePath(index, sourceEntryId, query, false);
    if (relative) {
      const resolved = uniqueResolution(index.attachmentPaths.get(fold(relative)));
      if (resolved.status !== 'unresolved') return resolved;
    }
  }

  const source = index.entriesById.get(sourceEntryId);
  const sibling = uniqueResolution(index.attachmentSiblingNames.get(parentKey(source?.parentId ?? null, query)));
  if (sibling.status !== 'unresolved') return sibling;

  return uniqueResolution(index.attachmentNames.get(q));
}

function referenceTarget(reference: WikiReference, sourceEntryId: EntryId, index: GraphResolutionIndex): { resolution: TargetResolution; kind: GraphEdgeKind } {
  if (!reference.heading && !reference.block) {
    const attachment = resolveAttachmentTarget(reference.note, sourceEntryId, index);
    if (attachment.status !== 'unresolved') {
      return { resolution: attachment, kind: reference.embed ? 'attachment-embed' : 'attachment-link' };
    }
  }
  return {
    resolution: resolveNoteTarget(reference.note, sourceEntryId, index),
    kind: reference.embed ? 'embed' : 'link',
  };
}

function propertyStrings(value: KnowledgePropertyValue | undefined): string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.map(item => item === null ? 'null' : String(item));
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? 'Vault root' : path.slice(0, slash);
}

export function buildKnowledgeGraph(entries: readonly Entry[], records: readonly KnowledgeRecord[]): KnowledgeGraph {
  const index = buildResolutionIndex(entries, records);
  const recordsById = new Map(records.map(record => [record.entryId, record]));
  const nodes: GraphNode[] = [];

  for (const entry of entries) {
    if (entry.deletedAt !== null || (entry.kind !== 'markdown' && entry.kind !== 'attachment')) continue;
    const path = index.paths.get(entry.id);
    if (!path) continue;
    const record = recordsById.get(entry.id);
    nodes.push({
      id: entry.id,
      kind: entry.kind === 'markdown' ? 'note' : 'attachment',
      label: entry.kind === 'markdown' ? stem(entry.name) : entry.name,
      path,
      folder: folderOf(path),
      tags: record?.tags ?? [],
      properties: record?.properties ?? {},
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      inDegree: 0,
      outDegree: 0,
      degree: 0,
      orphan: true,
    });
  }

  const nodeIds = new Set(nodes.map(node => node.id));
  const edgeMap = new Map<string, GraphEdge>();
  let unresolvedReferences = 0;
  let ambiguousReferences = 0;

  for (const record of records) {
    if (!nodeIds.has(record.entryId)) continue;
    for (const reference of record.links) {
      const target = referenceTarget(reference, record.entryId, index);
      if (target.resolution.status === 'unresolved') {
        unresolvedReferences++;
        continue;
      }
      if (target.resolution.status === 'ambiguous') {
        ambiguousReferences++;
        continue;
      }
      if (!nodeIds.has(target.resolution.entryId)) continue;
      const key = `${record.entryId}\u0000${target.resolution.entryId}\u0000${target.kind}`;
      const existing = edgeMap.get(key);
      if (existing) existing.weight++;
      else edgeMap.set(key, {
        id: key,
        source: record.entryId,
        target: target.resolution.entryId,
        kind: target.kind,
        weight: 1,
      });
    }
  }

  const edges = [...edgeMap.values()];
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    source.outDegree += edge.weight;
    target.inDegree += edge.weight;
  }
  for (const node of nodes) {
    node.degree = node.inDegree + node.outDegree;
    node.orphan = node.degree === 0;
  }

  nodes.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
  edges.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.kind.localeCompare(b.kind));

  return { nodes, edges, unresolvedReferences, ambiguousReferences };
}

export function localKnowledgeGraph(graph: KnowledgeGraph, centerId: EntryId, depth: number): KnowledgeGraph {
  const boundedDepth = Math.max(0, Math.min(6, Math.floor(depth)));
  const nodeIds = new Set(graph.nodes.map(node => node.id));
  if (!nodeIds.has(centerId)) return { ...graph, nodes: [], edges: [] };

  const adjacency = new Map<EntryId, Set<EntryId>>();
  for (const edge of graph.edges) {
    const source = adjacency.get(edge.source) ?? new Set<EntryId>();
    source.add(edge.target);
    adjacency.set(edge.source, source);
    const target = adjacency.get(edge.target) ?? new Set<EntryId>();
    target.add(edge.source);
    adjacency.set(edge.target, target);
  }

  const distance = new Map<EntryId, number>([[centerId, 0]]);
  const queue: EntryId[] = [centerId];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor]!;
    const currentDepth = distance.get(current)!;
    if (currentDepth >= boundedDepth) continue;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (distance.has(neighbor)) continue;
      distance.set(neighbor, currentDepth + 1);
      queue.push(neighbor);
    }
  }

  const visible = new Set(distance.keys());
  return {
    nodes: graph.nodes.filter(node => visible.has(node.id)),
    edges: graph.edges.filter(edge => visible.has(edge.source) && visible.has(edge.target)),
    unresolvedReferences: graph.unresolvedReferences,
    ambiguousReferences: graph.ambiguousReferences,
  };
}

function matchesSearch(node: GraphNode, raw: string): boolean {
  const query = fold(raw.trim());
  if (!query) return true;
  if (fold(node.label).includes(query) || fold(node.path).includes(query)) return true;
  if (node.tags.some(tag => fold(tag).includes(query))) return true;
  for (const [key, value] of Object.entries(node.properties)) {
    if (fold(key).includes(query) || propertyStrings(value).some(item => fold(item).includes(query))) return true;
  }
  return false;
}

function matchesTag(node: GraphNode, raw: string): boolean {
  const tag = fold(raw.trim().replace(/^#/u, ''));
  if (!tag) return true;
  return node.tags.some(value => {
    const candidate = fold(value.replace(/^#/u, ''));
    return candidate === tag || candidate.startsWith(`${tag}/`);
  });
}

export function matchesPropertyFilter(node: GraphNode, raw: string): boolean {
  const input = raw.trim();
  if (!input) return true;
  const match = /^([A-Za-z0-9_.-]+)\s*(=|!=)\s*(.*?)\s*$/u.exec(input);
  if (!match) return Object.prototype.hasOwnProperty.call(node.properties, input);
  const key = match[1]!;
  const operator = match[2]!;
  const wanted = fold(match[3]!);
  const actual = propertyStrings(node.properties[key]).map(fold);
  const equal = actual.some(value => value === wanted);
  return operator === '=' ? equal : !equal;
}

export function filterKnowledgeGraph(graph: KnowledgeGraph, filter: GraphFilter): KnowledgeGraph {
  const kinds = filter.kinds?.length ? new Set(filter.kinds) : null;
  const visibleNodes = graph.nodes.filter(node => {
    if (kinds && !kinds.has(node.kind)) return false;
    if (filter.orphanOnly && !node.orphan) return false;
    if (filter.search && !matchesSearch(node, filter.search)) return false;
    if (filter.tag && !matchesTag(node, filter.tag)) return false;
    if (filter.property && !matchesPropertyFilter(node, filter.property)) return false;
    return true;
  });
  const visibleIds = new Set(visibleNodes.map(node => node.id));
  return {
    nodes: visibleNodes,
    edges: graph.edges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target)),
    unresolvedReferences: graph.unresolvedReferences,
    ambiguousReferences: graph.ambiguousReferences,
  };
}

export function graphGroupKey(node: GraphNode, mode: GraphGroupMode, propertyName = ''): string {
  if (mode === 'folder') return node.folder;
  if (mode === 'kind') return node.kind === 'note' ? 'Notes' : 'Attachments';
  if (mode === 'tag') return [...node.tags].sort((a, b) => a.localeCompare(b))[0] ?? 'Untagged';
  if (mode === 'property') {
    const key = propertyName.trim();
    if (!key) return 'No property selected';
    const values = propertyStrings(node.properties[key]);
    return values[0] ?? `No ${key}`;
  }
  return 'All notes';
}

export function graphStats(graph: KnowledgeGraph): { nodes: number; notes: number; attachments: number; edges: number; references: number; orphans: number } {
  return {
    nodes: graph.nodes.length,
    notes: graph.nodes.filter(node => node.kind === 'note').length,
    attachments: graph.nodes.filter(node => node.kind === 'attachment').length,
    edges: graph.edges.length,
    references: graph.edges.reduce((sum, edge) => sum + edge.weight, 0),
    orphans: graph.nodes.filter(node => node.orphan).length,
  };
}
