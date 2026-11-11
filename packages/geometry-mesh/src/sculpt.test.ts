import { describe, expect, it } from 'vitest';
import {
  boxMesh,
  multiresBase,
  multiresDisplacementsFrom,
  multiresFrames,
  multiresPositions,
  sculptSegment,
  sculptTriangles,
  SculptSurface,
  type SculptBrush,
} from './index';

/** A 200 mm box at multires level 4 (its top at z ≈ 100 after smoothing). */
function surface() {
  const base = multiresBase(boxMesh([200, 200, 200]), 4);
  return { base, s: new SculptSurface(base.positions, base.quads) };
}
const brush = (kind: SculptBrush['kind'], more: Partial<SculptBrush> = {}): SculptBrush => ({
  kind,
  radius: 40,
  strength: 1,
  invert: false,
  symmetry: false,
  ...more,
});
const at = (p: Float32Array, v: number) => [p[3 * v], p[3 * v + 1], p[3 * v + 2]];
/** The vertex nearest a point. */
function nearest(p: Float32Array, q: number[]) {
  let best = 0,
    d = Infinity;
  for (let v = 0; v < p.length / 3; v++) {
    const e = Math.hypot(p[3 * v] - q[0], p[3 * v + 1] - q[1], p[3 * v + 2] - q[2]);
    if (e < d) {
      d = e;
      best = v;
    }
  }
  return best;
}

describe('sculpt brushes (C7b, TS-1276)', () => {
  it('Draw raises the surface under the brush, most at the middle; Shift lowers it', () => {
    const { s } = surface();
    const before = s.positions.slice();
    const top = nearest(before, [0, 0, 200]);
    const c = at(before, top) as [number, number, number];
    const change = s.dab(c, brush('draw'));
    expect(change.vertices.length).toBeGreaterThan(4);
    const lift = s.positions[3 * top + 2] - before[3 * top + 2];
    expect(lift).toBeCloseTo(4, 1); // a tenth of the radius at full strength
    // Further out, less; outside the radius, nothing.
    for (let v = 0; v < s.vertexCount; v++) {
      const d = Math.hypot(
        before[3 * v] - c[0],
        before[3 * v + 1] - c[1],
        before[3 * v + 2] - c[2],
      );
      const moved = Math.hypot(...[0, 1, 2].map((k) => s.positions[3 * v + k] - before[3 * v + k]));
      if (d > 40) expect(moved).toBe(0);
      else expect(moved).toBeLessThanOrEqual(lift + 1e-6);
    }
    expect(change.first).toBeLessThanOrEqual(Math.min(...change.vertices));
    expect(change.last).toBeGreaterThanOrEqual(Math.max(...change.vertices));
    // Normals stay unit length and lean out of the bump.
    for (const v of change.vertices) expect(Math.hypot(...at(s.normals, v))).toBeCloseTo(1, 5);
    s.dab(c, brush('draw', { invert: true }));
    // Back near where it was (the area's normal leans a little after the first dab).
    expect(Math.abs(s.positions[3 * top + 2] - before[3 * top + 2])).toBeLessThan(0.2);
  });

  it('Inflate, Smooth, Pinch and Flatten', () => {
    const { s } = surface();
    const before = s.positions.slice();
    const top = nearest(before, [0, 0, 200]);
    const c = at(before, top) as [number, number, number];
    s.dab(c, brush('inflate'));
    expect(s.positions[3 * top + 2]).toBeGreaterThan(before[3 * top + 2] + 3);
    // Smooth pulls a raised point back toward its neighbours.
    const high = s.positions[3 * top + 2];
    s.dab(c, brush('smooth', { radius: 10 }));
    expect(s.positions[3 * top + 2]).toBeLessThan(high);
    // Pinch draws points toward the middle along the surface.
    const { s: p } = surface();
    const side = nearest(before, [25, 0, 200]);
    const d0 = Math.hypot(before[3 * side] - c[0], before[3 * side + 1] - c[1]);
    p.dab(c, brush('pinch'));
    expect(Math.hypot(p.positions[3 * side] - c[0], p.positions[3 * side + 1] - c[1])).toBeLessThan(
      d0,
    );
    // Flatten takes a bump back toward the plane around it.
    const { s: f } = surface();
    f.dab(c, brush('draw', { radius: 20 }));
    const bump = f.positions[3 * top + 2];
    f.dab(c, brush('flatten', { radius: 40 }));
    expect(f.positions[3 * top + 2]).toBeLessThan(bump);
  });

  it('mirrors across x = 0, holds masked vertices, and fills a fast drag', () => {
    const { s } = surface();
    const before = s.positions.slice();
    const right = nearest(before, [50, 0, 200]);
    const left = nearest(before, [-50, 0, 200]);
    s.dab(at(before, right) as [number, number, number], brush('draw', { symmetry: true }));
    const lr = s.positions[3 * right + 2] - before[3 * right + 2];
    const ll = s.positions[3 * left + 2] - before[3 * left + 2];
    expect(lr).toBeGreaterThan(1);
    expect(ll).toBeCloseTo(lr, 2);
    const { s: m } = surface();
    const mask = new Float32Array(m.vertexCount);
    mask[right] = 1;
    m.dab(at(before, right) as [number, number, number], brush('draw'), mask);
    expect(m.positions[3 * right + 2]).toBe(before[3 * right + 2]);
    // A drag 120 mm long moves the points all along it.
    const { s: d } = surface();
    const a = at(before, nearest(before, [-60, 0, 200])) as [number, number, number];
    const b = at(before, nearest(before, [60, 0, 200])) as [number, number, number];
    sculptSegment(d, a, b, brush('draw', { radius: 20 }));
    const mid = nearest(before, [0, 0, 200]);
    expect(d.positions[3 * mid + 2]).toBeGreaterThan(before[3 * mid + 2] + 1);
    expect(() => d.dab(a, brush('draw', { radius: 0 }))).toThrow();
  });

  it('keeps a mirrored dab symmetric where both sides overlap (from the same starting shape)', () => {
    for (const kind of ['pinch', 'smooth', 'draw', 'flatten'] as const) {
      const { s } = surface();
      const before = s.positions.slice();
      const c = at(before, nearest(before, [10, 0, 200])) as [number, number, number];
      s.dab(c, brush(kind, { symmetry: true }));
      for (let v = 0; v < s.vertexCount; v++) {
        const [x, y, z] = at(before, v);
        if (Math.abs(z - before[3 * nearest(before, [0, 0, 200]) + 2]) > 30) continue;
        const m = nearest(before, [-x, y, z]);
        expect(s.positions[3 * m]).toBeCloseTo(-s.positions[3 * v], 3);
        expect(s.positions[3 * m + 2]).toBeCloseTo(s.positions[3 * v + 2], 3);
      }
    }
  });

  it('finds vertices that dabs moved far from where the stroke started', () => {
    const { s } = surface();
    const before = s.positions.slice();
    const top = nearest(before, [0, 0, 200]);
    const c = at(before, top) as [number, number, number];
    s.refresh();
    // Many full-strength dabs at the moving top: it rises well past one grid cell.
    let p = c;
    for (let k = 0; k < 40; k++) {
      s.dab(p, brush('inflate', { radius: 40 }));
      p = at(s.positions, top) as [number, number, number];
    }
    const rise = s.positions[3 * top + 2] - before[3 * top + 2];
    expect(rise).toBeGreaterThan(40);
    let found = false;
    s.near(p, 1, (v) => (found ||= v === top));
    expect(found).toBe(true);
    const hit = s.raycast([p[0], p[1], p[2] + 500], [0, 0, -1])!;
    expect(Math.abs(s.positions[3 * hit + 2] - p[2])).toBeLessThan(5);
  });

  it('finds vertices a Grab dragged far once the drag is over (the grid waits for a query) (C7f, TS-1290)', () => {
    const { s } = surface();
    const before = s.positions.slice();
    const top = nearest(before, [0, 0, 200]);
    const c = at(before, top) as [number, number, number];
    const g = s.grab(c, 40);
    for (let z = 10; z <= 120; z += 10) g.move([0, 0, z]);
    const p = at(s.positions, top) as [number, number, number];
    expect(p[2] - before[3 * top + 2]).toBeCloseTo(120, 3);
    let found = false;
    s.near(p, 1, (v) => (found ||= v === top));
    expect(found).toBe(true);
    const hit = s.raycast([p[0], p[1], p[2] + 500], [0, 0, -1])!;
    expect(Math.abs(s.positions[3 * hit + 2] - p[2])).toBeLessThan(5);
  });

  it('finds where a ray first meets the surface, facing it', () => {
    const { s } = surface();
    const down = s.raycast([0, 0, 1000], [0, 0, -1])!;
    expect(s.positions[3 * down + 2]).toBeGreaterThan(50);
    const up = s.raycast([0, 0, -1000], [0, 0, 1])!;
    expect(s.positions[3 * up + 2]).toBeLessThan(-50);
    expect(s.raycast([1000, 1000, 1000], [0, 0, -1])).toBeUndefined();
    // From inside the box looking out, the faces point away: nothing is hit.
    expect(s.raycast([0, 0, 0], [0, 0, 1])).toBeUndefined();
  });

  it('a stroke reads back into displacements that give the same shape, naming its corner grids (C7f, TS-1290)', () => {
    const { base, s } = surface();
    const frames = multiresFrames(base);
    const before = s.positions.slice();
    s.dab(at(before, nearest(before, [0, 0, 200])) as [number, number, number], brush('draw'));
    const touched = s.takeTouched();
    expect(touched.size).toBeGreaterThan(0);
    expect(s.takeTouched().size).toBe(0);
    const zero = new Float32Array(3 * base.gridVertex.length);
    const corners = new Set<number>();
    const d = multiresDisplacementsFrom(base, frames, s.positions, zero.slice(), touched, corners);
    // The corner grids written: those holding a touched vertex (C7f), not all of them.
    const G2 = base.grid * base.grid;
    const expected = new Set<number>();
    base.gridVertex.forEach((v, g) => touched.has(v) && expected.add(Math.floor(g / G2)));
    expect(corners).toEqual(expected);
    expect(corners.size).toBeGreaterThan(0);
    expect(corners.size).toBeLessThan(base.corners);
    const shape = multiresPositions(base, frames, d);
    for (let i = 0; i < shape.length; i++) expect(shape[i]).toBeCloseTo(s.positions[i], 3);
    expect(sculptTriangles(new Uint32Array([0, 1, 2, 3]))).toEqual(
      new Uint32Array([0, 1, 2, 0, 2, 3]),
    );
  });

  it('times a dab when asked, with the same result as without (C7e, TS-1285)', () => {
    const plain = surface().s;
    const timed = surface().s;
    timed.timing = { brush: 0, apply: 0, settle: 0 };
    const c = at(plain.positions, nearest(plain.positions, [10, 0, 200])) as [
      number,
      number,
      number,
    ];
    for (const kind of ['draw', 'smooth', 'inflate'] as const) {
      const a = plain.dab(c, brush(kind, { symmetry: true }));
      const b = timed.dab(c, brush(kind, { symmetry: true }));
      expect(b).toEqual(a);
    }
    expect(timed.positions).toEqual(plain.positions);
    expect(timed.normals).toEqual(plain.normals);
    const t = timed.timing;
    expect(t.brush + t.apply + t.settle).toBeGreaterThan(0);
    expect(Math.min(t.brush, t.apply, t.settle)).toBeGreaterThanOrEqual(0);
    expect(plain.timing).toBeUndefined();
    // Grab: the same moves with and without.
    const ga = plain.grab(c, 40, undefined, true);
    const gb = timed.grab(c, 40, undefined, true);
    const settled = t.settle;
    for (const z of [5, 10, 15]) expect(gb.move([0, 0, z])).toEqual(ga.move([0, 0, z]));
    expect(timed.positions).toEqual(plain.positions);
    expect(t.settle).toBeGreaterThan(settled);
  });
});
