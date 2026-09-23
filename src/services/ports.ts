import type { AttachmentContent, CloudVaultBinding, CloudVaultRole, Entry, EntryId, EntryWithContent, Vault, VaultId, VaultSnapshot } from '../domain/model.js';

export interface VaultRepository {
  listVaults(): Promise<Vault[]>;
  createVault(name: string): Promise<Vault>;
  renameVault(vaultId: VaultId, name: string): Promise<Vault>;
  adoptCloud(vaultId: VaultId, binding: CloudVaultBinding): Promise<Vault>;
  createCloudReplica(name: string, binding: CloudVaultBinding): Promise<Vault>;
  updateCloudAccess(vaultId: VaultId, access: { accessRole: CloudVaultRole; ownerAccountId: CloudVaultBinding['accountId']; ownerAuthUserId: string }): Promise<Vault>;
  updateCloudProtocol(vaultId: VaultId, protocolVersion: CloudVaultBinding['protocolVersion']): Promise<Vault>;
  snapshot(vaultId: VaultId): Promise<VaultSnapshot>;
}
export interface FileRepository {
  listEntries(vaultId: VaultId, includeTrash?: boolean): Promise<Entry[]>;
  createEntry(vaultId: VaultId, parentId: EntryId | null, name: string, kind: Exclude<Entry['kind'], 'attachment'>, text?: string): Promise<Entry>;
  createAttachment(vaultId: VaultId, parentId: EntryId | null, name: string, mimeType: string, bytes: Uint8Array): Promise<Entry>;
  read(entryId: EntryId): Promise<EntryWithContent>;
  readAttachment(entryId: EntryId): Promise<AttachmentContent>;
  saveMarkdown(entryId: EntryId, text: string, expectedVersion: number): Promise<Entry>;
  move(entryId: EntryId, parentId: EntryId | null, name: string, expectedVersion: number): Promise<Entry>;
  duplicate(entryId: EntryId, expectedVersion: number): Promise<Entry>;
  trash(entryId: EntryId, expectedVersion: number): Promise<void>;
  restore(entryId: EntryId): Promise<void>;
}
export interface AuthIdentity { userId: string; email: string | null }
export interface AuthService {
  readonly configured: boolean;
  identity(): Promise<AuthIdentity | null>;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}
export interface RevisionRepository {
  checkpoint(entryId: EntryId): Promise<void>;
}
