import { describe, expect, it } from 'vitest';
import { drawingAnnotationGraphics, drawingSnap } from './dimensions';
import { drawingIssueBlockers } from './issue';
import type {
  DrawingCadView,
  DrawingDimension,
  DrawingDocument,
  DrawingRef,
  DrawingSource,
} from './model';
import {
  addDrawingAnnotation,
  addDrawingView,
  deleteDrawingItems,
  drawingStarter,
  useDrawingSource,
} from './operations';
import {
  drawingProject,
  drawingViewAxes,
  type DrawingEdgeFeature,
  type DrawingMeshBody,
  type Vec3,
} from './project';
import { drawingSheetSvg, type DrawingViewState } from './svg';
import { box, cylinder } from './test-shapes';
import { validateDrawing } from './validation';
import { drawingCadViewGraphics } from './view-graphics';

// DW3a (docs/cad/drawing-editor.md, 寸法): dimensions measured on the 3D shape. ST-703, TS-2410.

const source: DrawingSource = {
  id: 'src-1',
  kind: 'cad',
  artifactId: 'part',
  versionId: 'v1',
  contentHash: 'h1',
  name: 'Part',
};
const viewOf = (direction: DrawingCadView['direction']): DrawingCadView => ({
  id: 'view-1',
  kind: 'cad-projection',
  sheetId: 'sheet-1',
  sourceId: 'src-1',
  name: '正面図',
  at: [150, 150],
  scale: '1:1',
  label: true,
  direction,
  only: [],
  hiddenLines: true,
  centerLines: true,
});
function setup(bodies: DrawingMeshBody[], direction: DrawingCadView['direction'] = 'front') {
  const view = viewOf(direction);
  const r = drawingProject(bodies, direction, { step: 0.25, hidden: true, centers: true });
  const g = drawingCadViewGraphics(view, r);
  const state: DrawingViewState = {
    status: 'ready',
    graphics: { items: g.items, bounds: g.bounds, frame: g.frame, features: g.features },
  };
  const doc = addDrawingView(useDrawingSource(drawingStarter(), source).doc, view);
  return { doc, views: new Map([[view.id, state]]), features: g.features! };
}
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) < 1e-6);
/** A ref to the edge running from `a` to `b` (either way), at one of its points. */
function refTo(
  features: DrawingEdgeFeature[],
  a: number[],
  b: number[],
  point: DrawingRef['point'],
): DrawingRef {
  const f = features.find(
    (x) => (near(x.start, a) && near(x.end, b)) || (near(x.start, b) && near(x.end, a)),
  )!;
  const model = point === 'end' ? f.end : point === 'center' ? f.circle!.c : f.start;
  return { path: f.anchor.path, bodyId: f.anchor.bodyId, edge: f.anchor.edge, point, model };
}
const dim = (over: Partial<DrawingDimension>): DrawingDimension => ({
  id: 'dim-1',
  sheetId: 'sheet-1',
  kind: 'dimension',
  viewId: 'view-1',
  type: 'horizontal',
  refs: [],
  at: [0, -20],
  text: '',
  tolerance: '',
  heightMm: 3.5,
  ...over,
});
const texts = (g: { items: { type: string; text?: string }[] }) =>
  g.items.filter((i) => i.type === 'text').map((i) => i.text);
const startOf = (f: DrawingEdgeFeature[], a: number[], b: number[]) => {
  const r = refTo(f, a, b, 'start');
  return near(r.model, a)
    ? r
    : { ...r, point: 'end' as const, model: a as [number, number, number] };
};

describe('dimensions (DW3a)', () => {
  it('measures a horizontal and a vertical length on the 3D shape', () => {
    const { doc, views, features } = setup([box(60, 40, 20)]);
    const bottom = refTo(features, [0, 0, 0], [60, 0, 0], 'start');
    const h = dim({
      refs: [
        startOf(features, [0, 0, 0], [60, 0, 0]),
        { ...bottom, point: near(bottom.model, [0, 0, 0]) ? 'end' : 'start', model: [60, 0, 0] },
      ],
      tolerance: '±0.1',
    });
    const g = drawingAnnotationGraphics(doc, h, views);
    expect(g.status).toBe('ok');
    expect(g.value).toBeCloseTo(60);
    expect(texts(g)).toEqual(['60 ±0.1']);
    // Two arrows, the dimension line and two extension lines.
    expect(g.items.filter((i) => i.type === 'polyline' && i.fill)).toHaveLength(2);
    expect(g.items.filter((i) => i.type === 'line')).toHaveLength(3);
    const side = refTo(features, [0, 0, 0], [0, 0, 20], 'start');
    const v = dim({
      type: 'vertical',
      refs: [
        startOf(features, [0, 0, 0], [0, 0, 20]),
        { ...side, point: near(side.model, [0, 0, 0]) ? 'end' : 'start', model: [0, 0, 20] },
      ],
      at: [-50, 0],
    });
    const gv = drawingAnnotationGraphics(doc, v, views);
    expect(gv.value).toBeCloseTo(20);
    const t = gv.items.find((i) => i.type === 'text');
    expect(t?.type === 'text' && t.rotation).toBeCloseTo(Math.PI / 2);
  });

  it('says when an aligned length is projected (an edge not square to the view)', () => {
    const { doc, views, features } = setup([box(60, 40, 20)], 'iso');
    const r = refTo(features, [0, 0, 20], [60, 0, 20], 'start');
    const g = drawingAnnotationGraphics(
      doc,
      dim({
        type: 'aligned',
        refs: [r, { ...r, point: r.point === 'start' ? 'end' : 'start', model: [0, 0, 0] }],
      }),
      views,
    );
    expect(g.projected).toBe(true);
    expect(texts(g)[0]).toMatch(/（投影）$/);
    expect(g.value).toBeLessThan(60);
  });

  it('takes a diameter and a radius from the circle, face-on and side-on', () => {
    const top = setup([cylinder(10, 30)], 'top');
    const c = top.features.find((f) => f.circle)!;
    const ref: DrawingRef = {
      path: c.anchor.path,
      bodyId: c.anchor.bodyId,
      edge: c.anchor.edge,
      point: 'edge',
      model: c.circle!.c,
    };
    const d = drawingAnnotationGraphics(
      top.doc,
      dim({ type: 'diameter', refs: [ref], at: [30, 20] }),
      top.views,
    );
    expect(texts(d)).toEqual(['Ø20']);
    const r = drawingAnnotationGraphics(
      top.doc,
      dim({ type: 'radius', refs: [ref], at: [30, 20] }),
      top.views,
    );
    expect(texts(r)).toEqual(['R10']);
    const front = setup([cylinder(10, 30)], 'front');
    const s = drawingAnnotationGraphics(
      front.doc,
      dim({ type: 'diameter', refs: [ref], at: [0, -30] }),
      front.views,
    );
    expect(s.value).toBeCloseTo(20);
    expect(texts(s)).toEqual(['Ø20']);
  });

  it('measures the angle between two straight edges', () => {
    const { doc, views, features } = setup([box(60, 40, 20)]);
    const x = refTo(features, [0, 0, 0], [60, 0, 0], 'edge');
    const z = refTo(features, [0, 0, 0], [0, 0, 20], 'edge');
    const g = drawingAnnotationGraphics(
      doc,
      dim({ type: 'angle', refs: [x, z], at: [-140, -140 + 10] }),
      views,
    );
    expect(g.status).toBe('ok');
    expect(g.value).toBeCloseTo(90);
    expect(texts(g)).toEqual(['90°']);
    expect(g.items.some((i) => i.type === 'arc')).toBe(true);
  });

  it('keeps a sheet from being issued while an angle measures parallel edges (Codex on #1246)', () => {
    const { doc, views, features } = setup([box(60, 40, 20)]);
    const bottom = refTo(features, [0, 0, 0], [60, 0, 0], 'edge');
    const top = refTo(features, [0, 0, 20], [60, 0, 20], 'edge');
    const angle = dim({ type: 'angle', refs: [bottom, top], at: [-140, -140 + 10] });
    expect(drawingAnnotationGraphics(doc, angle, views).status).toBe('parallel');
    const withAngle = addDrawingAnnotation(doc, angle);
    expect(drawingIssueBlockers(withAngle, views, ['sheet-1'])).toEqual([
      { sheetId: 'sheet-1', code: 'issue-unprintable', id: 'dim-1' },
    ]);
  });

  it('keeps an unresolved dimension in red where it was', () => {
    const { doc, views } = setup([box(60, 40, 20)]);
    const lost: DrawingRef = {
      path: [],
      bodyId: 'box',
      edge: 999,
      point: 'start',
      model: [0, 0, 0],
    };
    const g = drawingAnnotationGraphics(
      doc,
      dim({ refs: [lost, { ...lost, model: [60, 0, 0] }] }),
      views,
    );
    expect(g.status).toBe('unresolved');
    expect(g.value).toBeCloseTo(60);
    const withDim = addDrawingAnnotation(
      doc,
      dim({ refs: [lost, { ...lost, model: [60, 0, 0] }] }),
    );
    const svg = drawingSheetSvg(withDim, withDim.sheets[0]!, views);
    expect(svg).toContain('class="err"');
  });

  it('is valid content; refuses wrong refs; goes with its view', () => {
    const { doc, features } = setup([box(60, 40, 20)]);
    const a = refTo(features, [0, 0, 0], [60, 0, 0], 'start');
    const good = addDrawingAnnotation(doc, dim({ refs: [a, { ...a, point: 'end' }] }));
    expect(validateDrawing(good)).toEqual([]);
    const bad = (patch: (d: DrawingDocument) => void) => {
      const d = structuredClone(good);
      patch(d);
      return validateDrawing(d).map((x) => x.code);
    };
    expect(bad((d) => ((d.annotations[0] as DrawingDimension).refs = [a]))).toContain(
      'dimension-refs',
    );
    expect(bad((d) => ((d.annotations[0] as DrawingDimension).type = 'diameter'))).toContain(
      'dimension-refs',
    );
    expect(bad((d) => ((d.annotations[0] as DrawingDimension).viewId = 'view-9'))).toContain(
      'view-missing',
    );
    expect(
      bad((d) => {
        (d.annotations[0] as DrawingDimension).type = 'angle';
      }),
    ).toContain('ref-point');
    expect(deleteDrawingItems(good, ['view-1']).annotations).toEqual([]);
  });

  it('snaps where it was picked, and only to what the view draws (Codex on #1211)', () => {
    const { doc, views } = setup([box(60, 40, 20)]);
    // Front view at 1:1, centred at (150, 150): the bottom edge runs from (120, 140) to (180, 140).
    const line = drawingSnap(doc, views, 'sheet-1', [150, 140.5], 'line', 2)!;
    expect(line.paper[0]).toBeCloseTo(150);
    expect(line.paper[1]).toBeCloseTo(140);
    expect(line.ref.model[0]).toBeCloseTo(30);
    expect(line.ref.model[2]).toBeCloseTo(0);
    // A detail round the corner (0, 0, 0): the far corner is outside it and is not offered.
    const r = drawingProject([box(60, 40, 20)], 'front', {
      step: 0.25,
      hidden: true,
      centers: true,
    });
    const g = drawingCadViewGraphics(viewOf('front'), r, { center: [0, 0], radius: 5 });
    expect(g.frame?.clipRadius).toBe(5);
    expect(g.features!.some((f) => f.pickable === false)).toBe(true);
    const detail = new Map<string, DrawingViewState>([
      ['view-1', { status: 'ready', graphics: { ...g, items: g.items } }],
    ]);
    const corner = drawingSnap(doc, detail, 'sheet-1', [151, 151], 'point', 3)!;
    expect(corner.paper).toEqual([150, 150]);
    expect(drawingSnap(doc, detail, 'sheet-1', [210, 150], 'point', 3)).toBeUndefined();
    expect(drawingSnap(doc, detail, 'sheet-1', [154, 150], 'point', 6)?.paper).toEqual([150, 150]);
  });

  it('draws an angle the same whichever edge is picked first (Codex on #1211)', () => {
    const { doc, views, features } = setup([box(60, 40, 20)]);
    const x = refTo(features, [0, 0, 0], [60, 0, 0], 'edge');
    const z = refTo(features, [0, 0, 0], [0, 0, 20], 'edge');
    // The vertex is at (120, 140) on the paper; the text 70 mm out at 45°.
    const at: [number, number] = [120 + 49.5 - 150, 140 + 49.5 - 150];
    const lines = (refs: DrawingRef[]) =>
      drawingAnnotationGraphics(doc, dim({ type: 'angle', refs, at }), views)
        .items.filter((i) => i.type === 'line')
        .map((i) =>
          i.type === 'line' ? [...i.a, ...i.b].map((v) => Math.round(v * 100) / 100) : [],
        )
        .sort();
    const xz = lines([x, z]);
    expect(xz).toEqual(lines([z, x]));
    // The extension of the bottom edge starts past its far end (60 mm out), not at the vertex.
    expect(xz.some((l) => Math.abs(l[0]! - 181) < 0.01 && Math.abs(l[1]! - 140) < 0.01)).toBe(true);
  });

  it('snaps to a circle seen side-on only near its drawn line (Codex on #1211)', () => {
    const { doc, views } = setup([cylinder(10, 30)]);
    expect(drawingSnap(doc, views, 'sheet-1', [150, 145], 'circle', 1)).toBeUndefined();
    const s = drawingSnap(doc, views, 'sheet-1', [155, 135.4], 'circle', 1)!;
    expect(s.paper[1]).toBeCloseTo(135, 3);
    expect(s.ref.point).toBe('edge');
  });

  it('picks an arc only where it is drawn (Codex on #1211)', () => {
    const { doc } = setup([box(60, 40, 20)], 'top');
    // A quarter circle of 10 mm round the origin, seen face-on in a view placed at (100, 100).
    const arc: Vec3[] = Array.from({ length: 9 }, (_, k) => {
      const t = (k / 8) * (Math.PI / 2);
      return [10 * Math.cos(t), 10 * Math.sin(t), 0];
    });
    const feature: DrawingEdgeFeature = {
      anchor: { kind: 'edge', path: [], bodyId: 'arc', edge: 0 },
      start: arc[0]!,
      end: arc[8]!,
      straight: false,
      circle: { c: [0, 0, 0], n: [0, 0, 1], r: 10 },
      runs: [arc],
    };
    const view = { ...doc.views[0]!, at: [100, 100] as [number, number] };
    const top = drawingViewAxes('top');
    const views = new Map<string, DrawingViewState>([
      [
        view.id,
        {
          status: 'ready',
          graphics: {
            items: [],
            bounds: [
              [90, 90],
              [110, 110],
            ],
            frame: {
              center: [0, 0],
              origin: [100, 100],
              scale: 1,
              box: [
                [-10, -10],
                [10, 10],
              ],
              depth: [0, 0],
              axes: top,
            },
            features: [feature],
          },
        },
      ],
    ]);
    const d = { ...doc, views: [view] };
    const blank = [100 - 10 * top.right[0] - 0, 100 - 10 * top.up[0]] as [number, number];
    expect(drawingSnap(d, views, 'sheet-1', blank, 'circle', 0.5)).toBeUndefined();
    const on = drawingSnap(
      d,
      views,
      'sheet-1',
      [100 + 10 * top.right[0], 100 + 10 * top.up[0]],
      'circle',
      0.5,
    );
    expect(on?.distance).toBeCloseTo(0);
    // A radius whose text lies off the arc: its arrow still lands on the arc.
    const ref: DrawingRef = { path: [], bodyId: 'arc', edge: 0, point: 'edge', model: [10, 0, 0] };
    const off: [number, number] = [-30 * top.right[0], -30 * top.up[0]];
    const g = drawingAnnotationGraphics(d, dim({ type: 'radius', refs: [ref], at: off }), views);
    const tip = g.items.find((i) => i.type === 'polyline' && i.fill);
    const t = tip?.type === 'polyline' ? tip.points[0]! : [0, 0];
    const m: [number, number] = [t[0] - 100, t[1] - 100];
    // On the arc: 10 mm from the centre, in the quarter the arc covers.
    expect(Math.hypot(...m)).toBeCloseTo(10, 3);
    const back = [m[0] * top.right[0] + m[1] * top.up[0], m[0] * top.right[1] + m[1] * top.up[1]];
    expect(back[0]).toBeGreaterThan(-1e-6);
    expect(back[1]).toBeGreaterThan(-1e-6);
  });
});
