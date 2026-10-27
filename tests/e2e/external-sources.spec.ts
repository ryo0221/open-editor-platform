import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

// External read ports (ADR 016) through the reference Host. Every port is the deterministic
// mock: synthetic data, no network, no sign-in.
const host = '/external-sources-host.html';
const panel = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
async function control(page: Page, name: string) {
  const region = panel(page, name);
  await region.getByText('Mock Host controls', { exact: true }).click();
  return region;
}

test('reads Geo features in an area and keeps provider text as plain text', async ({ page }) => {
  await page.goto(host);
  const geo = panel(page, 'Geo features');
  await expect(geo.getByLabel('Source')).toHaveValue('mock-ponds-1');
  await geo.getByRole('button', { name: 'Read', exact: true }).click();
  await expect(geo.getByRole('status')).toHaveText('Read.');
  const rows = geo.getByRole('table', { name: 'Features' }).getByRole('row');
  await expect(rows).toHaveCount(6);
  await expect(geo.getByText('Gauge <b>A</b> (synthetic)', { exact: false })).toBeVisible();
  await expect(geo.getByText(/collection-1 \(unsupported-geometry\)/)).toBeVisible();
  await expect(geo.getByText('Properties not read: tags')).toBeVisible();

  // An invalid area is refused before anything is asked of the Host.
  await geo.getByLabel(/^Area/).fill('139,36,140,35');
  await expect(geo.getByRole('button', { name: 'Read', exact: true })).toBeDisabled();
  // A change notice reads again on its own; the invalid area still stops it.
  await geo.getByText('Mock Host controls', { exact: true }).click();
  await geo.getByRole('button', { name: 'Change source', exact: true }).click();
  await expect(geo.getByRole('status')).toHaveText('Not read: Enter four numbers in CRS84 ranges.');
  await geo.getByLabel(/^Area/).fill('139.71,35.63,139.73,35.65');
  await geo.getByRole('button', { name: 'Read', exact: true }).click();
  await expect(rows).toHaveCount(3);
});

test('shows a cut table as incomplete and drops a late answer after an account switch', async ({
  page,
}) => {
  await page.goto(host);
  const data = await control(page, 'Data table');
  await data.getByLabel('Complete reads').uncheck();
  await data.getByRole('button', { name: 'Read', exact: true }).click();
  await expect(data.getByText(/^Incomplete: rows after the last one are unknown/)).toBeVisible();
  await expect(data.getByRole('table', { name: 'Table values' }).getByRole('row')).toHaveCount(3);

  await data.getByLabel('Complete reads').check();
  await data.getByLabel('Hold reads').check();
  await data.getByRole('button', { name: 'Read', exact: true }).click();
  await expect(data.getByRole('status')).toHaveText('Reading…');
  await data.getByRole('button', { name: 'Switch account', exact: true }).click();
  await data.getByRole('button', { name: 'Release held reads', exact: true }).click();
  await expect(data.getByRole('status')).toContainText(
    'Results from the old connection were discarded',
  );
  await expect(data.getByRole('table', { name: 'Table values' })).toHaveCount(0);
  await expect(data.getByText(/account 2 \(synthetic\)/)).toBeVisible();
});

test('reads work items, says what was not read and follows a change notice', async ({ page }) => {
  await page.goto(host);
  const work = await control(page, 'Work items');
  await work.getByRole('button', { name: 'Read', exact: true }).click();
  const table = work.getByRole('table', { name: 'Work items' });
  await expect(table.getByRole('row')).toHaveCount(5);
  const pr = table.getByRole('row', { name: /Pull request #2/ });
  await expect(pr).toContainText('open (draft)');
  await expect(pr).toContainText('(more not read)');
  await expect(pr).toContainText('Pad short rows <img src=x> (synthetic)');

  await work.getByRole('button', { name: 'Change source', exact: true }).click();
  await expect(work.getByRole('status')).toHaveText('The source changed. Read again.');
  await expect(pr).toContainText('merged');

  await work.getByLabel('Fail reads').check();
  await work.getByRole('button', { name: 'Read', exact: true }).click();
  await expect(work.getByRole('status')).toHaveText('Not read: The source could not be read.');
  await expect(table).toHaveCount(0);
});
