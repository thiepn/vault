declare const idBrand: unique symbol;
export type Id<K extends string> = string & { readonly [idBrand]: K };
export type VaultId = Id<'vault'>;
export type AccountId = Id<'account'>;
export type EntryId = Id<'entry'>;
export type OperationId = Id<'operation'>;
export type DeviceId = Id<'device'>;
export type Revision = number;
export type CloudVaultRole = 'owner' | 'editor' | 'viewer' | 'revoked';
export type Principal = { kind: 'local' } | { kind: 'account'; userId: string; projectRef: string };

export function newId<K extends string>(): Id<K> {
  return crypto.randomUUID() as Id<K>;
}

export interface CloudVaultBinding {
  /** Account currently using this local replica. */
  accountId: AccountId;
  /** Auth user currently using this local replica. */
  authUserId: string;
  /** Stable owner identity. Omitted on legacy bindings where actor = owner. */
  ownerAccountId?: AccountId;
  ownerAuthUserId?: string;
  /** Server-authoritative membership role. Legacy bindings default to owner. */
  accessRole?: CloudVaultRole;
  projectRef: string;
  remoteVaultId: VaultId;
  epoch: string;
  protocolVersion: 1 | 2;
  deviceId: DeviceId;
  adoptedAt: string;
}

export interface Vault {
  id: VaultId;
  name: string;
  createdAt: string;
  updatedAt: string;
  mode: 'local' | 'cloud';
  /** Present only after an explicit user-initiated cloud adoption. */
  cloud?: CloudVaultBinding;
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
  reason: 'checkpoint' | 'trash' | 'restore' | 'migration';
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

export interface MarkdownConflictRecord {
  id: string;
  vaultId: VaultId;
  entryId: EntryId;
  conflictEntryId: EntryId;
  ownerId: string;
  epoch: string;
  baseRevision: Revision;
  remoteRevision: Revision;
  baseText: string;
  localText: string;
  remoteText: string;
  source: 'pull' | 'push';
  status: 'open' | 'resolved';
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolutionText: string | null;
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
  conflicts?: MarkdownConflictRecord[];
  /** Protocol v2 BASE/LOCAL/REMOTE conflicts; type-only import avoids duplicating the wire-independent record model. */
  syncConflicts?: import('../sync/conflict-store-v2.js').SyncConflictRecordV2[];
}
