import { VaultError } from '../domain/errors.js';
import type { AccountId, OperationId, VaultId } from '../domain/model.js';
import { storageDriver, type LocalStorageDriver } from '../storage/driver.js';
import {
  assertAccountV2,
  decodeOperationV2,
  validateSealedOperationV2,
  type CursorV2,
  type SealedOperationV2,
} from './protocol-v2.js';

export interface SyncOutboxRecordV2 {
  protocolVersion: 2;
  id: OperationId;
  vaultId: VaultId;
  accountId: AccountId;
  wire: string;
  sha256: string;
  createdAt: string;
  attempt: number;
  nextAttemptAt: string;
  acceptedAt?: string | null;
  acceptedThrough?: string | null;
}

export interface SyncCursorRecordV2 {
  protocolVersion: 2;
  vaultId: VaultId;
  accountId: AccountId;
  epoch: string;
  cursor: CursorV2;
  updatedAt: string;
}

interface LegacyOutboxLike {
  id?: string;
  vaultId?: string;
  ownerId?: string;
  wire?: string;
}

interface LegacyCursorLike {
  vaultId?: string;
  ownerId?: string;
  epoch?: string;
  cursor?: string;
  accountId?: string;
  protocolVersion?: number;
}

interface LegacyShadowLike {
  vaultId?: string;
}

function bigintCursor(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new VaultError('PROTOCOL', 'Invalid Protocol v2 local synchronization cursor.');
  const parsed = BigInt(value);
  if (parsed > 9223372036854775807n) throw new VaultError('PROTOCOL', 'Protocol v2 synchronization cursor exceeds PostgreSQL bigint.');
  return parsed;
}

/**
 * Account-bound Protocol v2 persistence. It deliberately shares the existing
 * outbox/syncCursors object stores so no second source of truth is introduced.
 * Legacy v1 rows remain immutable and are never rewritten as v2 operations.
 */
export class SyncLocalStateV2 {
  private readonly driver: LocalStorageDriver;

  constructor(database: IDBDatabase | LocalStorageDriver) {
    this.driver = storageDriver(database);
  }

  async enqueue(operation: SealedOperationV2): Promise<SyncOutboxRecordV2> {
    validateSealedOperationV2(operation);
    const decoded = decodeOperationV2(operation.wire);
    if (decoded.operationId !== operation.operationId
      || decoded.vaultId !== operation.vaultId
      || decoded.accountId !== operation.accountId) {
      throw new VaultError('PROTOCOL', 'The sealed Protocol v2 operation does not match its exact wire payload.');
    }
    const now = new Date().toISOString();
    const row: SyncOutboxRecordV2 = {
      protocolVersion: 2,
      id: operation.operationId,
      vaultId: operation.vaultId,
      accountId: operation.accountId,
      wire: operation.wire,
      sha256: operation.sha256,
      createdAt: now,
      attempt: 0,
      nextAttemptAt: now,
      acceptedAt: null,
      acceptedThrough: null,
    };

    return this.driver.transaction(['outbox'], 'readwrite', async tx => {
      const existing = await tx.store('outbox').get<SyncOutboxRecordV2 | LegacyOutboxLike>(operation.operationId);
      if (existing) {
        if ((existing as SyncOutboxRecordV2).protocolVersion !== 2
          || (existing as SyncOutboxRecordV2).sha256 !== row.sha256
          || (existing as SyncOutboxRecordV2).wire !== row.wire
          || (existing as SyncOutboxRecordV2).accountId !== row.accountId
          || existing.vaultId !== row.vaultId) {
          throw new VaultError('PROTOCOL', 'A Protocol v2 outbox operation ID was reused with different bytes or legacy identity.');
        }
        return existing as SyncOutboxRecordV2;
      }
      await tx.store('outbox').add(row);
      return row;
    });
  }

  async pending(vaultId: VaultId, accountId: AccountId, at = new Date()): Promise<SyncOutboxRecordV2[]> {
    const now = at.getTime();
    const rows = await this.driver.transaction(
      ['outbox'],
      'readonly',
      tx => tx.store('outbox').allFromIndex<SyncOutboxRecordV2 | LegacyOutboxLike>('vaultId', vaultId),
    );
    return rows
      .filter((row): row is SyncOutboxRecordV2 => (row as SyncOutboxRecordV2).protocolVersion === 2)
      .filter(row => row.accountId === accountId && Number.isFinite(Date.parse(row.nextAttemptAt)) && Date.parse(row.nextAttemptAt) <= now)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  async assertPendingAccounts(vaultId: VaultId, accountId: AccountId): Promise<void> {
    const rows = await this.driver.transaction(
      ['outbox'],
      'readonly',
      tx => tx.store('outbox').allFromIndex<SyncOutboxRecordV2 | LegacyOutboxLike>('vaultId', vaultId),
    );
    for (const row of rows) {
      if ((row as SyncOutboxRecordV2).protocolVersion !== 2) {
        throw new VaultError('PROTOCOL', 'Legacy Protocol v1 outbox work must be reconciled before Protocol v2 can start.');
      }
      const v2 = row as SyncOutboxRecordV2;
      assertAccountV2({ accountId: v2.accountId }, accountId);
    }
  }

  async pendingForEntity(vaultId: VaultId, accountId: AccountId, entityId: string): Promise<SyncOutboxRecordV2[]> {
    const rows = await this.pending(vaultId, accountId, new Date(8640000000000000));
    return rows.filter(row => decodeOperationV2(row.wire).mutations.some(mutation => mutation.entityId === entityId));
  }

  async dropEntityOperations(vaultId: VaultId, accountId: AccountId, entityId: string): Promise<void> {
    const rows = await this.pendingForEntity(vaultId, accountId, entityId);
    if (!rows.length) return;
    await this.driver.transaction(['outbox'], 'readwrite', async tx => {
      for (const row of rows) await tx.store('outbox').delete(row.id);
    });
  }

  async markAccepted(id: OperationId, through: string): Promise<void> {
    bigintCursor(through);
    await this.driver.transaction(['outbox'], 'readwrite', async tx => {
      const row = await tx.store('outbox').get<SyncOutboxRecordV2>(id);
      if (!row) return;
      if (row.protocolVersion !== 2) throw new VaultError('PROTOCOL', 'Cannot accept a legacy outbox row through Protocol v2.');
      const next: SyncOutboxRecordV2 = {
        ...row,
        acceptedAt: row.acceptedAt ?? new Date().toISOString(),
        acceptedThrough: through,
      };
      await tx.store('outbox').put(next);
    });
  }

  async markAttempt(id: OperationId, attempt: number, nextAttemptAt: string): Promise<void> {
    if (!Number.isInteger(attempt) || attempt < 1 || !Number.isFinite(Date.parse(nextAttemptAt))) {
      throw new VaultError('PROTOCOL', 'Invalid Protocol v2 outbox retry state.');
    }
    await this.driver.transaction(['outbox'], 'readwrite', async tx => {
      const row = await tx.store('outbox').get<SyncOutboxRecordV2>(id);
      if (!row) return;
      if (row.protocolVersion !== 2) throw new VaultError('PROTOCOL', 'Cannot mutate retry state for a legacy outbox row through Protocol v2.');
      await tx.store('outbox').put({ ...row, attempt, nextAttemptAt });
    });
  }

  async acknowledge(id: OperationId): Promise<void> {
    await this.driver.transaction(['outbox'], 'readwrite', tx => tx.store('outbox').delete(id));
  }

  async count(vaultId: VaultId, accountId?: AccountId): Promise<number> {
    const rows = await this.driver.transaction(
      ['outbox'],
      'readonly',
      tx => tx.store('outbox').allFromIndex<SyncOutboxRecordV2 | LegacyOutboxLike>('vaultId', vaultId),
    );
    return rows.filter(row => {
      if ((row as SyncOutboxRecordV2).protocolVersion !== 2) return false;
      return accountId === undefined || (row as SyncOutboxRecordV2).accountId === accountId;
    }).length;
  }

  async cursor(vaultId: VaultId, accountId: AccountId): Promise<SyncCursorRecordV2 | null> {
    const row = await this.driver.transaction(
      ['syncCursors'],
      'readonly',
      tx => tx.store('syncCursors').get<SyncCursorRecordV2 | LegacyCursorLike>(vaultId),
    );
    if (!row) return null;
    if ((row as SyncCursorRecordV2).protocolVersion !== 2 || !(row as SyncCursorRecordV2).accountId) {
      throw new VaultError('PROTOCOL', 'This Vault still has a legacy Protocol v1 cursor. Run the clean Protocol v2 migration first.');
    }
    const v2 = row as SyncCursorRecordV2;
    if (v2.accountId !== accountId) throw new VaultError('ACCOUNT_MISMATCH', 'This Protocol v2 Vault cursor belongs to another AccountId.');
    bigintCursor(v2.cursor);
    return v2;
  }

  async initializeCursor(vaultId: VaultId, accountId: AccountId, epoch: string): Promise<SyncCursorRecordV2> {
    const existing = await this.cursor(vaultId, accountId);
    if (existing) {
      if (existing.epoch !== epoch) throw new VaultError('PROTOCOL', 'The remote synchronization epoch changed. Resynchronization is required.');
      return existing;
    }
    const row: SyncCursorRecordV2 = {
      protocolVersion: 2,
      vaultId,
      accountId,
      epoch,
      cursor: '0',
      updatedAt: new Date().toISOString(),
    };
    await this.driver.transaction(['syncCursors'], 'readwrite', tx => tx.store('syncCursors').add(row));
    return row;
  }

  async advanceCursor(vaultId: VaultId, accountId: AccountId, epoch: string, next: CursorV2): Promise<SyncCursorRecordV2> {
    const nextValue = bigintCursor(next);
    return this.driver.transaction(['syncCursors'], 'readwrite', async tx => {
      const current = await tx.store('syncCursors').get<SyncCursorRecordV2 | LegacyCursorLike>(vaultId);
      if (!current) {
        if (nextValue !== 0n) throw new VaultError('PROTOCOL', 'A Protocol v2 cursor cannot skip initial remote history.');
        const initialized: SyncCursorRecordV2 = {
          protocolVersion: 2,
          vaultId,
          accountId,
          epoch,
          cursor: next,
          updatedAt: new Date().toISOString(),
        };
        await tx.store('syncCursors').add(initialized);
        return initialized;
      }
      if ((current as SyncCursorRecordV2).protocolVersion !== 2 || !(current as SyncCursorRecordV2).accountId) {
        throw new VaultError('PROTOCOL', 'Legacy Protocol v1 cursor cannot be advanced by Protocol v2.');
      }
      const v2 = current as SyncCursorRecordV2;
      if (v2.accountId !== accountId) throw new VaultError('ACCOUNT_MISMATCH', 'This Protocol v2 Vault cursor belongs to another AccountId.');
      if (v2.epoch !== epoch) throw new VaultError('PROTOCOL', 'The synchronization epoch changed. Resynchronization is required.');
      const currentValue = bigintCursor(v2.cursor);
      if (nextValue < currentValue) throw new VaultError('PROTOCOL', 'Protocol v2 synchronization cursor cannot move backwards.');
      if (nextValue === currentValue) return v2;
      const updated: SyncCursorRecordV2 = { ...v2, cursor: next, updatedAt: new Date().toISOString() };
      await tx.store('syncCursors').put(updated);
      return updated;
    });
  }

  async assertCanMigrateEmptyV1State(input: {
    vaultId: VaultId;
    legacyAuthUserId: string;
    accountId: AccountId;
    epoch: string;
  }): Promise<void> {
    const { vaultId, legacyAuthUserId, accountId, epoch } = input;
    await this.driver.transaction(['outbox', 'remoteShadows', 'syncCursors'], 'readonly', async tx => {
      const queued = await tx.store('outbox').allFromIndex<LegacyOutboxLike | SyncOutboxRecordV2>('vaultId', vaultId);
      if (queued.length) {
        throw new VaultError('PROTOCOL', 'Protocol v2 migration is blocked because this Vault has queued Protocol v1/v2 operations.');
      }
      const shadows = await tx.store('remoteShadows').getAll<LegacyShadowLike>();
      if (shadows.some(row => row.vaultId === vaultId)) {
        throw new VaultError('PROTOCOL', 'Protocol v2 migration is blocked because this Vault already has synchronized remote content.');
      }
      const existing = await tx.store('syncCursors').get<LegacyCursorLike | SyncCursorRecordV2>(vaultId);
      if (existing && (existing as SyncCursorRecordV2).protocolVersion === 2) {
        const v2 = existing as SyncCursorRecordV2;
        if (v2.accountId !== accountId) throw new VaultError('ACCOUNT_MISMATCH', 'Existing Protocol v2 cursor belongs to another AccountId.');
        if (v2.epoch !== epoch || v2.cursor !== '0') throw new VaultError('PROTOCOL', 'Existing Protocol v2 cursor is not an empty migration baseline.');
        return;
      }
      if (existing) {
        const legacy = existing as LegacyCursorLike;
        if (legacy.ownerId !== legacyAuthUserId) throw new VaultError('ACCOUNT_MISMATCH', 'Legacy Protocol v1 cursor belongs to another authenticated user.');
        if (legacy.epoch !== epoch) throw new VaultError('PROTOCOL', 'Legacy Protocol v1 cursor belongs to another synchronization epoch.');
        if (legacy.cursor !== '0') throw new VaultError('PROTOCOL', 'Protocol v2 migration requires a zero high-watermark Protocol v1 cursor.');
      }
    });
  }

  /**
   * Clean-break migration required by A9/I1. It is intentionally valid only for
   * a v1 Vault that never synchronized content: cursor zero, no sealed outbox
   * work, and no remote shadows. Existing v1 wire bytes are never rewritten.
   */
  async migrateEmptyV1State(input: {
    vaultId: VaultId;
    legacyAuthUserId: string;
    accountId: AccountId;
    epoch: string;
  }): Promise<SyncCursorRecordV2> {
    const { vaultId, legacyAuthUserId, accountId, epoch } = input;
    return this.driver.transaction(['outbox', 'remoteShadows', 'syncCursors'], 'readwrite', async tx => {
      const queued = await tx.store('outbox').allFromIndex<LegacyOutboxLike | SyncOutboxRecordV2>('vaultId', vaultId);
      if (queued.length) {
        throw new VaultError('PROTOCOL', 'Protocol v2 migration is blocked because this Vault has queued Protocol v1/v2 operations.');
      }

      const shadows = await tx.store('remoteShadows').getAll<LegacyShadowLike>();
      if (shadows.some(row => row.vaultId === vaultId)) {
        throw new VaultError('PROTOCOL', 'Protocol v2 migration is blocked because this Vault already has synchronized remote content.');
      }

      const existing = await tx.store('syncCursors').get<LegacyCursorLike | SyncCursorRecordV2>(vaultId);
      if (existing && (existing as SyncCursorRecordV2).protocolVersion === 2) {
        const v2 = existing as SyncCursorRecordV2;
        if (v2.accountId !== accountId) throw new VaultError('ACCOUNT_MISMATCH', 'Existing Protocol v2 cursor belongs to another AccountId.');
        if (v2.epoch !== epoch || v2.cursor !== '0') throw new VaultError('PROTOCOL', 'Existing Protocol v2 cursor is not an empty migration baseline.');
        return v2;
      }

      if (existing) {
        const legacy = existing as LegacyCursorLike;
        if (legacy.ownerId !== legacyAuthUserId) throw new VaultError('ACCOUNT_MISMATCH', 'Legacy Protocol v1 cursor belongs to another authenticated user.');
        if (legacy.epoch !== epoch) throw new VaultError('PROTOCOL', 'Legacy Protocol v1 cursor belongs to another synchronization epoch.');
        if (legacy.cursor !== '0') throw new VaultError('PROTOCOL', 'Protocol v2 migration requires a zero high-watermark Protocol v1 cursor.');
      }

      const migrated: SyncCursorRecordV2 = {
        protocolVersion: 2,
        vaultId,
        accountId,
        epoch,
        cursor: '0',
        updatedAt: new Date().toISOString(),
      };
      await tx.store('syncCursors').put(migrated);
      return migrated;
    });
  }
}
