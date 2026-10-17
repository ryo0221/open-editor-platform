import { test, expect } from '@playwright/test';
import type {} from '../test-host/edit-test';

for (const kind of ['table', 'map'] as const) {
  test(`${kind} keyboard selection preserves focus and native history`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/edit.html');
    const before = await page.evaluate(() => window.geoEditTest.state());
    const name = kind === 'table' ? 'Select point-2 (Point)' : 'Select point point-2;';
    const target = page.getByRole('button', { name, exact: kind === 'table' });
    const original = await target.elementHandle();
    await target.focus();
    await page.keyboard.press('Enter');
    await expect(target).toBeFocused();
    expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(target).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.geo-point-editor')).toContainText('Target synthetic-sites/point-2');
    const after = await page.evaluate(() => window.geoEditTest.state());
    expect(after.hash).toBe(before.hash);
    expect(after.revision).toEqual(before.revision);
    await page.keyboard.press('Tab');
    await expect(target).not.toBeFocused();
    expect(errors).toEqual([]);
  });
}

test('scalar field selection keeps its keyboard focus after form replacement', async ({ page }) => {
  await page.goto('/edit.html');
  const selector = page.getByLabel('Scalar field', { exact: true });
  await selector.focus();
  await selector.selectOption('code');
  await expect(selector).toBeFocused();
  await expect(selector).toHaveValue('code');
  await expect(page.getByLabel('Scalar value', { exact: true })).toHaveValue('001');
});
