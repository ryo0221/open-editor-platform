import { createArtifact, commitVersion } from '@editor-platform/artifact-core';
import { createDesign, insertElement, updateElement } from '@editor-platform/design/model';
import { designDivisionCommand } from '@editor-platform/design/division';
import { insertDesignPage, captureDesignPages } from '@editor-platform/design/pagination';
import { test, expect, editorToolbarAction } from './fixtures';

test('inside panel stroke remains visible above opaque artwork in canvas, prototype and captured SVG pixels', async ({
  page,
  baseURL,
}, info) => {
  let d = insertDesignPage({ x: 0, y: 0, width: 100, height: 100 }, 'page').apply(createDesign());
  d = designDivisionCommand({
    type: 'startDivision',
    pageId: 'page',
    region: { x: 10, y: 10, width: 80, height: 80 },
    root: { panelId: 'panel' },
  }).apply(d);
  d = updateElement('panel', { stroke: '#111111', strokeWidth: 4 }).apply(d);
  d = insertElement('rectangle', {
    id: 'paint',
    parentId: 'panel',
    bounds: { x: 10, y: 10, width: 80, height: 80 },
  }).apply(d);
  d = updateElement('paint', { fill: '#ff0000', strokeWidth: 0 }).apply(d);
  d = insertElement('rectangle', {
    id: 'outside',
    parentId: 'panel',
    bounds: { x: 120, y: 120, width: 10, height: 10 },
  }).apply(d);
  const independent = /:4177$/.test(baseURL ?? '');
  const initial = { ...createArtifact('design', 'Opaque panel artwork', d), annotations: [] };
  const saved = await commitVersion(
    { ...initial, id: independent ? 'comic' : initial.id },
    null,
    'fixture',
  );
  const capture = await captureDesignPages(saved, saved.versions[0].versionId, { mode: 'vector' });
  expect(capture.ok).toBe(true);
  await page.goto(independent ? '/authoring.html' : '/');
  if (independent) {
    await page.evaluate(
      (json) => localStorage.setItem('authoring:comic', json),
      JSON.stringify(saved),
    );
    await page.reload();
    await page.getByRole('button', { name: 'Comic pages', exact: true }).click();
  } else
    await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
      name: 'panel.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(saved)),
    });
  await editorToolbarAction(page, '漫画ワークスペース');
  await expect(page.locator('[data-workspace]')).toHaveAttribute('data-workspace', 'manga');
  const panel = page.getByRole('region', { name: 'Manga pages and panels' });
  const toggle = page.getByRole('button', { name: 'Toggle 漫画のページ・コマ', exact: true });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: '単ページ', exact: true }).click();
  const close = page.getByRole('button', { name: 'Close 漫画のページ・コマ', exact: true });
  if (await close.isVisible()) await close.click();
  const art = page.locator('[data-canvas-target="paint"]');
  await art.scrollIntoViewIfNeeded();
  const points = await art.evaluate(async (node) => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const matrix = (node as SVGGraphicsElement).getScreenCTM()!;
    return [
      [12, 50],
      [50, 50],
    ].map(([x, y]) => {
      const p = new DOMPoint(x, y).matrixTransform(matrix);
      return [p.x, p.y];
    });
  });
  const pixels = async (src: string, points: number[][]) =>
    page.evaluate(
      async ({ src, points }) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        return points.map(([x, y]) => [
          ...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data,
        ]);
      },
      { src, points },
    );
  const screenshot = await page.screenshot({
    path: info.outputPath('opaque-panel-border.png'),
    scale: 'css',
  });
  const visible = await pixels('data:image/png;base64,' + screenshot.toString('base64'), points);
  expect(visible[0].slice(0, 3)).toEqual([17, 17, 17]);
  expect(visible[1].slice(0, 3)).toEqual([255, 0, 0]);
  const exported = await pixels(
    'data:image/svg+xml;base64,' + Buffer.from(capture.pages[0].svg).toString('base64'),
    [
      [12, 50],
      [16, 50],
      [9, 50],
    ],
  );
  expect(exported.map((p) => p.slice(0, 3))).toEqual([
    [17, 17, 17],
    [255, 0, 0],
    [255, 255, 255],
  ]);
  await editorToolbarAction(page, 'Designで詳細編集');
  await expect(page.locator('[data-workspace]')).toHaveAttribute('data-workspace', 'design');
  const openPrototype = page.getByRole('button', { name: 'Open prototype', exact: true });
  if (!(await openPrototype.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await openPrototype.click();
  const prototype = page.getByRole('dialog', { name: 'Design prototype', exact: true });
  const frame = prototype.locator('svg[data-prototype-active="true"]');
  await expect(frame).toBeVisible();
  const prototypePoints = await frame.evaluate((node) => {
    const matrix = (node as SVGSVGElement).getScreenCTM()!;
    return [
      [12, 50],
      [50, 50],
    ].map(([x, y]) => {
      const p = new DOMPoint(x, y).matrixTransform(matrix);
      return [p.x, p.y];
    });
  });
  const prototypeShot = await page.screenshot({
    path: info.outputPath('prototype-panel-border.png'),
    scale: 'css',
  });
  const prototypePixels = await pixels(
    'data:image/png;base64,' + prototypeShot.toString('base64'),
    prototypePoints,
  );
  expect(prototypePixels.map((p) => p.slice(0, 3))).toEqual([
    [17, 17, 17],
    [255, 0, 0],
  ]);
  await prototype.getByRole('button', { name: 'Exit prototype', exact: true }).click();
});
