import { test as base, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { StoredArtifact } from '../../apps/playground/src/model';
export const test = base.extend<{ browserErrors: void }>({
  browserErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      await use();
      expect(errors, 'No browser console errors or uncaught exceptions').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };
export async function nativeArtifact(page: Page): Promise<StoredArtifact> {
  await page.getByRole('button', { name: 'Export artifact', exact: true }).click();
  // Read canonical output only after queued shared edits/history are confirmed.
  // This waits for the existing UI state; it neither retries nor submits edits.
  await expect(page.locator('.save-status')).not.toContainText(/\b[1-9]\d* pending\b/);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const file = await pending;
  const record = JSON.parse(await readFile((await file.path())!, 'utf8'));
  await page.keyboard.press('Escape');
  return record;
}
export async function create(page: Page, kind = 'document') {
  if (!(await page.getByLabel('Artifact type', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByLabel('Artifact type', { exact: true }).selectOption(kind);
  await page.getByRole('button', { name: 'New artifact' }).click();
  await expect(page.getByLabel('Artifact name')).toBeVisible();
}
export async function save(page: Page, n: number) {
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Save immutable version', exact: true })
    .getByRole('button', { name: 'Save version', exact: true })
    .click();
  await page.getByRole('button', { name: 'History and compare', exact: true }).click();
  await expect(page.getByRole('tab', { name: `History (${n})`, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
}
export async function artifactView(page: Page, name: 'Editor' | 'History' | 'Compare') {
  await page.getByRole('button', { name: 'History and compare', exact: true }).click();
  await page
    .getByRole('tab', {
      name: name === 'History' ? /^History \(/ : name,
      exact: name !== 'History',
    })
    .click();
  await page.keyboard.press('Escape');
}
export async function setDocumentText(page: Page, selector: string, text: string) {
  const element = page
    .locator(
      selector.startsWith(':scope')
        ? selector.replace(':scope', '.ProseMirror')
        : `.ProseMirror ${selector}`,
    )
    .first();
  await element.evaluate((node) => {
    (node.closest('.ProseMirror') as HTMLElement).focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.keyboard.insertText(text);
}
export async function insertDoc(page: Page, name: string) {
  await page.getByRole('button', { name: 'Insert block', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Insert document block' })
    .getByRole('button', { name, exact: true })
    .click();
}
export async function comments(page: Page) {
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByRole('button', { name: /^Comments \(/ }).click();
  await page.keyboard.press('Escape');
}
export async function editCell(
  page: Page,
  name: string,
  row: number,
  value: string,
  choice = false,
) {
  await page.getByRole('gridcell', { name: `${name} · record ${row}`, exact: true }).dblclick();
  const field = page.getByLabel(`Edit ${name}`, { exact: true });
  if (choice) await field.selectOption(value);
  else await field.fill(value);
  await field.press('Enter');
}
export async function addRecord(page: Page) {
  await page.getByRole('button', { name: 'Add records', exact: true }).click();
  await page.getByRole('button', { name: 'Add 1 record', exact: true }).click();
  await page.keyboard.press('Escape');
}
export async function addField(page: Page, name: string, type: string) {
  await page.getByRole('button', { name: 'Add field', exact: true }).click();
  await page.getByLabel('New field name', { exact: true }).fill(name);
  await page.getByLabel('New field type', { exact: true }).selectOption(type);
  await page.getByRole('button', { name: 'Create field', exact: true }).click();
}
export const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);

/** Follow the explicit Viewer replacement confirmation, including the narrow toolbar. */
export async function replaceFileSource(
  page: Page,
  files: Parameters<import('@playwright/test').Locator['setInputFiles']>[0],
) {
  const replace = page.getByRole('button', { name: 'Replace source', exact: true });
  if (!(await replace.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await replace.click();
  await page.getByLabel('Open file', { exact: true }).setInputFiles(files);
  await page.getByRole('button', { name: 'Confirm source replacement', exact: true }).click();
}
