import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_V2_VERSION,
  assertAccountV2,
  decodeOperationV2,
  sealOperationV2,
  validateOperationV2,
  validatePageV2,
} from '../build/core/sync/protocol-v2.js';
import { SyncLocalStateV2 } from '../build/core/sync/local-state-v2.js';
import {
  encryptedProtocolV2Status,
  validateSyncBackendCapabilities,
} from '../build/core/sync/capabilities.js';

class MemoryStore {
  constructor(data, name) { this.data = data; this.name = name; }
  key(value) {
    if (this.name === 'outbox') return value.id;
    if (this.name === 'syncCursors') return value.vaultId;
    if (this.name === 'remoteShadows') return value.entryId;
    return value.id ?? value.entryId ?? value.key;
  }
  async get(key) { return structuredClone(this.data.get(key)); }
  async getAll() { return [...this.data.values()].map(value => structuredClone(value)); }
  async fromIndex(index, key) {
    return structuredClone([...this.data.values()].find(value => value[index] === key));
  }
  async allFromIndex(index, key) {
    return [...this.data.values()].filter(value => value[index] === key).map(value => structuredClone(value));
  }
  async add(value) {
    const key = this.key(value);
    if (this.data.has(key)) throw new Error('duplicate ' + this.name);
    this.data.set(key, structuredClone(value));
  }
  async put(value) { this.data.set(this.key(value), structuredClone(value)); }
  async delete(key) { this.data.delete(key); }
}

class MemoryDriver {
  constructor() {
    this.stores = new Map(['outbox', 'syncCursors', 'remoteShadows'].map(name => [name, new Map()]));
  }
  async transaction(names, mode, body) {
    const working = new Map([...this.stores].map(([name, data]) => [
      name,
      mode === 'readwrite' && names.includes(name)
        ? new Map([...data].map(([key, value]) => [key, structuredClone(value)]))
        : data,
    ]));
    const result = await body({ store: name => new MemoryStore(working.get(name), name) });
    if (mode === 'readwrite') for (const name of names) this.stores.set(name, working.get(name));
    return result;
  }
}

const token = char => char.repeat(43);
const payload = () => ({
  encryptionVersion: 1,
  keyGeneration: 1,
  algorithm: 'A256GCM',
  nonce: 'AAAAAAAAAAAAAAAA',
  ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA',
});

function operation(overrides = {}) {
  const entityId = crypto.randomUUID();
  return {
    protocolVersion: PROTOCOL_V2_VERSION,
    operationId: crypto.randomUUID(),
    accountId: crypto.randomUUID(),
    vaultId: crypto.randomUUID(),
    deviceId: crypto.randomUUID(),
    mutations: [{
      kind: 'put',
      entityId,
      entityType: 'note',
      baseRemoteRevision: null,
      schemaVersion: 1,
      structural: {
        parentId: null,
        nameToken: token('A'),
        deleted: false,
        blobId: null,
      },
      payload: payload(),
    }],
    ...overrides,
  };
}

test('I1 Protocol v2 accepts only strict ciphertext-first entity mutations', async () => {
  const value = operation();
  validateOperationV2(value);
  const sealed = await sealOperationV2(value);
  assert.equal(decodeOperationV2(sealed.wire).accountId, value.accountId);
  assert.equal(sealed.protocolVersion, 2);
  assert.match(sealed.sha256, /^[0-9a-f]{64}$/u);

  const leaked = structuredClone(value);
  leaked.mutations[0].text = '# plaintext must never enter v2';
  assert.throws(() => validateOperationV2(leaked), /unsupported field: text/);

  const leakedName = structuredClone(value);
  leakedName.mutations[0].structural.name = 'Secret.md';
  assert.throws(() => validateOperationV2(leakedName), /unsupported field: name/);

  const leakedMime = structuredClone(value);
  leakedMime.mutations[0].payload.mimeType = 'text/plain';
  assert.throws(() => validateOperationV2(leakedMime), /unsupported field: mimeType/);
});

test('I1 Protocol v2 is AccountId-bound and sealed wire identity is immutable', async () => {
  const value = operation();
  const sealed = await sealOperationV2(value);
  assert.doesNotThrow(() => assertAccountV2(sealed, value.accountId));
  assert.throws(() => assertAccountV2(sealed, crypto.randomUUID()), /different Vault account/);

  const decoded = decodeOperationV2(sealed.wire);
  decoded.accountId = crypto.randomUUID();
  assert.notEqual(JSON.stringify(decoded), sealed.wire);
});

test('I1 Protocol v2 pages keep PostgreSQL bigint revisions/cursors as strings', () => {
  const value = operation();
  const epoch = crypto.randomUUID();
  const entity = value.mutations[0];
  const page = validatePageV2({
    protocolVersion: 2,
    vaultId: value.vaultId,
    epoch,
    after: '9223372036854775805',
    through: '9223372036854775806',
    highWatermark: '9223372036854775806',
    events: [{
      sequence: '9223372036854775806',
      operationId: value.operationId,
      entityId: entity.entityId,
      entityType: entity.entityType,
      remoteRevision: '9223372036854775807',
      kind: 'put',
    }],
  }, {
    vaultId: value.vaultId,
    epoch,
    after: '9223372036854775805',
  });
  assert.equal(page.events[0].remoteRevision, '9223372036854775807');

  assert.throws(() => validatePageV2({
    ...page,
    through: '9223372036854775807',
  }, {
    vaultId: value.vaultId,
    epoch,
    after: '9223372036854775805',
  }), /would skip changes/);
});

test('I1 local Protocol v2 outbox is immutable and account-bound', async () => {
  const driver = new MemoryDriver();
  const state = new SyncLocalStateV2(driver);
  const value = operation();
  const sealed = await sealOperationV2(value);

  const first = await state.enqueue(sealed);
  const second = await state.enqueue(sealed);
  assert.equal(first.sha256, second.sha256);
  assert.equal(await state.count(value.vaultId, value.accountId), 1);
  await state.assertPendingAccounts(value.vaultId, value.accountId);
  await assert.rejects(() => state.assertPendingAccounts(value.vaultId, crypto.randomUUID()), /different Vault account/);

  await state.acknowledge(value.operationId);
  assert.equal(await state.count(value.vaultId, value.accountId), 0);
});

test('I1 clean-break migration rewrites only empty cursor identity, never v1 wire/history', async () => {
  const driver = new MemoryDriver();
  const state = new SyncLocalStateV2(driver);
  const vaultId = crypto.randomUUID();
  const authUserId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const epoch = crypto.randomUUID();

  driver.stores.get('syncCursors').set(vaultId, {
    vaultId,
    ownerId: authUserId,
    epoch,
    cursor: '0',
    updatedAt: new Date().toISOString(),
  });

  const migrated = await state.migrateEmptyV1State({
    vaultId,
    legacyAuthUserId: authUserId,
    accountId,
    epoch,
  });
  assert.equal(migrated.protocolVersion, 2);
  assert.equal(migrated.accountId, accountId);
  assert.equal(migrated.cursor, '0');
  assert.equal('ownerId' in driver.stores.get('syncCursors').get(vaultId), false);

  const blockedDriver = new MemoryDriver();
  blockedDriver.stores.get('syncCursors').set(vaultId, {
    vaultId,
    ownerId: authUserId,
    epoch,
    cursor: '1',
    updatedAt: new Date().toISOString(),
  });
  await assert.rejects(() => new SyncLocalStateV2(blockedDriver).migrateEmptyV1State({
    vaultId,
    legacyAuthUserId: authUserId,
    accountId,
    epoch,
  }), /zero high-watermark/);
});

test('I1 migration refuses queued v1 bytes or existing remote shadows', async () => {
  const vaultId = crypto.randomUUID();
  const authUserId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const epoch = crypto.randomUUID();

  const withOutbox = new MemoryDriver();
  withOutbox.stores.get('outbox').set(crypto.randomUUID(), {
    id: crypto.randomUUID(),
    vaultId,
    ownerId: authUserId,
    wire: '{"protocolVersion":1}',
  });
  await assert.rejects(() => new SyncLocalStateV2(withOutbox).migrateEmptyV1State({
    vaultId,
    legacyAuthUserId: authUserId,
    accountId,
    epoch,
  }), /queued Protocol v1\/v2 operations/);

  const withShadow = new MemoryDriver();
  withShadow.stores.get('remoteShadows').set(crypto.randomUUID(), {
    entryId: crypto.randomUUID(),
    vaultId,
    ownerId: authUserId,
  });
  await assert.rejects(() => new SyncLocalStateV2(withShadow).migrateEmptyV1State({
    vaultId,
    legacyAuthUserId: authUserId,
    accountId,
    epoch,
  }), /already has synchronized remote content/);
});

test('I1 backend negotiation keeps encrypted content disabled until later prerequisites exist', () => {
  const capabilities = validateSyncBackendCapabilities({
    contractVersion: 1,
    protocolVersions: [1, 2],
    encryptedContentV2: {
      contractAvailable: true,
      acceptingContent: false,
    },
    maxMutations: 1000,
    maxPageEvents: 1000,
  });
  assert.deepEqual(encryptedProtocolV2Status(capabilities, {
    cryptoSuiteReady: false,
    deviceKeysReady: false,
    encryptedRemoteStateReady: false,
  }), {
    ready: false,
    reason: 'Backend Protocol v2 content ingestion is not enabled yet.',
  });

  const readyCapabilities = {
    ...capabilities,
    encryptedContentV2: {
      contractAvailable: true,
      acceptingContent: true,
    },
  };
  assert.equal(encryptedProtocolV2Status(readyCapabilities, {
    cryptoSuiteReady: true,
    deviceKeysReady: true,
    encryptedRemoteStateReady: true,
  }).ready, true);
});
