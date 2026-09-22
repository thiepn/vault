import { Document, parseDocument } from 'yaml';

export type CanvasNodeType = 'note' | 'text' | 'media';

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

interface CanvasNodeBase {
  id: string;
  type: CanvasNodeType;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasNoteNode extends CanvasNodeBase {
  type: 'note';
  target: string;
}

export interface CanvasTextNode extends CanvasNodeBase {
  type: 'text';
  text: string;
}

export interface CanvasMediaNode extends CanvasNodeBase {
  type: 'media';
  target: string;
  alt: string | null;
}

export type CanvasNode = CanvasNoteNode | CanvasTextNode | CanvasMediaNode;

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  label: string | null;
}

export interface CanvasGroup {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasDocument {
  version: 1;
  id: string;
  viewport: CanvasViewport;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  groups: CanvasGroup[];
}

export class CanvasDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanvasDocumentError';
  }
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const MAX_NODES = 1000;
const MAX_EDGES = 2500;
const MAX_GROUPS = 250;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_COORDINATE = 1_000_000;
const MIN_NODE_WIDTH = 120;
const MIN_NODE_HEIGHT = 80;
const MAX_ITEM_SIZE = 4000;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CanvasDocumentError(`${label} must be a YAML mapping.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new CanvasDocumentError(`${label} must be a YAML list.`);
  return value;
}

function string(value: unknown, label: string, options: { empty?: boolean; max?: number } = {}): string {
  if (typeof value !== 'string') throw new CanvasDocumentError(`${label} must be text.`);
  const result = value.trim();
  if (!options.empty && !result) throw new CanvasDocumentError(`${label} cannot be empty.`);
  if (result.length > (options.max ?? 4096)) throw new CanvasDocumentError(`${label} is too long.`);
  return options.empty ? value : result;
}

function id(value: unknown, label: string): string {
  const result = string(value, label, { max: 64 });
  if (!idPattern.test(result)) throw new CanvasDocumentError(`${label} must use letters, numbers, underscore or hyphen.`);
  return result;
}

function finite(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new CanvasDocumentError(`${label} must be a finite number from ${min} to ${max}.`);
  }
  return value;
}

function optionalString(value: unknown, label: string, max = 512): string | null {
  if (value === undefined || value === null || value === '') return null;
  return string(value, label, { max });
}

function parseRect(value: Record<string, unknown>, label: string): Pick<CanvasNodeBase, 'x' | 'y' | 'width' | 'height'> {
  return {
    x: finite(value.x, `${label}.x`, -MAX_COORDINATE, MAX_COORDINATE),
    y: finite(value.y, `${label}.y`, -MAX_COORDINATE, MAX_COORDINATE),
    width: finite(value.width, `${label}.width`, MIN_NODE_WIDTH, MAX_ITEM_SIZE),
    height: finite(value.height, `${label}.height`, MIN_NODE_HEIGHT, MAX_ITEM_SIZE),
  };
}

function parseNode(value: unknown, index: number): CanvasNode {
  const raw = record(value, `nodes[${index}]`);
  const nodeId = id(raw.id, `nodes[${index}].id`);
  const type = string(raw.type, `nodes[${index}].type`, { max: 16 });
  const rect = parseRect(raw, `nodes[${index}]`);

  if (type === 'note') {
    return { id: nodeId, type, ...rect, target: string(raw.target, `nodes[${index}].target`, { max: 1024 }) };
  }
  if (type === 'text') {
    return { id: nodeId, type, ...rect, text: string(raw.text ?? '', `nodes[${index}].text`, { empty: true, max: 100_000 }) };
  }
  if (type === 'media') {
    return {
      id: nodeId,
      type,
      ...rect,
      target: string(raw.target, `nodes[${index}].target`, { max: 1024 }),
      alt: optionalString(raw.alt, `nodes[${index}].alt`, 1024),
    };
  }
  throw new CanvasDocumentError(`nodes[${index}].type must be note, text or media.`);
}

function parseGroup(value: unknown, index: number): CanvasGroup {
  const raw = record(value, `groups[${index}]`);
  const groupId = id(raw.id, `groups[${index}].id`);
  return {
    id: groupId,
    title: string(raw.title, `groups[${index}].title`, { max: 256 }),
    x: finite(raw.x, `groups[${index}].x`, -MAX_COORDINATE, MAX_COORDINATE),
    y: finite(raw.y, `groups[${index}].y`, -MAX_COORDINATE, MAX_COORDINATE),
    width: finite(raw.width, `groups[${index}].width`, 180, MAX_ITEM_SIZE),
    height: finite(raw.height, `groups[${index}].height`, 120, MAX_ITEM_SIZE),
  };
}

function parseEdge(value: unknown, index: number): CanvasEdge {
  const raw = record(value, `edges[${index}]`);
  return {
    id: id(raw.id, `edges[${index}].id`),
    from: id(raw.from, `edges[${index}].from`),
    to: id(raw.to, `edges[${index}].to`),
    label: optionalString(raw.label, `edges[${index}].label`, 512),
  };
}

function uniqueIds(values: readonly { id: string }[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) throw new CanvasDocumentError(`Duplicate ${label} id "${value.id}".`);
    seen.add(value.id);
  }
}

function validateReferences(document: CanvasDocument): void {
  const nodeIds = new Set(document.nodes.map(node => node.id));
  for (const edge of document.edges) {
    if (!nodeIds.has(edge.from)) throw new CanvasDocumentError(`Edge "${edge.id}" references missing source node "${edge.from}".`);
    if (!nodeIds.has(edge.to)) throw new CanvasDocumentError(`Edge "${edge.id}" references missing target node "${edge.to}".`);
    if (edge.from === edge.to) throw new CanvasDocumentError(`Edge "${edge.id}" cannot connect a node to itself.`);
  }
}

export function parseCanvasDocument(source: string): CanvasDocument {
  if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) {
    throw new CanvasDocumentError('Canvas source exceeds the 2 MB safety limit.');
  }
  const parsed = parseDocument(source, { prettyErrors: false, strict: true, uniqueKeys: true });
  if (parsed.errors.length) throw new CanvasDocumentError(parsed.errors.map(error => error.message).join('; '));
  const root = record(parsed.toJS({ mapAsMap: false, maxAliasCount: 100 }) ?? {}, 'Canvas');

  const version = root.version ?? 1;
  if (version !== 1) throw new CanvasDocumentError('Only Canvas format version 1 is supported.');

  const canvasId = id(root.id, 'Canvas id');
  const viewportRaw = root.viewport === undefined ? {} : record(root.viewport, 'viewport');
  const nodesRaw = array(root.nodes, 'nodes');
  const edgesRaw = array(root.edges, 'edges');
  const groupsRaw = array(root.groups, 'groups');
  if (nodesRaw.length > MAX_NODES) throw new CanvasDocumentError(`Canvas supports at most ${MAX_NODES} nodes.`);
  if (edgesRaw.length > MAX_EDGES) throw new CanvasDocumentError(`Canvas supports at most ${MAX_EDGES} edges.`);
  if (groupsRaw.length > MAX_GROUPS) throw new CanvasDocumentError(`Canvas supports at most ${MAX_GROUPS} groups.`);

  const document: CanvasDocument = {
    version: 1,
    id: canvasId,
    viewport: {
      x: finite(viewportRaw.x ?? 80, 'viewport.x', -MAX_COORDINATE, MAX_COORDINATE),
      y: finite(viewportRaw.y ?? 80, 'viewport.y', -MAX_COORDINATE, MAX_COORDINATE),
      zoom: finite(viewportRaw.zoom ?? 1, 'viewport.zoom', 0.1, 4),
    },
    nodes: nodesRaw.map(parseNode),
    edges: edgesRaw.map(parseEdge),
    groups: groupsRaw.map(parseGroup),
  };

  uniqueIds(document.nodes, 'node');
  uniqueIds(document.edges, 'edge');
  uniqueIds(document.groups, 'group');
  validateReferences(document);
  return document;
}

export function serializeCanvasDocument(document: CanvasDocument): string {
  validateReferences(document);
  const yaml = new Document({
    version: 1,
    id: document.id,
    viewport: {
      x: Number(document.viewport.x.toFixed(2)),
      y: Number(document.viewport.y.toFixed(2)),
      zoom: Number(document.viewport.zoom.toFixed(4)),
    },
    nodes: document.nodes.map(node => node.type === 'note'
      ? { id: node.id, type: node.type, target: node.target, x: node.x, y: node.y, width: node.width, height: node.height }
      : node.type === 'media'
        ? { id: node.id, type: node.type, target: node.target, ...(node.alt ? { alt: node.alt } : {}), x: node.x, y: node.y, width: node.width, height: node.height }
        : { id: node.id, type: node.type, text: node.text, x: node.x, y: node.y, width: node.width, height: node.height }),
    edges: document.edges.map(edge => ({ id: edge.id, from: edge.from, to: edge.to, ...(edge.label ? { label: edge.label } : {}) })),
    groups: document.groups.map(group => ({ id: group.id, title: group.title, x: group.x, y: group.y, width: group.width, height: group.height })),
  });
  return yaml.toString({ lineWidth: 0 }).trimEnd();
}

export function canvasObjectId(prefix: 'node' | 'edge' | 'group' | 'canvas'): string {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  return `${prefix}-${suffix}`;
}

export function emptyCanvasDocument(canvasId = canvasObjectId('canvas')): CanvasDocument {
  return {
    version: 1,
    id: canvasId,
    viewport: { x: 80, y: 80, zoom: 1 },
    nodes: [],
    edges: [],
    groups: [],
  };
}

export function cloneCanvasDocument(document: CanvasDocument): CanvasDocument {
  return structuredClone(document);
}

export function deleteCanvasNode(document: CanvasDocument, nodeId: string): CanvasDocument {
  const next = cloneCanvasDocument(document);
  next.nodes = next.nodes.filter(node => node.id !== nodeId);
  next.edges = next.edges.filter(edge => edge.from !== nodeId && edge.to !== nodeId);
  return next;
}

export function canvasBounds(document: CanvasDocument): { x: number; y: number; width: number; height: number } | null {
  const items = [
    ...document.nodes.map(item => ({ x: item.x, y: item.y, width: item.width, height: item.height })),
    ...document.groups.map(item => ({ x: item.x, y: item.y, width: item.width, height: item.height })),
  ];
  if (!items.length) return null;
  const left = Math.min(...items.map(item => item.x));
  const top = Math.min(...items.map(item => item.y));
  const right = Math.max(...items.map(item => item.x + item.width));
  const bottom = Math.max(...items.map(item => item.y + item.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}
