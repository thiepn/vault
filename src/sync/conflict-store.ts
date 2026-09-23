import { VaultError } from '../domain/errors.js';
import type { EntryId, MarkdownConflictRecord, VaultId } from '../domain/model.js';
import { storageDriver, type LocalStorageDriver } from '../storage/driver.js';

export interface RecordMarkdownConflictInput {
  vaultId: VaultId;
  entryId: EntryId;
  conflictEntryId: EntryId;
  ownerId: string;
  epoch: string;
  baseRevision: number;
  remoteRevision: number;
  baseText: string;
  localText: string;
  remoteText: string;
  source: 'pull' | 'push';
}

function validateRecord(record: MarkdownConflictRecord): void {
  if (!record.id || record.id.length > 180) throw new VaultError('CORRUPT', 'Conflict record identity is invalid.');
  if (!record.ownerId || !record.epoch) throw new VaultError('CORRUPT', 'Conflict account/epoch identity is missing.');
  if (!Number.isSafeInteger(record.baseRevision) || record.baseRevision < 1
    || !Number.isSafeInteger(record.remoteRevision) || record.remoteRevision < 1) {
    throw new VaultError('CORRUPT', 'Conflict revisions are invalid.');
  }
  if (record.remoteRevision <= record.baseRevision) throw new VaultError('CORRUPT', 'Conflict remote revision must advance the base.');
  if (typeof record.baseText !== 'string' || typeof record.localText !== 'string' || typeof record.remoteText !== 'string') {
    throw new VaultError('CORRUPT', 'Conflict Markdown snapshots are invalid.');
  }
  if (record.status !== 'open' && record.status !== 'resolved') throw new VaultError('CORRUPT', 'Conflict status is invalid.');
}

export function markdownConflictId(entryId: EntryId, remoteRevision: number): string {
  if (!Number.isSafeInteger(remoteRevision) || remoteRevision < 1) {
    throw new VaultError('CORRUPT', 'Conflict remote revision is invalid.');
  }
  return String(entryId) + ':' + remoteRevision;
}

export class MarkdownConflictStore {
  private readonly driver: LocalStorageDriver;

  constructor(database: IDBDatabase | LocalStorageDriver) {
    this.driver = storageDriver(database);
  }

  async record(input: RecordMarkdownConflictInput): Promise<MarkdownConflictRecord> {
    const id = markdownConflictId(input.entryId, input.remoteRevision);
    return this.driver.transaction(['conflicts'], 'readwrite', async tx => {
      const previous = await tx.store('conflicts').get<MarkdownConflictRecord>(id);
      if (previous) {
        validateRecord(previous);
        if (previous.vaultId !== input.vaultId
          || previous.entryId !== input.entryId
          || previous.ownerId !== input.ownerId
          || previous.epoch !== input.epoch
          || previous.remoteRevision !== input.remoteRevision
          || previous.baseText !== input.baseText
          || previous.localText !== input.localText
          || previous.remoteText !== input.remoteText) {
          throw new VaultError('PROTOCOL', 'Conflict identity was reused with different Markdown snapshots.');
        }
        return previous;
      }

      const timestamp = new Date().toISOString();
      const record: MarkdownConflictRecord = {
        id,
        vaultId: input.vaultId,
        entryId: input.entryId,
        conflictEntryId: input.conflictEntryId,
        ownerId: input.ownerId,
        epoch: input.epoch,
        baseRevision: input.baseRevision,
        remoteRevision: input.remoteRevision,
        baseText: input.baseText,
        localText: input.localText,
        remoteText: input.remoteText,
        source: input.source,
        status: 'open',
        createdAt: timestamp,
        updatedAt: timestamp,
        resolvedAt: null,
        resolutionText: null,
      };
      validateRecord(record);
      await tx.store('conflicts').add(record);
      return record;
    });
  }

  async get(id: string): Promise<MarkdownConflictRecord | null> {
    const record = await this.driver.transaction(
      ['conflicts'],
      'readonly',
      tx => tx.store('conflicts').get<MarkdownConflictRecord>(id),
    );
    if (!record) return null;
    validateRecord(record);
    return record;
  }

  async forRemote(entryId: EntryId, remoteRevision: number): Promise<MarkdownConflictRecord | null> {
    return this.get(markdownConflictId(entryId, remoteRevision));
  }

  async listOpen(vaultId: VaultId): Promise<MarkdownConflictRecord[]> {
    const rows = await this.driver.transaction(
      ['conflicts'],
      'readonly',
      tx => tx.store('conflicts').allFromIndex<MarkdownConflictRecord>('vaultId', vaultId),
    );
    for (const row of rows) validateRecord(row);
    return rows
      .filter(row => row.status === 'open')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async resolve(id: string, resolutionText: string): Promise<MarkdownConflictRecord> {
    if (typeof resolutionText !== 'string') throw new VaultError('CORRUPT', 'Conflict resolution must be Markdown text.');
    return this.driver.transaction(['conflicts'], 'readwrite', async tx => {
      const record = await tx.store('conflicts').get<MarkdownConflictRecord>(id);
      if (!record) throw new VaultError('NOT_FOUND', 'The conflict record no longer exists.');
      validateRecord(record);
      if (record.status === 'resolved') return record;
      const timestamp = new Date().toISOString();
      const updated: MarkdownConflictRecord = {
        ...record,
        status: 'resolved',
        resolvedAt: timestamp,
        resolutionText,
        updatedAt: timestamp,
      };
      await tx.store('conflicts').put(updated);
      return updated;
    });
  }

  async reopen(id: string): Promise<MarkdownConflictRecord> {
    return this.driver.transaction(['conflicts'], 'readwrite', async tx => {
      const record = await tx.store('conflicts').get<MarkdownConflictRecord>(id);
      if (!record) throw new VaultError('NOT_FOUND', 'The conflict record no longer exists.');
      validateRecord(record);
      const updated: MarkdownConflictRecord = {
        ...record,
        status: 'open',
        resolvedAt: null,
        resolutionText: null,
        updatedAt: new Date().toISOString(),
      };
      await tx.store('conflicts').put(updated);
      return updated;
    });
  }
}
