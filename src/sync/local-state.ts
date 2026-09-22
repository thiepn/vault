import { VaultError } from '../domain/errors.js';
import type { OperationId, VaultId } from '../domain/model.js';
import { storageDriver, type LocalStorageDriver } from '../storage/driver.js';
import { assertOwner, decodeOperation, type Cursor, type SealedOperation } from './protocol.js';

export interface SyncOutboxRecord {
  id: OperationId;
  vaultId: VaultId;
  ownerId: string;
  wire: string;
  sha256: string;
  createdAt: string;
  attempt: number;
  nextAttemptAt: string;
}

export interface SyncCursorRecord {
  vaultId: VaultId;
  ownerId: string;
  epoch: string;
  cursor: Cursor;
  updatedAt: string;
}

function bigintCursor(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new VaultError('PROTOCOL','Invalid local synchronization cursor.');
  const parsed=BigInt(value);
  if (parsed > 9223372036854775807n) throw new VaultError('PROTOCOL','Synchronization cursor exceeds PostgreSQL bigint.');
  return parsed;
}

export class SyncLocalState {
  private readonly driver: LocalStorageDriver;
  constructor(database: IDBDatabase|LocalStorageDriver) { this.driver=storageDriver(database); }

  async enqueue(operation: SealedOperation): Promise<SyncOutboxRecord> {
    const decoded=decodeOperation(operation.wire);
    if (decoded.id !== operation.id || decoded.vaultId !== operation.vaultId || decoded.ownerId !== operation.ownerId) {
      throw new VaultError('PROTOCOL','The sealed operation envelope does not match its exact wire payload.');
    }
    const now=new Date().toISOString();
    const record: SyncOutboxRecord={
      id:operation.id,
      vaultId:operation.vaultId,
      ownerId:operation.ownerId,
      wire:operation.wire,
      sha256:operation.sha256,
      createdAt:now,
      attempt:0,
      nextAttemptAt:now,
    };
    return this.driver.transaction(['outbox'],'readwrite',async tx=>{
      const existing=await tx.store('outbox').get<SyncOutboxRecord>(operation.id);
      if (existing) {
        if (existing.sha256 !== record.sha256 || existing.wire !== record.wire || existing.ownerId !== record.ownerId || existing.vaultId !== record.vaultId) {
          throw new VaultError('PROTOCOL','An outbox operation ID was reused with different bytes.');
        }
        return existing;
      }
      await tx.store('outbox').add(record);
      return record;
    });
  }

  async pending(vaultId: VaultId, ownerId: string, at=new Date()): Promise<SyncOutboxRecord[]> {
    const now=at.getTime();
    const rows=await this.driver.transaction(['outbox'],'readonly',tx=>tx.store('outbox').allFromIndex<SyncOutboxRecord>('vaultId',vaultId));
    return rows
      .filter(row=>row.ownerId===ownerId && Number.isFinite(Date.parse(row.nextAttemptAt)) && Date.parse(row.nextAttemptAt)<=now)
      .sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
  }

  async assertPendingOwners(vaultId: VaultId, authenticatedUserId: string): Promise<void> {
    const rows=await this.driver.transaction(['outbox'],'readonly',tx=>tx.store('outbox').allFromIndex<SyncOutboxRecord>('vaultId',vaultId));
    for (const row of rows) {
      assertOwner({id:row.id,vaultId:row.vaultId,ownerId:row.ownerId,wire:row.wire,sha256:row.sha256},authenticatedUserId);
    }
  }

  async markAttempt(id: OperationId, attempt: number, nextAttemptAt: string): Promise<void> {
    if (!Number.isInteger(attempt) || attempt < 1 || !Number.isFinite(Date.parse(nextAttemptAt))) throw new VaultError('PROTOCOL','Invalid outbox retry state.');
    await this.driver.transaction(['outbox'],'readwrite',async tx=>{
      const row=await tx.store('outbox').get<SyncOutboxRecord>(id);
      if (!row) return;
      await tx.store('outbox').put({...row,attempt,nextAttemptAt});
    });
  }

  async acknowledge(id: OperationId): Promise<void> {
    await this.driver.transaction(['outbox'],'readwrite',tx=>tx.store('outbox').delete(id));
  }

  async count(vaultId: VaultId): Promise<number> {
    const rows=await this.driver.transaction(['outbox'],'readonly',tx=>tx.store('outbox').allFromIndex<SyncOutboxRecord>('vaultId',vaultId));
    return rows.length;
  }

  async cursor(vaultId: VaultId, ownerId: string): Promise<SyncCursorRecord|null> {
    const row=await this.driver.transaction(['syncCursors'],'readonly',tx=>tx.store('syncCursors').get<SyncCursorRecord>(vaultId));
    if (!row) return null;
    if (row.ownerId !== ownerId) throw new VaultError('ACCOUNT_MISMATCH','This Vault cursor belongs to another account.');
    bigintCursor(row.cursor);
    return row;
  }

  async initializeCursor(vaultId: VaultId, ownerId: string, epoch: string): Promise<SyncCursorRecord> {
    const existing=await this.cursor(vaultId,ownerId);
    if (existing) {
      if (existing.epoch !== epoch) throw new VaultError('PROTOCOL','The remote synchronization epoch changed. Reconciliation is required before continuing.');
      return existing;
    }
    const record: SyncCursorRecord={vaultId,ownerId,epoch,cursor:'0',updatedAt:new Date().toISOString()};
    await this.driver.transaction(['syncCursors'],'readwrite',tx=>tx.store('syncCursors').add(record));
    return record;
  }

  async advanceCursor(vaultId: VaultId, ownerId: string, epoch: string, next: Cursor): Promise<SyncCursorRecord> {
    const nextValue=bigintCursor(next);
    return this.driver.transaction(['syncCursors'],'readwrite',async tx=>{
      const current=await tx.store('syncCursors').get<SyncCursorRecord>(vaultId);
      if (!current) {
        if (nextValue !== 0n) throw new VaultError('PROTOCOL','A synchronization cursor cannot skip the initial remote history.');
        const initialized: SyncCursorRecord={vaultId,ownerId,epoch,cursor:next,updatedAt:new Date().toISOString()};
        await tx.store('syncCursors').add(initialized);
        return initialized;
      }
      if (current.ownerId !== ownerId) throw new VaultError('ACCOUNT_MISMATCH','This Vault cursor belongs to another account.');
      if (current.epoch !== epoch) throw new VaultError('PROTOCOL','The synchronization epoch changed. Reconciliation is required.');
      const currentValue=bigintCursor(current.cursor);
      if (nextValue < currentValue) throw new VaultError('PROTOCOL','Synchronization cursor cannot move backwards.');
      if (nextValue === currentValue) return current;
      const updated={...current,cursor:next,updatedAt:new Date().toISOString()};
      await tx.store('syncCursors').put(updated);
      return updated;
    });
  }
}
