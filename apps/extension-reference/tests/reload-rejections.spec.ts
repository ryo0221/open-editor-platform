import { expect, test } from '@playwright/test';

for (const rejection of ['invalid-json', 'invalid-content', 'read-only', 'uninstalled']) {
  test(`rejected reload preserves saved bytes and expected surface state: ${rejection}`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto('/');
    const value = page.getByLabel('Counter value');
    const click = (name: string) => page.getByRole('button', { name, exact: true }).click();
    const saved = () => page.evaluate(() => localStorage.getItem('extension.counter.draft'));
    await click('Increment');
    await click('Save');
    await expect.poll(saved).toBe('{"id":"counter","value":1}');
    await click('Increment');
    await expect(value).toHaveText('2');
    await click('Undo');
    await expect(value).toHaveText('1');
    if (rejection === 'invalid-json' || rejection === 'invalid-content') {
      await page.evaluate(
        (raw) => localStorage.setItem('extension.counter.draft', raw),
        rejection === 'invalid-json' ? '{' : '{"id":"counter","value":1001}',
      );
    }
    if (rejection === 'read-only') await page.getByLabel('Read-only').check();
    if (rejection === 'uninstalled') await click('Uninstall');
    const bytes = await saved();
    await click('Reload saved draft');
    const status = page.locator('#status');
    if (rejection === 'invalid-json') await expect(status).toContainText(/JSON/);
    if (rejection === 'invalid-content') await expect(status).toHaveText('Invalid saved draft');
    if (rejection === 'read-only') await expect(status).toHaveText('Permission denied');
    if (rejection === 'uninstalled') {
      await expect(status).toContainText('revoked');
      await expect(page.locator('#surface')).toBeEmpty();
    } else {
      await expect(value).toHaveText('1');
    }
    expect(await saved()).toBe(bytes);
    await page.screenshot({ path: info.outputPath('reload-refused.png'), fullPage: true });
    if (rejection !== 'uninstalled') {
      await page.getByLabel('Read-only').uncheck();
      // A rejected reload must not replace the session and erase pending Redo.
      await click('Redo');
      await expect(value).toHaveText('2');
      await click('Undo');
      await expect(value).toHaveText('1');
      expect(await saved()).toBe(bytes);
    }
    expect(errors).toEqual([]);
  });
}
