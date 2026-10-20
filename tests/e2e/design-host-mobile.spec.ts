import { test, expect } from './fixtures';
import { designHostCases } from './design-host-cases';
import { independentPrototype } from './design-prototype-fixtures';

designHostCases();

test('#291 mobile retains panel drawers and overflow with a Host threshold', async ({
  page,
}, info) => {
  await independentPrototype(page, true, { hostContracts: true });
  await page.getByLabel('Host compact breakpoint').fill('800');
  const layout = page.locator('.ep-layout');
  await expect(layout).toHaveClass(/ep-compact/);
  await expect(layout).toHaveClass(/ep-narrow/);
  await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open prototype', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('design-host-mobile-overflow.png') });
  await page.getByRole('button', { name: 'Open prototype', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Design prototype', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Exit prototype', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
