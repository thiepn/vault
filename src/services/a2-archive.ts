import { VaultError } from '../domain/errors.js';
import type {
  AttachmentContent,
  DirtyEntry,
  Entry,
  LocalRevision,
  MarkdownConflictRecord,
  MarkdownContent,
  RecoveryDraft,
  Vault,
  VaultId,
  VaultSnapshot,
} from '../domain/model.js';
import { VaultTree } from '../domain/tree.js';
import type { AttachmentEntity } from '../domain/canonical.js';
import type { NoteBodyRecord, StoredEntity } from '../storage/a2-persistence.js';
import { createPreferredBlobStore, sha256Hex } from '../storage/blob-store.js';
import { storageDriver } from '../storage/driver.js';
import { vaultFiles, type ExportFile } from './export.js';

export interface VaultArchiveManifest {
  format: 'vault-archive';
  version: 2;
  exportedAt: string;
  vaultId: string;
  vaultName: string;
  entries: Array<{
    id: string;
    kind: string;
    path: string;
    revision: number;
    deletedAt: string | null;
  }>;
}

export interface VaultArchiveState {
  format: 'vault-archive-state';
  version: 1;
  vault: Vault;
  entries: Entry[];
  contents: MarkdownContent[];
  recoveryDrafts: RecoveryDraft[];
  revisions: LocalRevision[];
  conflicts?: MarkdownConflictRecord[];
  attachments: Array<{
    entryId: string;
    mimeType: string;
    size: number;
    archivePath: string;
  }>;
}

export interface ParsedVaultArchive {
  manifest: VaultArchiveManifest;
  state: VaultArchiveState;
  entities: StoredEntity[];
  noteBodies: NoteBodyRecord[];
  attachments: AttachmentContent[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const jsonFile = (path: string, value: unknown): ExportFile => ({
  path,
  bytes: encoder.encode(JSON.stringify(value, null, 2)),
});

function base64Bytes(value: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = value.replace(/\s+/gu, '');
  if (clean.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(clean)) {
    throw new VaultError('CORRUPT', 'Attachment backup data is not valid base64.');
  }
  const output: number[] = [];
  for (let index = 0; index < clean.length; index += 4) {
    const chunk = clean.slice(index, index + 4);
    const values = [...chunk].map(character => character === '=' ? 0 : alphabet.indexOf(character));
    if (values.some(value => value < 0)) throw new VaultError('CORRUPT', 'Attachment backup data is not valid base64.');
    const combined = (values[0]! << 18) | (values[1]! << 12) | (values[2]! << 6) | values[3]!;
    output.push((combined >>> 16) & 255);
    if (chunk[2] !== '=') output.push((combined >>> 8) & 255);
    if (chunk[3] !== '=') output.push(combined & 255);
  }
  return Uint8Array.from(output);
}

function parseJson<T>(files: Map<string, ExportFile>, path: string): T {
  const file = files.get(path);
  if (!file) throw new VaultError('CORRUPT', 'Vault archive is missing ' + path + '.');
  try {
    return JSON.parse(decoder.decode(file.bytes)) as T;
  } catch (error) {
    throw new VaultError('CORRUPT', 'Vault archive metadata is invalid JSON at ' + path + '.', { cause: error });
  }
}

function assertArchiveState(state: VaultArchiveState, manifest: VaultArchiveManifest): void {
  if (state.format !== 'vault-archive-state' || state.version !== 1) {
    throw new VaultError('CORRUPT', 'Vault archive restore state version is unsupported.');
  }
  if (!state.vault?.id || state.vault.id !== manifest.vaultId) {
    throw new VaultError('CORRUPT', 'Vault archive restore state does not match its manifest.');
  }
  if (!Array.isArray(state.entries) || !Array.isArray(state.contents) || !Array.isArray(state.attachments)
    || !Array.isArray(state.recoveryDrafts) || !Array.isArray(state.revisions)) {
    throw new VaultError('CORRUPT', 'Vault archive restore state is incomplete.');
  }

  const entryIds = new Set<string>();
  for (const entry of state.entries) {
    if (!entry?.id || entry.vaultId !== state.vault.id || entryIds.has(entry.id)) {
      throw new VaultError('CORRUPT', 'Vault archive contains duplicate or cross-vault entries.');
    }
    entryIds.add(entry.id);
  }

  const tree = new VaultTree(state.entries);
  for (const entry of state.entries) tree.path(entry.id);

  const entryById = new Map(state.entries.map(entry => [entry.id as string, entry]));
  const contentIds = new Set<string>();
  for (const content of state.contents) {
    const entry = entryById.get(content.entryId as string);
    if (!entry || entry.kind !== 'markdown' || contentIds.has(content.entryId) || typeof content.text !== 'string'
      || content.localVersion !== entry.localVersion) {
      throw new VaultError('CORRUPT', 'Vault archive contains invalid or revision-mismatched Markdown content records.');
    }
    contentIds.add(content.entryId);
  }

  for (const entry of state.entries) {
    if (entry.kind === 'markdown' && !contentIds.has(entry.id)) {
      throw new VaultError('CORRUPT', 'Vault archive is missing Markdown content for ' + entry.name + '.');
    }
  }

  const revisionIds = new Set<string>();
  for (const revision of state.revisions) {
    if (!revision?.id || revision.vaultId !== state.vault.id || !entryIds.has(revision.entryId)
      || revisionIds.has(revision.id) || typeof revision.text !== 'string') {
      throw new VaultError('CORRUPT', 'Vault archive contains invalid revision records.');
    }
    revisionIds.add(revision.id);
  }

  const draftIds = new Set<string>();
  for (const draft of state.recoveryDrafts) {
    if (!draft?.id || draft.vaultId !== state.vault.id || !entryIds.has(draft.entryId)
      || draftIds.has(draft.id) || typeof draft.text !== 'string') {
      throw new VaultError('CORRUPT', 'Vault archive contains invalid recovery draft records.');
    }
    draftIds.add(draft.id);
  }

  const conflictIds = new Set<string>();
  for (const conflict of state.conflicts ?? []) {
    if (!conflict?.id || conflict.vaultId !== state.vault.id || conflictIds.has(conflict.id)
      || !entryIds.has(conflict.entryId) || !entryIds.has(conflict.conflictEntryId)
      || typeof conflict.baseText !== 'string' || typeof conflict.localText !== 'string' || typeof conflict.remoteText !== 'string'
      || (conflict.status !== 'open' && conflict.status !== 'resolved')) {
      throw new VaultError('CORRUPT', 'Vault archive contains invalid conflict-resolution records.');
    }
    conflictIds.add(conflict.id);
  }

  const attachmentIds = new Set<string>();
  for (const attachment of state.attachments) {
    const entry = state.entries.find(item => item.id === attachment.entryId);
    if (!entry || entry.kind !== 'attachment' || attachmentIds.has(attachment.entryId)
      || !Number.isSafeInteger(attachment.size) || attachment.size < 0 || !attachment.archivePath) {
      throw new VaultError('CORRUPT', 'Vault archive contains invalid attachment restore metadata.');
    }
    attachmentIds.add(attachment.entryId);
  }
  for (const entry of state.entries) {
    if (entry.kind === 'attachment' && !attachmentIds.has(entry.id)) {
      throw new VaultError('CORRUPT', 'Vault archive is missing attachment restore metadata for ' + entry.name + '.');
    }
  }
}

export async function fullVaultArchiveFiles(
  snapshot: VaultSnapshot,
  entities: readonly StoredEntity[],
  noteBodies: readonly NoteBodyRecord[],
): Promise<ExportFile[]> {
  const tree = new VaultTree(snapshot.entries);
  const files = vaultFiles(snapshot);
  const byPath = new Set(files.map(file => file.path));
  const entryById = new Map(snapshot.entries.map(entry => [entry.id, entry]));

  const stateAttachments: VaultArchiveState['attachments'] = [];
  for (const attachment of snapshot.attachments ?? []) {
    const entry = entryById.get(attachment.entryId);
    if (!entry || entry.kind !== 'attachment') throw new VaultError('CORRUPT', 'Attachment backup metadata points to a missing entry.');
    const bytes = base64Bytes(attachment.dataBase64);
    if (bytes.byteLength !== attachment.size) throw new VaultError('CORRUPT', 'Attachment backup size does not match its bytes.');

    let archivePath = entry.deletedAt === null ? tree.path(entry.id) : '.vault/deleted-attachments/' + entry.id + '.bin';
    if (entry.deletedAt !== null) {
      if (byPath.has(archivePath)) throw new VaultError('CORRUPT', 'Deleted attachment archive path collided unexpectedly.');
      files.push({ path: archivePath, bytes });
      byPath.add(archivePath);
    } else if (!byPath.has(archivePath)) {
      throw new VaultError('CORRUPT', 'Active attachment is missing from interoperable archive files.');
    }

    stateAttachments.push({
      entryId: attachment.entryId,
      mimeType: attachment.mimeType,
      size: attachment.size,
      archivePath,
    });
  }

  const manifest: VaultArchiveManifest = {
    format: 'vault-archive',
    version: 2,
    exportedAt: new Date().toISOString(),
    vaultId: snapshot.vault.id,
    vaultName: snapshot.vault.name,
    entries: snapshot.entries.map(entry => ({
      id: entry.id,
      kind: entry.kind,
      path: tree.path(entry.id),
      revision: entry.localVersion,
      deletedAt: entry.deletedAt,
    })),
  };

  const state: VaultArchiveState = {
    format: 'vault-archive-state',
    version: 1,
    vault: snapshot.vault,
    entries: snapshot.entries,
    contents: snapshot.contents,
    recoveryDrafts: snapshot.recoveryDrafts,
    revisions: snapshot.revisions ?? [],
    conflicts: snapshot.conflicts ?? [],
    attachments: stateAttachments,
  };

  files.push(
    jsonFile('.vault/manifest.json', manifest),
    jsonFile('.vault/state.json', state),
    jsonFile('.vault/entities.json', entities),
    jsonFile('.vault/note-bodies.json', noteBodies),
  );

  const checksums: Record<string, string> = {};
  for (const file of files) {
    if (file.path.endsWith('/')) continue;
    checksums[file.path] = await sha256Hex(file.bytes);
  }
  files.push(jsonFile('.vault/checksums.json', checksums));
  return files;
}

export async function validateFullVaultArchiveFiles(files: readonly ExportFile[]): Promise<void> {
  const byPath = new Map<string, ExportFile>();
  for (const file of files) {
    if (byPath.has(file.path)) throw new VaultError('CORRUPT', 'Vault archive contains duplicate file paths.');
    byPath.set(file.path, file);
  }
  for (const required of [
    '.vault/manifest.json',
    '.vault/entities.json',
    '.vault/note-bodies.json',
    '.vault/checksums.json',
  ]) {
    if (!byPath.has(required)) throw new VaultError('CORRUPT', 'Vault archive is missing ' + required + '.');
  }

  const manifest = parseJson<{ format?: string; version?: number; vaultId?: string }>(byPath, '.vault/manifest.json');
  const checksums = parseJson<Record<string, string>>(byPath, '.vault/checksums.json');
  if (manifest.format !== 'vault-archive' || (manifest.version !== 1 && manifest.version !== 2) || !manifest.vaultId) {
    throw new VaultError('CORRUPT', 'Vault archive manifest version is unsupported.');
  }

  for (const [path, expected] of Object.entries(checksums)) {
    const file = byPath.get(path);
    if (!file) throw new VaultError('CORRUPT', 'Vault archive checksum references a missing file.');
    const actual = await sha256Hex(file.bytes);
    if (actual !== expected) throw new VaultError('CORRUPT', 'Vault archive checksum mismatch for ' + path + '.');
  }

  if (manifest.version === 2) {
    if (!byPath.has('.vault/state.json')) throw new VaultError('CORRUPT', 'Vault archive is missing .vault/state.json.');
    const state = parseJson<VaultArchiveState>(byPath, '.vault/state.json');
    assertArchiveState(state, manifest as VaultArchiveManifest);
  }
}

export async function parseFullVaultArchiveFiles(files: readonly ExportFile[]): Promise<ParsedVaultArchive> {
  await validateFullVaultArchiveFiles(files);
  const byPath = new Map(files.map(file => [file.path, file]));
  const manifest = parseJson<VaultArchiveManifest>(byPath, '.vault/manifest.json');
  if (manifest.version !== 2) {
    throw new VaultError('UNSUPPORTED', 'This older Vault archive can be verified but cannot be losslessly restored. Re-export it with A2 archive version 2.');
  }
  const state = parseJson<VaultArchiveState>(byPath, '.vault/state.json');
  const entities = parseJson<StoredEntity[]>(byPath, '.vault/entities.json');
  const noteBodies = parseJson<NoteBodyRecord[]>(byPath, '.vault/note-bodies.json');
  assertArchiveState(state, manifest);
  if (!Array.isArray(entities) || !Array.isArray(noteBodies)) throw new VaultError('CORRUPT', 'Vault archive canonical records are invalid.');

  const attachments: AttachmentContent[] = [];
  for (const metadata of state.attachments) {
    const file = byPath.get(metadata.archivePath);
    if (!file || file.bytes.byteLength !== metadata.size) {
      throw new VaultError('CORRUPT', 'Vault archive attachment payload is missing or truncated.');
    }
    attachments.push({
      entryId: metadata.entryId as AttachmentContent['entryId'],
      vaultId: state.vault.id,
      mimeType: metadata.mimeType,
      size: metadata.size,
      bytes: file.bytes.slice(),
    });
  }

  const attachmentEntities = new Map(
    entities
      .filter((entity): entity is AttachmentEntity => entity.entityType === 'attachment')
      .map(entity => [entity.id as string, entity]),
  );
  for (const attachment of attachments) {
    const entity = attachmentEntities.get(attachment.entryId);
    if (!entity) throw new VaultError('CORRUPT', 'Vault archive attachment has no canonical Attachment entity.');
    const hash = await sha256Hex(attachment.bytes);
    if (hash !== entity.checksumSha256) throw new VaultError('CORRUPT', 'Vault archive attachment checksum does not match canonical metadata.');
  }

  const entityIds = new Set<string>();
  const noteEntityIds = new Set<string>();
  let vaultEntityCount = 0;
  for (const entity of entities) {
    const id = entity?.id as string | undefined;
    if (!id || entityIds.has(id)) throw new VaultError('CORRUPT', 'Vault archive canonical entity IDs are invalid or duplicated.');
    entityIds.add(id);

    if (entity.entityType === 'vault') {
      vaultEntityCount += 1;
      if (id !== state.vault.id) throw new VaultError('CORRUPT', 'Vault archive canonical Vault entity does not match restore state.');
    } else {
      if (!('vaultId' in entity) || (entity.vaultId as string) !== (state.vault.id as string)) {
        throw new VaultError('CORRUPT', 'Vault archive contains a cross-vault canonical entity.');
      }
      if (entity.entityType === 'note') noteEntityIds.add(id);
    }
  }
  if (vaultEntityCount !== 1) throw new VaultError('CORRUPT', 'Vault archive must contain exactly one canonical Vault entity.');

  const noteBodyIds = new Set<string>();
  for (const body of noteBodies) {
    const noteId = body?.noteId as string | undefined;
    if (!noteId || (body.vaultId as string) !== (state.vault.id as string) || typeof body.text !== 'string'
      || noteBodyIds.has(noteId) || !noteEntityIds.has(noteId)) {
      throw new VaultError('CORRUPT', 'Vault archive note-body records are invalid or duplicated.');
    }
    const legacyEntry = state.entries.find(entry => entry.id === noteId);
    if (!legacyEntry || legacyEntry.kind !== 'markdown' || body.revision !== legacyEntry.localVersion) {
      throw new VaultError('CORRUPT', 'Vault archive note body does not match its legacy Note revision.');
    }
    noteBodyIds.add(noteId);
  }
  for (const noteId of noteEntityIds) {
    if (!noteBodyIds.has(noteId)) throw new VaultError('CORRUPT', 'Vault archive is missing a canonical Note body.');
  }

  return { manifest, state, entities, noteBodies, attachments };
}

export async function restoreFullVaultArchive(
  database: IDBDatabase,
  files: readonly ExportFile[],
): Promise<VaultId> {
  const parsed = await parseFullVaultArchiveFiles(files);
  const driver = storageDriver(database);

  const collision = await driver.transaction(['vaults'], 'readonly', tx => tx.store('vaults').get<Vault>(parsed.state.vault.id));
  if (collision) throw new VaultError('COLLISION', 'A Vault with this archive identity already exists. Restore into an empty profile or remove the existing copy first.');

  const blobStore = await createPreferredBlobStore(database);
  const attachmentEntities = new Map(
    parsed.entities
      .filter((entity): entity is AttachmentEntity => entity.entityType === 'attachment')
      .map(entity => [entity.id as string, entity]),
  );
  for (const attachment of parsed.attachments) {
    const entity = attachmentEntities.get(attachment.entryId);
    if (!entity) throw new VaultError('CORRUPT', 'Attachment metadata disappeared during restore validation.');
    await blobStore.write(entity.checksumSha256, attachment.bytes);
  }

  const stores = [
    'vaults',
    'entries',
    'contents',
    'attachments',
    'dirty',
    'revisions',
    'drafts',
    'conflicts',
    'entities',
    'noteBodies',
  ] as const;

  await driver.transaction(stores, 'readwrite', async tx => {
    if (await tx.store('vaults').get<Vault>(parsed.state.vault.id)) {
      throw new VaultError('COLLISION', 'A Vault with this archive identity already exists.');
    }

    for (const entity of parsed.entities) {
      if (await tx.store('entities').get<StoredEntity>(entity.id as string)) {
        throw new VaultError('COLLISION', 'A canonical entity ID from this archive already exists locally.');
      }
    }

    await tx.store('vaults').add(parsed.state.vault);
    for (const entry of parsed.state.entries) await tx.store('entries').add(entry);
    for (const content of parsed.state.contents) await tx.store('contents').add(content);
    for (const attachment of parsed.attachments) await tx.store('attachments').add(attachment);
    for (const revision of parsed.state.revisions) await tx.store('revisions').add(revision);
    for (const draft of parsed.state.recoveryDrafts) await tx.store('drafts').add(draft);
    for (const conflict of parsed.state.conflicts ?? []) await tx.store('conflicts').add(conflict);
    for (const entity of parsed.entities) await tx.store('entities').add(entity);
    for (const body of parsed.noteBodies) await tx.store('noteBodies').add(body);

    const changedAt = new Date().toISOString();
    for (const entry of parsed.state.entries) {
      await tx.store('dirty').put({
        entryId: entry.id,
        vaultId: entry.vaultId,
        localVersion: entry.localVersion,
        changedAt,
        intent: entry.deletedAt ? 'trash' : 'upsert',
      } satisfies DirtyEntry);
    }
  });

  return parsed.state.vault.id;
}
