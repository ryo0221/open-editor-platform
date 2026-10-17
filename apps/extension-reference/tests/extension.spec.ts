import { expect, test } from '@playwright/test';
test('independent production mount, history, persistence, read-only and uninstall', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  const value = page.getByLabel('Counter value');
  await expect(value).toHaveText('0');
  await page.getByRole('button', { name: 'Increment', exact: true }).click();
  await expect(value).toHaveText('1');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(value).toHaveText('0');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(value).toHaveText('1');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(value).toHaveText('0');
  await page.getByRole('button', { name: 'Reload saved draft' }).click();
  await expect(value).toHaveText('1');
  await page.getByLabel('Read-only').check();
  for (const name of ['Increment', 'Reset', 'Undo', 'Redo', 'Save']) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect(page.locator('section [role=status]')).toHaveText('Permission denied');
    await expect(value).toHaveText('1');
  }
  await page.screenshot({ path: testInfo.outputPath('readonly.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await expect(value).toHaveCount(0);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('extension.counter.draft')!).value),
  ).toBe(1);
  expect(errors).toEqual([]);
});
