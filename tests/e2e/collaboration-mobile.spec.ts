import { test, expect } from '@playwright/test';
test('mobile collaboration reference edits data, retains private view and exports', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`/collaboration.html?room=mobile-${Date.now()}&actor=A&domain=data`);
  await expect(page.getByRole('status')).toContainText('Connected');
  await page.getByLabel('row1 value', { exact: true }).fill('42');
  await page.getByLabel('row1 value', { exact: true }).press('Tab');
  await expect(page.getByTestId('confirmed-content')).toContainText('42');
  await page.getByRole('button', { name: 'Save confirmed version' }).click();
  await expect(page.getByRole('status')).toContainText('Saved immutable version');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export confirmed' }).click();
  expect((await download).suggestedFilename()).toBe('data.csv');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
