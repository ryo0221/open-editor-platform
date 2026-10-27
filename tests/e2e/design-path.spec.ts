import { createArtifact, commitVersion, contentHash } from '@editor-platform/artifact-core';
import {
  createDesign,
  insertDesignPath,
  presetDesignPath,
  insertElement,
  patchDesign,
} from '@editor-platform/design/model';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { test, expect, create, nativeArtifact, save } from './fixtures';
import type { Page } from '@playwright/test';
import type { DesignContent } from '@editor-platform/design/model';
const bundles = new Map<string, Promise<{ js: string; css: string }>>();
async function independent(page: Page, entry = 'host') {
  if (!bundles.has(entry))
    bundles.set(
      entry,
      build({
        entryPoints: [`tests/fixtures/design-path/${entry}.tsx`],
        bundle: true,
        write: false,
        outdir: '/tmp/design-path-host',
        format: 'iife',
        define: { 'process.env.NODE_ENV': '"production"' },
      }).then((r) => ({
        js: r.outputFiles!.find((f) => f.path.endsWith('.js'))!.text,
        css: r.outputFiles!.find((f) => f.path.endsWith('.css'))?.text ?? '',
      })),
    );
  const b = await bundles.get(entry)!;
  await page.route('**/path-host.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: b.js }),
  );
  await page.route('**/path-host.css', (r) => r.fulfill({ contentType: 'text/css', body: b.css }));
  await page.route('**/path-host', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/path-host.css"></head><body style="margin:0"><div id="root"></div><script src="/path-host.js"></script></body></html>',
    }),
  );
  await page.goto('/path-host');
}
const content = async (page: Page): Promise<DesignContent> =>
  JSON.parse((await page.getByTestId('native').textContent())!);
async function drag(page: Page, label: string, dx: number, dy: number) {
  const p = page.getByRole('button', { name: label, exact: true }),
    b = (await p.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 5 });
  await page.mouse.up();
}
async function anchorMatchesDrawing(page: Page) {
  const start = await page
    .getByRole('application', { name: 'Design canvas', exact: true })
    .locator('path[fill-rule]')
    .first()
    .evaluate((node) => {
      const path = node as SVGPathElement;
      const p = path.getPointAtLength(0).matrixTransform(path.getScreenCTM()!);
      return { x: p.x, y: p.y };
    });
  const anchor = (await page
    .getByRole('button', { name: 'Anchor 1.1', exact: true })
    .boundingBox())!;
  expect(start.x).toBeCloseTo(anchor.x + anchor.width / 2, 2);
  expect(start.y).toBeCloseTo(anchor.y + anchor.height / 2, 2);
}

test('independent: add/edit/gesture/Undo/native/save failure/retry/exports', async ({
  page,
}, info) => {
  await independent(page);
  await page.getByRole('button', { name: 'Add cubic path', exact: true }).click();
  const initial = await content(page);
  expect(initial.schemaVersion).toBe(3);
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect((await content(page)).schemaVersion).toBe(2);
  await page.getByRole('button', { name: 'Host Redo', exact: true }).click();
  await page.getByRole('button', { name: 'Edit path points', exact: true }).click();
  await anchorMatchesDrawing(page);
  const revision = Number(await page.getByTestId('revision').textContent());
  await drag(page, 'Anchor 1.1', -100, 50);
  const moved = await content(page);
  expect(moved.elements[0].path!.subpaths[0].anchors[0].x).toBeLessThan(0);
  expect(Number(await page.getByTestId('revision').textContent())).toBe(revision + 1);
  await page.getByRole('button', { name: 'Fit path points', exact: true }).click();
  expect(await content(page)).toEqual(moved);
  expect(Number(await page.getByTestId('revision').textContent())).toBe(revision + 1);
  const canvasBox = (await page
    .getByRole('application', { name: 'Design canvas', exact: true })
    .boundingBox())!;
  for (const point of await page.locator('[data-path-point]').all()) {
    const box = (await point.boundingBox())!;
    expect(box.x).toBeGreaterThan(canvasBox.x);
    expect(box.y).toBeGreaterThan(canvasBox.y);
    expect(box.x + box.width).toBeLessThan(canvasBox.x + canvasBox.width);
    expect(box.y + box.height).toBeLessThan(canvasBox.y + canvasBox.height);
  }
  await anchorMatchesDrawing(page);
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect(await content(page)).toEqual(initial);
  await page.getByRole('button', { name: 'Host Redo', exact: true }).click();
  const before = await content(page);
  await drag(page, 'Handle 1.1.c1', 30, -20);
  await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
  expect(await content(page)).toEqual(before);
  await page.getByLabel('Path point', { exact: true }).selectOption({ label: 'Anchor 1.1' });
  const coordinateBase = await content(page);
  await page.getByLabel('Path point X', { exact: true }).fill('1000001');
  await page.getByLabel('Path point X', { exact: true }).press('Enter');
  expect(await content(page)).toEqual(coordinateBase);
  await expect(page.getByLabel('Path point X', { exact: true })).toHaveValue('1000001');
  await page.getByRole('button', { name: 'Finish point editing', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Finish point editing', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Path point X', { exact: true })).toHaveValue('1000001');
  await page.getByRole('button', { name: 'Host Save', exact: true }).click();
  await expect(page.getByTestId('host-status')).toHaveText('Not saved');
  expect(await content(page)).toEqual(coordinateBase);
  await page.getByLabel('Path point X', { exact: true }).fill('-140');
  await page.getByLabel('Path point X', { exact: true }).press('Enter');
  expect((await content(page)).elements[0].path!.subpaths[0].anchors[0].x).toBe(-140);
  await page.getByLabel('Anchor mode', { exact: true }).selectOption('symmetric');
  const committed = await content(page),
    rev = await page.getByTestId('revision').textContent();
  await drag(page, 'Anchor 1.1', 0, 0);
  expect(await page.getByTestId('revision').textContent()).toBe(rev);
  const p = page.getByRole('button', { name: 'Anchor 1.1', exact: true }),
    b = (await p.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 40, b.y + 40);
  await p.dispatchEvent('pointercancel', { pointerId: 1 });
  await page.mouse.up();
  expect(await content(page)).toEqual(committed);
  await p.focus();
  await page.keyboard.press('Delete');
  expect(await content(page)).toEqual(committed);
  await expect(page.getByRole('alert')).toContainText('Point deletion');
  await page.keyboard.press('Escape');
  await page.getByLabel('Host Fail saves', { exact: true }).check();
  await page.getByRole('button', { name: 'Host Save', exact: true }).click();
  await expect(page.getByTestId('host-status')).toHaveText('Not saved');
  expect(await content(page)).toEqual(committed);
  await page.getByLabel('Host Fail saves', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Host Save', exact: true }).click();
  await expect(page.getByTestId('host-status')).toHaveText('Saved');
  await page.getByRole('button', { name: 'Host Reload', exact: true }).click();
  expect(await content(page)).toEqual(committed);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Host Native JSON', exact: true }).click();
  const file = (await (await download).path())!;
  await page.getByLabel('Host Import', { exact: true }).setInputFiles(file);
  expect(await content(page)).toEqual(committed);
  await page.getByRole('button', { name: 'Export design', exact: true }).click();
  const svgDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export all SVG', exact: true }).click();
  const svg = await readFile((await (await svgDownload).path())!, 'utf8');
  expect(svg).toContain('C');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Export design', exact: true }).click();
  const pngDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export all PNG', exact: true }).click();
  const png = await readFile((await (await pngDownload).path())!);
  expect(png.readUInt32BE(16)).toBeGreaterThan(220);
  expect(png.readUInt32BE(16)).toBe(Math.ceil(Number(svg.match(/width="([^"]+)"/)![1])));
  expect(png.readUInt32BE(20)).toBe(Math.ceil(Number(svg.match(/height="([^"]+)"/)![1])));
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Fit design', exact: true }).click();
  await page.screenshot({ path: info.outputPath('independent-path.png') });
});

test('independent: accepted extreme coordinates fit with CSS-sized points and consistent wheel/toolbar zoom', async ({
  page,
}, info) => {
  for (const [kind, width] of [
    ['line', 220],
    ['line', 100_000_000],
    ['cubic', 100_000_000],
  ] as const) {
    await independent(page);
    await page.getByRole('button', { name: `Add ${kind} path`, exact: true }).click();
    if (width !== 220) {
      await page.getByLabel('Element width', { exact: true }).fill(String(width));
      await page.getByLabel('Element width', { exact: true }).press('Enter');
    }
    await page.getByRole('button', { name: 'Edit path points', exact: true }).click();
    await page.getByLabel('Path point X', { exact: true }).fill('-1000000');
    await page.getByLabel('Path point X', { exact: true }).press('Enter');
    const edited = await content(page);
    const revision = await page.getByTestId('revision').textContent();
    await page.getByRole('button', { name: 'Fit path points', exact: true }).click();
    await anchorMatchesDrawing(page);
    const stage = page.getByRole('application', { name: 'Design canvas', exact: true });
    const canvas = (await stage.boundingBox())!;
    for (const point of await page.locator('[data-path-point]').all()) {
      const box = (await point.boundingBox())!;
      // Chromium includes stroke in the box: 2 * radius + the 1.5px stroke.
      const diameter = (await point.getAttribute('aria-label'))!.startsWith('Handle') ? 9.5 : 11.5;
      expect(box.width).toBeCloseTo(diameter, 1);
      expect(box.height).toBeCloseTo(diameter, 1);
      expect(box.x).toBeGreaterThan(canvas.x);
      expect(box.y).toBeGreaterThan(canvas.y);
      expect(box.x + box.width).toBeLessThan(canvas.x + canvas.width);
      expect(box.y + box.height).toBeLessThan(canvas.y + canvas.height);
    }
    const zoom = page.getByLabel('Canvas zoom', { exact: true });
    const fitted = Number(await zoom.inputValue());
    expect(fitted).toBeLessThan(0.001);
    await expect(zoom.locator('option:checked')).not.toHaveText('0%');
    await stage.dispatchEvent('wheel', {
      ctrlKey: true,
      deltaX: 0,
      deltaY: 20,
      clientX: canvas.x + canvas.width / 2,
      clientY: canvas.y + canvas.height / 2,
    });
    await expect.poll(async () => Number(await zoom.inputValue())).toBeLessThan(fitted);
    const wheel = Number(await zoom.inputValue());
    await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
    expect(Number(await zoom.inputValue())).toBeLessThan(wheel);
    expect(await content(page)).toEqual(edited);
    expect(await page.getByTestId('revision').textContent()).toBe(revision);
    if (kind === 'line') await drag(page, 'Anchor 1.1', 12, 0);
    else {
      // At this scale adjacent points overlap; keyboard selection owns the anchor.
      await page.getByRole('button', { name: 'Anchor 1.1', exact: true }).focus();
      await page.keyboard.press('ArrowRight');
    }
    expect((await content(page)).elements[0].path!.subpaths[0].anchors[0].x).toBeGreaterThan(
      -1000000,
    );
    await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
    expect(await content(page)).toEqual(edited);
    if (kind === 'cubic') {
      await drag(page, 'Handle 1.1.c1', 8, 0);
      const segment = (await content(page)).elements[0].path!.subpaths[0].segments[0];
      expect(segment.type).toBe('cubic');
      if (segment.type === 'cubic') expect(segment.c1.x).toBeGreaterThan(-999960);
      await page.getByRole('button', { name: 'Host Undo', exact: true }).click();
      expect(await content(page)).toEqual(edited);
    }
    await page.getByRole('button', { name: 'Fit design', exact: true }).click();
    await expect.poll(async () => Number(await zoom.inputValue())).toBeLessThan(0.001);
    await page.screenshot({ path: info.outputPath(`extreme-path-${kind}-${width}.png`) });
  }
});

test('ordinary Playground: schema3 keeps the external React graphic-export guard without blocking native path selection', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'design');
  await page.getByRole('button', { name: 'Enable React Web', exact: true }).click();
  await page.getByRole('button', { name: 'Insert React Button', exact: true }).click();
  const original = (await nativeArtifact(page)).draft.content as DesignContent;
  expect(original.elements.some((e) => e.type === 'react')).toBe(true);
  await page.getByRole('button', { name: 'Add line path', exact: true }).click();
  const mixed = (await nativeArtifact(page)).draft.content as DesignContent;
  expect(mixed.schemaVersion).toBe(3);
  expect(mixed.elements.filter((e) => e.react)).toEqual(original.elements.filter((e) => e.react));
  const downloads: string[] = [];
  page.on('download', (file) => downloads.push(file.suggestedFilename()));
  for (const format of ['SVG', 'PNG']) {
    await page.getByRole('button', { name: 'Export design', exact: true }).click();
    await page.getByRole('button', { name: `Export all ${format}`, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(
      'SVG/PNG cannot preserve external React content',
    );
    await page.keyboard.press('Escape');
  }
  expect(downloads).toEqual([]);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export design', exact: true }).click();
  await page.getByRole('button', { name: 'Export selection SVG', exact: true }).click();
  expect(await readFile((await (await pending).path())!, 'utf8')).toContain('<path');
  await page.keyboard.press('Escape');
  expect((await nativeArtifact(page)).draft.content).toEqual(mixed);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await nativeArtifact(page)).draft.content).toEqual(original);
});

test('ordinary Playground: dashed/dotted paths render on canvas and in SVG/PNG and survive reload', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'design');
  await page.getByRole('button', { name: 'Add line path', exact: true }).click();
  await page.getByLabel('Stroke width (px)', { exact: true }).fill('1');
  await page.getByLabel('Stroke width (px)', { exact: true }).press('Enter');
  const curve = page
    .getByRole('application', { name: 'Design canvas', exact: true })
    .locator('path[fill-rule]');
  for (const dash of ['8 4', '2 3']) {
    await page.getByLabel('Stroke dash', { exact: true }).selectOption(dash);
    await expect(curve).toHaveAttribute('stroke-dasharray', dash);
    for (const format of ['SVG', 'PNG']) {
      await page.getByRole('button', { name: 'Export design', exact: true }).click();
      const pending = page.waitForEvent('download');
      await page.getByRole('button', { name: `Export all ${format}`, exact: true }).click();
      const file = await pending;
      await file.saveAs(info.outputPath(`path-${dash.replace(' ', '-')}.${format.toLowerCase()}`));
      const bytes = await readFile((await file.path())!);
      if (format === 'SVG') expect(bytes.toString('utf8')).toContain(`stroke-dasharray="${dash}"`);
      else {
        const row = await page.evaluate(async (base64) => {
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d')!;
          context.drawImage(image, 0, 0);
          // Find the painted line rather than assuming that its local frame
          // or export padding places it at the image's vertical midpoint.
          const width = image.width - 50;
          const pixels = context.getImageData(25, 0, width, image.height).data;
          let best = { ink: 0, gaps: 0 };
          for (let y = 0; y < image.height; y++) {
            let ink = 0,
              gaps = 0;
            for (let x = 0; x < width; x++) {
              const alpha = pixels[(y * width + x) * 4 + 3];
              if (alpha > 100) ink++;
              if (alpha === 0) gaps++;
            }
            if (ink > best.ink) best = { ink, gaps };
          }
          image.close();
          return best;
        }, bytes.toString('base64'));
        expect(row.ink).toBeGreaterThan(20);
        expect(row.gaps).toBeGreaterThan(20);
      }
      await page.keyboard.press('Escape');
    }
  }
  await save(page, 1);
  const saved = (await nativeArtifact(page)).draft.content;
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(saved);
  await expect(curve).toHaveAttribute('stroke-dasharray', '2 3');
});

test('ordinary Playground: paths survive clipboard, save, reload and native export', async ({
  page,
}, info) => {
  await page.goto('/');
  await create(page, 'design');
  await page.getByRole('button', { name: 'Add line path', exact: true }).click();
  await page.getByRole('button', { name: 'Add cubic path', exact: true }).click();
  let record = await nativeArtifact(page);
  expect((record.draft.content as DesignContent).elements.filter((e) => e.path)).toHaveLength(2);
  const stage = page.getByRole('application', { name: 'Design canvas', exact: true });
  await stage.focus();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  record = await nativeArtifact(page);
  expect((record.draft.content as DesignContent).elements.filter((e) => e.path)).toHaveLength(3);
  await save(page, 1);
  const saved = (await nativeArtifact(page)).draft.content;
  await page.reload();
  expect((await nativeArtifact(page)).draft.content).toEqual(saved);
  await page.getByRole('button', { name: 'Fit design', exact: true }).click();
  await page.screenshot({ path: info.outputPath('playground-path.png') });
});

test('ordinary Playground: hidden paths and hidden parents reject point fitting without exceptions or history', async ({
  page,
}) => {
  for (const parent of [false, true]) {
    await page.goto('/');
    await create(page, 'design');
    if (parent) {
      await page.getByRole('button', { name: 'Add frame', exact: true }).click();
      await page.getByLabel('Layer name', { exact: true }).fill('Parent frame');
      await page.getByLabel('Layer name', { exact: true }).press('Enter');
    }
    await page.getByRole('button', { name: 'Add cubic path', exact: true }).click();
    const target = parent ? 'Parent frame' : 'Editable path';
    await page.getByRole('button', { name: `Hide ${target}`, exact: true }).click();
    const hidden = (await nativeArtifact(page)).draft.content;
    await page.getByRole('button', { name: 'Edit path points', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Show the path and its parent frames');
    await expect(
      page.getByRole('button', { name: 'Finish point editing', exact: true }),
    ).toHaveCount(0);
    expect((await nativeArtifact(page)).draft.content).toEqual(hidden);
    await page.getByRole('button', { name: `Show ${target}`, exact: true }).click();
    const visible = (await nativeArtifact(page)).draft.content;
    await page.getByRole('button', { name: 'Edit path points', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Anchor 1.1', exact: true })).toBeVisible();
    await page.getByRole('button', { name: `Hide ${target}`, exact: true }).click();
    await expect(page.locator('[data-path-point]')).toHaveCount(0);
    const activeHidden = (await nativeArtifact(page)).draft.content;
    await page.getByRole('button', { name: 'Fit path points', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Show the path and its parent frames');
    expect((await nativeArtifact(page)).draft.content).toEqual(activeHidden);
    await page.getByRole('button', { name: 'Finish point editing', exact: true }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect((await nativeArtifact(page)).draft.content).toEqual(visible);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    expect((await nativeArtifact(page)).draft.content).toEqual(activeHidden);
  }
});

test('ordinary Playground: add paths inside selected clipping frames away from the viewport centre', async ({
  page,
}, info) => {
  for (const [width, height] of [
    [400, 300],
    [120, 80],
  ]) {
    const bounds = { x: 100, y: 100, width, height };
    let initial = insertElement('frame', {
      id: 'target',
      bounds,
    }).apply(createDesign());
    initial = patchDesign(['target'], { name: 'Target frame', clipContent: true }).apply(initial);
    initial = insertElement('frame', {
      id: 'far',
      bounds: { x: 1600, y: 100, width: 400, height: 300 },
    }).apply(initial);
    const record = createArtifact('design', `Frame placement ${width}`, initial);
    await page.goto('/');
    await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
      name: 'frame-placement.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(record)),
    });
    await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(record.name);
    await page.getByRole('button', { name: 'Fit design', exact: true }).click();
    const stage = page.getByRole('application', { name: 'Design canvas', exact: true });
    const centre = await stage
      .locator(':scope > g')
      .first()
      .evaluate((g) => {
        const svg = (g as SVGGraphicsElement).ownerSVGElement!;
        const rect = svg.getBoundingClientRect();
        const point = new DOMPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        ).matrixTransform((g as SVGGraphicsElement).getScreenCTM()!.inverse());
        return { x: point.x, y: point.y };
      });
    expect(centre.x).toBeGreaterThan(bounds.x + bounds.width);
    for (const kind of ['line', 'cubic']) {
      await page.getByRole('button', { name: 'Layer Target frame', exact: true }).click();
      const before = (await nativeArtifact(page)).draft.content as DesignContent;
      await page.getByRole('button', { name: `Add ${kind} path`, exact: true }).click();
      const inserted = (await nativeArtifact(page)).draft.content as DesignContent;
      const path = inserted.elements.find(
        (e) => e.path && !before.elements.some((p) => p.id === e.id),
      )!;
      expect(path.parentId).toBe('target');
      expect(path.bounds.x).toBeGreaterThan(bounds.x);
      expect(path.bounds.y).toBeGreaterThan(bounds.y);
      expect(path.bounds.x + path.bounds.width).toBeLessThan(bounds.x + width);
      expect(path.bounds.y + path.bounds.height).toBeLessThan(bounds.y + height);
      expect(path.path!.frame).toEqual({ x: 0, y: 0, width: 220, height: 160 });
      for (const format of ['SVG', 'PNG']) {
        await page.getByRole('button', { name: 'Export design', exact: true }).click();
        const pending = page.waitForEvent('download');
        await page.getByRole('button', { name: `Export selection ${format}`, exact: true }).click();
        const file = await pending;
        await file.saveAs(
          info.outputPath(`parent-${width}-${kind}-export.${format.toLowerCase()}`),
        );
        const bytes = await readFile((await file.path())!);
        if (format === 'SVG') expect(bytes.toString('utf8')).toContain('<clipPath');
        else {
          const ink = await page.evaluate(async (base64) => {
            const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
            const image = await createImageBitmap(new Blob([data], { type: 'image/png' }));
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext('2d')!;
            context.drawImage(image, 0, 0);
            const pixels = context.getImageData(0, 0, image.width, image.height).data;
            const count = Array.from(pixels).filter(
              (alpha, i) => i % 4 === 3 && alpha > 100,
            ).length;
            image.close();
            return count;
          }, bytes.toString('base64'));
          expect(ink).toBeGreaterThan(20);
        }
        await page.keyboard.press('Escape');
      }
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      expect((await nativeArtifact(page)).draft.content).toEqual(before);
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      expect((await nativeArtifact(page)).draft.content).toEqual(inserted);
      await page.screenshot({ path: info.outputPath(`parent-${width}-${kind}.png`) });
    }
  }
});

test('independent: rotation/flip/parent, keyboard/IME, revocation and narrow container', async ({
  page,
}, info) => {
  await independent(page);
  await page.getByRole('button', { name: 'Add cubic path', exact: true }).click();
  await page.getByRole('button', { name: 'Host parent frame', exact: true }).click();
  await page.getByRole('button', { name: 'Host rotate flip', exact: true }).click();
  await page.getByRole('button', { name: 'Edit path points', exact: true }).click();
  const panBase = await content(page);
  await page.getByRole('button', { name: 'Pan canvas', exact: true }).click();
  await drag(page, 'Anchor 1.1', 20, 15);
  expect(await content(page)).toEqual(panBase);
  const camera = page
    .getByRole('application', { name: 'Design canvas', exact: true })
    .locator(':scope > g')
    .first();
  const originalCamera = await camera.getAttribute('transform');
  const panPoint = (await page
    .getByRole('button', { name: 'Anchor 1.1', exact: true })
    .boundingBox())!;
  await page.mouse.move(panPoint.x + panPoint.width / 2, panPoint.y + panPoint.height / 2);
  await page.mouse.down();
  await page.mouse.move(panPoint.x + 30, panPoint.y + 20);
  await page.keyboard.press('Escape');
  await page.mouse.move(panPoint.x + 60, panPoint.y + 40);
  await page.mouse.up();
  expect(await camera.getAttribute('transform')).toBe(originalCamera);
  expect(await content(page)).toEqual(panBase);
  await page.getByRole('button', { name: 'Pan canvas', exact: true }).click();
  await page.getByRole('button', { name: 'Anchor 1.1', exact: true }).focus();
  await page.keyboard.down('Space');
  const spaceBase = await content(page);
  await drag(page, 'Anchor 1.1', 15, 10);
  await drag(page, 'Anchor 1.1', 15, 10);
  await page.keyboard.up('Space');
  expect(await content(page)).toEqual(spaceBase);
  const before = await content(page),
    path = before.elements.find((e) => e.path)!,
    untouched = path.path!.subpaths[0].anchors[1];
  await drag(page, 'Anchor 1.1', 35, -20);
  const after = await content(page);
  await anchorMatchesDrawing(page);
  expect(after.elements.find((e) => e.path)!.path!.subpaths[0].anchors[1]).toEqual(untouched);
  expect(after.elements.find((e) => e.path)!.bounds).toEqual(path.bounds);
  const point = page.getByRole('button', { name: 'Anchor 1.1', exact: true });
  await point.focus();
  const base = await content(page);
  await point.dispatchEvent('keydown', { key: 'ArrowRight', isComposing: true });
  expect(await content(page)).toEqual(base);
  await point.press('Control+ArrowRight');
  await point.press('Control+Backspace');
  await point.press('Meta+ArrowLeft');
  expect(await content(page)).toEqual(base);
  await page.keyboard.press('ArrowRight');
  expect(
    (await content(page)).elements.find((e) => e.path)!.path!.subpaths[0].anchors[0].x,
  ).toBeCloseTo(base.elements.find((e) => e.path)!.path!.subpaths[0].anchors[0].x + 1);
  const committed = await content(page),
    rev = await page.getByTestId('revision').textContent(),
    box = (await point.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + 10);
  await page
    .getByLabel('Host Read only', { exact: true })
    .evaluate((e) => (e as HTMLInputElement).click());
  await page.mouse.up();
  expect(await content(page)).toEqual(committed);
  expect(await page.getByTestId('revision').textContent()).toBe(rev);
  await expect(page.getByLabel('Path point X', { exact: true })).toBeDisabled();
  await page.getByLabel('Host Read only', { exact: true }).uncheck();
  await page.getByRole('application', { name: 'Design canvas', exact: true }).focus();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Close Design inspector', exact: true }).click();
  await page.getByRole('button', { name: 'Close Design navigator', exact: true }).click();
  await expect(page.getByRole('application', { name: 'Design canvas', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Fit design', exact: true }).click();
  await page.screenshot({ path: info.outputPath('narrow-path.png') });
});

test('Artifact Host: ordinary Design path edits/save/native/reload without React conversion', async ({
  page,
}, info) => {
  await page.goto('http://127.0.0.1:4177');
  await page.getByRole('button', { name: 'Product pageを開く', exact: true }).click();
  const add = page.getByRole('button', { name: 'Add cubic path', exact: true });
  if (!(await add.isVisible()))
    await page.getByRole('button', { name: 'More editor tools', exact: true }).click();
  await add.click();
  await page.keyboard.press('Escape');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '成果物JSON保存', exact: true }).click();
  const record = JSON.parse(await readFile((await (await download).path())!, 'utf8'));
  expect(record.draft.content.schemaVersion).toBe(3);
  expect(record.draft.content.elements.some((e: { path?: unknown }) => e.path)).toBe(true);
  await page.getByRole('button', { name: '保存してアプリに戻る', exact: true }).click();
  await expect(page.getByLabel('成果物一覧', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Product pageを開く', exact: true }).click();
  const next = page.waitForEvent('download');
  await page.getByRole('button', { name: '成果物JSON保存', exact: true }).click();
  const reloaded = JSON.parse(await readFile((await (await next).path())!, 'utf8'));
  expect(reloaded.draft.content).toEqual(record.draft.content);
  await page.getByRole('button', { name: 'Fit design', exact: true }).click();
  await page.screenshot({ path: info.outputPath('artifact-host-path.png') });
});

test('ordinary Playground: paste into schema2 and Cut/Paste keep native path identity remapping atomic', async ({
  page,
}) => {
  await page.goto('/');
  await create(page, 'design');
  await page.getByRole('button', { name: 'Add cubic path', exact: true }).click();
  const stage = page.getByRole('application', { name: 'Design canvas', exact: true });
  await stage.focus();
  await page.keyboard.press('Control+c');
  const original = (await nativeArtifact(page)).draft.content as DesignContent;
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(((await nativeArtifact(page)).draft.content as DesignContent).schemaVersion).toBe(2);
  await stage.focus();
  await page.keyboard.press('Control+v');
  const pasted = (await nativeArtifact(page)).draft.content as DesignContent;
  expect(pasted.schemaVersion).toBe(3);
  expect(pasted.elements).toHaveLength(1);
  expect(pasted.elements[0].path!.subpaths[0].anchors[0].id).not.toBe(
    original.elements[0].path!.subpaths[0].anchors[0].id,
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(((await nativeArtifact(page)).draft.content as DesignContent).schemaVersion).toBe(2);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await stage.focus();
  await page.keyboard.press('Control+x');
  expect(((await nativeArtifact(page)).draft.content as DesignContent).elements).toHaveLength(0);
  await stage.focus();
  await page.keyboard.press('Control+v');
  expect(((await nativeArtifact(page)).draft.content as DesignContent).elements).toHaveLength(1);
});

test('Playground capacity failure retains draft/Undo without growing immutable history and retries after correction', async ({
  page,
}) => {
  test.setTimeout(120000);
  const path = presetDesignPath('line'),
    sub = path.subpaths[0];
  sub.anchors = Array.from({ length: 1536 }, (_, i) => ({
    id: `a${i}${'x'.repeat(700)}`,
    x: i,
    y: 0,
    mode: 'corner',
  }));
  sub.segments = sub.anchors.slice(1).map((a, i) => ({
    id: `s${i}${'s'.repeat(700)}`,
    type: 'line',
    from: sub.anchors[i].id,
    to: a.id,
  }));
  const content = insertDesignPath(path).apply(createDesign());
  let record = createArtifact('design', 'Capacity path', content);
  record = await commitVersion(record, null, 'first');
  record = await commitVersion(record, null, 'second');
  const bytes = Buffer.from(JSON.stringify(record));
  expect(bytes.length).toBeLessThan(16 * 1024 * 1024);
  await page.goto('/');
  await page
    .getByLabel('Import artifact', { exact: true })
    .setInputFiles({ name: 'capacity.json', mimeType: 'application/json', buffer: bytes });
  await expect(page.getByLabel('Artifact name')).toHaveValue(/capacity/i);
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Save version', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Save immutable version', exact: true })
      .getByRole('button', { name: 'この版を保存', exact: true })
      .click();
    await expect(page.locator('.save-status')).toContainText('Not saved');
    const failed = await nativeArtifact(page);
    expect(failed.versions.map((v) => v.versionId)).toEqual(
      record.versions.map((v) => v.versionId),
    );
    expect(failed.draft.baseVersionId).toBe(record.draft.baseVersionId);
    expect(await contentHash(failed.draft.content)).toBe(record.versions[1].contentHash);
  }
  await page.getByRole('button', { name: 'Design object Editable path', exact: true }).click();
  const stage = page.getByRole('application', { name: 'Design canvas', exact: true });
  await stage.focus();
  await page.keyboard.press('Delete');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await contentHash((await nativeArtifact(page)).draft.content)).toBe(
    record.versions[1].contentHash,
  );
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await save(page, 3);
  expect((await nativeArtifact(page)).versions).toHaveLength(3);
});

test('plain EditorSession: a paste exceeding the aggregate anchor limit preserves content and Undo', async ({
  page,
}) => {
  let initial = createDesign();
  for (let n = 0; n < 4; n++) {
    const path = presetDesignPath('line'),
      sub = path.subpaths[0];
    sub.anchors = Array.from({ length: 4096 }, (_, i) => ({
      id: `a${n}-${i}`,
      x: i / 40,
      y: n * 50,
      mode: 'corner',
    }));
    sub.segments = sub.anchors.slice(1).map((a, i) => ({
      id: `s${n}-${i}`,
      type: 'line',
      from: sub.anchors[i].id,
      to: a.id,
    }));
    initial = insertDesignPath(path).apply(initial);
    initial = {
      ...initial,
      elements: initial.elements.map((e, i) => ({ ...e, name: `Path ${i + 1}` })),
    };
  }
  await page.addInitScript(
    (value) => sessionStorage.setItem('plain-native', value),
    JSON.stringify(initial),
  );
  await independent(page);
  await page.getByRole('button', { name: 'Layer Path 1', exact: true }).click();
  const stage = page.getByRole('application', { name: 'Design canvas', exact: true });
  await stage.focus();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect(page.getByRole('alert')).toContainText(/path|limit|storage/i);
  expect(await content(page)).toEqual(initial);
  expect(await page.getByTestId('revision').textContent()).toBe('0');
});

test('coordinate drafts keep their point owner when another handle is selected or dragged', async ({
  page,
}) => {
  await independent(page);
  await page.getByRole('button', { name: 'Add cubic path', exact: true }).click();
  await page.getByRole('button', { name: 'Edit path points', exact: true }).click();
  await page.getByLabel('Path point X', { exact: true }).fill('25');
  await drag(page, 'Anchor 1.2', 25, 15);
  const moved = await content(page),
    anchors = moved.elements[0].path!.subpaths[0].anchors;
  expect(anchors[0].x).toBe(25);
  expect(anchors[1].x).toBeGreaterThan(110);
  await page.getByRole('button', { name: 'Host Save', exact: true }).click();
  expect(await content(page)).toEqual(moved);
  await page.getByLabel('Path point X', { exact: true }).fill('1000001');
  await page.getByRole('button', { name: 'Anchor 1.1', exact: true }).click();
  await expect(page.getByLabel('Path point', { exact: true }).locator('option:checked')).toHaveText(
    'Anchor 1.2',
  );
  await expect(page.getByLabel('Path point X', { exact: true })).toHaveValue('1000001');
  await page.getByRole('button', { name: 'Host Save', exact: true }).click();
  await expect(page.getByTestId('host-status')).toHaveText('Not saved');
  expect(await content(page)).toEqual(moved);
});

test('an in-place mutable Host update cancels a path gesture without overwriting the new path', async ({
  page,
}) => {
  const initial = insertDesignPath(presetDesignPath('cubic')).apply(createDesign());
  await page.addInitScript(
    (value) => sessionStorage.setItem('mutable-native', value),
    JSON.stringify(initial),
  );
  await independent(page);
  await page.getByRole('button', { name: 'Layer Editable path', exact: true }).click();
  await page.getByRole('button', { name: 'Edit path points', exact: true }).click();
  const p = page.getByRole('button', { name: 'Anchor 1.1', exact: true }),
    b = (await p.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 30, b.y + 20);
  await page
    .getByRole('button', { name: 'Host mutate path', exact: true })
    .evaluate((e) => (e as HTMLButtonElement).click());
  const updated = await content(page);
  expect(updated.elements[0].path!.subpaths[0].anchors[0].x).toBe(25);
  await page.mouse.move(b.x + 60, b.y + 40);
  await page.mouse.up();
  expect(await content(page)).toEqual(updated);
  await anchorMatchesDrawing(page);
});

test('clipped path hit geometry cannot intercept clicks on objects outside its parent frame', async ({
  page,
}) => {
  let initial = insertElement('shape', {
    id: 'under',
    bounds: { x: 330, y: 190, width: 100, height: 100 },
  }).apply(createDesign());
  initial = patchDesign(['under'], { name: 'Under' }).apply(initial);
  initial = insertElement('frame', {
    id: 'clip',
    bounds: { x: 200, y: 200, width: 100, height: 100 },
  }).apply(initial);
  initial = patchDesign(['clip'], { clipContent: true }).apply(initial);
  const path = presetDesignPath('line');
  for (const a of path.subpaths[0].anchors) a.y = 50;
  initial = insertDesignPath(path, { x: 180, y: 180, width: 220, height: 160 }, 'clip').apply(
    initial,
  );
  await page.addInitScript(
    (value) => sessionStorage.setItem('plain-native', value),
    JSON.stringify(initial),
  );
  await independent(page);
  await page.getByRole('button', { name: 'Fit design', exact: true }).click();
  const under = page.getByRole('button', { name: 'Design object Under', exact: true });
  await under.click();
  await expect(under).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('button', { name: 'Design object Editable path', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
});

test('opaque native point IDs remain distinct and boundary keyboard nudges fail without browser errors', async ({
  page,
}) => {
  const path = presetDesignPath('cubic'),
    sub = path.subpaths[0];
  sub.anchors[0].id = 's:c1';
  sub.segments[0].id = 's';
  sub.segments[0].from = 's:c1';
  if (sub.segments[0].type === 'cubic') sub.segments[0].c1.x = -40;
  sub.anchors[1].x = 600000;
  if (sub.segments[1].type === 'cubic') sub.segments[1].c1.x = -600000;
  const initial = insertDesignPath(path).apply(createDesign());
  await page.addInitScript(
    (value) => sessionStorage.setItem('plain-native', value),
    JSON.stringify(initial),
  );
  await independent(page);
  await page.getByRole('button', { name: 'Layer Editable path', exact: true }).click();
  await page.getByRole('button', { name: 'Edit path points', exact: true }).click();
  const anchor = page.getByRole('button', { name: 'Anchor 1.1', exact: true });
  await anchor.focus();
  await page.keyboard.press('ArrowRight');
  expect((await content(page)).elements[0].path!.subpaths[0].anchors[0].x).toBe(1);
  await page.getByLabel('Path point X', { exact: true }).fill('1000000');
  await page.getByLabel('Path point X', { exact: true }).press('Enter');
  const limited = await content(page),
    revision = await page.getByTestId('revision').textContent();
  await anchor.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('alert')).toContainText('limits');
  expect(await content(page)).toEqual(limited);
  expect(await page.getByTestId('revision').textContent()).toBe(revision);
  await page.getByLabel('Path point', { exact: true }).selectOption({ label: 'Anchor 1.2' });
  await page.getByLabel('Anchor mode', { exact: true }).selectOption('symmetric');
  await expect(page.getByLabel('Anchor mode', { exact: true })).toHaveValue('corner');
  await expect(page.getByRole('alert')).toContainText('limits');
  expect(await content(page)).toEqual(limited);
  expect(await page.getByTestId('revision').textContent()).toBe(revision);
});

test('independent public handles cancel capture on Escape even when the domain revision stays fixed', async ({
  page,
}) => {
  await independent(page, 'handles');
  const anchor = page.getByRole('button', { name: 'Independent anchor', exact: true });
  const box = (await anchor.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.keyboard.press('Escape');
  const cancelled = JSON.parse((await page.getByTestId('events').textContent())!) as string[];
  expect(cancelled).toContain('cancel');
  expect(cancelled).toContain('domain escape');
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.up();
  expect(JSON.parse((await page.getByTestId('events').textContent())!)).toEqual(cancelled);
  expect(cancelled).not.toContain('commit');
});

test('canvas Escape retains rejected coordinate drafts until the input is explicitly cancelled', async ({
  page,
}) => {
  await independent(page);
  await page.getByRole('button', { name: 'Add line path', exact: true }).click();
  await page.getByRole('button', { name: 'Edit path points', exact: true }).click();
  const before = await content(page),
    revision = await page.getByTestId('revision').textContent();
  const input = page.getByLabel('Path point X', { exact: true });
  await input.fill('1000001');
  await input.press('Enter');
  const stage = page.getByRole('application', { name: 'Design canvas', exact: true });
  await stage.click({ position: { x: 10, y: 10 } });
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Finish point editing', exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue('1000001');
  await page.getByRole('button', { name: 'Host Save', exact: true }).click();
  await expect(page.getByTestId('host-status')).toHaveText('Not saved');
  expect(await content(page)).toEqual(before);
  expect(await page.getByTestId('revision').textContent()).toBe(revision);
  await input.focus();
  await page.keyboard.press('Escape');
  await stage.click({ position: { x: 10, y: 10 } });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Edit path points', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Host Save', exact: true }).click();
  await expect(page.getByTestId('host-status')).toHaveText('Saved');
  expect(await content(page)).toEqual(before);
});

test('marquee outside a clipping frame excludes invisible path overflow and cannot delete it', async ({
  page,
}, info) => {
  let initial = insertElement('frame', {
    id: 'clip',
    bounds: { x: 100, y: 100, width: 100, height: 100 },
  }).apply(createDesign());
  initial = patchDesign(['clip'], { clipContent: true }).apply(initial);
  const path = presetDesignPath('line');
  path.subpaths[0].anchors[0].y = 80;
  path.subpaths[0].anchors[1] = { ...path.subpaths[0].anchors[1], x: 1000, y: 80 };
  initial = insertDesignPath(path, { x: 120, y: 120, width: 40, height: 40 }, 'clip').apply(
    initial,
  );
  await page.addInitScript(
    (value) => sessionStorage.setItem('plain-native', value),
    JSON.stringify(initial),
  );
  await independent(page);
  await page.getByRole('button', { name: 'Fit design', exact: true }).click();
  const stage = page.getByRole('application', { name: 'Design canvas', exact: true });
  const points = await stage
    .locator(':scope > g')
    .first()
    .evaluate(
      (g, points) =>
        points.map((p) => {
          const screen = new DOMPoint(p.x, p.y).matrixTransform(
            (g as SVGGraphicsElement).getScreenCTM()!,
          );
          return { x: screen.x, y: screen.y };
        }),
      [
        { x: 230, y: 110 },
        { x: 270, y: 170 },
      ],
    );
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  await page.mouse.move(points[1].x, points[1].y, { steps: 5 });
  await page.mouse.up();
  await expect(
    page.getByRole('button', { name: 'Design object Editable path', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  expect(await page.getByTestId('revision').textContent()).toBe('0');
  await page.keyboard.press('Delete');
  expect(await content(page)).toEqual(initial);
  await page.screenshot({ path: info.outputPath('clipped-path-marquee.png') });
});
