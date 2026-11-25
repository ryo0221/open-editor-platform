import { create, expect, test } from './fixtures';

for (const width of [1440, 390]) {
  test(`Schedule and Document offer shared editing at ${width}px and a peer receives event changes`, async ({
    page,
    browser,
    baseURL,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await create(page, 'document');
    const menu = page.getByRole('button', { name: 'More artifact actions', exact: true });
    const startShared = page.getByRole('button', { name: 'Open collaboratively', exact: true });
    await menu.click();
    await expect(startShared).toBeVisible();
    await expect(startShared).toBeEnabled();
    await page.keyboard.press('Escape');

    await create(page, 'schedule');
    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await expect(startShared).toBeEnabled();
    await page.keyboard.press('Escape');
    await page.reload();
    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await expect(startShared).toBeEnabled();
    await page.screenshot({ path: info.outputPath(`schedule-actions-${width}.png`) });
    await startShared.click();
    await expect(page.locator('.save-status')).toContainText('Shared · confirmed');
    await menu.click();
    const peer = await page.getByRole('link', { name: 'Open peer editor' }).getAttribute('href');
    expect(peer).toBeTruthy();
    await page.keyboard.press('Escape');
    const context = await browser.newContext({ baseURL, viewport: { width, height: 900 } });
    try {
      const other = await context.newPage();
      const errors: string[] = [];
      other.on('pageerror', (error) => errors.push(error.message));
      await other.goto(peer!);
      await expect(other.locator('.save-status')).toContainText('Shared · confirmed');

      await page.getByRole('button', { name: 'New event', exact: true }).click();
      const title = page
        .getByRole('complementary', { name: 'Event details' })
        .getByLabel('Event title', { exact: true });
      await title.fill('Shared review');
      await title.press('Enter');
      await expect(other.getByRole('button', { name: /^Shared review,/ })).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
