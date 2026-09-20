import { expect, test, type Page } from '@playwright/test';

async function confirmTextDialog(page: Page, value: string): Promise<void> {
  const dialog = page.locator('.form-dialog');
  await expect(dialog).toBeVisible();
  const input = dialog.locator('#vault-dialog-input');
  await expect(input).toBeVisible();
  await input.fill(value);
  await dialog.locator('button[value="confirm"]').click();
  await expect(dialog).not.toBeVisible();
}


async function setEditorText(page: Page, text: string): Promise<void> {
  const content = page.locator('#vault-editor .cm-content');
  await expect(content).toBeVisible();
  await content.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(text);
}

async function expectEditorText(page: Page, text: string): Promise<void> {
  await expect.poll(async () => {
    const lines = await page.locator('#vault-editor .cm-line').allTextContents();
    return lines.join('\n');
  }).toBe(text);
}

async function createVault(page: Page, name: string): Promise<void> {
  await page.locator('.empty-state [data-command="vault.create"]').click();
  await confirmTextDialog(page, name);
  await expect(page.locator('#vault-vault')).toHaveValue(/.+/);
}

test('desktop Phase 1 vault lifecycle persists through reload', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');

  await page.goto('/');
  await expect(page).toHaveTitle('Vault');
  await expect(page.locator('.stage')).toHaveText('Phase 2 · Markdown editor');
  await createVault(page, 'Knowledge');

  await page.locator('[data-command="folder.create"]').click();
  await confirmTextDialog(page, 'University');
  await expect(page.getByRole('treeitem').filter({ has: page.getByRole('button', { name: 'Folder University' }) })).toBeVisible();

  await page.locator('[data-command="file.create"]').click();
  await confirmTextDialog(page, 'Analysis');
  const editor = page.locator('#vault-editor');
  await expect(editor).toBeVisible();

  const markdown = '# Analysis\n\nA local-first Markdown note.\n\n$e^{i\\pi}+1=0$\n';
  await setEditorText(page, markdown);
  await expect(page.locator('.save-status')).toContainText('Saved locally');
  await expect(page.locator('.breadcrumb')).toHaveText('University/Analysis.md');

  await page.reload();
  await expect(editor).toBeVisible();
  await expectEditorText(page, markdown);
  await expect(page.locator('.breadcrumb')).toHaveText('University/Analysis.md');

  await page.locator('[data-action="duplicate"]').click();
  await expect(page.getByRole('button', { name: 'Note Analysis copy.md' })).toBeVisible();
  await expectEditorText(page, markdown);

  await page.locator('[data-action="rename"]').click();
  await confirmTextDialog(page, 'Analysis Copy Renamed');
  await expect(page.locator('.breadcrumb')).toHaveText('University/Analysis Copy Renamed.md');

  await page.locator('[data-action="delete"]').click();
  await expect(page.locator('.empty-state')).toBeVisible();
  await page.locator('[data-action="trash-view"]').click();
  const trashed = page.getByRole('button', { name: 'Note Analysis Copy Renamed.md' });
  await expect(trashed).toBeVisible();
  await trashed.click();
  await expect(page.locator('.save-status')).toContainText('In Trash');
  await page.locator('[data-action="restore"]').click();
  await expect(editor).toBeVisible();
  await expectEditorText(page, markdown);

  await page.locator('[data-action="vault-rename"]').click();
  await confirmTextDialog(page, 'Study Vault');
  await expect(page.locator('#vault-vault option:checked')).toHaveText('Study Vault');

  await page.locator('[data-command="folder.create"]').click();
  await confirmTextDialog(page, 'Archive');
  await expect(page.getByRole('button', { name: 'Folder Archive' })).toBeVisible();

  const source = page.getByRole('button', { name: 'Note Analysis.md' });
  const archiveShell = page.getByRole('treeitem').filter({ has: page.getByRole('button', { name: 'Folder Archive' }) });
  await source.dragTo(archiveShell);
  await source.click();
  await expect(page.locator('.breadcrumb')).toHaveText('University/Archive/Analysis.md');

  await page.locator('.file-filter').fill('analysis');
  await expect(page.getByRole('button', { name: 'Note Analysis.md' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('â');
  await expect(page.locator('body')).not.toContainText('Â');
});

test('mobile shell exposes the local vault workflow without desktop sidebars', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile');

  await page.goto('/');
  const workspace = page.locator('.workspace');
  await expect(workspace).toHaveAttribute('data-sidebar-open', 'false');
  const toggle = page.locator('[data-action="files"]');
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(workspace).toHaveAttribute('data-sidebar-open', 'true');

  await page.locator('.sidebar [data-command="vault.create"]').click();
  await confirmTextDialog(page, 'Mobile');
  await page.locator('[data-command="file.create"]').click();
  await confirmTextDialog(page, 'Quick Capture');

  const editor = page.locator('#vault-editor');
  await expect(editor).toBeVisible();
  await setEditorText(page, '# Mobile\n\nSaved from the touch layout.');
  await expect(page.locator('.save-status')).toContainText('Saved locally');

  await page.reload();
  await expectEditorText(page, '# Mobile\n\nSaved from the touch layout.');
  await expect(page.locator('body')).not.toContainText('â');
  await expect(page.locator('body')).not.toContainText('Â');
});
