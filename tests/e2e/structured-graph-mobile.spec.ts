import { test, expect, create, save } from './fixtures';
import { graphAttribute, dataProjection, independentSource } from './structured-graph-fixtures';
test('mobile ordinary Graph: attributes, deletion Cancel, readonly and persisted draft', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'structured-graph');
  await graphAttribute(page, 'Research', 'name', 'Mobile Research');
  await save(page, 1);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Select node Mobile Research', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Select node Mobile Research', exact: true }).click();
  await page.getByRole('button', { name: 'Delete selection', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel deletion', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Select node Mobile Research', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('ordinary-graph-mobile.png') });
});
test('mobile independent Graph and Data: responsive controls, typed edit and shared history', async ({
  page,
}, info) => {
  await page.goto('/graph-host.html');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  await graphAttribute(page, 'Research', 'name', 'Mobile independent');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  expect((await independentSource(page)).nodes[0].attributes.name).toBe('Mobile independent');
  await page.screenshot({ path: info.outputPath('independent-graph-mobile.png') });
  await page.getByLabel('Graph source', { exact: true }).selectOption('data');
  await expect(page.getByRole('status').first()).toHaveText('Ready');
  await dataProjection(page, 'Graph');
  await graphAttribute(page, 'Research', 'Name', 'Mobile Data');
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Select node Research', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('independent-data-graph-mobile.png') });
});
