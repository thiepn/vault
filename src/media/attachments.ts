import { VaultError } from '../domain/errors.js';
import type { Entry, EntryId } from '../domain/model.js';
import { VaultTree } from '../domain/tree.js';
import type { KnowledgeRecord, WikiSuggestion } from '../knowledge/types.js';

export const MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024;

export type AttachmentMediaKind = 'image' | 'audio' | 'video' | 'pdf' | 'file';
export type AttachmentResolution =
  | { status: 'resolved'; entryId: EntryId }
  | { status: 'ambiguous'; entryIds: EntryId[] }
  | { status: 'unresolved' };

const fold = (value: string): string => value.normalize('NFC').toLocaleLowerCase();

const mimeByExtension = new Map<string, string>([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['svg', 'image/svg+xml'],
  ['avif', 'image/avif'],
  ['bmp', 'image/bmp'],
  ['ico', 'image/x-icon'],
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
  ['ogg', 'audio/ogg'],
  ['m4a', 'audio/mp4'],
  ['flac', 'audio/flac'],
  ['mp4', 'video/mp4'],
  ['webm', 'video/webm'],
  ['mov', 'video/quicktime'],
  ['pdf', 'application/pdf'],
  ['txt', 'text/plain'],
  ['csv', 'text/csv'],
  ['json', 'application/json'],
  ['zip', 'application/zip'],
]);

export function normalizeAttachmentMimeType(filename: string, raw: string | null | undefined): string {
  const candidate = raw?.trim().toLocaleLowerCase();
  if (candidate && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(candidate)) return candidate;
  const extension = filename.split('.').at(-1)?.toLocaleLowerCase() ?? '';
  return mimeByExtension.get(extension) ?? 'application/octet-stream';
}

export function attachmentMediaKind(mimeType: string): AttachmentMediaKind {
  const mime = mimeType.toLocaleLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  return 'file';
}

export function validateAttachmentBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array)) throw new VaultError('CORRUPT', 'Attachment data must be binary bytes.');
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new VaultError('UNSUPPORTED', 'Individual attachments are limited to 128 MB in this browser-first release.');
  }
}

export function resolveAttachmentTarget(
  rawTarget: string,
  currentEntryId: EntryId | undefined,
  entries: readonly Entry[],
): AttachmentResolution {
  const active = entries.filter(entry => entry.kind === 'attachment' && entry.deletedAt === null);
  const query = rawTarget.replace(/^\.\//u, '').trim();
  if (!query) return { status: 'unresolved' };
  const q = fold(query);
  const tree = new VaultTree(entries);
  const current = currentEntryId ? entries.find(entry => entry.id === currentEntryId && entry.deletedAt === null) : undefined;
  const currentParent = current?.parentId ?? null;
  const scored: Array<{ entryId: EntryId; score: number; path: string }> = [];

  for (const entry of active) {
    const path = tree.path(entry.id);
    let score = -1;
    if (fold(path) === q) score = 120;
    else if (query.includes('/') && current) {
      const currentPath = tree.path(current.id);
      const slash = currentPath.lastIndexOf('/');
      const relative = slash >= 0 ? `${currentPath.slice(0, slash)}/${query}` : query;
      if (fold(path) === fold(relative)) score = 115;
    } else if (entry.parentId === currentParent && fold(entry.name) === q) score = 110;
    else if (fold(entry.name) === q) score = 100;
    if (score >= 0) scored.push({ entryId: entry.id, score, path });
  }

  if (!scored.length) return { status: 'unresolved' };
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  const best = scored[0]!.score;
  const tied = scored.filter(item => item.score === best);
  if (tied.length > 1) return { status: 'ambiguous', entryIds: tied.map(item => item.entryId) };
  return { status: 'resolved', entryId: scored[0]!.entryId };
}

export function canonicalAttachmentTarget(entryId: EntryId, entries: readonly Entry[]): string {
  const target = entries.find(entry => entry.id === entryId && entry.kind === 'attachment' && entry.deletedAt === null);
  return target ? new VaultTree(entries).path(target.id) : '';
}

export function attachmentSuggestions(query: string, entries: readonly Entry[]): WikiSuggestion[] {
  const q = fold(query.trim());
  const tree = new VaultTree(entries);
  return entries
    .filter(entry => entry.kind === 'attachment' && entry.deletedAt === null)
    .flatMap(entry => {
      const path = tree.path(entry.id);
      const name = entry.name;
      const nameFold = fold(name);
      const pathFold = fold(path);
      let boost = 0;
      if (!q) boost = 12;
      else if (nameFold === q) boost = 96;
      else if (nameFold.startsWith(q)) boost = 82;
      else if (nameFold.includes(q)) boost = 64;
      else if (pathFold.includes(q)) boost = 54;
      else return [];
      return [{ label: name, insert: path, detail: `Attachment · ${path}`, boost }];
    })
    .sort((a, b) => b.boost - a.boost || a.label.localeCompare(b.label))
    .slice(0, 40);
}

export function attachmentReferenceCounts(
  entries: readonly Entry[],
  records: readonly KnowledgeRecord[],
): Map<EntryId, number> {
  const counts = new Map<EntryId, number>();
  for (const entry of entries) if (entry.kind === 'attachment' && entry.deletedAt === null) counts.set(entry.id, 0);
  for (const record of records) {
    for (const reference of record.links) {
      if (!reference.note) continue;
      const resolution = resolveAttachmentTarget(reference.note, record.entryId, entries);
      if (resolution.status !== 'resolved') continue;
      counts.set(resolution.entryId, (counts.get(resolution.entryId) ?? 0) + 1);
    }
  }
  return counts;
}

export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
