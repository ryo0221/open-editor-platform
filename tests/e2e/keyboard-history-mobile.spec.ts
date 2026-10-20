import { test, expect, create, addRecord, editCell } from './fixtures';

test('#299 narrow Document and Data retain keyboard history and reachable controls', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'document');
  const body = page.getByRole('textbox', { name: 'Document body', exact: true });
  await body.press('Control+End');
  await page.keyboard.insertText('mobile-299');
  await body.press('Control+z');
  await expect(body).not.toContainText('mobile-299');
  await body.press('Control+y');
  await expect(body).toContainText('mobile-299');
  await body.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Edit link', exact: true });
  await expect(dialog.getByLabel('Link URL', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('mobile-document-link.png') });
  await page.keyboard.press('Escape');
  await create(page, 'data');
  await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await addRecord(page);
  await editCell(page, 'Name', 1, 'mobile-cell-299');
  const grid = page.getByRole('grid', { name: 'Data grid', exact: true });
  await grid.press('Control+z');
  await expect(grid).not.toContainText('mobile-cell-299');
  await grid.press('Control+Shift+z');
  await expect(grid).toContainText('mobile-cell-299');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('mobile-data-history.png') });
});
