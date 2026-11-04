import { test, expect, create, nativeArtifact, save, artifactView } from '../e2e/fixtures';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createArtifact, commitVersion } from '@editor-platform/artifact-core';
import type { FictionMapContent } from '@editor-platform/fiction-map/model';
import { mapFixture } from './native-fixture';
async function importMap(page: Page, axis: 'up' | 'down' = 'down') {
  const artifact = await commitVersion(
    createArtifact('fiction-map', `D3 Map ${axis}`, mapFixture(axis)),
    'tester',
    'Original map',
  );
  await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'map.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(artifact)),
  });
  await expect(page.getByRole('application', { name: 'Fiction Map canvas' })).toBeVisible();
  const actual = await nativeArtifact(page);
  expect(actual.draft.content).toEqual(artifact.draft.content);
  return {
    ...artifact,
    id: actual.id,
    versions: artifact.versions.map((v) => ({ ...v, artifactId: actual.id })),
  };
}
async function details(page: Page) {
  if (!(await page.getByLabel('Map details').isVisible()))
    await page.getByRole('button', { name: 'Layers and inspector', exact: true }).click();
}
async function selectPlace(page: Page) {
  await details(page);
  await page.locator('.fm-features').getByRole('button', { name: 'Place 0', exact: true }).click();
}
async function rename(page: Page, name: string) {
  await selectPlace(page);
  await page.getByLabel('Feature name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Apply feature', exact: true }).click();
}
async function download(page: Page, name: string) {
  const wait = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  return readFile((await (await wait).path())!);
}
async function independent(page: Page) {
  await page.goto('http://127.0.0.1:4192/d3.html');
  await expect(page.getByTestId('native')).toContainText('place-9');
}

test('normal production Host admits 19 features, edits with one history, saves and reopens', async ({
  page,
}) => {
  await page.goto('/');
  const original = await importMap(page);
  expect((await nativeArtifact(page)).draft.content).toEqual(original.draft.content);
  await rename(page, 'Harbor renamed');
  let current = await nativeArtifact(page);
  const content = current.draft.content as FictionMapContent;
  expect(content.features).toHaveLength(19);
  expect(content.features[0]).toEqual({
    ...original.draft.content.features[0],
    name: 'Harbor renamed',
  });
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  expect(((await nativeArtifact(page)).draft.content as FictionMapContent).features[0].name).toBe(
    'Place 0',
  );
  await page.getByRole('button', { name: 'Redo', exact: true }).first().click();
  await save(page, 2);
  current = await nativeArtifact(page);
  expect(current.versions[0]).toEqual(original.versions[0]);
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(current.draft.content);
  await expect(page.getByRole('region', { name: 'World reference diagnostics' })).toContainText(
    'not connected',
  );
  await page.screenshot({
    path: `/tmp/fiction-map-d3/normal-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test('normal Host blocks dirty/IME/invalid drawing on save, export and switching', async ({
  page,
}) => {
  await page.goto('/');
  await importMap(page);
  await selectPlace(page);
  const field = page.getByLabel('Feature name', { exact: true });
  await field.fill('Uncommitted');
  await create(page, 'document');
  await expect(page.getByLabel('Artifact name')).toHaveValue('D3 Map down');
  await expect(field).toHaveValue('Uncommitted');
  const closeLibrary = page.getByRole('button', { name: 'Close library panel', exact: true });
  if (await closeLibrary.isVisible()) await closeLibrary.click();
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await page.getByRole('button', { name: 'この版を保存', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText(/Apply|cancel|input/i);
  await expect(field).toHaveValue('Uncommitted');
  await page.keyboard.press('Escape');
  await field.dispatchEvent('compositionstart');
  await page.getByRole('button', { name: 'Export artifact', exact: true }).click();
  const exportJson = page.getByRole('button', { name: 'Export JSON', exact: true });
  if (await exportJson.isVisible()) await exportJson.click();
  await expect(field).toHaveValue('Uncommitted');
  await field.dispatchEvent('compositionend');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Cancel edits', exact: true }).click();
  await page.getByRole('button', { name: 'Draw region', exact: true }).click();
  await page.locator('[data-fiction-world]').scrollIntoViewIfNeeded();
  const point = await page.locator('[data-fiction-world]').evaluate((el) => {
    const p = new DOMPoint(250, 300).matrixTransform((el as SVGGElement).getScreenCTM()!);
    return { x: p.x, y: p.y };
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.getByText('1 draft vertices', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await page.getByRole('button', { name: 'この版を保存', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText(/Finish|cancel|pending/i);
  await expect(page.getByRole('button', { name: 'Cancel drawing', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel drawing', exact: true }).click();
  const native = await nativeArtifact(page);
  expect((native.draft.content as FictionMapContent).features).toEqual(mapFixture().features);
});

for (const axis of ['up', 'down'] as const)
  test(`saved version output is deterministic, transparent, named and independent of current draft (${axis})`, async ({
    page,
  }) => {
    await page.goto('/');
    const original = await importMap(page, axis);
    await rename(page, 'Unpublished rename');
    await page.getByLabel('Map output width').fill('500');
    await page.getByLabel('Map output height').fill('350');
    await page.getByLabel('Transparent map background').check();
    const svg = (await download(page, 'Export map SVG')).toString();
    expect(svg).toContain('Place 0');
    expect(svg).not.toContain('Unpublished rename');
    expect(svg).toContain('width="500"');
    const png = await download(page, 'Export map PNG');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(500);
    expect(png.readUInt32BE(20)).toBe(350);
    expect(await download(page, 'Export map PNG')).toEqual(png);
    const alpha = await page.evaluate(async (data) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, 1, 1).data[3];
    }, png.toString('base64'));
    expect(alpha).toBe(0);
    await page
      .getByRole('combobox', { name: 'Saved map view', exact: true })
      .selectOption(JSON.stringify({ kind: 'named', id: 'default' }));
    expect((await download(page, 'Export map SVG')).toString()).not.toBe(svg);
    const namedPng = await download(page, 'Export map PNG');
    expect(namedPng.subarray(1, 4).toString()).toBe('PNG');
    expect(namedPng).not.toEqual(png);
    await page
      .getByRole('region', { name: 'Saved map output' })
      .screenshot({ path: `/tmp/fiction-map-d3/output-${test.info().project.name}.png` });
    await page.getByLabel('Map output width').fill('4097');
    await expect(page.getByRole('button', { name: 'Export map PNG', exact: true })).toBeDisabled();
    expect((await nativeArtifact(page)).versions).toEqual(original.versions);
  });

test('two normal Fiction Map artifacts keep native, selection and history separate', async ({
  page,
}) => {
  await page.goto('/');
  const first = await importMap(page);
  await rename(page, 'First edited');
  const edited = await nativeArtifact(page);
  await create(page, 'fiction-map');
  const second = await nativeArtifact(page);
  expect(second.id).not.toBe(first.id);
  expect((second.draft.content as FictionMapContent).features).toEqual([]);
  await page.getByLabel('Named document view').fill('Second view');
  await page.getByRole('button', { name: 'Save bounds as named view', exact: true }).click();
  expect(((await nativeArtifact(page)).draft.content as FictionMapContent).namedViews).toHaveLength(
    1,
  );
  const names = page.getByLabel('Artifact name');
  await expect(names).toBeVisible();
  if (
    !(await page.getByRole('button', { name: new RegExp(first.name + ' Fiction Map') }).isVisible())
  )
    await page.getByRole('button', { name: 'Toggle library', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(first.name + ' Fiction Map') }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(edited.draft.content);
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  expect(((await nativeArtifact(page)).draft.content as FictionMapContent).features[0].name).toBe(
    'Place 0',
  );
});

test('independent public Artifact Host preserves failed/delayed saves and immutable versions', async ({
  page,
}) => {
  await independent(page);
  const original = JSON.parse((await page.getByTestId('versions').textContent())!);
  await page.getByRole('button', { name: 'External rename', exact: true }).click();
  await page.getByRole('button', { name: 'Fail next save', exact: true }).click();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Injected storage failure');
  await expect(page.getByTestId('dirty')).toHaveText('true');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByTestId('dirty')).toHaveText('false');
  await page.getByRole('button', { name: 'Delay next save', exact: true }).click();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByTestId('saving')).toHaveText('true');
  await page.getByRole('button', { name: 'External rename', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle permission', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add place', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Release save', exact: true }).click();
  await expect(page.getByTestId('saving')).toHaveText('false');
  await expect(page.getByTestId('dirty')).toHaveText('true');
  await expect(page.getByTestId('native')).toContainText('Newer draft 2');
  await page.getByRole('button', { name: 'External rename', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('permission-denied');
  expect(JSON.parse((await page.getByTestId('versions').textContent())!)).toEqual(original);
});

test('independent fixed reference hides forbidden pixels, warns offline; mock World resolves and revokes', async ({
  page,
}) => {
  await independent(page);
  await expect(
    page.getByRole('region', { name: 'World reference diagnostics' }).first(),
  ).toContainText('Verified World city');
  await page.getByRole('button', { name: 'Create fixed reference', exact: true }).click();
  const image = page.getByAltText('Fixed map reference');
  await expect(image).toHaveAttribute('src', /^data:image\/svg/);
  const src = await image.getAttribute('src');
  await page.getByRole('button', { name: 'External rename', exact: true }).click();
  await page.getByRole('button', { name: 'Create version', exact: true }).click();
  await expect(image).toHaveAttribute('src', src!);
  const stable = {
    native: await page.getByTestId('native').textContent(),
    versions: await page.getByTestId('versions').textContent(),
    revision: await page.getByTestId('revision').textContent(),
  };
  await page.getByRole('button', { name: 'Reference forbidden', exact: true }).click();
  await expect(image).not.toHaveAttribute('src');
  await page.getByRole('button', { name: 'Reference offline', exact: true }).click();
  await expect(image).toHaveAttribute('src', src!);
  await expect(page.getByRole('status').filter({ hasText: 'オフライン' })).toContainText(
    '保持した固定表示',
  );
  await page.getByRole('button', { name: 'Delay World lookup', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'World reference diagnostics' }).first(),
  ).toContainText('loading');
  await page.getByRole('button', { name: 'World forbidden', exact: true }).click();
  await page.getByRole('button', { name: 'Release World lookup', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'World reference diagnostics' }).first(),
  ).toContainText('forbidden');
  await expect(page.getByText('Verified World city')).toHaveCount(0);
  await page.getByRole('button', { name: 'Reference missing-target', exact: true }).click();
  await expect(image).not.toHaveAttribute('src');
  await expect(
    page.getByRole('status').filter({ hasText: 'Saved version is missing' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Reference stale', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'stale' })).toBeVisible();
  await expect(image).not.toHaveAttribute('src');
  await page.getByRole('button', { name: 'World missing-source', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'World reference diagnostics' }).first(),
  ).toContainText('missing-source');
  expect({
    native: await page.getByTestId('native').textContent(),
    versions: await page.getByTestId('versions').textContent(),
    revision: await page.getByTestId('revision').textContent(),
  }).toEqual(stable);
  await page.screenshot({
    path: `/tmp/fiction-map-d3/mock-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test('immutable history displays and explicitly restores a draft with one Undo', async ({
  page,
}) => {
  await page.goto('/');
  const original = await importMap(page);
  await rename(page, 'Version two');
  await save(page, 2);
  await artifactView(page, 'History');
  await expect(page.getByAltText('Immutable Fiction Map version')).toHaveCount(2);
  await page.getByRole('button', { name: 'Restore to draft', exact: true }).first().click();
  await artifactView(page, 'Editor');
  expect((await nativeArtifact(page)).draft.content).toEqual(original.draft.content);
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  const restored = await nativeArtifact(page);
  expect((restored.draft.content as FictionMapContent).features[0].name).toBe('Version two');
  expect(restored.versions[0]).toEqual(original.versions[0]);
  expect(restored.versions).toHaveLength(2);
});

test('invalid native/version hash imports are wholly rejected without a partial artifact', async ({
  page,
}) => {
  await page.goto('/');
  const original = await importMap(page);
  const before = await nativeArtifact(page);
  for (const failure of ['hash', 'schema', 'duplicate'] as const) {
    const a = structuredClone(original);
    a.id = `invalid-${failure}`;
    let text = '';
    if (failure === 'hash') a.versions[0].contentHash = '0'.repeat(64);
    else if (failure === 'schema') Reflect.set(a.versions[0].content, 'schemaVersion', 99);
    text = JSON.stringify(a);
    if (failure === 'duplicate')
      text = text.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersi\\u006fn":1');
    await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
      name: `${failure}.json`,
      mimeType: 'application/json',
      buffer: Buffer.from(text),
    });
    await expect(page.getByRole('alert').first()).toBeVisible();
    expect((await nativeArtifact(page)).id).toBe(before.id);
  }
});

test('normal Slide consumes saved Fiction Map as fixed image and disables follow', async ({
  page,
}) => {
  await page.goto('/');
  const original = await importMap(page);
  await create(page, 'slide');
  const more = page.getByRole('button', { name: 'More editor tools', exact: true });
  if (await more.isVisible()) await more.click();
  await page.getByRole('button', { name: '参照を埋め込む', exact: true }).click();
  await page.getByRole('button', { name: '参照元を再取得', exact: true }).click();
  const source = page.getByLabel('埋め込みの参照元');
  const options = await source.locator('option').allTextContents();
  const index = options.findIndex((t) => t.includes(original.name));
  expect(index).toBeGreaterThan(0);
  await source.selectOption(String(index - 1));
  await expect(
    page.getByLabel('埋め込みの更新方式').locator('option[value="follow"]'),
  ).toHaveAttribute('disabled', '');
  await page.getByRole('button', { name: '参照を配置', exact: true }).click();
  await page.keyboard.press('Escape');
  const slide = await nativeArtifact(page);
  const json = JSON.stringify(slide.draft.content);
  expect(json).toContain(original.versions[0].versionId);
  expect(json).toContain(original.versions[0].contentHash);
  expect(json).toContain('fiction-map-document');
});

test('production Artifact Host saves, closes, reopens and uses its own guarded history', async ({
  page,
}) => {
  await page.goto('http://127.0.0.1:4177');
  await page.getByRole('button', { name: 'Fiction Mapを開く', exact: true }).click();
  await expect(page.getByRole('application', { name: 'Fiction Map canvas' })).toBeVisible();
  await details(page);
  await page.getByLabel('New layer name', { exact: true }).fill('Host places');
  await page.getByRole('button', { name: 'Add layer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Host Undo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  await expect(page.getByLabel('Map details')).not.toContainText('Host places');
  await page.getByRole('button', { name: 'Host Redo', exact: true }).click();
  await page.getByRole('button', { name: '保存してアプリに戻る', exact: true }).click();
  await page.getByRole('button', { name: 'Fiction Mapを開く', exact: true }).click();
  await expect(page.getByLabel('Saved map version').locator('option')).toHaveCount(1);
  await page.getByLabel('閲覧モード', { exact: true }).check();
  await expect(page.getByRole('button', { name: 'Add place', exact: true })).toBeDisabled();
  await page.getByLabel('閲覧モード', { exact: true }).uncheck();
  const json = JSON.parse((await download(page, '成果物JSON保存')).toString());
  expect(json.kind).toBe('fiction-map');
  expect(json.draft.content.layers[0].name).toBe('Host places');
  expect(json.versions).toHaveLength(1);
});

test('normal new map creates point, polyline, polygon and named view through visible controls', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'fiction-map');
  await details(page);
  await page.getByLabel('New layer name', { exact: true }).fill('New land');
  await page.getByRole('button', { name: 'Add layer', exact: true }).click();
  async function clickWorld(x: number, y: number) {
    await page.locator('[data-fiction-world]').scrollIntoViewIfNeeded();
    const p = await page.locator('[data-fiction-world]').evaluate(
      (el, p) => {
        const q = new DOMPoint(p.x, p.y).matrixTransform((el as SVGGElement).getScreenCTM()!);
        return { x: q.x, y: q.y };
      },
      { x, y },
    );
    await page.mouse.click(p.x, p.y);
  }
  await page.getByRole('button', { name: 'Add place', exact: true }).click();
  await clickWorld(100, 100);
  await page.getByRole('button', { name: 'Draw path', exact: true }).click();
  await clickWorld(150, 150);
  await clickWorld(250, 170);
  await page.getByRole('button', { name: 'Finish shape', exact: true }).click();
  await page.getByRole('button', { name: 'Draw region', exact: true }).click();
  for (const p of [
    [300, 200],
    [400, 200],
    [350, 280],
  ])
    await clickWorld(p[0], p[1]);
  await page.getByRole('button', { name: 'Finish shape', exact: true }).click();
  await page.getByLabel('Named document view').fill('My whole map');
  await page.getByRole('button', { name: 'Save bounds as named view', exact: true }).click();
  const content = (await nativeArtifact(page)).draft.content as FictionMapContent;
  expect(content.features.map((f) => f.geometry.type)).toEqual(['point', 'polyline', 'polygon']);
  expect(content.namedViews[0].extent).toEqual(content.coordinateSpace.bounds);
  await save(page, 1);
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(content);
});

test('normal persistence failure keeps durable native and offers retry without losing edits', async ({
  page,
}) => {
  await page.goto('/');
  const a = await importMap(page);
  const current = await nativeArtifact(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, ...args: []) {
      if ((value as { kind?: string }).kind === 'fiction-map') {
        IDBObjectStore.prototype.put = original;
        throw new DOMException('Injected IndexedDB failure', 'UnknownError');
      }
      return original.call(this, value, ...args);
    };
  });
  await rename(page, 'Unsaved harbor');
  await expect(page.getByRole('alert').first()).toContainText(
    /Injected IndexedDB failure|save|保存/i,
  );
  await expect(page.getByRole('button', { name: /Retry/i })).toBeVisible();
  const durable = (await page.evaluate(
    (id) =>
      new Promise<unknown>((resolve, reject) => {
        const open = indexedDB.open('editor-platform');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const q = db.transaction('artifacts').objectStore('artifacts').get(id);
          q.onsuccess = () => {
            resolve(q.result);
            db.close();
          };
          q.onerror = () => reject(q.error);
        };
      }),
    current.id,
  )) as { draft: { content: FictionMapContent } };
  expect(durable.draft.content).toEqual(a.draft.content);
  await page.getByRole('button', { name: /Retry/i }).click();
  await expect(page.getByRole('status').first()).toHaveText('Saved locally');
  expect(((await nativeArtifact(page)).draft.content as FictionMapContent).features[0].name).toBe(
    'Unsaved harbor',
  );
  await page.reload();
  expect(((await nativeArtifact(page)).draft.content as FictionMapContent).features[0].name).toBe(
    'Unsaved harbor',
  );
});

test('production PNG refuses a result if Inspector input changes while rasterization is pending', async ({
  page,
}) => {
  await page.goto('/');
  const original = await importMap(page);
  await selectPlace(page);
  await page.evaluate(() => {
    const gate = { pending: false, release: () => {} };
    Object.assign(window, { d3PngGate: gate });
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      HTMLCanvasElement.prototype.toBlob = original;
      return original.call(
        this,
        (blob) => {
          gate.pending = true;
          gate.release = () => callback(blob);
        },
        type,
        quality,
      );
    };
  });
  const downloads: string[] = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  await page.getByRole('button', { name: 'Export map PNG', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, 'd3PngGate').pending)).toBe(true);
  const field = page.getByLabel('Feature name', { exact: true });
  await field.fill('Private input during PNG');
  await page.evaluate(() => Reflect.get(window, 'd3PngGate').release());
  await expect(page.getByRole('alert').first()).toContainText('stale-output');
  await expect(field).toHaveValue('Private input during PNG');
  expect(downloads).toEqual([]);
  await page.getByRole('button', { name: 'Cancel edits', exact: true }).click();
  const current = await nativeArtifact(page);
  expect(current.draft.content).toEqual(original.draft.content);
  expect(current.versions).toEqual(original.versions);
  await expect(page.getByRole('button', { name: 'Undo', exact: true }).first()).toBeDisabled();
});

test('review: dirty Inspector deletion refuses without orphaning input or history', async ({
  page,
}) => {
  await page.goto('/');
  const before = await importMap(page);
  await selectPlace(page);
  const field = page.getByLabel('Feature name', { exact: true });
  await field.fill('Keep this private text');
  await page.getByRole('button', { name: 'Delete selected', exact: true }).click();
  await expect(field).toHaveValue('Keep this private text');
  await expect(page.getByRole('alert').first()).toContainText(/Apply|cancel/i);
  await page.getByRole('button', { name: 'Cancel edits', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(before.draft.content);
  await page.getByRole('button', { name: 'Draw path', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Draw path', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Delete selected', exact: true }).click();
  expect(((await nativeArtifact(page)).draft.content as FictionMapContent).features).toHaveLength(
    18,
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  expect((await nativeArtifact(page)).draft.content).toEqual(before.draft.content);
});

test('review: active vertex drag refuses keyboard save until commit or cancel', async ({
  page,
}) => {
  await page.goto('/');
  const before = await importMap(page);
  await details(page);
  await page.locator('.fm-features').getByRole('button', { name: 'Region 0', exact: true }).click();
  await page.getByRole('button', { name: 'Edit vertices', exact: true }).click();
  const h = page.getByRole('button', { name: 'Vertex 1 of Region 0', exact: true });
  await h.scrollIntoViewIfNeeded();
  const b = (await h.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 15, b.y + b.height / 2 + 10, { steps: 5 });
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('alert').first()).toContainText(/Finish|cancel|input/i);
  await expect(page.getByLabel('Saved map version').locator('option')).toHaveCount(1);
  await page.mouse.up();
  const after = await nativeArtifact(page);
  expect((after.draft.content as FictionMapContent).features[10].geometry).not.toEqual(
    before.draft.content.features[10].geometry,
  );
  expect(after.versions).toEqual(before.versions);
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  expect((await nativeArtifact(page)).draft.content).toEqual(before.draft.content);
  await h.scrollIntoViewIfNeeded();
  const cancelBox = (await h.boundingBox())!;
  await page.mouse.move(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    cancelBox.x + cancelBox.width / 2 + 12,
    cancelBox.y + cancelBox.height / 2 + 6,
  );
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect((await nativeArtifact(page)).draft.content).toEqual(before.draft.content);
  await save(page, 2);
});

test('review: actual Artifact Host surfaces stale named-view and pending output errors', async ({
  page,
}) => {
  await page.goto('http://127.0.0.1:4177');
  await page.getByRole('button', { name: 'Fiction Mapを開く', exact: true }).click();
  await page.getByLabel('Named document view').fill('Pinned view');
  await details(page);
  await page.getByLabel('New layer name', { exact: true }).fill('External layer');
  await page.getByRole('button', { name: 'Add layer', exact: true }).click();
  await page.getByRole('button', { name: 'Save bounds as named view', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText('stale-revision');
  await page.getByRole('button', { name: 'Cancel view input', exact: true }).click();
  await page.getByRole('button', { name: '保存してアプリに戻る', exact: true }).click();
  await page.getByRole('button', { name: 'Fiction Mapを開く', exact: true }).click();
  await page.getByLabel('Named document view').fill('Pending output input');
  await page.getByRole('button', { name: 'Export map SVG', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText(/named view input/i);
  await page.getByRole('button', { name: 'Cancel view input', exact: true }).click();
  expect((await download(page, 'Export map SVG')).toString()).toContain('<svg');
  const png = await download(page, 'Export map PNG');
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  await page
    .getByRole('region', { name: 'Saved map output' })
    .screenshot({ path: `/tmp/fiction-map-d3/artifact-output-${test.info().project.name}.png` });
  const current = JSON.parse((await download(page, '成果物JSON保存')).toString());
  expect(current.draft.content.namedViews).toEqual([]);
  expect(current.versions).toHaveLength(1);
});

test('review: emptied named-view draft remains cancellable in both real Hosts', async ({
  page,
}) => {
  await page.goto('/');
  const before = await importMap(page);
  const normal = page.getByLabel('Named document view');
  await normal.fill('Temporary view');
  await normal.fill('');
  await expect(
    page.getByRole('button', { name: 'Save bounds as named view', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancel view input', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel view input', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(before.draft.content);
  await save(page, 2);
  await page.goto('http://127.0.0.1:4177');
  await page.getByRole('button', { name: 'Fiction Mapを開く', exact: true }).click();
  await page.getByLabel('Named document view').fill('Temporary view');
  await page.getByLabel('Named document view').fill('');
  await expect(
    page.getByRole('button', { name: 'Save bounds as named view', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancel view input', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel view input', exact: true }).click();
  const current = JSON.parse((await download(page, '成果物JSON保存')).toString());
  expect(current.draft.content.namedViews).toEqual([]);
  await expect(page.getByRole('button', { name: 'Host Undo', exact: true })).toBeDisabled();
});
