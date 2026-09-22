import { VaultError } from '../domain/errors.js';
import { activeKey, validateName } from '../domain/paths.js';
import { newId, type AttachmentContent, type DirtyEntry, type Entry, type EntryId, type MarkdownContent, type Vault, type VaultId } from '../domain/model.js';
import { ensureTaskIdentityMarkers } from '../tasks/markdown.js';
import { normalizeAttachmentMimeType, validateAttachmentBytes, validateAttachmentName } from '../media/attachments.js';
import { storageDriver } from '../storage/driver.js';
import type { A2Persistence } from '../storage/a2-persistence.js';
import type { ObsidianMigrationPlan } from './obsidian.js';

export interface ObsidianMigrationCommitResult {
  vaultId: VaultId;
  markdownNotes: number;
  attachments: number;
  directories: number;
  taskIdentityMarkersAdded: number;
  canonicalMirrorComplete: boolean;
  warnings: string[];
}

function timestamp(value: string | null, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function nameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

export async function commitObsidianMigration(
  database: IDBDatabase,
  a2: A2Persistence,
  plan: ObsidianMigrationPlan,
  rawVaultName: string,
): Promise<ObsidianMigrationCommitResult> {
  const vaultName = validateName(rawVaultName);
  if (!plan.files.length && !plan.directories.length) throw new VaultError('CORRUPT', 'The migration source contains no importable Vault content.');

  const importedAt = new Date().toISOString();
  const vaultId = newId<'vault'>();
  const vault: Vault = {
    id: vaultId,
    name: vaultName,
    createdAt: importedAt,
    updatedAt: importedAt,
    mode: 'local',
  };

  const directoryIds = new Map<string, EntryId>();
  const entries: Entry[] = [];
  const contents: MarkdownContent[] = [];
  const attachments: AttachmentContent[] = [];
  const dirty: DirtyEntry[] = [];
  const usedTaskIds = new Set<string>();
  let taskIdentityMarkersAdded = 0;

  for (const directory of plan.directories.slice().sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))) {
    const parentPath = parentOf(directory.path);
    const parentId = parentPath ? directoryIds.get(parentPath) : null;
    if (parentPath && !parentId) throw new VaultError('CORRUPT', 'Migration plan contains a folder whose parent is missing.');
    const name = validateName(nameOf(directory.path));
    const id = newId<'entry'>();
    directoryIds.set(directory.path, id);
    const entry: Entry = {
      id,
      vaultId,
      parentId: parentId ?? null,
      name,
      kind: 'directory',
      createdAt: importedAt,
      updatedAt: importedAt,
      localVersion: 1,
      deletedAt: null,
      deletionBatch: null,
      activeKey: activeKey(vaultId, parentId ?? null, name),
    };
    entries.push(entry);
    dirty.push({ entryId: id, vaultId, localVersion: 1, changedAt: importedAt, intent: 'upsert' });
  }

  for (const file of plan.files) {
    const parentPath = parentOf(file.path);
    const parentId = parentPath ? directoryIds.get(parentPath) : null;
    if (parentPath && !parentId) throw new VaultError('CORRUPT', 'Migration plan contains a file whose parent folder is missing.');
    const id = newId<'entry'>();
    const createdAt = timestamp(file.modifiedAt, importedAt);

    if (file.kind === 'markdown') {
      const name = validateName(nameOf(file.path));
      if (!/\.md$/iu.test(name)) throw new VaultError('CORRUPT', 'Migration Markdown path does not end in .md.');
      const reconciled = ensureTaskIdentityMarkers(file.text, { usedIds: usedTaskIds });
      if (reconciled.changed) {
        taskIdentityMarkersAdded += reconciled.taskIds.length;
      }
      const entry: Entry = {
        id,
        vaultId,
        parentId: parentId ?? null,
        name,
        kind: 'markdown',
        createdAt,
        updatedAt: createdAt,
        localVersion: 1,
        deletedAt: null,
        deletionBatch: null,
        activeKey: activeKey(vaultId, parentId ?? null, name),
      };
      entries.push(entry);
      contents.push({ entryId: id, text: reconciled.text, localVersion: 1 });
      dirty.push({ entryId: id, vaultId, localVersion: 1, changedAt: createdAt, intent: 'upsert' });
      continue;
    }

    validateAttachmentBytes(file.bytes);
    const name = validateAttachmentName(nameOf(file.path));
    const mimeType = normalizeAttachmentMimeType(name, file.mimeType);
    const entry: Entry = {
      id,
      vaultId,
      parentId: parentId ?? null,
      name,
      kind: 'attachment',
      createdAt,
      updatedAt: createdAt,
      localVersion: 1,
      deletedAt: null,
      deletionBatch: null,
      activeKey: activeKey(vaultId, parentId ?? null, name),
    };
    entries.push(entry);
    attachments.push({
      entryId: id,
      vaultId,
      mimeType,
      size: file.bytes.byteLength,
      bytes: file.bytes.slice(),
    });
    dirty.push({ entryId: id, vaultId, localVersion: 1, changedAt: createdAt, intent: 'upsert' });
  }

  const activeKeys = new Set<string>();
  for (const entry of entries) {
    if (!entry.activeKey || activeKeys.has(entry.activeKey)) {
      throw new VaultError('COLLISION', 'Migration plan contains a duplicate portable file path.');
    }
    activeKeys.add(entry.activeKey);
  }

  const driver = storageDriver(database);
  await driver.transaction(['vaults', 'entries', 'contents', 'attachments', 'dirty'], 'readwrite', async tx => {
    await tx.store('vaults').add(vault);
    for (const entry of entries) await tx.store('entries').add(entry);
    for (const content of contents) await tx.store('contents').add(content);
    for (const attachment of attachments) await tx.store('attachments').add(attachment);
    for (const item of dirty) await tx.store('dirty').put(item);
  });

  let canonicalMirrorComplete = true;
  const warnings = [...plan.report.warnings];
  try {
    await a2.syncVaultTree(vaultId);
  } catch (error) {
    canonicalMirrorComplete = false;
    await a2.markRepairNeeded(error).catch(() => undefined);
    warnings.push('The interoperable Vault data imported successfully, but the A2 canonical mirror needs repair and will be rebuilt on a later startup.');
  }

  return {
    vaultId,
    markdownNotes: contents.length,
    attachments: attachments.length,
    directories: directoryIds.size,
    taskIdentityMarkersAdded,
    canonicalMirrorComplete,
    warnings: [...new Set(warnings)],
  };
}
