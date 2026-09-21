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

async function createFolder(page: Page, name: string): Promise<void> {
  await ensureFilesOpen(page);
  await page.locator('.sidebar [data-command="folder.create"]').click();
  await confirmTextDialog(page, name);
  await expect(page.locator('.breadcrumb')).toContainText(name);
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

async function openFolder(page: Page, name: string): Promise<void> {
  await ensureFilesOpen(page);
  await page.getByRole('button', { name: `Folder ${name}` }).click();
  await expect(page.locator('.breadcrumb')).toContainText(name);
}

async function openCalendar(page: Page): Promise<void> {
  await ensureFilesOpen(page);
  await page.locator('[data-sidebar-panel="calendar"]').click();
  await expect(page.locator('.calendar-grid')).toBeVisible();
}

async function sourceText(page: Page): Promise<string> {
  await page.locator('[data-editor-mode="source"]').click();
  return (await page.locator('#vault-editor .cm-line').allTextContents()).join('\n');
}

test('Phase 6 templates, folder defaults, Daily Notes and calendar work end to end', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');
  await createVault(page, 'Planning Vault');
  await createNote(page, 'Home', '# Home');

  await createFolder(page, 'Templates');
  await createNote(page, 'Project Template', [
    '---',
    'kind: project',
    'created: {{date}}',
    '---',
    '# {{title}}',
    'Created {{date:DD.MM.YYYY}}',
    '',
    '{{cursor}}Start here.',
  ].join('\n'));

  await openFolder(page, 'Templates');
  await createNote(page, 'Daily Template', [
    '---',
    'date: {{date}}',
    'tags: [daily]',
    '---',
    '# {{weekday}}, {{date}}',
    '',
    '{{cursor}}',
  ].join('\n'));

  await ensureFilesOpen(page);
  await page.getByRole('button', { name: 'Note Home.md' }).click();
  await createFolder(page, 'Daily');
  await ensureFilesOpen(page);
  await page.getByRole('button', { name: 'Note Home.md' }).click();
  await createFolder(page, 'Projects');

  await openCalendar(page);
  await page.locator('.calendar-settings summary').click();
  await expect(page.locator('.templates-folder-select')).toBeVisible();
  await page.locator('.templates-folder-select').selectOption({ label: 'Templates' });
  await expect(page.locator('.default-template-select')).toContainText('Templates/Project Template.md');
  await expect(page.locator('.default-template-select')).toContainText('Templates/Daily Template.md');
  await page.locator('.default-template-select').selectOption({ label: 'Templates/Project Template.md' });
  await page.locator('.daily-folder-select').selectOption({ label: 'Daily' });
  await page.locator('.daily-template-select').selectOption({ label: 'Templates/Daily Template.md' });

  await page.locator('.folder-template-folder').selectOption({ label: 'Projects' });
  await page.locator('.folder-template-template').selectOption({ label: 'Templates/Project Template.md' });

  await openFolder(page, 'Projects');
  await page.locator('.sidebar [data-command="file.create"]').click();
  await confirmTextDialog(page, 'Roadmap');
  const roadmap = await sourceText(page);
  expect(roadmap).toContain('kind: project');
  expect(roadmap).toContain('# Roadmap');
  expect(roadmap).toContain('Start here.');
  expect(roadmap).not.toContain('{{title}}');
  expect(roadmap).not.toContain('{{cursor}}');

  await ensureFilesOpen(page);
  await page.locator('[data-sidebar-panel="files"]').click();
  await page.getByRole('button', { name: 'Note Roadmap.md' }).click();
  await page.locator('[data-action="insert-template"]').click();
  const dialog = page.locator('.template-dialog');
  await expect(dialog).toBeVisible();
  await page.locator('.template-dialog-select').selectOption({ label: 'Templates/Project Template.md' });
  await dialog.locator('button[value="confirm"]').click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('#vault-editor .cm-content')).toContainText('Created');

  const today = await page.evaluate(() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  });
  const tomorrow = await page.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  });

  await openCalendar(page);
  await page.locator('.daily-nav [data-daily-nav="0"]').click();
  await expect(page.locator('.breadcrumb')).toContainText(`Daily/${today}.md`);
  const dailyText = await sourceText(page);
  expect(dailyText).toContain(`date: ${today}`);
  expect(dailyText).toContain('tags:');
  expect(dailyText).not.toContain('{{date}}');

  await page.locator('.daily-document-nav [data-daily-nav="1"]').click();
  await expect(page.locator('.breadcrumb')).toContainText(`Daily/${tomorrow}.md`);
  await page.locator('.daily-document-nav [data-daily-nav="-1"]').click();
  await expect(page.locator('.breadcrumb')).toContainText(`Daily/${today}.md`);

  await ensureFilesOpen(page);
  await page.locator('[data-sidebar-panel="files"]').click();
  await page.getByRole('button', { name: 'Note Home.md' }).click();
  await createNote(page, 'Event', `---\ndue: ${today}\n---\n# Event`);

  await openCalendar(page);
  const day = page.locator(`[data-calendar-date="${today}"]`);
  await expect(day).toHaveClass(/has-daily/);
  await expect(day).toHaveClass(/has-associated/);
  await day.click();
  await expect(page.locator('.breadcrumb')).toContainText(`Daily/${today}.md`);
});

test('Phase 6 Calendar and default Daily Notes remain usable on mobile', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile');
  await createVault(page, 'Mobile Planning');

  await openCalendar(page);
  await expect(page.locator('.calendar-grid')).toBeVisible();
  await page.locator('.daily-nav [data-daily-nav="0"]').click();

  const expected = await page.evaluate(() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.md`;
  });
  await expect(page.locator('.breadcrumb')).toContainText(expected);
  await expect(page.locator('.daily-document-nav')).toBeVisible();

  const source = await sourceText(page);
  expect(source).toContain('date:');
  expect(source).toContain('# ');

  await ensureFilesOpen(page);
  await page.locator('[data-sidebar-panel="calendar"]').click();
  await expect(page.locator(`.calendar-day.has-daily`)).toBeVisible();
  await page.locator('.daily-nav [data-daily-nav="1"]').click();
  await expect(page.locator('.breadcrumb')).not.toContainText(expected);
});
