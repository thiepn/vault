import { expect, test, type Page } from '@playwright/test';

async function confirmTextDialog(page: Page, value: string): Promise<void> {
  const dialog = page.locator('.form-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('#vault-dialog-input').fill(value);
  await dialog.locator('button[value="confirm"]').click();
  await expect(dialog).not.toBeVisible();
}

async function createVault(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.locator('.empty-state [data-command="vault.create"]').click();
  await confirmTextDialog(page, name);
  await expect(page.locator('#vault-vault')).toHaveValue(/.+/);
}

async function createNote(page: Page, name: string, text: string): Promise<void> {
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
  const source = page.locator('[data-editor-mode="source"]');
  await source.click();
  await expect(source).toHaveAttribute('aria-pressed', 'true');
  return (await page.locator('#vault-editor .cm-line').allTextContents()).join('\n');
}

function taskId(text: string): string {
  const match = /<!--\s*vault:task=([0-9a-f-]{36})\s*-->/iu.exec(text);
  if (!match) throw new Error('Missing A2 task identity marker.');
  return match[1]!.toLowerCase();
}

test('A2 task identity survives reload and note duplication rekeys copied tasks', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');

  await createVault(page, 'A2 Identity');
  await createNote(page, 'Tasks', '# Tasks\n- [ ] Stable task\n');

  const firstSource = await sourceText(page);
  const originalTaskId = taskId(firstSource);
  expect(originalTaskId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/u);

  await expect.poll(async () => page.evaluate(async id => {
    return new Promise<boolean>((resolve, reject) => {
      const request = indexedDB.open('vault:local');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('entities', 'readonly');
        const get = transaction.objectStore('entities').get(id);
        get.onerror = () => { database.close(); reject(get.error); };
        get.onsuccess = () => {
          const value = get.result as { entityType?: string; title?: string } | undefined;
          database.close();
          resolve(value?.entityType === 'task' && value.title === 'Stable task');
        };
      };
    });
  }, originalTaskId)).toBe(true);

  await page.reload();
  const afterReload = await sourceText(page);
  expect(taskId(afterReload)).toBe(originalTaskId);

  await page.locator('[data-action="duplicate"]').click();
  await expect(page.locator('.breadcrumb')).toContainText('Tasks copy.md');
  const copiedSource = await sourceText(page);
  const copiedTaskId = taskId(copiedSource);
  expect(copiedTaskId).not.toBe(originalTaskId);
  expect(copiedTaskId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/u);
});

test('A2 PWA cold-starts offline and opens durable local data', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');

  await createVault(page, 'Offline A2');
  await createNote(page, 'Offline Note', '# Offline\n\nThis survives a cold offline reload.');

  await expect.poll(async () => page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false;
    await navigator.serviceWorker.ready;
    const keys = await caches.keys();
    return navigator.serviceWorker.controller !== null && document.documentElement.dataset.offlineShell === 'ready' && keys.some(key => key.startsWith('vault-shell-'));
  }), { timeout: 10_000 }).toBe(true);

  await expect.poll(async () => page.evaluate(async () => {
    const cache = await caches.open('vault-shell-a2-v2');
    const keys = await cache.keys();
    return keys.some(request => /\/assets\/.*\.js(?:$|\?)/u.test(request.url));
  }), { timeout: 10_000 }).toBe(true);

  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveTitle('Vault');
    await expect(page.locator('.breadcrumb')).toContainText('Offline Note.md');
    await expect(page.locator('#vault-editor .cm-content')).toContainText('This survives a cold offline reload.');
    await expect(page.locator('.save-status')).toContainText('Saved locally');
  } finally {
    await context.setOffline(false);
  }
});
