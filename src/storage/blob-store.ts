import { VaultError } from '../domain/errors.js';
import { storageDriver, type LocalStorageDriver } from './driver.js';

const hashPattern = /^[0-9a-f]{64}$/u;

export interface BlobStore {
  readonly kind: 'opfs' | 'indexeddb' | 'hybrid';
  has(hash: string): Promise<boolean>;
  write(hash: string, bytes: Uint8Array): Promise<void>;
  read(hash: string): Promise<Uint8Array | null>;
  delete(hash: string): Promise<void>;
}

export interface BlobPayloadRecord {
  hash: string;
  size: number;
  bytes: Uint8Array;
  createdAt: string;
}

function assertHash(hash: string): void {
  if (!hashPattern.test(hash)) throw new VaultError('CORRUPT', 'Blob hash must be lowercase SHA-256 hex.');
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!(bytes instanceof Uint8Array)) throw new VaultError('CORRUPT', 'Blob payload must be binary bytes.');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

export class IndexedDbBlobStore implements BlobStore {
  readonly kind = 'indexeddb' as const;
  private readonly driver: LocalStorageDriver;

  constructor(database: IDBDatabase | LocalStorageDriver) {
    this.driver = storageDriver(database);
  }

  async has(hash: string): Promise<boolean> {
    assertHash(hash);
    return this.driver.transaction(['blobPayloads'], 'readonly', async tx => !!await tx.store('blobPayloads').get<BlobPayloadRecord>(hash));
  }

  async write(hash: string, bytes: Uint8Array): Promise<void> {
    assertHash(hash);
    const actual = await sha256Hex(bytes);
    if (actual !== hash) throw new VaultError('CORRUPT', 'Blob payload does not match its SHA-256 identity.');
    await this.driver.transaction(['blobPayloads'], 'readwrite', async tx => {
      const existing = await tx.store('blobPayloads').get<BlobPayloadRecord>(hash);
      if (existing) {
        if (existing.size !== bytes.byteLength) throw new VaultError('CORRUPT', 'Existing blob size does not match its hash identity.');
        return;
      }
      await tx.store('blobPayloads').add({
        hash,
        size: bytes.byteLength,
        bytes: bytes.slice(),
        createdAt: new Date().toISOString(),
      } satisfies BlobPayloadRecord);
    });
  }

  async read(hash: string): Promise<Uint8Array | null> {
    assertHash(hash);
    return this.driver.transaction(['blobPayloads'], 'readonly', async tx => {
      const record = await tx.store('blobPayloads').get<BlobPayloadRecord>(hash);
      if (!record) return null;
      if (record.size !== record.bytes.byteLength) throw new VaultError('CORRUPT', 'IndexedDB blob bytes are truncated.');
      return record.bytes.slice();
    });
  }

  async delete(hash: string): Promise<void> {
    assertHash(hash);
    await this.driver.transaction(['blobPayloads'], 'readwrite', tx => tx.store('blobPayloads').delete(hash));
  }
}

interface StorageManagerWithDirectory extends StorageManager {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>;
}

export class OpfsBlobStore implements BlobStore {
  readonly kind = 'opfs' as const;

  private async directory(hash: string, create: boolean): Promise<FileSystemDirectoryHandle> {
    assertHash(hash);
    const manager = navigator.storage as StorageManagerWithDirectory;
    if (!manager.getDirectory) throw new VaultError('UNSUPPORTED', 'OPFS is unavailable in this browser.');
    const root = await manager.getDirectory();
    const vault = await root.getDirectoryHandle('vault-blobs', { create });
    const sha = await vault.getDirectoryHandle('sha256', { create });
    return sha.getDirectoryHandle(hash.slice(0, 2), { create });
  }

  async has(hash: string): Promise<boolean> {
    try {
      const directory = await this.directory(hash, false);
      await directory.getFileHandle(hash, { create: false });
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return false;
      throw error;
    }
  }

  async write(hash: string, bytes: Uint8Array): Promise<void> {
    assertHash(hash);
    const actual = await sha256Hex(bytes);
    if (actual !== hash) throw new VaultError('CORRUPT', 'Blob payload does not match its SHA-256 identity.');
    const directory = await this.directory(hash, true);
    const handle = await directory.getFileHandle(hash, { create: true });
    const existing = await handle.getFile();
    if (existing.size === bytes.byteLength && existing.size > 0) return;
    const writable = await handle.createWritable();
    try {
      await writable.write(bytes);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => undefined);
      throw error;
    }
    const verified = await handle.getFile();
    if (verified.size !== bytes.byteLength) throw new VaultError('STORAGE', 'OPFS blob write was incomplete.');
  }

  async read(hash: string): Promise<Uint8Array | null> {
    try {
      const directory = await this.directory(hash, false);
      const handle = await directory.getFileHandle(hash, { create: false });
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;
      throw error;
    }
  }

  async delete(hash: string): Promise<void> {
    try {
      const directory = await this.directory(hash, false);
      await directory.removeEntry(hash);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return;
      throw error;
    }
  }
}

/**
 * Reads prefer OPFS. IndexedDB remains a durable browser fallback and a repair
 * target. Writes go to OPFS when possible, otherwise to the fallback.
 */
export class HybridBlobStore implements BlobStore {
  readonly kind = 'hybrid' as const;

  constructor(
    private readonly primary: BlobStore,
    private readonly fallback: BlobStore,
  ) {}

  async has(hash: string): Promise<boolean> {
    try {
      if (await this.primary.has(hash)) return true;
    } catch {
      // The fallback remains a valid local implementation.
    }
    return this.fallback.has(hash);
  }

  async write(hash: string, bytes: Uint8Array): Promise<void> {
    try {
      await this.primary.write(hash, bytes);
    } catch {
      await this.fallback.write(hash, bytes);
    }
  }

  async read(hash: string): Promise<Uint8Array | null> {
    try {
      const primary = await this.primary.read(hash);
      if (primary) return primary;
    } catch {
      // Fall through to IndexedDB.
    }
    return this.fallback.read(hash);
  }

  async delete(hash: string): Promise<void> {
    await Promise.allSettled([this.primary.delete(hash), this.fallback.delete(hash)]);
  }
}

export async function createPreferredBlobStore(database: IDBDatabase): Promise<BlobStore> {
  const fallback = new IndexedDbBlobStore(database);
  const manager = typeof navigator === 'undefined' ? undefined : navigator.storage as StorageManagerWithDirectory | undefined;
  if (!manager?.getDirectory) return fallback;

  const primary = new OpfsBlobStore();
  try {
    // Capability probe creates only Vault's private blob directory.
    const probe = await sha256Hex(new Uint8Array());
    await primary.write(probe, new Uint8Array());
    await primary.delete(probe);
    return new HybridBlobStore(primary, fallback);
  } catch {
    return fallback;
  }
}
