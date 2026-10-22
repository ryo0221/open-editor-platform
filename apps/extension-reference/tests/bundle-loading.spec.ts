import { expect, test } from '@playwright/test';

test('normal Host refuses altered bundle bytes before mounting any extension', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let intercepted = false;
  await page.route('**/assets/*.js', async (route) => {
    const response = await route.fetch();
    const text = await response.text();
    if (!text.includes('Bundle verification failed')) {
      await route.fulfill({ response });
      return;
    }
    expect(text).toContain('Increment');
    intercepted = true;
    await route.fulfill({ response, body: text.replace('Increment', 'Tampered!') });
  });
  await page.goto('/');
  await expect(page.locator('#status')).toContainText(
    'Bundle verification failed: Error: Untrusted bundle pin',
  );
  expect(intercepted).toBe(true);
  await expect(page.locator('#surface')).toBeEmpty();
  await page.getByRole('button', { name: 'Install fixture 0.0.2', exact: true }).click();
  await expect(page.locator('#surface')).toBeEmpty();
  expect(errors).toEqual([]);
});
