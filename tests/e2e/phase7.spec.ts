import { expect, test, type Locator, type Page } from '@playwright/test';

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

async function openPanel(page: Page, panel: 'files' | 'tasks' | 'calendar'): Promise<void> {
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
  const content = page.locator('#vault-editor .cm-content');
  await expect(content).toBeVisible();
  await content.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(text);
  await expect(page.locator('.save-status')).toContainText('Saved locally');
}

function taskCard(page: Page, title: string): Locator {
  return page.locator(`.task-card[data-task-text="${title.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]`);
}

async function sourceText(page: Page): Promise<string> {
  await page.locator('[data-editor-mode="source"]').click();
  return (await page.locator('#vault-editor .cm-line').allTextContents()).join('\n');
}

test('Phase 7 task management edits Markdown, recurs tasks and feeds Calendar', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');

  const dates = await page.evaluate(() => {
    const key = (date: Date) => {
      const pad = (value: number) => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    };
    const today = new Date();
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    const nextWeek = new Date(today); nextWeek.setDate(today.getDate() + 7);
    return { today: key(today), yesterday: key(yesterday), tomorrow: key(tomorrow), nextWeek: key(nextWeek) };
  });

  await createVault(page, 'Task Vault');
  await createNote(page, 'Tasks', [
    '# Tasks',
    `- [ ] Overdue report @due(${dates.yesterday}) @priority(high)`,
    `- [ ] Weekly review @due(${dates.today}) @repeat(weekly)`,
    `- [ ] Scheduled prep @scheduled(${dates.tomorrow}) @priority(low)`,
    `- [x] Finished task @done(${dates.yesterday})`,
  ].join('\n'));

  await openPanel(page, 'tasks');
  await expect(page.locator('.task-summary')).toContainText('3 open');
  await expect(page.locator('.task-summary')).toContainText('1 overdue');
  await expect(page.locator('.task-summary')).toContainText('1 today');
  await expect(taskCard(page, 'Overdue report')).toHaveClass(/task-state-overdue/);
  await expect(taskCard(page, 'Finished task')).toHaveCount(0);

  await page.locator('.task-status-filter').selectOption('all');
  await expect(taskCard(page, 'Finished task')).toBeVisible();

  await page.locator('.task-date-filter').selectOption('overdue');
  await expect(taskCard(page, 'Overdue report')).toBeVisible();
  await expect(taskCard(page, 'Weekly review')).toHaveCount(0);
  await page.locator('.task-date-filter').selectOption('all');

  let overdue = taskCard(page, 'Overdue report');
  const title = overdue.locator('.task-title-input');
  await title.fill('Send report');
  await title.press('Tab');
  await expect(taskCard(page, 'Send report')).toBeVisible();

  overdue = taskCard(page, 'Send report');
  await overdue.locator('.task-date-input').nth(1).fill(dates.today);
  await expect(taskCard(page, 'Send report').locator('.task-date-input').nth(1)).toHaveValue(dates.today);
  await taskCard(page, 'Send report').locator('.task-priority-input').selectOption('medium');
  await expect(taskCard(page, 'Send report').locator('.task-priority-input')).toHaveValue('medium');

  const weekly = taskCard(page, 'Weekly review');
  await weekly.locator('.task-check').check();
  await expect(taskCard(page, 'Weekly review')).toHaveCount(2);
  const openWeekly = page.locator('.task-card[data-task-text="Weekly review"]:not(.completed)');
  await expect(openWeekly.locator('.task-date-input').nth(1)).toHaveValue(dates.nextWeek);

  await openPanel(page, 'calendar');
  const todayCell = page.locator(`[data-calendar-date="${dates.today}"]`);
  await expect(todayCell).toHaveClass(/has-task/);

  await openPanel(page, 'tasks');
  await page.locator('.task-status-filter').selectOption('open');
  const send = taskCard(page, 'Send report');
  await send.locator('[data-task-action="source"]').click();
  await expect(page.locator('.breadcrumb')).toContainText('Tasks.md');

  const source = await sourceText(page);
  expect(source).toContain(`- [ ] Send report @due(${dates.today}) @priority(medium)`);
  expect(source).toContain(`- [x] Weekly review @due(${dates.today}) @repeat(weekly) @done(${dates.today})`);
  expect(source).toContain(`- [ ] Weekly review @due(${dates.nextWeek}) @repeat(weekly)`);
});

test('Phase 7 Tasks panel is usable on mobile and can add/complete tasks', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile');

  const today = await page.evaluate(() => {
    const date = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  });

  await createVault(page, 'Mobile Tasks');
  await createNote(page, 'Mobile', `# Mobile\n- [ ] Mobile task @due(${today})`);

  await openPanel(page, 'tasks');
  await expect(taskCard(page, 'Mobile task')).toBeVisible();
  await expect(page.locator('.task-summary')).toContainText('1 open');

  await taskCard(page, 'Mobile task').locator('.task-check').check();
  await expect(taskCard(page, 'Mobile task')).toHaveCount(0);
  await expect(page.locator('.task-summary')).toContainText('0 open');

  await page.locator('[data-task-action="add"]').click();
  await expect(taskCard(page, 'New task')).toBeVisible();

  const newTask = taskCard(page, 'New task').locator('.task-title-input');
  await newTask.fill('Phone follow-up');
  await newTask.press('Tab');
  await expect(taskCard(page, 'Phone follow-up')).toBeVisible();

  await openPanel(page, 'calendar');
  await expect(page.locator('.calendar-grid')).toBeVisible();
});
