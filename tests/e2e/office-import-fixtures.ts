import { expect } from './fixtures';
export async function openImport(page: import('@playwright/test').Page) {
  await page.goto('/');
  if (!(await page.getByRole('button', { name: 'Officeから新規作成', exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByRole('button', { name: 'Officeから新規作成', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Office import', exact: true });
  await dialog
    .getByLabel('Office file', { exact: true })
    .setInputFiles('tests/fixtures/office/import/external.pptx');
  return dialog;
}
export async function ready(dialog: import('@playwright/test').Locator) {
  await dialog.getByLabel('Import conversion policy').selectOption('review-conversions');
  await dialog.getByRole('button', { name: 'Prepare import preview', exact: true }).click();
  await expect(
    dialog.getByLabel('Exclude UNSUPPORTED_ELEMENT /sld[1]/AlternateContent[1]', { exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await dialog
    .getByLabel('Exclude UNSUPPORTED_ELEMENT /sld[1]/AlternateContent[1]', { exact: true })
    .check();
  await dialog.getByRole('button', { name: 'Prepare import preview', exact: true }).click();
  await expect(dialog.getByLabel('Accept import conversions')).toBeEnabled({ timeout: 30000 });
}
