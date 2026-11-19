import { expect, it } from 'vitest';
import {
  createDesign,
  designFrameAreaBounds,
  designFrameAreaElements,
  exportDesignFrameAreaSvg,
  exportDesignSvg,
  makeDesignElement,
  type DesignContent,
} from './model';

// Manga pages keep panel art on page-level layers, not under the panel frame.
function page(): DesignContent {
  const d = createDesign();
  const el = (
    type: 'frame' | 'rectangle' | 'text',
    id: string,
    x: number,
    y: number,
    w: number,
    h: number,
    extra = {},
  ) => ({
    ...{ ...makeDesignElement(type), bounds: { x, y, width: w, height: h } },
    id,
    name: id,
    ...extra,
  });
  return {
    ...d,
    elements: [
      el('frame', 'PG-1', 0, 0, 400, 600, { fill: '#ffffff' }),
      el('frame', 'PN-1', 10, 10, 180, 200, { parentId: 'PG-1', fill: 'transparent' }),
      el('frame', 'LY-ink', 0, 0, 400, 600, { parentId: 'PG-1', fill: 'transparent' }),
      el('rectangle', 'art-in', 50, 50, 40, 40, { parentId: 'LY-ink', fill: '#123456' }),
      el('rectangle', 'art-out', 300, 400, 40, 40, { parentId: 'LY-ink', fill: '#abcdef' }),
      el('rectangle', 'hidden', 60, 60, 10, 10, {
        parentId: 'LY-ink',
        fill: '#fedcba',
        hidden: true,
      }),
    ],
  } as DesignContent;
}

it('exports what is seen inside a panel, including page-level layer art, cropped to the panel', () => {
  const d = page();
  // A subtree export of the panel has no art.
  expect(exportDesignSvg(d, ['PN-1'])).not.toContain('#123456');
  const svg = exportDesignFrameAreaSvg(d, 'PN-1', { background: '#ffffff' });
  expect(svg).toContain('#123456');
  expect(svg).not.toContain('#abcdef');
  expect(svg).not.toContain('#fedcba');
  expect(svg).toMatch(/viewBox="10 10 180 200"/);
  expect(() => exportDesignFrameAreaSvg(d, 'art-in')).toThrow('Frame art-in not found');
});

it('culls by projected paint extent, so a rotated shape that overlaps the panel is kept and listed for export guards', () => {
  const d = page();
  const rotated = {
    ...d.elements.find((e) => e.id === 'art-out')!,
    id: 'rotated',
    fill: '#0f0f0f',
    bounds: { x: 195, y: 100, width: 10, height: 100 },
    rotation: 90,
  };
  const withRotated = { ...d, elements: [...d.elements, rotated] } as DesignContent;
  expect(exportDesignFrameAreaSvg(withRotated, 'PN-1')).toContain('#0f0f0f');
  const ids = designFrameAreaElements(withRotated, 'PN-1').map((e) => e.id);
  expect(ids).toEqual(expect.arrayContaining(['PG-1', 'PN-1', 'LY-ink', 'art-in', 'rotated']));
  expect(ids).not.toContain('art-out');
  expect(ids).not.toContain('hidden');
});

it('clips page-level art to an oblique panel outline, not only to its bounding box', () => {
  const d = page();
  const oblique = {
    ...d,
    elements: d.elements.map((e) =>
      e.id === 'PN-1'
        ? {
            ...e,
            panelGeometry: {
              polygon: [
                { x: 0, y: 0 },
                { x: 1, y: 0 },
                { x: 0.5, y: 1 },
              ],
            },
          }
        : e,
    ),
  } as DesignContent;
  const plain = exportDesignFrameAreaSvg(d, 'PN-1');
  const svg = exportDesignFrameAreaSvg(oblique, 'PN-1');
  expect(svg).toContain('#123456');
  expect(svg).toContain('<path d="M10 10 L190 10 L100 210Z"');
  expect(plain).not.toContain('L100 210Z');
  // A flipped panel draws its polygon reflected, so the crop is reflected too.
  const flipped = {
    ...oblique,
    elements: oblique.elements.map((e) => (e.id === 'PN-1' ? { ...e, flipY: true } : e)),
  } as DesignContent;
  // The panel's own drawing is flipped once; every other drawing's crop is flipped too.
  const reflected = exportDesignFrameAreaSvg(flipped, 'PN-1').split('scale(1 -1)').length - 1;
  expect(reflected).toBeGreaterThan(1);
  expect(svg).not.toContain('scale(1 -1)');
});

it('crops a rotated panel to the extent it covers on the page', () => {
  const d = page();
  const turned = {
    ...d,
    elements: [
      ...d.elements.map((e) =>
        e.id === 'PN-1'
          ? { ...e, bounds: { x: 0, y: 0, width: 100, height: 20 }, rotation: 90 }
          : e,
      ),
      {
        ...d.elements.find((e) => e.id === 'art-in')!,
        id: 'art-top',
        fill: '#246802',
        bounds: { x: 45, y: -30, width: 5, height: 5 },
      },
    ],
  } as DesignContent;
  const extent = designFrameAreaBounds(turned, 'PN-1');
  expect([extent.x, extent.y, extent.width, extent.height].map(Math.round)).toEqual([
    40, -40, 20, 100,
  ]);
  expect(designFrameAreaElements(turned, 'PN-1').map((e) => e.id)).toContain('art-top');
  expect(exportDesignFrameAreaSvg(turned, 'PN-1')).toContain('#246802');
});
