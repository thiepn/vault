import { VaultError } from '../domain/errors.js';
import type { Principal } from '../domain/model.js';

/**
 * Schema v7 extends the A2 persistence foundation with an offline-safe
 * collaboration-history outbox while retaining conflict/background state.
 * Phase 1–11 stores stay intact while canonical entities/note bodies/blobs are
 * populated and verified before a later cut-over. This makes upgrade rollback
 * possible without re-identifying existing content.
 */
export const SCHEMA_VERSION = 7;
export const STORES = [
  'vaults',
  'entries',
  'contents',
  'attachments',
  'dirty',
  'outbox',
  'revisions',
  'drafts',
  'settings',
  'remoteShadows',
  'syncCursors',
  'knowledge',
  'entities',
  'noteBodies',
  'blobPayloads',
  'migrationState',
  'backgroundRuntime',
  'remoteInbox',
  'conflicts',
  'collabHistoryOutbox',
] as const;
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
      if (event.oldVersion < 2) {
        const knowledge = db.createObjectStore('knowledge', { keyPath: 'entryId' });
        knowledge.createIndex('vaultId', 'vaultId');
      }
      if (event.oldVersion < 3) {
        const attachments = db.createObjectStore('attachments', { keyPath: 'entryId' });
        attachments.createIndex('vaultId', 'vaultId');
      }
      if (event.oldVersion < 4) {
        const entities = db.createObjectStore('entities', { keyPath: 'id' });
        entities.createIndex('vaultId', 'vaultId');
        entities.createIndex('entityType', 'entityType');
        entities.createIndex('vaultEntityType', ['vaultId', 'entityType']);
        entities.createIndex('sourceNoteId', 'sourceNoteId');

        const noteBodies = db.createObjectStore('noteBodies', { keyPath: 'noteId' });
        noteBodies.createIndex('vaultId', 'vaultId');

        const blobs = db.createObjectStore('blobPayloads', { keyPath: 'hash' });
        blobs.createIndex('createdAt', 'createdAt');

        db.createObjectStore('migrationState', { keyPath: 'id' });
      }
      if (event.oldVersion < 5) {
        db.createObjectStore('backgroundRuntime', { keyPath: 'id' });
        const inbox = db.createObjectStore('remoteInbox', { keyPath: 'id' });
        inbox.createIndex('vaultId', 'vaultId');
        inbox.createIndex('vaultSequence', ['vaultId', 'sequence'], { unique: true });
      }
      if (event.oldVersion < 6) {
        const conflicts = db.createObjectStore('conflicts', { keyPath: 'id' });
        conflicts.createIndex('vaultId', 'vaultId');
        conflicts.createIndex('entryId', 'entryId');
        conflicts.createIndex('conflictEntryId', 'conflictEntryId');
      }
      if (event.oldVersion < 7) {
        const historyOutbox = db.createObjectStore('collabHistoryOutbox', { keyPath: 'id' });
        historyOutbox.createIndex('vaultId', 'vaultId');
        historyOutbox.createIndex('entryId', 'entryId');
        historyOutbox.createIndex('createdAt', 'createdAt');
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
