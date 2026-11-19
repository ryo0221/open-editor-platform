import { readFile } from 'node:fs/promises';
import { f172SmallLineExperiment, type FactoryDocument } from '@editor-platform/factory-core';
import type { Page } from '@playwright/test';
import { create, expect, nativeArtifact, test } from './fixtures';

// FT5 (ST-845, ST-846, TS-2677): experiments on the factory Surface in the ordinary Playground.

const panel = (page: Page) => page.getByTestId('fac-experiment');
const progress = (page: Page) => page.getByTestId('fac-experiment-progress');
const rows = (page: Page) => page.getByTestId('fac-experiment-table').locator('tbody tr');
const draft = async (page: Page) => (await nativeArtifact(page)).draft.content as FactoryDocument;
async function commit(page: Page, label: string, value: string) {
  const field = page.getByLabel(label, { exact: true });
  await field.fill(value);
  await field.press('Enter');
}

test('FT5: repeat F172 over a factor table, compare with intervals, stop, CSV', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'desktop', 'desktop flow');
  await page.goto('/');
  await create(page, 'factory');
  const record = await nativeArtifact(page);
  const input = page.getByLabel('Import artifact', { exact: true });
  if (!(await input.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await input.setInputFiles({
    name: 'f172.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        ...record,
        name: 'F172 line',
        draft: { ...record.draft, content: f172SmallLineExperiment() },
        versions: [],
      }),
    ),
  });
  await expect(page.getByLabel('Artifact name')).toHaveValue('F172 line');
  await expect(page.getByTestId('fac-experiment-size')).toHaveText(
    '8 combinations × 10 replications = 80 runs',
  );
  // Three seeds instead of ten, as one edit of the model.
  await commit(page, 'Replications (seeds)', '3');
  await expect(page.getByTestId('fac-experiment-size')).toHaveText(
    '8 combinations × 3 replications = 24 runs',
  );
  expect((await draft(page)).experiment!.replications).toBe(3);

  // Run in the Worker: every combination with its mean ± 95% interval.
  await panel(page).getByRole('button', { name: 'Run experiment' }).click();
  await expect(progress(page)).toContainText('24 / 24 runs · done');
  await expect(rows(page)).toHaveCount(8);
  // Two machines: the machining cell is the bottleneck; three and a faster test: the assembly.
  await expect(rows(page).nth(0)).toContainText('Machining cell');
  await expect(rows(page).nth(0)).toContainText('±');
  await expect(rows(page).nth(5)).toContainText('Assembly');
  await expect(rows(page).nth(4)).toHaveAttribute('data-best', 'true');
  // Pictures for review only (FT_SHOTS: a folder outside the repository).
  if (process.env.FT_SHOTS) {
    await page.screenshot({ path: `${process.env.FT_SHOTS}/ft5-surface.png` });
    await panel(page).screenshot({ path: `${process.env.FT_SHOTS}/ft5-experiment.png` });
  }
  // The comparison table as CSV.
  const download = page.waitForEvent('download');
  await panel(page).getByRole('button', { name: 'Table CSV' }).click();
  const csv = await readFile((await (await download).path())!, 'utf8');
  const lines = csv.trimEnd().split('\r\n');
  expect(lines[0]).toMatch(
    /^parallel-count:machining,time-scale:test,buffer-capacity:buffer-1,runs,failed,throughputPerHour_mean,throughputPerHour_ci95_low,/,
  );
  expect(lines).toHaveLength(9);
  expect(lines[6]).toMatch(/^3,80,5,3,0,/);
  const runs = page.waitForEvent('download');
  await panel(page).getByRole('button', { name: 'Runs CSV' }).click();
  expect(
    (await readFile((await (await runs).path())!, 'utf8')).trimEnd().split('\r\n'),
  ).toHaveLength(25);

  // An edit makes the table stale; dropping the buffer factor halves the table; Undo.
  await panel(page).getByRole('button', { name: 'Remove factor 3' }).click();
  await expect(page.getByTestId('fac-experiment-size')).toHaveText(
    '4 combinations × 3 replications = 12 runs',
  );
  await expect(panel(page)).toContainText('ran on an earlier version');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByTestId('fac-experiment-size')).toHaveText(
    '8 combinations × 3 replications = 24 runs',
  );

  // A long experiment stopped part way keeps the runs it finished.
  await commit(page, 'Replications (seeds)', '100');
  await panel(page).getByRole('button', { name: 'Run experiment' }).click();
  await expect(progress(page)).toContainText(/[1-9][0-9]* \/ 800 runs · running/);
  await panel(page).getByRole('button', { name: 'Stop experiment' }).click();
  await expect(progress(page)).toContainText('· stopped');
  await expect(page.getByTestId('fac-notice')).toContainText('stopped');
  const shown = await progress(page).innerText();
  expect(Number(/(\d+) \/ 800/.exec(shown)![1])).toBeLessThan(800);
  await expect(rows(page)).toHaveCount(8);

  // A value out of range is refused with its code.
  await commit(page, 'Values of factor 1 (comma)', '0, 2');
  await expect(page.getByTestId('fac-notice')).toContainText('factor-values');
});
