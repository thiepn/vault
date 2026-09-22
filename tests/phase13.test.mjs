import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { zipStore } from '../build/core/services/export.js';
import { readZipArchive } from '../build/core/interoperability/zip.js';
import { planObsidianMigration, obsidianExportFiles } from '../build/core/interoperability/obsidian.js';
import { commitObsidianMigration } from '../build/core/interoperability/importer.js';
import { parseCanvasFences } from '../build/core/canvas/fences.js';
import { parseCanvasDocument } from '../build/core/canvas/model.js';

const enc = new TextEncoder();

function archive(path, content, directory = false) {
  return {
    path,
    bytes: directory ? new Uint8Array() : typeof content === 'string' ? enc.encode(content) : content,
    directory,
    modifiedAt: '2026-09-20T10:00:00.000Z',
  };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function deflatedZip(path, payload) {
  const name = enc.encode(path);
  const compressed = new Uint8Array(deflateRawSync(payload));
  const crc = crc32(payload);
  const local = new Uint8Array(30);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(6, 0x0800, true);
  lv.setUint16(8, 8, true);
  lv.setUint32(14, crc, true);
  lv.setUint32(18, compressed.length, true);
  lv.setUint32(22, payload.length, true);
  lv.setUint16(26, name.length, true);

  const central = new Uint8Array(46);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true);
  cv.setUint16(6, 20, true);
  cv.setUint16(8, 0x0800, true);
  cv.setUint16(10, 8, true);
  cv.setUint32(16, crc, true);
  cv.setUint32(20, compressed.length, true);
  cv.setUint32(24, payload.length, true);
  cv.setUint16(28, name.length, true);
  cv.setUint32(42, 0, true);

  const centralOffset = local.length + name.length + compressed.length;
  const centralSize = central.length + name.length;
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);

  const result = new Uint8Array(centralOffset + centralSize + end.length);
  let at = 0;
  for (const part of [local, name, compressed, central, name, end]) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}

test('Phase 13 reads both Vault STORE ZIPs and standard DEFLATE ZIPs', async () => {
  const stored = zipStore([{ path:'Vault/Note.md', bytes:enc.encode('# Note') }]);
  const storedResult = await readZipArchive(stored);
  assert.equal(storedResult.files.length, 1);
  assert.equal(new TextDecoder().decode(storedResult.files[0].bytes), '# Note');

  const deflated = deflatedZip('Obsidian/Compressed.md', enc.encode('# Compressed'));
  const deflatedResult = await readZipArchive(deflated);
  assert.equal(deflatedResult.files[0].path, 'Obsidian/Compressed.md');
  assert.equal(new TextDecoder().decode(deflatedResult.files[0].bytes), '# Compressed');
});

test('migration strips the common root, ignores .obsidian config and detects community plugins', () => {
  const plan = planObsidianMigration([
    archive('My Vault/', '', true),
    archive('My Vault/.obsidian/community-plugins.json', '["dataview","templater-obsidian"]'),
    archive('My Vault/.obsidian/app.json', '{"useMarkdownLinks":false}'),
    archive('My Vault/Notes/Hello.md', '# Hello'),
  ], 'my-vault.zip');

  assert.equal(plan.suggestedVaultName, 'My Vault');
  assert.equal(plan.report.ignoredConfiguration, 2);
  assert.deepEqual(plan.report.detectedCommunityPlugins, ['dataview','templater-obsidian']);
  assert.equal(plan.files[0].path, 'Notes/Hello.md');
});

test('migration repairs non-portable names, resolves collisions and rewrites Wiki/Markdown links', () => {
  const plan = planObsidianMigration([
    archive('Bad:Name.md', '# Target'),
    archive('Bad?Name.md', '# Other'),
    archive('Index.md', [
      '[[Bad:Name]]',
      '[standard](Bad%3AName.md)',
      '![[image:one.png]]',
    ].join('\n')),
    archive('image:one.png', Uint8Array.from([1,2,3])),
  ]);

  const bad = plan.files.find(file => file.sourcePath === 'Bad:Name.md');
  const other = plan.files.find(file => file.sourcePath === 'Bad?Name.md');
  const index = plan.files.find(file => file.sourcePath === 'Index.md');
  const image = plan.files.find(file => file.sourcePath === 'image:one.png');
  assert.ok(bad && other && index?.kind === 'markdown' && image);
  assert.equal(bad.path, 'Bad-Name.md');
  assert.equal(other.path, 'Bad-Name (2).md');
  assert.equal(image.path, 'image-one.png');
  assert.match(index.text, /\[\[Bad-Name\]\]/);
  assert.match(index.text, /\(Bad-Name\.md\)/);
  assert.match(index.text, /!\[\[image-one\.png\]\]/);
  assert.ok(plan.report.rewrittenWikiLinks >= 2);
  assert.ok(plan.report.renamedPaths.length >= 3);
});

test('Obsidian JSON Canvas converts to Vault Canvas while preserving unresolved web links as text', () => {
  const jsonCanvas = JSON.stringify({
    nodes:[
      { id:'a', type:'file', file:'Notes/Alpha.md', x:0, y:0, width:250, height:140 },
      { id:'b', type:'text', text:'Idea', x:320, y:0, width:220, height:120 },
      { id:'g', type:'group', label:'Cluster', x:-20, y:-30, width:620, height:300 },
      { id:'web', type:'link', url:'https://example.com', x:0, y:200, width:250, height:100 },
    ],
    edges:[{ id:'e', fromNode:'a', toNode:'b', toEnd:'arrow', label:'inspires' }],
  });
  const plan = planObsidianMigration([
    archive('Notes/Alpha.md', '# Alpha'),
    archive('Board.canvas', jsonCanvas),
  ]);
  const converted = plan.files.find(file => file.sourcePath === 'Board.canvas');
  assert.ok(converted?.kind === 'markdown');
  assert.equal(converted.path, 'Board.canvas.md');
  const fence = parseCanvasFences(converted.text)[0];
  assert.ok(fence);
  const document = parseCanvasDocument(fence.source);
  assert.equal(document.nodes.length, 3);
  assert.equal(document.groups.length, 1);
  assert.equal(document.edges.length, 1);
  assert.equal(document.nodes.find(node => node.id === 'a')?.type, 'note');
  assert.equal(document.nodes.find(node => node.id === 'web')?.type, 'text');
  assert.equal(plan.report.canvasesConverted, 1);
  assert.match(plan.report.warnings.join('\n'), /web-link cards/);
});

test('invalid .canvas files are preserved as attachments instead of discarded', () => {
  const plan = planObsidianMigration([
    archive('Broken.canvas', '{not json'),
  ]);
  assert.equal(plan.report.canvasesPreservedRaw, 1);
  assert.equal(plan.files[0].kind, 'attachment');
  assert.equal(plan.files[0].path, 'Broken.canvas');
});

test('Obsidian export creates JSON Canvas companions while preserving Markdown', () => {
  const markdown = '# Spatial\n\n~~~vault-canvas\nversion: 1\nid: canvas-one\nviewport: { x: 80, y: 80, zoom: 1 }\nnodes:\n  - { id: text-one, type: text, text: Hello, x: 0, y: 0, width: 200, height: 100 }\nedges: []\ngroups: []\n~~~\n';
  const document = parseCanvasDocument(parseCanvasFences(markdown)[0].source);
  const result = obsidianExportFiles(
    [{ path:'Spatial.md', bytes:enc.encode(markdown) }],
    new Map([['Spatial.md', markdown]]),
    new Map([['Spatial.md', [document]]]),
  );
  assert.equal(result.report.canvasCompanions, 1);
  assert.ok(result.files.some(file => file.path === 'Spatial.md'));
  const canvas = result.files.find(file => file.path === 'Spatial.canvas');
  assert.ok(canvas);
  const parsed = JSON.parse(new TextDecoder().decode(canvas.bytes));
  assert.equal(parsed.nodes[0].type, 'text');
});

class MemoryStore {
  constructor(data, name, fail) { this.data=data; this.name=name; this.fail=fail; }
  key(value) {
    if (this.name === 'vaults') return value.id;
    if (this.name === 'entries') return value.id;
    if (this.name === 'contents' || this.name === 'attachments' || this.name === 'dirty') return value.entryId;
    throw new Error('unknown store ' + this.name);
  }
  async get(key) { return structuredClone(this.data.get(key)); }
  async getAll() { return [...this.data.values()].map(structuredClone); }
  async fromIndex(index,key) { return [...this.data.values()].find(v=>v[index]===key); }
  async allFromIndex(index,key) { return [...this.data.values()].filter(v=>v[index]===key).map(structuredClone); }
  async add(value) {
    if (this.fail?.(this.name,value)) throw new Error('injected storage failure');
    const key=this.key(value); if(this.data.has(key)) throw new Error('duplicate'); this.data.set(key,structuredClone(value));
  }
  async put(value) {
    if (this.fail?.(this.name,value)) throw new Error('injected storage failure');
    this.data.set(this.key(value),structuredClone(value));
  }
  async delete(key) { this.data.delete(key); }
}

class MemoryDriver {
  constructor(fail=null) {
    this.fail=fail;
    this.stores=new Map(['vaults','entries','contents','attachments','dirty'].map(name=>[name,new Map()]));
  }
  async transaction(names,mode,body) {
    const working=new Map([...this.stores].map(([name,data])=>[name, mode==='readwrite'&&names.includes(name) ? new Map([...data].map(([k,v])=>[k,structuredClone(v)])) : data]));
    const result=await body({store:name=>new MemoryStore(working.get(name),name,this.fail)});
    if(mode==='readwrite') for(const name of names) this.stores.set(name,working.get(name));
    return result;
  }
}

test('migration commit is atomic and adopts stable task identities', async () => {
  const plan = planObsidianMigration([
    archive('Tasks.md', '- [ ] Imported task'),
    archive('pic.png', Uint8Array.from([7,8,9])),
  ]);
  const driver = new MemoryDriver();
  const mirror = { async syncVaultTree(){}, async markRepairNeeded(){} };
  const result = await commitObsidianMigration(driver, mirror, plan, 'Imported');
  assert.equal(result.markdownNotes, 1);
  assert.equal(result.attachments, 1);
  const contents=[...driver.stores.get('contents').values()];
  assert.match(contents[0].text, /<!-- vault:task=[0-9a-f-]+ -->/);

  const failing = new MemoryDriver((name,value)=>name==='attachments');
  await assert.rejects(() => commitObsidianMigration(failing, mirror, plan, 'Fails'), /injected storage failure/);
  assert.equal(failing.stores.get('vaults').size, 0);
  assert.equal(failing.stores.get('entries').size, 0);
});
