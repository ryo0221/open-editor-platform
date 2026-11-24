import { create, expect, test } from './fixtures';

test('two Geo editors share a manually created layer and its Undo', async ({ page, browser, baseURL }) => {
  const peerContext = await browser.newContext({ baseURL });
  try {
    await page.goto('/');
    await create(page, 'geo');
    const menu = page.getByRole('button', { name: 'More artifact actions', exact: true });
    await menu.click();
    await page.getByRole('button', { name: 'Open collaboratively', exact: true }).click();
    await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
    await menu.click();
    const href = await page.getByRole('link', { name: 'Open peer editor', exact: true }).getAttribute('href');
    expect(href).toBeTruthy();
    await page.keyboard.press('Escape');
    const other = await peerContext.newPage();
    const errors: string[] = [];
    other.on('pageerror', (error) => errors.push(error.message));
    await other.goto(href!);
    await expect(other.locator('.save-status')).toContainText('Shared · confirmed');
    await page.getByRole('button', { name: 'Add layer', exact: true }).click();
    await expect(other.getByText('New layer', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(other.getByText('New layer', { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await peerContext.close();
  }
});
