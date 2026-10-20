import { test, expect } from './fixtures';
import { designHostCases } from './design-host-cases';
import { independentPrototype } from './design-prototype-fixtures';

designHostCases();

test('#291 Host controls toolbar overflow by container width and can change the threshold while mounted', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await independentPrototype(page, true, { hostContracts: true });
  const layout = page.locator('.ep-layout');
  const start = page.getByRole('button', { name: 'Open prototype', exact: true });
  await expect(layout).toHaveClass(/ep-compact/);
  await expect(start).toHaveCount(0);
  expect((await layout.boundingBox())!.width).toBe(1040);
  await page.getByLabel('Host compact breakpoint').fill('800');
  await expect(layout).not.toHaveClass(/ep-compact/);
  await expect(start).toBeVisible();
  await page.screenshot({ path: info.outputPath('design-host-1040.png') });
  await start.click();
  await expect(page.getByRole('dialog', { name: 'Design prototype', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Exit prototype', exact: true }).click();
  await page.getByLabel('Host compact breakpoint').fill('1040');
  await expect(layout).toHaveClass(/ep-compact/);
  await page.getByLabel('Host compact breakpoint').fill('800');
  await expect(start).toBeVisible();
  await page.getByLabel('Host container width').fill('800');
  await expect(layout).toHaveClass(/ep-compact/);
  await expect(layout).toHaveClass(/ep-narrow/);
  await page.getByLabel('Host container width').fill('801');
  await expect(layout).not.toHaveClass(/ep-compact/);
  await expect(layout).not.toHaveClass(/ep-narrow/);
  await expect(start).toBeVisible();
  await page.getByLabel('Host compact breakpoint').fill('-1');
  await expect(layout).toHaveClass(/ep-compact/);
  await page.getByLabel('Host compact breakpoint').fill('0');
  await expect(start).toBeVisible();
});
