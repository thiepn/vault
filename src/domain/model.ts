declare const idBrand: unique symbol;
export type Id<K extends string> = string & { readonly [idBrand]: K };
export type VaultId = Id<'vault'>;
export type EntryId = Id<'entry'>;
export type OperationId = Id<'operation'>;
export type DeviceId = Id<'device'>;
export type Revision = number;
export type Principal = { kind: 'local' } | { kind: 'account'; userId: string; projectRef: string };

export function newId<K extends string>(): Id<K> {
  return crypto.randomUUID() as Id<K>;
}

export interface Vault {
  id: VaultId;
  name: string;
  createdAt: string;
  updatedAt: string;
  mode: 'local'; // Cloud adoption is an explicit later operation, never inferred from login.
}

export interface Entry {
  id: EntryId;
  vaultId: VaultId;
  parentId: EntryId | null;
  name: string;
  kind: 'directory' | 'markdown' | 'attachment';
  createdAt: string;
  updatedAt: string;
  localVersion: Revision;
  deletedAt: string | null;
  deletionBatch: string | null;
  /** Sparse unique key. Omitted for trashed entries. */
  activeKey?: string;
}

export interface MarkdownContent {
  entryId: EntryId;
  text: string;
  localVersion: Revision;
}

export interface AttachmentContent {
  entryId: EntryId;
  vaultId: VaultId;
  mimeType: string;
  size: number;
  bytes: Uint8Array;
}

export interface AttachmentSnapshot {
  entryId: EntryId;
  mimeType: string;
  size: number;
  dataBase64: string;
}

export interface DirtyEntry {
  entryId: EntryId;
  vaultId: VaultId;
  localVersion: Revision;
  changedAt: string;
  /** This is NOT an upload job. A local vault is never uploaded automatically. */
  intent: 'upsert' | 'trash' | 'restore';
}

export interface LocalRevision {
  id: string;
  entryId: EntryId;
  vaultId: VaultId;
  text: string;
  localVersion: Revision;
  createdAt: string;
  reason: 'checkpoint' | 'trash' | 'restore';
}

export interface RecoveryDraft {
  id: string;
  entryId: EntryId;
  vaultId: VaultId;
  baseVersion: Revision;
  text: string;
  createdAt: string;
  reason: 'stale-write' | 'deleted-write' | 'invalid-content' | 'editor-recovery';
}

export interface Setting { key: string; value: unknown }
export interface EntryWithContent {
  entry: Entry;
  content: MarkdownContent | null;
  attachment: AttachmentContent | null;
}
export interface VaultSnapshot {
  format: 'vault-local-backup';
  version: 2;
  exportedAt: string;
  vault: Vault;
  entries: Entry[];
  contents: MarkdownContent[];
  attachments: AttachmentSnapshot[];
  recoveryDrafts: RecoveryDraft[];
  revisions?: LocalRevision[];
}
