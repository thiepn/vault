import { expect, test, type Page } from '@playwright/test';

async function confirmTextDialog(page: Page, value: string): Promise<void> {
  const dialog = page.locator('.form-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('#vault-dialog-input').fill(value);
  await dialog.locator('button[value="confirm"]').click();
  await expect(dialog).not.toBeVisible();
}

async function ensureSidebarOpen(page: Page): Promise<void> {
  const tabs = page.locator('.sidebar-tabs');
  if (await tabs.isVisible()) return;
  await page.locator('[data-action="files"]').click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar-open', 'true');
  await expect(tabs).toBeVisible();
}

async function openFiles(page: Page): Promise<void> {
  await ensureSidebarOpen(page);
  await page.locator('[data-sidebar-panel="files"]').click();
  await expect(page.locator('[data-panel="files"]')).toBeVisible();
}

async function createVault(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.locator('.empty-state [data-command="vault.create"]').click();
  await confirmTextDialog(page, name);
  await expect(page.locator('#vault-vault')).toHaveValue(/.+/);
}

async function createNote(page: Page, name: string, text: string): Promise<void> {
  await openFiles(page);
  await page.locator('.sidebar [data-command="file.create"]').click();
  await confirmTextDialog(page, name);
  const editor = page.locator('#vault-editor .cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(text);
  await expect(page.locator('.save-status')).toContainText('Saved locally');
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

async function returnLive(page: Page): Promise<void> {
  await page.locator('[data-editor-mode="live"]').click();
  const content = page.locator('#vault-editor .cm-content');
  await content.click();
  await page.keyboard.press('Control+Home');
}

const pixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n3sAAAAASUVORK5CYII=',
  'base64',
);

const canvasMarkdown = [
  '# Spatial workspace',
  '',
  '```vault-canvas',
  'version: 1',
  'id: canvas-main',
  'viewport:',
  '  x: 80',
  '  y: 80',
  '  zoom: 1',
  'nodes:',
  '  - id: note-alpha',
  '    type: note',
  '    target: Alpha',
  '    x: 0',
  '    y: 0',
  '    width: 260',
  '    height: 160',
  '  - id: text-idea',
  '    type: text',
  '    text: Initial idea',
  '    x: 340',
  '    y: 0',
  '    width: 240',
  '    height: 140',
  '  - id: media-pixel',
  '    type: media',
  '    target: Attachments/pixel.png',
  '    alt: Pixel',
  '    x: 0',
  '    y: 240',
  '    width: 280',
  '    height: 180',
  'edges:',
  '  - id: edge-one',
  '    from: note-alpha',
  '    to: text-idea',
  '    label: inspires',
  'groups:',
  '  - id: group-one',
  '    title: Ideas',
  '    x: -30',
  '    y: -35',
  '    width: 650',
  '    height: 500',
  '```',
].join('\n');

test('Phase 12 spatial Canvas persists authored geometry and interactions on desktop', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');

  await createVault(page, 'Canvas Vault');
  await createNote(page, 'Alpha', '# Alpha');

  await page.locator('.attachment-file-input').setInputFiles({
    name:'pixel.png',
    mimeType:'image/png',
    buffer:pixelPng,
  });
  await expect(page.locator('.save-status')).toContainText('Saved locally');

  await createNote(page, 'Spatial', canvasMarkdown);
  await expect(page.locator('[data-action="insert-canvas"]')).toBeVisible();

  const editor = page.locator('#vault-editor .cm-content');
  await editor.click();
  await page.keyboard.press('Control+Home');

  let canvas = page.locator('#vault-editor .cm-canvas-widget .canvas-workspace');
  await expect(canvas).toBeVisible();
  await expect(canvas.locator('.canvas-node')).toHaveCount(3);
  await expect(canvas.locator('.canvas-group')).toHaveCount(1);
  await expect(canvas.locator('.canvas-edge-line')).toHaveCount(1);
  await expect(canvas.locator('[data-canvas-node="note-alpha"] .canvas-note-title')).toHaveText('Alpha');
  await expect(canvas.locator('[data-canvas-node="media-pixel"] .canvas-media-image')).toBeVisible();

  await canvas.getByRole('button', { name:'Expand canvas workspace' }).click();
  await expect(canvas).toHaveClass(/expanded/);
  await canvas.getByRole('button', { name:'Collapse canvas workspace' }).click();
  await expect(canvas).not.toHaveClass(/expanded/);

  await canvas.getByRole('button', { name:'Fit canvas content' }).click();
  canvas = page.locator('#vault-editor .cm-canvas-widget .canvas-workspace');
  await expect(canvas).toBeVisible();
  const header = canvas.locator('[data-canvas-node="text-idea"] .canvas-node-header');
  await expect(header).toBeVisible();
  const box = await header.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 40, box!.y + 14);
  await page.mouse.down();
  await page.mouse.move(box!.x + 140, box!.y + 74, { steps:5 });
  await page.mouse.up();

  const movedSource = await sourceText(page);
  const movedMatch = /id: text-idea[\s\S]*?x:\s*(-?\d+(?:\.\d+)?)[\s\S]*?y:\s*(-?\d+(?:\.\d+)?)/u.exec(movedSource);
  expect(!!movedMatch && Number(movedMatch[1]) > 340 && Number(movedMatch[2]) > 0).toBe(true);

  await returnLive(page);
  canvas = page.locator('#vault-editor .cm-canvas-widget .canvas-workspace');
  await expect(canvas).toBeVisible();

  await canvas.getByRole('button', { name:'Add text card' }).click();
  await confirmTextDialog(page, 'New spatial idea');
  canvas = page.locator('#vault-editor .cm-canvas-widget .canvas-workspace');
  await expect(canvas.locator('.canvas-node')).toHaveCount(4);
  const newText = canvas.locator('.canvas-node-text').filter({ hasText:'New spatial idea' });
  await expect(newText).toBeVisible();

  await canvas.getByRole('button', { name:'Connect two nodes' }).click();
  await canvas.locator('[data-canvas-node="note-alpha"]').click();
  await newText.click();
  canvas = page.locator('#vault-editor .cm-canvas-widget .canvas-workspace');
  await expect(canvas.locator('.canvas-edge-line')).toHaveCount(2);

  await canvas.getByRole('button', { name:'Add group' }).click();
  await confirmTextDialog(page, 'New group');
  canvas = page.locator('#vault-editor .cm-canvas-widget .canvas-workspace');
  await expect(canvas.locator('.canvas-group')).toHaveCount(2);

  await canvas.getByRole('button', { name:'Zoom in' }).click();
  await expect.poll(async () => {
    const text = await sourceText(page);
    return /zoom: 1\.(?:1|2)/u.test(text) || /zoom: 1\.22/u.test(text);
  }).toBe(true);

  await returnLive(page);
  canvas = page.locator('#vault-editor .cm-canvas-widget .canvas-workspace');
  await canvas.locator('[data-canvas-node="note-alpha"] .canvas-open-button').click();
  await expect(page.locator('.breadcrumb')).toContainText('Alpha.md');

  await quickOpen(page, 'Spatial');
  await page.locator('[data-editor-mode="reading"]').click();
  const readingCanvas = page.locator('.reading-view .canvas-workspace');
  await expect(readingCanvas).toBeVisible();
  await expect(readingCanvas.locator('.canvas-node')).toHaveCount(4);
  await expect(readingCanvas.locator('.canvas-edge-line')).toHaveCount(2);
  await expect(readingCanvas.locator('.canvas-group')).toHaveCount(2);

  await page.reload();
  await quickOpen(page, 'Spatial');
  await page.locator('[data-editor-mode="reading"]').click();
  await expect(page.locator('.reading-view .canvas-node-text').filter({ hasText:'New spatial idea' })).toBeVisible();
  await expect(page.locator('.reading-view .canvas-edge-line')).toHaveCount(2);
});

test('Phase 12 Canvas remains usable with touch-sized controls on mobile', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile');

  await createVault(page, 'Mobile Canvas');
  await createNote(page, 'Spatial', [
    '# Mobile spatial',
    '',
    '```vault-canvas',
    'version: 1',
    'id: mobile-canvas',
    'viewport: { x: 40, y: 40, zoom: 1 }',
    'nodes:',
    '  - { id: text-one, type: text, text: Mobile idea, x: 0, y: 0, width: 220, height: 120 }',
    'edges: []',
    'groups: []',
    '```',
  ].join('\n'));

  const editor = page.locator('#vault-editor .cm-content');
  await editor.click();
  await page.keyboard.press('Control+Home');
  let canvas = page.locator('#vault-editor .cm-canvas-widget .canvas-workspace');
  await expect(canvas).toBeVisible();
  await expect(canvas.locator('.canvas-node')).toHaveCount(1);

  await canvas.getByRole('button', { name:'Add text card' }).tap();
  await confirmTextDialog(page, 'Second mobile idea');
  canvas = page.locator('#vault-editor .cm-canvas-widget .canvas-workspace');
  await expect(canvas.locator('.canvas-node')).toHaveCount(2);

  await canvas.locator('.canvas-node-text').filter({ hasText:'Second mobile idea' }).tap();
  await canvas.getByRole('button', { name:'Edit selected item' }).tap();
  await confirmTextDialog(page, 'Edited mobile idea');
  canvas = page.locator('#vault-editor .cm-canvas-widget .canvas-workspace');
  await expect(canvas.locator('.canvas-node-text').filter({ hasText:'Edited mobile idea' })).toBeVisible();

  await canvas.getByRole('button', { name:'Zoom in' }).tap();
  await page.locator('[data-editor-mode="reading"]').tap();
  await expect(page.locator('.reading-view .canvas-workspace')).toBeVisible();
  await expect(page.locator('.reading-view .canvas-node')).toHaveCount(2);
});
