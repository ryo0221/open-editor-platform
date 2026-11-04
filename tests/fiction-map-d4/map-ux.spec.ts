import { test, expect, nativeArtifact, save, create } from '../e2e/fixtures';
import { commitVersion } from '@editor-platform/artifact-core';
import type { FictionMapContent } from '@editor-platform/fiction-map/model';
import { settingDemoArtifact } from '../../scripts/fixtures/fiction-map-demo';

test('setting scenario: labels stay view-only and saved extent/layers edit atomically with Undo and fixed old version', async ({
  page,
}, info) => {
  await page.goto('/');
  const artifact = await commitVersion(settingDemoArtifact(), null, '王朝末期');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'kingdom.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(artifact)),
  });
  const before = await nativeArtifact(page);
  await expect(page.getByRole('application', { name: 'Fiction Map canvas' })).toBeVisible();
  await expect(page.getByLabel('Avoid label overlap', { exact: true })).toBeChecked();
  await page.getByLabel('Avoid label overlap', { exact: true }).uncheck();
  await expect(page.locator('[data-fiction-label]')).toHaveCount(
    artifact.draft.content.features.filter((f) => f.style?.label !== false).length,
  );
  await page.getByLabel('Avoid label overlap', { exact: true }).check();
  expect((await nativeArtifact(page)).draft.content).toEqual(before.draft.content);
  await page.getByRole('button', { name: 'Edit saved view 王国全図', exact: true }).click();
  await page.getByLabel('View minX', { exact: true }).fill('150');
  await page.getByLabel('View maxX', { exact: true }).fill('900');
  await page.getByLabel('View layer 政治境界', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Update named view', exact: true }).click();
  const edited = await nativeArtifact(page);
  const content = edited.draft.content as FictionMapContent;
  expect(content.namedViews[0]).toEqual({
    ...artifact.draft.content.namedViews[0],
    extent: { minX: 150, minY: 0, maxX: 900, maxY: 650 },
    visibleLayerIds: artifact.draft.content.layers
      .filter((l) => l.id !== 'political')
      .map((l) => l.id),
  });
  expect(edited.versions).toEqual(before.versions);
  const undo = page.getByRole('button', { name: 'Undo', exact: true }).first();
  if (!(await undo.isVisible()))
    await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await undo.click();
  await page.keyboard.press('Escape');
  expect((await nativeArtifact(page)).draft.content).toEqual(before.draft.content);
  const redo = page.getByRole('button', { name: 'Redo', exact: true }).first();
  if (!(await redo.isVisible()))
    await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await redo.click();
  await page.keyboard.press('Escape');
  expect((await nativeArtifact(page)).draft.content).toEqual(edited.draft.content);
  await save(page, 2);
  await page.getByRole('button', { name: 'Edit saved view 王国全図', exact: true }).click();
  await page.getByLabel('View minX', { exact: true }).fill('950');
  await page.getByRole('button', { name: 'Update named view', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText('invalid-bounds');
  // Export correctly refuses dirty/invalid inputs. Explicitly cancel before reading native.
  await page.getByRole('button', { name: 'Cancel view input', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(edited.draft.content);
  await page.screenshot({
    path: `/tmp/fiction-map-d4/map-ux-${info.project.name}.png`,
    fullPage: true,
  });
  await page.reload();
  const reloaded = await nativeArtifact(page);
  expect(reloaded.draft.content).toEqual(edited.draft.content);
  expect(reloaded.versions[0]).toEqual(before.versions[0]);
});

test('saved-view Cancel preserves the shared composition guard until composition end (synthetic)', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'fiction-map');
  const before = await nativeArtifact(page);
  const field = page.getByLabel('Named document view', { exact: true });
  await field.dispatchEvent('compositionstart');
  await field.fill('変換中');
  await page.getByRole('button', { name: 'Cancel view input', exact: true }).click();
  await expect(field).toHaveValue('');
  await page.getByRole('button', { name: 'Export artifact', exact: true }).click();
  const exportJson = page.getByRole('button', { name: 'Export JSON', exact: true });
  if (await exportJson.isVisible()) await exportJson.click();
  await expect(page.getByRole('alert').filter({ hasText: '入力変換' }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await field.dispatchEvent('compositionend');
  const after = await nativeArtifact(page);
  expect(after.draft.content).toEqual(before.draft.content);
  expect(after.versions).toEqual(before.versions);
});
