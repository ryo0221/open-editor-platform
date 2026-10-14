import { test, expect, nativeArtifact, save } from './fixtures';
import { createArtifact } from '@editor-platform/artifact-core';
import type { Page } from '@playwright/test';
import type { SlideContent } from '@editor-platform/slide';
import type { DesignContent } from '@editor-platform/design';
import type { WhiteboardContent } from '@editor-platform/whiteboard';
import { readFile, writeFile } from 'node:fs/promises';
import {
  PDFDocument,
  PDFDict,
  PDFRawStream,
  PDFName,
  PDFNumber,
  decodePDFRawStream,
} from 'pdf-lib';

type Kind = 'slide' | 'design' | 'whiteboard';
type Content = SlideContent | DesignContent | WhiteboardContent;
function elements(d: Content) {
  return 'slides' in d ? d.slides[0].objects : 'elements' in d ? d.elements : d.nodes;
}
const node = (d: Content, id: string) => elements(d).find((n) => n.id === id)!;
async function snapshot(page: Page) {
  return (await nativeArtifact(page)).draft.content as Content;
}
async function arrange(page: Page, action: string) {
  await page.getByRole('button', { name: 'Arrange', exact: true }).click();
  await page.getByRole('button', { name: action, exact: true }).click();
  await page.keyboard.press('Escape');
}
async function select(page: Page, kind: Kind, content: Content, ids: string[]) {
  if (kind === 'slide') await page.getByRole('button', { name: 'Layers', exact: true }).click();
  for (const [i, id] of ids.entries()) {
    const index = elements(content).findIndex((e) => e.id === id);
    const label = kind === 'slide' ? `Select group object ${index + 1}` : `Layer ${id}`;
    await page
      .getByRole('button', { name: label, exact: true })
      .click({ modifiers: i ? ['Shift'] : [] });
  }
}
async function history(page: Page, before: Content, after: Content, reset = false) {
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await snapshot(page)).toEqual(before);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect(await snapshot(page)).toEqual(after);
  if (reset) await page.getByRole('button', { name: 'Undo', exact: true }).click();
}
async function imagePixel(page: Page, buffer: Buffer, x: number, y: number, mime = 'image/png') {
  return page.evaluate(
    async ({ source, mime, x, y }) => {
      const img = new Image();
      img.src = `data:${mime};base64,${source}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(img, 0, 0);
      return [...context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data].slice(0, 3);
    },
    { source: buffer.toString('base64'), mime, x, y },
  );
}

for (const kind of ['slide', 'design', 'whiteboard'] as const)
  test(`R2 ${kind}: menu size/flip/layers, atomic history, reload and screen/export pixels`, async ({
    page,
  }, info) => {
    test.setTimeout(150000);
    page.setDefaultTimeout(10000);
    await page.goto('/');
    const src = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 80;
      canvas.height = 40;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ff9900';
      ctx.fillRect(0, 0, 40, 40);
      ctx.fillStyle = '#00aa88';
      ctx.fillRect(40, 0, 40, 40);
      return canvas.toDataURL('image/png');
    });
    const item = (
      id: string,
      type: 'group' | 'shape' | 'image' | 'text',
      x: number,
      y: number,
      width: number,
      height: number,
      parentId?: string,
    ) => ({
      id,
      type,
      name: id,
      bounds: { x, y, width, height },
      parentId,
      text: type === 'text' ? 'ABC →' : '',
      fill: id === 'R' ? '#0000ff' : '#ff0000',
      rotation: 0,
      flipX: false,
      flipY: false,
      ...(type === 'image' ? { src } : {}),
      ...(type === 'text' ? { typography: { fontSize: 10, padding: 0 } } : {}),
    });
    // Reproducible public native import, followed by actual editor menu operations.
    const fixture = [
      item('G', 'group', 100, 100, 100, 100),
      item('A', 'shape', 110, 110, 20, 20, 'G'),
      item('N', 'group', 105, 135, 55, 30, 'G'),
      { ...item('T', 'text', 110, 140, 40, 15, 'N'), rotation: 345 },
      { ...item('I', 'image', 140, 105, 40, 20, 'G'), rotation: 20 },
      item('B', 'shape', 160, 160, 30, 30, 'G'),
      item('H', 'group', 100, 100, 200, 200),
      item('R', 'shape', 100, 100, 200, 200, 'H'),
    ];
    const content: Content =
      kind === 'slide'
        ? {
            schemaVersion: 2,
            width: 480,
            height: 360,
            slides: [
              {
                id: 'page',
                title: 'Group regression',
                background: '#ffffff',
                objects: fixture.map(({ parentId, ...e }) => ({ ...e, groupId: parentId })),
              },
            ],
          }
        : kind === 'design'
          ? { schemaVersion: 2, elements: fixture, components: [] }
          : {
              schemaVersion: 3,
              sections: [],
              nodes: fixture.map(({ type, parentId, fill, ...e }) => ({
                ...e,
                kind: type,
                groupId: parentId,
                color: fill,
              })),
              connectors: [{ id: 'edge', from: 'A', to: 'B', label: '' }],
            };
    await page.getByLabel('Import artifact', { exact: true }).setInputFiles({
      name: `${kind}-group.json`,
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          ...createArtifact(kind, `${kind} group review`, content),
          annotations: [],
        }),
      ),
    });
    await expect(page.getByLabel('Artifact name', { exact: true })).toHaveValue(
      `${kind} group review`,
    );
    const before = await snapshot(page);
    for (const dimension of ['width', 'height', 'both']) {
      await select(page, kind, before, ['G', 'H']);
      await arrange(page, `Match ${dimension} to first selected`);
      const after = await snapshot(page);
      for (const id of ['G', 'A', 'N', 'T', 'I', 'B'])
        expect(node(after, id)).toEqual(node(before, id));
      expect(node(after, 'R').bounds).toEqual({
        x: 100,
        y: 100,
        width: dimension === 'height' ? 200 : 100,
        height: dimension === 'width' ? 200 : 100,
      });
      await history(page, before, after, true);
    }
    await select(page, kind, before, ['H', 'G']);
    await arrange(page, 'Match both to first selected');
    const scaled = await snapshot(page);
    expect(node(scaled, 'A').bounds).toEqual({ x: 120, y: 120, width: 40, height: 40 });
    expect(node(scaled, 'T').bounds).toEqual({ x: 120, y: 180, width: 80, height: 30 });
    expect(node(scaled, 'H')).toEqual(node(before, 'H'));
    await history(page, before, scaled, true);
    for (const [axis, label] of [
      ['x', 'horizontally'],
      ['y', 'vertically'],
    ] as const) {
      await select(page, kind, before, ['G']);
      await arrange(page, `Flip ${label}`);
      const reflected = await snapshot(page);
      expect(node(reflected, 'A').bounds[axis]).toBe(170);
      expect(node(reflected, 'B').bounds[axis]).toBe(110);
      expect(node(reflected, 'I').rotation).toBe(340);
      expect(node(reflected, 'T').rotation).toBe(15);
      await history(page, before, reflected);
      await arrange(page, `Flip ${label}`);
      expect(await snapshot(page)).toEqual(before);
    }
    const canvas = page.getByRole('application', {
      name:
        kind === 'slide'
          ? 'Slide canvas'
          : kind === 'design'
            ? 'Design canvas'
            : 'Whiteboard canvas',
    });
    const screenPixel = async (state: Content) => {
      const index = elements(state).findIndex((e) => e.id === 'A');
      const target = canvas.getByRole('button', {
        name:
          kind === 'slide'
            ? `shape object ${index + 1}`
            : kind === 'design'
              ? 'Design object A'
              : `shape ${index + 1}`,
        exact: true,
      });
      const point = await target.evaluate((el) =>
        new DOMPoint(120, 120)
          .matrixTransform((el as unknown as SVGGraphicsElement).getScreenCTM()!)
          .toJSON(),
      );
      const screen = await page.screenshot();
      const rgb = await imagePixel(page, screen, point.x, point.y);
      if (kind === 'whiteboard') {
        const overviewPoint = await page
          .getByRole('img', { name: 'Board overview' })
          .evaluate((el) =>
            new DOMPoint(120, 120)
              .matrixTransform((el as unknown as SVGGraphicsElement).getScreenCTM()!)
              .toJSON(),
          );
        expect(await imagePixel(page, screen, overviewPoint.x, overviewPoint.y)).toEqual(rgb);
      }
      return rgb;
    };
    expect(await screenPixel(before)).toEqual([0, 0, 255]);
    await page.screenshot({ path: info.outputPath(`${kind}-groups-behind.png`) });
    let front = before;
    for (const [action, rgb] of [
      ['Bring to front', [255, 0, 0]],
      ['Send to back', [0, 0, 255]],
      ['Bring forward', [255, 0, 0]],
      ['Send backward', [0, 0, 255]],
      ['Bring to front', [255, 0, 0]],
    ] as const) {
      await select(page, kind, front, ['G']);
      const old = front;
      await arrange(page, action);
      front = await snapshot(page);
      expect(await screenPixel(front)).toEqual(rgb);
      await history(page, old, front);
    }
    if ('connectors' in front)
      expect(front.connectors).toEqual((before as WhiteboardContent).connectors);
    await save(page, 1);
    await page.reload();
    expect(await snapshot(page)).toEqual(front);
    expect(await screenPixel(front)).toEqual([255, 0, 0]);
    await page.screenshot({ path: info.outputPath(`${kind}-groups-front.png`) });
    await writeFile(
      info.outputPath(`${kind}-groups.native.json`),
      JSON.stringify(await nativeArtifact(page), null, 2),
    );
    let viewBox = [0, 0, 480, 360];
    for (const format of ['SVG', 'PNG', ...(kind === 'slide' ? ['PDF'] : [])]) {
      await page
        .getByRole('button', {
          name: kind === 'slide' ? 'Export visual' : `Export ${kind}`,
          exact: true,
        })
        .click();
      const pending = page.waitForEvent('download');
      await page
        .getByRole('button', {
          name: kind === 'slide' ? `Export ${format}` : `Export all ${format}`,
          exact: true,
        })
        .click();
      const download = await pending,
        path = info.outputPath(`${kind}-groups.${format.toLowerCase()}`);
      await download.saveAs(path);
      const bytes = await readFile(path);
      if (format === 'SVG') {
        viewBox = bytes
          .toString()
          .match(/viewBox="([^"]+)"/)![1]
          .split(/\s+/)
          .map(Number);
        expect(
          await imagePixel(page, bytes, 120 - viewBox[0], 120 - viewBox[1], 'image/svg+xml'),
        ).toEqual([255, 0, 0]);
      } else if (format === 'PNG') {
        expect(await imagePixel(page, bytes, 120 - viewBox[0], 120 - viewBox[1])).toEqual([
          255, 0, 0,
        ]);
      } else {
        const pdf = await PDFDocument.load(bytes);
        const images = pdf.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
        const bitmap = images.lookup(images.keys()[0]);
        if (!(bitmap instanceof PDFRawStream)) throw new Error('Expected exported page bitmap');
        const width = bitmap.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber();
        const offset =
          (Math.floor((120 * width) / 480) * width + Math.floor((120 * width) / 480)) * 3;
        expect([
          ...decodePDFRawStream(bitmap)
            .decode()
            .slice(offset, offset + 3),
        ]).toEqual([255, 0, 0]);
      }
      await page.keyboard.press('Escape');
    }
    if (kind === 'slide') {
      await page.getByRole('button', { name: 'Present', exact: true }).click();
      const svg = page.getByLabel('Presentation page 1', { exact: true });
      const point = await svg.evaluate((el) =>
        new DOMPoint(120, 120)
          .matrixTransform((el as unknown as SVGGraphicsElement).getScreenCTM()!)
          .toJSON(),
      );
      expect(await imagePixel(page, await page.screenshot(), point.x, point.y)).toEqual([
        255, 0, 0,
      ]);
      await page.screenshot({ path: info.outputPath('slide-groups-presentation.png') });
    }
  });
