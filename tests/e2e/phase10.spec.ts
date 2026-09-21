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

async function openGraph(page: Page): Promise<void> {
  await page.locator('[data-action="graph-open"]').click();
  await expect(page.locator('.graph-surface')).toBeVisible();
  await expect(page.locator('.workspace')).toHaveAttribute('data-graph-open', 'true');
}

const pixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n3sAAAAASUVORK5CYII=',
  'base64',
);

test('Phase 10 full/local graph, filters, grouping and navigation work on desktop', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');

  await createVault(page, 'Graph Vault');
  await createNote(page, 'Alpha', '# Alpha\n\n[[Hub]]');
  await createNote(page, 'Beta', '# Beta');
  await createNote(page, 'Orphan', '# Orphan');
  await createNote(page, 'Hub', [
    '---',
    'tags: [project]',
    'status: active',
    '---',
    '# Hub',
    '',
    '[[Alpha]]',
    '[[Beta]]',
  ].join('\n'));

  await page.locator('.attachment-file-input').setInputFiles({
    name: 'graph.png',
    mimeType: 'image/png',
    buffer: pixelPng,
  });
  await expect(page.locator('.save-status')).toContainText('Saved locally');

  await openGraph(page);
  const summary = page.locator('.graph-summary');
  await expect(summary).toContainText('Full vault');
  await expect(summary).toContainText('5 nodes');
  await expect(summary).toContainText('4 edges');
  await expect(summary).toContainText('1 orphan');
  await expect(page.locator('.graph-canvas')).toBeVisible();
  await expect(page.locator('.graph-node-button')).toHaveCount(5);

  await page.locator('.graph-search').fill('Orphan');
  await expect(page.locator('.graph-browser-count')).toContainText('1 match');
  await expect(page.locator('.graph-node-button')).toHaveCount(1);
  await expect(page.locator('.graph-node-title')).toHaveText('Orphan');

  await page.locator('.graph-search').fill('');
  await page.locator('.graph-orphans').check();
  await expect(summary).toContainText('1 nodes');
  await expect(summary).toContainText('0 edges');
  await expect(page.locator('.graph-node-title')).toHaveText('Orphan');

  await page.locator('.graph-orphans').uncheck();
  await page.locator('.graph-tag').fill('#project');
  await expect(summary).toContainText('1 nodes');
  await expect(page.locator('.graph-node-title')).toHaveText('Hub');

  await page.locator('.graph-tag').fill('');
  await page.locator('.graph-property').fill('status=active');
  await expect(summary).toContainText('1 nodes');
  await expect(page.locator('.graph-node-title')).toHaveText('Hub');

  await page.locator('.graph-property').fill('');
  await page.locator('.graph-group').selectOption('property');
  await expect(page.locator('.graph-group-property-setting')).toBeVisible();
  await page.locator('.graph-group-property').fill('status');

  await page.locator('.graph-mode').selectOption('local');
  await page.locator('.graph-depth').selectOption('1');
  await expect(summary).toContainText('Local · 1 hop');
  await expect(summary).toContainText('4 nodes');
  await expect(page.locator('.graph-node-button')).toHaveCount(4);
  await expect(page.locator('.graph-node-title').filter({ hasText:'Orphan' })).toHaveCount(0);

  await page.locator('[data-graph-action="zoom-in"]').click();
  await page.locator('[data-graph-action="zoom-out"]').click();
  await page.locator('[data-graph-action="fit"]').click();

  await page.locator('.graph-node-button').filter({ hasText:'Alpha' }).click();
  await expect(page.locator('.graph-surface')).not.toBeVisible();
  await expect(page.locator('.breadcrumb')).toContainText('Alpha.md');

  await page.locator('[data-action="graph-local"]').click();
  await expect(page.locator('.graph-surface')).toBeVisible();
  await expect(summary).toContainText('Local');
  await page.keyboard.press('Escape');
  await expect(page.locator('.graph-surface')).not.toBeVisible();
});

test('Phase 10 graph controls and node navigation remain usable on mobile', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile');

  await createVault(page, 'Mobile Graph');
  await createNote(page, 'Alpha', '# Alpha');
  await createNote(page, 'Beta', '# Beta');
  await createNote(page, 'Hub', '# Hub\n\n[[Alpha]]\n[[Beta]]');

  await openGraph(page);
  await expect(page.locator('.graph-canvas')).toBeVisible();
  await expect(page.locator('.graph-node-button')).toHaveCount(3);

  await page.locator('.graph-mode').selectOption('local');
  await page.locator('.graph-depth').selectOption('1');
  await expect(page.locator('.graph-summary')).toContainText('Local · 1 hop');
  await expect(page.locator('.graph-summary')).toContainText('3 nodes');

  await page.locator('.graph-search').fill('Beta');
  await expect(page.locator('.graph-browser-count')).toContainText('1 match');
  const beta = page.locator('.graph-node-button').filter({ hasText:'Beta' });
  await expect(beta).toBeVisible();
  await beta.click();

  await expect(page.locator('.graph-surface')).not.toBeVisible();
  await expect(page.locator('.breadcrumb')).toContainText('Beta.md');
});
