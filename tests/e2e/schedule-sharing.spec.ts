import { create, expect, test } from './fixtures';

for (const width of [1440, 390]) {
  test(`Schedule hides unsupported shared editing while Document keeps it at ${width}px`, async ({
    page,
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
    await expect(startShared).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.reload();
    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await expect(startShared).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`schedule-actions-${width}.png`) });
  });
}
