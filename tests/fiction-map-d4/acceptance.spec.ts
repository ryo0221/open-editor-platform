import { test, expect, create, nativeArtifact, save, artifactView } from '../e2e/fixtures';
import type { Page } from '@playwright/test';
import { createArtifact, commitVersion, contentHash } from '@editor-platform/artifact-core';
import type { FictionMapContent } from '@editor-platform/fiction-map/model';
import { mapFixture } from '../fiction-map-d3/native-fixture';
async function details(page: Page) {
  if (!(await page.getByLabel('Map details').isVisible()))
    await page.getByRole('button', { name: 'Layers and inspector', exact: true }).click();
}
async function clickWorld(page: Page, x: number, y: number) {
  await page.getByRole('application', { name: 'Fiction Map canvas' }).scrollIntoViewIfNeeded();
  let p = await xy(page, x, y);
  if (p.y < 15 || p.y > page.viewportSize()!.height - 15) {
    await page.evaluate(({ y, h }) => window.scrollBy(0, y - h / 2), {
      y: p.y,
      h: page.viewportSize()!.height,
    });
    p = await xy(page, x, y);
  }
  await page.mouse.click(p.x, p.y);
}
async function xy(page: Page, x: number, y: number) {
  return page.locator('[data-fiction-world]').evaluate(
    (el, p) => {
      const q = new DOMPoint(p.x, p.y).matrixTransform((el as SVGGElement).getScreenCTM()!);
      return { x: q.x, y: q.y };
    },
    { x, y },
  );
}
async function imported(page: Page) {
  const a = await commitVersion(
    createArtifact('fiction-map', 'D4 acceptance', mapFixture()),
    null,
    'baseline',
  );
  await page.goto('/');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'map.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(a)),
  });
  await expect(page.getByRole('application', { name: 'Fiction Map canvas' })).toBeVisible();
  return nativeArtifact(page);
}
async function choose(page: Page, name: string) {
  await details(page);
  await page.locator('.fm-features').getByRole('button', { name, exact: true }).click();
}
async function native(page: Page) {
  return (await nativeArtifact(page)).draft.content as FictionMapContent;
}
async function oneUndo(page: Page, before: FictionMapContent, after: FictionMapContent) {
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  expect(await native(page)).toEqual(before);
  await page.getByRole('button', { name: 'Redo', exact: true }).first().click();
  expect(await native(page)).toEqual(after);
}

test('D4 AC1: author 10 places, 4 regions and 5 paths in the ordinary production Host', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'fiction-map');
  await details(page);
  await page.getByLabel('New layer name', { exact: true }).fill('Terrain');
  await page.getByRole('button', { name: 'Add layer', exact: true }).click();
  for (let i = 0; i < 4; i++) {
    const x = 60 + i * 180;
    await page.getByRole('button', { name: 'Draw region', exact: true }).click();
    for (const p of [
      [x, 300],
      [x + 100, 300],
      [x + 100, 430],
      [x, 430],
    ])
      await clickWorld(page, p[0], p[1]);
    await page.getByRole('button', { name: 'Finish shape', exact: true }).click();
  }
  await details(page);
  await page.getByLabel('New layer name', { exact: true }).fill('Places and routes');
  await page.getByRole('button', { name: 'Add layer', exact: true }).click();
  for (let i = 0; i < 10; i++) {
    await page.getByRole('button', { name: 'Add place', exact: true }).click();
    await clickWorld(page, 60 + i * 80, 140);
  }
  for (let i = 0; i < 5; i++) {
    const x = 60 + i * 160;
    await page.getByRole('button', { name: 'Draw path', exact: true }).click();
    for (const p of [
      [x, 550],
      [x + 50, 620],
      [x + 110, 560],
    ])
      await clickWorld(page, p[0], p[1]);
    await page.getByRole('button', { name: 'Finish shape', exact: true }).click();
  }
  const built = await nativeArtifact(page),
    c = built.draft.content as FictionMapContent;
  expect(c.features.filter((f) => f.featureKind === 'place')).toHaveLength(10);
  expect(c.features.filter((f) => f.featureKind === 'region')).toHaveLength(4);
  expect(c.features.filter((f) => f.featureKind === 'path')).toHaveLength(5);
  expect(c.layers).toHaveLength(2);
  expect(c.layers.map((l) => l.name)).toEqual(['Terrain', 'Places and routes']);
  for (const feature of c.features) {
    const expectedLayerId = feature.featureKind === 'region' ? c.layers[0].id : c.layers[1].id;
    expect(feature.layerId, `${feature.featureKind} ${feature.id} drawing layer`).toBe(
      expectedLayerId,
    );
  }
  expect(new Set(c.features.map((f) => f.id)).size).toBe(19);
  await save(page, 1);
  const saved = await nativeArtifact(page);
  expect(saved.versions[0].content).toEqual(c);
  expect(saved.versions[0].contentHash).toBe(await contentHash(c));
  await page.reload();
  const reopened = await nativeArtifact(page);
  expect(reopened.draft.content).toEqual(c);
  expect(reopened.versions).toEqual(saved.versions);
  await artifactView(page, 'History');
  await expect(page.getByAltText('Immutable Fiction Map version')).toBeVisible();
  await artifactView(page, 'Editor');
  await page.screenshot({
    path: `/tmp/fiction-map-d4/authored-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test('D4 AC2: rename, position and region vertex each undo once; saved old source stays fixed', async ({
  page,
}) => {
  const a = await imported(page),
    original = a.draft.content as FictionMapContent;
  await choose(page, 'Place 0');
  await page.getByLabel('Feature name', { exact: true }).fill('Harbor');
  await page.getByRole('button', { name: 'Apply feature', exact: true }).click();
  const renamed = await native(page);
  expect(renamed.features[0]).toEqual({ ...original.features[0], name: 'Harbor' });
  await oneUndo(page, original, renamed);
  await choose(page, 'Harbor');
  await page.getByLabel('Feature x', { exact: true }).fill('180');
  await page.getByLabel('Feature y', { exact: true }).fill('90');
  await page.getByRole('button', { name: 'Apply feature', exact: true }).click();
  const moved = await native(page);
  expect(moved.features[0]).toEqual({
    ...renamed.features[0],
    geometry: { type: 'point', coordinates: [180, 90] },
  });
  await oneUndo(page, renamed, moved);
  await choose(page, 'Region 0');
  await page.getByRole('button', { name: 'Edit vertices', exact: true }).click();
  const handle = page.getByRole('button', { name: 'Vertex 1 of Region 0', exact: true });
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 8, { steps: 4 });
  await page.mouse.up();
  const vertex = await native(page);
  expect(vertex.features[10].geometry).not.toEqual(moved.features[10].geometry);
  expect(vertex.features.filter((f) => f.id !== 'region-0')).toEqual(
    moved.features.filter((f) => f.id !== 'region-0'),
  );
  await oneUndo(page, moved, vertex);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await choose(page, 'Place 1');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.getByRole('button', { name: 'Pan canvas', exact: true }).click();
  await page.getByRole('application', { name: 'Fiction Map canvas' }).scrollIntoViewIfNeeded();
  const stage = (await page
    .getByRole('application', { name: 'Fiction Map canvas' })
    .boundingBox())!;
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width / 2 + 20, stage.y + stage.height / 2 + 12, {
    steps: 3,
  });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Pan canvas', exact: true }).click();
  expect(await native(page)).toEqual(vertex);
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  expect(await native(page)).toEqual(moved);
  await page.getByRole('button', { name: 'Redo', exact: true }).first().click();
  await save(page, 2);
  const final = await nativeArtifact(page);
  expect(final.versions[0]).toEqual(a.versions[0]);
  expect(final.versions[1].content).toEqual(vertex);
  expect((final.draft.content as FictionMapContent).features[0].worldEntityRef).toEqual(
    original.features[0].worldEntityRef,
  );
  await page.reload();
  expect((await nativeArtifact(page)).versions).toEqual(final.versions);
  await page.getByLabel('Saved map version').selectOption(a.versions[0].versionId);
  const src = await page.getByAltText('Saved Fiction Map version').getAttribute('src');
  expect(decodeURIComponent(src!)).toContain('Place 0');
  expect(decodeURIComponent(src!)).not.toContain('Harbor');
  await page.screenshot({
    path: `/tmp/fiction-map-d4/pinned-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test('D4 N09: ordinary readOnly rejects edits and shortcuts while retaining view and native export', async ({
  page,
}) => {
  const before = await imported(page);
  await choose(page, 'Place 0');
  await page.getByRole('button', { name: 'More artifact actions', exact: true }).click();
  await page.getByLabel('Read only', { exact: true }).check();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Add place', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Feature name', { exact: true })).toBeDisabled();
  await page.getByRole('application', { name: 'Fiction Map canvas' }).focus();
  for (const key of ['ArrowRight', 'Delete', 'Control+z', 'Control+s'])
    await page.keyboard.press(key);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const after = await nativeArtifact(page);
  expect(after.draft.content).toEqual(before.draft.content);
  expect(after.versions).toEqual(before.versions);
  await expect(page.getByRole('button', { name: 'Undo', exact: true }).first()).toBeDisabled();
});
