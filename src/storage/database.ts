import { VaultError } from '../domain/errors.js';
import type { Principal } from '../domain/model.js';

export const SCHEMA_VERSION = 1;
export const STORES = ['vaults', 'entries', 'contents', 'dirty', 'outbox', 'revisions', 'drafts', 'settings', 'remoteShadows', 'syncCursors'] as const;
export type StoreName = typeof STORES[number];

export function databaseName(principal: Principal): string {
  if (principal.kind === 'local') return 'vault:local';
  if (!/^[a-z0-9-]+$/i.test(principal.projectRef) || !/^[a-z0-9-]+$/i.test(principal.userId)) {
    throw new VaultError('ACCOUNT_MISMATCH', 'Invalid account storage identity.');
  }
  return `vault:account:${principal.projectRef}:${principal.userId}`;
}

export async function openDatabase(name = databaseName({ kind: 'local' })): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') throw new VaultError('UNSUPPORTED', 'This browser does not provide IndexedDB. No notes have been saved.');
  return new Promise((resolve, reject) => {
    let failed = false;
    const req = indexedDB.open(name, SCHEMA_VERSION);
    req.onblocked = () => { failed = true; reject(new VaultError('STORAGE', 'Another tab is blocking a database update. Close that tab and reload.')); };
    req.onerror = () => reject(req.error ?? new VaultError('STORAGE', 'The local database could not be opened.'));
    req.onupgradeneeded = event => {
      const db = req.result;
      if (failed) { req.transaction?.abort(); return; }
      if (event.oldVersion < 1) {
        db.createObjectStore('vaults', { keyPath: 'id' });
        const entries = db.createObjectStore('entries', { keyPath: 'id' });
        entries.createIndex('vaultId', 'vaultId');
        entries.createIndex('activeKey', 'activeKey', { unique: true });
        db.createObjectStore('contents', { keyPath: 'entryId' });
        const dirty = db.createObjectStore('dirty', { keyPath: 'entryId' });
        dirty.createIndex('vaultId', 'vaultId');
        const outbox = db.createObjectStore('outbox', { keyPath: 'id' });
        outbox.createIndex('vaultId', 'vaultId');
        const revisions = db.createObjectStore('revisions', { keyPath: 'id' });
        revisions.createIndex('entryId', 'entryId');
        revisions.createIndex('vaultId', 'vaultId');
        const drafts = db.createObjectStore('drafts', { keyPath: 'id' });
        drafts.createIndex('entryId', 'entryId');
        drafts.createIndex('vaultId', 'vaultId');
        db.createObjectStore('settings', { keyPath: 'key' });
        db.createObjectStore('remoteShadows', { keyPath: 'entryId' });
        db.createObjectStore('syncCursors', { keyPath: 'vaultId' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      if (failed) { db.close(); return; }
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}
