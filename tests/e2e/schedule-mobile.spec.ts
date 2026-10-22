import { test, expect } from './fixtures';

// Narrow Schedule: the list replaces the week grid and details stack below it.
test('uses the list view and stacked details on a phone', async ({ page }) => {
  await page.goto('/schedule-host.html?date=2026-10-26&zone=Asia/Tokyo');
  await expect(page.getByLabel('Event list', { exact: true })).toBeVisible();
  await expect(page.getByRole('grid', { name: 'Week' })).toHaveCount(0);
  await page.getByRole('button', { name: 'New event', exact: true }).click();
  const details = page.getByRole('complementary', { name: 'Event details' });
  await details.getByLabel('Event title', { exact: true }).fill('Phone review');
  await details.getByLabel('Event title', { exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: /^Phone review,/ })).toBeVisible();
  // List cards are not dragged, so a swipe starting on one still scrolls.
  expect(
    await page
      .getByRole('button', { name: /^Phone review,/ })
      .evaluate((card) => getComputedStyle(card).touchAction),
  ).not.toBe('none');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
