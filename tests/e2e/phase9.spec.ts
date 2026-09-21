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
}

async function openPanel(page: Page, panel: 'files' | 'media'): Promise<void> {
  await ensureSidebarOpen(page);
  await page.locator(`[data-sidebar-panel="${panel}"]`).click();
  await expect(page.locator(`[data-panel="${panel}"]`)).toBeVisible();
}

async function createVault(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.locator('.empty-state [data-command="vault.create"]').click();
  await confirmTextDialog(page, name);
  await expect(page.locator('#vault-vault')).toHaveValue(/.+/);
}

async function createNote(page: Page, name: string, text: string): Promise<void> {
  await openPanel(page, 'files');
  await page.locator('.sidebar [data-command="file.create"]').click();
  await confirmTextDialog(page, name);
  const editor = page.locator('#vault-editor .cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(text);
  await expect(page.locator('.save-status')).toContainText('Saved locally');
}

async function sourceText(page: Page): Promise<string> {
  await page.locator('[data-editor-mode="source"]').click();
  return (await page.locator('#vault-editor .cm-line').allTextContents()).join('\n');
}

async function quickOpen(page: Page, title: string): Promise<void> {
  await page.locator('[data-action="quick-switcher"]').click();
  const dialog = page.locator('.quick-switcher-dialog');
  await dialog.locator('.quick-switcher-input').fill(title);
  const result = dialog.locator('.quick-result').filter({ hasText: title }).first();
  await expect(result).toBeVisible();
  await result.click();
}

const pixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n3sAAAAASUVORK5CYII=',
  'base64',
);

test('Phase 9 uploads, embeds, previews and rewrites attachment references on desktop', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');

  await createVault(page, 'Media Vault');
  await createNote(page, 'Gallery', '# Gallery\n');

  await page.locator('.attachment-file-input').setInputFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: pixelPng,
  });

  await expect.poll(async () => await sourceText(page)).toContain('![[Attachments/pixel.png]]');
  await page.locator('[data-editor-mode="reading"]').click();
  const image = page.locator('.reading-view .vault-media-image img');
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('src', /^blob:/);

  await openPanel(page, 'media');
  const pixelItem = page.locator('.media-item').filter({ hasText: 'pixel.png' });
  await expect(pixelItem).toBeVisible();
  await expect(pixelItem).toContainText('1 ref');
  await pixelItem.click();

  await expect(page.locator('.attachment-view')).toBeVisible();
  await expect(page.locator('.attachment-title')).toHaveText('pixel.png');
  await expect(page.locator('.attachment-detail')).toContainText('image/png');
  await expect(page.locator('.attachment-preview-image')).toBeVisible();

  await page.locator('[data-action="rename"]').click();
  await confirmTextDialog(page, 'renamed.png');
  await expect(page.locator('.breadcrumb')).toContainText('Attachments/renamed.png');

  await quickOpen(page, 'Gallery');
  const rewritten = await sourceText(page);
  expect(rewritten).toContain('![[Attachments/renamed.png]]');
  expect(rewritten).not.toContain('pixel.png');

  await openPanel(page, 'media');
  await page.locator('.media-item').filter({ hasText: 'renamed.png' }).click();
  await page.locator('.attachment-file-input').setInputFiles({
    name: 'manual.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% Vault test\n'),
  });

  await openPanel(page, 'media');
  const pdfItem = page.locator('.media-item').filter({ hasText: 'manual.pdf' });
  await expect(pdfItem).toBeVisible();
  await expect(pdfItem).toContainText('Unreferenced');
  await expect(page.locator('.media-summary')).toContainText('1 unreferenced');

  await pdfItem.click();
  await expect(page.locator('.attachment-preview-file')).toContainText('PDF');
  await page.locator('[data-action="duplicate"]').click();
  await openPanel(page, 'files');
  await expect(page.getByRole('button', { name: 'Attachment manual copy.pdf' })).toBeVisible();
});

test('Phase 9 media library and attachment preview remain usable on mobile', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile');

  await createVault(page, 'Mobile Media');
  await createNote(page, 'Mobile Note', '# Mobile\n');

  await page.locator('.attachment-file-input').setInputFiles({
    name: 'mobile.png',
    mimeType: 'image/png',
    buffer: pixelPng,
  });

  await openPanel(page, 'media');
  await expect(page.locator('.media-summary')).toContainText('1 attachment');
  const item = page.locator('.media-item').filter({ hasText: 'mobile.png' });
  await expect(item).toBeVisible();
  await item.click();

  await expect(page.locator('.attachment-view')).toBeVisible();
  await expect(page.locator('.attachment-preview-image')).toBeVisible();
  await expect(page.locator('.attachment-detail')).toContainText('image/png');
});
