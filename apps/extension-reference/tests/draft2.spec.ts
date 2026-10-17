import { test, expect } from '@playwright/test';
test('fake async capture: newer edit, unknown write, explicit reconciliation and revoke', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/draft2.html');
  await page.getByRole('button', { name: 'Increment', exact: true }).click();
  await expect(page.getByLabel('Value', { exact: true })).toHaveText('1');
  await page.getByRole('button', { name: 'Save capture', exact: true }).click();
  await expect(page.getByLabel('Host outcome')).toHaveText('Captured');
  await page.getByRole('button', { name: 'Increment', exact: true }).click();
  await page.getByRole('button', { name: 'Advance settlement deadline' }).click();
  await expect(page.getByLabel('Extension save')).toHaveText('indeterminate');
  await page.getByRole('button', { name: 'Reconcile committed' }).click();
  await expect(page.getByLabel('Host outcome')).toHaveText('committed');
  await expect(page.getByLabel('Extension save')).toHaveText('indeterminate');
  await expect(page.getByLabel('Value', { exact: true })).toHaveText('2');
  await page.screenshot({ path: testInfo.outputPath('draft2-async.png'), fullPage: true });
  await page.getByRole('button', { name: 'Revoke scope' }).click();
  await expect(page.getByText('Scope revoked', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save capture', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
