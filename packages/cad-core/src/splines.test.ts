import { describe, expect, it } from 'vitest';
import { f16Reference, f16Sketch, f16Spline } from './fixtures';
import { parameterValues } from './graph';
import type { CadDocument } from './model';
import { applyCadOperation } from './operations';
import {
  loopArea,
  sketchDefaultPath,
  sketchDefaultRegion,
  sketchElement,
  sketchPath,
  sketchRegion,
  solveSketch,
  splineKnots,
  splinePoints,
  type CadSketch,
} from './sketch';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);
const withSketch = (s: CadSketch) => {
  const doc = structuredClone(f16Spline()) as CadDocument;
  doc.sketches[0] = s;
  return doc;
};
type Loose = Record<string, unknown>;
const spline = (s: CadSketch) => s.entities.find((e) => e.id === 'sp') as unknown as Loose;

describe('sketch splines (R2a-2, CAD40)', () => {
  it('knots: uniform and clamped when open, all simple when closed', () => {
    expect(splineKnots(5, 3, false)).toEqual({ knots: [0, 1, 2], mults: [4, 1, 4] });
    expect(splineKnots(6, 5, false)).toEqual({ knots: [0, 1], mults: [6, 6] });
    expect(splineKnots(4, 2, true)).toEqual({ knots: [0, 1, 2, 3, 4], mults: [1, 1, 1, 1, 1] });
  });

  it('samples the curve from its control points, ends exactly on the end poles', () => {
    const poles: [number, number][] = [
      [0, 0],
      [20, 0],
      [40, 30],
      [60, 0],
      [80, 0],
    ];
    const pts = splinePoints(poles, 3, false);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts.at(-1)).toEqual([80, 0]);
    // Symmetric poles: the middle of the curve is on the axis of symmetry, at 3/4 × 30 / 2.
    const mid = pts[(pts.length - 1) / 2]!;
    expect(mid[0]).toBeCloseTo(40, 9);
    expect(mid[1]).toBeCloseTo(15, 9);
    // A closed one comes back to where it started.
    const ring = splinePoints(poles.slice(0, 4), 3, true);
    expect(ring[0]![0]).toBeCloseTo(ring.at(-1)![0], 9);
    expect(ring[0]![1]).toBeCloseTo(ring.at(-1)![1], 9);
  });

  it('F16 is valid and fully constrained, its control points held by the constraints', () => {
    const doc = f16Spline();
    expect(codes(doc)).toEqual([]);
    const s = f16Sketch();
    expect(solveSketch(s, parameterValues(doc)).dof).toBe(0);
    // Without the fixed top point it may move both ways.
    const loose = { ...s, constraints: s.constraints.filter((k) => k.id !== 'top') };
    expect(solveSketch(loose, parameterValues(doc)).dof).toBe(2);
    // A rough guess solves to the same control points.
    const guess = structuredClone(s);
    Object.assign(guess.solved, { p1: [17, 2], p3: [63, -1] });
    const { solved } = solveSketch(guess, parameterValues(doc));
    expect(solved.p1![0]).toBeCloseTo(20, 6);
    expect(solved.p1![1]).toBeCloseTo(0, 6);
    expect(solved.p3![0]).toBeCloseTo(60, 6);
  });

  it('a dimension moves the control points, and the ends stay level', () => {
    const doc = applyCadOperation(f16Spline(), {
      type: 'setParameter',
      parameterId: 'L',
      value: 30,
    });
    expect(codes(doc)).toEqual([]);
    const { solved } = doc.sketches[0]!;
    expect(solved.p1![0]).toBeCloseTo(30, 6);
    expect(solved.p1![1]).toBeCloseTo(0, 6);
    expect(solved.p3![0]).toBeCloseTo(50, 6);
    expect(solved.p3![1]).toBeCloseTo(0, 6);
  });

  it('closes a region and makes a path; the sampled area is near the exact one', () => {
    const s = f16Sketch();
    const g = sketchRegion(s, { outer: ['sp', 'base'], holes: [] });
    if ('code' in g) throw new Error(g.code);
    // Exact area 510 mm² (f16Reference); the sampled polygon is within 0.5 %.
    expect(f16Reference().area).toBeCloseTo(510, 9);
    expect(Math.abs(Math.abs(loopArea(g.loops[0]!)) / 510 - 1)).toBeLessThan(0.005);
    expect(sketchDefaultRegion(s)).toEqual({ outer: ['sp', 'base'], holes: [] });
    const path = sketchPath(s, ['sp'], 'refuse');
    expect('code' in path).toBe(false);
    const open = { ...s, entities: s.entities.filter((e) => e.id !== 'base') };
    expect(sketchDefaultPath(open)).toEqual(['sp']);
    // A closed spline is a loop alone, like a circle.
    const ring = structuredClone(s);
    ring.entities = ring.entities.filter((e) => e.id !== 'base');
    Object.assign(spline(ring), { closed: true, poles: ['p0', 'p1', 'p2', 'p3'] });
    expect(sketchElement(ring, 'sp')?.type).toBe('closedSpline');
    const loop = sketchRegion(ring, { outer: ['sp'], holes: [] });
    expect('code' in loop).toBe(false);
    expect(sketchDefaultRegion(ring)).toEqual({ outer: ['sp'], holes: [] });
  });

  it('refuses a crossing spline, too few control points, a bad degree and bad poles', () => {
    expect(codes(withSketch(f16Sketch('crossing')))).toEqual([
      'sketch-self-intersection@$.sketches[0].entities[5]',
    ]);
    expect(codes(withSketch(f16Sketch('few')))).toEqual([
      'sketch-spline-poles@$.sketches[0].entities[5].poles',
    ]);
    const changed = (change: (e: Loose) => void) => {
      const s = structuredClone(f16Sketch());
      change(spline(s));
      return codes(withSketch(s));
    };
    expect(changed((e) => (e.degree = 4))).toEqual([
      'sketch-spline-degree@$.sketches[0].entities[5].degree',
    ]);
    // Five control points are too few for degree 5.
    expect(changed((e) => (e.degree = 5))).toEqual([
      'sketch-spline-poles@$.sketches[0].entities[5].poles',
    ]);
    expect(changed((e) => (e.poles = ['p0', 'p1', 'p2', 'base', 'p4']))).toEqual([
      'sketch-reference@$.sketches[0].entities[5].poles[3]',
    ]);
    expect(changed((e) => (e.poles = ['p0', 'p1', 'p2', 'p1', 'p4']))).toEqual([
      'sketch-degenerate@$.sketches[0].entities[5]',
    ]);
    expect(changed((e) => (e.closed = 'yes'))).toEqual([
      'sketch-entity@$.sketches[0].entities[5].closed',
    ]);
    expect(changed((e) => (e.weights = [1, 1, 1, 1, 1]))).toEqual([
      'unknown-field@$.sketches[0].entities[5].weights',
    ]);
    expect(
      changed((e) => (e.poles = Array.from({ length: 257 }, (_, i) => `p${i % 5}`))),
    ).toContain('sketch-spline-poles@$.sketches[0].entities[5].poles');
  });

  it('finds a line that doubles back along a spline from their joint', () => {
    const pts: Record<string, [number, number]> = {
      q: [10, 0],
      p0: [0, 0],
      p1: [100, 0],
      p2: [200, 0],
      p3: [300, 0],
    };
    const s: CadSketch = {
      ...f16Sketch(),
      entities: [
        ...Object.keys(pts).map((id) => ({ type: 'point' as const, id })),
        { type: 'line', id: 'back', start: 'q', end: 'p0' },
        { type: 'spline', id: 'sp', poles: ['p0', 'p1', 'p2', 'p3'], degree: 3 },
      ],
      constraints: [],
      solved: pts,
    };
    const g = sketchPath(s, ['back', 'sp'], 'refuse');
    expect('code' in g && g.code).toBe('sweep-path-self-intersection');
    // Turning away at the joint is no overlap.
    const turned = { ...s, solved: { ...pts, q: [-10, 5] as [number, number] } };
    expect('code' in sketchPath(turned, ['back', 'sp'], 'refuse')).toBe(false);
  });

  it('refuses a spline that folds back on itself between neighbouring samples', () => {
    const s = structuredClone(f16Sketch());
    s.constraints = [];
    Object.assign(s.solved, { p0: [0, 0], p1: [100, 0], p2: [101, 0], p3: [98.5, 0] });
    Object.assign(spline(s), { poles: ['p0', 'p1', 'p2', 'p3'] });
    s.entities = s.entities.filter((e) => e.id !== 'base' && e.id !== 't1');
    expect(codes(withSketch(s))).toContain('sketch-self-intersection@$.sketches[0].entities[5]');
  });

  it('refuses control points on top of each other', () => {
    const s = structuredClone(f16Sketch());
    s.constraints = [];
    s.solved.p3 = [40, 29.9999];
    expect(codes(withSketch(s))).toEqual(['sketch-degenerate@$.sketches[0].entities[5]']);
  });
});
