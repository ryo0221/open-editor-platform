import { expect, test } from '@playwright/test';

test('fixture pin switches retain draft, redo and saved bytes while revoking old surfaces', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  const value = page.getByLabel('Counter value');
  const pin = page.getByLabel('Installed fixture');
  const action = (name: string) => page.getByRole('button', { name, exact: true }).click();
  const saved = () => page.evaluate(() => localStorage.getItem('extension.counter.draft'));
  await expect(pin).toHaveText(/^Fixture 0\.0\.1 · sha256:[a-f0-9]{64}$/);
  const firstPin = await pin.textContent();
  await action('Increment');
  await action('Save');
  const bytes = await saved();
  expect(bytes).toBe(JSON.stringify({ id: 'counter', value: 1 }));
  await action('Increment');
  await action('Undo');
  await expect(value).toHaveText('1');
  const oldSurface = await page.locator('#surface section').elementHandle();
  expect(oldSurface).not.toBeNull();
  await page.getByLabel('Read-only').check();
  await action('Install fixture 0.0.2');
  await expect(pin).toHaveText(/^Fixture 0\.0\.2 · sha256:[a-f0-9]{64}$/);
  await expect(page.locator('#surface section')).toHaveCount(1);
  await expect(value).toHaveText('1');
  await action('Increment');
  await expect(page.locator('#surface [role=status]')).toHaveText('Permission denied');
  const secondSurface = await page.locator('#surface section').elementHandle();
  expect(secondSurface).not.toBeNull();
  await action('Restore fixture 0.0.1');
  await expect(pin).toHaveText(/^Fixture 0\.0\.1 · sha256:[a-f0-9]{64}$/);
  await expect(pin).toHaveText(firstPin!);
  await expect(page.locator('#surface section')).toHaveCount(1);
  await expect(value).toHaveText('1');
  expect(await saved()).toBe(bytes);
  await page.getByLabel('Read-only').uncheck();
  // Detached controls retain their listeners, but their registry handles are revoked.
  for (const surface of [oldSurface!, secondSurface!]) {
    await surface.evaluate(async (node) => {
      for (const button of node.querySelectorAll('button')) {
        button.click();
        await Promise.resolve();
      }
    });
    expect(await surface.evaluate((node) => node.querySelector('[role=status]')?.textContent)).toBe(
      'Registration revoked',
    );
  }
  await expect(value).toHaveText('1');
  expect(await saved()).toBe(bytes);
  await action('Redo');
  await expect(value).toHaveText('2');
  await action('Undo');
  await expect(value).toHaveText('1');
  await action('Uninstall');
  await expect(pin).toHaveText('No fixture installed');
  await expect(value).toHaveCount(0);
  expect(await saved()).toBe(bytes);
  await action('Install fixture 0.0.2');
  await expect(page.locator('#surface section')).toHaveCount(1);
  await expect(value).toHaveText('1');
  await action('Redo');
  await expect(value).toHaveText('2');
  expect(await saved()).toBe(bytes);
  await action('Reload saved draft');
  await expect(value).toHaveText('1');
  await expect(page.locator('#surface section')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('fixture-switch.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
