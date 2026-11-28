import { expect, type Page } from '@playwright/test';

/** Opens the workflow-definition reference Host with its sample definition. */
export async function openWorkflowHost(page: Page) {
  await page.goto('/workflow-definition-host.html');
  await expect(page.getByLabel('Host status')).toHaveText('Ready');
  await expect(page.getByRole('tab', { name: '流れ' })).toHaveAttribute('aria-selected', 'true');
}
export async function workflowTab(page: Page, name: string) {
  await page.getByRole('tab', { name, exact: true }).click();
  await expect(page.getByRole('tabpanel', { name })).toBeVisible();
}
/** Adds an element with the shared form (kind, ID and name). */
export async function addElement(page: Page, kind: string, id: string, name: string) {
  await page.getByLabel('Element kind').selectOption({ label: kind });
  await page.getByLabel('New element ID').fill(id);
  await page.getByLabel('New element name').fill(name);
  await page.getByRole('button', { name: '追加', exact: true }).click();
}
/** The Host's current definition JSON, read through its JSON panel. */
export async function hostJson(page: Page) {
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  const text = await page.getByLabel('Definition JSON text').inputValue();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  return JSON.parse(text) as {
    phases: { id: string; name: string; after: string[]; deliverables: string[] }[];
    deliverables: { id: string }[];
    acceptance: { id: string; target: string }[];
    sections: { id: string; phases: string[] }[];
  };
}
export const noPageOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
