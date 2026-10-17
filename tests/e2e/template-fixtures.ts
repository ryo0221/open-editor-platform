import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
export async function openWhole(page: Page, domain: string, name: string) {
  if (!(await page.getByLabel('Artifact type', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByRole('button', { name: 'テンプレートから作成', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'テンプレートから作成', exact: true });
  await dialog.getByLabel('テンプレートのEditor', { exact: true }).selectOption(domain);
  await expect(dialog.locator('.tp-card')).toHaveCount(5);
  await dialog.getByRole('button', { name: `テンプレートを選択: ${name}`, exact: true }).click();
  return dialog;
}
export async function artifactMenu(page: Page, name: string) {
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name, exact: true }).click();
}
export async function createWhole(page: Page, domain: string, name: string) {
  const dialog = await openWhole(page, domain, name);
  await dialog.getByRole('button', { name: '入力内容をプレビュー', exact: true }).click();
  await dialog.getByRole('button', { name: 'この内容で作成', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
export async function downloadText(page: Page, name: string) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  if (name === 'Export CSV')
    await page
      .getByRole('dialog', { name: 'CSV export scope', exact: true })
      .getByRole('button', { name: 'Download CSV' })
      .click();
  return readFile((await (await pending).path())!, 'utf8');
}
