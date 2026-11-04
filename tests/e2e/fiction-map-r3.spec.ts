import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { createDeck, makeSlideObject, exportSlideSvg, isDeck } from '@editor-platform/slide/model';
import {
  createWhiteboard,
  makeWhiteboardNode,
  exportWhiteboardSvg,
  isWhiteboard,
} from '@editor-platform/whiteboard/model';
import { createSection, boardBounds } from '@editor-platform/whiteboard/sections';

// Public native export → browser SVG rasterization. This does not claim a new Host acceptance.
async function raster(page: Page, svg: string) {
  await page.goto('about:blank');
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1">');
  return page.evaluate(async (source) => {
    const root = new DOMParser().parseFromString(source, 'image/svg+xml').documentElement;
    const viewBox = root.getAttribute('viewBox')!.split(/\s+/).map(Number);
    const image = new Image();
    const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }));
    try {
      image.src = url;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth + 30;
      canvas.height = image.naturalHeight + 10;
      document.body.append(canvas);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      const pixel = (x: number, y: number) => [
        ...ctx.getImageData(x - viewBox[0], y - viewBox[1], 1, 1).data,
      ];
      return {
        viewBox,
        width: image.naturalWidth,
        inside: pixel(90, 45),
        overflow: pixel(110, 45),
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  }, svg);
}

test('R3 Slide export clips at the page viewport while retaining outside native geometry', async ({
  page,
}, info) => {
  const deck = createDeck();
  deck.width = 100;
  deck.height = 100;
  deck.slides[0].objects = [
    {
      ...makeSlideObject('shape', 0),
      id: 'overflow',
      shape: 'rectangle',
      bounds: { x: 80, y: 30, width: 40, height: 30 },
      fill: '#ff0000',
    },
  ];
  expect(isDeck(deck)).toBe(true);
  const before = JSON.stringify(deck);
  const svg = exportSlideSvg(deck, deck.slides[0]);
  expect(JSON.stringify(deck)).toBe(before);
  expect(await raster(page, svg)).toEqual({
    viewBox: [0, 0, 100, 100],
    width: 100,
    inside: [255, 0, 0, 255],
    overflow: [0, 0, 0, 0],
  });
  await page.screenshot({ path: info.outputPath('slide-page-clip.png') });
});

test('R3 Whiteboard Section retains visible overflow in export bounds rather than clipping members', async ({
  page,
}, info) => {
  const source = createWhiteboard();
  source.nodes = [
    {
      ...makeWhiteboardNode('rectangle', 0),
      id: 'overflow',
      text: '',
      color: '#ff0000',
      bounds: { x: 80, y: 30, width: 40, height: 30 },
    },
  ];
  const board = createSection({ x: 0, y: 0, width: 100, height: 100 }, 'Section', [
    'overflow',
  ]).apply(source);
  expect(isWhiteboard(board)).toBe(true);
  const sectionId = board.sections![0].id;
  expect(board.nodes[0].sectionId).toBe(sectionId);
  expect(boardBounds(board, [sectionId])).toEqual({ x: 0, y: 0, width: 120, height: 100 });
  const before = JSON.stringify(board);
  const svg = exportWhiteboardSvg(board, [sectionId]);
  expect(JSON.stringify(board)).toBe(before);
  const result = await raster(page, svg);
  expect(result.viewBox).toEqual([-30, -30, 180, 160]);
  expect(result.inside).toEqual([255, 0, 0, 255]);
  expect(result.overflow).toEqual([255, 0, 0, 255]);
  await page.screenshot({ path: info.outputPath('whiteboard-section-overflow.png') });
});
