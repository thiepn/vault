import { request, transact } from './idb.js';
import type { StoreName } from './database.js';

/** Narrow transaction port. Production uses native IndexedDB; test doubles do not
 * claim to reproduce browser durability, quota or transaction scheduling. */
export interface TransactionStore {
  get<T>(key: string): Promise<T | undefined>;
  getAll<T>(): Promise<T[]>;
  fromIndex<T>(index: string, key: string): Promise<T | undefined>;
  allFromIndex<T>(index: string, key: string): Promise<T[]>;
  add(value: object): Promise<void>;
  put(value: object): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface StorageTransaction { store(name: StoreName): TransactionStore }
export interface LocalStorageDriver {
  transaction<T>(stores: readonly StoreName[], mode: IDBTransactionMode, body: (tx: StorageTransaction) => Promise<T>): Promise<T>;
  hasStore?(name: StoreName): boolean;
}

export class NativeIndexedDBDriver implements LocalStorageDriver {
  constructor(readonly database: IDBDatabase) {}
  hasStore(name: StoreName): boolean { return this.database.objectStoreNames.contains(name); }
  transaction<T>(stores: readonly StoreName[], mode: IDBTransactionMode, body: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    return transact(this.database, [...stores], mode, tx => body({
      store(name) {
        const target = tx.objectStore(name);
        return {
          get: <V>(key: string) => request<V | undefined>(target.get(key)),
          getAll: <V>() => request<V[]>(target.getAll()),
          fromIndex: <V>(index: string, key: string) => request<V | undefined>(target.index(index).get(key)),
          allFromIndex: <V>(index: string, key: string) => request<V[]>(target.index(index).getAll(key)),
          async add(value) { await request(target.add(value)); },
          async put(value) { await request(target.put(value)); },
          async delete(key) { await request(target.delete(key)); },
        };
      },
    }));
  }
}

export function storageDriver(value: IDBDatabase | LocalStorageDriver): LocalStorageDriver {
  return 'objectStoreNames' in value ? new NativeIndexedDBDriver(value) : value;
}
