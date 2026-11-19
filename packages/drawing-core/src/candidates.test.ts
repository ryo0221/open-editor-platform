import { describe, expect, it } from 'vitest';
import { drawingCandidateDimensions, drawingFaceOnCircles, drawingHoleCircles } from './candidates';
import { drawingAnnotationGraphics, drawingNearestOnFeature } from './dimensions';
import type { DrawingCadView, DrawingDimension, DrawingDirection, DrawingDocument } from './model';
import {
  addDrawingAnnotations,
  addDrawingView,
  drawingStarter,
  useDrawingSource,
} from './operations';
import { drawingProject, type DrawingMeshBody } from './project';
import type { DrawingViewState } from './svg';
import { box, cylinder } from './test-shapes';
import { drawingCadViewGraphics } from './view-graphics';

// DW4b (docs/cad/drawing-editor.md, 組立図; DW-U4): the outline and hole dimensions a new part
// drawing starts with. ST-709, TS-2427.

const viewOf = (
  direction: DrawingDirection,
  scale: DrawingCadView['scale'] = '1:1',
): DrawingCadView => ({
  id: 'view-1',
  kind: 'cad-projection',
  sheetId: 'sheet-1',
  sourceId: 'src-1',
  name: 'v',
  at: [150, 150],
  scale,
  label: true,
  direction,
  only: [],
  hiddenLines: true,
  centerLines: true,
});
const moved = (b: DrawingMeshBody, d: [number, number, number]): DrawingMeshBody => ({
  ...b,
  path: [],
  positions: Array.from(b.positions, (v, i) => v + d[i % 3]!),
  edges: b.edges.map((e) => ({ ...e, points: Array.from(e.points, (v, i) => v + d[i % 3]!) })),
});
/** A 60 × 40 × 20 plate with two Ø10 holes and one Ø6 (the holes' walls as cylinders). */
const plate = [
  box(60, 40, 20),
  moved(cylinder(5, 20), [15, 20, 0]),
  moved({ ...cylinder(5, 20), bodyId: 'cyl-2' }, [45, 20, 0]),
  moved({ ...cylinder(3, 20), bodyId: 'cyl-3' }, [30, 30, 0]),
];
function measured(
  bodies: DrawingMeshBody[],
  direction: DrawingDirection,
  o: Partial<Parameters<typeof drawingCandidateDimensions>[2]> = {},
  scale: DrawingCadView['scale'] = '1:1',
) {
  const view = viewOf(direction, scale);
  const r = drawingProject(bodies, direction, { step: 0.25, hidden: true, centers: true });
  const g = drawingCadViewGraphics(view, r);
  const st: DrawingViewState = { status: 'ready', graphics: g };
  const list = drawingCandidateDimensions(g, view.at, {
    width: true,
    height: true,
    holes: true,
    below: false,
    left: true,
    ...o,
  });
  const dims: DrawingDimension[] = list.map((c, i) => ({
    id: `dim-${i}`,
    sheetId: 'sheet-1',
    kind: 'dimension',
    viewId: view.id,
    type: c.type,
    refs: c.refs,
    at: c.at,
    text: '',
    tolerance: '',
    heightMm: 3.5,
  }));
  const base = addDrawingView(
    useDrawingSource(drawingStarter(), {
      id: 'src-1',
      kind: 'cad',
      artifactId: 'a',
      versionId: 'v',
      contentHash: 'h',
      name: 'Part',
    }).doc,
    view,
  );
  const doc: DrawingDocument = dims.length ? addDrawingAnnotations(base, dims) : base;
  return {
    g,
    view,
    list,
    values: dims.map((d) => {
      const r = drawingAnnotationGraphics(doc, d, new Map([[view.id, st]]));
      return `${d.type} ${r.status} ${Math.round((r.value ?? NaN) * 100) / 100}`;
    }),
  };
}

describe('candidate dimensions of a part drawing (DW4b)', () => {
  it('gives the outline of the front: width and height, outside the view', () => {
    const { values, list, g, view } = measured([box(60, 40, 20)], 'front');
    expect(values).toEqual(['horizontal ok 60', 'vertical ok 20']);
    const [[x0], [, y1]] = g.bounds;
    // Over the view and to its left.
    expect(list[0]!.at[1] + view.at[1]).toBeGreaterThan(y1);
    expect(list[1]!.at[0] + view.at[0]).toBeLessThan(x0);
  });

  it('gives each hole size once and the holes’ places from the left and lower edges', () => {
    const { values, g } = measured(plate, 'top');
    // The two rims of each hole are one circle on the paper.
    expect(drawingFaceOnCircles(g)).toHaveLength(3);
    expect(values.sort()).toEqual(
      [
        // Places across: 15, 30, 45; up: 20, 30.
        'horizontal ok 15',
        'horizontal ok 30',
        'horizontal ok 45',
        'vertical ok 20',
        'vertical ok 30',
        // The outline.
        'horizontal ok 60',
        'vertical ok 40',
        // Ø10 once, Ø6.
        'diameter ok 10',
        'diameter ok 6',
      ].sort(),
    );
    // Stacked lines do not share a place.
    const { list } = measured(plate, 'top');
    const lines = list.filter((c) => c.type === 'horizontal').map((c) => c.at[1]);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('gives a round outline its diameter, and holes off its centre', () => {
    const disc = [
      { ...cylinder(25, 10), path: [] },
      moved({ ...cylinder(4, 10), bodyId: 'h' }, [12, 0, 0]),
    ];
    const { values } = measured(disc, 'top');
    expect(values.sort()).toEqual(['horizontal ok 12', 'diameter ok 50', 'diameter ok 8'].sort());
    // Seen from the side the rims are edge-on: across is the diameter, along the rims' centres
    // (Codex on #1232).
    expect(measured([{ ...cylinder(25, 10), path: [] }], 'front').values.sort()).toEqual(
      ['diameter ok 50', 'vertical ok 10'].sort(),
    );
  });

  it('finds a shaft’s cross bore as its hole, not the shaft’s end (Codex on #1232)', () => {
    // A Ø50 shaft along z with a Ø8 blind bore along x into its side.
    const turn = (b: DrawingMeshBody): DrawingMeshBody => {
      const t = (a: ArrayLike<number>) =>
        Array.from(a, (_, i) => {
          const k = i - (i % 3);
          const [x, y, z] = [a[k]!, a[k + 1]!, a[k + 2]!];
          return [25 - z, y, 20 + x][i % 3]!;
        });
      return {
        ...b,
        positions: t(b.positions),
        edges: b.edges.map((e) => ({ ...e, points: t(e.points) })),
      };
    };
    const shaft = [
      { ...cylinder(25, 40), path: [] },
      { ...turn(cylinder(4, 10)), path: [], bodyId: 'bore' },
    ];
    const holes = (['front', 'top', 'right'] as const).map(
      (d) => drawingHoleCircles(measured(shaft, d).g).length,
    );
    expect(holes).toEqual([0, 0, 1]);
    expect(drawingFaceOnCircles(measured(shaft, 'top').g)).toHaveLength(1);
  });

  it('takes a big hole in a square plate for a hole, not a round outline (Codex on #1232)', () => {
    const plate = [box(50, 50, 10), moved({ ...cylinder(24.75, 10), bodyId: 'h' }, [25, 25, 0])];
    expect(measured(plate, 'top').values.sort()).toEqual(
      [
        'horizontal ok 25',
        'vertical ok 25',
        'horizontal ok 50',
        'vertical ok 50',
        'diameter ok 49.5',
      ].sort(),
    );
  });

  it('takes a hole in an elliptical plate for a hole, not a round outline (Codex on #1278)', () => {
    // A 60 × 40 elliptical plate (its rim a stretched circle, so no circle) with a centred Ø10.
    const c = cylinder(10, 10);
    const stretch = (v: number, i: number) => (i % 3 === 0 ? v * 3 : i % 3 === 1 ? v * 2 : v);
    const ellipse: DrawingMeshBody = {
      ...c,
      bodyId: 'ellipse',
      path: [],
      positions: Array.from(c.positions, stretch),
      edges: c.edges.map((e) => ({ ...e, points: Array.from(e.points, stretch) })),
    };
    const g = measured([ellipse, { ...cylinder(5, 10), bodyId: 'h' }], 'top').g;
    expect(drawingHoleCircles(g)).toHaveLength(1);
  });

  it('resolves a point on an ellipse on the curve, not its chord (Codex on #1278)', () => {
    const c = cylinder(1, 10);
    const stretch = (v: number, i: number) => (i % 3 === 0 ? v * 20 : i % 3 === 1 ? v * 10 : v);
    const ellipse: DrawingMeshBody = {
      ...c,
      bodyId: 'ellipse',
      path: [],
      positions: Array.from(c.positions, stretch),
      edges: c.edges.map((e) => ({ ...e, points: Array.from(e.points, stretch) })),
    };
    const r = drawingProject([ellipse], 'top', { step: 0.25, hidden: true, centers: true });
    const rim = r.features.find((f) => !f.straight && !f.circle && f.start[2] === 10)!;
    expect(rim.runs?.length).toBeGreaterThan(0);
    const q = drawingNearestOnFeature(rim, [0, 10, 10]);
    expect(Math.hypot(q[0], q[1] - 10)).toBeLessThan(0.1);
  });

  it('gives no overall width that a half-ellipse reaches past (Codex on #1278)', () => {
    // A 10 × 20 plate end (x 0…10) joined to a half-ellipse reaching to x 40: flat, seen from above.
    const n = 32;
    const lobe: number[] = [];
    for (let i = 0; i <= n; i++) {
      const t = (Math.PI * i) / n;
      lobe.push(10 + 30 * Math.sin(t), 10 - 10 * Math.cos(t), 0);
    }
    const positions = [0, 0, 0, 10, 0, 0, 10, 20, 0, 0, 20, 0, 10, 10, 0, ...lobe];
    const indices = [0, 1, 2, 0, 2, 3];
    for (let i = 0; i < n; i++) indices.push(4, 5 + i, 6 + i);
    const flat: DrawingMeshBody = {
      path: [],
      bodyId: 'lobe',
      positions,
      indices,
      faces: indices.filter((_, i) => i % 3 === 0).map(() => 0),
      edges: [
        { index: 0, points: [10, 20, 0, 0, 20, 0] },
        { index: 1, points: [0, 20, 0, 0, 0, 0] },
        { index: 2, points: [0, 0, 0, 10, 0, 0] },
        { index: 3, points: lobe },
      ],
    };
    const values = measured([flat], 'top').values;
    expect(values.some((v) => v.startsWith('horizontal'))).toBe(false);
    expect(values).toContain('vertical ok 20');
  });

  it('leaves out what is not asked for, and an arc', () => {
    expect(measured(plate, 'top', { width: false, height: false, holes: false }).values).toEqual(
      [],
    );
    expect(measured(plate, 'top', { width: false, height: true, holes: false }).values).toEqual([
      'vertical ok 40',
    ]);
    const arc = {
      ...cylinder(5, 20),
      bodyId: 'arc',
      path: [],
      edges: cylinder(5, 20).edges.map((e) => ({
        ...e,
        points: Array.from(e.points).slice(0, (e.points.length / 3 / 2) * 3 + 3),
      })),
    };
    const g = measured([box(60, 40, 20), moved(arc, [30, 20, 0])], 'top').g;
    expect(drawingFaceOnCircles(g)).toEqual([]);
  });

  it('measures the true extent of a slope at any scale (Codex on #1232)', () => {
    // A 600 × 400 × 200 box leaning 1 % along x with height: 602 wide seen from the front.
    const lean = (b: DrawingMeshBody): DrawingMeshBody => ({
      ...b,
      positions: Array.from(b.positions, (v, i) =>
        i % 3 === 0 ? v + 0.01 * b.positions[i + 2]! : v,
      ),
      edges: b.edges.map((e) => ({
        ...e,
        points: Array.from(e.points, (v, i) => (i % 3 === 0 ? v + 0.01 * e.points[i + 2]! : v)),
      })),
    });
    for (const scale of ['1:1', '1:10'] as const)
      expect(measured([lean(box(600, 400, 200))], 'front', {}, scale).values[0]).toBe(
        'horizontal ok 602',
      );
  });

  it('takes a round part’s width from its rim, not from an eccentric boss (Codex on #1232)', () => {
    const disc = [
      { ...cylinder(25, 10), path: [] },
      moved({ ...cylinder(4, 5), bodyId: 'boss' }, [12, 0, 10]),
    ];
    expect(measured(disc, 'front').values.sort()).toEqual(
      ['diameter ok 50', 'vertical ok 15'].sort(),
    );
  });

  it('gives a capsule no width between its arcs’ tangent points (Codex on #1232)', () => {
    // 60 × 20, R10 ends, 5 thick, seen from the top; the arcs' points miss their extremes.
    const n = 25;
    const arc = (cx: number, from: number) =>
      Array.from({ length: n + 1 }, (_, i) => {
        const t = from + (Math.PI * i) / n;
        return [cx + 10 * Math.cos(t), 10 + 10 * Math.sin(t), 5];
      });
    const outline = [...arc(50, -Math.PI / 2), ...arc(10, Math.PI / 2)];
    const positions = [30, 10, 5, ...outline.flat()];
    const indices = outline.flatMap((_, i) => [0, 1 + i, 1 + ((i + 1) % outline.length)]);
    const capsule: DrawingMeshBody = {
      path: [],
      bodyId: 'capsule',
      positions,
      indices,
      faces: indices.filter((_, i) => i % 3 === 0).map(() => 0),
      edges: [
        { index: 0, points: [10, 0, 5, 50, 0, 5] },
        { index: 1, points: arc(50, -Math.PI / 2).flat() },
        { index: 2, points: [50, 20, 5, 10, 20, 5] },
        { index: 3, points: arc(10, Math.PI / 2).flat() },
      ],
    };
    // Its width is to the arcs, which no edge end or centre gives: left to the designer. Its
    // height is between its straight sides.
    for (const scale of ['1:1', '1:5'] as const)
      expect(measured([capsule], 'top', {}, scale).values).toEqual(['vertical ok 20']);
    // A rounded corner ends where the side does: the plate keeps its width and height.
    const quarter = (cx: number, cy: number, from: number) =>
      Array.from({ length: 13 }, (_, i) => {
        const t = from + (Math.PI / 2) * (i / 12);
        return [cx + 10 * Math.cos(t), cy + 10 * Math.sin(t), 5];
      }).flat();
    const rounded = structuredClone(capsule);
    rounded.edges = [
      { index: 0, points: [10, 0, 5, 50, 0, 5] },
      { index: 1, points: quarter(50, 10, -Math.PI / 2) },
      { index: 2, points: [60, 10, 5, 60, 20, 5] },
      { index: 3, points: [60, 20, 5, 0, 20, 5] },
      { index: 4, points: [0, 20, 5, 0, 10, 5] },
      { index: 5, points: quarter(10, 10, Math.PI) },
    ];
    expect(measured([rounded], 'top').values).toEqual(['horizontal ok 60', 'vertical ok 20']);
  });

  it('keeps a thin part’s thickness at a small scale (Codex on #1232)', () => {
    for (const scale of ['1:1', '1:5', '1:10'] as const)
      expect(measured([box(1000, 500, 1)], 'front', {}, scale).values).toEqual([
        'horizontal ok 1000',
        'vertical ok 1',
      ]);
  });
});
