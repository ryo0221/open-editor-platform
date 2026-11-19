import { describe, expect, it } from 'vitest';
import { compareCad } from './diff';
import { f11Bracket } from './fixtures';
import type { CadDocument, Vec3 } from './model';
import { applyCadOperation } from './operations';
import type { CadProportionMesh } from './proportions';
import {
  SightGrid,
  measureSightChecks,
  pruneSightChecks,
  sightCheckReport,
  type CadSightCheck,
} from './sight-checks';
import { f157Eyes, f157Lamp, f157SightChecks, f157WatchEye } from './sight-fixtures';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);
/** An axis-aligned box as a mesh: its 8 corners (bit 0 x, 1 y, 2 z) and 12 triangles. */
const box = (bodyId: string, min: number[], max: number[]): CadProportionMesh => ({
  bodyId,
  points: [0, 1, 2, 3, 4, 5, 6, 7].flatMap((i) => [
    i & 1 ? max[0]! : min[0]!,
    i & 2 ? max[1]! : min[1]!,
    i & 4 ? max[2]! : min[2]!,
  ]),
  indices: [
    [0, 1, 3, 0, 3, 2],
    [4, 5, 7, 4, 7, 6],
    [0, 1, 5, 0, 5, 4],
    [2, 3, 7, 2, 7, 6],
    [0, 2, 6, 0, 6, 4],
    [1, 3, 7, 1, 7, 5],
  ].flat(),
});
/** A z-axis cylinder of `n` sides: a fan on each end and two triangles a side. */
const cylinder = (bodyId: string, c: Vec3, r: number, h: number, n = 64): CadProportionMesh => {
  const points: number[] = [c[0], c[1], c[2], c[0], c[1], c[2] + h];
  for (let k = 0; k < n; k++) {
    const a = (2 * Math.PI * k) / n;
    for (const z of [c[2], c[2] + h])
      points.push(c[0] + r * Math.cos(a), c[1] + r * Math.sin(a), z);
  }
  const lo = (k: number) => 2 + 2 * (k % n);
  const hi = (k: number) => 3 + 2 * (k % n);
  const indices: number[] = [];
  for (let k = 0; k < n; k++)
    indices.push(
      0,
      lo(k + 1),
      lo(k),
      1,
      hi(k),
      hi(k + 1),
      lo(k),
      lo(k + 1),
      hi(k + 1),
      lo(k),
      hi(k + 1),
      hi(k),
    );
  return { bodyId, points, indices };
};
/** The angles (degrees, left positive from +X) a box's corners make seen from an eye. */
const shadow = (eye: Vec3, min: number[], max: number[]): [number, number] => {
  const a = [0, 1, 2, 3].map((i) => {
    const x = (i & 1 ? max[0]! : min[0]!) - eye[0];
    const y = (i & 2 ? max[1]! : min[1]!) - eye[1];
    return (Math.atan2(y, x) * 180) / Math.PI;
  });
  return [Math.min(...a), Math.max(...a)];
};
// The checks read the meshes only; a document without bodies of its own needs no others' meshes.
const doc = (checks: CadSightCheck[]): CadDocument => ({
  ...f11Bracket(),
  bodies: [],
  sightChecks: checks,
});

// PD7 (docs/cad/product-design.md, PD7 見え方の検査). ST-769, ST-770, TS-2550..2553.
describe('PD7 sight checks', () => {
  const pillarL = { min: [700, 600, 900], max: [760, 660, 1700] };
  const pillarR = { min: [700, -660, 900], max: [760, -600, 1700] };
  const carMeshes = [box('pl', pillarL.min, pillarL.max), box('pr', pillarR.min, pillarR.max)];
  const pillar = (id: string, bodyId: string, eyes: Vec3[], from: number, to: number) =>
    ({
      id,
      name: id,
      measure: {
        kind: 'obstruction',
        eyes,
        forward: [1, 0, 0],
        up: [0, 0, 1],
        fromDeg: from,
        toDeg: to,
        bodyIds: [bodyId],
      },
      max: 6,
    }) satisfies CadSightCheck;

  it('measures the angle a pillar hides from both eyes, and from each eye (TS-2550)', () => {
    const d = doc([
      pillar('left', 'pl', f157Eyes, 0, 90),
      pillar('right', 'pr', f157Eyes, -90, 0),
      pillar('one-eye', 'pl', [f157Eyes[0]!], 0, 90),
    ]);
    const [left, right, oneEye] = measureSightChecks(d, { meshes: carMeshes });
    const [a0, a1] = shadow(f157Eyes[0]!, pillarL.min, pillarL.max);
    const [b0, b1] = shadow(f157Eyes[1]!, pillarL.min, pillarL.max);
    // Both eyes: only where the two eyes' shadows overlap, narrower than either eye's own.
    const both = Math.min(a1, b1) - Math.max(a0, b0);
    expect(both).toBeGreaterThan(1);
    expect(left!.unit).toBe('deg');
    expect(left!.value).toBeCloseTo(both, 0);
    expect(Math.abs(left!.value! - both)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(left!.perEye![0]! - (a1 - a0))).toBeLessThanOrEqual(0.2);
    expect(Math.abs(left!.perEye![1]! - (b1 - b0))).toBeLessThanOrEqual(0.2);
    expect(left!.value!).toBeLessThan(Math.min(...left!.perEye!));
    expect(left!.hidden).toHaveLength(1);
    expect(Math.abs(left!.hidden![0]![0] - Math.max(a0, b0))).toBeLessThanOrEqual(0.1);
    expect(Math.abs(left!.hidden![0]![1] - Math.min(a1, b1))).toBeLessThanOrEqual(0.1);
    expect(left!.status).toBe('pass');
    expect(left).toMatchObject({ stepDeg: 0.1, rays: 1800, triangles: 12 });
    // The right pillar is the left one mirrored: the same angle, on the negative side.
    expect(right!.value).toBeCloseTo(left!.value!, 6);
    expect(right!.hidden![0]![1]).toBeLessThan(0);
    // One eye sees no more than its own shadow.
    expect(oneEye!.value).toBeCloseTo(left!.perEye![0]!, 6);
    // A body over the whole arc hides exactly the arc: the steps are counted, not summed.
    const wall = measureSightChecks(
      doc([{ ...pillar('w', 'wall', [[0, 0, 0]], 0, 45), max: 45 }]),
      { meshes: [box('wall', [1, -1, -1], [2, 3, 1])] },
    )[0]!;
    expect(wall.value).toBe(45);
    expect(wall.perEye).toEqual([45]);
    expect(wall.hidden).toEqual([[0, 45]]);
    expect(wall.status).toBe('pass');
    // A step that does not divide the arc is narrowed to one that does.
    const coarse = measureSightChecks(
      doc([
        {
          ...pillar('c', 'pl', f157Eyes, 0, 90),
          measure: { ...pillar('c', 'pl', f157Eyes, 0, 90).measure, stepDeg: 0.7 },
        },
      ]),
      { meshes: carMeshes },
    )[0]!;
    expect(coarse.stepDeg).toBeCloseTo(90 / 129, 9);
    expect(Math.abs(coarse.value! - both)).toBeLessThanOrEqual(2 * coarse.stepDeg!);
  });

  const watch = (withBridge: boolean) => [
    cylinder('balance', [0, 5000, 0], 5, 1),
    ...(withBridge ? [box('bridge', [-6, 4994, 3], [0, 5006, 3.5])] : []),
    cylinder('crystal', [0, 5000, 8], 15, 1),
  ];
  const seen = (clearIds?: string[], eyes: Vec3[] = [f157WatchEye]): CadSightCheck => ({
    id: 'seen',
    name: 'Balance',
    measure: {
      kind: 'visibleFraction',
      eyes,
      targetIds: ['balance'],
      ...(clearIds ? { clearIds } : {}),
    },
    min: 0.4,
  });

  it('measures the share of a target seen through clear bodies (TS-2551)', () => {
    // The bridge's edge lies in the plane through the eye: it hides exactly half the face. The
    // balance's own sides and underside face away and are not counted.
    const [half] = measureSightChecks(doc([seen(['crystal'])]), { meshes: watch(true) });
    expect(half!.unit).toBe('ratio');
    expect(half!.value).toBeCloseTo(0.5, 6);
    expect(half!.status).toBe('pass');
    expect(half).toMatchObject({ samples: 256, rays: 256, triangles: 12 });
    const [all] = measureSightChecks(doc([seen(['crystal'])]), { meshes: watch(false) });
    expect(all!.value).toBeCloseTo(1, 6);
    // Without the crystal listed as clear, it stops every line.
    const [none] = measureSightChecks(doc([seen()]), { meshes: watch(true) });
    expect(none!.value).toBe(0);
    expect(none!.status).toBe('fail');
    // Two eyes: a point counts when either eye sees it, out of what faces either eye; the
    // second eye, off to the side, also faces some of the balance's rim.
    const eyes: Vec3[] = [f157WatchEye, [-60, 5000, 250]];
    const [two] = measureSightChecks(doc([seen(['crystal'], eyes)]), { meshes: watch(true) });
    expect(two!.perEye).toHaveLength(2);
    expect(two!.perEye![0]).toBeCloseTo(0.5, 6);
    expect(two!.perEye![1]).not.toBeCloseTo(0.5, 2);
    expect(two!.value!).toBeGreaterThan(0);
    expect(two!.value!).toBeLessThan(1);
    expect(two!.rays).toBe(512);
  });

  it('measures how far a lamp’s light turns before a body stops it (TS-2552)', () => {
    const meshes = [
      box('lamp', [-3010, -10, -510], [-2990, 10, -490]),
      box('fender', [-2900, -200, -550], [-2700, -100, -450]),
    ];
    const lamp = (toward: 'left' | 'right', clearIds?: string[]): CadSightCheck => ({
      id: toward,
      name: toward,
      measure: {
        kind: 'visibleAngle',
        from: [...f157Lamp],
        forward: [1, 0, 0],
        up: [0, 0, 1],
        toward,
        limitDeg: 45,
        ...(clearIds ? { clearIds } : {}),
      },
      min: 30,
    });
    const [right, left, boxed] = measureSightChecks(
      doc([lamp('right', ['lamp']), lamp('left', ['lamp']), lamp('right')]),
      { meshes },
    );
    // The fender's far inner corner (300 mm ahead, 100 mm out): atan(100 / 300).
    const edge = (Math.atan(1 / 3) * 180) / Math.PI;
    expect(right!.value!).toBeLessThanOrEqual(edge);
    expect(right!.value!).toBeGreaterThan(edge - 0.1);
    expect(right!.status).toBe('fail');
    expect(right!.stepDeg).toBeCloseTo(0.1, 9);
    expect(left!.value).toBe(45);
    expect(left!.status).toBe('pass');
    expect(left!.rays).toBe(451);
    // A tilted lamp keeps its aim: up is squared to forward, not forward to up.
    const [tilted] = measureSightChecks(
      doc([
        {
          id: 't',
          name: 't',
          measure: {
            kind: 'visibleAngle',
            from: [0, 0, 0],
            forward: [1, 0, 1],
            up: [0, 0, 1],
            toward: 'left',
            limitDeg: 30,
          },
          min: 10,
        },
      ]),
      { meshes: [box('aim', [9, -1, 9], [11, 1, 11])] },
    );
    expect(tilted!.value).toBe(0);
    // Its own lens, not listed as clear, stops the first ray.
    expect(boxed!.value).toBe(0);
  });

  it('reports what it cannot measure now as unknown, never as a pass (TS-2551)', () => {
    const d = doc([pillar('p', 'pl', f157Eyes, 0, 90), seen(['crystal'])]);
    expect(measureSightChecks(d, {}).map((r) => [r.status, r.reason])).toEqual([
      ['unknown', 'sight-not-evaluated'],
      ['unknown', 'sight-not-evaluated'],
    ]);
    expect(measureSightChecks(d, { meshes: [] }).map((r) => r.reason)).toEqual([
      'sight-body-missing',
      'sight-body-missing',
    ]);
    // A target with no area: nothing of it can face an eye.
    const flat: CadProportionMesh = {
      bodyId: 'balance',
      points: [0, 5000, 0, 0, 5000, 0, 1, 5000, 0],
      indices: [0, 1, 2],
    };
    expect(measureSightChecks(doc([seen()]), { meshes: [flat] })[0]!.reason).toBe(
      'sight-target-hidden',
    );
    // An eye inside a closed target sees only its inside: none of it faces the eye.
    const cube = box('balance', [-10, 4990, -10], [10, 5010, 10]);
    expect(
      measureSightChecks(doc([seen(undefined, [[0, 5000, 0]])]), { meshes: [cube] })[0]!.reason,
    ).toBe('sight-target-hidden');
    // With a second eye outside, only that eye counts.
    const [outer] = measureSightChecks(
      doc([
        seen(undefined, [
          [0, 5000, 0],
          [0, 5000, 100],
        ]),
      ]),
      {
        meshes: [cube],
      },
    );
    expect(outer!.value).toBe(1);
    expect(outer!.perEye).toEqual([0, 1]);
    // An open sheet has no inside: an eye below it sees it wherever it stands.
    const sheet: CadProportionMesh = {
      bodyId: 'balance',
      points: [-10, 4990, 0, 10, 4990, 0, 10, 5010, 0, -10, 5010, 0],
      indices: [0, 2, 1, 0, 3, 2],
    };
    for (const eye of [
      [0, 5000, -1],
      [20, 5000, -1],
    ] as Vec3[])
      expect(measureSightChecks(doc([seen(undefined, [eye])]), { meshes: [sheet] })[0]!.value).toBe(
        1,
      );
    // An eye in the sheet's own plane sees it edge-on: none of it.
    expect(
      measureSightChecks(doc([seen(undefined, [[20, 5000, 0]])]), { meshes: [sheet] })[0]!.reason,
    ).toBe('sight-target-hidden');
    // One eye blocked, the other clear: the triangle counts as seen with one weight, so the
    // share stays 1 (adding a blocked eye never lowers it).
    const tri: CadProportionMesh = {
      bodyId: 'balance',
      points: [-1, 4999, 0, 1, 4999, 0, 0, 5001, 0],
      indices: [0, 1, 2],
    };
    const cover = box('cover', [-5, 4995, 5], [5, 5005, 5.1]);
    const [mixed] = measureSightChecks(
      doc([
        seen(undefined, [
          [0, 5000, 10],
          [20, 5000, 1],
        ]),
      ]),
      { meshes: [tri, cover] },
    );
    expect(mixed!.perEye).toEqual([0, 1]);
    expect(mixed!.value).toBe(1);
    // An eye outside a closed box whose crossing ray passes through a shared edge: still outside.
    const edgeBox = box('balance', [-1, -1, -1], [1, 1, 1]);
    const [edgeOn] = measureSightChecks(
      doc([seen(undefined, [[1 - 2 * 0.5773, 1 - 2 * 0.5779, -2]])]),
      { meshes: [edgeBox] },
    );
    expect(edgeOn!.status).toBe('pass');
    expect(edgeOn!.value).toBe(1);
    const report = sightCheckReport(d, measureSightChecks(d, { meshes: carMeshes }), 'Car');
    expect(report).toMatchObject({
      format: 'editor-platform/cad-sight-checks@1',
      document: 'Car',
      basis: 'display-meshes',
      summary: { pass: 1, fail: 0, unknown: 1 },
    });
    expect(report.checks[0]).toMatchObject({ id: 'p', max: 6, unit: 'deg', status: 'pass' });
    expect(report.checks[1]).toMatchObject({
      id: 'seen',
      status: 'unknown',
      reason: 'sight-body-missing',
    });
  });

  it('finds a ray’s hit through the grid as a scan of every triangle does (TS-2550)', () => {
    // Many small boxes: the grid answers as testing each triangle would.
    const meshes = Array.from({ length: 60 }, (_, i) =>
      box(
        `b${i}`,
        [(i % 6) * 30, Math.floor(i / 6) * 25, (i % 4) * 10],
        [(i % 6) * 30 + 8, Math.floor(i / 6) * 25 + 6, (i % 4) * 10 + 5],
      ),
    );
    const flat = new Float64Array(
      meshes.flatMap((m) =>
        Array.from(m.indices!, (k) => [0, 1, 2].map((j) => m.points[k * 3 + j]!)).flat(),
      ),
    );
    const grid = new SightGrid(flat);
    const naive = (o: Vec3, d: Vec3) => {
      for (let t = 0; t < flat.length / 9; t++) {
        const one = new SightGrid(flat.slice(t * 9, t * 9 + 9));
        if (one.blocked(o, d, Infinity)) return true;
      }
      return false;
    };
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    let hits = 0;
    for (let i = 0; i < 200; i++) {
      const o: Vec3 = [rnd() * 300 - 50, rnd() * 300 - 50, rnd() * 60 - 10];
      const v: Vec3 = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
      const l = Math.hypot(...v);
      const d: Vec3 = [v[0] / l, v[1] / l, v[2] / l];
      const g = grid.blocked(o, d, Infinity);
      expect(g).toBe(naive(o, d));
      if (g) hits++;
    }
    expect(hits).toBeGreaterThan(10);
  });

  it('stores the checks in the document: validated, removed when empty, pruned with a body (TS-2553)', () => {
    const base = f11Bracket();
    const id = base.bodies[0]!.id;
    const checks: CadSightCheck[] = [
      { ...pillar('p', id, f157Eyes, 0, 90), requirement: 'RQ-21' },
      {
        id: 'v',
        name: 'V',
        measure: { kind: 'visibleFraction', eyes: [f157WatchEye], targetIds: [id] },
        min: 0.2,
      },
      {
        id: 'a',
        name: 'A',
        measure: {
          kind: 'visibleAngle',
          from: [0, 0, 0],
          forward: [1, 0, 0],
          up: [0, 0, 1],
          toward: 'up',
          clearIds: [id],
        },
        min: 10,
      },
    ];
    const set = applyCadOperation(base, { type: 'setSightChecks', checks });
    expect(set.sightChecks).toEqual(checks);
    expect(codes(set)).toEqual([]);
    expect(compareCad(base, set).map((c) => c.path)).toEqual(['sightChecks']);
    expect(() => applyCadOperation(set, { type: 'setSightChecks', checks })).toThrow(
      'sight-checks-unchanged',
    );
    expect(
      applyCadOperation(set, { type: 'setSightChecks', checks: [] }).sightChecks,
    ).toBeUndefined();
    // Removing the body takes the checks over it; the lamp check keeps going without its clear list.
    const gone = applyCadOperation(set, { type: 'deleteClosure', ids: [id], cascade: true });
    const { clearIds: _clear, ...lamp } = checks[2]!.measure as { clearIds?: string[] };
    expect(gone.sightChecks).toEqual([{ ...checks[2], measure: lamp }]);
    const two: CadDocument = {
      ...set,
      sightChecks: [
        {
          ...checks[0]!,
          measure: { ...(checks[0]!.measure as object), bodyIds: ['x', 'y'] } as never,
        },
      ],
    };
    pruneSightChecks(two, new Set(['x']));
    expect((two.sightChecks![0]!.measure as { bodyIds: string[] }).bodyIds).toEqual(['y']);
    pruneSightChecks(two, new Set(['y']));
    expect(two.sightChecks).toBeUndefined();
  });

  it('refuses bad points, directions, arcs, steps, bodies and bands (TS-2553)', () => {
    const base = f11Bracket();
    const id = base.bodies[0]!.id;
    const at = '$.sightChecks[0]';
    const withC = (t: unknown) => ({ ...base, sightChecks: [t] }) as unknown as CadDocument;
    const ok = pillar('p', id, f157Eyes, 0, 90);
    const m = ok.measure;
    expect(codes(withC(ok))).toEqual([]);
    expect(codes({ ...base, sightChecks: [] })).toEqual(['sight-checks@$.sightChecks']);
    expect(codes(withC({ id: 'p', name: 'p', measure: m }))).toEqual([`sight-check-band@${at}`]);
    expect(codes(withC({ ...ok, min: 5, max: 1 }))).toEqual([`sight-check-band@${at}.max`]);
    expect(codes(withC({ ...ok, requirement: '' }))).toEqual([
      `sight-check-requirement@${at}.requirement`,
    ]);
    expect(codes(withC({ ...ok, measure: { ...m, eyes: [] } }))).toEqual([
      `sight-check-eyes@${at}.measure.eyes`,
    ]);
    expect(codes(withC({ ...ok, measure: { ...m, eyes: [[0, 0, 1e9]] } }))).toEqual([
      `sight-check-point@${at}.measure.eyes[0]`,
    ]);
    expect(codes(withC({ ...ok, measure: { ...m, up: [2, 0, 0] } }))).toEqual([
      `sight-check-direction@${at}.measure.up`,
    ]);
    expect(codes(withC({ ...ok, measure: { ...m, forward: [0, 0, 0] } }))).toEqual([
      `sight-check-direction@${at}.measure.forward`,
    ]);
    expect(codes(withC({ ...ok, measure: { ...m, fromDeg: 10, toDeg: 10 } }))).toEqual([
      `sight-check-arc@${at}.measure.toDeg`,
    ]);
    expect(codes(withC({ ...ok, measure: { ...m, stepDeg: 0.001 } }))).toEqual([
      `sight-check-step@${at}.measure.stepDeg`,
    ]);
    // 90° in 0.01° steps is 9,000 rays; 360° would be over the limit, but the arc stops at ±180°.
    expect(codes(withC({ ...ok, measure: { ...m, stepDeg: 0.01 } }))).toEqual([]);
    expect(
      codes(withC({ ...ok, measure: { ...m, fromDeg: -180, toDeg: 180, stepDeg: 0.01 } })),
    ).toEqual([`sight-check-step@${at}.measure.stepDeg`]);
    expect(codes(withC({ ...ok, measure: { ...m, bodyIds: ['ghost', id, id] } }))).toEqual([
      `sight-check-body@${at}.measure.bodyIds[0]`,
      `sight-check-body-twice@${at}.measure.bodyIds[2]`,
    ]);
    const frac = {
      id: 'v',
      name: 'v',
      measure: { kind: 'visibleFraction', eyes: [f157WatchEye], targetIds: [id], clearIds: [id] },
      min: 1.5,
    };
    expect(codes(withC(frac))).toEqual([
      `sight-check-band@${at}.min`,
      `sight-check-clear-target@${at}.measure.clearIds`,
    ]);
    const ang = {
      id: 'a',
      name: 'a',
      measure: {
        kind: 'visibleAngle',
        from: [0, 0],
        forward: [1, 0, 0],
        up: [0, 0, 1],
        toward: 'back',
        limitDeg: 200,
      },
      min: 1,
    };
    expect(codes(withC(ang))).toEqual([
      `sight-check-point@${at}.measure.from`,
      `sight-check-toward@${at}.measure.toward`,
      `sight-check-limit@${at}.measure.limitDeg`,
    ]);
    expect(codes(withC({ ...ok, measure: { kind: 'glare' } }))).toEqual([
      `sight-check-measure@${at}.measure`,
    ]);
    expect(codes({ ...base, sightChecks: [ok, ok] })).toEqual(['duplicate-id@$.sightChecks[1].id']);
  });
});

describe('F157 sight checks', () => {
  it('validates, one check of each kind (TS-2553)', () => {
    const d = f157SightChecks();
    expect(codes(d)).toEqual([]);
    expect(d.sightChecks?.map((c) => c.measure.kind)).toEqual([
      'obstruction',
      'obstruction',
      'visibleFraction',
      'visibleAngle',
    ]);
  });

  it('needs every opaque body’s meshes for a fraction or an angle (TS-2551)', () => {
    // The F157 bodies as boxes: the bridge half covers the balance, the fender stops the lamp.
    const d = f157SightChecks();
    const all = [
      box('a-pillar-left', [700, 600, 900], [760, 660, 1700]),
      box('a-pillar-right', [700, -660, 900], [760, -600, 1700]),
      cylinder('balance', [0, 5000, 0], 5, 1),
      box('bridge', [-6, 4994, 3], [0, 5006, 3.5]),
      cylinder('crystal', [0, 5000, 8], 15, 1),
      box('lamp-lens', [-3010, -10, -510], [-2990, 10, -490]),
      box('fender', [-2900, -200, -550], [-2700, -100, -450]),
    ];
    expect(d.bodies.map((b) => b.id).sort()).toEqual(all.map((m) => m.bodyId).sort());
    const full = measureSightChecks(d, { meshes: all });
    expect(full.map((r) => r.status)).toEqual(['pass', 'pass', 'pass', 'fail']);
    // Without the bridge's meshes the balance would look wholly seen; without the fender's the
    // lamp would look clear: both unknown, never a pass.
    for (const gone of ['bridge', 'fender']) {
      const r = measureSightChecks(d, { meshes: all.filter((m) => m.bodyId !== gone) });
      expect(r.slice(2).map((x) => [x.status, x.reason])).toEqual([
        ['unknown', 'sight-body-missing'],
        ['unknown', 'sight-body-missing'],
      ]);
      // The pillars' obstruction names its own bodies only.
      expect(r[0]!.status).toBe('pass');
    }
  });
});
