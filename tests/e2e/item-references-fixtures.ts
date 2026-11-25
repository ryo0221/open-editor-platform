/** Shared steps of the business item reference specs (desktop and mobile). */
import { expect, save } from './fixtures';
import type { Page } from '@playwright/test';

export async function create(page: Page, type: string, template: [string, string]) {
  if (!(await page.getByLabel('Artifact type', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByLabel('Artifact type', { exact: true }).selectOption(type);
  await page.getByLabel(template[0], { exact: true }).selectOption(template[1]);
  await page.getByRole('button', { name: 'New artifact' }).click();
  await expect(page.getByLabel('Artifact name')).toBeVisible();
}
export async function causeName(page: Page, from: string, id: string, name: string) {
  await page.getByRole('button', { name: `Select node ${from}`, exact: true }).click();
  const inspector = page.getByRole('complementary', { name: 'Graph Inspector' });
  await inspector.getByLabel('業務 ID', { exact: true }).fill(id);
  await inspector.getByLabel('原因', { exact: true }).fill(name);
  await inspector.getByRole('button', { name: '属性を適用', exact: true }).click();
}
export async function activate(page: Page, name: RegExp) {
  if (!(await page.getByRole('navigation', { name: 'Artifacts' }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByRole('navigation', { name: 'Artifacts' }).getByRole('button', { name }).click();
}

/** Shows a Data projection; on a narrow screen the control is under the editor tools menu. */
export async function projection(page: Page, name: string) {
  const select = page.getByLabel('Data projection', { exact: true });
  if (await select.isVisible()) return void (await select.selectOption(name));
  await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await select.selectOption(name);
  await page.keyboard.press('Escape');
}

/** A saved Fishbone with cause CC-01 and a DFMEA whose failure cause FC-01 cites it. */
export async function citedFmea(page: Page) {
  await create(page, 'structured-graph', ['Graph template', 'fishbone']);
  await causeName(page, '設備温度の変動', 'CC-01', '設備温度の変動');
  await save(page, 1);
  await create(page, 'data', ['Data template', 'dfmea']);
  await projection(page, 'Form');
  await page.getByLabel('Record 故障原因の ID', { exact: true }).fill('FC-01');
  await page.getByRole('button', { name: 'Save record', exact: true }).click();
  const refs = page.getByRole('region', { name: '原因の候補', exact: true });
  await refs.getByRole('button', { name: '候補から選ぶ', exact: true }).click();
  await refs.getByRole('button', { name: /CC-01/ }).click();
  await expect(refs.getByRole('listitem').filter({ hasText: 'CC-01' })).toContainText(
    '設備温度の変動',
  );
  return refs;
}
