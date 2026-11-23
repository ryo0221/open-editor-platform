import type { Page } from '@playwright/test';
import { test, expect, create } from './fixtures';

const surface = (page: Page) => page.getByRole('region', { name: 'マインドマップ', exact: true });

test('mobile: add a branch with the panel under the map', async ({ page }) => {
  await page.goto('/');
  await create(page, 'mindmap');
  const map = surface(page);
  await map.locator('.mindmap-node').first().click();
  await map.getByRole('button', { name: '子を足す', exact: true }).click();
  await map.getByLabel('名前', { exact: true }).fill('スマホで足した枝');
  await map.getByRole('button', { name: '適用', exact: true }).click();
  await expect(map.locator('.mindmap-node').filter({ hasText: 'スマホで足した枝' })).toBeVisible();
  // The panel stacks under the map and the page does not scroll sideways.
  const mapBox = (await map.locator('.mindmap-map').boundingBox())!;
  const panelBox = (await map.locator('.mindmap-panel').boundingBox())!;
  expect(panelBox.y).toBeGreaterThanOrEqual(mapBox.y + mapBox.height - 1);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: test.info().outputPath('mindmap-mobile.png') });
});
