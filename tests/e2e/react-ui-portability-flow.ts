import { expect, nativeArtifact, save } from './fixtures';
import type { Page, TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync, strFromU8 } from 'fflate';

export async function portabilityFlow(page: Page, info: TestInfo) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New React UI', exact: true }).click();
  const frame = page.frameLocator('iframe[title="React component preview"]');
  await page.getByRole('button', { name: 'footer · Text', exact: true }).click();
  await page.getByRole('button', { name: 'Delete subtree', exact: true }).click();
  const exportFiles = async () => {
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export React TSX', exact: true }).click();
    const download = await pending;
    const files = unzipSync(await readFile((await download.path())!));
    return Object.fromEntries(Object.entries(files).map(([key, bytes]) => [key, strFromU8(bytes)]));
  };
  await expect(frame.locator('footer')).toHaveText('');
  const first = await exportFiles();
  expect(first['Screen.tsx']).not.toContain('footer={');
  expect(first['Screen.tsx']).toContain('  return (\n');
  const initial = await nativeArtifact(page);
  await save(page, 1);
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(initial.draft.content);
  expect(await exportFiles()).toEqual(first);
  await page.getByLabel('Target slot', { exact: true }).selectOption({ label: 'card / footer' });
  await page.getByRole('button', { name: 'Insert Text', exact: true }).click();
  await page.getByLabel('Prop text', { exact: true }).fill('Portable footer');
  await expect(frame.getByText('Portable footer', { exact: true })).toBeVisible();
  const added = await exportFiles();
  expect(added['Screen.tsx']).toContain('footer={<Fragment>');
  await page.screenshot({ path: info.outputPath('portable-ui.png'), fullPage: true });
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  if (!(await undo.isVisible()))
    await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await undo.click();
  await expect(frame.getByText('Portable footer', { exact: true })).toHaveCount(0);
}
