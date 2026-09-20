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

async function editorText(page: Page): Promise<string> {
  const lines = await page.locator('#vault-editor .cm-line').allTextContents();
  return lines.join('\n');
}

async function createNote(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('.empty-state [data-command="vault.create"]').click();
  await confirmTextDialog(page, 'Phase 2');
  await page.locator('[data-command="file.create"]').click();
  await confirmTextDialog(page, 'Editor');
}

test('professional Markdown editor and reading renderer work end to end', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');
  await createNote(page);

  const markdown = [
    '# Phase 2',
    '',
    'This is **bold**, *italic*, and `inline code`.',
    '',
    '> [!NOTE]',
    '> A rendered callout.',
    '',
    '| Name | Score |',
    '| --- | ---: |',
    '| Vault | 10 |',
    '',
    '$$',
    'e^{i\\pi}+1=0',
    '$$',
    '',
    '```javascript',
    'const answer = 42;',
    '```',
    '',
    '```mermaid',
    'graph TD',
    'A --> B',
    '```',
    '',
    '<img src="x" onerror="window.__vaultXss=1">',
    '<script>window.__vaultXss=2</script>',
  ].join('\n');

  await setEditorText(page, markdown);
  await expect(page.locator('.save-status')).toContainText('Saved locally');
  await expect(page.locator('#vault-editor')).toHaveAttribute('data-mode', 'live');
  await expect(page.locator('.cm-live-h1')).toBeVisible();

  await page.locator('[data-editor-action="search"]').click();
  await expect(page.locator('.cm-search')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.locator('[data-editor-action="line-numbers"]').click();
  await expect(page.locator('#vault-editor')).toHaveAttribute('data-line-numbers', 'true');
  await expect(page.locator('[data-editor-action="line-numbers"]')).toHaveAttribute('aria-pressed', 'true');

  await page.locator('[data-editor-mode="reading"]').click();
  await expect(page.locator('.reading-view')).toBeVisible();
  await expect(page.locator('.reading-document h1')).toHaveText('Phase 2');
  await expect(page.locator('.reading-document table')).toBeVisible();
  await expect(page.locator('.reading-document .katex')).toBeVisible();
  await expect(page.locator('.reading-document .callout-note')).toContainText('A rendered callout.');
  await expect(page.locator('.reading-document .hljs')).toContainText('const answer = 42;');
  await expect(page.locator('.reading-document .mermaid-diagram svg')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.reading-document script')).toHaveCount(0);
  await expect(page.locator('.reading-document [onerror]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __vaultXss?: number }).__vaultXss)).toBeUndefined();

  await page.locator('[data-editor-mode="source"]').click();
  await expect(page.locator('#vault-editor')).toHaveAttribute('data-mode', 'source');
  await expect(page.locator('.cm-live-h1')).toHaveCount(0);
  expect(await editorText(page)).toBe(markdown);

  const content = page.locator('#vault-editor .cm-content');
  await content.click();
  await page.keyboard.press('Control+A');
  await page.locator('[data-editor-command="bold"]').click();
  await expect.poll(() => editorText(page)).toBe(`**${markdown}**`);

  await page.reload();
  await expect.poll(() => editorText(page)).toBe(`**${markdown}**`);
  await expect(page.locator('#vault-editor')).toHaveAttribute('data-line-numbers', 'true');
});

test('mobile editor toolbar and mode switch remain usable', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile');
  await createNote(page);

  await expect(page.locator('.editor-toolbar')).toBeVisible();
  await setEditorText(page, '# Mobile editor\n\nText');
  await page.locator('[data-editor-mode="reading"]').click();
  await expect(page.locator('.reading-document h1')).toHaveText('Mobile editor');
  await page.locator('[data-editor-mode="live"]').click();
  await expect(page.locator('#vault-editor .cm-content')).toBeVisible();
  await expect(page.locator('.cm-live-h1')).toBeVisible();
});
