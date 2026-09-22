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

const boardDefinition = [
  '# Project board',
  '',
  '```vault-board',
  'title: Projects',
  'query: tag:#project',
  'group-by: property:status',
  'columns: backlog=Backlog, todo=To do, doing=Doing, done=Done',
  'card-fields: property:priority, tags',
  'sort: file asc',
  'exclude-self: true',
  '```',
].join('\n');

test('Phase 11 Live Preview drag/drop and Reading board moves update canonical YAML', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');

  await createVault(page, 'Board Vault');
  await createNote(page, 'Alpha', [
    '---',
    'tags: [project]',
    'status: todo',
    'priority: high',
    '---',
    '# Alpha',
  ].join('\n'));
  await createNote(page, 'Beta', [
    '---',
    'tags: [project]',
    'status: doing',
    'priority: medium',
    '---',
    '# Beta',
  ].join('\n'));
  await createNote(page, 'Loose', [
    '---',
    'tags: [project]',
    '---',
    '# Loose',
  ].join('\n'));
  await createNote(page, 'Dashboard', boardDefinition);

  await expect(page.locator('[data-action="insert-board"]')).toBeVisible();
  const editor = page.locator('#vault-editor .cm-content');
  await editor.click();
  await page.keyboard.press('Control+Home');

  const liveBoard = page.locator('#vault-editor .cm-board-widget .board-view');
  await expect(liveBoard).toBeVisible();
  await expect(liveBoard.locator('.board-view-header')).toContainText('Projects');
  await expect(liveBoard.locator('.board-card')).toHaveCount(3);
  await expect(liveBoard.locator('.board-column[data-board-column="todo"] .board-card-title')).toHaveText('Alpha');
  await expect(liveBoard.locator('.board-column[data-board-column="doing"] .board-card-title')).toHaveText('Beta');
  await expect(liveBoard.locator('.board-column[data-board-column=""] .board-card-title')).toHaveText('Loose');

  const alpha = liveBoard.locator('.board-card').filter({ hasText:'Alpha' });
  const doing = liveBoard.locator('.board-card-list[data-board-drop="doing"]');
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await alpha.dispatchEvent('dragstart', { dataTransfer:transfer });
  await doing.dispatchEvent('dragover', { dataTransfer:transfer });
  await doing.dispatchEvent('drop', { dataTransfer:transfer });
  await alpha.dispatchEvent('dragend', { dataTransfer:transfer }).catch(() => undefined);

  await expect(liveBoard.locator('.board-column[data-board-column="doing"] .board-card-title')).toHaveCount(2);
  await expect(liveBoard.locator('.board-column[data-board-column="todo"] .board-card-title')).toHaveCount(0);

  await quickOpen(page, 'Alpha');
  let source = await sourceText(page);
  expect(source).toContain('status: doing');
  expect(source).not.toContain('status: todo');

  await quickOpen(page, 'Dashboard');
  await page.locator('[data-editor-mode="reading"]').click();
  const readingBoard = page.locator('.reading-view .board-view');
  await expect(readingBoard).toBeVisible();
  await expect(readingBoard.locator('.board-column[data-board-column="doing"] .board-card-title')).toHaveCount(2);

  const readingAlpha = readingBoard.locator('.board-card').filter({ hasText:'Alpha' });
  await readingAlpha.locator('.board-card-move').selectOption('done');
  await expect(readingBoard.locator('.board-column[data-board-column="done"] .board-card-title')).toHaveText('Alpha');

  await quickOpen(page, 'Alpha');
  source = await sourceText(page);
  expect(source).toContain('status: done');

  await page.reload();
  await quickOpen(page, 'Dashboard');
  await page.locator('[data-editor-mode="reading"]').click();
  await expect(page.locator('.reading-view .board-column[data-board-column="done"] .board-card-title')).toHaveText('Alpha');
});

test('Phase 11 board lane selector remains usable on mobile', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile');

  await createVault(page, 'Mobile Board');
  await createNote(page, 'Card', [
    '---',
    'tags: [project]',
    'status: todo',
    '---',
    '# Card',
  ].join('\n'));
  await createNote(page, 'Dashboard', boardDefinition);

  const editor = page.locator('#vault-editor .cm-content');
  await editor.click();
  await page.keyboard.press('Control+Home');
  const board = page.locator('#vault-editor .cm-board-widget .board-view');
  await expect(board).toBeVisible();
  await expect(board.locator('.board-column[data-board-column="todo"] .board-card-title')).toHaveText('Card');

  await board.locator('.board-card').filter({ hasText:'Card' }).locator('.board-card-move').selectOption('doing');
  await expect(board.locator('.board-column[data-board-column="doing"] .board-card-title')).toHaveText('Card');

  await quickOpen(page, 'Card');
  const source = await sourceText(page);
  expect(source).toContain('status: doing');
});
