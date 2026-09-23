import test from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_VERSION, STORES } from '../build/core/storage/database.js';
import { sha256Hex } from '../build/core/storage/blob-store.js';
import { readZipStore, zipStore } from '../build/core/services/export.js';
import {
  ensureTaskIdentityMarkers,
  parseTaskLine,
  taskIdentityFromRaw,
  updateTaskMarkdown,
} from '../build/core/tasks/markdown.js';
import {
  fullVaultArchiveFiles,
  parseFullVaultArchiveFiles,
  validateFullVaultArchiveFiles,
} from '../build/core/services/a2-archive.js';

const ids = [
  '019c0000-0000-7000-8000-000000000001',
  '019c0000-0000-7000-8000-000000000002',
  '019c0000-0000-7000-8000-000000000003',
  '019c0000-0000-7000-8000-000000000004',
];

test('A2 schema adds canonical entity, note-body, blob, migration and background-replication stores', () => {
  assert.equal(SCHEMA_VERSION, 5);
  for (const store of ['entities','noteBodies','blobPayloads','migrationState','backgroundRuntime','remoteInbox']) {
    assert.ok(STORES.includes(store), store);
  }
});

test('A2 task adoption adds stable hidden IDs only to real Markdown tasks', () => {
  let index = 0;
  const source = [
    '- [ ] First',
    '~~~md',
    '- [ ] ignored',
    '~~~',
    '- [ ] Last',
  ].join('\n');

  const completeOnly = ensureTaskIdentityMarkers(source, {
    completeLinesOnly: true,
    idFactory: () => ids[index++],
  });
  assert.match(completeOnly.text.split('\n')[0], /vault:task=019c0000-0000-7000-8000-000000000001/u);
  assert.equal(completeOnly.text.includes('ignored <!--'), false);
  assert.equal(completeOnly.text.split('\n').at(-1), '- [ ] Last');

  const finalized = ensureTaskIdentityMarkers(completeOnly.text, {
    idFactory: () => ids[index++],
  });
  assert.match(finalized.text.split('\n').at(-1), /vault:task=019c0000-0000-7000-8000-000000000002/u);

  const parsed = parseTaskLine(finalized.text.split('\n')[0]);
  assert.ok(parsed);
  assert.equal(parsed.text, 'First');
  assert.equal(taskIdentityFromRaw(parsed.raw), ids[0]);
});

test('A2 recurring tasks preserve completed identity and allocate a new next-occurrence identity', () => {
  const source = '- [ ] Review @due(2026-09-22) @repeat(weekly) <!-- vault:task=' + ids[0] + ' -->\n';
  const parsed = parseTaskLine(source.trimEnd(), 0);
  assert.ok(parsed);
  const mutation = updateTaskMarkdown(source, parsed, { completed: true }, new Date(2026, 8, 22, 12));
  const lines = mutation.text.trimEnd().split('\n');
  assert.equal(taskIdentityFromRaw(lines[0]), ids[0]);
  const nextId = taskIdentityFromRaw(lines[1]);
  assert.ok(nextId);
  assert.notEqual(nextId, ids[0]);
  assert.match(nextId, /^[0-9a-f]{8}-[0-9a-f]{4}-7/u);
});

test('A2 rekey operation does not clone task identity', () => {
  let index = 1;
  const source = '- [ ] One <!-- vault:task=' + ids[0] + ' -->\n- [ ] Two\n';
  const result = ensureTaskIdentityMarkers(source, { rekey: true, idFactory: () => ids[index++] });
  assert.equal(result.changed, true);
  const lines = result.text.trimEnd().split('\n');
  assert.equal(taskIdentityFromRaw(lines[0]), ids[1]);
  assert.equal(taskIdentityFromRaw(lines[1]), ids[2]);
  assert.notEqual(taskIdentityFromRaw(lines[0]), ids[0]);
});

test('A2 SHA-256 content addressing is deterministic', async () => {
  assert.equal(
    await sha256Hex(new Uint8Array()),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

test('A2 full archive includes stable metadata and validates checksums', async () => {
  const vaultId = '11111111-1111-4111-8111-111111111111';
  const noteId = '22222222-2222-4222-8222-222222222222';
  const now = '2026-09-22T02:00:00.000Z';
  const snapshot = {
    format: 'vault-local-backup',
    version: 2,
    exportedAt: now,
    vault: { id:vaultId, name:'Archive', createdAt:now, updatedAt:now, mode:'local' },
    entries: [{
      id:noteId, vaultId, parentId:null, name:'Note.md', kind:'markdown',
      createdAt:now, updatedAt:now, localVersion:1, deletedAt:null,
      deletionBatch:null, activeKey:vaultId + '/root/note.md',
    }],
    contents: [{ entryId:noteId, text:'# Exact\n', localVersion:1 }],
    attachments: [],
    recoveryDrafts: [],
    revisions: [],
  };
  const entities = [{
    id:vaultId, entityType:'vault', name:'Archive', schemaVersion:1, revision:1,
    createdAt:now, updatedAt:now, deletedAt:null, properties:{},
  }, {
    id:noteId, entityType:'note', vaultId, title:'Note', folderId:null, aliases:[],
    noteKind:'standard', schemaVersion:1, revision:1, createdAt:now, updatedAt:now,
    deletedAt:null, properties:{}, bodyStore:'noteBodies',
  }];
  const bodies = [{ noteId, vaultId, revision:1, text:'# Exact\n' }];

  const files = await fullVaultArchiveFiles(snapshot, entities, bodies);
  assert.ok(files.some(file => file.path === 'Note.md'));
  assert.ok(files.some(file => file.path === '.vault/manifest.json'));
  assert.ok(files.some(file => file.path === '.vault/entities.json'));
  assert.ok(files.some(file => file.path === '.vault/checksums.json'));
  await assert.doesNotReject(() => validateFullVaultArchiveFiles(files));

  const note = files.find(file => file.path === 'Note.md');
  assert.ok(note);
  note.bytes = new TextEncoder().encode('# Tampered\n');
  await assert.rejects(() => validateFullVaultArchiveFiles(files), /checksum mismatch/u);
});


test('A2 cross-note task identity collisions are rekeyed instead of aliasing one TaskEntity', () => {
  const shared = ids[0];
  const replacement = ids[1];
  const used = new Set([shared]);
  const source = '- [ ] Pasted task <!-- vault:task=' + shared + ' -->\n';
  const reconciled = ensureTaskIdentityMarkers(source, {
    usedIds: used,
    idFactory: () => replacement,
  });
  assert.equal(reconciled.changed, true);
  assert.equal(taskIdentityFromRaw(reconciled.text.trimEnd()), replacement);
  assert.equal(used.has(shared), true);
  assert.equal(used.has(replacement), true);
});


test('A2 archive v2 round-trips deleted attachment payloads through its verified ZIP subset', async () => {
  const vaultId = '11111111-1111-4111-8111-111111111111';
  const attachmentId = '33333333-3333-4333-8333-333333333333';
  const now = '2026-09-22T02:00:00.000Z';
  const bytes = Uint8Array.from([7, 8, 9, 255]);
  const dataBase64 = Buffer.from(bytes).toString('base64');
  const checksumSha256 = await sha256Hex(bytes);

  const snapshot = {
    format: 'vault-local-backup',
    version: 2,
    exportedAt: now,
    vault: { id:vaultId, name:'Deleted media', createdAt:now, updatedAt:now, mode:'local' },
    entries: [{
      id:attachmentId, vaultId, parentId:null, name:'old.bin', kind:'attachment',
      createdAt:now, updatedAt:now, localVersion:2, deletedAt:now,
      deletionBatch:'batch', 
    }],
    contents: [],
    attachments: [{ entryId:attachmentId, mimeType:'application/octet-stream', size:bytes.length, dataBase64 }],
    recoveryDrafts: [],
    revisions: [],
  };
  const entities = [{
    id:vaultId, entityType:'vault', name:'Deleted media', schemaVersion:1, revision:1,
    createdAt:now, updatedAt:now, deletedAt:null, properties:{},
  }, {
    id:attachmentId, entityType:'attachment', vaultId, filename:'old.bin',
    mediaType:'application/octet-stream', size:bytes.length, checksumSha256,
    originalFilename:null, width:null, height:null, durationSeconds:null,
    schemaVersion:1, revision:2, createdAt:now, updatedAt:now, deletedAt:now, properties:{},
  }];
  const files = await fullVaultArchiveFiles(snapshot, entities, []);
  assert.ok(files.some(file => file.path === '.vault/state.json'));
  assert.ok(files.some(file => file.path === '.vault/deleted-attachments/' + attachmentId + '.bin'));

  const zip = zipStore(files);
  const unpacked = readZipStore(zip);
  const parsed = await parseFullVaultArchiveFiles(unpacked);
  assert.equal(parsed.manifest.version, 2);
  assert.equal(parsed.attachments.length, 1);
  assert.deepEqual([...parsed.attachments[0].bytes], [...bytes]);
  assert.equal(parsed.state.entries[0].deletedAt, now);
});


test('A2 archive restore rejects a checksummed cyclic folder tree before restore', async () => {
  const vaultId = '11111111-1111-4111-8111-111111111111';
  const folderId = '44444444-4444-4444-8444-444444444444';
  const now = '2026-09-22T02:00:00.000Z';
  const snapshot = {
    format: 'vault-local-backup',
    version: 2,
    exportedAt: now,
    vault: { id:vaultId, name:'Cycle', createdAt:now, updatedAt:now, mode:'local' },
    entries: [{
      id:folderId, vaultId, parentId:null, name:'Folder', kind:'directory',
      createdAt:now, updatedAt:now, localVersion:1, deletedAt:null,
      deletionBatch:null, activeKey:vaultId + '/root/folder',
    }],
    contents: [],
    attachments: [],
    recoveryDrafts: [],
    revisions: [],
  };
  const entities = [{
    id:vaultId, entityType:'vault', name:'Cycle', schemaVersion:1, revision:1,
    createdAt:now, updatedAt:now, deletedAt:null, properties:{},
  }, {
    id:folderId, entityType:'folder', vaultId, name:'Folder', parentFolderId:null,
    schemaVersion:1, revision:1, createdAt:now, updatedAt:now,
    deletedAt:null, properties:{},
  }];

  const files = await fullVaultArchiveFiles(snapshot, entities, []);
  const stateFile = files.find(file => file.path === '.vault/state.json');
  const checksumsFile = files.find(file => file.path === '.vault/checksums.json');
  assert.ok(stateFile);
  assert.ok(checksumsFile);

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state = JSON.parse(decoder.decode(stateFile.bytes));
  state.entries[0].parentId = folderId;
  stateFile.bytes = encoder.encode(JSON.stringify(state, null, 2));

  const checksums = JSON.parse(decoder.decode(checksumsFile.bytes));
  checksums['.vault/state.json'] = await sha256Hex(stateFile.bytes);
  checksumsFile.bytes = encoder.encode(JSON.stringify(checksums, null, 2));

  await assert.rejects(
    () => parseFullVaultArchiveFiles(files),
    error => error?.code === 'CYCLE' || /cyclic|cycle/iu.test(error?.message ?? ''),
  );
});
