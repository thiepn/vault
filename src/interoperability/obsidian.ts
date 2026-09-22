import { VaultError } from '../domain/errors.js';
import { nameKey, validateName } from '../domain/paths.js';
import { parseWikiReferences } from '../knowledge/parser.js';
import { normalizeAttachmentMimeType } from '../media/attachments.js';
import { serializeCanvasDocument, type CanvasDocument, type CanvasEdge, type CanvasGroup, type CanvasNode } from '../canvas/model.js';
import type { ArchiveFile } from './zip.js';
import type { ExportFile } from '../services/export.js';

export interface MigrationPathChange {
  from: string;
  to: string;
  reason: 'portable-name' | 'collision' | 'canvas-conversion';
}

export interface ObsidianMigrationReport {
  sourceEntries: number;
  markdownNotes: number;
  attachments: number;
  canvasesConverted: number;
  canvasesPreservedRaw: number;
  directories: number;
  ignoredConfiguration: number;
  ignoredSystemFiles: number;
  rewrittenWikiLinks: number;
  rewrittenMarkdownLinks: number;
  vaultOnlyBlocksPreserved: number;
  detectedCommunityPlugins: string[];
  renamedPaths: MigrationPathChange[];
  warnings: string[];
}

export interface PlannedDirectory {
  sourcePath: string;
  path: string;
}

export interface PlannedMarkdown {
  kind: 'markdown';
  sourcePath: string;
  path: string;
  text: string;
  modifiedAt: string | null;
  sourceKind: 'markdown' | 'canvas';
}

export interface PlannedAttachment {
  kind: 'attachment';
  sourcePath: string;
  path: string;
  bytes: Uint8Array;
  mimeType: string;
  modifiedAt: string | null;
}

export type PlannedObsidianFile = PlannedMarkdown | PlannedAttachment;

export interface ObsidianMigrationPlan {
  suggestedVaultName: string;
  directories: PlannedDirectory[];
  files: PlannedObsidianFile[];
  sourceToTargetPath: Map<string, string>;
  report: ObsidianMigrationReport;
}

export interface ObsidianExportReport {
  markdownFiles: number;
  attachments: number;
  canvasCompanions: number;
  vaultOnlyBlocksPreserved: number;
  warnings: string[];
}

export interface ObsidianExportResult {
  files: ExportFile[];
  report: ObsidianExportReport;
}

interface SourceItem {
  sourcePath: string;
  directory: boolean;
  bytes: Uint8Array;
  modifiedAt: string | null;
  kind: 'markdown' | 'canvas' | 'attachment';
  canvasJson?: JsonCanvas;
}

interface JsonCanvas {
  nodes?: unknown[];
  edges?: unknown[];
}

interface JsonCanvasRecord {
  id?: unknown;
  type?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
  text?: unknown;
  file?: unknown;
  subpath?: unknown;
  url?: unknown;
  label?: unknown;
  color?: unknown;
}

interface JsonCanvasEdgeRecord {
  id?: unknown;
  fromNode?: unknown;
  toNode?: unknown;
  fromEnd?: unknown;
  toEnd?: unknown;
  label?: unknown;
  color?: unknown;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
const MAX_MARKDOWN_BYTES = 16 * 1024 * 1024;
const MAX_CANVAS_BYTES = 8 * 1024 * 1024;

function fold(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase();
}

function pathKey(value: string): string {
  return fold(value.replace(/^\.\//u, '').replace(/\\/gu, '/').replace(/\/$/u, ''));
}

function splitPath(path: string): string[] {
  return path.replace(/\/$/u, '').split('/').filter(Boolean);
}

function parentPath(path: string): string {
  const trimmed = path.replace(/\/$/u, '');
  const slash = trimmed.lastIndexOf('/');
  return slash < 0 ? '' : trimmed.slice(0, slash);
}

function basename(path: string): string {
  const trimmed = path.replace(/\/$/u, '');
  const slash = trimmed.lastIndexOf('/');
  return slash < 0 ? trimmed : trimmed.slice(slash + 1);
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function stripExtension(name: string, extension: RegExp): string {
  return name.replace(extension, '');
}

function decodeUtf8(bytes: Uint8Array, label: string, limit: number): string {
  if (bytes.byteLength > limit) throw new VaultError('UNSUPPORTED', `${label} exceeds the migration size limit.`);
  try {
    const source = decoder.decode(bytes);
    return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  } catch (error) {
    throw new VaultError('CORRUPT', `${label} is not valid UTF-8.`, { cause: error });
  }
}

function sanitizeSegment(raw: string): { name: string; changed: boolean } {
  const original = raw.normalize('NFC');
  try {
    const valid = validateName(original);
    return { name: valid, changed: valid !== raw };
  } catch {
    // Migration is allowed to repair external names; internal authored names still
    // use the stricter validateName() path everywhere else.
  }

  let name = original
    .replace(/[\x00-\x1f\x7f/\\<>:"|?*]/gu, '-')
    .trim()
    .replace(/[. ]+$/gu, '');
  if (!name || name === '.' || name === '..') name = 'Untitled';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) name = '_' + name;

  const bytes = encoder.encode(name);
  if (bytes.byteLength > 240) {
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && name.length - dot <= 24 ? name.slice(dot) : '';
    const base = extension ? name.slice(0, -extension.length) : name;
    let shortened = '';
    for (const character of base) {
      if (encoder.encode(shortened + character + extension).byteLength > 232) break;
      shortened += character;
    }
    name = (shortened || 'Untitled') + extension;
  }

  return { name: validateName(name), changed: name !== original };
}

function uniqueName(parent: string, desired: string, used: Map<string, Set<string>>): { name: string; collided: boolean } {
  const set = used.get(parent) ?? new Set<string>();
  used.set(parent, set);
  if (!set.has(nameKey(desired))) {
    set.add(nameKey(desired));
    return { name: desired, collided: false };
  }

  const dot = desired.lastIndexOf('.');
  const base = dot > 0 ? desired.slice(0, dot) : desired;
  const extension = dot > 0 ? desired.slice(dot) : '';
  for (let index = 2; index <= 10_000; index++) {
    const candidate = sanitizeSegment(`${base} (${index})${extension}`).name;
    if (!set.has(nameKey(candidate))) {
      set.add(nameKey(candidate));
      return { name: candidate, collided: true };
    }
  }
  throw new VaultError('COLLISION', 'Could not allocate a portable imported filename.');
}

function commonTopLevel(files: readonly ArchiveFile[]): string | null {
  const relevant = files.filter(file => {
    const trimmed = file.path.replace(/\/$/u, '');
    return !file.directory && trimmed && !trimmed.startsWith('__MACOSX/');
  });
  if (!relevant.length) return null;
  let candidate: string | null = null;
  for (const file of relevant) {
    const segments = splitPath(file.path);
    if (segments.length < 2) return null;
    if (candidate === null) candidate = segments[0]!;
    else if (segments[0] !== candidate) return null;
  }
  return candidate;
}

function stripRoot(path: string, root: string | null): string {
  if (!root) return path.replace(/^\.\//u, '');
  const prefix = root + '/';
  return path.startsWith(prefix) ? path.slice(prefix.length) : path === root + '/' ? '' : path;
}

function suggestedVaultName(root: string | null, fallback: string): string {
  const source = root || fallback.replace(/\.(?:zip|vault\.zip)$/iu, '') || 'Obsidian import';
  return sanitizeSegment(source).name;
}

function parseCommunityPlugins(item: ArchiveFile): string[] {
  try {
    const parsed = JSON.parse(decodeUtf8(item.bytes, 'community-plugins.json', 2 * 1024 * 1024)) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function safeNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

function objectId(raw: unknown, prefix: string, used: Set<string>): string {
  let value = typeof raw === 'string' ? raw.normalize('NFC') : '';
  value = value.replace(/[^A-Za-z0-9_-]/gu, '-').replace(/^-+/u, '').slice(0, 56);
  if (!value || !/^[A-Za-z0-9]/u.test(value)) value = `${prefix}-item`;
  let candidate = value;
  let index = 2;
  while (used.has(candidate)) candidate = `${value.slice(0, 50)}-${index++}`;
  used.add(candidate);
  return candidate;
}

function resolveMappedFile(
  raw: string,
  sourcePath: string,
  sourceToTarget: ReadonlyMap<string, string>,
  sourceFiles: readonly string[],
): string | null {
  const query = raw.replace(/^\.\//u, '').replace(/\\/gu, '/');
  const sourceDirectory = parentPath(sourcePath);
  const candidates = [
    query,
    sourceDirectory ? joinPath(sourceDirectory, query) : query,
  ];
  for (const candidate of candidates) {
    const exact = sourceToTarget.get(pathKey(candidate));
    if (exact) return exact;
  }

  const queryName = basename(query);
  const queryNoteStem = stripExtension(queryName, /\.md$/iu);
  const matches = sourceFiles.filter(path => {
    const name = basename(path);
    if (/\.md$/iu.test(path) || /\.canvas$/iu.test(path)) {
      return fold(stripExtension(stripExtension(name, /\.md$/iu), /\.canvas$/iu)) === fold(stripExtension(queryNoteStem, /\.canvas$/iu));
    }
    return fold(name) === fold(queryName);
  });
  if (matches.length !== 1) return null;
  return sourceToTarget.get(pathKey(matches[0]!)) ?? null;
}

function wikiTargetForMappedPath(path: string): string {
  return /\.md$/iu.test(path) ? path.replace(/\.md$/iu, '') : path;
}

function rewriteWikiLinks(
  source: string,
  sourcePath: string,
  sourceToTarget: ReadonlyMap<string, string>,
  sourceFiles: readonly string[],
): { text: string; count: number } {
  const replacements: Array<{ from: number; to: number; value: string }> = [];
  for (const reference of parseWikiReferences(source)) {
    if (!reference.note) continue;
    const mapped = resolveMappedFile(reference.note, sourcePath, sourceToTarget, sourceFiles);
    if (!mapped) continue;
    const targetNote = wikiTargetForMappedPath(mapped);
    if (fold(targetNote) === fold(reference.note)) continue;
    const suffix = reference.targetText.slice(reference.note.length);
    const target = targetNote + suffix;
    const value = `${reference.embed ? '!' : ''}[[${target}${reference.alias ? '|' + reference.alias : ''}]]`;
    replacements.push({ from: reference.from, to: reference.to, value });
  }

  let text = source;
  for (const replacement of replacements.sort((a, b) => b.from - a.from)) {
    text = text.slice(0, replacement.from) + replacement.value + text.slice(replacement.to);
  }
  return { text, count: replacements.length };
}

function rewriteMarkdownLinks(
  source: string,
  sourcePath: string,
  sourceToTarget: ReadonlyMap<string, string>,
  sourceFiles: readonly string[],
): { text: string; count: number } {
  let count = 0;
  const text = source.replace(/(!?\[[^\]\n]*\]\()(<[^>]+>|[^)\s]+)(\s+(?:"[^"]*"|'[^']*'))?(\))/gu, (whole, prefix: string, rawHref: string, title: string | undefined, suffix: string) => {
    const wrapped = rawHref.startsWith('<') && rawHref.endsWith('>');
    const href = wrapped ? rawHref.slice(1, -1) : rawHref;
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(href) || href.startsWith('#')) return whole;
    const hashAt = href.indexOf('#');
    const pathPartRaw = hashAt >= 0 ? href.slice(0, hashAt) : href;
    const fragment = hashAt >= 0 ? href.slice(hashAt) : '';
    let pathPart = pathPartRaw;
    try { pathPart = decodeURIComponent(pathPartRaw); } catch { /* preserve undecodable path */ }
    const mapped = resolveMappedFile(pathPart, sourcePath, sourceToTarget, sourceFiles);
    if (!mapped) return whole;
    const encoded = mapped.split('/').map(segment => encodeURIComponent(segment)).join('/') + fragment;
    if (encoded === href) return whole;
    count++;
    return prefix + (wrapped ? `<${encoded}>` : encoded) + (title ?? '') + suffix;
  });
  return { text, count };
}

function canvasRecord(value: unknown): JsonCanvasRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonCanvasRecord : null;
}

function edgeRecord(value: unknown): JsonCanvasEdgeRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonCanvasEdgeRecord : null;
}

function convertJsonCanvas(
  parsed: JsonCanvas,
  sourcePath: string,
  sourceToTarget: ReadonlyMap<string, string>,
  sourceFiles: readonly string[],
  report: ObsidianMigrationReport,
): CanvasDocument {
  const usedNodeIds = new Set<string>();
  const usedEdgeIds = new Set<string>();
  const usedGroupIds = new Set<string>();
  const idMap = new Map<string, string>();
  const nodes: CanvasNode[] = [];
  const groups: CanvasGroup[] = [];

  for (const rawValue of parsed.nodes ?? []) {
    const raw = canvasRecord(rawValue);
    if (!raw) continue;
    const originalId = typeof raw.id === 'string' ? raw.id : `node-${idMap.size + 1}`;
    const type = typeof raw.type === 'string' ? raw.type : '';
    const x = safeNumber(raw.x, 0, -1_000_000, 1_000_000);
    const y = safeNumber(raw.y, 0, -1_000_000, 1_000_000);
    const width = safeNumber(raw.width, 260, type === 'group' ? 180 : 120, 4000);
    const height = safeNumber(raw.height, 160, type === 'group' ? 120 : 80, 4000);

    if (type === 'group') {
      const id = objectId(originalId, 'group', usedGroupIds);
      idMap.set(originalId, id);
      groups.push({
        id,
        title: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : 'Group',
        x, y, width, height,
      });
      continue;
    }

    const id = objectId(originalId, 'node', usedNodeIds);
    idMap.set(originalId, id);
    if (type === 'text') {
      nodes.push({ id, type: 'text', text: typeof raw.text === 'string' ? raw.text : '', x, y, width, height });
      continue;
    }

    if (type === 'file' && typeof raw.file === 'string') {
      const mapped = resolveMappedFile(raw.file, sourcePath, sourceToTarget, sourceFiles);
      const target = mapped ?? raw.file.replace(/\\/gu, '/');
      const subpath = typeof raw.subpath === 'string' ? raw.subpath : '';
      if (/\.md$/iu.test(target)) {
        nodes.push({ id, type: 'note', target: target.replace(/\.md$/iu, '') + subpath, x, y, width, height });
      } else {
        nodes.push({ id, type: 'media', target, alt: null, x, y, width, height });
      }
      if (!mapped) report.warnings.push(`Canvas ${sourcePath} references an external or unresolved file: ${raw.file}`);
      continue;
    }

    if (type === 'link' && typeof raw.url === 'string') {
      nodes.push({ id, type: 'text', text: raw.url, x, y, width, height });
      report.warnings.push(`Canvas ${sourcePath} web-link cards were preserved as text URLs.`);
      continue;
    }

    nodes.push({ id, type: 'text', text: `Unsupported Obsidian Canvas node: ${type || 'unknown'}`, x, y, width, height });
    report.warnings.push(`Canvas ${sourcePath} contained an unsupported ${type || 'unknown'} node.`);
  }

  const nodeIds = new Set(nodes.map(node => node.id));
  const edges: CanvasEdge[] = [];
  for (const rawValue of parsed.edges ?? []) {
    const raw = edgeRecord(rawValue);
    if (!raw || typeof raw.fromNode !== 'string' || typeof raw.toNode !== 'string') continue;
    let from = idMap.get(raw.fromNode);
    let to = idMap.get(raw.toNode);
    if (!from || !to || !nodeIds.has(from) || !nodeIds.has(to) || from === to) {
      report.warnings.push(`Canvas ${sourcePath} skipped an edge connected to a group or missing node.`);
      continue;
    }
    if (raw.fromEnd === 'arrow' && raw.toEnd !== 'arrow') [from, to] = [to, from];
    if (raw.fromEnd === 'arrow' && raw.toEnd === 'arrow') {
      report.warnings.push(`Canvas ${sourcePath} bidirectional arrow was approximated as one directed connection.`);
    }
    const id = objectId(raw.id, 'edge', usedEdgeIds);
    edges.push({
      id,
      from,
      to,
      label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : null,
    });
    if (raw.color !== undefined) report.warnings.push(`Canvas ${sourcePath} edge colors are not represented in Vault Canvas v1.`);
  }

  return {
    version: 1,
    id: objectId(stripExtension(basename(sourcePath), /\.canvas$/iu), 'canvas', new Set()),
    viewport: { x: 80, y: 80, zoom: 1 },
    nodes,
    edges,
    groups,
  };
}

function tryParseJsonCanvas(file: ArchiveFile): JsonCanvas | null {
  try {
    if (file.bytes.byteLength > MAX_CANVAS_BYTES) return null;
    const parsed = JSON.parse(decodeUtf8(file.bytes, file.path, MAX_CANVAS_BYTES)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const canvas = parsed as JsonCanvas;
    if (!Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges)) return null;
    return canvas;
  } catch {
    return null;
  }
}

function vaultOnlyBlockCount(text: string): number {
  return (text.match(/^ {0,3}(?:```|~~~)(?:vault-query|vault-board|vault-canvas)\s*$/gimu) ?? []).length;
}

export function planObsidianMigration(
  inputFiles: readonly ArchiveFile[],
  sourceName = 'Obsidian vault',
  initialWarnings: readonly string[] = [],
): ObsidianMigrationPlan {
  const duplicate = new Set<string>();
  for (const file of inputFiles) {
    const key = pathKey(file.path);
    if (duplicate.has(key)) throw new VaultError('CORRUPT', 'Migration source contains duplicate or case-colliding paths.');
    duplicate.add(key);
  }

  const root = commonTopLevel(inputFiles);
  const report: ObsidianMigrationReport = {
    sourceEntries: inputFiles.length,
    markdownNotes: 0,
    attachments: 0,
    canvasesConverted: 0,
    canvasesPreservedRaw: 0,
    directories: 0,
    ignoredConfiguration: 0,
    ignoredSystemFiles: 0,
    rewrittenWikiLinks: 0,
    rewrittenMarkdownLinks: 0,
    vaultOnlyBlocksPreserved: 0,
    detectedCommunityPlugins: [],
    renamedPaths: [],
    warnings: [...initialWarnings],
  };

  const sourceItems: SourceItem[] = [];
  for (const original of inputFiles) {
    const path = stripRoot(original.path, root);
    if (!path) continue;
    const key = pathKey(path);
    if (key === '.ds_store' || key.startsWith('__macosx/') || key.endsWith('/.ds_store')) {
      report.ignoredSystemFiles++;
      continue;
    }
    if (key === '.obsidian/community-plugins.json') {
      report.detectedCommunityPlugins.push(...parseCommunityPlugins(original));
      report.ignoredConfiguration++;
      continue;
    }
    if (key === '.obsidian' || key.startsWith('.obsidian/')) {
      report.ignoredConfiguration++;
      continue;
    }
    if (key === '.trash' || key.startsWith('.trash/') || key === '.git' || key.startsWith('.git/')) {
      report.ignoredSystemFiles++;
      continue;
    }
    if (original.directory) {
      sourceItems.push({ sourcePath: path, directory: true, bytes: new Uint8Array(), modifiedAt: original.modifiedAt, kind: 'attachment' });
      continue;
    }

    const lower = fold(path);
    if (lower.endsWith('.md')) {
      sourceItems.push({ sourcePath: path, directory: false, bytes: original.bytes, modifiedAt: original.modifiedAt, kind: 'markdown' });
    } else if (lower.endsWith('.canvas')) {
      const parsed = tryParseJsonCanvas(original);
      sourceItems.push({
        sourcePath: path,
        directory: false,
        bytes: original.bytes,
        modifiedAt: original.modifiedAt,
        kind: parsed ? 'canvas' : 'attachment',
        ...(parsed ? { canvasJson: parsed } : {}),
      });
      if (!parsed) {
        report.canvasesPreservedRaw++;
        report.warnings.push(`Could not parse ${path} as JSON Canvas; the original file will be imported as an attachment.`);
      }
    } else {
      sourceItems.push({ sourcePath: path, directory: false, bytes: original.bytes, modifiedAt: original.modifiedAt, kind: 'attachment' });
    }
  }

  report.detectedCommunityPlugins = [...new Set(report.detectedCommunityPlugins)].sort();

  const directorySources = new Set<string>();
  for (const item of sourceItems) {
    const path = item.sourcePath.replace(/\/$/u, '');
    const segments = splitPath(path);
    const stop = item.directory ? segments.length : Math.max(0, segments.length - 1);
    for (let length = 1; length <= stop; length++) directorySources.add(segments.slice(0, length).join('/'));
  }

  const used = new Map<string, Set<string>>();
  const directoryMap = new Map<string, string>([['', '']]);
  const directories: PlannedDirectory[] = [];
  for (const sourceDirectory of [...directorySources].sort((a, b) => splitPath(a).length - splitPath(b).length || a.localeCompare(b))) {
    const parentSource = parentPath(sourceDirectory);
    const parentTarget = directoryMap.get(parentSource);
    if (parentTarget === undefined) throw new VaultError('CORRUPT', 'Migration directory hierarchy could not be constructed.');
    const rawName = basename(sourceDirectory);
    const sanitized = sanitizeSegment(rawName);
    const allocated = uniqueName(parentTarget, sanitized.name, used);
    const target = joinPath(parentTarget, allocated.name);
    directoryMap.set(sourceDirectory, target);
    directories.push({ sourcePath: sourceDirectory, path: target });
    if (sanitized.changed || allocated.collided || target !== sourceDirectory) {
      report.renamedPaths.push({
        from: sourceDirectory,
        to: target,
        reason: allocated.collided ? 'collision' : 'portable-name',
      });
    }
  }

  const sourceToTargetPath = new Map<string, string>();
  const fileTargetNames = new Map<string, string>();
  for (const item of sourceItems.filter(item => !item.directory).sort((a, b) => a.sourcePath.localeCompare(b.sourcePath))) {
    const sourceParent = parentPath(item.sourcePath);
    const targetParent = directoryMap.get(sourceParent) ?? '';
    const raw = basename(item.sourcePath);
    const desiredRaw = item.kind === 'canvas' ? raw + '.md' : raw;
    const sanitized = sanitizeSegment(desiredRaw);
    const allocated = uniqueName(targetParent, sanitized.name, used);
    const target = joinPath(targetParent, allocated.name);
    sourceToTargetPath.set(pathKey(item.sourcePath), target);
    fileTargetNames.set(item.sourcePath, target);
    if (item.kind === 'canvas') {
      report.renamedPaths.push({ from: item.sourcePath, to: target, reason: 'canvas-conversion' });
    } else if (sanitized.changed || allocated.collided || target !== item.sourcePath) {
      report.renamedPaths.push({
        from: item.sourcePath,
        to: target,
        reason: allocated.collided ? 'collision' : 'portable-name',
      });
    }
  }

  const sourceFiles = sourceItems.filter(item => !item.directory).map(item => item.sourcePath);
  const files: PlannedObsidianFile[] = [];
  for (const item of sourceItems.filter(item => !item.directory).sort((a, b) => a.sourcePath.localeCompare(b.sourcePath))) {
    const target = fileTargetNames.get(item.sourcePath)!;
    if (item.kind === 'markdown') {
      const raw = decodeUtf8(item.bytes, item.sourcePath, MAX_MARKDOWN_BYTES);
      const wiki = rewriteWikiLinks(raw, item.sourcePath, sourceToTargetPath, sourceFiles);
      const markdown = rewriteMarkdownLinks(wiki.text, item.sourcePath, sourceToTargetPath, sourceFiles);
      report.markdownNotes++;
      report.rewrittenWikiLinks += wiki.count;
      report.rewrittenMarkdownLinks += markdown.count;
      report.vaultOnlyBlocksPreserved += vaultOnlyBlockCount(markdown.text);
      if (/^ {0,3}(?:```|~~~)dataview(?:js)?\s*$/imu.test(markdown.text)) {
        report.warnings.push(`${item.sourcePath} contains Dataview blocks; source is preserved but Vault does not execute Dataview.`);
      }
      files.push({
        kind: 'markdown',
        sourcePath: item.sourcePath,
        path: target,
        text: markdown.text,
        modifiedAt: item.modifiedAt,
        sourceKind: 'markdown',
      });
      continue;
    }

    if (item.kind === 'canvas' && item.canvasJson) {
      const document = convertJsonCanvas(item.canvasJson, item.sourcePath, sourceToTargetPath, sourceFiles, report);
      files.push({
        kind: 'markdown',
        sourcePath: item.sourcePath,
        path: target,
        text: [
          `# ${stripExtension(basename(item.sourcePath), /\.canvas$/iu)}`,
          '',
          '```vault-canvas',
          serializeCanvasDocument(document),
          '```',
          '',
        ].join('\n'),
        modifiedAt: item.modifiedAt,
        sourceKind: 'canvas',
      });
      report.markdownNotes++;
      report.canvasesConverted++;
      continue;
    }

    if (item.bytes.byteLength > 128 * 1024 * 1024) {
      report.warnings.push(`${item.sourcePath} was skipped because it exceeds Vault's 128 MB attachment limit.`);
      continue;
    }
    files.push({
      kind: 'attachment',
      sourcePath: item.sourcePath,
      path: target,
      bytes: item.bytes.slice(),
      mimeType: normalizeAttachmentMimeType(target, ''),
      modifiedAt: item.modifiedAt,
    });
    report.attachments++;
  }

  report.directories = directories.length;
  report.warnings = [...new Set(report.warnings)];

  return {
    suggestedVaultName: suggestedVaultName(root, sourceName),
    directories,
    files,
    sourceToTargetPath,
    report,
  };
}

function targetPathForCanvasReference(target: string, sourceNotePath: string, notePaths: readonly string[], attachmentPaths: readonly string[]): string {
  const clean = target.replace(/^\.\//u, '');
  const sourceDir = parentPath(sourceNotePath);
  const noteCandidates = notePaths.filter(path => {
    const withoutMd = path.replace(/\.md$/iu, '');
    if (fold(withoutMd) === fold(clean) || fold(path) === fold(clean)) return true;
    if (sourceDir && (fold(withoutMd) === fold(joinPath(sourceDir, clean)) || fold(path) === fold(joinPath(sourceDir, clean)))) return true;
    return !clean.includes('/') && fold(basename(withoutMd)) === fold(clean);
  });
  if (noteCandidates.length === 1) return noteCandidates[0]!;
  const attachmentCandidates = attachmentPaths.filter(path => {
    if (fold(path) === fold(clean)) return true;
    if (sourceDir && fold(path) === fold(joinPath(sourceDir, clean))) return true;
    return !clean.includes('/') && fold(basename(path)) === fold(clean);
  });
  if (attachmentCandidates.length === 1) return attachmentCandidates[0]!;
  return /\.md$/iu.test(clean) ? clean : clean;
}

function vaultCanvasToJson(
  document: CanvasDocument,
  sourceNotePath: string,
  notePaths: readonly string[],
  attachmentPaths: readonly string[],
): { nodes: object[]; edges: object[] } {
  const nodes: object[] = [];
  for (const node of document.nodes) {
    if (node.type === 'text') {
      nodes.push({ id: node.id, type: 'text', text: node.text, x: node.x, y: node.y, width: node.width, height: node.height });
    } else {
      const path = targetPathForCanvasReference(node.target.replace(/#.*$/u, ''), sourceNotePath, notePaths, attachmentPaths);
      const subpath = node.type === 'note' && node.target.includes('#') ? '#' + node.target.split('#').slice(1).join('#') : undefined;
      nodes.push({
        id: node.id,
        type: 'file',
        file: node.type === 'note' && !/\.md$/iu.test(path) ? path + '.md' : path,
        ...(subpath ? { subpath } : {}),
        x: node.x, y: node.y, width: node.width, height: node.height,
      });
    }
  }
  for (const group of document.groups) {
    nodes.push({ id: group.id, type: 'group', label: group.title, x: group.x, y: group.y, width: group.width, height: group.height });
  }
  const edges = document.edges.map(edge => ({
    id: edge.id,
    fromNode: edge.from,
    toNode: edge.to,
    toEnd: 'arrow',
    ...(edge.label ? { label: edge.label } : {}),
  }));
  return { nodes, edges };
}

export function obsidianExportFiles(snapshotFiles: readonly ExportFile[], markdownByPath: ReadonlyMap<string, string>, canvasDocumentsByPath: ReadonlyMap<string, readonly CanvasDocument[]>): ObsidianExportResult {
  const files = snapshotFiles.map(file => ({ path: file.path, bytes: file.bytes.slice() }));
  const used = new Set(files.map(file => pathKey(file.path)));
  const notePaths = [...markdownByPath.keys()];
  const attachmentPaths = files.filter(file => !file.path.endsWith('/') && !/\.md$/iu.test(file.path)).map(file => file.path);
  const report: ObsidianExportReport = {
    markdownFiles: notePaths.length,
    attachments: attachmentPaths.length,
    canvasCompanions: 0,
    vaultOnlyBlocksPreserved: 0,
    warnings: [],
  };

  for (const [path, markdown] of markdownByPath) {
    report.vaultOnlyBlocksPreserved += vaultOnlyBlockCount(markdown);
    const documents = canvasDocumentsByPath.get(path) ?? [];
    for (let index = 0; index < documents.length; index++) {
      const stem = path.replace(/\.md$/iu, '');
      let candidate = documents.length === 1 ? stem + '.canvas' : `${stem} - Canvas ${index + 1}.canvas`;
      let serial = 2;
      while (used.has(pathKey(candidate))) candidate = `${stem} - Canvas ${index + 1} (${serial++}).canvas`;
      used.add(pathKey(candidate));
      const json = vaultCanvasToJson(documents[index]!, path, notePaths, attachmentPaths);
      files.push({ path: candidate, bytes: encoder.encode(JSON.stringify(json, null, 2)) });
      report.canvasCompanions++;
    }
  }

  if (report.vaultOnlyBlocksPreserved > report.canvasCompanions) {
    report.warnings.push('Vault-specific query/board fences remain in Markdown as code because Obsidian has no native equivalent.');
  }
  return { files, report };
}

export async function browserFilesToArchiveFiles(files: readonly File[]): Promise<{ files: ArchiveFile[]; rootName: string | null }> {
  const output: ArchiveFile[] = [];
  let rootName: string | null = null;
  for (const file of files) {
    const relative = (file.webkitRelativePath || file.name).replace(/\\/gu, '/');
    const segments = splitPath(relative);
    if (file.webkitRelativePath && segments.length > 1) {
      rootName ??= segments[0]!;
      if (rootName !== segments[0]) rootName = null;
    }
    output.push({
      path: relative,
      bytes: new Uint8Array(await file.arrayBuffer()),
      directory: false,
      modifiedAt: file.lastModified ? new Date(file.lastModified).toISOString() : null,
    });
  }
  return { files: output, rootName };
}
