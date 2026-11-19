import { describe, expect, it } from 'vitest';
import type { DrawingCadDetail, DrawingCadSection, DrawingCadView, DrawingSource } from './model';
import {
  addDrawingView,
  deleteDrawingItems,
  DrawingEditError,
  drawingStarter,
  nextDrawingMark,
  switchDrawingSource,
  useDrawingSource,
} from './operations';
import { drawingProject, drawingSectionFrame, drawingViewAxes } from './project';
import { drawingParentSymbol } from './symbols';
import { drawingSheetSvg } from './svg';
import { box, cylinder } from './test-shapes';
import { validateDrawing } from './validation';
import { clipToCircle, drawingCadViewGraphics, drawingViewSpec, hatch } from './view-graphics';

// DW2b (docs/cad/drawing-editor.md): sections, details, a newer version, the limits. ST-702,
// TS-2406.

const front = drawingViewAxes('front');
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) < 1e-9);

describe('section frames (DW2b)', () => {
  it('sees a vertical cutting line from the side and a horizontal one from above', () => {
    const side = drawingSectionFrame(front, [
      [30, -5],
      [30, 25],
    ]);
    expect(near(side.frame.direction, [1, 0, 0])).toBe(true);
    expect(near(side.frame.up, [0, 0, 1])).toBe(true);
    expect(side.cut.point[0]).toBe(30);
    const plan = drawingSectionFrame(front, [
      [-5, 10],
      [65, 10],
    ]);
    // Looking down, with the front view's depth (+y) as its up: like the top view.
    expect(near(plan.frame.direction, [0, 0, -1])).toBe(true);
    expect(near(plan.frame.up, [0, 1, 0])).toBe(true);
    expect(near(plan.frame.right, drawingViewAxes('top').right)).toBe(true);
    const below = drawingSectionFrame(front, [
      [65, 10],
      [-5, 10],
    ]);
    expect(near(below.frame.direction, [0, 0, 1])).toBe(true);
    expect(near(below.frame.up, [0, -1, 0])).toBe(true);
  });
});

describe('cutting (DW2b)', () => {
  const cutAt = (x: number) =>
    drawingSectionFrame(front, [
      [x, -5],
      [x, 25],
    ]);

  it('cuts a box: one hatched region, the outline on the plane, the box still centred', () => {
    const { frame, cut } = cutAt(30);
    const r = drawingProject([box(60, 40, 20)], frame, {
      step: 0.5,
      hidden: false,
      centers: false,
      cut,
    });
    expect(r.cuts).toHaveLength(1);
    const loop = r.cuts[0]!.loops.flat();
    expect(Math.min(...loop.map((p) => p[0]))).toBeCloseTo(-40);
    expect(Math.max(...loop.map((p) => p[0]))).toBeCloseTo(0);
    expect(Math.min(...loop.map((p) => p[1]))).toBeCloseTo(0);
    expect(Math.max(...loop.map((p) => p[1]))).toBeCloseTo(20);
    // The back face's edges lie under the outline: only the cut outline is drawn.
    expect(r.lines.length).toBeGreaterThan(0);
    expect(r.lines.every((l) => l.anchor.kind === 'section')).toBe(true);
    expect(r.bounds).toEqual([
      [-40, 0],
      [0, 20],
    ]);
  });

  it('cuts a sheet as lines only: no filled face, nothing hidden by it (Codex on #1278)', () => {
    const { frame, cut } = cutAt(30);
    const at = (b: ReturnType<typeof box>, id: string, d: number[]) => ({
      ...b,
      bodyId: id,
      positions: Array.from(b.positions, (v, i) => v + d[i % 3]!),
      edges: b.edges.map((e) => ({ ...e, points: Array.from(e.points, (v, i) => v + d[i % 3]!) })),
    });
    // A closed shell across the plane (a sheet body, or a solid), and a small box inside it.
    const shell = at(box(20, 20, 20), 'shell', [25, 10, 2]);
    const core = at(box(4, 4, 4), 'core', [33, 18, 8]);
    const project = (sheet: boolean) =>
      drawingProject([{ ...shell, ...(sheet ? { sheet } : {}) }, core], frame, {
        step: 0.25,
        hidden: false,
        centers: false,
        cut,
      });
    const solid = project(false);
    const sheet = project(true);
    expect(solid.cuts.map((c) => c.bodyId)).toEqual(['shell']);
    expect(sheet.cuts).toEqual([]);
    // Its cut lines stay; the box inside, which the solid's filled face hides, is seen.
    const cutLines = (r: typeof solid) =>
      r.lines.filter((l) => l.anchor.kind === 'section' && l.anchor.bodyId === 'shell').length;
    expect(cutLines(sheet)).toBe(cutLines(solid));
    expect(cutLines(sheet)).toBeGreaterThan(0);
    const seen = (r: typeof solid) => r.lines.filter((l) => l.anchor.bodyId === 'core').length;
    expect(seen(solid)).toBe(0);
    expect(seen(sheet)).toBeGreaterThan(0);
  });

  it('joins the cut of a long thin wall by the mesh, not by distance (Codex on #1207)', () => {
    const { frame, cut } = cutAt(30_000);
    const r = drawingProject([box(60_000, 40, 1)], frame, {
      step: 0.05,
      hidden: false,
      centers: false,
      cut,
    });
    expect(r.cuts).toHaveLength(1);
    const loops = r.cuts[0]!.loops;
    expect(loops).toHaveLength(1);
    const area = (l: [number, number][]) =>
      Math.abs(
        l.reduce(
          (a, p, i) => a + p[0] * l[(i + 1) % l.length]![1] - l[(i + 1) % l.length]![0] * p[1],
          0,
        ),
      ) / 2;
    expect(area(loops[0]!)).toBeCloseTo(40, 6);
  });

  it('hides what lies in the cut material behind the plane (the cut face is solid)', () => {
    const { frame, cut } = cutAt(30);
    const inner = { ...box(10, 10, 5, [40, 10, 5]), bodyId: 'inner', path: ['in'] };
    const shown = (hidden: boolean) =>
      drawingProject([box(60, 40, 20), inner], frame, {
        step: 0.25,
        hidden,
        centers: false,
        cut,
      }).lines.filter((l) => l.anchor.bodyId === 'inner' && l.anchor.kind === 'edge');
    expect(shown(false)).toEqual([]);
    const hidden = shown(true);
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.every((l) => l.hidden)).toBe(true);
  });

  it('takes the material on the viewer side away: a box beyond the plane is seen whole', () => {
    const { frame, cut } = cutAt(30);
    const before = { ...box(10, 10, 10, [0, 50, 0]), bodyId: 'gone', path: ['g'] };
    const after = { ...box(10, 10, 10, [40, 50, 0]), bodyId: 'kept', path: ['k'] };
    const r = drawingProject([before, after], frame, {
      step: 0.5,
      hidden: false,
      centers: false,
      cut,
    });
    expect(r.lines.some((l) => l.anchor.bodyId === 'gone')).toBe(false);
    expect(r.lines.filter((l) => l.anchor.bodyId === 'kept' && !l.hidden).length).toBe(4);
    expect(r.cuts).toEqual([]);
  });

  it('cuts a cylinder through its axis and keeps its centre line', () => {
    const { frame, cut } = cutAt(0);
    const r = drawingProject([cylinder(10, 30)], frame, {
      step: 0.5,
      hidden: false,
      centers: true,
      cut,
    });
    expect(r.cuts).toHaveLength(1);
    const xs = r.cuts[0]!.loops.flat().map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(-10);
    expect(Math.max(...xs)).toBeCloseTo(10);
    expect(r.centers).toHaveLength(1);
    expect(r.centers[0]!.anchor.kind).toBe('axis');
  });
});

describe('section and detail graphics (DW2b)', () => {
  it('hatches neighbouring bodies differently and keeps hatching inside the cut', () => {
    const { frame, cut } = drawingSectionFrame(front, [
      [30, -5],
      [30, 25],
    ]);
    const second = { ...box(60, 40, 20, [0, 40, 0]), bodyId: 'b2', path: ['p2'] };
    const r = drawingProject([box(60, 40, 20), second], frame, {
      step: 0.5,
      hidden: false,
      centers: false,
      cut,
    });
    const g = drawingCadViewGraphics({ at: [200, 150], scale: '1:1' }, r);
    const hatches = g.items.filter((i) => i.type === 'segments' && i.cls === 'hatch');
    expect(hatches).toHaveLength(2);
    const slope = (i: (typeof hatches)[number]) => {
      if (i.type !== 'segments') throw new Error('kind');
      const [x0, y0, x1, y1] = i.points as [number, number, number, number];
      return Math.sign((y1 - y0) / (x1 - x0));
    };
    expect(slope(hatches[0]!)).not.toBe(slope(hatches[1]!));
    // The paper box of the two cuts (80 × 20 mm at 1:1 around the view's centre).
    for (const h of hatches)
      if (h.type === 'segments')
        for (let i = 0; i < h.points.length; i += 2) {
          expect(Math.abs(h.points[i]! - 200)).toBeLessThanOrEqual(40 + 1e-6);
          expect(Math.abs(h.points[i + 1]! - 150)).toBeLessThanOrEqual(10 + 1e-6);
        }
    expect(g.frame).toEqual({
      center: [-40, 10],
      origin: [200, 150],
      scale: 1,
      box: r.bounds,
      depth: r.depth,
      axes: r.axes,
    });
  });

  it('draws a detail: only what lies in its circle, at its scale, around its own centre', () => {
    const r = drawingProject([box(60, 40, 20)], 'front', {
      step: 0.05,
      hidden: false,
      centers: false,
      window: [
        [-6, -6],
        [6, 6],
      ],
    });
    const g = drawingCadViewGraphics({ at: [300, 100], scale: '5:1' }, r, {
      center: [0, 0],
      radius: 5,
    });
    expect(g.bounds).toEqual([
      [275, 75],
      [325, 125],
    ]);
    expect(g.lines.length).toBe(2);
    for (const l of g.lines)
      for (const p of l.points)
        expect(Math.hypot(p[0] - 300, p[1] - 100)).toBeLessThanOrEqual(25 + 1e-6);
    expect(g.items.some((i) => i.type === 'circle' && i.radius === 25)).toBe(true);
    // The edges off the window (x = 60, z = 20) were never tested for visibility.
    expect(r.lines.some((l) => l.points.every((p) => p[0] > 59 || p[1] > 19))).toBe(false);
  });

  it('samples only the part of a long edge over a detail’s window (Codex on #1207)', () => {
    const r = drawingProject([box(60_000, 40, 20)], 'front', {
      step: 0.0125,
      hidden: false,
      centers: false,
      window: [
        [-5, -5],
        [5, 5],
      ],
    });
    // The two edges at the corner, each cut to the window.
    expect(r.lines).toHaveLength(2);
    for (const l of r.lines)
      for (const p of l.points)
        expect(Math.max(Math.abs(p[0]), Math.abs(p[1]))).toBeLessThanOrEqual(5 + 1e-9);
  });

  it('hatches a small detail of a large section (Codex on #1207)', () => {
    const { frame, cut } = drawingSectionFrame(front, [
      [500, -10],
      [500, 1010],
    ]);
    const r = drawingProject([box(1000, 1000, 1000)], frame, {
      step: 0.005,
      hidden: false,
      centers: false,
      cut,
      window: [
        [-501, 499],
        [-499, 501],
      ],
    });
    const g = drawingCadViewGraphics({ at: [200, 150], scale: '50:1' }, r, {
      center: [-500, 500],
      radius: 0.5,
    });
    const hatches = g.items.filter((i) => i.type === 'segments' && i.cls === 'hatch');
    expect(hatches).toHaveLength(1);
    if (hatches[0]!.type === 'segments') expect(hatches[0]!.points.length).toBeGreaterThan(20);
  });

  it('clips polylines to a circle and hatches a square', () => {
    expect(
      clipToCircle(
        [
          [-10, 0],
          [10, 0],
        ],
        [0, 0],
        5,
      ),
    ).toEqual([
      [
        [-5, 0],
        [5, 0],
      ],
    ]);
    const lines = hatch(
      [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
      ],
      45,
      2.5,
    );
    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const [a, b] of lines) {
      for (const p of [a, b]) {
        expect(p[0]).toBeGreaterThanOrEqual(-1e-9);
        expect(p[0]).toBeLessThanOrEqual(10 + 1e-9);
      }
      expect((b[1] - a[1]) / (b[0] - a[0])).toBeCloseTo(1);
    }
  });
});

const source: DrawingSource = {
  id: 'src-1',
  kind: 'cad',
  artifactId: 'part',
  versionId: 'v1',
  contentHash: 'h1',
  name: 'Part',
};
const projection: DrawingCadView = {
  id: 'view-1',
  kind: 'cad-projection',
  sheetId: 'sheet-1',
  sourceId: 'src-1',
  name: '正面図',
  at: [120, 150],
  scale: '1:1',
  label: true,
  direction: 'front',
  only: [],
  hiddenLines: true,
  centerLines: true,
};
const section: DrawingCadSection = {
  id: 'view-2',
  kind: 'cad-section',
  sheetId: 'sheet-1',
  sourceId: 'src-1',
  parentId: 'view-1',
  name: '断面 A–A',
  at: [250, 150],
  scale: '1:1',
  label: true,
  line: [
    [30, -8],
    [30, 28],
  ],
  mark: 'A',
  hiddenLines: false,
  centerLines: true,
};
const detail: DrawingCadDetail = {
  id: 'view-3',
  kind: 'cad-detail',
  sheetId: 'sheet-1',
  sourceId: 'src-1',
  parentId: 'view-2',
  name: '詳細 B',
  at: [300, 60],
  scale: '5:1',
  label: true,
  center: [0, 0],
  radius: 5,
  mark: 'B',
};
const doc = () =>
  [projection, section, detail].reduce(
    (d, v) => addDrawingView(d, v),
    useDrawingSource(drawingStarter(), source).doc,
  );

describe('section and detail content (DW2b)', () => {
  it('is valid content, and refuses wrong parents, marks and lines', () => {
    expect(validateDrawing(doc())).toEqual([]);
    const bad = (patch: (d: ReturnType<typeof doc>) => void) => {
      const d = doc();
      patch(d);
      return validateDrawing(d).map((x) => x.code);
    };
    expect(bad((d) => ((d.views[0] as DrawingCadView).direction = 'iso'))).toContain(
      'view-parent-kind',
    );
    expect(bad((d) => ((d.views[2] as DrawingCadDetail).parentId = 'view-3'))).toContain(
      'view-parent',
    );
    expect(bad((d) => ((d.views[2] as DrawingCadDetail).mark = 'A'))).toContain('mark-duplicate');
    expect(bad((d) => ((d.views[1] as DrawingCadSection).mark = 'I'))).toContain('mark');
    expect(
      bad(
        (d) =>
          ((d.views[1] as DrawingCadSection).line = [
            [1, 1],
            [1, 1],
          ]),
      ),
    ).toContain('section-line');
    expect(
      bad((d) => {
        d.sources.push({ ...source, id: 'src-2', versionId: 'v2', contentHash: 'h2' });
        d.views[1]!.sourceId = 'src-2';
      }),
    ).toContain('view-parent-source');
  });

  it('takes a view’s sections and details (and theirs) with it when it is deleted', () => {
    const d = deleteDrawingItems(doc(), ['view-1']);
    expect(d.views).toEqual([]);
    expect(d.sources).toEqual([]);
    expect(deleteDrawingItems(doc(), ['view-2']).views.map((v) => v.id)).toEqual(['view-1']);
  });

  it('gives the next free mark, leaving out I, O and Q', () => {
    expect(nextDrawingMark(doc())).toBe('C');
    const d = doc();
    (d.views[1] as DrawingCadSection).mark = 'H';
    (d.views[2] as DrawingCadDetail).mark = 'J';
    expect(nextDrawingMark(d)).toBe('A');
    expect(nextDrawingMark({ ...d, views: d.views.slice(0, 1) })).toBe('A');
  });

  it('derives a detail of a section from the section’s cut, in the parent’s plane', () => {
    const spec = drawingViewSpec(doc(), detail);
    if ('code' in spec) throw new Error(spec.code);
    expect(spec.cut).toBeDefined();
    expect(spec.clip).toEqual({ center: [0, 0], radius: 5 });
    expect(near(spec.frame.direction, [1, 0, 0])).toBe(true);
  });

  it('switches every view of a source to a newer version as one edit', () => {
    const next = switchDrawingSource(doc(), 'src-1', {
      versionId: 'v2',
      contentHash: 'h2',
      name: 'Part',
    });
    expect(next.sources).toEqual([{ ...source, versionId: 'v2', contentHash: 'h2' }]);
    expect(() =>
      switchDrawingSource(next, 'src-1', { ...source, versionId: 'v2', contentHash: 'h2' }),
    ).toThrow(DrawingEditError);
    // Another source already sees that version: its views join it.
    const twin = structuredClone(doc());
    twin.sources.push({ ...source, id: 'src-2', versionId: 'v2', contentHash: 'h2' });
    twin.views.push({ ...projection, id: 'view-9', sourceId: 'src-2' });
    const merged = switchDrawingSource(twin, 'src-1', {
      versionId: 'v2',
      contentHash: 'h2',
      name: 'Part',
    });
    expect(merged.sources.map((s) => s.id)).toEqual(['src-2']);
    expect(new Set(merged.views.map((v) => v.sourceId))).toEqual(new Set(['src-2']));
  });

  it('draws the cutting line and the detail circle on the parent', () => {
    const frame = {
      center: [30, 10] as [number, number],
      origin: [120, 150] as [number, number],
      scale: 1,
      box: [
        [0, 0],
        [60, 20],
      ] as [[number, number], [number, number]],
      depth: [-40, 0] as [number, number],
      axes: front,
    };
    const items = drawingParentSymbol(section, frame);
    expect(items.filter((i) => i.type === 'line' && i.cls === 'center')).toHaveLength(1);
    expect(items.filter((i) => i.type === 'line' && i.cls === 'cut')).toHaveLength(2);
    expect(items.filter((i) => i.type === 'polyline' && i.fill)).toHaveLength(2);
    expect(items.filter((i) => i.type === 'text' && i.text === 'A')).toHaveLength(2);
    // The arrows point the way it is seen: +x on the paper.
    for (const i of items) if (i.type === 'polyline') expect(i.points[0]![0]).toBeGreaterThan(120);
    const circle = drawingParentSymbol({ ...detail, parentId: 'view-1' }, frame);
    expect(circle[0]).toEqual({ type: 'circle', center: [90, 140], radius: 5, cls: 'thin' });
    // On the sheet: drawn with the parent's derived frame only.
    const svg = drawingSheetSvg(
      doc(),
      doc().sheets[0]!,
      new Map([
        [
          'view-1',
          {
            status: 'ready',
            graphics: {
              items: [],
              bounds: [
                [90, 140],
                [150, 160],
              ],
              frame,
            },
          },
        ],
      ]),
    );
    expect(svg).toContain('class="cut"');
    expect(svg).toContain('class="dot"');
  });
});
