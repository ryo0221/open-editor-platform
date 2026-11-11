import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  bimContentHash,
  bimDrawingSvg,
  bimElementBox,
  deriveBim,
  f31BoxBuilding,
  f33Types,
  f37Office,
  f39Roofs,
  f40Lattice,
  f47Taper,
  f48Ramp,
  f50Lean,
  f51Ramps,
  f52LeanOpenings,
  f54LeanJoins,
  f54LeanRoofs,
  f55RampOpenings,
  f55Stairs,
  loopArea,
  type BimDocument,
  type BimDrawing,
  type BimView,
} from '@editor-platform/bim-core';
import type { OcModule } from '@editor-platform/geometry-kernel-occt';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { BimDrawings, drawBim } from './drawing';
import { bimDirectKernel, BimEvaluator, type BimKernel } from './evaluate';
import { bimKernelLimits } from './port';

/** CAD68 (F36): plans and sections of F31 against the development build (`CAD_OCCT_DIST`). */
const dist = process.env.CAD_OCCT_DIST;
const plan: BimView = {
  id: 'v-1f',
  kind: 'plan',
  name: '1F plan',
  level: 'l-1f',
  cutHeightMm: 1200,
  depthMm: 1200,
  scale: 100,
};
const section: BimView = {
  id: 'v-x',
  kind: 'section',
  name: 'Section X',
  line: [
    [5000, -1000],
    [5000, 9000],
  ],
  direction: 'left',
  depthMm: 20000,
  scale: 100,
};
/** F31 with two axes each way, 10,000 and 8,000 mm apart. */
function f36(): BimDocument {
  const doc = f31BoxBuilding();
  doc.grids = [
    { id: 'g-a', label: 'A', start: [0, -1000], end: [0, 9000] },
    { id: 'g-b', label: 'B', start: [10000, -1000], end: [10000, 9000] },
    { id: 'g-1', label: '1', start: [-1000, 0], end: [11000, 0] },
    { id: 'g-2', label: '2', start: [-1000, 8000], end: [11000, 8000] },
  ];
  doc.views = [plan, section];
  return doc;
}
const ofType = <T extends BimDrawing['items'][number]['type']>(d: BimDrawing, t: T) =>
  d.items.filter((i): i is Extract<BimDrawing['items'][number], { type: T }> => i.type === t);
const area = (loops: [number, number][][]) => loops.reduce((s, l) => s + Math.abs(loopArea(l)), 0);

describe.skipIf(!dist)('bim drawings (R2c-5, CAD68)', { timeout: 120_000 }, () => {
  let kernel: BimKernel;
  beforeAll(async () => {
    globalThis.require ??= createRequire(import.meta.url);
    const { default: factory } = await import(pathToFileURL(`${dist}/${cadKernelBuild.js}`).href);
    const oc: OcModule = await factory({
      wasmBinary: readFileSync(`${dist}/${cadKernelBuild.wasm}`),
    });
    kernel = bimDirectKernel(oc);
  }, 120_000);

  it('cuts the 1F walls at 1,200 mm, sees the floor, and draws doors, windows, grids and spaces', async () => {
    const doc = f36();
    const hash = bimContentHash(doc);
    const r = await drawBim(doc, plan, kernel);
    if (r.status !== 'ok') throw new Error(r.code);
    const d = r.drawing;
    expect(bimContentHash(doc)).toBe(hash);
    const cuts = ofType(d, 'polygon');
    expect(cuts.map((c) => c.id).sort()).toEqual(['w-east', 'w-north', 'w-south', 'w-west']);
    // The ring of 200 mm walls (10,200 × 8,200 outside) less the door and the four windows.
    const ring = 10_200 * 8_200 - 9_800 * 7_800;
    const openings = (900 + 4 * 1800) * 200;
    expect(area(cuts.flatMap((c) => c.loops))).toBeCloseTo(ring - openings, 0);
    expect(cuts.map((c) => [c.id, c.loops.length])).toEqual(
      expect.arrayContaining([
        ['w-west', 1],
        ['w-south', 2],
        ['w-east', 2],
        ['w-north', 4],
      ]),
    );
    expect(cuts.find((c) => c.id === 'w-south')!.cls).toBe('cut cut-wall m-concrete');
    // Below the cut: the floor slab's outline is seen.
    const seen = ofType(d, 'segments')[0]!.points;
    expect(seen.length).toBeGreaterThan(0);
    // Symbols by rule: the door's leaf and swing, three lines per window, the type marks.
    expect(ofType(d, 'arc').map((a) => [a.id, a.radius])).toEqual([['d-entrance', 900]]);
    expect(ofType(d, 'line').filter((l) => l.cls === 'window-mark')).toHaveLength(12);
    expect(ofType(d, 'text').filter((t) => t.cls === 'type-mark')).toHaveLength(5);
    expect(
      ofType(d, 'text')
        .filter((t) => t.cls.startsWith('space'))
        .map((t) => t.text),
    ).toEqual(['101 Hall', '76.44 m²']);
    // Grid lines with a bubble at each end, and the spacing between neighbouring axes.
    expect(ofType(d, 'line').filter((l) => l.cls === 'grid')).toHaveLength(4);
    expect(ofType(d, 'circle')).toHaveLength(8);
    expect(
      ofType(d, 'text')
        .filter((t) => t.cls === 'dimension-text')
        .map((t) => t.text)
        .sort(),
    ).toEqual(['10000', '8000']);
    expect(d.failed).toEqual([]);

    const svg = bimDrawingSvg(d);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('data-scale="1:100"');
    expect(svg.match(/class="cut cut-wall/g)).toHaveLength(4);
    // The same content draws the same bytes.
    const again = await drawBim(f36(), plan, kernel);
    expect(again.status === 'ok' && bimDrawingSvg(again.drawing)).toBe(svg);
  });

  it('cuts a section through the box and marks the levels and the axes it crosses', async () => {
    const doc = f36();
    const r = await drawBim(doc, section, kernel);
    if (r.status !== 'ok') throw new Error(r.code);
    const d = r.drawing;
    const cut = (id: string) => ofType(d, 'polygon').find((c) => c.id === id);
    // The south wall from 1F to RF, 200 mm thick; the north wall split by the middle window.
    expect(area(cut('w-south')!.loops)).toBeCloseTo(200 * 6000, 0);
    expect(cut('w-north')!.loops).toHaveLength(2);
    expect(cut('win-n2')).toBeDefined();
    expect(area(cut('s-2f')!.loops)).toBeCloseTo(200 * 7800, 0);
    expect(area(cut('r-roof')!.loops)).toBeCloseTo(200 * 8200, 0);
    // Looking left (−x) along +y: the drawing's x runs along the line, y is the height.
    const south = cut('w-south')!.loops.flat();
    expect(Math.min(...south.map((p) => p[0]))).toBeCloseTo(-100, 3);
    expect(Math.max(...south.map((p) => p[1]))).toBeCloseTo(6000, 3);
    expect(ofType(d, 'line').filter((l) => l.cls === 'level')).toHaveLength(3);
    expect(
      ofType(d, 'text')
        .filter((t) => t.cls === 'level-label')
        .map((t) => t.text),
    ).toEqual(['1F ±0', '2F +3000', 'RF +6000']);
    // Axes 1 and 2 cross the line; A and B run along it and do not.
    expect(
      ofType(d, 'text')
        .filter((t) => t.cls === 'grid-label')
        .map((t) => t.text),
    ).toEqual(['1', '2']);
    expect(ofType(d, 'segments')[0]!.points.length).toBeGreaterThan(0);
  });

  it('cuts and sees leaning columns, sloping beams and members (TW2, F40)', async () => {
    const doc = f40Lattice();
    const gl: BimView = { ...plan, id: 'v-gl', level: 'l-gl' };
    const p = await drawBim(doc, gl, kernel);
    if (p.status !== 'ok') throw new Error(p.code);
    // At 1,200 mm the plan cuts the column, the diagonal, the vertical and the grid member;
    // the horizontal member and the beam lie above the cut.
    expect(
      ofType(p.drawing, 'polygon')
        .map((c) => c.id)
        .sort(),
    ).toEqual(['c-lean', 'm-diag', 'm-grid', 'm-vert']);
    const vert = ofType(p.drawing, 'polygon').find((c) => c.id === 'm-vert')!;
    // A faceted circle: within 0.1 %.
    expect(Math.abs(area(vert.loops) / (Math.PI * 200 * 200) - 1)).toBeLessThan(1e-3);
    expect(vert.cls).toBe('cut cut-member m-metal');
    expect(p.drawing.failed).toEqual([]);
    // A section along y = 0 through the column's, the beam's and the vertical member's axes.
    const along: BimView = {
      ...section,
      id: 'v-y0',
      line: [
        [-2000, 0],
        [14000, 0],
      ],
    };
    const r = await drawBim(doc, along, kernel);
    if (r.status !== 'ok') throw new Error(r.code);
    const cut = (id: string) => ofType(r.drawing, 'polygon').find((c) => c.id === id)!;
    expect(area(cut('c-lean').loops)).toBeCloseTo(600 * Math.hypot(2000, 6000), -1);
    expect(area(cut('b-slope').loops)).toBeCloseTo(700 * Math.hypot(6000, 1500), -1);
    expect(area(cut('m-vert').loops)).toBeCloseTo(400 * 6000, -1);
    // The column's square top end rises past L1 by its half width times the lean.
    const top = Math.max(
      ...cut('c-lean')
        .loops.flat()
        .map((q) => q[1]),
    );
    expect(top).toBeCloseTo(6000 + (300 * 2000) / Math.hypot(2000, 6000), 3);
    expect(r.drawing.failed).toEqual([]);
  });

  it('cuts tapered columns and sloped slabs in a section (TW5, F47, F48)', async () => {
    const along = (y: number): BimView => ({
      ...section,
      id: `v-y${y}`,
      line: [
        [-2000, y],
        [30000, y],
      ],
    });
    const t = await drawBim(f47Taper(), along(0), kernel);
    if (t.status !== 'ok') throw new Error(t.code);
    const cut = (d: BimDrawing, id: string) =>
      ofType(d, 'polygon')
        .filter((c) => c.id === id)
        .flatMap((c) => c.loops);
    // Through the axes: the round column a trapezoid from Ø1,200 to Ø300; the box column's two
    // side walls from 40 to 30 mm.
    expect(area(cut(t.drawing, 'c-round')) / (((1200 + 300) / 2) * 6000) - 1).toBeLessThan(1e-3);
    expect(area(cut(t.drawing, 'c-box'))).toBeCloseTo(2 * ((40 + 30) / 2) * 6000, -1);
    expect(t.drawing.failed).toEqual([]);
    // Along the ramp clear of its hole and opening: 200 mm deep over its 12 m run, up to L1.
    const r = await drawBim(f48Ramp(), along(500), kernel);
    if (r.status !== 'ok') throw new Error(r.code);
    const ramp = cut(r.drawing, 's-ramp');
    expect(area(ramp)).toBeCloseTo(200 * 12000, -1);
    expect(Math.max(...ramp.flat().map((q) => q[1]))).toBeCloseTo(3000, 3);
    expect(Math.min(...ramp.flat().map((q) => q[1]))).toBeCloseTo(0, 3);
    expect(r.drawing.failed).toEqual([]);
  });

  it('cuts a leaning wall as a parallelogram in a section (LR2c, F50)', async () => {
    // Across w-free (0,0)→(6000,0), 4 m high, leaning 15° to its right (−y), 200 mm thick.
    const across: BimView = {
      ...section,
      id: 'v-x3000',
      line: [
        [3000, 3000],
        [3000, -3000],
      ],
    };
    const d = await drawBim(f50Lean(), across, kernel);
    if (d.status !== 'ok') throw new Error(d.code);
    const loops = ofType(d.drawing, 'polygon')
      .filter((c) => c.id === 'w-free')
      .flatMap((c) => c.loops);
    const lean = Math.PI / 12;
    expect(area(loops)).toBeCloseTo((200 / Math.cos(lean)) * 4000, -1);
    const xs = loops.flat().map((q) => q[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(
      200 / Math.cos(lean) + 4000 * Math.tan(lean),
      1,
    );
    expect(d.drawing.failed).toEqual([]);
  });

  it('cuts the openings of a leaning wall along its face (FU3c, F52)', async () => {
    // Across w-free through the 1,800 mm window (800–2,600 mm along): the wall's 200 mm
    // strip, 4,000 ÷ cos 15° long up its face, less the window's 900–2,400 mm along it.
    const lean = Math.PI / 12;
    const across: BimView = {
      ...section,
      id: 'v-x1700',
      line: [
        [1700, 3000],
        [1700, -3000],
      ],
    };
    const d = await drawBim(f52LeanOpenings(), across, kernel);
    if (d.status !== 'ok') throw new Error(d.code);
    const loops = ofType(d.drawing, 'polygon')
      .filter((c) => c.id === 'w-free')
      .flatMap((c) => c.loops);
    expect(loops).toHaveLength(2);
    expect(area(loops)).toBeCloseTo(200 * (4000 / Math.cos(lean) - 1500), -1);
    // The sill and the head at 900 and 2,400 mm along the face.
    const z = loops.flatMap((l) => l.map((q) => q[1]));
    const levels = [...new Set(z.map((v) => Math.round(v)))].sort((a, b) => a - b);
    expect(levels).toEqual(
      [0, 900, 2400, 4000 / Math.cos(lean)].map((v) => Math.round(v * Math.cos(lean))),
    );
    expect(d.drawing.failed).toEqual([]);
    // The GL plan at 1,200 mm cuts the window and the door out of the wall.
    const p = await drawBim(f52LeanOpenings(), { ...plan, id: 'v-gl', level: 'l-gl' }, kernel);
    if (p.status !== 'ok') throw new Error(p.code);
    const cut = ofType(p.drawing, 'polygon')
      .filter((c) => c.id === 'w-free')
      .flatMap((c) => c.loops);
    expect(cut).toHaveLength(3);
    expect(area(cut)).toBeCloseTo((200 / Math.cos(lean)) * (6000 - 1800 - 900), -1);
    expect(p.drawing.failed).toEqual([]);
  });

  it("draws a stair's risers, sides, break line and arrow in a plan (LS6, F55)", async () => {
    // st-main climbs 3,000 mm east from (0, 0) in 17 risers of 176.5 mm, 1,200 mm wide: the
    // 1,200 mm cut passes over the first 6, through the 6th tread.
    const doc = f55Stairs();
    const view: BimView = { ...plan, id: 'v-gl', level: 'l-gl', cutHeightMm: 1200 };
    const p = await drawBim(doc, view, kernel);
    if (p.status !== 'ok') throw new Error(p.code);
    const lines = ofType(p.drawing, 'line').filter((l) => l.id === 'st-main');
    const of = (cls: string) => lines.filter((l) => l.cls === cls);
    // Risers across the flight at each 260 mm tread: 6 solid, 11 dashed.
    const across = (cls: string) =>
      of(cls).filter((l) => Math.abs(l.a[0] - l.b[0]) < 1e-9 && Math.abs(l.a[1] - l.b[1]) > 1199);
    expect(across('stair-line').map((l) => l.a[0])).toEqual([0, 260, 520, 780, 1040, 1300]);
    expect(across('stair-above')).toHaveLength(11);
    expect(Math.max(...across('stair-above').map((l) => l.a[0]))).toBeCloseTo(16 * 260, 9);
    // Its sides: solid to the middle of the 6th tread (1,430 mm), dashed beyond.
    const sides = (cls: string) => of(cls).filter((l) => Math.abs(l.a[1] - l.b[1]) < 1e-9);
    expect(sides('stair-line').map((l) => [l.a[0], l.b[0]])).toEqual([
      [0, 1430],
      [0, 1430],
    ]);
    expect(sides('stair-above')).toHaveLength(2);
    expect(of('stair-break')).toHaveLength(1);
    // The arrow from the foot's middle to the break: its shaft and a two-stroke head.
    const arrow = of('stair-arrow');
    expect(arrow).toHaveLength(3);
    expect(arrow[0]).toMatchObject({ a: [0, 0], b: [1430, 0] });
    // st-north (to 1,800 mm, from 0) is all below a cut at 2,000 mm: no break, nothing dashed.
    const high = await drawBim(doc, { ...view, cutHeightMm: 2000 }, kernel);
    if (high.status !== 'ok') throw new Error(high.code);
    const north = ofType(high.drawing, 'line').filter((l) => l.id === 'st-north');
    expect(north.filter((l) => l.cls === 'stair-line')).toHaveLength(12);
    expect(north.filter((l) => l.cls === 'stair-above' || l.cls === 'stair-break')).toEqual([]);
    // Dashed lines above the cut in the SVG.
    expect(bimDrawingSvg(p.drawing)).toContain('.stair-above{');
  });

  it('marks a window in a leaning wall only where the roof leaves the wall at the cut (LS1, Codex)', async () => {
    // F52's free wall leaning 0.5 rad under a 45° roof whose underside is z = 1,000 − y; a
    // window 900–3,400 mm up the face. At 2,700 mm the wall is 1,474 mm south, under 2,474 mm
    // of roof: cut away there, though the roof clears the opening's head further north.
    const doc = f52LeanOpenings();
    doc.types.push({
      id: 't-window-tall',
      kind: 'window',
      name: 'Tall',
      widthMm: 1800,
      heightMm: 2500,
    });
    for (const e of doc.elements) {
      if (e.id === 'w-free' && e.kind === 'wall')
        Object.assign(e, { lean: 0.5, clipBy: 'r-slope' });
      if (e.id === 'win-free' && e.kind === 'window') e.typeId = 't-window-tall';
    }
    doc.elements.push({
      id: 'r-slope',
      kind: 'roof',
      typeId: 't-roof-200',
      base: { level: 'l-gl', offsetMm: 0 },
      boundary: [
        [-1000, -6000],
        [7000, -6000],
        [7000, 1000],
        [-1000, 1000],
      ],
      shape: { form: 'mono', slopeRad: Math.PI / 4, directionRad: -Math.PI / 2 },
    });
    const view: BimView = { ...plan, id: 'v-gl', level: 'l-gl', cutHeightMm: 2700 };
    const p = await drawBim(doc, view, kernel);
    if (p.status !== 'ok') throw new Error(p.code);
    expect(ofType(p.drawing, 'line').filter((l) => l.cls === 'window-mark')).toEqual([]);
    // At 1,200 mm the wall stands there (under 1,000 + 619 mm of roof): the window is marked,
    // with the square's (1,176–2,646 mm up).
    const low = await drawBim(doc, { ...view, cutHeightMm: 1200 }, kernel);
    if (low.status !== 'ok') throw new Error(low.code);
    expect(ofType(low.drawing, 'line').filter((l) => l.cls === 'window-mark')).toHaveLength(6);
  });

  it('marks a window under a roof ridge though the roof is below the cut at its jambs (LS1, Codex)', async () => {
    // F52's free wall (leaning 15°) with a window 2,500 mm high across x = 800–2,600 under a
    // 45° gable over the whole wall whose ridge at x = 1,700 is 3,000 mm up: 2,100 mm at both
    // jambs.
    const doc = f52LeanOpenings();
    doc.types.push({
      id: 't-window-tall',
      kind: 'window',
      name: 'Tall',
      widthMm: 1800,
      heightMm: 2500,
    });
    for (const e of doc.elements) {
      if (e.id === 'w-free' && e.kind === 'wall') e.clipBy = 'r-gable';
      if (e.id === 'win-free' && e.kind === 'window') e.typeId = 't-window-tall';
    }
    doc.elements = doc.elements.filter((e) => e.id !== 'door-free');
    doc.elements.push({
      id: 'r-gable',
      kind: 'roof',
      typeId: 't-roof-200',
      base: { level: 'l-gl', offsetMm: -1300 },
      boundary: [
        [-2600, -6000],
        [6000, -6000],
        [6000, 6000],
        [-2600, 6000],
      ],
      shape: { form: 'gable', slopeRad: Math.PI / 4, ridgeRad: Math.PI / 2 },
    });
    const view: BimView = { ...plan, id: 'v-gl', level: 'l-gl', cutHeightMm: 2500 };
    const p = await drawBim(doc, view, kernel);
    if (p.status !== 'ok') throw new Error(p.code);
    expect(
      ofType(p.drawing, 'line').filter((l) => l.cls === 'window-mark' && l.id === 'win-free'),
    ).toHaveLength(3);
    // Above the ridge nothing of the wall is left: no mark.
    const high = await drawBim(doc, { ...view, cutHeightMm: 3050 }, kernel);
    if (high.status !== 'ok') throw new Error(high.code);
    expect(
      ofType(high.drawing, 'line').filter((l) => l.cls === 'window-mark' && l.id === 'win-free'),
    ).toEqual([]);
  });

  it("tests the roof over the wall itself, not the opening tool's margin (LS1, Codex)", async () => {
    // F52's free wall (leaning 15°) under a 45° roof whose underside is z = 769.93 − y: at the
    // 1,200 mm cut it reaches 1,195 mm over the wall's far face but 1,205 mm over the cutting
    // tool's 10 mm margin beyond it. Nothing of the wall is left there: no mark.
    const marks = async (offsetMm: number) => {
      const doc = f52LeanOpenings();
      for (const e of doc.elements) if (e.id === 'w-free' && e.kind === 'wall') e.clipBy = 'r-mono';
      doc.elements.push({
        id: 'r-mono',
        kind: 'roof',
        typeId: 't-roof-200',
        base: { level: 'l-gl', offsetMm },
        boundary: [
          [-1000, -6000],
          [7000, -6000],
          [7000, 1000],
          [-1000, 1000],
        ],
        shape: { form: 'mono', slopeRad: Math.PI / 4, directionRad: -Math.PI / 2 },
      });
      const p = await drawBim(
        doc,
        { ...plan, id: 'v-gl', level: 'l-gl', cutHeightMm: 1200 },
        kernel,
      );
      if (p.status !== 'ok') throw new Error(p.code);
      return ofType(p.drawing, 'line').filter(
        (l) => l.cls === 'window-mark' && l.id === 'win-free',
      );
    };
    expect(await marks(-230.066649)).toEqual([]);
    // 10 mm higher it reaches 1,205 mm over the wall: the window is marked.
    expect(await marks(-220.066649)).toHaveLength(3);
  });

  it('cuts a spiral ramp in a plan and a section (LR3c, F51)', async () => {
    // Across the 1.5-turn ramp along x = 0: it crosses at 90° and 450° on the north, 270° on
    // the south, each a 3,000 × 200 mm radial rectangle (its radii stay level).
    const across: BimView = {
      ...section,
      id: 'v-ramp',
      line: [
        [0, -6000],
        [0, 6000],
      ],
    };
    const d = await drawBim(f51Ramps(), across, kernel);
    if (d.status !== 'ok') throw new Error(d.code);
    const loops = ofType(d.drawing, 'polygon')
      .filter((c) => c.id === 'r-spiral')
      .flatMap((c) => c.loops);
    expect(loops).toHaveLength(3);
    expect(area(loops) / (3 * 3000 * 200) - 1).toBeLessThan(1e-3);
    // Their tops at the heights of those angles: 4,000 mm over 540°.
    const tops = loops.map((l) => Math.max(...l.map((q) => q[1]))).sort((a, b) => a - b);
    for (const [k, deg] of [90, 270, 450].entries())
      expect(tops[k]).toBeCloseTo((4000 * deg) / 540, 0);
    expect(d.drawing.failed).toEqual([]);
    // A plan of GL cuts the ramps that rise through its cut height.
    const p = await drawBim(f51Ramps(), { ...plan, id: 'v-gl', level: 'l-gl' }, kernel);
    if (p.status !== 'ok') throw new Error(p.code);
    const ids = new Set(ofType(p.drawing, 'polygon').map((c) => c.id));
    expect(ids.has('r-spiral')).toBe(true);
    expect(p.drawing.failed).toEqual([]);
  });

  it('cuts railings on a spiral ramp in a section and a plan (LS5, F55)', async () => {
    const across: BimView = {
      ...section,
      id: 'v-ramp',
      line: [
        [0, -6000],
        [0, 6000],
      ],
    };
    const doc = f55RampOpenings();
    const d = await drawBim(doc, across, kernel);
    if (d.status !== 'ok') throw new Error(d.code);
    // Each railing of the spiral crosses x = 0 where the ramp does: 50 × 1,100 mm, standing on
    // the ramp's top at 90°, 270° and 450°.
    for (const id of ['rail-in', 'rail-out']) {
      const loops = ofType(d.drawing, 'polygon')
        .filter((c) => c.id === id)
        .flatMap((c) => c.loops);
      expect(loops, id).toHaveLength(3);
      expect(area(loops) / (3 * 50 * 1100) - 1).toBeLessThan(1e-3);
      const tops = loops.map((l) => Math.max(...l.map((q) => q[1]))).sort((a, b) => a - b);
      for (const [k, deg] of [90, 270, 450].entries())
        expect(tops[k]).toBeCloseTo((4000 * deg) / 540 + 1100, 0);
    }
    expect(d.drawing.failed).toEqual([]);
    const p = await drawBim(doc, { ...plan, id: 'v-gl', level: 'l-gl' }, kernel);
    if (p.status !== 'ok') throw new Error(p.code);
    const ids = new Set(ofType(p.drawing, 'polygon').map((c) => c.id));
    expect(ids.has('rail-in') && ids.has('rail-out')).toBe(true);
    expect(p.drawing.failed).toEqual([]);
  });

  it('bounds every solid by its box, so a view leaves out only what it never meets', async () => {
    // F37, the roofs and the types, and F31 with an arc wall: every mesh point in its box.
    const arc = f31BoxBuilding();
    const south = arc.elements.find((e) => e.id === 'w-south')!;
    if (south.kind === 'wall') south.bulge = -0.4;
    arc.elements = arc.elements.filter((e) => e.kind !== 'door' && e.kind !== 'window');
    let checked = 0;
    for (const doc of [
      f37Office(),
      f39Roofs('gable'),
      f33Types(),
      arc,
      f40Lattice(),
      f47Taper(),
      f48Ramp(),
      f50Lean(),
      f51Ramps(),
      f52LeanOpenings(),
      f54LeanRoofs(),
      f54LeanJoins(),
      f55RampOpenings(),
      f55Stairs(),
    ]) {
      const derived = deriveBim(doc);
      const e = await new BimEvaluator(kernel).evaluate(doc);
      if (e.status !== 'ok') throw new Error(e.status);
      for (const [id, r] of e.elements) {
        const box = bimElementBox(doc, derived, id);
        if (!box || r.status !== 'ok') continue;
        const { rotation: m, translation: t } = r.placement ?? {
          rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          translation: [0, 0, 0],
        };
        const p = r.mesh.positions;
        for (let i = 0; i < p.length; i += 3) {
          const w = [0, 1, 2].map(
            (k) =>
              m[k * 3]! * p[i]! + m[k * 3 + 1]! * p[i + 1]! + m[k * 3 + 2]! * p[i + 2]! + t[k]!,
          );
          for (let k = 0; k < 3; k++) {
            expect(w[k]!, `${id} ${k}`).toBeGreaterThanOrEqual(box[0][k]! - 0.01);
            expect(w[k]!, `${id} ${k}`).toBeLessThanOrEqual(box[1][k]! + 0.01);
          }
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(800);
  });

  it('names an element it cannot build and draws the rest, and caches by content', async () => {
    const doc = f36();
    doc.types.push({
      id: 'pt-1',
      kind: 'part',
      name: 'Missing',
      source: { artifactId: 'a', versionId: 'v', contentHash: 'c'.repeat(64) },
      hintBounds: { min: [0, 0, 0], max: [100, 100, 100] },
    });
    doc.elements.push({
      id: 'p-1',
      kind: 'part',
      typeId: 'pt-1',
      at: { xy: [5000, 4000] },
      base: { level: 'l-1f', offsetMm: 0 },
      rotationRad: 0,
    });
    let runs = 0;
    const counted: BimKernel = { run: (...a) => (runs++, kernel.run(...a)) };
    const drawings = new BimDrawings(counted);
    const r = await drawings.draw(doc, plan);
    if (r.status !== 'ok') throw new Error(r.code);
    expect(r.drawing.failed).toEqual([{ id: 'p-1', code: 'asset-missing' }]);
    expect(ofType(r.drawing, 'polygon')).toHaveLength(4);
    expect(bimDrawingSvg(r.drawing)).toContain('>p-1 (asset-missing)</text>');
    const before = runs;
    expect(await drawings.draw(structuredClone(doc), plan)).toBe(r);
    expect(runs).toBe(before);
  });
});

describe('bim drawings without a kernel (R2c-5)', () => {
  it('names an element whose clip fails, and not one with nothing to see', async () => {
    const doc = f36();
    // Cuts succeed; the seen part of w-north fails to clip, of w-south is empty.
    const kernel: BimKernel = {
      run: async (graph, requests) =>
        ({
          status: 'ok',
          results: requests.map((r) => {
            const id = r.node.split('\u0000')[0]!;
            if (r.measure && id === 'w-north')
              return { node: r.node, status: 'error' as const, code: 'half-space-failed' };
            if (r.measure && id === 'w-south')
              return { node: r.node, status: 'error' as const, code: 'empty-result' };
            if (r.measure) return { node: r.node, status: 'error' as const, code: 'empty-result' };
            return { node: r.node, status: 'ok' as const, section: [] };
          }),
        }) as never,
    };
    const r = await drawBim(doc, plan, kernel);
    if (r.status !== 'ok') throw new Error(r.code);
    expect(r.drawing.failed).toEqual([{ id: 'w-north', code: 'half-space-failed' }]);
  });

  it('asks the kernel only for the elements a view can meet', async () => {
    // F37's 2F plan keeps 4,000–5,200 mm: the 2F walls and columns, and what ends at 4,000 mm
    // (the 1F walls and columns, the 2F slab) are asked for; nothing of 3F–5F is.
    const doc = f37Office();
    const asked = new Set<string>();
    const kernel: BimKernel = {
      run: async (_graph, requests) =>
        ({
          status: 'ok',
          results: requests.map((r) => {
            asked.add(r.node.split('\u0000')[0]!);
            return r.measure
              ? { node: r.node, status: 'error' as const, code: 'empty-result' }
              : { node: r.node, status: 'ok' as const, section: [] };
          }),
        }) as never,
    };
    const view: BimView = { ...plan, id: 'v-2f', level: 'l-2f' };
    const r = await drawBim(doc, view, kernel);
    if (r.status !== 'ok') throw new Error(r.code);
    expect(asked.has('w-s-2')).toBe(true);
    expect(asked.has('c-2-1-1')).toBe(true);
    expect([...asked].some((id) => /^(w-[a-z]-|c-)[345]\b/.test(id))).toBe(false);
    expect(asked.has('r-roof')).toBe(false);
    expect(asked.size).toBeLessThan(160);
    // A section asks for what lies within its depth of its line, on every storey.
    asked.clear();
    await drawBim(
      doc,
      {
        ...section,
        line: [
          [14400, -2000],
          [14400, 30800],
        ],
        depthMm: 1000,
      },
      kernel,
    );
    expect(asked.has('c-1-3-1') && asked.has('c-5-3-5')).toBe(true);
    expect(asked.has('c-1-1-1')).toBe(false);
    // Deeper, the columns behind the cut are seen whole: no clip, and no cut asked for.
    const cutOf = new Set<string>();
    const clipped = new Set<string>();
    const recording: BimKernel = {
      run: async (graph, requests) => {
        for (const r of requests) if (r.section) cutOf.add(r.node.split('\u0000')[0]!);
        for (const id of Object.keys(graph.nodes))
          if (id.includes('\u0000draw:keep')) clipped.add(id.split('\u0000')[0]!);
        return kernel.run(graph, requests, new Map());
      },
    };
    await drawBim(
      doc,
      {
        ...section,
        line: [
          [14400, -2000],
          [14400, 30800],
        ],
      },
      recording,
    );
    expect(cutOf.has('c-1-3-1') && clipped.has('c-1-3-1')).toBe(true);
    expect(cutOf.has('c-1-1-1') || clipped.has('c-1-1-1')).toBe(false);
  });

  it("gives the projection, one job for every seen solid, the projection's limit", async () => {
    const limits: (number | undefined)[] = [];
    const kernel: BimKernel = {
      run: async (_graph, requests, _assets, _signal, options) => {
        limits.push(options?.timeoutMs);
        return {
          status: 'ok',
          results: requests.map((r) =>
            r.projection
              ? { node: r.node, status: 'ok' as const, projection: { visible: [], hidden: [] } }
              : r.measure
                ? { node: r.node, status: 'ok' as const, measure: {} }
                : { node: r.node, status: 'ok' as const, section: [] },
          ),
        } as never;
      },
    };
    const r = await drawBim(f36(), plan, kernel);
    if (r.status !== 'ok') throw new Error(r.code);
    // The cuts keep the ordinary limit; the last job is the projection.
    expect(limits.slice(0, -1).every((l) => l === undefined)).toBe(true);
    expect(limits.at(-1)).toBe(bimKernelLimits.projectionTimeoutMs);
    expect(bimKernelLimits.projectionTimeoutMs).toBe(300_000);
  });

  it('splits a job that times out until the element at fault is alone, and draws the rest', async () => {
    const doc = f36();
    const kernel: BimKernel = {
      run: async (_graph, requests) =>
        (requests.some((r) => r.node.startsWith('w-north\u0000'))
          ? { status: 'timeout' }
          : {
              status: 'ok',
              results: requests.map((r) =>
                r.measure
                  ? { node: r.node, status: 'error' as const, code: 'empty-result' }
                  : { node: r.node, status: 'ok' as const, section: [] },
              ),
            }) as never,
    };
    const r = await drawBim(doc, plan, kernel);
    if (r.status !== 'ok') throw new Error(r.code);
    expect(r.drawing.failed).toEqual([{ id: 'w-north', code: 'element-timeout' }]);
    // Not kept: the next draw asks the kernel again.
    let runs = 0;
    const drawings = new BimDrawings({ run: (...a) => (runs++, kernel.run(...a)) });
    await drawings.draw(doc, plan);
    const first = runs;
    await new Promise((r) => setTimeout(r, 0));
    await drawings.draw(doc, plan);
    expect(runs).toBeGreaterThan(first);
  });

  it("draws a sheet part's closed cut as a line, a solid's as a filled area", async () => {
    const doc = f36();
    const hash = 'ab'.repeat(32);
    doc.types.push({
      id: 't-tube',
      kind: 'part',
      name: 'Tube',
      source: { artifactId: 'cad-1', versionId: 'v1', contentHash: hash },
      hintBounds: { min: [0, 0, 0], max: [1000, 1000, 3000] },
    });
    doc.elements.push({
      id: 'p-tube',
      kind: 'part',
      typeId: 't-tube',
      at: { xy: [4000, 4000] },
      base: { level: 'l-1f', offsetMm: 0 },
      rotationRad: 0,
    });
    // An uncapped square tube: its cut is a closed square.
    const square = new Float64Array([
      4000, 4000, 1200, 5000, 4000, 1200, 5000, 5000, 1200, 4000, 5000, 1200, 4000, 4000, 1200,
    ]);
    const kernel: BimKernel = {
      run: async (_graph, requests) =>
        ({
          status: 'ok',
          results: requests.map((r) =>
            r.measure
              ? { node: r.node, status: 'error' as const, code: 'empty-result' }
              : {
                  node: r.node,
                  status: 'ok' as const,
                  // The whole part, or one body of it: each cut is the square.
                  section: r.node.startsWith('p-tube\u0000') ? [square] : [],
                },
          ),
        }) as never,
    };
    const cut = async (kinds: ('solid' | 'sheet')[]) => {
      const r = await drawBim(doc, plan, kernel, {
        parts: new Map([[hash, { status: 'available', kinds }]]),
      });
      if (r.status !== 'ok') throw new Error(r.code);
      return r.drawing.items.find((i) => i.type === 'polygon' && i.id === 'p-tube');
    };
    // Once the part's kinds are known, a drawing made without them is not reused.
    const drawings = new BimDrawings(kernel);
    const assets = new Map([[hash, new Uint8Array([1])]]);
    const before = await drawings.draw(doc, plan, assets);
    const after = await drawings.draw(
      doc,
      plan,
      assets,
      new Map([[hash, { status: 'available', kinds: ['sheet'] }]]),
    );
    expect(after).not.toBe(before);
    const tube = (r: typeof after) =>
      r.status === 'ok'
        ? r.drawing.items.find((i) => i.type === 'polygon' && i.id === 'p-tube')
        : undefined;
    expect(tube(after)).toMatchObject({ loops: [] });
    const sheet = await cut(['sheet']);
    expect(sheet).toMatchObject({ loops: [] });
    expect(sheet?.type === 'polygon' && sheet.open?.[0]).toHaveLength(5);
    const solid = await cut(['solid']);
    expect(solid?.type === 'polygon' && solid.loops).toHaveLength(1);
    expect(solid?.type === 'polygon' && solid.open).toBeUndefined();
    // Both kinds: the solid's cut is filled, the sheet's is a line, cut apart.
    const mixed = await cut(['solid', 'sheet']);
    expect(mixed?.type === 'polygon' && mixed.loops).toHaveLength(1);
    expect(mixed?.type === 'polygon' && mixed.open).toHaveLength(1);
  });

  it("leaves out a part whose shape's bounds lie wholly outside the view", async () => {
    const doc = f36();
    const hash = 'ef'.repeat(32);
    doc.types.push({
      id: 't-lamp',
      kind: 'part',
      name: 'Lamp',
      source: { artifactId: 'cad-1', versionId: 'v1', contentHash: hash },
      hintBounds: { min: [0, 0, 0], max: [500, 500, 500] },
    });
    // 5 m above the floor, turned: wholly above the plan's cut at 1,200 mm.
    doc.elements.push({
      id: 'p-lamp',
      kind: 'part',
      typeId: 't-lamp',
      at: { xy: [4000, 4000] },
      base: { level: 'l-1f', offsetMm: 5000 },
      rotationRad: 0.5,
    });
    const asked: string[] = [];
    const kernel: BimKernel = {
      run: async (_graph, requests) => {
        asked.push(...requests.map((r) => r.node));
        return {
          status: 'ok',
          results: requests.map((r) =>
            r.measure
              ? { node: r.node, status: 'error' as const, code: 'empty-result' }
              : { node: r.node, status: 'ok' as const, section: [] },
          ),
        } as never;
      },
    };
    const lamp = () => asked.filter((n) => n.startsWith('p-lamp\u0000'));
    const draw = async (bounds?: [[number, number, number], [number, number, number]]) => {
      asked.length = 0;
      const r = await drawBim(doc, plan, kernel, {
        parts: new Map([
          [hash, { status: 'available', kinds: ['solid'], ...(bounds ? { bounds } : {}) }],
        ]),
      });
      if (r.status !== 'ok') throw new Error(r.code);
      return r.drawing;
    };
    // Without its bounds, the kernel is asked and finds nothing to draw.
    await draw();
    expect(lamp().length).toBeGreaterThan(0);
    const drawing = await draw([
      [0, 0, 0],
      [500, 500, 500],
    ]);
    expect(lamp()).toEqual([]);
    expect(drawing.failed).toEqual([]);
    // Reaching down through the cut, it is cut again.
    await draw([
      [0, 0, -4500],
      [500, 500, 500],
    ]);
    expect(lamp().length).toBeGreaterThan(0);
  });

  it('clips a part placed near the limit in its own frame, so the view keeps its depth', async () => {
    const doc = f36();
    doc.types.push({
      id: 't-box',
      kind: 'part',
      name: 'Box',
      source: { artifactId: 'cad-1', versionId: 'v1', contentHash: 'cd'.repeat(32) },
      hintBounds: { min: [0, 0, 0], max: [1000, 1000, 1000] },
    });
    doc.elements.push({
      id: 'p-far',
      kind: 'part',
      typeId: 't-box',
      at: { xy: [999000, 0] },
      base: { level: 'l-1f', offsetMm: 0 },
      rotationRad: 0,
    });
    // Looking right (+x) from x = 998,000, 20,000 mm deep: the far plane is at x = 1,018,000.
    const view: BimView = {
      ...section,
      line: [
        [998000, -1000],
        [998000, 1000],
      ],
      direction: 'right',
    };
    const graphs: Record<string, unknown>[] = [];
    const kernel: BimKernel = {
      run: async (graph, requests) =>
        (graphs.push(graph.nodes),
        {
          status: 'ok',
          results: requests.map((r) =>
            r.measure
              ? { node: r.node, status: 'error' as const, code: 'empty-result' }
              : { node: r.node, status: 'ok' as const, section: [] },
          ),
        }) as never,
    };
    const r = await drawBim(doc, view, kernel);
    if (r.status !== 'ok') throw new Error(r.code);
    const far = graphs.find((g) => g['p-far\u0000draw:keep1'])!['p-far\u0000draw:keep1'] as {
      origin: number[];
      normal: number[];
      keep: string;
    };
    // In the part's frame the far plane is 19,000 mm along x: in range, and kept.
    expect(far.keep).toBe('below');
    expect(far.origin[0]).toBeCloseTo(19000, 6);
    expect(far.normal[0]).toBeCloseTo(1, 9);
  });
});
