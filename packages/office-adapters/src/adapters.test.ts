import { readFile } from 'node:fs/promises';
import { createCanvas } from '@napi-rs/canvas';
import { expect, it } from 'vitest';
import { hashExportBytes } from '@editor-platform/export-core';
import {
  prepareOfficeFonts,
  inspectOfficeImage,
  type OfficeFontManifest,
} from '@editor-platform/office-adapters';
import { decodeNodeOfficeImage, nodeOfficeImagePng } from '@editor-platform/office-adapters/node';
import { createOfficeSvgRenderer } from '@editor-platform/office-adapters/raster';
import { ownedOfficeFonts } from './fonts';
import { createPptxRasterAdapter } from '@editor-platform/slide-export/raster';

it('validates actual fixed Regular/Bold hashes, owns font buffers and rasterizes Japanese with them', async () => {
  const root = 'apps/playground/public/office-fonts/';
  const manifest = JSON.parse(await readFile(root + 'manifest.json', 'utf8')) as OfficeFontManifest;
  const source = await Promise.all(manifest.faces.map((f) => readFile(root + f.file)));
  const fonts = await prepareOfficeFonts(manifest, source);
  source[0].fill(0);
  expect(await hashExportBytes(ownedOfficeFonts(fonts)[0])).toBe(manifest.faces[0].sha256);
  await expect(prepareOfficeFonts(manifest, source)).rejects.toThrow('hash mismatch');
  const wasm = await readFile('node_modules/@resvg/resvg-wasm/index_bg.wasm');
  const render = await createOfficeSvgRenderer(wasm, fonts);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><text x="10" y="50" font-family="Noto Sans CJK JP" font-size="30">日本語の表示 ABC</text></svg>';
  const first = render(svg, 400, 100),
    second = render(svg, 400, 100);
  expect(first).toMatchObject({ width: 400, height: 100, mime: 'image/png' });
  expect(first.bytes).toEqual(second.bytes);
  expect(first.bytes.length).toBeGreaterThan(1000);
  expect(() => render(svg, 40, 10)).toThrow('dimensions changed');
  expect(() => render(svg, 10000, 10000)).toThrow('limit exceeded');
  const rasterize = await createPptxRasterAdapter(wasm, fonts, nodeOfficeImagePng);
  await expect(
    rasterize({
      drawing: {
        id: 'italic',
        kind: 'text',
        text: 'Italic を反転',
        fill: '#000',
        typography: { italic: true },
        bounds: { x: 0, y: 0, width: 300, height: 100 },
      },
      bounds: { x: 0, y: 0, width: 300, height: 100 },
      scale: 2,
    }),
  ).rejects.toMatchObject({ code: 'RASTER_TEXT_STYLE_UNSUPPORTED' });
  const expanded = await rasterize({
    drawing: {
      id: 'chart',
      kind: 'chart',
      text: '',
      fill: '#3879b9',
      bounds: { x: 10, y: 20, width: 120, height: 110 },
      chart: { labels: ['LONG_LABEL_OUTSIDE_THE_BOX'], values: [6], type: 'bar' },
    },
    bounds: { x: 10, y: 20, width: 120, height: 110 },
    scale: 2,
  });
  expect(expanded.bounds!.width).toBeGreaterThan(120);
  expect(expanded.width).toBe(Math.ceil(expanded.bounds!.width * 2));
});

it.each(['png', 'jpeg', 'webp'] as const)(
  'decodes %s bytes and rejects truncated input',
  async (mime) => {
    const canvas = createCanvas(23, 17),
      context = canvas.getContext('2d');
    context.fillStyle = '#e63546';
    context.fillRect(0, 0, 23, 17);
    const bytes = new Uint8Array(
      await (mime === 'png' ? canvas.encode('png') : canvas.encode(mime, 90)),
    );
    const asset = await decodeNodeOfficeImage(bytes);
    expect(asset).toMatchObject({ mime: `image/${mime}`, width: 23, height: 17 });
    const png = await nodeOfficeImagePng(asset);
    expect(png).toMatchObject({ mime: 'image/png', width: 23, height: 17 });
    await expect(decodeNodeOfficeImage(bytes.subarray(0, 26))).rejects.toThrow();
  },
);

it('rejects excessive dimensions before allocating a decoder and rejects non-image bytes', async () => {
  const canvas = createCanvas(23, 17);
  const bytes = new Uint8Array(await canvas.encode('png'));
  new DataView(bytes.buffer).setUint32(16, 2000000);
  expect(() => inspectOfficeImage(bytes)).toThrow();
  await expect(decodeNodeOfficeImage(new Uint8Array([60, 115, 118, 103, 62]))).rejects.toThrow(
    'Only PNG',
  );
});
