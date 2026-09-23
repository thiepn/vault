import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalRepository } from '../build/core/storage/local-repository.js';
import { vaultFiles } from '../build/core/services/export.js';
import { parseKnowledge } from '../build/core/knowledge/parser.js';
import {
  attachmentMediaKind,
  attachmentReferenceCounts,
  canonicalAttachmentTarget,
  normalizeAttachmentMimeType,
  resolveAttachmentTarget,
  validateAttachmentName,
} from '../build/core/media/attachments.js';
import { rewriteAttachmentReferences } from '../build/core/media/link-updater.js';
import { compareEntries } from '../build/core/services/file-tree.js';

const clone = value => value === undefined ? undefined : structuredClone(value);

class MemoryStore {
  constructor(data, name) { this.data = data; this.name = name; }
  async get(key) { return clone(this.data.get(key)); }
  async getAll() { return [...this.data.values()].map(clone); }
  async fromIndex(index, key) {
    for (const value of this.data.values()) if (value[index] === key) return clone(value);
    return undefined;
  }
  async allFromIndex(index, key) {
    return [...this.data.values()].filter(value => value[index] === key).map(clone);
  }
  async add(value) {
    const key = this.#key(value);
    if (this.data.has(key)) throw new Error('duplicate key');
    this.#assertUnique(value, key);
    this.data.set(key, clone(value));
  }
  async put(value) {
    const key = this.#key(value);
    this.#assertUnique(value, key);
    this.data.set(key, clone(value));
  }
  #key(value) {
    if (this.name === 'vaults') return value.id;
    if (this.name === 'entries') return value.id;
    if (this.name === 'contents' || this.name === 'attachments') return value.entryId;
    if (this.name === 'dirty') return value.entryId;
    if (this.name === 'revisions' || this.name === 'drafts' || this.name === 'outbox') return value.id;
    if (this.name === 'settings') return value.key;
    if (this.name === 'remoteShadows') return value.entryId;
    if (this.name === 'syncCursors') return value.vaultId;
    if (this.name === 'knowledge') return value.entryId;
    if (this.name === 'conflicts') return value.id;
    throw new Error('unknown store ' + this.name);
  }
  #assertUnique(value, key) {
    if (this.name !== 'entries' || value.activeKey === undefined) return;
    for (const [existingKey, existing] of this.data) {
      if (existingKey !== key && existing.activeKey === value.activeKey) throw new Error('unique activeKey');
    }
  }
}

class MemoryDriver {
  stores = new Map();
  constructor() {
    for (const name of ['vaults','entries','contents','attachments','dirty','outbox','revisions','drafts','settings','remoteShadows','syncCursors','knowledge','conflicts']) {
      this.stores.set(name, new Map());
    }
  }
  async transaction(names, mode, body) {
    const working = new Map();
    for (const [name, data] of this.stores) {
      working.set(name, mode === 'readwrite' && names.includes(name) ? new Map([...data].map(([key,value]) => [key, clone(value)])) : data);
    }
    const result = await body({ store: name => new MemoryStore(working.get(name), name) });
    if (mode === 'readwrite') for (const name of names) this.stores.set(name, working.get(name));
    return result;
  }
}

async function fixture() {
  const repository = new LocalRepository(new MemoryDriver());
  const vault = await repository.createVault('Media');
  return { repository, vault };
}

test('attachment filenames stay portable and Wiki-reference safe', () => {
  assert.equal(validateAttachmentName('photo 1.png'), 'photo 1.png');
  assert.throws(() => validateAttachmentName('broken#name.png'), /reserved by Wiki-link syntax/u);
  assert.throws(() => validateAttachmentName('broken[name].png'), /reserved by Wiki-link syntax/u);
  assert.throws(() => validateAttachmentName('note.md'), /notes, not attachments/u);
});

test('Phase 9 stores binary attachments separately from Markdown and reads exact bytes', async () => {
  const { repository, vault } = await fixture();
  const folder = await repository.createEntry(vault.id, null, 'Attachments', 'directory');
  const bytes = Uint8Array.from([0, 1, 2, 127, 128, 255]);
  const entry = await repository.createAttachment(vault.id, folder.id, 'sample.bin', '', bytes);
  const read = await repository.read(entry.id);
  assert.equal(read.entry.kind, 'attachment');
  assert.equal(read.content, null);
  assert.equal(read.attachment.mimeType, 'application/octet-stream');
  assert.deepEqual([...read.attachment.bytes], [...bytes]);
  assert.equal(read.attachment.size, bytes.length);
});

test('attachment duplication and folder duplication preserve bytes with deterministic filenames', async () => {
  const { repository, vault } = await fixture();
  const folder = await repository.createEntry(vault.id, null, 'Assets', 'directory');
  const media = await repository.createAttachment(vault.id, folder.id, 'photo.png', 'image/png', Uint8Array.from([1,2,3,4]));

  const directCopy = await repository.duplicate(media.id, media.localVersion);
  assert.equal(directCopy.name, 'photo copy.png');
  assert.deepEqual([...(await repository.readAttachment(directCopy.id)).bytes], [1,2,3,4]);

  const folderCopy = await repository.duplicate(folder.id, folder.localVersion);
  const entries = await repository.listEntries(vault.id, true);
  const nested = entries.find(entry => entry.parentId === folderCopy.id && entry.kind === 'attachment');
  assert.ok(nested);
  assert.equal(nested.name, 'photo.png');
  assert.deepEqual([...(await repository.readAttachment(nested.id)).bytes], [1,2,3,4]);
});

test('backup snapshot and ZIP source preserve attachment bytes and paths', async () => {
  const { repository, vault } = await fixture();
  const folder = await repository.createEntry(vault.id, null, 'Attachments', 'directory');
  await repository.createEntry(vault.id, null, 'Note', 'markdown', '# Note');
  await repository.createAttachment(vault.id, folder.id, 'data.dat', 'application/octet-stream', Uint8Array.from([10,20,30,40]));

  const snapshot = await repository.snapshot(vault.id);
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.attachments.length, 1);
  const files = vaultFiles(snapshot);
  const attachment = files.find(file => file.path === 'Attachments/data.dat');
  assert.ok(attachment);
  assert.deepEqual([...attachment.bytes], [10,20,30,40]);
  assert.equal(files.find(file => file.path === 'Note.md') !== undefined, true);
});

test('attachment resolution supports full paths, same-folder names and orphan reference counts', () => {
  const vaultId = '11111111-1111-4111-8111-111111111111';
  const now = '2026-09-21T10:00:00.000Z';
  const folder = { id:'folder', vaultId, parentId:null, name:'Assets', kind:'directory', createdAt:now, updatedAt:now, localVersion:1, deletedAt:null, deletionBatch:null, activeKey:'folder' };
  const note = { id:'note', vaultId, parentId:folder.id, name:'Note.md', kind:'markdown', createdAt:now, updatedAt:now, localVersion:1, deletedAt:null, deletionBatch:null, activeKey:'note' };
  const used = { id:'used', vaultId, parentId:folder.id, name:'photo.png', kind:'attachment', createdAt:now, updatedAt:now, localVersion:1, deletedAt:null, deletionBatch:null, activeKey:'used' };
  const orphan = { id:'orphan', vaultId, parentId:folder.id, name:'unused.pdf', kind:'attachment', createdAt:now, updatedAt:now, localVersion:1, deletedAt:null, deletionBatch:null, activeKey:'orphan' };
  const entries = [folder,note,used,orphan];
  const record = parseKnowledge({ entryId:note.id, vaultId, localVersion:1, text:'![[photo.png]]' });

  assert.deepEqual(resolveAttachmentTarget('photo.png', note.id, entries), { status:'resolved', entryId:used.id });
  assert.deepEqual(resolveAttachmentTarget('Assets/photo.png', note.id, entries), { status:'resolved', entryId:used.id });
  assert.equal(canonicalAttachmentTarget(used.id, entries), 'Assets/photo.png');
  const counts = attachmentReferenceCounts(entries, [record]);
  assert.equal(counts.get(used.id), 1);
  assert.equal(counts.get(orphan.id), 0);
});

test('moving or renaming attachment rewrites inbound embeds without altering aliases', () => {
  const vaultId = '11111111-1111-4111-8111-111111111111';
  const now = '2026-09-21T10:00:00.000Z';
  const folder = { id:'folder', vaultId, parentId:null, name:'Assets', kind:'directory', createdAt:now, updatedAt:now, localVersion:1, deletedAt:null, deletionBatch:null, activeKey:'folder' };
  const note = { id:'note', vaultId, parentId:null, name:'Note.md', kind:'markdown', createdAt:now, updatedAt:now, localVersion:1, deletedAt:null, deletionBatch:null, activeKey:'note' };
  const before = { id:'asset', vaultId, parentId:folder.id, name:'old.png', kind:'attachment', createdAt:now, updatedAt:now, localVersion:1, deletedAt:null, deletionBatch:null, activeKey:'before' };
  const after = { ...before, name:'new.png', localVersion:2, activeKey:'after' };
  const oldEntries = [folder,note,before];
  const newEntries = [folder,note,after];
  const source = 'Image: ![[Assets/old.png|Diagram]] and [[Assets/old.png]].';
  assert.equal(
    rewriteAttachmentReferences(source, note.id, before.id, oldEntries, newEntries),
    'Image: ![[Assets/new.png|Diagram]] and [[Assets/new.png]].',
  );
});

test('media classification and folders-first sorting are deterministic with the third entry kind', () => {
  assert.equal(normalizeAttachmentMimeType('x.PNG', ''), 'image/png');
  assert.equal(attachmentMediaKind('image/png'), 'image');
  assert.equal(attachmentMediaKind('application/pdf'), 'pdf');
  const now = '2026-09-21T10:00:00.000Z';
  const base = { vaultId:'v', parentId:null, createdAt:now, updatedAt:now, localVersion:1, deletedAt:null, deletionBatch:null };
  const folder = { ...base, id:'f', name:'Folder', kind:'directory' };
  const note = { ...base, id:'n', name:'A.md', kind:'markdown' };
  const attachment = { ...base, id:'a', name:'B.png', kind:'attachment' };
  assert.equal(compareEntries(folder, note, 'name-asc', true) < 0, true);
  assert.equal(compareEntries(note, attachment, 'name-asc', true) < 0, true);
  assert.equal(compareEntries(attachment, note, 'name-asc', true) > 0, true);
});
