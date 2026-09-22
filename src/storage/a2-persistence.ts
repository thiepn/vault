import { VaultError } from '../domain/errors.js';
import { assertMarkdownContent, nextVersion } from '../domain/integrity.js';
import type {
  AttachmentContent,
  DirtyEntry,
  Entry,
  EntryId,
  LocalRevision,
  MarkdownContent,
  Vault,
  VaultId,
} from '../domain/model.js';
import {
  asCanonicalId,
  type AttachmentEntity,
  type EntityProperties,
  type FolderEntity,
  type FolderId,
  type NoteId,
  type TaskEntity,
  type VaultEntity,
  type VaultDomainId,
} from '../domain/canonical.js';
import { parseKnowledge } from '../knowledge/parser.js';
import {
  ensureTaskIdentityMarkers,
  rekeyTaskIdentityMarkers,
  taskIdentityFromRaw,
} from '../tasks/markdown.js';
import { LocalRepository } from './local-repository.js';
import { storageDriver, type LocalStorageDriver, type StorageTransaction } from './driver.js';
import { createPreferredBlobStore, sha256Hex, type BlobStore } from './blob-store.js';
import { withVaultExclusiveLock, VaultBroadcast } from './coordination.js';

export const A2_MIGRATION_ID = 'a2-canonical-shadow-v2';

export interface StoredNoteHeader {
  id: NoteId;
  entityType: 'note';
  vaultId: VaultDomainId;
  title: string;
  folderId: FolderId | null;
  aliases: readonly string[];
  noteKind: 'standard' | 'daily' | 'template';
  schemaVersion: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  properties: EntityProperties;
  bodyStore: 'noteBodies';
}

export interface NoteBodyRecord {
  noteId: NoteId;
  vaultId: VaultDomainId;
  revision: number;
  text: string;
}

export interface A2MigrationState {
  id: typeof A2_MIGRATION_ID;
  status: 'running' | 'complete' | 'repair-needed';
  schemaVersion: 2;
  startedAt: string;
  completedAt: string | null;
  lastError: string | null;
  processedEntries: number;
}

export type StoredEntity = VaultEntity | FolderEntity | StoredNoteHeader | TaskEntity | AttachmentEntity;

const now = (): string => new Date().toISOString();
const titleFromName = (name: string): string => name.replace(/\.md$/iu, '');

function base(entry: Entry) {
  return {
    schemaVersion: 1,
    revision: entry.localVersion,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    deletedAt: entry.deletedAt,
    properties: {} as EntityProperties,
  };
}

function storedVault(vault: Vault, revision: number): VaultEntity {
  return {
    id: asCanonicalId('vault', vault.id),
    entityType: 'vault',
    name: vault.name,
    schemaVersion: 1,
    revision,
    createdAt: vault.createdAt,
    updatedAt: vault.updatedAt,
    deletedAt: null,
    properties: {},
  };
}

function storedFolder(entry: Entry): FolderEntity {
  return {
    ...base(entry),
    id: asCanonicalId('folder', entry.id),
    entityType: 'folder',
    vaultId: asCanonicalId('vault', entry.vaultId),
    name: entry.name,
    parentFolderId: entry.parentId ? asCanonicalId('folder', entry.parentId) : null,
  };
}

function storedNote(entry: Entry): StoredNoteHeader {
  return {
    ...base(entry),
    id: asCanonicalId('note', entry.id),
    entityType: 'note',
    vaultId: asCanonicalId('vault', entry.vaultId),
    title: titleFromName(entry.name),
    folderId: entry.parentId ? asCanonicalId('folder', entry.parentId) : null,
    aliases: [],
    noteKind: 'standard',
    bodyStore: 'noteBodies',
  };
}

function taskCompletedAt(task: { completed: boolean; completedOn: string | null }, fallback: string): string | null {
  if (!task.completed) return null;
  return task.completedOn ? task.completedOn + 'T12:00:00.000Z' : fallback;
}

function taskEntities(entry: Entry, text: string): TaskEntity[] {
  const noteId = asCanonicalId('note', entry.id);
  const vaultId = asCanonicalId('vault', entry.vaultId);
  const record = parseKnowledge({
    entryId: entry.id,
    vaultId: entry.vaultId,
    localVersion: entry.localVersion,
    text,
  });
  const result: TaskEntity[] = [];
  for (const task of record.tasks) {
    const taskId = taskIdentityFromRaw(task.raw);
    if (!taskId) continue;
    result.push({
      id: asCanonicalId('task', taskId),
      entityType: 'task',
      vaultId,
      title: task.text,
      status: task.completed ? 'completed' : 'open',
      scheduledAt: task.scheduled,
      dueAt: task.due,
      completedAt: taskCompletedAt(task, entry.updatedAt),
      priority: task.priority,
      projectId: null,
      parentTaskId: null,
      sourceNoteId: noteId,
      sourceBlockId: null,
      recurrenceRule: task.recurrence,
      schemaVersion: 1,
      revision: entry.localVersion,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      deletedAt: entry.deletedAt,
      properties: {},
    });
  }
  return result;
}

async function readLegacyEntry(
  tx: StorageTransaction,
  entryId: EntryId,
): Promise<{ entry: Entry; content: MarkdownContent | null; attachment: AttachmentContent | null }> {
  const entry = await tx.store('entries').get<Entry>(entryId);
  if (!entry) throw new VaultError('NOT_FOUND', 'The legacy Vault entry no longer exists.');
  const content = entry.kind === 'markdown'
    ? await tx.store('contents').get<MarkdownContent>(entryId) ?? null
    : null;
  if (entry.kind === 'markdown') assertMarkdownContent(entry, content ?? undefined);
  const attachment = entry.kind === 'attachment'
    ? await tx.store('attachments').get<AttachmentContent>(entryId) ?? null
    : null;
  return { entry, content, attachment };
}

export class A2Persistence {
  readonly blobStore: BlobStore;
  private readonly driver: LocalStorageDriver;
  private readonly broadcast: VaultBroadcast;

  private constructor(readonly database: IDBDatabase, blobStore: BlobStore, sourceId?: string) {
    this.driver = storageDriver(database);
    this.blobStore = blobStore;
    this.broadcast = new VaultBroadcast('vault:storage', undefined, sourceId);
  }

  static async create(database: IDBDatabase, sourceId?: string): Promise<A2Persistence> {
    return new A2Persistence(database, await createPreferredBlobStore(database), sourceId);
  }

  close(): void {
    this.broadcast.close();
  }

  async state(): Promise<A2MigrationState | null> {
    return this.driver.transaction(['migrationState'], 'readonly', async tx =>
      await tx.store('migrationState').get<A2MigrationState>(A2_MIGRATION_ID) ?? null);
  }

  private async saveState(state: A2MigrationState): Promise<void> {
    await this.driver.transaction(['migrationState'], 'readwrite', tx => tx.store('migrationState').put(state));
  }

  async repairAll(): Promise<void> {
    await withVaultExclusiveLock('a2-migration', async () => {
      const previous = await this.state();
      if (previous?.status === 'complete') return;
      const startedAt = now();
      let state: A2MigrationState = {
        id: A2_MIGRATION_ID,
        status: 'running',
        schemaVersion: 2,
        startedAt,
        completedAt: null,
        lastError: null,
        processedEntries: 0,
      };
      await this.saveState(state);
      this.broadcast.post({ kind: 'migration-started', vaultId: null });

      try {
        const vaults = await this.driver.transaction(['vaults'], 'readonly', tx => tx.store('vaults').getAll<Vault>());
        for (const vault of vaults) await this.syncVaultRecord(vault);

        const entries = await this.driver.transaction(['entries'], 'readonly', tx => tx.store('entries').getAll<Entry>());
        const usedTaskIds = new Set<string>();
        for (const original of entries.sort((a, b) => a.id.localeCompare(b.id))) {
          if (original.kind === 'markdown') {
            await this.adoptTaskIdentities(original.id, false, usedTaskIds);
          }
          await this.syncEntry(original.id);
          state = { ...state, processedEntries: state.processedEntries + 1 };
          if (state.processedEntries % 100 === 0) await this.saveState(state);
        }

        state = { ...state, status: 'complete', completedAt: now(), lastError: null };
        await this.saveState(state);
        this.broadcast.post({ kind: 'migration-finished', vaultId: null });
      } catch (error) {
        state = {
          ...state,
          status: 'repair-needed',
          lastError: error instanceof Error ? error.message : 'Unknown A2 migration failure',
        };
        await this.saveState(state).catch(() => undefined);
        throw error;
      }
    });
  }

  async markRepairNeeded(error: unknown): Promise<void> {
    const previous = await this.state();
    await this.saveState({
      id: A2_MIGRATION_ID,
      status: 'repair-needed',
      schemaVersion: 2,
      startedAt: previous?.startedAt ?? now(),
      completedAt: null,
      lastError: error instanceof Error ? error.message : String(error),
      processedEntries: previous?.processedEntries ?? 0,
    });
  }

  async syncVault(vaultId: VaultId): Promise<void> {
    const vault = await this.driver.transaction(['vaults'], 'readonly', tx => tx.store('vaults').get<Vault>(vaultId));
    if (vault) await this.syncVaultRecord(vault);
  }

  private async syncVaultRecord(vault: Vault): Promise<void> {
    await this.driver.transaction(['entities'], 'readwrite', async tx => {
      const existing = await tx.store('entities').get<VaultEntity>(vault.id);
      const unchanged = existing?.entityType === 'vault'
        && existing.name === vault.name
        && existing.updatedAt === vault.updatedAt;
      const revision = unchanged ? existing.revision : (existing?.revision ?? 0) + 1;
      await tx.store('entities').put(storedVault(vault, revision));
    });
  }

  async syncEntry(entryId: EntryId): Promise<void> {
    const source = await this.driver.transaction(
      ['entries', 'contents', 'attachments'],
      'readonly',
      tx => readLegacyEntry(tx, entryId),
    );
    const entry = source.entry;

    if (entry.kind === 'directory') {
      await this.driver.transaction(['entities'], 'readwrite', tx => tx.store('entities').put(storedFolder(entry)));
      this.broadcast.post({
        kind: entry.deletedAt ? 'entity-deleted' : 'entity-changed',
        vaultId: entry.vaultId,
        entityId: entry.id,
      });
      return;
    }

    if (entry.kind === 'markdown') {
      if (!source.content) throw new VaultError('CORRUPT', 'A Markdown entry has no canonical text.');
      const header = storedNote(entry);
      const body: NoteBodyRecord = {
        noteId: header.id,
        vaultId: header.vaultId,
        revision: entry.localVersion,
        text: source.content.text,
      };
      const tasks = taskEntities(entry, source.content.text);

      await this.driver.transaction(['entities', 'noteBodies'], 'readwrite', async tx => {
        await tx.store('entities').put(header);
        await tx.store('noteBodies').put(body);

        const oldTasks = await tx.store('entities').allFromIndex<TaskEntity>('sourceNoteId', header.id);
        const current = new Set(tasks.map(task => task.id as string));
        for (const previous of oldTasks) {
          if (current.has(previous.id as string) || previous.deletedAt !== null) continue;
          await tx.store('entities').put({
            ...previous,
            revision: Math.max(previous.revision + 1, entry.localVersion),
            updatedAt: entry.updatedAt,
            deletedAt: entry.deletedAt ?? entry.updatedAt,
          } satisfies TaskEntity);
        }
        for (const task of tasks) await tx.store('entities').put(task);
      });

      this.broadcast.post({
        kind: entry.deletedAt ? 'entity-deleted' : 'note-saved',
        vaultId: entry.vaultId,
        entityId: entry.id,
      });
      return;
    }

    if (!source.attachment) throw new VaultError('CORRUPT', 'An attachment entry has no legacy binary payload.');
    const hash = await sha256Hex(source.attachment.bytes);
    await this.blobStore.write(hash, source.attachment.bytes);
    const entity: AttachmentEntity = {
      ...base(entry),
      id: asCanonicalId('attachment', entry.id),
      entityType: 'attachment',
      vaultId: asCanonicalId('vault', entry.vaultId),
      filename: entry.name,
      mediaType: source.attachment.mimeType,
      size: source.attachment.size,
      checksumSha256: hash,
      originalFilename: null,
      width: null,
      height: null,
      durationSeconds: null,
    };
    await this.driver.transaction(['entities'], 'readwrite', tx => tx.store('entities').put(entity));
    this.broadcast.post({
      kind: entry.deletedAt ? 'entity-deleted' : 'entity-changed',
      vaultId: entry.vaultId,
      entityId: entry.id,
    });
  }

  async syncVaultTree(vaultId: VaultId): Promise<void> {
    await this.syncVault(vaultId);
    const entries = await this.driver.transaction(
      ['entries'],
      'readonly',
      tx => tx.store('entries').allFromIndex<Entry>('vaultId', vaultId),
    );
    for (const entry of entries) await this.syncEntry(entry.id);
  }

  async adoptTaskIdentities(entryId: EntryId, rekey: boolean, usedIds?: Set<string>): Promise<Entry> {
    const source = await this.driver.transaction(
      ['entries', 'contents'],
      'readonly',
      tx => readLegacyEntry(tx, entryId),
    );
    if (source.entry.kind !== 'markdown' || !source.content) return source.entry;

    const reconciled = rekey
      ? rekeyTaskIdentityMarkers(source.content.text)
      : ensureTaskIdentityMarkers(source.content.text, { usedIds });
    if (!reconciled.changed) return source.entry;

    return this.driver.transaction(
      ['entries', 'contents', 'dirty', 'revisions'],
      'readwrite',
      async tx => {
        const latest = await tx.store('entries').get<Entry>(entryId);
        const current = await tx.store('contents').get<MarkdownContent>(entryId);
        if (!latest || latest.kind !== 'markdown') throw new VaultError('NOT_FOUND', 'The note disappeared during A2 migration.');
        assertMarkdownContent(latest, current);
        if (latest.localVersion !== source.entry.localVersion || current.text !== source.content!.text) {
          throw new VaultError('STALE_WRITE', 'The note changed during A2 task identity migration.');
        }

        const revisionId = latest.id + ':' + latest.localVersion + ':migration';
        if (!await tx.store('revisions').get<LocalRevision>(revisionId)) {
          await tx.store('revisions').add({
            id: revisionId,
            entryId: latest.id,
            vaultId: latest.vaultId,
            text: current.text,
            localVersion: latest.localVersion,
            createdAt: now(),
            reason: 'migration',
          } satisfies LocalRevision);
        }

        const updated: Entry = {
          ...latest,
          updatedAt: now(),
          localVersion: nextVersion(latest.localVersion),
        };
        await tx.store('entries').put(updated);
        await tx.store('contents').put({
          entryId: updated.id,
          text: reconciled.text,
          localVersion: updated.localVersion,
        } satisfies MarkdownContent);
        await tx.store('dirty').put({
          entryId: updated.id,
          vaultId: updated.vaultId,
          localVersion: updated.localVersion,
          changedAt: updated.updatedAt,
          intent: updated.deletedAt ? 'trash' : 'upsert',
        } satisfies DirtyEntry);
        return updated;
      },
    );
  }

  async rekeyTaskIdentitiesForTree(rootId: EntryId): Promise<void> {
    const root = await this.driver.transaction(['entries'], 'readonly', tx => tx.store('entries').get<Entry>(rootId));
    if (!root) return;
    const entries = await this.driver.transaction(
      ['entries'],
      'readonly',
      tx => tx.store('entries').allFromIndex<Entry>('vaultId', root.vaultId),
    );
    const byParent = new Map<string | null, Entry[]>();
    for (const entry of entries) {
      const key = entry.parentId as string | null;
      const list = byParent.get(key) ?? [];
      list.push(entry);
      byParent.set(key, list);
    }

    const queue: Entry[] = [root];
    while (queue.length) {
      const entry = queue.shift()!;
      if (entry.kind === 'markdown' && entry.deletedAt === null) await this.adoptTaskIdentities(entry.id, true);
      if (entry.kind === 'directory') queue.push(...(byParent.get(entry.id) ?? []));
    }
    await this.syncVaultTree(root.vaultId);
  }

  async canonicalEntities(vaultId: VaultId): Promise<StoredEntity[]> {
    return this.driver.transaction(['entities'], 'readonly', async tx => {
      const scoped = await tx.store('entities').allFromIndex<StoredEntity>('vaultId', vaultId);
      const vault = await tx.store('entities').get<StoredEntity>(vaultId);
      return vault ? [vault, ...scoped] : scoped;
    });
  }

  async noteBodies(vaultId: VaultId): Promise<NoteBodyRecord[]> {
    return this.driver.transaction(
      ['noteBodies'],
      'readonly',
      tx => tx.store('noteBodies').allFromIndex<NoteBodyRecord>('vaultId', vaultId),
    );
  }

  async readAttachmentBlob(entryId: EntryId): Promise<AttachmentContent | null> {
    const entity = await this.driver.transaction(
      ['entities'],
      'readonly',
      tx => tx.store('entities').get<AttachmentEntity>(entryId),
    );
    if (!entity || entity.entityType !== 'attachment' || entity.deletedAt !== null) return null;
    const bytes = await this.blobStore.read(entity.checksumSha256);
    if (!bytes) return null;
    if (bytes.byteLength !== entity.size) throw new VaultError('CORRUPT', 'A2 attachment blob size does not match canonical metadata.');
    const actual = await sha256Hex(bytes);
    if (actual !== entity.checksumSha256) throw new VaultError('CORRUPT', 'A2 attachment blob checksum does not match canonical metadata.');
    return {
      entryId: entity.id as unknown as EntryId,
      vaultId: entity.vaultId as unknown as VaultId,
      mimeType: entity.mediaType,
      size: entity.size,
      bytes,
    };
  }
}

export class A2LocalRepository extends LocalRepository {
  constructor(database: IDBDatabase, readonly a2: A2Persistence) {
    super(database);
  }

  private async mirror(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      await this.a2.markRepairNeeded(error).catch(() => undefined);
    }
  }

  override async readAttachment(entryId: EntryId): Promise<AttachmentContent> {
    const canonical = await this.a2.readAttachmentBlob(entryId);
    return canonical ?? super.readAttachment(entryId);
  }

  override async createVault(raw: string): Promise<Vault> {
    const vault = await super.createVault(raw);
    await this.mirror(() => this.a2.syncVault(vault.id));
    return vault;
  }

  override async renameVault(vaultId: VaultId, raw: string): Promise<Vault> {
    const vault = await super.renameVault(vaultId, raw);
    await this.mirror(() => this.a2.syncVault(vault.id));
    return vault;
  }

  override async createEntry(
    vaultId: VaultId,
    parentId: EntryId | null,
    raw: string,
    kind: 'directory' | 'markdown',
    text = '',
  ): Promise<Entry> {
    const prepared = kind === 'markdown' ? rekeyTaskIdentityMarkers(text).text : text;
    const entry = await super.createEntry(vaultId, parentId, raw, kind, prepared);
    await this.mirror(() => this.a2.syncEntry(entry.id));
    return entry;
  }

  override async createAttachment(
    vaultId: VaultId,
    parentId: EntryId | null,
    raw: string,
    mimeType: string,
    bytes: Uint8Array,
  ): Promise<Entry> {
    const hash = await sha256Hex(bytes);
    await this.a2.blobStore.write(hash, bytes);
    const entry = await super.createAttachment(vaultId, parentId, raw, mimeType, bytes);
    await this.mirror(() => this.a2.syncEntry(entry.id));
    return entry;
  }

  override async saveMarkdown(entryId: EntryId, text: string, expectedVersion: number): Promise<Entry> {
    const entry = await super.saveMarkdown(entryId, text, expectedVersion);
    await this.mirror(() => this.a2.syncEntry(entry.id));
    return entry;
  }

  override async move(entryId: EntryId, parentId: EntryId | null, raw: string, expectedVersion: number): Promise<Entry> {
    const entry = await super.move(entryId, parentId, raw, expectedVersion);
    await this.mirror(() => this.a2.syncVaultTree(entry.vaultId));
    return entry;
  }

  override async duplicate(entryId: EntryId, expectedVersion: number): Promise<Entry> {
    const duplicated = await super.duplicate(entryId, expectedVersion);
    await this.mirror(() => this.a2.rekeyTaskIdentitiesForTree(duplicated.id));
    return (await this.read(duplicated.id)).entry;
  }

  override async trash(entryId: EntryId, expectedVersion: number): Promise<void> {
    const before = await this.read(entryId);
    await super.trash(entryId, expectedVersion);
    await this.mirror(() => this.a2.syncVaultTree(before.entry.vaultId));
  }

  override async restore(entryId: EntryId): Promise<void> {
    const before = await this.read(entryId);
    await super.restore(entryId);
    await this.mirror(() => this.a2.syncVaultTree(before.entry.vaultId));
  }

  override async recoverDraft(draftId: string, rawName: string): Promise<Entry> {
    let entry = await super.recoverDraft(draftId, rawName);
    await this.mirror(async () => {
      entry = await this.a2.adoptTaskIdentities(entry.id, true);
      await this.a2.syncEntry(entry.id);
    });
    return entry;
  }
}
