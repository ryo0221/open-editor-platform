import { test, expect, create, save, artifactView, setDocumentText } from './fixtures';
import type { Page } from '@playwright/test';
async function tools(page: Page) {
  await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
}
async function projection(page: Page, name: string) {
  await tools(page);
  await page.getByLabel('Data projection', { exact: true }).selectOption(name);
  await page.keyboard.press('Escape');
}
test('mobile navigation, editing, persistence, history/compare and data', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page);
  await setDocumentText(page, 'h1', 'Mobile field notes');
  await setDocumentText(page, ':scope > p', 'Written on a small screen');
  await save(page, 1);
  await setDocumentText(page, ':scope > p', 'Second mobile draft');
  await save(page, 2);
  await page.screenshot({ path: info.outputPath('document-mobile.png') });
  await page.getByRole('button', { name: 'Toggle Document outline', exact: true }).click();
  await expect(
    page.getByRole('complementary', { name: 'Document outline', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close Document outline', exact: true }).click();
  await artifactView(page, 'History');
  await expect(page.getByRole('heading', { name: 'Version history' })).toBeVisible();
  await artifactView(page, 'Compare');
  await expect(page.getByText(/Second mobile draft/)).toBeVisible();
  await page.screenshot({ path: info.outputPath('compare-mobile.png') });
  await page.reload();
  await expect(page.locator('.ProseMirror > p')).toHaveText('Second mobile draft');
  await create(page, 'data');
  await tools(page);
  await page.getByRole('button', { name: 'Add records', exact: true }).click();
  await page.getByRole('button', { name: 'Add 1 record', exact: true }).click();
  await page.keyboard.press('Escape');
  await projection(page, 'Form');
  await page.getByLabel('Record Name', { exact: true }).fill('Mobile record');
  await page.getByLabel('Record Quantity', { exact: true }).fill('4');
  await expect(page.getByLabel('Record Total', { exact: true })).toHaveText('40');
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  await save(page, 1);
  await page.screenshot({ path: info.outputPath('data-mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.getByRole('button', { name: 'Toggle Data inspector', exact: true }).click();
  await expect(
    page.getByRole('complementary', { name: 'Data inspector', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close Data inspector', exact: true }).click();
  await projection(page, 'Grid');
  await expect(page.getByRole('gridcell', { name: 'Name · record 1', exact: true })).toHaveText(
    'Mobile record',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
