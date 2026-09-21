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

async function ensureFilesOpen(page: Page): Promise<void> {
  const noteButton = page.locator('.sidebar [data-command="file.create"]');
  if (await noteButton.isVisible()) return;
  const workspace = page.locator('.workspace');
  const mobileToggle = page.locator('[data-action="files"]');
  if (await mobileToggle.isVisible()) {
    await expect(workspace).toHaveAttribute('data-sidebar-open', 'false');
    await mobileToggle.click();
    await expect(workspace).toHaveAttribute('data-sidebar-open', 'true');
  } else {
    await page.locator('[data-sidebar-panel="files"]').click();
  }
  await expect(noteButton).toBeVisible();
}

async function createVault(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.locator('.empty-state [data-command="vault.create"]').click();
  await confirmTextDialog(page, name);
  await expect(page.locator('#vault-vault')).toHaveValue(/.+/);
}

async function createNote(page: Page, name: string, text: string): Promise<void> {
  await ensureFilesOpen(page);
  await page.locator('.sidebar [data-command="file.create"]').click();
  await confirmTextDialog(page, name);
  const content = page.locator('#vault-editor .cm-content');
  await expect(content).toBeVisible();
  await content.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(text);
  await expect(page.locator('.save-status')).toContainText('Saved locally');
}

async function sourceText(page: Page): Promise<string> {
  await page.locator('[data-editor-mode="source"]').click();
  await expect(page.locator('#vault-editor')).toHaveAttribute('data-mode', 'source');
  return (await page.locator('#vault-editor .cm-line').allTextContents()).join('\n');
}

test('Phase 5 visual properties edit canonical frontmatter and reindex search', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');
  await createVault(page, 'Properties Vault');

  const body = '# Analysis\n\nBody stays exactly here.';
  await createNote(page, 'Analysis', [
    '---',
    '# keep this comment',
    'status: active',
    'rating: 5',
    'published: false',
    'due: 2026-09-25',
    'tags: [math, university/analysis]',
    'nested:',
    '  owner: Jonathan',
    '---',
    body,
  ].join('\n'));

  const statusRow = page.locator('.property-row[data-property-name="status"]');
  await expect(statusRow).toBeVisible();
  await expect(page.locator('.property-row[data-property-name="nested"] .property-type')).toBeDisabled();
  await expect(page.locator('.property-row[data-property-name="rating"] .property-type')).toHaveValue('number');
  await expect(page.locator('.property-row[data-property-name="published"] .property-type')).toHaveValue('checkbox');
  await expect(page.locator('.property-row[data-property-name="due"] .property-type')).toHaveValue('date');
  await expect(page.locator('.property-row[data-property-name="tags"] .property-type')).toHaveValue('tags');

  const statusValue = statusRow.locator('.property-value');
  await statusValue.fill('review');
  await statusValue.press('Tab');
  await expect(statusRow.locator('.property-value')).toHaveValue('review');

  const ratingValue = page.locator('.property-row[data-property-name="rating"] .property-value');
  await ratingValue.fill('6');
  await ratingValue.press('Tab');
  await expect(page.locator('.property-row[data-property-name="rating"] .property-value')).toHaveValue('6');

  await page.locator('.property-row[data-property-name="published"] .property-checkbox').click();
  await expect(page.locator('.property-row[data-property-name="published"] .property-checkbox')).toBeChecked();

  const tags = page.locator('.property-row[data-property-name="tags"] .property-value');
  await tags.fill('math, analysis/new');
  await tags.press('Tab');
  await expect(page.locator('.property-row[data-property-name="tags"] .property-value')).toHaveValue('math, analysis/new');

  const due = page.locator('.property-row[data-property-name="due"] .property-value');
  await due.fill('2026-10-01');
  await due.press('Tab');
  await expect(page.locator('.property-row[data-property-name="due"] .property-value')).toHaveValue('2026-10-01');

  await page.locator('[data-property-action="add"]').click();
  await confirmTextDialog(page, 'priority');
  const priority = page.locator('.property-row[data-property-name="priority"]');
  await expect(priority).toBeVisible();
  await priority.locator('.property-value').fill('7');
  await priority.locator('.property-value').press('Tab');
  await priority.locator('.property-type').selectOption('number');
  await expect(page.locator('.property-row[data-property-name="priority"] .property-type')).toHaveValue('number');

  const priorityName = page.locator('.property-row[data-property-name="priority"] .property-name');
  await priorityName.fill('importance');
  await priorityName.dispatchEvent('change');
  await expect(page.locator('.property-row[data-property-name="importance"]')).toBeVisible();

  await page.locator('.property-row[data-property-name="status"] .property-delete').click();
  await expect(page.locator('.property-row[data-property-name="status"]')).toHaveCount(0);

  const source = await sourceText(page);
  expect(source).toContain('# keep this comment');
  expect(source).toContain('rating: 6');
  expect(source).toContain('published: true');
  expect(source).toContain('due: 2026-10-01');
  expect(source).toContain('importance: 7');
  expect(source).toContain('owner: Jonathan');
  expect(source).not.toContain('status:');
  expect(source.endsWith(body)).toBe(true);

  await ensureFilesOpen(page);
  await page.locator('[data-sidebar-panel="search"]').click();
  const search = page.locator('.global-search');
  await search.fill('property:importance>=7 tag:#analysis/new');
  await expect(page.locator('.search-result', { hasText: 'Analysis' })).toBeVisible();

  await page.locator('[data-sidebar-panel="files"]').click();
  await page.getByRole('button', { name: 'Note Analysis.md' }).click();
  await page.locator('[data-editor-mode="source"]').click();
  const editor = page.locator('#vault-editor .cm-content');
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(['---', 'nested:', '  owner: Jonathan', '---', '# Complex'].join('\n'));
  await expect(page.locator('.property-row[data-property-name="nested"] .property-type')).toBeDisabled({ timeout: 5000 });
  await expect(page.locator('.property-complex')).toContainText('owner');
  await page.locator('[data-property-action="source"]').click();
  await expect(page.locator('#vault-editor')).toHaveAttribute('data-mode', 'source');
});

test('Phase 5 properties remain usable and persistent on mobile', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile');
  await createVault(page, 'Mobile Properties');
  await createNote(page, 'Mobile', ['---', 'status: active', 'tags: [mobile]', '---', '# Mobile'].join('\n'));

  const details = page.locator('[data-action="knowledge-panel"].knowledge-toggle');
  await expect(details).toBeVisible();
  await details.click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-knowledge-open', 'true');
  const status = page.locator('.property-row[data-property-name="status"] .property-value');
  await expect(status).toBeVisible();
  await status.fill('done');
  await status.press('Tab');
  await expect(page.locator('.property-row[data-property-name="status"] .property-value')).toHaveValue('done');

  await page.locator('.inspector-close').click();
  await page.reload();
  await expect(page.locator('.breadcrumb')).toContainText('Mobile.md');
  await details.click();
  await expect(page.locator('.property-row[data-property-name="status"] .property-value')).toHaveValue('done');
});
