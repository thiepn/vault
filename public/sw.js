const BACKGROUND_DB = 'vault:local';
const BACKGROUND_SCHEMA = 7;
const BACKGROUND_TAG = 'vault-background-sync';
const PERIODIC_TAG = 'vault-periodic-sync';

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
  });
}

async function openBackgroundDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BACKGROUND_DB, BACKGROUND_SCHEMA);
    request.onerror = () => reject(request.error ?? new Error('Vault background database could not be opened.'));
    request.onupgradeneeded = event => {
      const database = request.result;
      if (event.oldVersion === 0) {
        request.transaction?.abort();
        return;
      }
      if (event.oldVersion < 5) {
        if (!database.objectStoreNames.contains('backgroundRuntime')) {
          database.createObjectStore('backgroundRuntime', { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains('remoteInbox')) {
          const inbox = database.createObjectStore('remoteInbox', { keyPath: 'id' });
          inbox.createIndex('vaultId', 'vaultId');
          inbox.createIndex('vaultSequence', ['vaultId', 'sequence'], { unique: true });
        }
      }
      if (event.oldVersion < 6 && !database.objectStoreNames.contains('conflicts')) {
        const conflicts = database.createObjectStore('conflicts', { keyPath: 'id' });
        conflicts.createIndex('vaultId', 'vaultId');
        conflicts.createIndex('entryId', 'entryId');
        conflicts.createIndex('conflictEntryId', 'conflictEntryId');
      }
      if (event.oldVersion < 7) {
        if (!database.objectStoreNames.contains('crdtSessions')) {
          const sessions = database.createObjectStore('crdtSessions', { keyPath: 'id' });
          sessions.createIndex('vaultId', 'vaultId');
          sessions.createIndex('entryId', 'entryId');
          sessions.createIndex('roomKey', 'roomKey');
          sessions.createIndex('updatedAt', 'updatedAt');
        }
        if (!database.objectStoreNames.contains('crdtUpdates')) {
          const updates = database.createObjectStore('crdtUpdates', { keyPath: 'id' });
          updates.createIndex('vaultId', 'vaultId');
          updates.createIndex('entryId', 'entryId');
          updates.createIndex('roomKey', 'roomKey');
          updates.createIndex('sessionId', 'sessionId');
          updates.createIndex('createdAt', 'createdAt');
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function readOne(database, storeName, key) {
  const transaction = database.transaction(storeName, 'readonly');
  return idbRequest(transaction.objectStore(storeName).get(key));
}

async function readAll(database, storeName) {
  const transaction = database.transaction(storeName, 'readonly');
  return idbRequest(transaction.objectStore(storeName).getAll());
}

async function readAllByIndex(database, storeName, indexName, key) {
  const transaction = database.transaction(storeName, 'readonly');
  return idbRequest(transaction.objectStore(storeName).index(indexName).getAll(key));
}

async function putOne(database, storeName, value) {
  const transaction = database.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).put(value);
  await transactionDone(transaction);
}

async function deleteOne(database, storeName, key) {
  const transaction = database.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).delete(key);
  await transactionDone(transaction);
}

function workerError(error) {
  return error instanceof Error ? error.message : String(error ?? 'Background replication failed.');
}

function validUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function validCursor(value) {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value) && BigInt(value) <= 9223372036854775807n;
}

function jsonHeaders(runtime, accessToken) {
  return {
    apikey: runtime.config.publishableKey,
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
}

async function responseJson(response) {
  try { return await response.json(); } catch { return null; }
}

async function freshWorkerSession(database, runtime) {
  const session = runtime?.session;
  if (!session?.accessToken || !session?.refreshToken || !Number.isFinite(session.expiresAt)) {
    throw new Error('Background replication has no valid signed-in session.');
  }
  if (session.expiresAt > Math.floor(Date.now() / 1000) + 60) return runtime;

  let response;
  try {
    response = await fetch(`${runtime.config.url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        apikey: runtime.config.publishableKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    });
  } catch (error) {
    throw new Error(`Background token refresh could not reach the server: ${workerError(error)}`);
  }
  const payload = await responseJson(response);
  if (!response.ok) {
    if (response.status === 400 || response.status === 401) {
      await deleteOne(database, 'backgroundRuntime', 'runtime');
      throw new Error('Background session expired. Open Vault and sign in again.');
    }
    throw new Error('Background token refresh failed temporarily.');
  }
  if (!payload || typeof payload.access_token !== 'string' || typeof payload.refresh_token !== 'string') {
    throw new Error('Background token refresh returned an invalid session.');
  }
  const expiresAt = typeof payload.expires_at === 'number'
    ? payload.expires_at
    : Math.floor(Date.now() / 1000) + (typeof payload.expires_in === 'number' ? payload.expires_in : 3600);
  const updated = {
    ...runtime,
    session: {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt,
    },
    updatedAt: new Date().toISOString(),
  };
  await putOne(database, 'backgroundRuntime', updated);
  return updated;
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
}

function attachmentBytes(record) {
  const value = record?.bytes;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

async function uploadAttachmentIfNeeded(database, runtime, vault, operation, mutation) {
  if (mutation.kind !== 'create' || mutation.entryKind !== 'attachment' || !mutation.attachment) return;
  const attachment = await readOne(database, 'attachments', mutation.entryId);
  const bytes = attachmentBytes(attachment);
  if (!bytes || bytes.byteLength !== mutation.attachment.size) {
    throw new Error('Background attachment bytes are unavailable; foreground sync is required.');
  }
  if (await sha256Hex(bytes) !== mutation.attachment.sha256) {
    throw new Error('Background attachment bytes do not match the sealed operation.');
  }
  const ownerUserId = vault.cloud.ownerAuthUserId ?? vault.cloud.authUserId;
  const path = [ownerUserId, vault.id, mutation.attachment.sha256].map(encodeURIComponent).join('/');
  const target = `${runtime.config.url}/storage/v1/object/vault-sync/${path}`;
  const response = await fetch(target, {
    method: 'POST',
    headers: {
      apikey: runtime.config.publishableKey,
      Authorization: `Bearer ${runtime.session.accessToken}`,
      'Content-Type': mutation.attachment.mimeType || 'application/octet-stream',
    },
    body: new Blob([bytes], { type: mutation.attachment.mimeType || 'application/octet-stream' }),
  });
  if (response.ok) return;
  if (response.status === 400 || response.status === 409) {
    const existing = await fetch(target, {
      headers: {
        apikey: runtime.config.publishableKey,
        Authorization: `Bearer ${runtime.session.accessToken}`,
      },
    });
    if (existing.ok) {
      const existingBytes = new Uint8Array(await existing.arrayBuffer());
      if (existingBytes.byteLength === bytes.byteLength && await sha256Hex(existingBytes) === mutation.attachment.sha256) return;
    }
  }
  throw new Error(`Background attachment upload failed with HTTP ${response.status}.`);
}

function parseSealedOperation(row, vault, userId) {
  if (!row || !validUuid(row.id) || row.vaultId !== vault.id || row.ownerId !== userId
    || typeof row.wire !== 'string' || !/^[0-9a-f]{64}$/u.test(row.sha256)) {
    throw new Error('Invalid sealed background operation.');
  }
  const operation = JSON.parse(row.wire);
  if (operation.protocolVersion !== 1 || operation.id !== row.id || operation.vaultId !== vault.id
    || operation.ownerId !== userId || operation.deviceId !== vault.cloud.deviceId
    || !Array.isArray(operation.mutations) || operation.mutations.length < 1) {
    throw new Error('Background operation envelope does not match its sealed row.');
  }
  return operation;
}

async function pushPendingOperations(database, runtime, vault, stagedOperationIds) {
  const rows = await readAllByIndex(database, 'outbox', 'vaultId', vault.id);
  let pushed = 0;
  for (const row of rows) {
    if (row.ownerId !== runtime.authUserId || stagedOperationIds.has(row.id)) continue;
    if (!Number.isFinite(Date.parse(row.nextAttemptAt)) || Date.parse(row.nextAttemptAt) > Date.now()) continue;
    const operation = parseSealedOperation(row, vault, runtime.authUserId);
    for (const mutation of operation.mutations) {
      await uploadAttachmentIfNeeded(database, runtime, vault, operation, mutation);
    }
    const response = await fetch(`${runtime.config.url}/rest/v1/rpc/vault_sync_push`, {
      method: 'POST',
      headers: jsonHeaders(runtime, runtime.session.accessToken),
      body: JSON.stringify({ p_wire: operation, p_sha256: row.sha256 }),
    });
    if (response.status === 409) {
      throw new Error('Background push found a canonical conflict; open Vault to reconcile it safely.');
    }
    if (!response.ok) {
      throw new Error(`Background push failed with HTTP ${response.status}.`);
    }
    const result = await responseJson(response);
    if (!result || result.status !== 'ok' || result.operationId !== row.id) {
      throw new Error('Background push returned an invalid acknowledgement.');
    }
    pushed++;
  }
  return pushed;
}

function stagedCursor(appliedCursor, rows) {
  let current = BigInt(appliedCursor);
  const sorted = rows
    .filter(row => validCursor(row.sequence))
    .sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : BigInt(a.sequence) > BigInt(b.sequence) ? 1 : 0);
  for (const row of sorted) {
    const sequence = BigInt(row.sequence);
    if (sequence <= current) continue;
    if (sequence !== current + 1n) break;
    current = sequence;
  }
  return current.toString();
}

function validateRemoteEvent(event, vaultId, expectedSequence) {
  return !!event
    && validCursor(event.sequence)
    && event.sequence === expectedSequence
    && validUuid(event.operationId)
    && validUuid(event.entryId)
    && validUuid(event.deviceId)
    && ['create', 'write', 'move', 'trash', 'restore'].includes(event.kind)
    && event.snapshot
    && event.snapshot.entryId === event.entryId
    && event.snapshot.vaultId === vaultId
    && Number.isSafeInteger(event.snapshot.revision)
    && event.snapshot.revision >= 1;
}

async function stageRemotePull(database, runtime, vault) {
  const cursor = await readOne(database, 'syncCursors', vault.id);
  if (!cursor || cursor.ownerId !== runtime.authUserId || cursor.epoch !== vault.cloud.epoch || !validCursor(cursor.cursor)) {
    throw new Error('Background pull requires an initialized foreground synchronization cursor.');
  }
  const existing = (await readAllByIndex(database, 'remoteInbox', 'vaultId', vault.id))
    .filter(row => row.ownerId === runtime.authUserId && row.epoch === vault.cloud.epoch);
  let current = stagedCursor(cursor.cursor, existing);
  let staged = 0;

  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    const response = await fetch(`${runtime.config.url}/rest/v1/rpc/vault_sync_pull`, {
      method: 'POST',
      headers: jsonHeaders(runtime, runtime.session.accessToken),
      body: JSON.stringify({
        p_vault_id: vault.id,
        p_epoch: vault.cloud.epoch,
        p_after: current,
        p_limit: 500,
      }),
    });
    if (!response.ok) throw new Error(`Background pull failed with HTTP ${response.status}.`);
    const page = await responseJson(response);
    if (!page || page.protocolVersion !== 1 || page.vaultId !== vault.id || page.epoch !== vault.cloud.epoch
      || page.after !== current || !validCursor(page.through) || !validCursor(page.highWatermark)
      || !Array.isArray(page.events) || page.events.length > 500) {
      throw new Error('Background pull returned an invalid page.');
    }
    let expected = BigInt(current);
    for (const event of page.events) {
      expected++;
      if (!validateRemoteEvent(event, vault.id, expected.toString())) {
        throw new Error('Background pull returned an invalid event.');
      }
      await putOne(database, 'remoteInbox', {
        id: `${vault.id}:${event.sequence}`,
        vaultId: vault.id,
        ownerId: runtime.authUserId,
        epoch: vault.cloud.epoch,
        sequence: event.sequence,
        event,
        stagedAt: new Date().toISOString(),
      });
      staged++;
      current = event.sequence;
    }
    if (page.through !== current) throw new Error('Background pull page cursor is inconsistent.');
    if (current === page.highWatermark) return staged;
    if (!page.events.length) throw new Error('Background pull made no progress.');
  }
  throw new Error('Background pull exceeded its page safety limit.');
}

async function stagedOperationIds(database, runtime, vault) {
  const rows = await readAllByIndex(database, 'remoteInbox', 'vaultId', vault.id);
  return new Set(rows
    .filter(row => row.ownerId === runtime.authUserId && row.epoch === vault.cloud.epoch)
    .map(row => row.event?.operationId)
    .filter(validUuid));
}

async function writeBackgroundStatus(database, previous, patch) {
  const next = {
    id: 'status',
    capability: previous?.capability === 'unsupported' ? 'unsupported' : 'registered',
    lastAttemptAt: previous?.lastAttemptAt ?? null,
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    lastError: previous?.lastError ?? null,
    stagedEvents: previous?.stagedEvents ?? 0,
    pushedOperations: previous?.pushedOperations ?? 0,
    updatedAt: new Date().toISOString(),
    ...patch,
  };
  await putOne(database, 'backgroundRuntime', next);
  return next;
}

async function notifyVaultClients(message) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) client.postMessage(message);
}

async function runBackgroundReplication() {
  let database;
  try {
    database = await openBackgroundDatabase();
    let runtime = await readOne(database, 'backgroundRuntime', 'runtime');
    if (!runtime) return { ok: false, skipped: true, reason: 'signed-out' };
    if (!runtime.config?.url || !runtime.config?.publishableKey || !validUuid(runtime.authUserId)) {
      throw new Error('Background runtime configuration is invalid.');
    }
    runtime = await freshWorkerSession(database, runtime);
    const previousStatus = await readOne(database, 'backgroundRuntime', 'status');
    await writeBackgroundStatus(database, previousStatus, {
      lastAttemptAt: new Date().toISOString(),
      lastError: null,
    });

    const vaults = (await readAll(database, 'vaults')).filter(vault => {
      const role = vault?.cloud?.accessRole ?? 'owner';
      return vault?.mode === 'cloud'
        && vault.cloud?.authUserId === runtime.authUserId
        && (role === 'owner' || role === 'editor');
    });

    let pushedOperations = 0;
    let stagedEvents = 0;
    for (const vault of vaults) {
      const stagedIds = await stagedOperationIds(database, runtime, vault);
      pushedOperations += await pushPendingOperations(database, runtime, vault, stagedIds);
      stagedEvents += await stageRemotePull(database, runtime, vault);
    }

    const status = await writeBackgroundStatus(database, await readOne(database, 'backgroundRuntime', 'status'), {
      lastSuccessAt: new Date().toISOString(),
      lastError: null,
      stagedEvents,
      pushedOperations,
    });
    await notifyVaultClients({ type: 'BACKGROUND_SYNC_COMPLETE', status });
    return { ok: true, pushedOperations, stagedEvents };
  } catch (error) {
    const message = workerError(error);
    if (database) {
      const previous = await readOne(database, 'backgroundRuntime', 'status').catch(() => null);
      await writeBackgroundStatus(database, previous, {
        lastAttemptAt: new Date().toISOString(),
        lastError: message,
      }).catch(() => undefined);
    }
    await notifyVaultClients({ type: 'BACKGROUND_SYNC_ERROR', message });
    return { ok: false, error: message };
  } finally {
    database?.close();
  }
}

const CACHE = 'vault-shell-a2-v3';

async function cacheDocumentShell(cache, root) {
  const response = await fetch(root, { cache: 'reload' });
  if (!response.ok) throw new Error('Could not fetch Vault shell.');
  await cache.put(root, response.clone());
  const html = await response.text();
  const urls = new Set([root]);
  for (const match of html.matchAll(/(?:src|href)=["']([^"'#]+)["']/giu)) {
    try {
      const url = new URL(match[1], root);
      if (url.origin === self.location.origin) urls.add(url.href);
    } catch {
      // Ignore malformed/non-network references.
    }
  }
  await Promise.all([...urls].filter(url => url !== root).map(url => cache.add(url)));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const root = new URL('./', self.registration.scope).href;
    await cacheDocumentShell(cache, root);
    await Promise.allSettled([
      cache.add(new URL('manifest.webmanifest', root).href),
      cache.add(new URL('icon.svg', root).href),
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE && key.startsWith('vault-shell-')) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'RUN_BACKGROUND_SYNC') {
    event.waitUntil(runBackgroundReplication().then(result => {
      event.ports?.[0]?.postMessage(result);
    }));
    return;
  }
  if (event.data?.type !== 'CACHE_URLS' || !Array.isArray(event.data.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const urls = event.data.urls
      .filter(value => typeof value === 'string')
      .filter(value => {
        try { return new URL(value).origin === self.location.origin; } catch { return false; }
      });
    const results = await Promise.allSettled(urls.map(url => cache.add(url)));
    const failed = results.filter(result => result.status === 'rejected').length;
    event.ports?.[0]?.postMessage({ type: 'CACHE_URLS_DONE', failed });
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        if (response.ok) await (await caches.open(CACHE)).put(event.request, response.clone());
        return response;
      } catch {
        const cached = await caches.match(event.request, { ignoreVary: true })
          ?? await caches.match(new URL('./', self.registration.scope).href, { ignoreVary: true });
        return cached ?? new Response('Vault is offline and its application shell has not been cached yet.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(event.request, { ignoreVary: true });
    if (cached) {
      event.waitUntil(fetch(event.request).then(async response => {
        if (response.ok) await (await caches.open(CACHE)).put(event.request, response.clone());
      }).catch(() => undefined));
      return cached;
    }
    const response = await fetch(event.request);
    if (response.ok) await (await caches.open(CACHE)).put(event.request, response.clone());
    return response;
  })());
});

self.addEventListener('sync', event => {
  if (event.tag !== BACKGROUND_TAG) return;
  event.waitUntil(runBackgroundReplication());
});

self.addEventListener('periodicsync', event => {
  if (event.tag !== PERIODIC_TAG) return;
  event.waitUntil(runBackgroundReplication());
});
