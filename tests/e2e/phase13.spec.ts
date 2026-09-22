import { expect, test, type Page } from '@playwright/test';

const encoder = new TextEncoder();

function crcTable(): Uint32Array {
  return Uint32Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    return crc >>> 0;
  });
}
const CRC_TABLE = crcTable();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeStoreZip(files: Array<{ path:string; bytes:Uint8Array }>): Buffer {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.path);
    const crc = crc32(file.bytes);
    const local = new Uint8Array(30);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, file.bytes.length, true);
    lv.setUint32(22, file.bytes.length, true);
    lv.setUint16(26, name.length, true);
    locals.push(local, name, file.bytes);

    const central = new Uint8Array(46);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, file.bytes.length, true);
    cv.setUint32(24, file.bytes.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    centrals.push(central, name);
    offset += local.length + name.length + file.bytes.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const result = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    result.set(part, at);
    at += part.length;
  }
  return Buffer.from(result);
}

function migrationZip(): Buffer {
  const canvas = JSON.stringify({
    nodes:[
      {id:'note',type:'file',file:'Notes/Bad:Name.md',x:0,y:0,width:260,height:160},
      {id:'text',type:'text',text:'Imported idea',x:340,y:0,width:230,height:120},
    ],
    edges:[{id:'edge',fromNode:'note',toNode:'text',toEnd:'arrow',label:'inspires'}],
  });
  return makeStoreZip([
    { path:'My Vault/.obsidian/community-plugins.json', bytes:encoder.encode('["dataview"]') },
    { path:'My Vault/Notes/Bad:Name.md', bytes:encoder.encode('# Target\n') },
    { path:'My Vault/Index.md', bytes:encoder.encode('# Index\n\n[[Bad:Name]]\n\n![image](Assets/image:one.png)\n') },
    { path:'My Vault/Assets/image:one.png', bytes:Buffer.from([137,80,78,71,1,2,3]) },
    { path:'My Vault/Board.canvas', bytes:encoder.encode(canvas) },
  ]);
}

async function quickOpen(page: Page, title: string): Promise<void> {
  await page.locator('[data-action="quick-switcher"]').click();
  const dialog = page.locator('.quick-switcher-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('.quick-switcher-input').fill(title);
  const result = dialog.locator('.quick-result').filter({ hasText:title }).first();
  await expect(result).toBeVisible();
  await result.click();
  await expect(dialog).not.toBeVisible();
}

async function sourceText(page: Page): Promise<string> {
  const source = page.locator('[data-editor-mode="source"]');
  await source.click();
  await expect(source).toHaveAttribute('aria-pressed', 'true');
  return (await page.locator('#vault-editor .cm-line').allTextContents()).join('\n');
}

test('Phase 13 imports an Obsidian ZIP into a new Vault and preserves interoperability', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');

  await page.goto('/');
  await page.locator('.obsidian-zip-input').setInputFiles({
    name:'my-vault.zip',
    mimeType:'application/zip',
    buffer:migrationZip(),
  });

  const migration = page.locator('.migration-dialog');
  await expect(migration).toBeVisible();
  await expect(migration.locator('.migration-summary')).toContainText('3 notes');
  await expect(migration.locator('.migration-summary')).toContainText('1 attachments');
  await expect(migration.locator('.migration-summary')).toContainText('1 Canvas converted');
  await expect(migration.locator('.migration-details')).toContainText('dataview');
  await expect(migration.locator('.migration-details')).toContainText('Renamed paths');

  const name = migration.locator('.migration-vault-name');
  await expect(name).toHaveValue('My Vault');
  await name.fill('Imported Obsidian');
  await migration.locator('button[value="confirm"]').click();
  await expect(migration).not.toBeVisible();

  await expect(page.locator('#vault-vault option:checked')).toHaveText('Imported Obsidian');
  await expect(page.locator('.vault-counts')).toContainText('3 notes');
  await expect(page.locator('.vault-counts')).toContainText('1 media');

  await quickOpen(page, 'Index');
  const indexSource = await sourceText(page);
  expect(indexSource).toContain('[[Notes/Bad-Name]]');
  expect(indexSource).toContain('Assets/image-one.png');

  await quickOpen(page, 'Board.canvas');
  await page.locator('[data-editor-mode="live"]').click();
  const canvas = page.locator('#vault-editor .cm-canvas-widget .canvas-workspace');
  await expect(canvas).toBeVisible();
  await expect(canvas.locator('.canvas-node')).toHaveCount(2);
  await expect(canvas.locator('.canvas-edge-line')).toHaveCount(1);
  await expect(canvas.locator('.canvas-note-title')).toHaveText('Bad-Name');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('.inspector [data-command="vault.export-obsidian"]').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Imported Obsidian-obsidian.zip');

  await page.reload();
  await expect(page.locator('#vault-vault option:checked')).toHaveText('Imported Obsidian');
  await quickOpen(page, 'Index');
  expect(await sourceText(page)).toContain('[[Notes/Bad-Name]]');
});

test('Phase 13 migration preview and confirmation remain usable on mobile', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile');

  await page.goto('/');
  await page.locator('.obsidian-zip-input').setInputFiles({
    name:'mobile-vault.zip',
    mimeType:'application/zip',
    buffer:migrationZip(),
  });

  const migration = page.locator('.migration-dialog');
  await expect(migration).toBeVisible();
  await expect(migration.locator('.migration-summary')).toContainText('Canvas converted');
  await migration.locator('.migration-vault-name').fill('Mobile Import');
  await migration.locator('button[value="confirm"]').tap();
  await expect(migration).not.toBeVisible();

  await expect(page.locator('#vault-vault option:checked')).toHaveText('Mobile Import');
  await page.locator('[data-action="quick-switcher"]').tap();
  await page.locator('.quick-switcher-input').fill('Board.canvas');
  await page.locator('.quick-result').filter({ hasText:'Board.canvas' }).first().tap();
  await expect(page.locator('#vault-editor .cm-canvas-widget .canvas-workspace')).toBeVisible();
});
