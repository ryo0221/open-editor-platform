import type { Page } from '@playwright/test';
import { test, expect, nativeArtifact, create } from './fixtures';
import { commitVersion, createArtifact, serializeArtifact } from '@editor-platform/artifact-core';
import type { EmbeddedReference } from '@editor-platform/artifact-references';
import { createSchedule } from '@editor-platform/schedule/model';
import { makeRow, type StructuredData } from '@editor-platform/structured-data/model';
import { defaultView } from '@editor-platform/structured-data/views';

// The Schedule shows its UTC week; a milestone on today's UTC date falls inside it.
const today = () => new Date().toISOString().slice(0, 10);

/** A saved Data plan and a Schedule that follows it in a lane, as two native exports. */
async function exports() {
  const columns = [
    { id: 'col-name', name: 'Task', type: 'text' as const, required: true, defaultValue: 'Task' },
    { id: 'col-start', name: 'Start', type: 'date' as const },
    { id: 'col-end', name: 'End', type: 'date' as const },
  ];
  const base: StructuredData = { schemaVersion: 2, columns, rows: [] };
  const rows = [
    {
      ...makeRow(base, 'row-1'),
      values: { 'col-name': 'Design review', 'col-start': today(), 'col-end': today() },
    },
  ];
  const view = {
    ...defaultView({ ...base, rows }),
    id: 'view-plan',
    name: 'Release plan',
    projection: 'Timeline' as const,
    timeline: {
      start: 'col-start',
      end: 'col-end',
      group: '',
      scale: 'week' as const,
      from: '',
      to: '',
    },
  };
  const data = await commitVersion(
    createArtifact('data', 'Plan', { ...base, rows, views: [view] }),
    null,
    'first',
  );
  const version = data.versions[0];
  const reference: EmbeddedReference = {
    schemaVersion: 1,
    source: {
      artifactId: data.id,
      domain: 'data',
      target: { kind: 'timeline', viewId: 'view-plan' },
    },
    mode: 'follow',
    fit: 'contain',
    snapshot: {
      artifactId: data.id,
      domain: 'data',
      versionId: version.versionId,
      revision: 1,
      contentHash: version.contentHash,
      content: version.content,
      dependencies: [],
    },
  };
  const schedule = await commitVersion(
    createArtifact('schedule', 'Calendar', {
      ...createSchedule('UTC'),
      lanes: [{ id: 'lane-1', reference }],
    }),
    null,
    'first',
  );
  const file = (name: string, artifact: object) => ({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(serializeArtifact(artifact as never)),
  });
  return {
    data,
    schedule,
    dataFile: file('plan.json', data),
    scheduleFile: file('calendar.json', schedule),
  };
}

const importer = (page: Page) => page.getByLabel('Import artifact', { exact: true });
const open = async (page: Page, name: string) => {
  if (!(await page.getByRole('navigation', { name: 'Artifacts' }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Artifacts' })
    .getByRole('button', { name: new RegExp(`^. ?${name}`) })
    .click();
};

test('imports a Data plan and the Schedule that follows it together, keeping the lane (ST-03#5)', async ({
  page,
}) => {
  const { data, schedule, dataFile, scheduleFile } = await exports();
  await page.goto('/');
  await importer(page).setInputFiles([scheduleFile, dataFile]);
  // The first file opens; its lane reads the Data imported with it.
  const lane = page.getByLabel('Lane Release plan', { exact: true });
  await expect(lane).toContainText('Design review');
  await expect(lane).not.toContainText('Lane unavailable');
  const importedSchedule = await nativeArtifact(page);
  await open(page, 'Plan');
  const importedData = await nativeArtifact(page);
  expect(importedData.id).not.toBe(data.id);
  expect(importedSchedule.id).not.toBe(schedule.id);
  const lanes = (content: unknown) =>
    (content as { lanes: { reference: EmbeddedReference }[] }).lanes;
  expect(lanes(importedSchedule.draft.content)[0].reference.source.artifactId).toBe(
    importedData.id,
  );
  // The saved version keeps the bytes and hash it was exported with.
  expect(importedSchedule.versions[0].contentHash).toBe(schedule.versions[0].contentHash);
  expect(lanes(importedSchedule.versions[0].content)[0].reference.source.artifactId).toBe(data.id);
  await page.reload();
  await open(page, 'Calendar');
  await expect(page.getByLabel('Lane Release plan', { exact: true })).toContainText(
    'Design review',
  );
});

test('one invalid file refuses the whole import and names the file (ST-03#6)', async ({ page }) => {
  const { dataFile, scheduleFile } = await exports();
  await page.goto('/');
  await importer(page).setInputFiles([
    dataFile,
    { name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{"kind":') },
    scheduleFile,
  ]);
  await expect(page.getByText(/^Import failed: broken\.json: /)).toBeVisible();
  if (!(await page.getByRole('navigation', { name: 'Artifacts' }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Artifacts' }).getByRole('button')).toHaveCount(
    0,
  );
});

test('a storage failure part way through keeps none of the import (ST-03#6)', async ({ page }) => {
  const { dataFile, scheduleFile } = await exports();
  // Refuse to store the second record, as a full quota would.
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if ((value as { name?: string })?.name === 'Plan')
        throw new DOMException('Storage is full', 'QuotaExceededError');
      return put.call(this, value, key);
    };
  });
  await page.goto('/');
  await create(page);
  const before = await nativeArtifact(page);
  await importer(page).setInputFiles([scheduleFile, dataFile]);
  await expect(page.getByText(/^Import failed: .*Storage is full/)).toBeVisible();
  await page.reload();
  if (!(await page.getByRole('navigation', { name: 'Artifacts' }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Artifacts' }).getByRole('button')).toHaveCount(
    1,
  );
  await page.getByRole('button', { name: 'Close library panel', exact: true }).click();
  expect(await nativeArtifact(page)).toEqual(before);
});

test('reimporting the same exports creates independent copies without changing existing artifacts', async ({
  page,
}) => {
  const { dataFile, scheduleFile, schedule } = await exports();
  await page.goto('/');
  await importer(page).setInputFiles([scheduleFile, dataFile]);
  await expect(page.getByLabel('Lane Release plan', { exact: true })).toContainText(
    'Design review',
  );
  const first = await nativeArtifact(page);
  await importer(page).setInputFiles([scheduleFile, dataFile]);
  await expect(page.getByLabel('Artifact name')).toHaveValue('Calendar');
  // Wait for the second import to be adopted before exporting it.
  const nav = page.getByRole('navigation', { name: 'Artifacts' });
  if (!(await nav.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await expect(nav.getByRole('button')).toHaveCount(4);
  await page.getByRole('button', { name: 'Close library panel', exact: true }).click();
  const second = await nativeArtifact(page);
  expect(second.id).not.toBe(first.id);
  expect(second.draft.content).not.toEqual(first.draft.content);
  expect(second.versions[0].content).toEqual(schedule.versions[0].content);
  expect(second.versions[0].contentHash).toBe(schedule.versions[0].contentHash);
  await page.reload();
  if (!(await nav.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await expect(nav.getByRole('button')).toHaveCount(4);
  const calendars = [];
  for (let i = 0; i < 2; i++) {
    if (!(await nav.isVisible()))
      await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
    await nav.getByRole('button').filter({ hasText: 'Calendar' }).nth(i).click();
    calendars.push(await nativeArtifact(page));
  }
  expect(calendars).toContainEqual(first);
  expect(calendars).toContainEqual(second);
});

for (const refusal of ['invalid', 'duplicate', 'limit', 'cancel'] as const) {
  test(`${refusal} import preserves existing data across reload`, async ({ page }) => {
    const { dataFile, scheduleFile } = await exports();
    await page.goto('/');
    await importer(page).setInputFiles([dataFile]);
    await expect(page.getByLabel('Artifact name')).toHaveValue('Plan');
    const before = await nativeArtifact(page);
    const files =
      refusal === 'invalid'
        ? [
            scheduleFile,
            { name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{') },
          ]
        : refusal === 'duplicate'
          ? [scheduleFile, scheduleFile]
          : refusal === 'limit'
            ? Array.from({ length: 33 }, () => scheduleFile)
            : [];
    await importer(page).setInputFiles(files);
    if (refusal !== 'cancel') {
      const message =
        refusal === 'invalid'
          ? /Import failed: broken.json:/
          : refusal === 'duplicate'
            ? /This artifact is already in the import/
            : /Import at most 32 files at once/;
      await expect(page.getByText(message)).toBeVisible();
    } else {
      // Empty selection and native cancel events must not start an import.
      await importer(page).dispatchEvent('cancel');
      await expect(page.getByText(/^Import failed:/)).toHaveCount(0);
    }
    await page.reload();
    const nav = page.getByRole('navigation', { name: 'Artifacts' });
    if (!(await nav.isVisible()))
      await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
    await expect(nav.getByRole('button')).toHaveCount(1);
    await open(page, 'Plan');
    expect(await nativeArtifact(page)).toEqual(before);
  });
}

test('Library explains unavailable CAD/BIM and local font setup', async ({ page }, testInfo) => {
  test.skip(!!process.env.CAD_OCCT_DIST, 'Exercises the ordinary no-kernel setup');
  await page.goto('/');
  const library = page.getByRole('complementary', { name: 'Artifact library' });
  if (!(await library.isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await library.getByText('3D CAD / BIM unavailable — setup', { exact: true }).click();
  await expect(library.getByText(/3D CAD and BIM creation require/)).toBeVisible();
  await expect(library.getByText('CAD_OCCT_DIST', { exact: true })).toBeVisible();
  await expect(library.getByText('npm run fonts:fetch', { exact: true })).toBeVisible();
  await expect(library.locator('option[value="cad"], option[value="bim"]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('playground-setup.png') });
});
