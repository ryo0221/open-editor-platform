import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import { commitVersion, createArtifact, contentHash } from '@editor-platform/artifact-core';
import { defaultGeoStyle, emptyGeoWorkspace, type GeoDocument } from '@editor-platform/geo-core';
import { defaultGeoBackgroundSettings } from '@editor-platform/geo-core/backgrounds';
import { test, expect, nativeArtifact, save, create } from './fixtures';
const extent: [number, number, number, number] = [138.8, 35.1, 140.2, 36.1];
const content = (): GeoDocument => ({
  schemaVersion: 1,
  sources: [],
  layers: [
    {
      id: 'places',
      name: 'Places',
      crs: 'OGC:CRS84',
      axis: 'longitude-latitude',
      fields: [],
      features: [
        {
          id: 'tokyo',
          rowId: 'tokyo',
          values: {},
          geometry: { type: 'Point', coordinates: [139.75, 35.68] },
        },
      ],
    },
  ],
  workspace: {
    ...emptyGeoWorkspace(),
    views: [
      {
        id: 'tokyo-view',
        name: 'Tokyo',
        extent,
        styles: [defaultGeoStyle('places')],
        annotations: [],
      },
    ],
  },
});
function longAttributionMap() {
  const d = content();
  d.sources = [
    {
      id: 'source',
      resourceId: 'resource',
      bytesHash: 'sha256:' + 'a'.repeat(64),
      pin: { artifactId: 'source', versionId: 'v1', contentHash: 'sha256:' + 'b'.repeat(64) },
      format: 'geojson',
      adapterVersion: '1',
      declaredCrs: 'OGC:CRS84',
      axis: 'longitude-latitude',
      attribution: 'Legacy source attribution '.repeat(55),
    },
  ];
  return d;
}
async function importMap(page: Page, d = content()) {
  // Keep the ordinary Host's retained-original admission active for the long-credit fixture.
  const geoResources = await Promise.all(
    d.sources.map(async (source) => {
      const bytes = Buffer.from(
        JSON.stringify({
          type: 'FeatureCollection',
          features: d.layers[0].features.map((f) => ({
            type: 'Feature',
            id: f.id,
            geometry: f.geometry,
            properties: f.values,
          })),
        }),
      );
      const manifest = {
        schemaVersion: 1,
        name: 'places.geojson',
        format: 'geojson',
        byteLength: bytes.length,
        bytesHash: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      };
      const sourceVersion = {
        artifactId: source.id,
        versionId: 'source-v1',
        parentVersionId: null,
        schemaVersion: 1,
        contentHash: await contentHash(manifest),
        createdAt: '2026-10-19T00:00:00.000Z',
        createdBy: null,
        reason: 'Retained fixture original',
        content: manifest,
      };
      source.bytesHash = manifest.bytesHash;
      source.pin = {
        artifactId: source.id,
        versionId: sourceVersion.versionId,
        contentHash: 'sha256:' + sourceVersion.contentHash,
      };
      return {
        sourceId: source.id,
        resourceId: source.resourceId,
        pin: source.pin,
        sourceVersion,
        recipe: {},
        encoding: 'base64',
        bytes: bytes.toString('base64'),
      };
    }),
  );
  const artifact = await commitVersion(
    createArtifact('geo', 'Boundary map', d),
    null,
    'Initial saved map',
  );
  await page.goto('/');
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'boundaries.geo.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...artifact, annotations: [], geoResources })),
  });
  await expect(page.getByRole('region', { name: 'Geographic editor', exact: true })).toBeVisible();
  await page.getByLabel('Saved view', { exact: true }).selectOption('tokyo-view');
  await page.getByRole('button', { name: 'Use saved view', exact: true }).click();
  return artifact;
}
async function downloaded(page: Page, name: string, role: 'link' | 'button' = 'link') {
  const event = page.waitForEvent('download');
  await page.getByRole(role, { name, exact: true }).click();
  return readFile((await (await event).path())!);
}
test('#280 offline read-only boundaries preserve native history, save pins, and reach PNG, receipt and Slide', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  const original = await importMap(page, longAttributionMap());
  const before = await nativeArtifact(page);
  await page.context().setOffline(true);
  for (const label of [
    'World countries',
    'World states and provinces',
    'Japan municipalities and wards',
  ])
    await page.getByLabel(`Show ${label}`, { exact: true }).check();
  const map = page.getByRole('region', { name: 'Map', exact: true });
  await expect(map.locator('[data-background-id]')).toHaveCount(3);
  expect(await nativeArtifact(page)).toEqual(before);
  await expect(map.locator('[data-feature-id]')).toHaveCount(1);
  await expect(
    page.getByRole('status', { name: 'Boundary background status', exact: true }),
  ).toContainText('OpenStreetMap');
  await page.getByLabel('World countries boundary color', { exact: true }).fill('#42634f');
  await page.getByLabel('World countries boundary color', { exact: true }).press('Tab');
  await expect(map.locator('[data-background-id="world-countries"] path')).toHaveAttribute(
    'stroke',
    '#42634f',
  );
  expect(await nativeArtifact(page)).toEqual(before);
  await page.getByLabel('View name', { exact: true }).fill('Tokyo with boundaries');
  await page.getByRole('button', { name: 'Save named view', exact: true }).click();
  await save(page, 2);
  const saved = await nativeArtifact(page),
    native = saved.draft.content as GeoDocument;
  expect(saved.versions[0].contentHash).toBe(original.versions[0].contentHash);
  expect(saved.versions[0].content).toEqual(original.versions[0].content);
  const view = native.workspace!.views.find((v) => v.name === 'Tokyo with boundaries')!;
  expect(view.backgrounds).toHaveLength(3);
  expect(JSON.stringify(view.backgrounds)).not.toContain('coordinates');
  await page.getByLabel('PNG saved view', { exact: true }).selectOption(view.id);
  await page.getByRole('button', { name: 'Generate fixed PNG', exact: true }).click();
  const png = await downloaded(page, 'Download fixed PNG');
  await writeFile(info.outputPath('fixed-map.png'), png);
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const receipt = JSON.parse((await downloaded(page, 'Download PNG receipt')).toString());
  expect(receipt.backgrounds.map((b: { id: string }) => b.id)).toEqual(
    view.backgrounds!.map((b) => b.id),
  );
  expect(receipt.backgrounds[0].color).toBe('#42634f');
  expect(receipt.backgroundDiagnostics).toEqual([]);
  expect(receipt.attribution.join(' ')).toContain('CC BY-SA 2.0');
  expect(receipt.attribution).toContain(original.draft.content.sources[0].attribution);
  await page.getByRole('button', { name: 'Place PNG on Slide', exact: true }).click();
  const slide = JSON.parse(
    (await downloaded(page, 'Download Slide with fixed map image')).toString(),
  );
  expect(Buffer.from(slide.draft.content.slides[0].objects[0].src.split(',')[1], 'base64')).toEqual(
    png,
  );
  expect(slide.draft.content.slides[0].notes).toContain(receipt.backgrounds[0].hash);
  await page.getByLabel('Saved view', { exact: true }).selectOption(view.id);
  await page.getByRole('button', { name: 'Use saved view', exact: true }).click();
  if (!(await map.isVisible()))
    await page.getByRole('button', { name: 'Map', exact: true }).click();
  await map.screenshot({ path: info.outputPath('boundary-map.png') });
  await info.attach('background-map.png', { body: png, contentType: 'image/png' });
  await page.context().setOffline(false);
  await page.reload();
  await page.getByLabel('Saved view', { exact: true }).selectOption(view.id);
  await page.getByRole('button', { name: 'Use saved view', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Map', exact: true }).locator('[data-background-id]'),
  ).toHaveCount(3);
  expect((await nativeArtifact(page)).draft.content).toEqual(native);
  expect(
    requests.filter(
      (url) => /^https?:/.test(url) && new URL(url).origin !== new URL(page.url()).origin,
    ),
  ).toEqual([]);
});
test('#280 missing exact dataset keeps features visible and diagnoses the omission in PNG receipt', async ({
  page,
}, info) => {
  const d = content();
  d.workspace!.views[0].backgrounds = defaultGeoBackgroundSettings()
    .slice(0, 1)
    .map((s) => ({ ...s, enabled: true, version: 'not-installed' }));
  await importMap(page, d);
  await expect(
    page.getByRole('status', { name: 'Boundary background status', exact: true }),
  ).toContainText('Pinned boundary dataset unavailable');
  await expect(page.locator('[data-background-id]')).toHaveCount(0);
  await expect(page.locator('[data-feature-id="tokyo"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Generate fixed PNG', exact: true }).click();
  const receipt = JSON.parse((await downloaded(page, 'Download PNG receipt')).toString());
  expect(receipt.backgrounds).toEqual([]);
  expect(receipt.backgroundRequests[0].version).toBe('not-installed');
  expect(receipt.backgroundDiagnostics[0].id).toBe('world-countries');
  await page.screenshot({ path: info.outputPath('missing-boundary.png') });
});
test('#280 normal Slide fixed map references retain only saved view pins and render bundled boundaries', async ({
  page,
}, info) => {
  const d = longAttributionMap();
  d.workspace!.views[0].backgrounds = defaultGeoBackgroundSettings()
    .map((s) => ({
      ...s,
      enabled: true,
    }))
    .reverse();
  await importMap(page, d);
  await create(page, 'slide');
  const tool = page.getByRole('button', { name: '参照を埋め込む', exact: true });
  if (!(await tool.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await tool.click();
  const dialog = page.getByRole('dialog', { name: '参照を埋め込む', exact: true });
  await dialog.getByRole('button', { name: '参照元を再取得', exact: true }).click();
  const select = dialog.getByLabel('埋め込みの参照元');
  await expect(select.locator('option')).not.toHaveCount(1);
  const index = (await select.locator('option').allTextContents()).findIndex((s) =>
    s.includes('Tokyo'),
  );
  expect(index).toBeGreaterThan(0);
  await select.selectOption(String(index - 1));
  await dialog.getByRole('button', { name: '参照を配置', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '参照を配置', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const a = await nativeArtifact(page),
    obj = (
      a.draft.content as {
        slides: { objects: { reference: { snapshot: { content: GeoDocument } }; src: string }[] }[];
      }
    ).slides[0].objects[0];
  expect(obj.reference.snapshot.content.workspace!.views[0].backgrounds).toHaveLength(3);
  expect(Buffer.from(obj.src.split(',')[1], 'base64').toString()).toContain(
    'data-background-id="japan-municipalities"',
  );
  await page.screenshot({ path: info.outputPath('slide-boundary-reference.png') });
});
