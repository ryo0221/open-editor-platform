import { describe, expect, it } from 'vitest';
import {
  bimBoxSide,
  bimCutClass,
  bimCutLoops,
  bimDrawingBounds,
  bimDrawingLimits,
  bimDrawingPrimitives,
  bimDrawingSvg,
  bimDrawingSymbols,
  bimDrawnByKernel,
  bimElementBox,
  bimLocalPlane,
  bimOutsideFrame,
  bimPlacedPoint,
  bimPlaneInRange,
  bimViewFrame,
  type BimDrawing,
} from './drawing';
import { bimContentHash } from './operations';
import { deriveBim } from './derive';
import { f31BoxBuilding, f39Roofs } from './fixtures';
import type { BimView } from './model';

/** The pure half of R2c-5: view frames, symbols and annotations by rule, cut loops and SVG. */
const plan: BimView = {
  id: 'v-1f',
  kind: 'plan',
  name: '1F plan',
  level: 'l-1f',
  cutHeightMm: 1200,
  depthMm: 1200,
  scale: 100,
};
const section = (direction: 'left' | 'right'): Extract<BimView, { kind: 'section' }> => ({
  id: 'v-x',
  kind: 'section',
  name: 'X',
  line: [
    [5000, -1000],
    [5000, 9000],
  ],
  direction,
  depthMm: 20000,
  scale: 50,
});

describe('bim drawings, pure (R2c-5)', () => {
  it('cuts a plan above its level and a section across its line, as the kernel projects', () => {
    const doc = f31BoxBuilding();
    const p = bimViewFrame(doc, plan);
    expect(p.cut).toEqual({ origin: [0, 0, 1200], normal: [0, 0, 1] });
    expect(p.keep.map((k) => [k.origin[2], k.keep])).toEqual([
      [1200, 'below'],
      [0, 'above'],
    ]);
    expect(p.toView([3, 4, 5])).toEqual([3, 4]);
    // Looking left (−x) along +y the drawing's x runs along the line; looking right, against it.
    const l = bimViewFrame(doc, section('left'));
    expect(l.direction).toEqual([-1, 0, 0]);
    expect(l.toView([5000, 2000, 700])).toEqual([2000, 700]);
    expect(l.keep[1]!.origin).toEqual([-15000, -1000, 0]);
    const r = bimViewFrame(doc, section('right'));
    expect(r.toView([5000, 2000, 700])).toEqual([-2000, 700]);
    expect(bimDrawnByKernel(plan, 'door')).toBe(false);
    expect(bimDrawnByKernel(section('left'), 'door')).toBe(true);
    expect(bimDrawnByKernel(section('left'), 'space')).toBe(false);
    expect(bimCutClass(doc, 'w-south')).toBe('cut cut-wall m-concrete');
  });

  it('draws doors, windows and spaces of the cut level only, and leaves the document alone', () => {
    const doc = f31BoxBuilding();
    const hash = bimContentHash(doc);
    const items = bimDrawingSymbols(doc, plan);
    expect(bimContentHash(doc)).toBe(hash);
    const swing = items.find((i) => i.type === 'arc')!;
    // The entrance (2,000–2,900 mm along the south wall) turns on its start into the hall.
    expect(swing).toMatchObject({ center: [2000, 100], radius: 900 });
    if (swing.type !== 'arc') throw new Error();
    expect(swing.start).toBeCloseTo(0);
    expect(swing.end).toBeCloseTo(Math.PI / 2);
    expect(items.filter((i) => i.type === 'line' && i.cls === 'window-mark')).toHaveLength(12);
    // A label beside the east wall reads away from it (towards −x: anchored at its end).
    const east = items.find((i) => i.type === 'text' && i.id === 'win-e1');
    expect(east).toMatchObject({ anchor: 'end' });
    // Above the walls (RF): no doors or windows there. On 2F (4,200 mm) the walls are cut, but
    // the door ends at 2,100 mm and the windows at 2,400 mm: none of them is there either.
    const opening = (i: { cls: string }) =>
      ['door-leaf', 'door-swing', 'window-mark', 'type-mark'].includes(i.cls);
    const rf = bimDrawingSymbols(doc, { ...plan, level: 'l-rf' });
    expect(rf.filter(opening)).toEqual([]);
    expect(bimDrawingSymbols(doc, { ...plan, level: 'l-2f' }).filter(opening)).toEqual([]);
  });

  it('boxes elements and tells which side of a plane a box lies on, within 1 mm', () => {
    const doc = f31BoxBuilding();
    const derived = deriveBim(doc);
    // The south wall, 200 mm thick on its axis, from 1F to RF.
    expect(bimElementBox(doc, derived, 'w-south')).toEqual([
      [-100, -100, 0],
      [10100, 100, 6000],
    ]);
    const box = bimElementBox(doc, derived, 'w-south')!;
    const at = (z: number) => ({
      origin: [0, 0, z] as [number, number, number],
      normal: [0, 0, 1] as [number, number, number],
    });
    expect(bimBoxSide(at(-2), box)).toBe('above');
    expect(bimBoxSide(at(-0.5), box)).toBe('both');
    expect(bimBoxSide(at(6000.5), box)).toBe('both');
    expect(bimBoxSide(at(6002), box)).toBe('below');
    // A plan of 2F keeps 3,000–4,200 mm; the wall crosses it, the roof lies wholly above.
    const frame = bimViewFrame(doc, { ...plan, level: 'l-2f' });
    expect(bimOutsideFrame(frame, box)).toBe(false);
    expect(bimOutsideFrame(frame, bimElementBox(doc, derived, 'r-roof')!)).toBe(true);
  });

  it('leaves out the symbols of an opening the roof has clipped its wall away from', () => {
    const doc = f39Roofs('gable');
    const win = doc.elements.find((e) => e.id === 'win-n2')!;
    if (win.kind !== 'window') throw new Error();
    const marks = (sill: number) => {
      win.sillMm = sill;
      return bimDrawingSymbols(doc, { ...plan, level: 'l-1f', cutHeightMm: sill + 500 }).filter(
        (i) => 'id' in i && i.id === 'win-n2',
      );
    };
    // At 7,000 mm the north wall is gone under the roof: no window marks, no label.
    expect(marks(6500)).toEqual([]);
    // Lower, where the wall still stands under the roof, the window is drawn.
    expect(marks(5000).length).toBeGreaterThan(0);
  });

  it('swings a door in an arc wall from jamb to jamb on the face it opens to', () => {
    const doc = f31BoxBuilding();
    const south = doc.elements.find((e) => e.id === 'w-south')!;
    const door = doc.elements.find((e) => e.kind === 'door')!;
    doc.elements.push(
      {
        ...structuredClone(south),
        id: 'w-arc',
        start: { xy: [20000, 0] },
        end: { xy: [24000, 0] },
        bulge: 1,
      } as typeof south,
      { ...structuredClone(door), id: 'd-arc', hostId: 'w-arc', alongMm: 1000 } as typeof door,
    );
    const items = bimDrawingSymbols(doc, plan).filter((i) => 'id' in i && i.id === 'd-arc');
    const leaf = items.find((i) => i.type === 'line' && i.cls === 'door-leaf');
    const swing = items.find((i) => i.type === 'arc' && i.cls === 'door-swing');
    if (leaf?.type !== 'line' || swing?.type !== 'arc') throw new Error('no door symbol');
    // The closed end of the swing is on the other jamb: the radius is the chord, not 900 mm.
    expect(swing.radius).toBeLessThan(900);
    expect(Math.hypot(leaf.b[0] - leaf.a[0], leaf.b[1] - leaf.a[1])).toBeCloseTo(swing.radius, 9);
  });

  it("shows a space's floor area unsigned, whichever way its boundary runs", () => {
    const doc = f31BoxBuilding();
    const hall = doc.elements.find((e) => e.id === 'sp-hall')!;
    if (hall.kind !== 'space') throw new Error();
    hall.boundary = [...hall.boundary].reverse();
    const area = bimDrawingSymbols(doc, plan).find(
      (i) => i.type === 'text' && i.cls === 'space-area',
    );
    expect(area).toMatchObject({ text: '76.44 m²' });
  });

  it('labels a concave room inside it, not at a centroid in the next room', () => {
    const doc = f31BoxBuilding();
    const hall = doc.elements.find((e) => e.id === 'sp-hall')!;
    if (hall.kind !== 'space') throw new Error();
    hall.boundary = [
      [100, 100],
      [9900, 100],
      [9900, 1900],
      [1900, 1900],
      [1900, 7900],
      [100, 7900],
    ];
    const name = bimDrawingSymbols(doc, plan).find(
      (i) => i.type === 'text' && i.cls === 'space-name' && i.id === 'sp-hall',
    );
    if (name?.type !== 'text') throw new Error('no label');
    // The centroid (about 3,481, 2,481) is outside; the label sits in the west wing's run.
    expect(name.at[0]).toBeCloseTo(1000, 6);
    expect(name.at[1]).toBeGreaterThan(1900);
  });

  it('refuses to write an SVG past its byte limit', () => {
    const d: BimDrawing = {
      viewId: 'v',
      kind: 'plan',
      name: 'v',
      scale: 100,
      // Escaping makes each "&" five bytes.
      items: [
        {
          type: 'text',
          at: [0, 0],
          text: '&'.repeat(bimDrawingLimits.svgBytes / 4),
          anchor: 'start',
          cls: 'label',
        },
      ],
      failed: [],
    };
    expect(() => bimDrawingSvg(d)).toThrow('drawing-too-large');
  });

  it('moves a plane into the coordinate limit along itself, or past every point it allows', () => {
    // On the plane x = 1,018,000 no point is within the limit: moved to x = 1,000,000, which
    // leaves every shape within the limit on the same side.
    expect(bimPlaneInRange({ origin: [1018000, -1000, 0], normal: [1, 0, 0] }).origin).toEqual([
      1000000, 0, 0,
    ]);
    // An oblique plane within reach is moved onto a point inside the limit, still on the plane.
    const n: [number, number, number] = [Math.SQRT1_2, Math.SQRT1_2, 0];
    const moved = bimPlaneInRange({ origin: [1200000, 100000, 0], normal: n });
    expect(moved.origin.every((c) => Math.abs(c) <= 1000000)).toBe(true);
    expect(moved.origin[0] * n[0] + moved.origin[1] * n[1]).toBeCloseTo(1300000 * Math.SQRT1_2, 4);
    // In a placed solid's frame, the same plane is near: a part 999,000 mm along x sees the far
    // plane 19,000 mm along its own x.
    const placement = {
      rotation: [0, -1, 0, 1, 0, 0, 0, 0, 1],
      translation: [999000, 0, 0] as [number, number, number],
    };
    const local = bimLocalPlane({ origin: [1018000, -1000, 0], normal: [1, 0, 0] }, placement);
    expect(local.origin.map((c) => c + 0)).toEqual([-1000, -19000, 0]);
    expect(local.normal.map((c) => c + 0)).toEqual([0, -1, 0]);
    expect(bimPlacedPoint(local.origin, placement)).toEqual([1018000, -1000, 0]);
  });

  it('draws a window in an arc wall on the wall faces, about its centre', () => {
    // A 200 mm wall on a half circle of 2,000 mm radius, a 1,800 mm window 1,000 mm along it.
    const doc = f31BoxBuilding();
    const south = doc.elements.find((e) => e.id === 'w-south')!;
    doc.elements.push(
      {
        ...structuredClone(south),
        id: 'w-arc',
        start: { xy: [20000, 0] },
        end: { xy: [24000, 0] },
        bulge: 1,
      } as typeof south,
      {
        id: 'win-arc',
        kind: 'window',
        typeId: 't-window-1800',
        hostId: 'w-arc',
        alongMm: 1000,
        sillMm: 900,
        flipFacing: false,
      },
    );
    const marks = bimDrawingSymbols(doc, plan).filter(
      (i) => i.cls === 'window-mark' && 'id' in i && i.id === 'win-arc',
    );
    expect(marks.map((m) => m.type)).toEqual(['arc', 'arc', 'arc']);
    for (const m of marks) {
      if (m.type !== 'arc') throw new Error();
      expect(m.center[0]).toBeCloseTo(22000, 6);
      expect(m.center[1]).toBeCloseTo(0, 6);
      // Its angle is the window's 1,800 mm along the 2,000 mm axis.
      expect(m.end - m.start).toBeCloseTo(1800 / 2000, 9);
    }
    expect(
      marks.map((m) => (m.type === 'arc' ? Math.round(m.radius * 1e6) / 1e6 : 0)).sort(),
    ).toEqual([1900, 2000, 2100]);
  });

  it('marks the levels and the axes a section crosses', () => {
    const doc = f31BoxBuilding();
    doc.grids = [
      { id: 'g-1', label: '1', start: [-1000, 0], end: [11000, 0] },
      { id: 'g-a', label: 'A', start: [0, -1000], end: [0, 9000] },
      // Past the line's end: not crossed.
      { id: 'g-x', label: 'X', start: [6000, 10000], end: [4000, 10000] },
    ];
    const items = bimDrawingSymbols(doc, section('left'));
    const labels = items.filter((i) => i.type === 'text').map((i) => (i as { text: string }).text);
    expect(labels).toEqual(['1F ±0', '2F +3000', 'RF +6000', '1']);
    const grid = items.find((i) => i.type === 'line' && i.cls === 'grid')!;
    expect(grid.type === 'line' && grid.a[0]).toBe(0);
  });

  it('dimensions parallel axes in the order they were sorted, whichever way each is drawn', () => {
    const doc = f31BoxBuilding();
    // The first axis in the document runs up; the one sorted first runs down.
    doc.grids = [
      { id: 'g-1', label: '1', start: [0, -1000], end: [0, 9000] },
      { id: 'g-2', label: '2', start: [6000, -1000], end: [6000, 9000] },
      { id: 'g-3', label: '3', start: [12000, 9000], end: [12000, -1000] },
    ];
    const dims = bimDrawingSymbols(doc, plan)
      .filter((i) => i.type === 'text' && i.cls === 'dimension-text')
      .map((i) => (i as { text: string }).text);
    expect(dims).toEqual(['6000', '6000']);
  });

  it('bounds text by its anchor, so long labels are not clipped', () => {
    const d = (anchor: 'start' | 'middle' | 'end'): BimDrawing => ({
      viewId: 'v',
      kind: 'plan',
      name: 'v',
      scale: 100,
      items: [{ type: 'text', at: [0, 0], text: 'x'.repeat(20), anchor, cls: 'label' }],
      failed: [],
    });
    // 20 characters at 2.5 mm × 100, 0.7 em each: 3,500 mm wide, 150 mm up and down.
    expect(bimDrawingBounds(d('start'))).toEqual([
      [0, -150],
      [3500, 150],
    ]);
    expect(bimDrawingBounds(d('end'))).toEqual([
      [-3500, -150],
      [0, 150],
    ]);
    expect(bimDrawingBounds(d('middle'))).toEqual([
      [-1750, -150],
      [1750, 150],
    ]);
  });

  it('joins cut edges into loops whatever their order and direction', () => {
    const e = (...pts: number[][]) => new Float64Array(pts.flat());
    // A 2 × 1 rectangle at z = 5 in four edges, two reversed, out of order; and a lone open edge.
    const loops = bimCutLoops(
      [
        e([2, 0, 5], [2, 1, 5]),
        e([0, 0, 5], [2, 0, 5]),
        e([0, 0, 5], [0, 1, 5]),
        e([0, 1, 5], [1, 1, 5], [2, 1, 5]),
        e([9, 9, 5], [9, 8, 5]),
      ],
      (p) => [p[0], p[1]],
    );
    expect(loops.loops).toHaveLength(1);
    expect(loops.loops[0]).toHaveLength(5);
    expect(loops.open).toEqual([
      [
        [9, 9],
        [9, 8],
      ],
    ]);
  });

  it('joins ends that straddle a rounding boundary within 0.01 mm', () => {
    const e = (...pts: number[][]) => new Float64Array(pts.flat());
    // The right side's ends are 0.000002 mm apart, either side of 100.005.
    const loops = bimCutLoops(
      [
        e([0, 0, 0], [100.004999, 0, 0]),
        e([100.005001, 0, 0], [100.005001, 50, 0]),
        e([100.004999, 50, 0], [0, 50, 0]),
        e([0, 50, 0], [0, 0, 0]),
      ],
      (p) => [p[0], p[1]],
    );
    expect(loops.loops).toHaveLength(1);
    expect(loops.loops[0]).toHaveLength(4);
    expect(loops.open).toEqual([]);
  });

  it("draws an open cut (a sheet's) as lines, never closed and filled", () => {
    const e = (...pts: number[][]) => new Float64Array(pts.flat());
    // An L-shaped sheet meets the plane in a bent open chain.
    const cut = bimCutLoops([e([0, 0, 0], [1000, 0, 0]), e([1000, 0, 0], [1000, 1000, 0])], (p) => [
      p[0],
      p[1],
    ]);
    expect(cut.loops).toEqual([]);
    expect(cut.open).toEqual([
      [
        [0, 0],
        [1000, 0],
        [1000, 1000],
      ],
    ]);
    const svg = bimDrawingSvg({
      viewId: 'v',
      kind: 'plan',
      name: 'v',
      scale: 100,
      items: [{ type: 'polygon', loops: [], open: cut.open, cls: 'cut m-metal', id: 'p-1' }],
      failed: [],
    });
    expect(svg).toContain(
      '<path class="cut m-metal cut-open" data-id="p-1" d="M0 0L1000 0L1000 -1000"/>',
    );
    expect(svg).not.toContain('Z"');
    expect(svg).toContain('.cut.cut-open{fill:none}');
  });

  it('bounds an arc by its sweep, not its whole circle', () => {
    const d: BimDrawing = {
      viewId: 'v',
      kind: 'plan',
      name: 'v',
      scale: 100,
      // A shallow arc of radius 100,000 about (0, -100,000), through (0, 0).
      items: [
        {
          type: 'arc',
          center: [0, -100000],
          radius: 100000,
          start: Math.PI / 2 - 0.009,
          end: Math.PI / 2 + 0.009,
          cls: 'window-mark',
        },
      ],
      failed: [],
    };
    const [lo, hi] = bimDrawingBounds(d)!;
    expect(hi[1]).toBeCloseTo(0, 6);
    expect(lo[1]).toBeGreaterThan(-5);
    expect(hi[0] - lo[0]).toBeCloseTo(2 * 100000 * Math.sin(0.009), 6);
    // An arc across a quarter point reaches it.
    const across = bimDrawingBounds({
      ...d,
      items: [{ ...d.items[0]!, center: [0, 0], radius: 10, start: -0.5, end: 0.5 } as never],
    })!;
    expect(across[1][0]).toBeCloseTo(10, 9);
  });

  it('shows the whole list of what was not drawn inside the page', () => {
    const failed = Array.from({ length: 10 }, (_, i) => ({
      id: `part-${i}`,
      code: 'asset-missing',
    }));
    const svg = bimDrawingSvg({
      viewId: 'v',
      kind: 'plan',
      name: 'v',
      scale: 100,
      items: [],
      failed,
    });
    const texts = [
      ...svg.matchAll(/<text class="failed" x="([-\d.]+)" y="([-\d.]+)"[^>]*>([^<]*)</g),
    ];
    expect(texts.map((t) => t[3])).toEqual([
      'Not drawn:',
      ...failed.map((f) => `${f.id} (${f.code})`),
    ]);
    const [vx, vy, vw, vh] = /viewBox="([^"]+)"/.exec(svg)![1]!.split(' ').map(Number);
    for (const t of texts) {
      const [x, y] = [Number(t[1]), Number(t[2])];
      // Its whole width (0.7 em a character at 2.5 mm × 100) and its line fit in the view box.
      expect(x).toBeGreaterThanOrEqual(vx!);
      expect(x + t[3]!.length * 250 * 0.7).toBeLessThanOrEqual(vx! + vw!);
      expect(y).toBeGreaterThanOrEqual(vy!);
      expect(y).toBeLessThanOrEqual(vy! + vh!);
    }
  });

  it('writes the same SVG for the same drawing, escaped, with failures listed', () => {
    const d: BimDrawing = {
      viewId: 'v<1>',
      kind: 'plan',
      name: 'A & B',
      scale: 200,
      items: [
        {
          type: 'polygon',
          id: 'w',
          cls: 'cut cut-wall',
          loops: [
            [
              [0, 0],
              [100, 0],
              [100, 50],
            ],
          ],
        },
        { type: 'segments', cls: 'seen', points: [0, 0, 10, 10, 20, 20, 30, 30] },
        { type: 'arc', center: [0, 0], radius: 10, start: 0, end: Math.PI / 2, cls: 'door-swing' },
        { type: 'text', at: [5, 5], text: '<x>', anchor: 'middle', cls: 'label' },
      ],
      failed: [{ id: 'p-1', code: 'asset-missing' }],
    };
    expect(bimDrawingPrimitives(d)).toBe(3 + 2 + 1 + 1);
    // Text counts by a conservative width (3 characters at 2.5 mm × 200), centred.
    expect(bimDrawingBounds(d)![0]).toEqual([-520, -295]);
    const svg = bimDrawingSvg(d);
    expect(svg).toBe(bimDrawingSvg(structuredClone(d)));
    expect(svg).toContain('data-view="v&lt;1&gt;"');
    expect(svg).toContain('<title>A &amp; B 1:200</title>');
    expect(svg).toContain('>&lt;x&gt;</text>');
    // y is flipped once: (100, 50) is written (100, -50); the quarter arc ends at (0, -10).
    expect(svg).toContain('M0 0L100 0L100 -50Z');
    expect(svg).toContain('A10 10 0 0 0 0 -10');
    expect(svg).toContain('>Not drawn:</text>');
    expect(svg).toContain('>p-1 (asset-missing)</text>');
  });
});
