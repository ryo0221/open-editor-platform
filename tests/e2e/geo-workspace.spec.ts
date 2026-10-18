import { mkdir, readFile } from 'node:fs/promises';
import { test, expect, create, save, nativeArtifact, editCell } from './fixtures';
import type { Page } from '@playwright/test';
import type { GeoDocument } from '@editor-platform/geo-core';
async function importFile(page: Page, name: string, text: string) {
  await page
    .getByLabel('Import artifact', { exact: true })
    .setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
}
async function activate(page: Page, name: string) {
  if (!(await page.getByLabel('Artifact type', { exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page
    .getByRole('button', { name: new RegExp(name) })
    .first()
    .click();
}
async function embedGeo(page: Page, mode: 'fixed' | 'follow') {
  const tool = page.getByRole('button', { name: '参照を埋め込む', exact: true });
  if (!(await tool.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await tool.click();
  const menu = page.getByRole('dialog', { name: '参照を埋め込む', exact: true });
  await menu.getByRole('button', { name: '参照元を再取得', exact: true }).click();
  const select = menu.getByLabel('埋め込みの参照元');
  await expect(select.locator('option')).not.toHaveCount(1);
  const options = await select.locator('option').allTextContents(),
    index = options.findIndex((x) => x.includes('Geo') && x.includes('Current map'));
  expect(index).toBeGreaterThan(0);
  await select.selectOption(String(index - 1));
  if (mode === 'fixed') await expect(menu.getByLabel('埋め込みの更新方式')).toHaveValue('fixed');
  else await menu.getByLabel('埋め込みの更新方式').selectOption(mode);
  await menu.getByRole('button', { name: '参照を配置', exact: true }).click();
  await expect(menu.getByRole('button', { name: '参照を配置', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
}
test('additional request: Japanese CSV → saved Data join → proportional map → Slide fixed/follow → explicit refresh → reload', async ({
  page,
}, info) => {
  await page.goto('/');
  await importFile(page, '支店売上.csv', 'branch,sales\n01,100\n02,400\n');
  await expect(page.getByLabel('Artifact name')).toHaveValue('支店売上');
  await save(page, 1);
  const data = await nativeArtifact(page);
  await create(page, 'geo');
  await expect(page.getByRole('region', { name: 'Geographic editor', exact: true })).toBeVisible();
  const work = page.getByRole('region', { name: 'Import geographic data', exact: true });
  await work.getByLabel('Local file', { exact: true }).setInputFiles({
    name: '支店.geojson',
    mimeType: 'application/geo+json',
    buffer: Buffer.from(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: '01',
            geometry: { type: 'Point', coordinates: [139, 35] },
            properties: { branch: '01' },
          },
          {
            type: 'Feature',
            id: '02',
            geometry: { type: 'Point', coordinates: [141, 38] },
            properties: { branch: '02' },
          },
        ],
      }),
    ),
  });
  await work.getByLabel('Format', { exact: true }).selectOption('geojson');
  await work.getByLabel('Layer name', { exact: true }).fill('Branches');
  await work.getByRole('button', { name: 'Add field', exact: true }).click();
  await work.getByLabel('Input column/property 1', { exact: true }).fill('branch');
  await work.getByLabel('Display name 1', { exact: true }).fill('Branch');
  await work.getByRole('button', { name: 'Preview import', exact: true }).click();
  await work.getByRole('button', { name: 'Import previewed data', exact: true }).click();
  await expect(
    page.getByRole('table', { name: 'Branches attributes' }).getByRole('row'),
  ).toHaveCount(3);
  await save(page, 1);
  const before = await nativeArtifact(page),
    geo = before.draft.content as GeoDocument,
    layer = geo.layers[0],
    join = page.getByRole('region', { name: 'Join existing Data artifact' });
  await join.getByLabel('Saved Data artifact', { exact: true }).selectOption(data.id);
  await join.getByLabel('Geo join layer', { exact: true }).selectOption(layer.id);
  await join.getByLabel('Geo key', { exact: true }).selectOption('field-1');
  await join.getByLabel('Data key', { exact: true }).selectOption({ label: 'branch (text)' });
  await join.getByRole('button', { name: 'Preview Data join / refresh', exact: true }).click();
  await expect(join.getByRole('status', { name: 'Data join status' })).toContainText('2 matched');
  await join.getByRole('button', { name: 'Adopt previewed Data version', exact: true }).click();
  await expect(join.getByRole('status', { name: 'Data join status' })).toContainText('adopted');
  const salesId = (data.draft.content as { columns: { id: string; name: string }[] }).columns.find(
    (c) => c.name === 'sales',
  )!.id;
  const field = `join:data-values:${salesId}`;
  await page.getByLabel('Symbol mode', { exact: true }).selectOption('proportional');
  await page.getByLabel('Style field', { exact: true }).selectOption(field);
  await page.getByLabel('Metric kind', { exact: true }).selectOption('count');
  await page.getByLabel('Numerator field', { exact: true }).selectOption(field);
  await page.getByLabel('Indicator', { exact: true }).fill('Branch sales');
  await page.getByLabel('Unit', { exact: true }).fill('万円');
  await page.getByLabel('Period', { exact: true }).fill('2026 Q4');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('button', { name: 'Fit map', exact: true }).click();
  await save(page, 2);
  const pinned = await nativeArtifact(page);
  expect((pinned.draft.content as GeoDocument).workspace!.joins[0].inputs.right.versionId).toBe(
    data.versions[0].versionId,
  );
  await create(page, 'slide');
  await page.getByLabel('Artifact name').fill('Following map');
  await page.getByLabel('Artifact name').press('Tab');
  await embedGeo(page, 'follow');
  await save(page, 1);
  const slideBefore = await nativeArtifact(page);
  const firstRef = (
    slideBefore.draft.content as { slides: { objects: { src: string; reference?: unknown }[] }[] }
  ).slides[0].objects.find((o) => o.reference)!;
  expect(firstRef.src).toContain('data:image/svg+xml');
  await create(page, 'slide');
  await page.getByLabel('Artifact name').fill('Fixed map');
  await page.getByLabel('Artifact name').press('Tab');
  await embedGeo(page, 'fixed');
  await save(page, 1);
  const fixedBefore = await nativeArtifact(page);
  await activate(page, '支店売上');
  await editCell(page, 'sales', 1, '900');
  await save(page, 2);
  await activate(page, 'Geo 1');
  await expect(join).toContainText('新しい Data 版');
  expect((await nativeArtifact(page)).draft.content).toEqual(pinned.draft.content);
  await join.getByLabel('Saved Data artifact', { exact: true }).selectOption(data.id);
  await join.getByLabel('Geo join layer', { exact: true }).selectOption(layer.id);
  await join.getByLabel('Geo key', { exact: true }).selectOption('field-1');
  await join.getByLabel('Data key', { exact: true }).selectOption({ label: 'branch (text)' });
  await join.getByRole('button', { name: 'Preview Data join / refresh', exact: true }).click();
  await expect(join.getByRole('status', { name: 'Data join status' })).toContainText('2 matched');
  await join.getByRole('button', { name: 'Adopt previewed Data version', exact: true }).click();
  await expect(join.getByRole('status', { name: 'Data join status' })).toContainText('adopted');
  await save(page, 3);
  await activate(page, 'Following map');
  const following = await nativeArtifact(page);
  const ref = (
    following.draft.content as typeof slideBefore.draft.content & {
      slides: { objects: { src: string; reference?: { snapshot: { versionId: string } } }[] }[];
    }
  ).slides[0].objects.find((o) => o.reference)!;
  expect(ref.src).not.toBe(firstRef.src);
  expect(ref.reference!.snapshot.versionId).not.toBe(
    (firstRef as unknown as { reference: { snapshot: { versionId: string } } }).reference.snapshot
      .versionId,
  );
  await activate(page, 'Fixed map');
  expect((await nativeArtifact(page)).draft.content).toEqual(fixedBefore.draft.content);
  await page.reload();
  await expect(page.getByLabel('Artifact name')).toHaveValue('Fixed map');
  expect((await nativeArtifact(page)).draft.content).toEqual(fixedBefore.draft.content);
  await activate(page, 'Geo 1');
  await expect(page.getByRole('table', { name: 'Branches attributes' })).toContainText('900');
  await mkdir(`/tmp/issue97-playground-evidence/${info.project.name}`, { recursive: true });
  await page.screenshot({
    path: `/tmp/issue97-playground-evidence/${info.project.name}/map.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Fit map', exact: true }).click();
  await page.getByLabel('View name', { exact: true }).fill('Sales map');
  await page.getByRole('button', { name: 'Save named view', exact: true }).click();
  await save(page, 4);
  await page.getByRole('button', { name: 'Generate fixed PNG', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Download fixed PNG', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Place PNG on Slide', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page
    .getByRole('link', { name: 'Download Slide with fixed map image', exact: true })
    .click();
  const download = await downloadPromise;
  const text = await readFile((await download.path())!, 'utf8');
  await importFile(page, 'fixed-map.slide.json', text);
  await expect(page.getByLabel('Artifact name')).toHaveValue('Geographic map · fixed image');
  const staticSlide = await nativeArtifact(page),
    objects = (
      staticSlide.draft.content as { slides: { objects: { type: string; src?: string }[] }[] }
    ).slides[0].objects;
  expect(objects.some((o) => o.src?.startsWith('data:image/png;base64,'))).toBe(true);
  await expect(page.locator('image[href^="data:image/png"]').last()).toBeVisible();
  await page.screenshot({
    path: `/tmp/issue97-playground-evidence/${info.project.name}/slide.png`,
  });
});
