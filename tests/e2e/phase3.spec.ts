import { expect, test, type Page } from '@playwright/test';

async function confirmTextDialog(page: Page, value?: string): Promise<void> {
  const dialog = page.locator('.form-dialog');
  await expect(dialog).toBeVisible();
  const input = dialog.locator('#vault-dialog-input');
  if (await input.isVisible()) {
    if (value !== undefined) await input.fill(value);
  }
  await dialog.locator('button[value="confirm"]').click();
  await expect(dialog).not.toBeVisible();
}

async function ensureFilesOpen(page: Page): Promise<void> {
  const noteButton = page.locator('.sidebar [data-command="file.create"]');
  if (!(await noteButton.isVisible())) {
    await page.locator('[data-action="files"]').click();
    await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar-open', 'true');
  }
}

async function createVault(page: Page, name = 'Knowledge'): Promise<void> {
  await page.goto('/');
  await page.locator('.empty-state [data-command="vault.create"]').click();
  await confirmTextDialog(page, name);
  await expect(page.locator('#vault-vault')).toHaveValue(/.+/);
}

async function createNote(page: Page, name: string): Promise<void> {
  await ensureFilesOpen(page);
  const button = page.locator('.sidebar [data-command="file.create"]');
  await expect(button).toBeEnabled();
  await button.click();
  await confirmTextDialog(page, name);
  await expect(page.locator('.breadcrumb')).toContainText(`${name}.md`);
}

async function setEditorText(page: Page, text: string): Promise<void> {
  const content = page.locator('#vault-editor .cm-content');
  await expect(content).toBeVisible();
  await content.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(text);
}

async function sourceText(page: Page): Promise<string> {
  await page.locator('[data-editor-mode="source"]').click();
  await expect(page.locator('#vault-editor')).toHaveAttribute('data-mode', 'source');
  return (await page.locator('#vault-editor .cm-line').allTextContents()).join('\n');
}

async function openNote(page: Page, name: string): Promise<void> {
  await ensureFilesOpen(page);
  await page.getByRole('button', { name: `Note ${name}.md` }).click();
  await expect(page.locator('.breadcrumb')).toContainText(`${name}.md`);
}

test('Phase 3 linked knowledge works end to end on desktop', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');
  await createVault(page);

  await createNote(page, 'Newton');
  const newton = [
    '---',
    'aliases: [Isaac, "Sir Isaac Newton"]',
    '---',
    '# Laws',
    'Second law is F=ma. ^law',
    '',
    '## Gravity',
    'Bodies attract.',
  ].join('\n');
  await setEditorText(page, newton);

  await createNote(page, 'History');
  await setEditorText(page, 'Sir Isaac Newton changed physics.');

  await createNote(page, 'Mechanics');
  const mechanics = [
    '# Mechanics',
    'See [[Isaac]] and [[Newton#Laws|the laws]].',
    '',
    '![[Newton#^law]]',
  ].join('\n');
  await setEditorText(page, mechanics);

  await openNote(page, 'Newton');
  await expect(page.locator('.outline-item', { hasText: 'Laws' })).toBeVisible();
  await expect(page.locator('.backlink-item', { hasText: 'Mechanics' })).toBeVisible();
  await expect(page.locator('.unlinked-item', { hasText: 'History' })).toBeVisible();

  await page.locator('.outline-item', { hasText: 'Laws' }).click();
  await expect(page.locator('.outline-item.current', { hasText: 'Laws' })).toBeVisible();

  await openNote(page, 'Mechanics');
  await page.locator('[data-editor-mode="reading"]').click();
  await expect(page.locator('.reading-document .vault-wiki-resolved', { hasText: 'Isaac' })).toBeVisible();
  await expect(page.locator('.reading-document .vault-wiki-resolved', { hasText: 'the laws' })).toBeVisible();
  await expect(page.locator('.reading-document .vault-embed-content')).toContainText('Second law is F=ma.');
  await expect(page.locator('.reading-document')).not.toContainText('^law');

  await page.locator('.reading-document .vault-wiki-resolved', { hasText: 'the laws' }).click();
  await expect(page.locator('.breadcrumb')).toContainText('Newton.md');

  await createNote(page, 'Link Test');
  await page.locator('[data-editor-mode="live"]').click();
  await expect(page.locator('#vault-editor')).toHaveAttribute('data-mode', 'live');
  const content = page.locator('#vault-editor .cm-content');
  await content.click();
  await page.keyboard.type('[[Isa');
  const autocomplete = page.locator('.cm-tooltip-autocomplete');
  await expect(autocomplete).toBeVisible();
  await expect(autocomplete).toContainText(/Isaac|Newton/);
  await page.keyboard.press('Escape');

  await openNote(page, 'Newton');
  const unlinkedRow = page.locator('.unlinked-item', { hasText: 'History' });
  await expect(unlinkedRow).toBeVisible();
  await unlinkedRow.locator('.unlinked-link').click();
  await expect(page.locator('.backlink-item', { hasText: 'History' })).toBeVisible();

  await page.locator('[data-action="rename"]').click();
  await confirmTextDialog(page, 'Isaac Newton');
  await expect(page.locator('.breadcrumb')).toContainText('Isaac Newton.md');

  await openNote(page, 'Mechanics');
  const rewritten = await sourceText(page);
  expect(rewritten).toContain('[[Isaac Newton|Isaac]]');
  expect(rewritten).toContain('[[Isaac Newton#Laws|the laws]]');
  expect(rewritten).toContain('![[Isaac Newton#^law]]');

  await openNote(page, 'History');
  expect(await sourceText(page)).toContain('[[Isaac Newton|Sir Isaac Newton]]');

  await createNote(page, 'Unresolved');
  await setEditorText(page, 'See [[Future Note]].');
  await page.locator('[data-editor-mode="reading"]').click();
  const unresolved = page.locator('.reading-document .vault-wiki-unresolved', { hasText: 'Future Note' });
  await expect(unresolved).toBeVisible();
  await unresolved.click();
  await expect(page.locator('.form-dialog')).toBeVisible();
  await confirmTextDialog(page, 'Future Note');
  await expect(page.locator('.breadcrumb')).toContainText('Future Note.md');
});

test('Phase 3 knowledge drawer and Wiki links remain usable on mobile', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile');
  await createVault(page, 'Mobile Knowledge');

  await createNote(page, 'Target');
  await setEditorText(page, '# Target\n\nLinked content.');

  await createNote(page, 'Mobile');
  await setEditorText(page, '# Mobile\n\n[[Target]]');

  await page.locator('.knowledge-toggle').click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-knowledge-open', 'true');
  await expect(page.locator('.inspector')).toBeVisible();
  await expect(page.locator('.outline-item', { hasText: 'Mobile' })).toBeVisible();
  await page.locator('.inspector-close').click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-knowledge-open', 'false');

  await page.locator('[data-editor-mode="reading"]').click();
  await page.locator('.reading-document .vault-wiki-resolved', { hasText: 'Target' }).click();
  await expect(page.locator('.breadcrumb')).toContainText('Target.md');
  await expect(page.locator('.reading-document h1')).toHaveText('Target');
});
