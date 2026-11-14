import {
  ladderBlinkExample,
  ladderStarter,
  type LadderDocument,
} from '@editor-platform/ladder-core';
import type { Page } from '@playwright/test';
import { create, expect, nativeArtifact, save, test } from './fixtures';

// SL7c (ST-572, TS-2115): the ladder Surface in the ordinary Playground.

const status = (page: Page) => page.getByTestId('lad-status');
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
const draft = async (page: Page) => (await nativeArtifact(page)).draft.content as LadderDocument;

test('create, edit, Undo, save a version, reload, run and round-trip native JSON', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'ladder');
  await expect(page.getByTestId('lad-diagram')).toContainText('No rungs yet');
  expect(await draft(page)).toEqual(ladderStarter());
  // A rung with a coil (output Y1), a contact (input X1), then Host Undo / Redo.
  await tool(page, 'Add rung').click();
  await tool(page, 'Add after').click();
  await expect(page.getByRole('button', { name: 'NO contact X1', exact: true })).toBeVisible();
  await tool(page, 'Undo').click();
  await expect(page.getByRole('button', { name: 'NO contact X1', exact: true })).toBeHidden();
  await tool(page, 'Redo').click();
  await expect(page.getByRole('button', { name: 'NO contact X1', exact: true })).toBeVisible();
  await save(page, 1);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Coil Y1', exact: true })).toBeVisible();
  const record = await nativeArtifact(page);
  expect(record.kind).toBe('ladder');
  expect(record.versions).toHaveLength(1);
  const saved = record.versions[0]!.content as LadderDocument;
  expect(saved.variables).toEqual([
    { name: 'Y1', type: 'BOOL', role: 'output' },
    { name: 'X1', type: 'BOOL', role: 'input' },
  ]);
  // Running uses the saved program: X1 held on lights Y1; running never changes the draft.
  await tool(page, 'Hold X1 on').click();
  await tool(page, 'One scan').click();
  await expect(page.getByTestId('lad-value-Y1')).toHaveAttribute('data-value', 'TRUE');
  expect(await draft(page)).toEqual(saved);

  // The blink example, imported as native JSON, round-trips unchanged.
  await importJson(page, 'blink.json', {
    ...record,
    name: 'Blink',
    draft: { ...record.draft, content: ladderBlinkExample() },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Blink');
  await expect(page.getByRole('button', { name: 'Timer T_ON', exact: true })).toBeVisible();
  expect(await draft(page)).toEqual(ladderBlinkExample());
  await expect(status(page)).toContainText('10 ms per scan');

  // Invalid content (a coil on an input) is refused on import.
  const bad = ladderBlinkExample();
  bad.rungs[2].coils[0].variable = 'ENABLE';
  await importJson(page, 'bad.json', {
    ...record,
    name: 'Bad ladder',
    draft: { ...record.draft, content: bad },
    versions: [],
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('Blink');
});
