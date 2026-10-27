import { describe, expect, it } from 'vitest';
import { assertCadOperation } from './commands';
import { compareCad } from './diff';
import {
  f01Empty,
  f11Area,
  f11Bracket,
  f11OnPlate,
  f11Region,
  f11Sketch,
  f11Solution,
  faceRef,
} from './fixtures';
import { dependencyOrder, featureReads, parameterValues } from './graph';
import { identityQuaternion, mm, position, type CadDocument } from './model';
import {
  applyCadOperation,
  cadContentHash,
  dependencyClosure,
  duplicateClosureOf,
  type CadNewBody,
} from './operations';
import {
  attachFrame,
  cadSketchLimits,
  CadSketchError,
  sketchFreedom,
  sketchMismatches,
  solveSketch,
  type CadSketch,
  type CadSketchConstraint,
  type CadSketchEntity,
  type CadSketchRegion,
  loopArea,
  regionArea,
  sketchDefaultRegion,
  sketchRegion,
} from './sketch';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);
const solveError = (run: () => unknown) => {
  try {
    run();
  } catch (e) {
    if (e instanceof CadSketchError) return `${e.code}@${e.at}`;
    return (e as Error).message;
  }
  return 'solved';
};
const params = parameterValues(f11Bracket());
const near = (
  a: Record<string, [number, number]>,
  b: Record<string, [number, number]>,
  tol = 1e-6,
) =>
  Object.keys(b).every(
    (k) => Math.abs(a[k][0] - b[k][0]) <= tol && Math.abs(a[k][1] - b[k][1]) <= tol,
  ) && Object.keys(a).length === Object.keys(b).length;
const exact = (): CadDocument => {
  const doc = structuredClone(f11Bracket());
  doc.sketches[0].solved = structuredClone(f11Solution) as CadSketch['solved'];
  return doc;
};

/** A sketch with no constraints: any coordinates are its solution. */
function free(
  points: Record<string, [number, number]>,
  entities: CadSketchEntity[],
  circles: Record<string, number> = {},
  constraints: CadSketchConstraint[] = [],
): CadSketch {
  return {
    id: 's',
    name: 'S',
    plane: { origin: position(0, 0, 0), orientation: identityQuaternion() },
    entities: [...Object.keys(points).map((id) => ({ type: 'point' as const, id })), ...entities],
    constraints,
    solved: {
      ...points,
      ...Object.fromEntries(Object.entries(circles).map(([id, r]) => [id, [r, 0]])),
    },
  };
}
const body = (id: string, source: string): CadNewBody => ({
  id,
  name: id,
  sourceFeatureId: source,
  placementFeatureId: `${id}-placement`,
  appearance: { color: '#9aa4b1', opacity: 1 },
});
/** One extrude (or revolve about `axis`) of `region` of `sketch`, built without validation. */
function sweep(
  sketch: CadSketch,
  region: CadSketchRegion,
  axis?: { origin: [number, number]; direction: [number, number] },
): CadDocument {
  const doc = f01Empty();
  doc.sketches.push(sketch);
  doc.features.push(
    axis
      ? {
          id: 'f',
          name: 'F',
          type: 'revolve',
          inputFeatureIds: [],
          args: {
            sketchId: sketch.id,
            region,
            axisOrigin: [mm(axis.origin[0]), mm(axis.origin[1])],
            axisDirection: axis.direction,
            angle: { literalRad: Math.PI },
          },
        }
      : {
          id: 'f',
          name: 'F',
          type: 'extrude',
          inputFeatureIds: [],
          args: { sketchId: sketch.id, region, distance: mm(5), direction: 1 },
        },
    {
      id: 'f-placement',
      name: 'P',
      type: 'transform',
      inputFeatureIds: ['f'],
      args: { translation: position(0, 0, 0), rotation: identityQuaternion() },
    },
  );
  doc.bodies.push({
    id: 'b',
    name: 'B',
    kind: 'solid',
    resultFeatureId: 'f-placement',
    state: 'active',
    appearance: { color: '#9aa4b1', opacity: 1 },
  });
  return doc;
}
const line = (id: string, start: string, end: string, construction?: boolean): CadSketchEntity => ({
  type: 'line',
  id,
  start,
  end,
  ...(construction ? { construction } : {}),
});
const square = { a: [0, 0], b: [10, 0], c: [10, 10], d: [0, 10] } as Record<
  string,
  [number, number]
>;
const squareLines = [
  line('ab', 'a', 'b'),
  line('bc', 'b', 'c'),
  line('cd', 'c', 'd'),
  line('da', 'd', 'a'),
];
const outer = ['ab', 'bc', 'cd', 'da'];

describe('F11 bracket solver (CAD33)', () => {
  it('solves the bracket to the analytic coordinates with no freedom left', () => {
    const doc = f11Bracket();
    expect(validateCad(doc)).toEqual([]);
    expect(near(doc.sketches[0].solved, f11Solution)).toBe(true);
    expect(sketchFreedom(doc.sketches[0], params)).toEqual({ dof: 0 });
    expect(f11Area()).toBeCloseTo(3300 - 57 * Math.PI, 9);
  });
  it('is deterministic and leaves a solved sketch exactly as it is', () => {
    const a = solveSketch(f11Sketch(), params);
    const b = solveSketch(f11Sketch(), params);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const again = solveSketch({ ...f11Sketch(), solved: a.solved }, params);
    expect(again.solved).toEqual(a.solved);
    expect(cadContentHash(f11Bracket())).toBe(cadContentHash(f11Bracket()));
  });
  it('names a redundant constraint and a conflicting one, and refuses both', () => {
    expect(solveError(() => solveSketch(f11Sketch('redundant'), params))).toBe(
      'sketch-redundant-constraint@constraints[20]',
    );
    expect(solveError(() => solveSketch(f11Sketch('conflict'), params))).toBe(
      'sketch-conflicting-constraint@constraints[20]',
    );
    const doc = f11Bracket();
    const s = f11Sketch('conflict');
    expect(() =>
      applyCadOperation(doc, {
        type: 'updateSketch',
        sketchId: s.id,
        plane: s.plane,
        entities: s.entities,
        constraints: s.constraints,
        solved: doc.sketches[0].solved,
      }),
    ).toThrow('sketch-conflicting-constraint');
    expect(validateCad(doc)).toEqual([]);
  });
  it('counts the degrees of freedom an under-constrained sketch keeps', () => {
    const without = (id: string) => {
      const s = f11Sketch();
      return { ...s, constraints: s.constraints.filter((k) => k.id !== id) };
    };
    expect(solveSketch(without('origin'), params).dof).toBe(2);
    expect(solveSketch(without('blend-r'), params).dof).toBe(1);
    const loose = free({ p: [1, 2] }, []);
    expect(solveSketch(loose, params)).toEqual({ solved: { p: [1, 2] }, dof: 2 });
  });
  it('solves again when a dimension parameter changes, and refuses a result that no longer fits', () => {
    const doc = f11Bracket();
    const wide = applyCadOperation(doc, { type: 'setParameter', parameterId: 'W', value: 120 });
    const solved = wide.sketches[0].solved;
    expect(near(solved, { ...f11Solution, p1: [120, 0], p2: [120, 20], q1: [100, 10] })).toBe(true);
    // The source is untouched: Undo restores the stored coordinates exactly.
    expect(doc.sketches[0].solved).toEqual(f11Bracket().sketches[0].solved);
    expect(() =>
      applyCadOperation(doc, { type: 'setParameter', parameterId: 'H', value: 15 }),
    ).toThrow('cad-invalid:region-hole-outside@$.features[0].args.region.holes[1]');
  });
});

describe('every constraint type', () => {
  const cases: {
    name: string;
    points: Record<string, [number, number]>;
    entities?: CadSketchEntity[];
    circles?: Record<string, number>;
    constraints: CadSketchConstraint[];
    check: (p: Record<string, [number, number]>) => void;
  }[] = [
    {
      name: 'coincident',
      points: { a: [0, 0], b: [1, 2] },
      constraints: [
        { id: 'k', type: 'coincident', a: 'a', b: 'b' },
        { id: 'f', type: 'fix', point: 'a', at: [mm(0), mm(0)] },
      ],
      check: (p) => expect(p.b[0] ** 2 + p.b[1] ** 2).toBeLessThan(1e-12),
    },
    {
      name: 'parallel and perpendicular',
      points: { a: [0, 0], b: [10, 1], c: [0, 5], d: [9, 7], e: [3, 3], f: [4, 9] },
      entities: [line('ab', 'a', 'b'), line('cd', 'c', 'd'), line('ef', 'e', 'f')],
      constraints: [
        { id: 'p', type: 'parallel', a: 'ab', b: 'cd' },
        { id: 'q', type: 'perpendicular', a: 'ab', b: 'ef' },
      ],
      check: (p) => {
        const d = (u: string, v: string) => [p[v][0] - p[u][0], p[v][1] - p[u][1]];
        const [ab, cd, ef] = [d('a', 'b'), d('c', 'd'), d('e', 'f')];
        expect(
          Math.abs(ab[0] * cd[1] - ab[1] * cd[0]) / Math.hypot(...ab) / Math.hypot(...cd),
        ).toBeLessThan(1e-9);
        expect(
          Math.abs(ab[0] * ef[0] + ab[1] * ef[1]) / Math.hypot(...ab) / Math.hypot(...ef),
        ).toBeLessThan(1e-9);
      },
    },
    {
      name: 'midpoint, point on line and symmetric',
      points: { a: [0, 0], b: [10, 0], m: [4, 1], o: [3, 2], s: [2, 3], t: [7, -2] },
      entities: [line('ab', 'a', 'b')],
      constraints: [
        { id: 'm', type: 'midpoint', point: 'm', line: 'ab' },
        { id: 'o', type: 'pointOnLine', point: 'o', line: 'ab' },
        { id: 's', type: 'symmetric', a: 's', b: 't', line: 'ab' },
      ],
      check: (p) => {
        expect(p.m[0]).toBeCloseTo((p.a[0] + p.b[0]) / 2, 6);
        expect(p.m[1]).toBeCloseTo((p.a[1] + p.b[1]) / 2, 6);
        const u = [p.b[0] - p.a[0], p.b[1] - p.a[1]];
        const side = (q: [number, number]) =>
          (u[0] * (q[1] - p.a[1]) - u[1] * (q[0] - p.a[0])) / Math.hypot(...u);
        expect(Math.abs(side(p.o))).toBeLessThan(1e-7);
        expect(side(p.s) + side(p.t)).toBeCloseTo(0, 7);
      },
    },
    {
      name: 'distances, angle and diameter',
      points: { a: [0, 0], b: [8, 1], c: [0, 4], d: [5, 9], o: [20, 20], q: [3, 7] },
      entities: [
        line('ab', 'a', 'b'),
        line('cd', 'c', 'd'),
        { type: 'circle', id: 'h', center: 'o' },
      ],
      circles: { h: 3 },
      constraints: [
        { id: 'f', type: 'fix', point: 'a', at: [mm(0), mm(0)] },
        { id: 'h0', type: 'horizontal', line: 'ab' },
        { id: 'd', type: 'distance', a: 'a', b: 'b', value: mm(10) },
        { id: 'n', type: 'angle', a: 'ab', b: 'cd', value: { literalRad: Math.PI / 3 } },
        { id: 'l', type: 'pointLineDistance', point: 'q', line: 'ab', value: mm(6) },
        { id: 'v', type: 'verticalDistance', a: 'a', b: 'c', value: mm(4) },
        { id: 'r', type: 'diameter', curve: 'h', value: mm(5) },
      ],
      check: (p) => {
        const u = [p.b[0] - p.a[0], p.b[1] - p.a[1]];
        expect(Math.hypot(...u)).toBeCloseTo(10, 6);
        const t = Math.atan2(p.d[1] - p.c[1], p.d[0] - p.c[0]) - Math.atan2(u[1], u[0]);
        expect(t).toBeCloseTo(Math.PI / 3, 9);
        const side = (u[0] * (p.q[1] - p.a[1]) - u[1] * (p.q[0] - p.a[0])) / Math.hypot(...u);
        expect(Math.abs(side)).toBeCloseTo(6, 6);
        expect(Math.abs(p.c[1] - p.a[1])).toBeCloseTo(4, 6);
        expect(p.h[0]).toBeCloseTo(2.5, 6);
      },
    },
    {
      name: 'tangent line–circle and circle–circle, equal lines and point on curve',
      points: { a: [0, 0], b: [10, 0], o: [5, 4], k: [12, 3], c: [0, 5], d: [3, 9], q: [8, 8] },
      entities: [
        line('ab', 'a', 'b'),
        line('cd', 'c', 'd'),
        { type: 'circle', id: 'h', center: 'o' },
        { type: 'circle', id: 'g', center: 'k' },
      ],
      circles: { h: 3, g: 2 },
      constraints: [
        { id: 't', type: 'tangent', a: 'ab', b: 'h' },
        { id: 'u', type: 'tangent', a: 'h', b: 'g' },
        { id: 'e', type: 'equal', a: 'cd', b: 'ab' },
        { id: 'p', type: 'pointOnCurve', point: 'q', curve: 'g' },
      ],
      check: (p) => {
        const u = [p.b[0] - p.a[0], p.b[1] - p.a[1]];
        const dist =
          Math.abs(u[0] * (p.o[1] - p.a[1]) - u[1] * (p.o[0] - p.a[0])) / Math.hypot(...u);
        expect(dist).toBeCloseTo(p.h[0], 7);
        expect(Math.hypot(p.k[0] - p.o[0], p.k[1] - p.o[1])).toBeCloseTo(p.h[0] + p.g[0], 7);
        expect(Math.hypot(p.d[0] - p.c[0], p.d[1] - p.c[1])).toBeCloseTo(Math.hypot(...u), 7);
        expect(Math.hypot(p.q[0] - p.k[0], p.q[1] - p.k[1])).toBeCloseTo(p.g[0], 7);
      },
    },
  ];
  for (const c of cases)
    it(c.name, () => {
      const s = free(c.points, c.entities ?? [], c.circles, c.constraints);
      const { solved } = solveSketch(s, params);
      c.check(solved);
      expect(sketchMismatches({ ...s, solved }, params)).toEqual([]);
    });
});

describe('degenerate solutions', () => {
  it('refuses concentric circles as tangent, solved or stored', () => {
    const rings = free(
      { o: [0, 0], k: [0, 0] },
      [
        { type: 'circle', id: 'h', center: 'o' },
        { type: 'circle', id: 'g', center: 'k' },
      ],
      { h: 10, g: 5 },
      [{ id: 't', type: 'tangent', a: 'h', b: 'g' }],
    );
    expect(solveError(() => solveSketch(rings, params))).toBe('sketch-degenerate@constraints[0]');
    expect(
      sketchMismatches(
        { ...rings, solved: { o: [0, 0], k: [0, 0], h: [7.5, 0], g: [7.5, 0] } },
        params,
      ),
    ).toEqual(['constraints[0]']);
    // Apart, they touch inside once.
    const apart = { ...rings, solved: { ...rings.solved, k: [1, 0] as [number, number] } };
    const { solved } = solveSketch(apart, params);
    expect(Math.hypot(solved.k![0] - solved.o![0], solved.k![1] - solved.o![1])).toBeCloseTo(
      Math.abs(solved.h![0] - solved.g![0]),
      6,
    );
  });

  it('counts the radii of two arcs that complete one circle once', () => {
    const halves = free({ p: [10, 0], q: [-10, 0], o: [0, 0] }, [
      { type: 'arc', id: 'top', center: 'o', start: 'p', end: 'q', clockwise: false },
      { type: 'arc', id: 'bottom', center: 'o', start: 'q', end: 'p', clockwise: false },
    ]);
    expect(solveSketch(halves, params).dof).toBe(5);
  });
});

describe('stored solution checks (CAD33)', () => {
  it('rejects coordinates that do not meet the dimensions, right at the tolerance', () => {
    expect(codes(exact())).toEqual([]);
    const tampered = exact();
    const s = tampered.sketches[0].solved;
    s.p1 = [80, 0];
    s.p2 = [80, 20];
    s.q1 = [60, 10];
    expect(codes(tampered)).toEqual(['sketch-solution-mismatch@$.sketches[0].constraints[9]']);
    const by = (delta: number) => {
      const doc = exact();
      doc.sketches[0].solved.p1 = [100 + delta, 0];
      return codes(doc);
    };
    expect(by(0.9e-6)).toEqual([]);
    expect(by(1.1e-6)).toEqual([
      'sketch-solution-mismatch@$.sketches[0].constraints[2]',
      'sketch-solution-mismatch@$.sketches[0].constraints[9]',
      'sketch-solution-mismatch@$.sketches[0].constraints[16]',
    ]);
    // The tolerance follows the current parameter values.
    const changed = exact();
    changed.parameters[0] = { id: 'W', name: 'Width', type: 'length', value: 100.01 };
    expect(codes(changed)).toContain('sketch-solution-mismatch@$.sketches[0].constraints[9]');
  });
  it('checks angle residuals to 1e-9 rad', () => {
    const parallel = (dy: number) =>
      sweep(
        free(
          { a: [0, 0], b: [100, 0], c: [0, 10], d: [100, 10 + dy], e: [50, 50] },
          [
            line('ab', 'a', 'b', true),
            line('cd', 'c', 'd', true),
            line('l0', 'a', 'b'),
            line('l1', 'b', 'e'),
            line('l2', 'e', 'a'),
          ],
          {},
          [{ id: 'k', type: 'parallel', a: 'ab', b: 'cd' }],
        ),
        { outer: ['l0', 'l1', 'l2'], holes: [] },
      );
    expect(codes(parallel(0.9e-7))).toEqual([]);
    expect(codes(parallel(1.1e-7))).toEqual([
      'sketch-solution-mismatch@$.sketches[0].constraints[0]',
    ]);
  });
  it('rejects missing or extra stored coordinates and a malformed radius', () => {
    const missing = exact();
    delete (missing.sketches[0].solved as Record<string, unknown>).q2;
    expect(codes(missing)).toEqual(['sketch-solution-mismatch@$.sketches[0].solved.q2']);
    const extra = exact();
    extra.sketches[0].solved.l0 = [0, 0];
    expect(codes(extra)).toEqual(['sketch-solution-mismatch@$.sketches[0].solved.l0']);
    const radius = exact();
    radius.sketches[0].solved.h1 = [4, 1];
    expect(codes(radius)).toEqual(['sketch-solved@$.sketches[0].solved.h1']);
  });
  it('rejects wrong element kinds, duplicate local IDs and unknown constraints', () => {
    const doc = exact();
    const s = doc.sketches[0];
    (s.entities[12] as { start: string }).start = 'l0';
    s.constraints.push({ id: 'origin', type: 'tangent', a: 'l0', b: 'l1' } as CadSketchConstraint);
    s.constraints.push({ id: 'z', type: 'curvature' } as unknown as CadSketchConstraint);
    expect(codes(doc)).toEqual([
      'sketch-reference@$.sketches[0].entities[12].start',
      'sketch-duplicate-id@$.sketches[0].constraints[20].id',
      'sketch-reference@$.sketches[0].constraints[20]',
      'sketch-constraint@$.sketches[0].constraints[21]',
    ]);
  });
  it('rejects a sketch attached to a face of the feature that sweeps it (cycle)', () => {
    const cycle = f11Bracket({ cycle: true });
    const d = validateCad(cycle);
    expect(d.map((x) => x.code)).toEqual(['cad-dependency-cycle']);
    expect(d[0].nodes).toEqual(['bracket-sketch', 'bracket-extrude']);
    expect(dependencyOrder(f11Bracket())).toEqual({
      order: ['bracket-sketch', 'bracket-extrude', 'bracket-placement'],
      depth: 3,
    });
  });
  it('keeps the sketch limits', () => {
    // Each limit at its value passes and one over is refused (CAD36).
    const sketches = (n: number) => {
      const many = exact();
      many.sketches = Array.from({ length: n }, (_, i) => ({ ...free({}, []), id: `s${i}` }));
      many.features[0] = {
        ...many.features[0],
        args: { ...many.features[0].args, sketchId: 's0' },
      } as never;
      return codes(many);
    };
    expect(sketches(cadSketchLimits.sketches)).not.toContain('limit-sketches@$.sketches');
    expect(sketches(cadSketchLimits.sketches + 1)).toContain('limit-sketches@$.sketches');
    const entities = (n: number) =>
      codes(
        sweep(
          free(Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, [i, 0]])), []),
          { outer: ['x'], holes: [] },
        ),
      );
    expect(entities(cadSketchLimits.entities)).not.toContain(
      'limit-sketch-entities@$.sketches[0].entities',
    );
    expect(entities(cadSketchLimits.entities + 1)).toContain(
      'limit-sketch-entities@$.sketches[0].entities',
    );
    const constraints = (n: number) =>
      codes(
        sweep(
          free(
            { a: [0, 0], b: [0, 0] },
            [],
            {},
            Array.from({ length: n }, (_, i) => ({
              id: `k${i}`,
              type: 'coincident',
              a: 'a',
              b: 'b',
            })),
          ),
          { outer: ['x'], holes: [] },
        ),
      );
    expect(constraints(cadSketchLimits.constraints)).not.toContain(
      'limit-sketch-constraints@$.sketches[0].constraints',
    );
    expect(constraints(cadSketchLimits.constraints + 1)).toContain(
      'limit-sketch-constraints@$.sketches[0].constraints',
    );
    const holes = (n: number) => {
      const doc = exact();
      (doc.features[0].args as { region: CadSketchRegion }).region.holes = Array.from(
        { length: n },
        () => ['h1'],
      );
      return codes(doc);
    };
    expect(holes(cadSketchLimits.holes)).not.toContain(
      'limit-region-holes@$.features[0].args.region.holes',
    );
    expect(holes(cadSketchLimits.holes + 1)).toEqual([
      'limit-region-holes@$.features[0].args.region.holes',
    ]);
  });
});

describe('regions', () => {
  const region = (holes: string[][] = [], o = outer): CadSketchRegion => ({ outer: o, holes });
  const withHoles = (circles: Record<string, [number, number, number]>) =>
    free(
      {
        ...square,
        ...Object.fromEntries(Object.entries(circles).map(([id, [x, y]]) => [`${id}c`, [x, y]])),
      },
      [
        ...squareLines,
        ...Object.keys(circles).map((id) => ({ type: 'circle' as const, id, center: `${id}c` })),
      ],
      Object.fromEntries(Object.entries(circles).map(([id, [, , r]]) => [id, r])),
    );
  it('accepts closed chains in either direction with holes inside', () => {
    expect(codes(sweep(withHoles({ h: [5, 5, 2] }), region([['h']])))).toEqual([]);
    expect(codes(sweep(withHoles({}), region([], ['da', 'cd', 'bc', 'ab'])))).toEqual([]);
  });
  it('rejects open chains, crossings, holes outside, overlapping and nested holes', () => {
    const at = (s: CadSketch, r: CadSketchRegion) =>
      codes(sweep(s, r)).map((c) => c.replace('$.features[0].args.region.', ''));
    expect(at(withHoles({}), region([], ['ab', 'bc', 'cd']))).toEqual(['region-open@outer']);
    expect(at(withHoles({}), region([], ['ab', 'cd', 'bc', 'da']))).toEqual([
      'region-open@outer[1]',
    ]);
    const bow = free({ a: [0, 0], b: [10, 10], c: [10, 0], d: [0, 10] }, squareLines);
    expect(at(bow, region())).toEqual(['region-self-intersection@outer[0]']);
    expect(at(withHoles({ h: [20, 5, 2] }), region([['h']]))).toEqual([
      'region-hole-outside@holes[0]',
    ]);
    expect(at(withHoles({ h: [9, 5, 2] }), region([['h']]))).toEqual(['region-overlap@outer[1]']);
    expect(at(withHoles({ h: [5, 5, 3], g: [5, 5, 1] }), region([['h'], ['g']]))).toEqual([
      'region-hole-nested@holes[1]',
    ]);
    expect(at(withHoles({ h: [5, 5, 3] }), region([['h'], ['h']]))).toEqual([
      'region-element@holes[1][0]',
    ]);
    const construction = free(square, [...squareLines.slice(0, 3), line('da', 'd', 'a', true)]);
    expect(at(construction, region())).toEqual(['region-element@outer[3]']);
    expect(at(withHoles({}), region([], ['ab', 'bc', 'cd', 'a']))).toEqual([
      'region-element@outer[3]',
    ]);
    const spike = free({ ...square, e: [5, 0] }, [
      line('ab', 'a', 'b'),
      line('be', 'b', 'e'),
      line('eb', 'e', 'c'),
      line('cd', 'c', 'd'),
      line('da', 'd', 'a'),
    ]);
    expect(at(spike, region([], ['ab', 'be', 'eb', 'cd', 'da']))).toEqual([
      'region-self-intersection@outer[0]',
    ]);
    // A hole that shares a corner point with the outer loop touches it.
    const corner = free({ ...square, e: [5, 3], f: [3, 5] }, [
      ...squareLines,
      line('ae', 'a', 'e'),
      line('ef', 'e', 'f'),
      line('fa', 'f', 'a'),
    ]);
    expect(at(corner, region([['ae', 'ef', 'fa']]))).toEqual(['region-overlap@outer[0]']);
  });
  it('winds around arcs exactly', () => {
    const dome = (hole: [number, number]) =>
      free(
        { a: [0, 0], b: [20, 0], o: [10, 0], m: hole },
        [
          line('ab', 'a', 'b'),
          { type: 'arc', id: 'ba', center: 'o', start: 'b', end: 'a', clockwise: false },
          { type: 'circle', id: 'h', center: 'm' },
        ],
        { h: 2 },
      );
    const r = { outer: ['ab', 'ba'], holes: [['h']] };
    expect(codes(sweep(dome([10, 5]), r))).toEqual([]);
    expect(codes(sweep(dome([10, -5]), r))).toEqual([
      'region-hole-outside@$.features[0].args.region.holes[0]',
    ]);
    expect(codes(sweep(dome([10, 8.5]), r))).toEqual([
      'region-overlap@$.features[0].args.region.outer[1]',
    ]);
    // A circle drawn as two half arcs: the hole's sample point lies on their common chord.
    const halves = free(
      { p: [10, 0], q: [-10, 0], o: [0, 0], m: [0, 0] },
      [
        { type: 'arc', id: 'top', center: 'o', start: 'p', end: 'q', clockwise: false },
        { type: 'arc', id: 'bottom', center: 'o', start: 'q', end: 'p', clockwise: false },
        { type: 'circle', id: 'h', center: 'm' },
      ],
      { h: 1 },
    );
    expect(codes(sweep(halves, { outer: ['top', 'bottom'], holes: [['h']] }))).toEqual([]);
  });
  it('refuses a revolve whose region crosses the axis, arcs included', () => {
    const sq = withHoles({});
    expect(codes(sweep(sq, region(), { origin: [0, 0], direction: [0, 1] }))).toEqual([]);
    expect(codes(sweep(sq, region(), { origin: [5, 0], direction: [0, 1] }))).toEqual([
      'revolve-crosses-axis@$.features[0].args',
    ]);
    const dome = free({ a: [0, 0], b: [20, 0], o: [10, 0] }, [
      line('ab', 'a', 'b'),
      { type: 'arc', id: 'ba', center: 'o', start: 'b', end: 'a', clockwise: false },
    ]);
    const r = { outer: ['ab', 'ba'], holes: [] };
    expect(codes(sweep(dome, r, { origin: [0, 0], direction: [1, 0] }))).toEqual([]);
    expect(codes(sweep(dome, r, { origin: [0, 9], direction: [1, 0] }))).toEqual([
      'revolve-crosses-axis@$.features[0].args',
    ]);
  });
  it('names a missing sketch', () => {
    const doc = exact();
    (doc.features[0].args as { sketchId: string }).sketchId = 'nope';
    expect(codes(doc)).toEqual(['sketch-missing@$.features[0].args.sketchId']);
  });
});

describe('sketch operations', () => {
  /** F11 with a square boss sketched on the bracket's end face and extruded 3 mm. */
  const bossOnBracket = () =>
    applyCadOperation(f11Bracket(), {
      type: 'insertFeatures',
      sketches: [
        {
          ...free({ ...square }, squareLines),
          id: 'top-sketch',
          plane: { face: faceRef('bracket-extrude', ['end'], [50, 10, 10], 100), offset: mm(0) },
        },
      ],
      features: [
        {
          id: 'boss',
          name: 'Boss',
          type: 'extrude',
          inputFeatureIds: [],
          args: {
            sketchId: 'top-sketch',
            region: { outer, holes: [] },
            distance: mm(3),
            direction: 1,
          },
        },
      ],
      bodies: [body('boss-body', 'boss')],
    });
  it('reads sketches into the dependency closure, faces they attach to included', () => {
    const doc = f11Bracket();
    expect(featureReads(doc.features[0]).sketches).toEqual(['bracket-sketch']);
    expect(() =>
      applyCadOperation(doc, { type: 'deleteClosure', ids: ['bracket-sketch'], cascade: false }),
    ).toThrow('delete-has-dependents');
    const gone = applyCadOperation(doc, {
      type: 'deleteClosure',
      ids: ['bracket-sketch'],
      cascade: true,
    });
    expect([gone.sketches, gone.features, gone.bodies].map((x) => x.length)).toEqual([0, 0, 0]);
    // A sketch on a face of the plate goes with the plate, and so does what sweeps it.
    const on = bossOnBracket();
    expect(validateCad(on)).toEqual([]);
    const closure = dependencyClosure(on, ['bracket-extrude']);
    expect([...closure.sketches]).toEqual(['top-sketch']);
    expect([...closure.features].sort()).toEqual(
      ['boss', 'boss-body-placement', 'bracket-extrude', 'bracket-placement'].sort(),
    );
  });
  it('edits a sketch in one solve and refuses a redundant constraint', () => {
    const doc = f11Bracket();
    const s = doc.sketches[0];
    const moved = applyCadOperation(doc, {
      type: 'updateSketch',
      sketchId: s.id,
      plane: s.plane,
      entities: s.entities,
      constraints: s.constraints.map((k) =>
        k.id === 'blend-r' ? { ...k, value: mm(5) } : k,
      ) as CadSketchConstraint[],
      solved: s.solved,
    });
    expect(
      near(moved.sketches[0].solved, { ...f11Solution, p3: [25, 20], c: [25, 25], p4: [20, 25] }),
    ).toBe(true);
    const r = f11Sketch('redundant');
    expect(() =>
      applyCadOperation(doc, {
        ...r,
        type: 'updateSketch',
        sketchId: r.id,
        solved: s.solved,
      } as never),
    ).toThrow('sketch-redundant-constraint');
    expect(() =>
      applyCadOperation(doc, {
        type: 'insertFeatures',
        sketches: [{ ...f11Sketch('conflict'), id: 'second' }],
        features: [],
      }),
    ).toThrow('sketch-conflicting-constraint');
    expect(() =>
      assertCadOperation({
        type: 'updateSketch',
        sketchId: s.id,
        plane: s.plane,
        entities: s.entities,
        constraints: s.constraints,
        solved: s.solved,
      }),
    ).not.toThrow();
    expect(compareCad(doc, moved).map((c) => c.path)).toEqual([
      'sketches.constraints',
      'sketches.solved',
    ]);
  });
  it('duplicates a body with its sketch, keeping element IDs', () => {
    const doc = f11Bracket();
    const { ids } = duplicateClosureOf(doc, ['bracket']);
    expect(ids).toContain('bracket-sketch');
    const copy = applyCadOperation(doc, {
      type: 'duplicateClosure',
      bodyIds: ['bracket'],
      idMap: Object.fromEntries(ids.map((id) => [id, `${id}-2`])),
    });
    expect(validateCad(copy)).toEqual([]);
    const [a, b] = copy.sketches;
    expect(b.id).toBe('bracket-sketch-2');
    expect(b.entities).toEqual(a.entities);
    expect(b.solved).toEqual(a.solved);
    expect(b.constraints.find((k) => k.id === 'width')).toEqual({
      id: 'width',
      type: 'horizontalDistance',
      a: 'p0',
      b: 'p1',
      value: { parameterId: 'W-2' },
    });
    expect(
      (copy.features.find((f) => f.id === 'bracket-extrude-2')!.args as { sketchId: string })
        .sketchId,
    ).toBe('bracket-sketch-2');
    const renamed = applyCadOperation(doc, {
      type: 'rename',
      targetId: 'bracket-sketch',
      name: 'Side',
    });
    expect(renamed.sketches[0].name).toBe('Side');
    expect(f11Region().outer).toHaveLength(7);
  });
  it('duplicates a body on a face with the features its sketch is attached to', () => {
    const doc = bossOnBracket();
    const { ids } = duplicateClosureOf(doc, ['boss-body']);
    // The face's features and what they read come too: the copy refers to nothing outside it.
    expect(ids).toEqual(
      expect.arrayContaining(['top-sketch', 'bracket-sketch', 'bracket-extrude', 'D', 'W']),
    );
    const copy = applyCadOperation(doc, {
      type: 'duplicateClosure',
      bodyIds: ['boss-body'],
      idMap: Object.fromEntries(ids.map((id) => [id, `${id}-2`])),
    });
    expect(validateCad(copy)).toEqual([]);
    const top = copy.sketches.find((s) => s.id === 'top-sketch-2')!;
    expect((top.plane as { face: { featureId: string } }).face.featureId).toBe('bracket-extrude-2');
    // Deleting the original bracket leaves the copied boss.
    const left = applyCadOperation(copy, {
      type: 'deleteClosure',
      ids: ['bracket'],
      cascade: true,
    });
    expect(left.bodies.map((b) => b.id)).toContain('boss-body-2');
  });
});

describe('sketch regions and frames for the kernel (R1d-2)', () => {
  it('measures a region exactly, either way round', () => {
    const s = { ...f11Sketch(), solved: { ...f11Solution } };
    const g = sketchRegion(s, f11Region());
    if ('code' in g) throw new Error(g.code);
    expect(regionArea(g)).toBeCloseTo(f11Area(), 9);
    expect(loopArea(g.loops[0]!)).toBeGreaterThan(0);
    const reversed = sketchRegion(s, { ...f11Region(), outer: [...f11Region().outer].reverse() });
    if ('code' in reversed) throw new Error(reversed.code);
    expect(loopArea(reversed.loops[0]!)).toBeCloseTo(-loopArea(g.loops[0]!), 9);
    expect(regionArea(reversed)).toBeCloseTo(f11Area(), 9);
  });

  it('frames a face by its plane: Z up on a side, X along on a top or bottom', () => {
    // Rotates local (1, 0, 0), (0, 1, 0) and (0, 0, 1) by the frame's quaternion.
    const axes = ({ orientation: [x, y, z, w] }: ReturnType<typeof attachFrame>) => {
      const rotate = (p: number[]) => {
        const [px, py, pz] = p as [number, number, number];
        const t = [2 * (y * pz - z * py), 2 * (z * px - x * pz), 2 * (x * py - y * px)];
        return [
          px + w * t[0]! + (y * t[2]! - z * t[1]!),
          py + w * t[1]! + (z * t[0]! - x * t[2]!),
          pz + w * t[2]! + (x * t[1]! - y * t[0]!),
        ].map((c) => Math.round(c * 1e9) / 1e9 + 0);
      };
      return [rotate([1, 0, 0]), rotate([0, 1, 0]), rotate([0, 0, 1])];
    };
    const top = attachFrame([70, 60, 10], [0, 0, 1], 2);
    expect(top.origin).toEqual([0, 0, 12]);
    expect(axes(top)).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    expect(axes(attachFrame([0, 0, 0], [0, 0, -1], 0))).toEqual([
      [1, 0, 0],
      [0, -1, 0],
      [0, 0, -1],
    ]);
    // Seen from outside the +y face, u runs along −X and v up Z.
    const side = attachFrame([70, 120, 5], [0, 2, 0], 0);
    expect(side.origin).toEqual([0, 120, 0]);
    expect(axes(side)).toEqual([
      [-1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ]);
    // A tilted face keeps a right-handed, unit frame with its normal as local Z.
    const n = [1, 2, 3].map((c) => c / Math.hypot(1, 2, 3));
    const tilted = axes(attachFrame([1, 1, 1], n as [number, number, number], 0));
    expect(tilted[2]!.map((c, i) => c - n[i]!).every((d) => Math.abs(d) < 1e-9)).toBe(true);
    expect(Math.hypot(...attachFrame([1, 1, 1], [1, 2, 3], 0).orientation)).toBeCloseTo(1, 12);
  });

  it('chooses the face a sketch is attached to again, in one operation', () => {
    const doc = f11OnPlate('+z');
    const ref = faceRef('plate-placement', ['-z'], [70, 60, 0], 140 * 120);
    const next = applyCadOperation(doc, {
      type: 'rebindReferences',
      bindings: [{ featureId: 'bracket-sketch', path: ['plane', 'face'], ref }],
    });
    expect(next.sketches[0]!.plane).toEqual({ face: ref, offset: mm(0) });
    expect(next.sketches[0]!.solved).toEqual(doc.sketches[0]!.solved);
    expect(() =>
      applyCadOperation(doc, {
        type: 'rebindReferences',
        bindings: [{ featureId: 'bracket-sketch', path: ['plane', 'offset'], ref }],
      }),
    ).toThrow('rebind-path');
  });

  it('accepts a sketch attached to a plate and orders it after the plate', () => {
    for (const face of ['+z', '+y'] as const) {
      const doc = f11OnPlate(face);
      expect(codes(doc)).toEqual([]);
      const graph = dependencyOrder(doc);
      if ('cycle' in graph) throw new Error('cycle');
      const at = (id: string) => graph.order.indexOf(id);
      expect(at('plate-placement')).toBeLessThan(at('bracket-sketch'));
      expect(at('bracket-sketch')).toBeLessThan(at('bracket-extrude'));
    }
  });
});

describe('the region a drawing closes (R1d-3, Sketch mode)', () => {
  const solvedF11 = (): CadSketch => ({ ...f11Sketch(), solved: { ...f11Solution } });
  const sameLoop = (a: string[], b: string[]) => expect([...a].sort()).toEqual([...b].sort());

  it('finds the outer loop and the holes of F11', () => {
    const region = sketchDefaultRegion(solvedF11())!;
    sameLoop(region.outer, f11Region().outer);
    expect(region.holes.map((h) => h.join())).toEqual(expect.arrayContaining(['h1', 'h2']));
    expect(region.holes).toHaveLength(2);
    const g = sketchRegion(solvedF11(), region);
    expect('code' in g ? g : regionArea(g)).toBeCloseTo(f11Area(), 6);
  });

  it('leaves out open chains, branches and construction elements', () => {
    const s = solvedF11();
    const open = { ...s, entities: s.entities.filter((e) => e.id !== 'l3') };
    // Without l3 the outline is open: the largest closed loop left is a hole circle.
    expect(sketchDefaultRegion(open)?.outer).toHaveLength(1);
    const branched: CadSketch = {
      ...s,
      entities: [
        ...s.entities,
        { type: 'point', id: 'px' },
        { type: 'line', id: 'lx', start: 'p0', end: 'px' },
      ],
      solved: { ...s.solved, px: [-10, -10] },
    };
    expect(sketchDefaultRegion(branched)?.outer).toHaveLength(1);
    const construction: CadSketch = {
      ...s,
      entities: s.entities.map((e) => (e.type === 'circle' ? { ...e, construction: true } : e)),
    };
    expect(sketchDefaultRegion(construction)?.holes).toEqual([]);
    const empty: CadSketch = { ...s, entities: [], constraints: [], solved: {} };
    expect(sketchDefaultRegion(empty)).toBeUndefined();
  });
});
