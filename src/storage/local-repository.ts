import { VaultError } from '../domain/errors.js';
import { activeKey, markdownName, validateName } from '../domain/paths.js';
import { assertMarkdownContent, assertVersion, nextVersion } from '../domain/integrity.js';
import { VaultTree } from '../domain/tree.js';
import { newId, type AttachmentContent, type AttachmentSnapshot, type CloudVaultBinding, type DirtyEntry, type Entry, type EntryId, type EntryWithContent, type LocalRevision, type MarkdownContent, type RecoveryDraft, type Vault, type VaultId, type VaultSnapshot } from '../domain/model.js';
import { normalizeAttachmentMimeType, validateAttachmentBytes, validateAttachmentName } from '../media/attachments.js';
import type { FileRepository, RevisionRepository, VaultRepository } from '../services/ports.js';
import type { StoreName } from './database.js';
import { storageDriver, type LocalStorageDriver, type StorageTransaction } from './driver.js';

const WRITE_STORES: readonly StoreName[] = ['vaults', 'entries', 'contents', 'attachments', 'dirty', 'revisions', 'drafts'];
const now = (): string => new Date().toISOString();

async function requiredEntry(tx: StorageTransaction, id: EntryId): Promise<Entry> {
  const entry = await tx.store('entries').get<Entry>(id);
  if (!entry) throw new VaultError('NOT_FOUND', 'The file no longer exists.');
  assertVersion(entry.localVersion); return entry;
}
function live(entry: Entry): void {
  if (entry.deletedAt !== null) throw new VaultError('DELETED', 'This file is in Trash. Restore it before editing.');
}
async function dirty(tx: StorageTransaction, entry: Entry, intent: DirtyEntry['intent']): Promise<void> {
  await tx.store('dirty').put({ entryId: entry.id, vaultId: entry.vaultId, localVersion: entry.localVersion, changedAt: entry.updatedAt, intent } satisfies DirtyEntry);
}
async function validateParent(tx: StorageTransaction, vaultId: VaultId, parentId: EntryId | null, childId?: EntryId): Promise<void> {
  const visited = new Set<EntryId>(); let id = parentId;
  while (id) {
    if (id === childId || visited.has(id) || visited.size >= 255) throw new VaultError('CYCLE', 'A folder cannot be moved into itself, a descendant, or beyond the supported nesting depth.');
    visited.add(id); const parent = await requiredEntry(tx, id);
    if (parent.kind !== 'directory' || parent.vaultId !== vaultId || parent.deletedAt !== null) throw new VaultError('INVALID_PARENT', 'Choose an active folder in the same vault.');
    id = parent.parentId;
  }
}
async function assertAvailable(tx: StorageTransaction, key: string, self?: EntryId): Promise<void> {
  const existing = await tx.store('entries').fromIndex<Entry>('activeKey', key);
  if (existing && existing.id !== self) throw new VaultError('COLLISION', 'A file or folder with that name already exists here. Nothing was overwritten.');
}
export interface PreserveDraftInput {
  id: string; entryId: EntryId; vaultId: VaultId; baseVersion: number; text: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const value = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    output += alphabet[(value >>> 18) & 63]!;
    output += alphabet[(value >>> 12) & 63]!;
    output += b === undefined ? '=' : alphabet[(value >>> 6) & 63]!;
    output += c === undefined ? '=' : alphabet[value & 63]!;
  }
  return output;
}

export class LocalRepository implements VaultRepository, FileRepository, RevisionRepository {
  private readonly driver: LocalStorageDriver;
  constructor(database: IDBDatabase | LocalStorageDriver) { this.driver = storageDriver(database); }
  async listVaults(): Promise<Vault[]> {
    return this.driver.transaction(['vaults'], 'readonly', tx => tx.store('vaults').getAll<Vault>());
  }
  async createVault(raw: string): Promise<Vault> {
    const vault: Vault = { id: newId<'vault'>(), name: validateName(raw), createdAt: now(), updatedAt: now(), mode: 'local' };
    await this.driver.transaction(['vaults'], 'readwrite', tx => tx.store('vaults').add(vault)); return vault;
  }
  async renameVault(vaultId: VaultId, raw: string): Promise<Vault> {
    const name = validateName(raw);
    return this.driver.transaction(['vaults'], 'readwrite', async tx => {
      const vault = await tx.store('vaults').get<Vault>(vaultId);
      if (!vault) throw new VaultError('NOT_FOUND', 'The vault no longer exists.');
      if (vault.name === name) return vault;
      const updated: Vault = { ...vault, name, updatedAt: now() };
      await tx.store('vaults').put(updated);
      return updated;
    });
  }
  async adoptCloud(vaultId: VaultId, binding: CloudVaultBinding): Promise<Vault> {
    if (binding.remoteVaultId !== vaultId) throw new VaultError('ACCOUNT_MISMATCH', 'Cloud adoption must preserve the Vault UUID.');
    return this.driver.transaction(['vaults'], 'readwrite', async tx => {
      const vault = await tx.store('vaults').get<Vault>(vaultId);
      if (!vault) throw new VaultError('NOT_FOUND', 'The vault no longer exists.');
      if (vault.mode === 'cloud') {
        const existing = vault.cloud;
        if (existing
          && existing.accountId === binding.accountId
          && existing.authUserId === binding.authUserId
          && existing.projectRef === binding.projectRef
          && existing.remoteVaultId === binding.remoteVaultId
          && existing.epoch === binding.epoch
          && existing.deviceId === binding.deviceId) return vault;
        throw new VaultError('ACCOUNT_MISMATCH', 'This Vault is already adopted by a different cloud account or synchronization epoch.');
      }
      const updated: Vault = { ...vault, mode: 'cloud', cloud: binding, updatedAt: now() };
      await tx.store('vaults').put(updated);
      return updated;
    });
  }
  async listEntries(vaultId: VaultId, includeTrash = false): Promise<Entry[]> {
    return this.driver.transaction(['entries'], 'readonly', async tx => {
      const entries = await tx.store('entries').allFromIndex<Entry>('vaultId', vaultId);
      return includeTrash ? entries : entries.filter(entry => entry.deletedAt === null);
    });
  }
  async listActiveMarkdownContents(vaultId: VaultId): Promise<MarkdownContent[]> {
    return this.driver.transaction(['entries', 'contents'], 'readonly', async tx => {
      const entries = await tx.store('entries').allFromIndex<Entry>('vaultId', vaultId);
      const contents: MarkdownContent[] = [];
      for (const entry of entries) {
        if (entry.kind !== 'markdown' || entry.deletedAt !== null) continue;
        const content = await tx.store('contents').get<MarkdownContent>(entry.id);
        if (content) {
          assertMarkdownContent(entry, content);
          contents.push(content);
        }
      }
      return contents;
    });
  }
  private async create(tx: StorageTransaction, vaultId: VaultId, parentId: EntryId | null, raw: string, kind: Exclude<Entry['kind'], 'attachment'>, text: string): Promise<Entry> {
    if (typeof text !== 'string') throw new VaultError('CORRUPT', 'Markdown content must be text.');
    const name = kind === 'markdown' ? markdownName(raw) : validateName(raw);
    if (!await tx.store('vaults').get(vaultId)) throw new VaultError('NOT_FOUND', 'The vault no longer exists.');
    await validateParent(tx, vaultId, parentId);
    const key = activeKey(vaultId, parentId, name); await assertAvailable(tx, key);
    const entry: Entry = { id: newId<'entry'>(), vaultId, parentId, name, kind, createdAt: now(), updatedAt: now(), localVersion: 1, deletedAt: null, deletionBatch: null, activeKey: key };
    await tx.store('entries').add(entry);
    if (kind === 'markdown') await tx.store('contents').add({ entryId: entry.id, text, localVersion: 1 } satisfies MarkdownContent);
    await dirty(tx, entry, 'upsert'); return entry;
  }
  async createEntry(vaultId: VaultId, parentId: EntryId | null, raw: string, kind: Exclude<Entry['kind'], 'attachment'>, text = ''): Promise<Entry> {
    return this.driver.transaction(WRITE_STORES, 'readwrite', tx => this.create(tx, vaultId, parentId, raw, kind, text));
  }

  private async createAttachmentInTransaction(
    tx: StorageTransaction,
    vaultId: VaultId,
    parentId: EntryId | null,
    raw: string,
    mimeType: string,
    bytes: Uint8Array,
  ): Promise<Entry> {
    validateAttachmentBytes(bytes);
    const name = validateAttachmentName(raw);
    if (!await tx.store('vaults').get(vaultId)) throw new VaultError('NOT_FOUND', 'The vault no longer exists.');
    await validateParent(tx, vaultId, parentId);
    const key = activeKey(vaultId, parentId, name);
    await assertAvailable(tx, key);
    const entry: Entry = {
      id: newId<'entry'>(),
      vaultId,
      parentId,
      name,
      kind: 'attachment',
      createdAt: now(),
      updatedAt: now(),
      localVersion: 1,
      deletedAt: null,
      deletionBatch: null,
      activeKey: key,
    };
    const content: AttachmentContent = {
      entryId: entry.id,
      vaultId,
      mimeType: normalizeAttachmentMimeType(name, mimeType),
      size: bytes.byteLength,
      bytes: bytes.slice(),
    };
    await tx.store('entries').add(entry);
    await tx.store('attachments').add(content);
    await dirty(tx, entry, 'upsert');
    return entry;
  }

  async createAttachment(vaultId: VaultId, parentId: EntryId | null, raw: string, mimeType: string, bytes: Uint8Array): Promise<Entry> {
    return this.driver.transaction(WRITE_STORES, 'readwrite', tx => this.createAttachmentInTransaction(tx, vaultId, parentId, raw, mimeType, bytes));
  }

  async read(entryId: EntryId): Promise<EntryWithContent> {
    return this.driver.transaction(['entries', 'contents', 'attachments'], 'readonly', async tx => {
      const entry = await requiredEntry(tx, entryId);
      const content = await tx.store('contents').get<MarkdownContent>(entryId);
      const attachment = await tx.store('attachments').get<AttachmentContent>(entryId);
      if (entry.kind === 'markdown') assertMarkdownContent(entry, content);
      if (entry.kind === 'attachment') {
        if (!attachment || attachment.entryId !== entry.id || attachment.vaultId !== entry.vaultId || attachment.size !== attachment.bytes.byteLength) {
          throw new VaultError('CORRUPT', 'Attachment bytes are missing or inconsistent.');
        }
      }
      return { entry, content: content ?? null, attachment: attachment ?? null };
    });
  }

  async readAttachment(entryId: EntryId): Promise<AttachmentContent> {
    const result = await this.read(entryId);
    if (result.entry.kind !== 'attachment' || !result.attachment) throw new VaultError('UNSUPPORTED', 'This entry is not an attachment.');
    return result.attachment;
  }
  private async draft(tx: StorageTransaction, entry: Entry, text: string, baseVersion: number, reason: RecoveryDraft['reason']): Promise<void> {
    await tx.store('drafts').add({ id: newId<'draft'>(), entryId: entry.id, vaultId: entry.vaultId, baseVersion, text, createdAt: now(), reason } satisfies RecoveryDraft);
  }
  async saveMarkdown(entryId: EntryId, text: string, expectedVersion: number): Promise<Entry> {
    assertVersion(expectedVersion);
    if (typeof text !== 'string') throw new VaultError('CORRUPT', 'Markdown content must be text.');
    const result = await this.driver.transaction(WRITE_STORES, 'readwrite', async tx => {
      const entry = await requiredEntry(tx, entryId);
      if (entry.kind !== 'markdown') throw new VaultError('UNSUPPORTED', 'Only Markdown files have text contents.');
      if (entry.deletedAt !== null) {
        await this.draft(tx, entry, text, expectedVersion, 'deleted-write');
        return { error: new VaultError('DELETED', 'Another tab moved this note to Trash. Your edit was preserved as a recovery draft; the deleted note was not overwritten.') };
      }
      if (entry.localVersion !== expectedVersion) {
        await this.draft(tx, entry, text, expectedVersion, 'stale-write');
        return { error: new VaultError('STALE_WRITE', 'Another tab changed this file. Your edit was preserved as a recovery draft; neither version was overwritten.') };
      }
      const previous = await tx.store('contents').get<MarkdownContent>(entryId);
      try { assertMarkdownContent(entry, previous); } catch (error) {
        await this.draft(tx, entry, text, expectedVersion, 'invalid-content');
        return { error: error instanceof Error ? error : new VaultError('CORRUPT', 'Saved content is inconsistent.') };
      }
      if (previous.text === text) return { entry };
      const updated: Entry = { ...entry, updatedAt: now(), localVersion: nextVersion(entry.localVersion) };
      await tx.store('entries').put(updated);
      await tx.store('contents').put({ entryId, text, localVersion: updated.localVersion } satisfies MarkdownContent);
      await dirty(tx, updated, 'upsert'); return { entry: updated };
    });
    if (result.error) throw result.error;
    if (!result.entry) throw new VaultError('STORAGE', 'The save did not return a durable file version.');
    return result.entry;
  }
  async preserveDraft(input: PreserveDraftInput): Promise<void> {
    assertVersion(input.baseVersion);
    if (!input.id || input.id.length > 200 || typeof input.text !== 'string') throw new VaultError('CORRUPT', 'Invalid recovery draft.');
    await this.driver.transaction(['vaults', 'entries', 'drafts'], 'readwrite', async tx => {
      if (!await tx.store('vaults').get(input.vaultId)) throw new VaultError('NOT_FOUND', 'The recovery vault no longer exists. Export your draft.');
      const entry = await tx.store('entries').get<Entry>(input.entryId);
      const previous = await tx.store('drafts').get<RecoveryDraft>(input.id);
      if ((entry && entry.vaultId !== input.vaultId) || (previous && (previous.vaultId !== input.vaultId || previous.entryId !== input.entryId))) throw new VaultError('ACCOUNT_MISMATCH', 'Recovery identity does not match the source vault.');
      if (previous?.text === input.text) return;
      await tx.store('drafts').put({ ...input, createdAt: now(), reason: 'editor-recovery' } satisfies RecoveryDraft);
    });
  }
  async listRecoveryDrafts(vaultId: VaultId): Promise<RecoveryDraft[]> {
    return this.driver.transaction(['drafts'], 'readonly', tx => tx.store('drafts').allFromIndex<RecoveryDraft>('vaultId', vaultId));
  }
  async recoverDraft(draftId: string, rawName: string): Promise<Entry> {
    return this.driver.transaction(WRITE_STORES, 'readwrite', async tx => {
      const draft = await tx.store('drafts').get<RecoveryDraft>(draftId);
      if (!draft) throw new VaultError('NOT_FOUND', 'This recovery draft no longer exists.');
      return this.create(tx, draft.vaultId, null, rawName, 'markdown', draft.text);
    });
  }
  async move(entryId: EntryId, parentId: EntryId | null, raw: string, expectedVersion: number): Promise<Entry> {
    assertVersion(expectedVersion);
    return this.driver.transaction(WRITE_STORES, 'readwrite', async tx => {
      const entry = await requiredEntry(tx, entryId); live(entry);
      if (entry.localVersion !== expectedVersion) throw new VaultError('STALE_WRITE', 'The file changed. Reopen it before moving or renaming.');
      const name = entry.kind === 'markdown' ? markdownName(raw) : entry.kind === 'attachment' ? validateAttachmentName(raw) : validateName(raw);
      await validateParent(tx, entry.vaultId, parentId, entryId);
      const key = activeKey(entry.vaultId, parentId, name); await assertAvailable(tx, key, entryId);
      const content = await tx.store('contents').get<MarkdownContent>(entryId);
      if (entry.kind === 'markdown') assertMarkdownContent(entry, content);
      if (entry.parentId === parentId && entry.name === name) return entry;
      const updated: Entry = { ...entry, parentId, name, activeKey: key, updatedAt: now(), localVersion: nextVersion(entry.localVersion) };
      if (entry.kind === 'directory') {
        const all = await tx.store('entries').allFromIndex<Entry>('vaultId', entry.vaultId);
        const tree = new VaultTree(all.map(item => item.id === entryId ? updated : item));
        tree.path(entryId); for (const descendant of tree.descendants(entryId)) tree.path(descendant.id);
      }
      await tx.store('entries').put(updated);
      if (content) await tx.store('contents').put({ ...content, localVersion: updated.localVersion });
      await dirty(tx, updated, 'upsert'); return updated;
    });
  }
  async duplicate(entryId: EntryId, expectedVersion: number): Promise<Entry> {
    assertVersion(expectedVersion);
    return this.driver.transaction(WRITE_STORES, 'readwrite', async tx => {
      const source = await requiredEntry(tx, entryId); live(source);
      if (source.localVersion !== expectedVersion) throw new VaultError('STALE_WRITE', 'The file changed. Reopen it before duplicating.');
      const all = await tx.store('entries').allFromIndex<Entry>('vaultId', source.vaultId);
      const tree = new VaultTree(all);
      tree.path(source.id);

      const copyName = async (entry: Entry, parentId: EntryId | null): Promise<string> => {
        const markdown = entry.kind === 'markdown';
        const attachment = entry.kind === 'attachment';
        const extensionIndex = attachment ? entry.name.lastIndexOf('.') : -1;
        const attachmentBase = extensionIndex > 0 ? entry.name.slice(0, extensionIndex) : entry.name;
        const attachmentExtension = extensionIndex > 0 ? entry.name.slice(extensionIndex) : '';
        const base = markdown ? entry.name.replace(/\.md$/iu, '') : attachmentBase;
        for (let index = 1; index <= 10_000; index++) {
          const suffix = index === 1 ? ' copy' : ` copy ${index}`;
          const candidate = markdown
            ? `${base}${suffix}.md`
            : attachment
              ? `${base}${suffix}${attachmentExtension}`
              : `${base}${suffix}`;
          validateName(candidate);
          const key = activeKey(entry.vaultId, parentId, candidate);
          if (!await tx.store('entries').fromIndex<Entry>('activeKey', key)) return candidate;
        }
        throw new VaultError('COLLISION', 'Could not find an available copy name.');
      };

      const cloneEntry = async (entry: Entry, parentId: EntryId | null, name: string): Promise<Entry> => {
        if (entry.kind === 'attachment') {
          const attachment = await tx.store('attachments').get<AttachmentContent>(entry.id);
          if (!attachment) throw new VaultError('CORRUPT', 'Attachment bytes are missing.');
          return this.createAttachmentInTransaction(tx, entry.vaultId, parentId, name, attachment.mimeType, attachment.bytes);
        }
        const content = entry.kind === 'markdown' ? await tx.store('contents').get<MarkdownContent>(entry.id) : undefined;
        if (entry.kind === 'markdown') assertMarkdownContent(entry, content);
        return this.create(tx, entry.vaultId, parentId, name, entry.kind, content?.text ?? '');
      };

      const rootName = await copyName(source, source.parentId);
      const duplicated = await cloneEntry(source, source.parentId, rootName);
      if (source.kind !== 'directory') return duplicated;

      const idMap = new Map<EntryId, EntryId>([[source.id, duplicated.id]]);
      const descendants = tree.descendants(source.id, entry => entry.deletedAt === null);
      for (const descendant of descendants) {
        const parentId = descendant.parentId ? idMap.get(descendant.parentId) : undefined;
        if (!parentId) throw new VaultError('CORRUPT', 'A duplicated folder contains an invalid descendant relationship.');
        const clone = await cloneEntry(descendant, parentId, descendant.name);
        idMap.set(descendant.id, clone.id);
      }
      return duplicated;
    });
  }

  async checkpoint(entryId: EntryId): Promise<void> {
    await this.driver.transaction(WRITE_STORES, 'readwrite', async tx => this.recordRevision(tx, await requiredEntry(tx, entryId), 'checkpoint'));
  }
  private async recordRevision(tx: StorageTransaction, entry: Entry, reason: LocalRevision['reason']): Promise<void> {
    if (entry.kind !== 'markdown') return;
    const content = await tx.store('contents').get<MarkdownContent>(entry.id); assertMarkdownContent(entry, content);
    const id = `${entry.id}:${entry.localVersion}:${reason}`;
    if (await tx.store('revisions').get(id)) return;
    await tx.store('revisions').add({ id, entryId: entry.id, vaultId: entry.vaultId, text: content.text, localVersion: entry.localVersion, createdAt: now(), reason } satisfies LocalRevision);
  }
  async trash(entryId: EntryId, expectedVersion: number): Promise<void> {
    assertVersion(expectedVersion);
    await this.driver.transaction(WRITE_STORES, 'readwrite', async tx => {
      const root = await requiredEntry(tx, entryId); live(root);
      if (root.localVersion !== expectedVersion) throw new VaultError('STALE_WRITE', 'The file changed. Reopen it before deleting.');
      const all = await tx.store('entries').allFromIndex<Entry>('vaultId', root.vaultId);
      const tree = new VaultTree(all); tree.path(entryId);
      const selected = [root, ...tree.descendants(entryId, item => item.deletedAt === null)];
      const batch = crypto.randomUUID(); const deletedAt = now();
      for (const entry of selected) {
        await this.recordRevision(tx, entry, 'trash');
        const updated: Entry = { ...entry, deletedAt, deletionBatch: batch, updatedAt: deletedAt, localVersion: nextVersion(entry.localVersion) }; delete updated.activeKey;
        await tx.store('entries').put(updated);
        const content = await tx.store('contents').get<MarkdownContent>(entry.id);
        if (content) await tx.store('contents').put({ ...content, localVersion: updated.localVersion });
        await dirty(tx, updated, 'trash');
      }
    });
  }
  async restore(entryId: EntryId): Promise<void> {
    await this.driver.transaction(WRITE_STORES, 'readwrite', async tx => {
      const root = await requiredEntry(tx, entryId); if (!root.deletedAt) return;
      if (!root.deletionBatch) throw new VaultError('CORRUPT', 'The Trash record has no deletion batch.');
      await validateParent(tx, root.vaultId, root.parentId);
      const all = await tx.store('entries').allFromIndex<Entry>('vaultId', root.vaultId);
      const tree = new VaultTree(all);
      const selected = [root, ...tree.descendants(entryId, item => item.deletedAt !== null && item.deletionBatch === root.deletionBatch)];
      for (const entry of selected) {
        const key = activeKey(entry.vaultId, entry.parentId, entry.name); await assertAvailable(tx, key, entry.id);
        const content = await tx.store('contents').get<MarkdownContent>(entry.id);
        if (entry.kind === 'markdown') assertMarkdownContent(entry, content);
        const updated: Entry = { ...entry, deletedAt: null, deletionBatch: null, activeKey: key, updatedAt: now(), localVersion: nextVersion(entry.localVersion) };
        await tx.store('entries').put(updated);
        if (content) await tx.store('contents').put({ ...content, localVersion: updated.localVersion });
        await dirty(tx, updated, 'restore'); await this.recordRevision(tx, updated, 'restore');
      }
    });
  }
  async listDirtyEntries(vaultId: VaultId): Promise<DirtyEntry[]> {
    return this.driver.transaction(['dirty'], 'readonly', tx => tx.store('dirty').allFromIndex<DirtyEntry>('vaultId', vaultId));
  }
  async snapshot(vaultId: VaultId): Promise<VaultSnapshot> {
    return this.driver.transaction(['vaults', 'entries', 'contents', 'attachments', 'drafts', 'revisions'], 'readonly', async tx => {
      const vault = await tx.store('vaults').get<Vault>(vaultId);
      if (!vault) throw new VaultError('NOT_FOUND', 'The vault no longer exists.');
      const entries = await tx.store('entries').allFromIndex<Entry>('vaultId', vaultId);
      const contents: MarkdownContent[] = [];
      for (const entry of entries) {
        const content = await tx.store('contents').get<MarkdownContent>(entry.id);
        if (content) contents.push(content);
      }
      const attachmentContents = await tx.store('attachments').allFromIndex<AttachmentContent>('vaultId', vaultId);
      const attachments: AttachmentSnapshot[] = attachmentContents.map(attachment => ({
        entryId: attachment.entryId,
        mimeType: attachment.mimeType,
        size: attachment.size,
        dataBase64: bytesToBase64(attachment.bytes),
      }));
      const recoveryDrafts = await tx.store('drafts').allFromIndex<RecoveryDraft>('vaultId', vaultId);
      const revisions = await tx.store('revisions').allFromIndex<LocalRevision>('vaultId', vaultId);
      return { format: 'vault-local-backup', version: 2, exportedAt: now(), vault, entries, contents, attachments, recoveryDrafts, revisions };
    });
  }
}
