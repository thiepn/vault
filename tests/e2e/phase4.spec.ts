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
  if (!(await noteButton.isVisible())) {
    await page.locator('[data-action="files"]').click();
    await expect(page.locator('.workspace')).toHaveAttribute('data-sidebar-open', 'true');
  }
  await page.locator('[data-sidebar-panel="files"]').click();
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

async function waitIndexed(page: Page, count: number): Promise<void> {
  await expect.poll(async () => page.locator('.search-index-status').textContent(), { timeout: 10_000 })
    .toContain(count + ' indexed');
}

async function openSearch(page: Page): Promise<void> {
  await ensureFilesOpen(page);
  await page.locator('[data-sidebar-panel="search"]').click();
  await expect(page.locator('.global-search')).toBeVisible();
}

test('Phase 4 worker search, structured filters, facets and quick switcher work on desktop', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');
  await createVault(page, 'Search Vault');

  await createNote(page, 'Analysis', [
    '---',
    'aliases: [Analysis Two]',
    'tags: [math, university/analysis]',
    'status: active',
    'rating: 5',
    '---',
    '# Uniform Continuity',
    'The Heine theorem characterizes uniform continuity.',
    '#analysis/continuity',
    '- [ ] Prove the theorem',
  ].join('\n'));

  await createNote(page, 'Archive', [
    '---',
    'tags: [math, archive]',
    'status: archived',
    'rating: 2',
    '---',
    '# Old Notes',
    'Historical continuity material.',
    '- [x] Review old proof',
  ].join('\n'));

  await waitIndexed(page, 2);
  await openSearch(page);

  const search = page.locator('.global-search');
  await search.fill('uniform continuity');
  await expect(page.locator('.search-result', { hasText: 'Analysis' })).toBeVisible();

  await search.fill('tag:#math property:status=active task:open');
  const structured = page.locator('.search-result');
  await expect(structured).toHaveCount(1);
  await expect(structured.first()).toContainText('Analysis');

  await search.fill('continuity NOT tag:#archive');
  await expect(page.locator('.search-result')).toHaveCount(1);
  await expect(page.locator('.search-result').first()).toContainText('Analysis');

  await search.fill('"uniform continuity"');
  const exact = page.locator('.search-result', { hasText: 'Analysis' });
  await expect(exact).toBeVisible();
  await exact.click();
  await expect(page.locator('.breadcrumb')).toContainText('Analysis.md');

  await ensureFilesOpen(page);
  await page.locator('[data-sidebar-panel="tags"]').click();
  await expect(page.locator('.facet-item', { hasText: '#math' })).toBeVisible();
  await expect(page.locator('.facet-item', { hasText: 'status' })).toBeVisible();
  await page.locator('.facet-item', { hasText: '#archive' }).click();
  await expect(page.locator('.global-search')).toHaveValue('tag:#archive');
  await expect(page.locator('.search-result')).toHaveCount(1);
  await expect(page.locator('.search-result').first()).toContainText('Archive');

  await page.keyboard.press('Control+O');
  const quick = page.locator('.quick-switcher-dialog');
  await expect(quick).toBeVisible();
  await page.locator('.quick-switcher-input').fill('Analysis Two');
  await expect(page.locator('.quick-result', { hasText: 'Analysis Two' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(quick).not.toBeVisible();
  await expect(page.locator('.breadcrumb')).toContainText('Analysis.md');

  const editor = page.locator('#vault-editor .cm-content');
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\nbrandnewsearchterm');
  await expect(page.locator('.save-status')).toContainText('Saved locally');

  await openSearch(page);
  await search.fill('brandnewsearchterm');
  await expect(page.locator('.search-result', { hasText: 'Analysis' })).toBeVisible();

  await search.fill('path:University file:Analysis');
  await expect(page.locator('.search-result', { hasText: 'Analysis' })).toBeVisible();

  await page.locator('[data-action="rebuild-search"]').click();
  await expect.poll(async () => page.locator('.search-index-status').textContent(), { timeout: 10_000 }).toContain('2 indexed');
});

test('Phase 4 search and tag navigation remain usable on mobile', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile');
  await createVault(page, 'Mobile Search');

  await createNote(page, 'French', [
    '---',
    'tags: [language/french]',
    'level: A2',
    '---',
    '# Vocabulary',
    'bonjour monde',
  ].join('\n'));

  await waitIndexed(page, 1);
  await ensureFilesOpen(page);
  await page.locator('[data-sidebar-panel="search"]').click();
  const search = page.locator('.global-search');
  await search.fill('bonjour');
  const result = page.locator('.search-result', { hasText: 'French' });
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.locator('.breadcrumb')).toContainText('French.md');

  await ensureFilesOpen(page);
  await page.locator('[data-sidebar-panel="tags"]').click();
  await expect(page.locator('.facet-item', { hasText: '#language/french' })).toBeVisible();
});
