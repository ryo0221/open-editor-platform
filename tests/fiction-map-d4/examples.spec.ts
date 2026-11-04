import { test, expect, nativeArtifact, save } from '../e2e/fixtures';
import { commitVersion } from '@editor-platform/artifact-core';
import {
  exampleIds,
  exampleBriefs,
  exampleArtifact,
  exampleContent,
} from '../../scripts/fixtures/fiction-map-examples';
import type { FictionMapContent } from '@editor-platform/fiction-map/model';
import type { Page } from '@playwright/test';
async function history(page: Page, name: 'Undo' | 'Redo') {
  const action = page.getByRole('button', { name, exact: true }).first();
  if (!(await action.isVisible()))
    await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await action.click();
  await page.keyboard.press('Escape');
}
for (const id of exampleIds)
  test(`${id}: rough → structure → detail, manual edit, Undo/Redo, immutable versions and reopen`, async ({
    page,
  }, info) => {
    await page.goto('/');
    const source = await commitVersion(exampleArtifact(id), null, 'Rough layout');
    await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
      name: `${id}.json`,
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(source)),
    });
    const before = await nativeArtifact(page);
    const form = page.locator('.fm-native-input');
    await form.locator('summary').click();
    for (const stage of ['structure', 'detailed'] as const) {
      await form.getByLabel('Refinement native JSON').setInputFiles({
        name: `${stage}.json`,
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(exampleContent(id, stage))),
      });
      await expect(form.getByAltText('Map refinement preview')).toBeVisible();
      await form.getByRole('button', { name: 'Apply map refinement', exact: true }).click();
      const applied = await nativeArtifact(page);
      expect(applied.id).toBe(before.id);
      expect(applied.draft.content).toEqual(exampleContent(id, stage));
      expect(applied.versions).toEqual(before.versions);
    }
    await form.locator('summary').click();
    await history(page, 'Undo');
    expect((await nativeArtifact(page)).draft.content).toEqual(exampleContent(id, 'structure'));
    await history(page, 'Redo');
    expect((await nativeArtifact(page)).draft.content).toEqual(exampleContent(id));
    const brief = exampleBriefs[id];
    if (!(await page.getByLabel('Map details').isVisible()))
      await page.getByRole('button', { name: 'Layers and inspector', exact: true }).click();
    await page
      .locator('.fm-features')
      .getByRole('button', { name: brief.landmark, exact: true })
      .click();
    await page.getByLabel('Feature x', { exact: true }).fill(String(brief.position[0] + 20));
    await page.getByLabel('Feature y', { exact: true }).fill(String(brief.position[1] - 20));
    await page.getByRole('button', { name: 'Apply feature', exact: true }).click();
    const edited = await nativeArtifact(page);
    const feature = (edited.draft.content as FictionMapContent).features.find(
      (f) => f.id === brief.landmarkId,
    )!;
    expect(feature.geometry).toEqual({
      type: 'point',
      coordinates: [brief.position[0] + 20, brief.position[1] - 20],
    });
    await history(page, 'Undo');
    expect((await nativeArtifact(page)).draft.content).toEqual(exampleContent(id));
    await history(page, 'Redo');
    expect((await nativeArtifact(page)).draft.content).toEqual(edited.draft.content);
    await save(page, 2);
    const saved = await nativeArtifact(page);
    expect(saved.versions[0]).toEqual(before.versions[0]);
    expect(saved.versions[1].content).toEqual(saved.draft.content);
    await page
      .getByLabel('Saved map version', { exact: true })
      .selectOption(saved.versions[1].versionId);
    await page
      .getByLabel('Saved map view', { exact: true })
      .selectOption(JSON.stringify({ kind: 'named', id: 'overview' }));
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export map PNG', exact: true }).click();
    expect(await (await download).failure()).toBeNull();
    await page.reload();
    await expect(page.getByRole('application', { name: 'Fiction Map canvas' })).toBeVisible();
    const reloaded = await nativeArtifact(page);
    expect(reloaded.draft.content).toEqual(saved.draft.content);
    expect(reloaded.versions).toEqual(saved.versions);
    if (await page.getByLabel('Map details').isVisible())
      await page.getByRole('button', { name: 'Layers and inspector', exact: true }).click();
    if (await page.getByLabel('Artifact type', { exact: true }).isVisible())
      await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
    await page.getByRole('button', { name: 'Fit map', exact: true }).click();
    await page.screenshot({
      path: `/tmp/fiction-map-examples/${id}-${info.project.name}.png`,
      fullPage: true,
    });
  });
