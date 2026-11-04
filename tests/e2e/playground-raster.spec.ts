import { createArtifact, commitVersion } from '@editor-platform/artifact-core';
import { createDesign, insertElement, updateElement } from '@editor-platform/design/model';
import { test, expect, nativeArtifact, save } from './fixtures';
import type { Page } from '@playwright/test';

const button = (p: Page, n: string) => p.getByRole('button', { name: n, exact: true });
const read = (p: Page) => p.evaluate(() => window.playgroundInk!.read());
async function selectImage(p: Page) {
  if (!(await p.getByLabel('Search layers').isVisible()))
    await button(p, 'Toggle Design navigator').click();
  await p.getByLabel('Search layers').fill('Character pixels');
  await p
    .locator('[data-layer-id="person"]')
    .getByRole('button', { name: 'Layer Character pixels', exact: true })
    .click();
  await button(p, 'Close Design navigator').click();
  if (!(await p.getByRole('complementary', { name: 'Design inspector', exact: true }).isVisible()))
    await button(p, 'Toggle Design inspector').click();
  await button(p, '画像を直接描き直す').click();
  await expect(p.getByRole('status').filter({ hasText: '画像を読み込み中です。' })).toHaveCount(0);
}
async function png(p: Page, color: string) {
  return p.evaluate((color) => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const x = c.getContext('2d')!;
    x.fillStyle = color;
    x.fillRect(0, 0, 128, 128);
    return c.toDataURL();
  }, color);
}
async function pixel(p: Page, src: string, x: number, y: number) {
  return p.evaluate(
    async ({ src, x, y }) => {
      const i = new Image();
      i.src = src;
      await i.decode();
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(i, 0, 0);
      return [...ctx.getImageData(x, y, 1, 1).data];
    },
    { src, x, y },
  );
}
async function setup(p: Page) {
  await p.goto('/');
  const src = await png(p, '#ffffff'),
    base = insertElement('image', {
      id: 'person',
      src,
      bounds: { x: 0, y: 0, width: 128, height: 128 },
    }).apply(createDesign()),
    content = updateElement('person', { name: 'Character pixels' }).apply(base);
  const artifact = await commitVersion(
    createArtifact('design', 'Raster fixture', content),
    null,
    'baseline',
  );
  await p.getByLabel('Import artifact', { exact: true }).setInputFiles({
    name: 'raster.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(artifact)),
  });
  await expect.poll(() => p.evaluate(() => !!window.playgroundInk)).toBe(true);
  await selectImage(p);
  return artifact;
}
async function stroke(p: Page, a: [number, number], b: [number, number]) {
  const box = (await p
    .getByRole('application', { name: '画像ピクセル編集', exact: true })
    .boundingBox())!;
  await p.mouse.move(box.x + (a[0] * box.width) / 128, box.y + (a[1] * box.height) / 128);
  await p.mouse.down();
  await p.mouse.move(box.x + (b[0] * box.width) / 128, box.y + (b[1] * box.height) / 128, {
    steps: 6,
  });
  await p.mouse.up();
}
test('owned PNG brush and alpha eraser use native Undo, immutable save, reload and direct reedit', async ({
  page,
}, info) => {
  const artifact = await setup(page),
    initial = (await read(page)).content;
  await stroke(page, [25, 35], [90, 35]);
  const painted = (await read(page)).content;
  expect(painted).not.toEqual(initial);
  expect(await pixel(page, painted.elements[0].src!, 50, 35)).toEqual([21, 21, 21, 255]);
  await button(page, '消しゴム').click();
  await stroke(page, [50, 30], [50, 40]);
  const erased = (await read(page)).content;
  expect(await pixel(page, erased.elements[0].src!, 50, 35)).toEqual([0, 0, 0, 0]);
  await button(page, '画像編集を元に戻す').click();
  expect((await read(page)).content).toEqual(painted);
  await button(page, '画像編集をやり直す').click();
  expect((await read(page)).content).toEqual(erased);
  await page.screenshot({ path: info.outputPath('pixel-editor.png') });
  await button(page, '編集を閉じる').click();
  await button(page, 'Close Design inspector').click();
  await save(page, 2);
  const saved = await nativeArtifact(page);
  expect(saved.versions[0].contentHash).toEqual(artifact.versions[0].contentHash);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!window.playgroundInk)).toBe(true);
  expect((await read(page)).content).toEqual(erased);
  await selectImage(page);
  await stroke(page, [20, 80], [90, 80]);
  expect((await read(page)).content).not.toEqual(erased);
});
test('AI rectangle preview preserves outside pixels; pending gestures, cancellation and stale proposals are guarded', async ({
  page,
}) => {
  await setup(page);
  await stroke(page, [20, 85], [90, 85]);
  const human = (await read(page)).content;
  const box = (await page
    .getByRole('application', { name: '画像ピクセル編集', exact: true })
    .boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  const blocked = await page.evaluate(() => {
    try {
      window.playgroundInk!.read();
      return false;
    } catch {
      return true;
    }
  });
  expect(blocked).toBe(true);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect((await read(page)).content).toEqual(human);
  await button(page, '範囲選択').click();
  await stroke(page, [20, 20], [60, 60]);
  await button(page, '選択範囲を使う').click();
  const current = await read(page),
    candidate = await png(page, '#d52b32');
  const selected = current.rasterSelection!.region;
  for (const [actual, expected] of [
    [selected.x, 20],
    [selected.y, 20],
    [selected.width, 40],
    [selected.height, 40],
  ])
    expect(
      Math.abs(actual - expected),
      'the selected source-pixel rectangle must follow the pointer',
    ).toBeLessThanOrEqual(1);
  const proposal = {
    id: 'raster-ai',
    summary: '選んだ範囲だけ描き直す',
    artifactId: current.artifactId,
    baseRevision: current.revision,
    operations: [
      {
        type: 'raster-region',
        id: 'person',
        src: candidate,
        region: current.rasterSelection!.region,
      },
    ],
  };
  await page.evaluate((p) => window.playgroundInk!.proposeRaster(p), proposal);
  expect((await read(page)).content).toEqual(human);
  await button(page, '作画案を採用').click();
  const applied = (await read(page)).content;
  expect(await pixel(page, applied.elements[0].src!, 30, 30)).toEqual([213, 43, 50, 255]);
  expect(await pixel(page, applied.elements[0].src!, 50, 85)).toEqual(
    await pixel(page, human.elements[0].src!, 50, 85),
  );
  const stale = await page.evaluate(async (p) => {
    try {
      await window.playgroundInk!.proposeRaster(p);
      return false;
    } catch {
      return true;
    }
  }, proposal);
  expect(stale).toBe(true);
});

test('AI selection includes the final row and column in either drag direction', async ({
  page,
}) => {
  await setup(page);
  await button(page, '範囲選択').click();
  const canvas = page.getByRole('application', { name: '画像ピクセル編集', exact: true });
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 0.01, box.y + 0.01);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 4, box.y + box.height + 4, { steps: 8 });
  await page.mouse.up();
  await button(page, '選択範囲を使う').click();
  let current = await read(page);
  expect(current.rasterSelection!.region).toEqual({ x: 0, y: 0, width: 128, height: 128 });
  const request = {
    id: 'whole-image-edge',
    summary: '端まで描き直す',
    artifactId: current.artifactId,
    baseRevision: current.revision,
    operations: [
      {
        type: 'raster-region',
        id: 'person',
        region: current.rasterSelection!.region,
        src: await png(page, '#d52b32'),
      },
    ],
  };
  await page.evaluate((p) => window.playgroundInk!.proposeRaster(p), request);
  await button(page, '作画案を採用').click();
  expect(await pixel(page, (await read(page)).content.elements[0].src!, 127, 127)).toEqual([
    213, 43, 50, 255,
  ]);
  await button(page, 'Close Design inspector').click();
  await selectImage(page);
  await button(page, '範囲選択').click();
  const reverse = (await canvas.boundingBox())!;
  await page.mouse.move(reverse.x + reverse.width - 0.01, reverse.y + reverse.height - 0.01);
  await page.mouse.down();
  await page.mouse.move(reverse.x - 4, reverse.y - 4, { steps: 8 });
  await page.mouse.up();
  await button(page, '選択範囲を使う').click();
  current = await read(page);
  expect(current.rasterSelection!.region).toEqual({ x: 0, y: 0, width: 128, height: 128 });
});
