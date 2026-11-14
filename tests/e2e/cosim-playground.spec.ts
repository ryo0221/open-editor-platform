import { cosimLedSchematic, type CosimDocument } from '@editor-platform/cosim-core';
import { ladderSelfHoldExample } from '@editor-platform/ladder-core';
import type { Page } from '@playwright/test';
import { create, expect, nativeArtifact, save, test } from './fixtures';

// SL8c (ST-575, TS-2120): the co-simulation Surface in the ordinary Playground, running saved
// versions of a schematic and a ladder program made there.

const tool = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
async function importJson(page: Page, name: string, value: unknown) {
  const input = page.getByLabel('Import artifact', { exact: true });
  if (!(await input.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await input.setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(value)),
  });
}
/** Makes an artifact of `kind` holding `content` and saves it as version 1. */
async function saved(page: Page, kind: string, name: string, content: unknown) {
  await create(page, kind);
  const record = await nativeArtifact(page);
  await importJson(page, `${kind}.json`, {
    ...record,
    name,
    draft: { ...record.draft, content },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue(name);
  await save(page, 1);
}
const draft = async (page: Page) => (await nativeArtifact(page)).draft.content as CosimDocument;

test('bind a saved ladder program to a saved schematic, press the button, the LED stays on', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await saved(page, 'schematic', 'LED board', cosimLedSchematic());
  await saved(page, 'ladder', 'Self-hold', ladderSelfHoldExample());

  await create(page, 'cosim');
  await expect(page.getByText('Choose a saved schematic version.')).toBeVisible();
  await page
    .getByLabel('Schematic', { exact: true })
    .selectOption({ label: 'LED board · v1 — Manual save' });
  await page
    .getByLabel('Ladder program', { exact: true })
    .selectOption({ label: 'Self-hold · v1 — Manual save' });
  await expect(page.getByTestId('cosim-ladder').locator('[data-rung]')).toHaveCount(1);
  await tool(page, 'Add input binding').click();
  await page.getByLabel('Net 1', { exact: true }).selectOption('GPIO27');
  await page.getByRole('checkbox', { name: 'Active low 1' }).check();
  await tool(page, 'Add output binding').click();
  await page.getByLabel('Net 2', { exact: true }).selectOption('GPIO17');
  await expect
    .poll(async () => (await draft(page)).bindings)
    .toEqual([
      { variable: 'START', net: 'GPIO27', kind: 'input', pull: 'up', activeLow: true },
      { variable: 'LAMP', net: 'GPIO17', kind: 'output' },
    ]);
  await save(page, 1);

  await page.reload();
  await expect(page.getByTestId('cosim-ladder').locator('[data-rung]')).toHaveCount(1);
  await tool(page, 'Run').click();
  await expect(page.getByTestId('cosim-status')).toContainText('Running');
  await tool(page, 'Press SW1').click();
  await expect(page.getByTestId('cosim-var-LAMP')).toHaveAttribute('data-value', 'true');
  await expect
    .poll(() =>
      page.getByTestId('cosim-current-D1').evaluate((e) => Number(e.getAttribute('data-value'))),
    )
    .toBeGreaterThan(1e-3);
  await tool(page, 'Hold STOP on').click();
  await expect(page.getByTestId('cosim-var-LAMP')).toHaveAttribute('data-value', 'false');
  await tool(page, 'Stop').click();
  // Running never changes the document.
  expect((await draft(page)).bindings).toHaveLength(2);
});
