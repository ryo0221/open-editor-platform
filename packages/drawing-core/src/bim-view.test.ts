import { describe, expect, it } from 'vitest';
import { drawingBimViewGraphics, type DrawingBimDrawing } from './bim-view';
import type { DrawingBimView, DrawingDocument } from './model';
import { addDrawingView, drawingStarter, useDrawingSource } from './operations';
import { validateDrawing } from './validation';

// DW5a (docs/cad/drawing-editor.md, 施工図): a building version's plan or section on a sheet.
// ST-710, TS-2430.

const view: DrawingBimView = {
  id: 'view-1',
  sheetId: 'sheet-1',
  sourceId: 'src-1',
  kind: 'bim-view',
  name: '1F plan',
  at: [200, 150],
  scale: '1:100',
  label: true,
  bimViewId: 'v-1f',
};
const docWith = (kind: 'cad' | 'bim', v: object = view): DrawingDocument => {
  const used = useDrawingSource(drawingStarter(), {
    id: 'src-1',
    kind,
    artifactId: 'b',
    versionId: 'v1',
    contentHash: 'hb',
    name: 'Building',
  }).doc;
  return { ...used, views: [v as DrawingBimView] };
};

describe('building views on a sheet (DW5a)', () => {
  it('sees a building version, at the building editor’s scales, by its view’s ID', () => {
    expect(validateDrawing(docWith('bim'))).toEqual([]);
    expect(() =>
      addDrawingView(useDrawingSource(drawingStarter(), docWith('bim').sources[0]!).doc, view),
    ).not.toThrow();
    const codes = (d: DrawingDocument) => validateDrawing(d).map((x) => `${x.code}@${x.path}`);
    // A building view of a CAD version, and a CAD view of a building version.
    expect(codes(docWith('cad'))).toEqual(['source-kind@$.views[0].sourceId']);
    expect(
      codes(
        docWith('bim', {
          id: 'view-1',
          sheetId: 'sheet-1',
          sourceId: 'src-1',
          kind: 'cad-projection',
          name: 'Front',
          at: [0, 0],
          scale: '1:100',
          label: true,
          direction: 'front',
          only: [],
          hiddenLines: true,
          centerLines: true,
        }),
      ),
    ).toEqual(['source-kind@$.views[0].sourceId']);
    // A scale the building editor has no symbols for; no view named; a stray key.
    expect(codes(docWith('bim', { ...view, scale: '1:20' }))).toEqual(['scale@$.views[0].scale']);
    expect(codes(docWith('bim', { ...view, bimViewId: '' }))).toEqual([
      'shape@$.views[0].bimViewId',
    ]);
    expect(codes(docWith('bim', { ...view, direction: 'front' }))[0]).toMatch(/^shape/);
  });

  it('places the building drawing at the view’s scale, cut lines thick and grids chained', () => {
    const d: DrawingBimDrawing = {
      items: [
        {
          type: 'polygon',
          loops: [
            [
              [0, 0],
              [10000, 0],
              [10000, 200],
              [0, 200],
            ],
          ],
          cls: 'cut cut-wall m-concrete',
          id: 'w-south',
        },
        { type: 'segments', points: [0, 0, 0, 8000], cls: 'seen' },
        { type: 'line', a: [-1000, 4000], b: [11000, 4000], cls: 'grid', id: 'g-1' },
        { type: 'circle', center: [-1400, 4000], radius: 400, cls: 'grid-bubble' },
        { type: 'text', at: [-1400, 4000], text: '1', anchor: 'middle', cls: 'grid-label' },
      ],
      failed: [{ id: 'p-1', code: 'part-missing' }],
    };
    const g = drawingBimViewGraphics(view, d);
    // The box of the lines (−1,800 … 11,000 × 0 … 8,000) is centred on `at`, 1:100.
    const area = g.items.find((i) => i.type === 'area')!;
    expect(area.type === 'area' && area.loops[0]![0]).toEqual([200 + (0 - 4600) / 100, 150 - 40]);
    const outline = g.items.find((i) => i.type === 'polyline');
    expect(outline?.type === 'polyline' && outline.cls).toBe('thick');
    expect(g.items.find((i) => i.type === 'line')).toMatchObject({ cls: 'center' });
    expect(g.items.find((i) => i.type === 'circle')).toMatchObject({ radius: 4, cls: 'thin' });
    expect(g.items.find((i) => i.type === 'segments')).toMatchObject({ cls: 'thin' });
    // Text keeps its paper size; what was not drawn is listed in red under the view.
    const texts = g.items.filter((i) => i.type === 'text');
    expect(texts[0]).toMatchObject({ text: '1', heightMm: 2.5, anchor: 'middle' });
    expect(texts[1]).toMatchObject({ error: true });
    expect(texts[1]!.type === 'text' && texts[1]!.text).toContain('p-1 (part-missing)');
    expect(g.bounds[0][1]).toBeLessThan(110);
    expect(g.bounds[1][0]).toBeCloseTo(200 + (11000 - 4600) / 100, 6);
    expect(g.frame).toBeUndefined();
    // A narrow drawing's failure messages widen its bounds (Codex on #1237).
    const narrow = drawingBimViewGraphics(view, {
      items: [{ type: 'line', a: [0, 0], b: [0, 1000], cls: 'seen' }],
      failed: [{ id: 'p-1', code: 'part-missing' }],
    });
    expect(narrow.bounds[1][0] - narrow.bounds[0][0]).toBeGreaterThan(40);
    // A Japanese room name counts a full em a character (Codex on #1237): 20 × 2.5 mm.
    const named = drawingBimViewGraphics(view, {
      items: [
        {
          type: 'text',
          at: [0, 0],
          text: '大会議室'.repeat(5),
          anchor: 'middle',
          cls: 'space-name',
        },
      ],
      failed: [],
    });
    expect(named.bounds[1][0] - named.bounds[0][0]).toBeCloseTo(50, 6);
    // A shallow arc of a big circle is as big as its sweep, not its circle (Codex on #1237).
    const shallow = drawingBimViewGraphics(view, {
      items: [
        { type: 'arc', center: [0, -100000], radius: 100000, start: 1.562, end: 1.58, cls: 'seen' },
      ],
      failed: [],
    });
    const [[ax0, ay0], [ax1, ay1]] = shallow.bounds;
    expect(ax1 - ax0).toBeLessThan(20);
    expect(ay1 - ay0).toBeLessThan(1);
    // At 1:200 the same drawing is half the size on paper.
    const half = drawingBimViewGraphics({ ...view, scale: '1:200' }, d);
    expect(half.items.find((i) => i.type === 'circle')).toMatchObject({ radius: 2 });
  });
});

// DW5b: elevations, framing plans and framing elevations of a building version. ST-711, TS-2436.
describe('building construction views (DW5b)', () => {
  const codes = (v: object) =>
    validateDrawing(docWith('bim', { ...base, ...v })).map((x) => `${x.code}@${x.path}`);
  const base = {
    id: 'view-1',
    sheetId: 'sheet-1',
    sourceId: 'src-1',
    name: 'v',
    at: [0, 0],
    scale: '1:200',
    label: true,
  };
  it('sees a side, a level or a grid axis of a building version', () => {
    expect(codes({ kind: 'bim-elevation', side: 'front' })).toEqual([]);
    expect(codes({ kind: 'bim-framing', levelId: 'l-2f' })).toEqual([]);
    expect(codes({ kind: 'bim-frame', gridId: 'g-y1', bandMm: 0 })).toEqual([]);
    expect(codes({ kind: 'bim-elevation', side: 'up' })).toEqual(['shape@$.views[0].side']);
    expect(codes({ kind: 'bim-framing', levelId: '' })).toEqual(['shape@$.views[0].levelId']);
    expect(codes({ kind: 'bim-frame', gridId: 'g', bandMm: -1 })).toEqual([
      'shape@$.views[0].bandMm',
    ]);
    expect(codes({ kind: 'bim-frame', gridId: 'g', bandMm: 0, scale: '1:1' })).toEqual([
      'scale@$.views[0].scale',
    ]);
    // Of a CAD version: refused.
    expect(
      validateDrawing(docWith('cad', { ...base, kind: 'bim-framing', levelId: 'l' })).map(
        (x) => x.code,
      ),
    ).toEqual(['source-kind']);
  });
  it('draws a framing drawing’s members heavy and its marks at the paper’s text size', () => {
    const g = drawingBimViewGraphics(view, {
      items: [
        { type: 'line', a: [0, 0], b: [7200, 0], cls: 'member', id: 'b-1' },
        {
          type: 'text',
          at: [3600, 200],
          text: 'G1',
          anchor: 'middle',
          cls: 'member-mark',
          id: 'b-1',
        },
      ],
      failed: [],
    });
    expect(g.items[0]).toMatchObject({ type: 'line', cls: 'thick' });
    expect(g.items[1]).toMatchObject({ type: 'text', text: 'G1', heightMm: 2.5 });
  });
});
