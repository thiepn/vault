import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalRepository } from '../build/core/storage/local-repository.js';
import { validateName } from '../build/core/domain/paths.js';
import { treeRows } from '../build/core/services/file-tree.js';
import { VaultError } from '../build/core/domain/errors.js';

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
    if (this.name === 'contents') return value.entryId;
    if (this.name === 'dirty') return value.entryId;
    if (this.name === 'revisions' || this.name === 'drafts' || this.name === 'outbox') return value.id;
    if (this.name === 'settings') return value.key;
    if (this.name === 'remoteShadows') return value.entryId;
    if (this.name === 'syncCursors') return value.vaultId;
    throw new Error('unknown store');
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
    for (const name of ['vaults','entries','contents','dirty','outbox','revisions','drafts','settings','remoteShadows','syncCursors']) this.stores.set(name, new Map());
  }
  async transaction(names, mode, body) {
    const working = new Map();
    for (const [name, data] of this.stores) working.set(name, mode === 'readwrite' && names.includes(name) ? new Map([...data].map(([k,v]) => [k,clone(v)])) : data);
    const tx = { store: name => new MemoryStore(working.get(name), name) };
    const result = await body(tx);
    if (mode === 'readwrite') for (const name of names) this.stores.set(name, working.get(name));
    return result;
  }
}

async function fixture() {
  const repository = new LocalRepository(new MemoryDriver());
  const vault = await repository.createVault('Personal');
  return { repository, vault };
}

test('portable Unicode filenames are preserved and paths are rejected', () => {
  assert.equal(validateName('한국어.md'), '한국어.md');
  assert.equal(validateName('Türkçe.md'), 'Türkçe.md');
  assert.throws(() => validateName('../escape.md'), VaultError);
});

test('create nested folders and preserve exact Markdown text', async () => {
  const { repository, vault } = await fixture();
  const university = await repository.createEntry(vault.id, null, 'University', 'directory');
  const analysis = await repository.createEntry(vault.id, university.id, 'Analysis', 'directory');
  const source = '# Integral\r\n\r\n$\\int_a^b f(x)\\,dx$\r\n';
  const note = await repository.createEntry(vault.id, analysis.id, 'Notes', 'markdown', source);
  const read = await repository.read(note.id);
  assert.equal(read.content.text, source);
  assert.equal(read.entry.name, 'Notes.md');
});

test('move keeps immutable identity', async () => {
  const { repository, vault } = await fixture();
  const a = await repository.createEntry(vault.id, null, 'A', 'directory');
  const b = await repository.createEntry(vault.id, null, 'B', 'directory');
  const note = await repository.createEntry(vault.id, a.id, 'Note', 'markdown', 'hello');
  const moved = await repository.move(note.id, b.id, note.name, note.localVersion);
  assert.equal(moved.id, note.id);
  assert.equal(moved.parentId, b.id);
});

test('duplicate note copies Markdown into a new identity and deterministic name', async () => {
  const { repository, vault } = await fixture();
  const note = await repository.createEntry(vault.id, null, 'Note', 'markdown', '**exact**');
  const copy1 = await repository.duplicate(note.id, note.localVersion);
  const copy2 = await repository.duplicate(note.id, note.localVersion);
  assert.notEqual(copy1.id, note.id);
  assert.equal(copy1.name, 'Note copy.md');
  assert.equal(copy2.name, 'Note copy 2.md');
  assert.equal((await repository.read(copy1.id)).content.text, '**exact**');
});

test('recursive folder duplicate preserves structure and Markdown', async () => {
  const { repository, vault } = await fixture();
  const folder = await repository.createEntry(vault.id, null, 'Project', 'directory');
  const nested = await repository.createEntry(vault.id, folder.id, 'Nested', 'directory');
  await repository.createEntry(vault.id, nested.id, 'Readme', 'markdown', '# hello');
  const cloneFolder = await repository.duplicate(folder.id, folder.localVersion);
  assert.equal(cloneFolder.name, 'Project copy');
  const entries = await repository.listEntries(vault.id, true);
  const cloneNested = entries.find(e => e.parentId === cloneFolder.id && e.name === 'Nested');
  const cloneNote = entries.find(e => e.parentId === cloneNested?.id && e.name === 'Readme.md');
  assert.ok(cloneNote);
  assert.equal((await repository.read(cloneNote.id)).content.text, '# hello');
});

test('stale save cannot overwrite current text and is preserved as recovery', async () => {
  const { repository, vault } = await fixture();
  const note = await repository.createEntry(vault.id, null, 'Note', 'markdown', 'v1');
  const saved = await repository.saveMarkdown(note.id, 'v2', note.localVersion);
  await assert.rejects(() => repository.saveMarkdown(note.id, 'stale draft', note.localVersion), error => error?.code === 'STALE_WRITE');
  assert.equal((await repository.read(note.id)).content.text, 'v2');
  const drafts = await repository.listRecoveryDrafts(vault.id);
  assert.equal(drafts.at(-1).text, 'stale draft');
  assert.equal(saved.localVersion, note.localVersion + 1);
});

test('trash and restore round-trip a note without changing identity', async () => {
  const { repository, vault } = await fixture();
  const note = await repository.createEntry(vault.id, null, 'Note', 'markdown', 'text');
  await repository.trash(note.id, note.localVersion);
  assert.equal((await repository.read(note.id)).entry.deletedAt !== null, true);
  await repository.restore(note.id);
  const restored = await repository.read(note.id);
  assert.equal(restored.entry.id, note.id);
  assert.equal(restored.entry.deletedAt, null);
  assert.equal(restored.content.text, 'text');
});

test('tree rows support collapse, filtering and folders-first sort', async () => {
  const { repository, vault } = await fixture();
  const folder = await repository.createEntry(vault.id, null, 'Folder', 'directory');
  const note = await repository.createEntry(vault.id, folder.id, 'Target', 'markdown', '');
  await repository.createEntry(vault.id, null, 'Root', 'markdown', '');
  const entries = await repository.listEntries(vault.id, true);
  const collapsed = treeRows(entries,{sort:'name-asc',foldersFirst:true,collapsed:new Set([folder.id]),filter:''});
  assert.deepEqual(collapsed.map(row => row.entry.name), ['Folder','Root.md']);
  const filtered = treeRows(entries,{sort:'name-asc',foldersFirst:true,collapsed:new Set([folder.id]),filter:'target'});
  assert.deepEqual(filtered.map(row => row.entry.id), [folder.id,note.id]);
});

test('vault rename changes display metadata without touching contained IDs', async () => {
  const { repository, vault } = await fixture();
  const note = await repository.createEntry(vault.id, null, 'Note', 'markdown', 'x');
  const renamed = await repository.renameVault(vault.id, 'Knowledge');
  assert.equal(renamed.id, vault.id);
  assert.equal(renamed.name, 'Knowledge');
  assert.equal((await repository.read(note.id)).entry.id, note.id);
});
