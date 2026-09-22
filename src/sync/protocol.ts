import { validateName } from '../domain/paths.js';
import { VaultError } from '../domain/errors.js';
import type { DeviceId, EntryId, OperationId, VaultId } from '../domain/model.js';

export const PROTOCOL_VERSION = 1 as const;
export type Cursor = string; // PostgreSQL bigint must never pass through a JS Number.
export interface RemoteAttachmentRef {
  sha256: string;
  mimeType: string;
  size: number;
}

export type Mutation =
  | { kind: 'create'; entryId: EntryId; parentId: EntryId | null; name: string; entryKind: 'directory' | 'markdown' | 'attachment'; text: string; attachment?: RemoteAttachmentRef }
  | { kind: 'write'; entryId: EntryId; baseRevision: number; text: string }
  | { kind: 'move'; entryId: EntryId; baseRevision: number; parentId: EntryId | null; name: string }
  | { kind: 'trash' | 'restore'; entryId: EntryId; baseRevision: number };
export interface Operation {
  protocolVersion: typeof PROTOCOL_VERSION;
  id: OperationId;
  vaultId: VaultId;
  deviceId: DeviceId;
  /** Explicit authenticated owner binding prevents switching-account uploads. */
  ownerId: string;
  mutations: readonly Mutation[];
}
export interface SealedOperation {
  id: OperationId;
  vaultId: VaultId;
  ownerId: string;
  wire: string;
  sha256: string;
}
export interface SyncEvent {
  sequence: Cursor;
  operationId: OperationId;
  entryId: EntryId;
  revision: number;
  kind: Mutation['kind'];
}
export interface ChangePage {
  protocolVersion: typeof PROTOCOL_VERSION;
  vaultId: VaultId;
  epoch: string;
  after: Cursor;
  through: Cursor;
  highWatermark: Cursor;
  events: readonly SyncEvent[];
}

function cursor(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 19) throw new VaultError('PROTOCOL', 'Invalid synchronization cursor.');
  const parsed = BigInt(value);
  if (parsed > 9223372036854775807n) throw new VaultError('PROTOCOL', 'Synchronization cursor exceeds PostgreSQL bigint.');
  return parsed;
}

/** Validate an entire page before applying any event or advancing its cursor. */
export function validatePage(page: unknown, expected: { vaultId: VaultId; epoch: string; after: Cursor }): Cursor {
  if (!record(page) || page.protocolVersion !== PROTOCOL_VERSION || !uuidValue(page.vaultId) || !uuidValue(page.epoch)
    || page.vaultId !== expected.vaultId || page.epoch !== expected.epoch || page.after !== expected.after
    || !Array.isArray(page.events) || page.events.length > 1000) {
    throw new VaultError('PROTOCOL', 'The change page does not match this vault, protocol or synchronization epoch.');
  }
  let previous = cursor(page.after); const highWatermark = cursor(page.highWatermark);
  if (highWatermark < previous) throw new VaultError('PROTOCOL', 'The server cursor moved backwards.');
  for (const event of page.events) {
    if (!record(event) || !uuidValue(event.operationId) || !uuidValue(event.entryId)
      || typeof event.kind !== 'string' || !['create', 'write', 'move', 'trash', 'restore'].includes(event.kind)
      || typeof event.revision !== 'number' || !Number.isSafeInteger(event.revision) || event.revision < 1) {
      throw new VaultError('PROTOCOL', 'Invalid change event identity, kind or revision.');
    }
    const next = cursor(event.sequence);
    if (next !== previous + 1n || next > highWatermark) throw new VaultError('PROTOCOL', 'The change page contains a gap, duplicate or invalid revision. Reconciliation is required.');
    previous = next;
  }
  if (cursor(page.through) !== previous) throw new VaultError('PROTOCOL', 'The page cursor would skip changes.');
  if (!page.events.length && previous !== highWatermark) throw new VaultError('PROTOCOL', 'An empty page cannot skip unseen changes.');
  return page.through as Cursor;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const uuidValue = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value);

/** Runtime validation, not only a TypeScript assertion. Server-side validation is still mandatory. */
export function validateOperation(operation: unknown): asserts operation is Operation {
  if (!record(operation) || operation.protocolVersion !== PROTOCOL_VERSION || !uuidValue(operation.id)
    || !uuidValue(operation.vaultId) || !uuidValue(operation.deviceId) || !uuidValue(operation.ownerId)
    || !Array.isArray(operation.mutations) || operation.mutations.length < 1 || operation.mutations.length > 1000) {
    throw new VaultError('PROTOCOL', 'Invalid operation envelope.');
  }
  for (const mutation of operation.mutations) {
    if (!record(mutation) || !uuidValue(mutation.entryId) || !['create', 'write', 'move', 'trash', 'restore'].includes(String(mutation.kind))) {
      throw new VaultError('PROTOCOL', 'Invalid mutation or file identity.');
    }
    if (mutation.kind !== 'create' && (typeof mutation.baseRevision !== 'number' || !Number.isSafeInteger(mutation.baseRevision) || mutation.baseRevision < 1)) {
      throw new VaultError('PROTOCOL', 'Invalid base revision.');
    }
    if (mutation.kind === 'create' || mutation.kind === 'move') {
      if (mutation.parentId !== null && !uuidValue(mutation.parentId)) throw new VaultError('PROTOCOL', 'Invalid folder identity.');
      if (typeof mutation.name !== 'string' || validateName(mutation.name) !== mutation.name) throw new VaultError('PROTOCOL', 'Names must be normalized before sealing.');
    }
    if (mutation.kind === 'write' || mutation.kind === 'create') {
      if (typeof mutation.text !== 'string') throw new VaultError('PROTOCOL', 'Markdown content must be a string.');
    }
    if (mutation.kind === 'create') {
      if (!['directory', 'markdown', 'attachment'].includes(String(mutation.entryKind))) throw new VaultError('PROTOCOL', 'Invalid entry kind.');
      if (mutation.entryKind === 'directory' && (mutation.text !== '' || mutation.attachment !== undefined)) {
        throw new VaultError('PROTOCOL', 'Directories cannot have Markdown or attachment content.');
      }
      if (mutation.entryKind === 'markdown') {
        if (!/\.md$/i.test(String(mutation.name))) throw new VaultError('PROTOCOL', 'Markdown files require the .md extension.');
        if (mutation.attachment !== undefined) throw new VaultError('PROTOCOL', 'Markdown creates cannot include attachment metadata.');
      }
      if (mutation.entryKind === 'attachment') {
        if (mutation.text !== '') throw new VaultError('PROTOCOL', 'Attachments cannot include Markdown text.');
        const attachment=mutation.attachment;
        if (!record(attachment) || typeof attachment.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(attachment.sha256)
          || typeof attachment.mimeType !== 'string' || attachment.mimeType.length < 1 || attachment.mimeType.length > 200
          || typeof attachment.size !== 'number' || !Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > 134217728) {
          throw new VaultError('PROTOCOL', 'Invalid attachment metadata.');
        }
      }
    }
  }
}

export function decodeOperation(wire: string): Operation {
  let parsed: unknown;
  try { parsed = JSON.parse(wire) as unknown; } catch { throw new VaultError('PROTOCOL', 'Invalid operation JSON.'); }
  validateOperation(parsed);
  return parsed;
}

/** Seal once, outside IndexedDB. Retries send these exact bytes and reuse this ID. */
export async function sealOperation(operation: Operation): Promise<SealedOperation> {
  validateOperation(operation);
  const wire = JSON.stringify(operation);
  // Capture identity from the exact serialized request BEFORE yielding to hashing.
  // The caller may mutate its original object while the digest promise is pending.
  const snapshot = decodeOperation(wire);
  const bytes = new TextEncoder().encode(wire);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const sha256 = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
  return Object.freeze({ id: snapshot.id, vaultId: snapshot.vaultId, ownerId: snapshot.ownerId, wire, sha256 });
}

export function assertOwner(operation: SealedOperation, authenticatedUserId: string): void {
  if (operation.ownerId !== authenticatedUserId) throw new VaultError('ACCOUNT_MISMATCH', 'This queued operation belongs to a different account. It will not be uploaded.');
}

export function retryDelay(attempt: number, random: number): number {
  if (!Number.isInteger(attempt) || attempt < 0 || !Number.isFinite(random) || random < 0 || random > 1) throw new VaultError('PROTOCOL', 'Invalid retry parameters.');
  return Math.round(Math.min(60_000, 500 * 2 ** Math.min(attempt, 10)) * (0.5 + random * 0.5));
}
