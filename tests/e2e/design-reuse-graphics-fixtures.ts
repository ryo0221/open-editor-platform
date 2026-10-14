import { build } from 'esbuild';
import { type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { expect } from './fixtures';
import {
  designDrawingProjector,
  makeDesignElement,
  type DesignContent,
} from '@editor-platform/design/model';
import { drawingPrimitives, serializeSvg } from '@editor-platform/editor-core';
import {
  smallButton,
  checkVector,
  collidingVectors,
  textLayoutReviewContent,
} from '../fixtures/design-reuse/content';
import { expandTemplate, saveAsTemplate } from '@editor-platform/templates';
export async function assertExpandedTextLayout(page: Page) {
  const source = textLayoutReviewContent('base');
  source.elements = [];
  source.components = [];
  for (const [index, mode] of (['base', 'run', 'padding', 'siblings'] as const).entries()) {
    const part = textLayoutReviewContent(mode);
    source.elements.push({
      ...part.elements[0],
      id: `instance-${index}`,
      componentId: `component-${index}`,
      bounds: { x: index * 130, y: 0, width: 100, height: 80 },
    });
    source.components.push({ ...part.components[0], id: `component-${index}` });
  }
  const definition = await saveAsTemplate({
    domain: 'design',
    content: source,
    kind: 'whole',
    name: 'Typography layout',
    purpose: 'Browser regression',
    category: 'test',
    slots: [],
    overflow: { policy: 'expand', minFontSize: 10 },
  });
  const expanded = expandTemplate(definition, {}, { remap: false }).content as DesignContent;
  expect(expanded.components).toEqual(source.components);
  const drawings = expanded.elements
    .flatMap(designDrawingProjector(expanded))
    .filter((d) => d.kind === 'text');
  expect(drawings.map((d) => d.bounds.height)).toEqual([44, 44, 35.6, 70.4, 23.6]);
  // The unclipped component can extend past its frame; give the Host an explicit export page.
  expanded.elements.unshift({
    ...makeDesignElement('frame'),
    id: 'page',
    name: 'Export page',
    text: '',
    fill: 'none',
    stroke: 'none',
    bounds: { x: 0, y: 0, width: 520, height: 140 },
  });
  await independentDesignReuse(page, expanded);
  const geometry = await page.locator('svg text').evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = (node as SVGTextElement).getBBox();
      return { text: node.textContent, x: box.x, y: box.y, width: box.width, height: box.height };
    }),
  );
  expect(geometry).toHaveLength(5);
  for (let index = 0; index < drawings.length; index++) {
    const bounds = drawings[index].bounds;
    expect(geometry[index].width).toBeGreaterThan(0);
    // DrawingView translates each drawing and gives its primitives a (0,0) origin.
    expect(geometry[index].y).toBeGreaterThanOrEqual(0);
    expect(geometry[index].y + geometry[index].height).toBeLessThanOrEqual(bounds.height);
  }
  await page.getByRole('button', { name: 'Host save', exact: true }).click();
  await page.reload();
  expect(JSON.parse((await page.getByTestId('reuse-native').textContent())!)).toEqual(expanded);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}
let bundled: Promise<{ js: string; css: string }> | undefined;
let diagnosticsBundle: Promise<{ js: string; css: string }> | undefined;
export async function assertInputDiagnostics(page: Page) {
  diagnosticsBundle ??= build({
    entryPoints: ['tests/fixtures/design-reuse/diagnostics-host.tsx'],
    bundle: true,
    write: false,
    outdir: '/tmp/design-diagnostics-bundle',
    format: 'esm',
    define: { 'process.env.NODE_ENV': '"production"' },
  }).then((result) => ({
    js: result.outputFiles!.find((file) => file.path.endsWith('.js'))!.text,
    css: result.outputFiles!.find((file) => file.path.endsWith('.css'))!.text,
  }));
  const bundle = await diagnosticsBundle;
  await page.route('**/design-diagnostics.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: bundle.js }),
  );
  await page.route('**/design-diagnostics.css', (route) =>
    route.fulfill({ contentType: 'text/css', body: bundle.css }),
  );
  await page.route('**/design-diagnostics-host', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/design-diagnostics.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/design-diagnostics.js"></script></body></html>',
    }),
  );
  await page.goto('/design-diagnostics-host');
  const first = page.locator('[data-slot="first"]');
  const second = page.locator('[data-slot="second"]');
  await expect(first).toBeVisible();
  const native = await page.getByTestId('diagnostic-native').textContent();
  await second.fill('一行目\n二行目\n三行目\n四行目');
  await page.getByRole('button', { name: 'Host validate input', exact: true }).click();
  await expect(second).toHaveAttribute('aria-invalid', 'true');
  await expect(first).toHaveAttribute('aria-invalid', 'false');
  await expect(page.locator('.tp-field-error')).toContainText('clipping frame');
  await expect(page.getByTestId('diagnostic-native')).toHaveText(native!);
  const diagnostics = JSON.parse((await page.getByTestId('input-diagnostics').textContent())!);
  expect(diagnostics.every((diagnostic: { path: string }) => diagnostic.path === 'second')).toBe(
    true,
  );
}
export async function independentDesignReuse(page: Page, initial?: DesignContent) {
  if (initial)
    await page.addInitScript((encoded) => {
      if (!sessionStorage.getItem('design-reuse-native'))
        sessionStorage.setItem('design-reuse-native', encoded);
    }, JSON.stringify(initial));
  bundled ??= build({
    entryPoints: ['tests/fixtures/design-reuse/host.tsx'],
    bundle: true,
    write: false,
    outdir: '/tmp/design-reuse-bundle',
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
  }).then((result) => ({
    js: result.outputFiles!.find((f) => f.path.endsWith('.js'))!.text,
    css: result.outputFiles!.find((f) => f.path.endsWith('.css'))!.text,
  }));
  const bundle = await bundled;
  await page.route('**/design-reuse-host.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: bundle.js }),
  );
  await page.route('**/design-reuse-host.css', (r) =>
    r.fulfill({ contentType: 'text/css', body: bundle.css }),
  );
  await page.route('**/design-reuse-host', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/design-reuse-host.css"></head><body style="margin:0"><div id="root"></div><script src="/design-reuse-host.js"></script></body></html>',
    }),
  );
  await page.goto('/design-reuse-host');
  await expect(page.getByRole('button', { name: 'Host dark mode', exact: true })).toBeVisible();
}
export async function assertVectorOccurrences(page: Page) {
  const content = collidingVectors();
  await independentDesignReuse(page, content);
  const clips = page.locator('svg clipPath[id^="vector-"]');
  await expect(clips).toHaveCount(2);
  expect(await clips.evaluateAll((nodes) => new Set(nodes.map((n) => n.id)).size)).toBe(2);
  const drawings = content.elements.flatMap(designDrawingProjector(content));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="40" viewBox="0 0 144 40">${serializeSvg(drawings.flatMap((drawing) => drawingPrimitives(drawing)))}</svg>`;
  const result = await page.evaluate(async (source) => {
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    const ids = [...doc.querySelectorAll('clipPath')].map((n) => n.id);
    const image = new Image();
    image.alt = 'Primitive occurrence export';
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(source);
    await image.decode();
    document.body.append(image);
    const canvas = document.createElement('canvas');
    canvas.width = 144;
    canvas.height = 40;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, 144, 40).data;
    let red = 0,
      green = 0,
      outside = 0;
    for (let y = 0; y < 40; y++)
      for (let x = 0; x < 144; x++) {
        const i = (y * 144 + x) * 4;
        const r = pixels[i] > 250 && pixels[i + 1] < 5 && pixels[i + 2] < 5 && pixels[i + 3] > 250;
        const g = pixels[i] < 5 && pixels[i + 1] > 250 && pixels[i + 2] < 5 && pixels[i + 3] > 250;
        if (r) {
          red++;
          if (x >= 48 || y >= 24) outside++;
        }
        if (g) {
          green++;
          if (x < 86 || x >= 98 || y >= 24) outside++;
        }
      }
    return {
      red,
      green,
      outside,
      ids: ids.length,
      unique: new Set(ids).size,
      xmlErrors: doc.querySelectorAll('parsererror').length,
    };
  }, svg);
  expect(result).toEqual({ red: 1152, green: 288, outside: 0, ids: 2, unique: 2, xmlErrors: 0 });
}
export async function assertVectorViewport(page: Page, rotated = false) {
  const content = smallButton();
  const icon = content.elements.find((e) => e.id === 'check')!;
  Object.assign(icon, {
    fill: '#ff0000',
    stroke: 'none',
    rotation: rotated ? 90 : 0,
    flipX: rotated,
    vector: {
      ...checkVector,
      viewBox: { x: 10, y: 20, width: 24, height: 12 },
      paths: ['M-100 -100H1000000V1000000H-100Z'],
    },
  });
  await independentDesignReuse(page, content);
  await expect(page.locator('svg [data-vector-source] > g')).toHaveAttribute(
    'clip-path',
    /url\(#vector-/,
  );
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Host export PNG', exact: true }).click();
  const bytes = await readFile((await (await pending).path())!);
  const result = await page.evaluate(
    async ({ encoded, rotated }) => {
      const image = new Image();
      image.src = 'data:image/png;base64,' + encoded;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
      let inside = 0,
        outside = 0;
      for (let y = 0; y < image.height; y++)
        for (let x = 0; x < image.width; x++) {
          const i = (y * image.width + x) * 4;
          if (pixels[i] > 250 && pixels[i + 1] < 5 && pixels[i + 2] < 5 && pixels[i + 3] > 250) {
            const contained = rotated
              ? x >= 14 && x < 26 && y >= 8 && y < 32
              : x >= 8 && x < 32 && y >= 14 && y < 26;
            if (contained) inside++;
            else outside++;
          }
        }
      return { width: image.width, height: image.height, inside, outside };
    },
    { encoded: bytes.toString('base64'), rotated },
  );
  expect(result).toEqual({ width: 144, height: 40, inside: 288, outside: 0 });
  await page.getByRole('button', { name: 'Host save', exact: true }).click();
  await page.reload();
  expect(JSON.parse((await page.getByTestId('reuse-native').textContent())!)).toEqual(content);
}
export async function assertButtonPng(page: Page, expected: number[]) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Host export PNG', exact: true }).click();
  const downloaded = await pending;
  const bytes = await readFile((await downloaded.path())!);
  const result = await page.evaluate(
    async ({ encoded, expected }) => {
      const image = new Image();
      image.src = 'data:image/png;base64,' + encoded;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      const data = ctx.getImageData(0, 0, 36, 36).data;
      let inkPixels = 0;
      for (let i = 0; i < data.length; i += 4)
        if (
          data[i + 3] === 255 &&
          expected.every((value, channel) => Math.abs(data[i + channel] - value) <= 2)
        )
          inkPixels++;
      return { width: image.width, height: image.height, inkPixels };
    },
    { encoded: bytes.toString('base64'), expected },
  );
  expect(result).toMatchObject({ width: 144, height: 40 });
  expect(result.inkPixels).toBeGreaterThan(10);
}
