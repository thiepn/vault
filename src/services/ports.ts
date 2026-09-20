import type { Entry, EntryId, EntryWithContent, Vault, VaultId, VaultSnapshot } from '../domain/model.js';

export interface VaultRepository {
  listVaults(): Promise<Vault[]>;
  createVault(name: string): Promise<Vault>;
  renameVault(vaultId: VaultId, name: string): Promise<Vault>;
  snapshot(vaultId: VaultId): Promise<VaultSnapshot>;
}
export interface FileRepository {
  listEntries(vaultId: VaultId, includeTrash?: boolean): Promise<Entry[]>;
  createEntry(vaultId: VaultId, parentId: EntryId | null, name: string, kind: Entry['kind'], text?: string): Promise<Entry>;
  read(entryId: EntryId): Promise<EntryWithContent>;
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
