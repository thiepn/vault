import { expect, test, type Page } from '@playwright/test';

async function confirmTextDialog(page: Page, value: string): Promise<void> {
  const dialog = page.locator('.form-dialog');
  await expect(dialog).toBeVisible();
  const input = dialog.locator('#vault-dialog-input');
  await input.fill(value);
  await dialog.locator('button[value="confirm"]').click();
  await expect(dialog).not.toBeVisible();
}

async function ensureSidebarOpen(page: Page): Promise<void> {
  const tabs = page.locator('.sidebar-tabs');
  if (await tabs.isVisible()) return;
  const workspace = page.locator('.workspace');
  const toggle = page.locator('[data-action="files"]');
  await toggle.click();
  await expect(workspace).toHaveAttribute('data-sidebar-open', 'true');
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
  const content = page.locator('#vault-editor .cm-content');
  await expect(content).toBeVisible();
  await content.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(text);
  await expect(page.locator('.save-status')).toContainText('Saved locally');
}

async function quickOpen(page: Page, title: string): Promise<void> {
  await page.locator('[data-action="quick-switcher"]').click();
  const dialog = page.locator('.quick-switcher-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('.quick-switcher-input').fill(title);
  const result = dialog.locator('.quick-result').filter({ hasText: title }).first();
  await expect(result).toBeVisible();
  await result.click();
  await expect(dialog).not.toBeVisible();
}

async function sourceText(page: Page): Promise<string> {
  await page.locator('[data-editor-mode="source"]').click();
  return (await page.locator('#vault-editor .cm-line').allTextContents()).join('\n');
}

test('Phase 8 renders live table/task queries and task actions mutate canonical Markdown', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');

  await createVault(page, 'Query Vault');
  await createNote(page, 'Alpha', [
    '---',
    'tags: [project/math]',
    'status: active',
    'score: 2',
    '---',
    '# Alpha',
    '- [ ] Ship Alpha @priority(high)',
  ].join('\n'));
  await createNote(page, 'Beta', [
    '---',
    'tags: [project]',
    'status: active',
    'score: 8',
    '---',
    '# Beta',
  ].join('\n'));
  await createNote(page, 'Archive', [
    '---',
    'tags: [project]',
    'status: archived',
    'score: 99',
    '---',
    '# Archive',
  ].join('\n'));
  await createNote(page, 'Dashboard', [
    '# Dashboard',
    '',
    '```vault-query',
    'view: table',
    'title: Active projects',
    'query: tag:#project AND property:status=active',
    'fields: file, property:score, tags',
    'sort: property:score desc',
    'exclude-self: true',
    '```',
    '',
    '```vault-query',
    'view: tasks',
    'title: Project tasks',
    'query: tag:#project',
    'task-status: open',
    'task-priority: high',
    '```',
  ].join('\n'));

  await expect(page.locator('[data-action="insert-query"]')).toBeVisible();
  const liveEditor = page.locator('#vault-editor .cm-content');
  await liveEditor.click();
  await page.keyboard.press('Control+Home');
  await expect(page.locator('#vault-editor .cm-query-widget .query-view[data-query-view="table"]')).toBeVisible();
  await expect(page.locator('#vault-editor .cm-query-widget .query-view[data-query-view="tasks"]')).toBeVisible();

  await page.locator('[data-editor-mode="reading"]').click();

  const tableView = page.locator('.reading-view .query-view[data-query-view="table"]');
  const taskView = page.locator('.reading-view .query-view[data-query-view="tasks"]');
  await expect(tableView).toBeVisible();
  await expect(taskView).toBeVisible();
  await expect(tableView.locator('.query-view-header')).toContainText('Active projects');
  await expect(tableView.locator('.query-table-file')).toHaveCount(2);
  await expect(tableView.locator('.query-table-file').nth(0)).toHaveText('Beta');
  await expect(tableView.locator('.query-table-file').nth(1)).toHaveText('Alpha');
  await expect(tableView).not.toContainText('Archive');
  await expect(taskView.locator('.query-task-title')).toHaveText('Ship Alpha');

  await tableView.locator('.query-table-file').filter({ hasText: 'Alpha' }).click();
  await expect(page.locator('.breadcrumb')).toContainText('Alpha.md');

  await quickOpen(page, 'Dashboard');
  await expect(page.locator('.query-view[data-query-view="tasks"] .query-task-title')).toHaveText('Ship Alpha');
  await page.locator('.query-view[data-query-view="tasks"] .query-task-row > input').check();
  await expect(page.locator('.query-view[data-query-view="tasks"] .query-empty')).toContainText('No tasks match');

  await quickOpen(page, 'Alpha');
  const source = await sourceText(page);
  expect(source).toContain('- [x] Ship Alpha @priority(high)');
  expect(source).toMatch(/@done\(\d{4}-\d{2}-\d{2}\)/u);
});

test('Phase 8 dynamic list view remains usable on mobile', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile');

  await createVault(page, 'Mobile Query Vault');
  await createNote(page, 'Reference', [
    '---',
    'tags: [reference]',
    'kind: guide',
    '---',
    '# Reference',
  ].join('\n'));
  await createNote(page, 'Mobile Dashboard', [
    '# Mobile Dashboard',
    '',
    '```vault-query',
    'view: list',
    'title: References',
    'query: tag:#reference',
    'fields: file, path, property:kind',
    'limit: 10',
    '```',
  ].join('\n'));

  const liveEditor = page.locator('#vault-editor .cm-content');
  await liveEditor.click();
  await page.keyboard.press('Control+Home');
  await expect(page.locator('#vault-editor .cm-query-widget .query-view[data-query-view="list"]')).toBeVisible();

  await page.locator('[data-editor-mode="reading"]').click();
  const view = page.locator('.reading-view .query-view[data-query-view="list"]');
  await expect(view).toBeVisible();
  await expect(view.locator('.query-view-header')).toContainText('References');
  await expect(view.locator('.query-note-row')).toHaveCount(1);
  await expect(view.locator('.query-note-title')).toHaveText('Reference');
  await expect(view.locator('.query-note-detail')).toContainText('guide');

  await view.locator('.query-note-row').click();
  await expect(page.locator('.breadcrumb')).toContainText('Reference.md');
});
