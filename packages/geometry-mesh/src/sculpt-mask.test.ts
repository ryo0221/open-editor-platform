import { describe, expect, it } from 'vitest';
import { boxMesh, multiresBase, multiresDisplayVertices, SculptSurface } from './index';

function surface() {
  const base = multiresBase(boxMesh([200, 200, 200]), 4);
  return { base, s: new SculptSurface(base.positions, base.quads) };
}
const at = (p: Float32Array, v: number): [number, number, number] => [
  p[3 * v],
  p[3 * v + 1],
  p[3 * v + 2],
];
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

describe('sculpt mask, Grab and display level (C7c, TS-1278)', () => {
  it('paints and erases the mask with the falloff and mirror; positions stay', () => {
    const { s } = surface();
    const before = s.positions.slice();
    const mask = new Float32Array(s.vertexCount);
    const right = nearest(before, [50, 0, 200]);
    const left = nearest(before, [-50, 0, 200]);
    const c = s.maskDab(mask, at(before, right), 30, 1, false, true);
    expect(c.vertices.length).toBeGreaterThan(2);
    expect(mask[right]).toBeCloseTo(1, 5);
    expect(mask[left]).toBeCloseTo(1, 2);
    expect(s.positions).toEqual(before);
    // Outside the radius nothing; within, between 0 and 1.
    for (let v = 0; v < s.vertexCount; v++) {
      expect(mask[v]).toBeGreaterThanOrEqual(0);
      expect(mask[v]).toBeLessThanOrEqual(1);
    }
    s.maskDab(mask, at(before, right), 30, 1, true, false);
    expect(mask[right]).toBe(0);
    expect(mask[left]).toBeGreaterThan(0.9);
    expect(() => s.maskDab(new Float32Array(3), at(before, right), 30, 1, false, false)).toThrow();
    expect(() => s.maskDab(mask, at(before, right), 0, 1, false, false)).toThrow();
  });

  it('Grab moves the held vertices by the drag, most at the middle, from where they started', () => {
    const { s } = surface();
    const before = s.positions.slice();
    const top = nearest(before, [0, 0, 200]);
    const g = s.grab(at(before, top), 40);
    expect(g.vertices).toBeGreaterThan(4);
    g.move([0, 0, 10]);
    const c = g.move([0, 0, 20]); // absolute: not 30
    expect(s.positions[3 * top + 2] - before[3 * top + 2]).toBeCloseTo(20, 4);
    expect(c.vertices).toContain(top);
    for (let v = 0; v < s.vertexCount; v++) {
      const dz = s.positions[3 * v + 2] - before[3 * v + 2];
      expect(dz).toBeLessThanOrEqual(20 + 1e-4);
      expect(s.positions[3 * v]).toBe(before[3 * v]);
    }
    expect(s.takeTouched().has(top)).toBe(true);
    // Back to the start: every vertex where it was.
    g.move([0, 0, 0]);
    for (let i = 0; i < before.length; i++) expect(s.positions[i]).toBeCloseTo(before[i], 4);
  });

  it('Grab holds masked vertices and mirrors the drag across x = 0', () => {
    const { s } = surface();
    const before = s.positions.slice();
    const right = nearest(before, [50, 0, 200]);
    const left = nearest(before, [-50, 0, 200]);
    const mask = new Float32Array(s.vertexCount);
    mask[right] = 1;
    s.grab(at(before, right), 30, mask, true).move([10, 0, 5]);
    expect(s.positions[3 * right + 2]).toBe(before[3 * right + 2]);
    // The mirrored side moves the other way in x, the same in z.
    expect(s.positions[3 * left] - before[3 * left]).toBeCloseTo(-10, 3);
    expect(s.positions[3 * left + 2] - before[3 * left + 2]).toBeCloseTo(5, 3);
    // From the mirror plane itself: the middle stays on it and moves no further than the drag.
    const { s: c } = surface();
    const g = c.grab(at(before, nearest(before, [0, 0, 200])), 40, undefined, true);
    const mid0 = nearest(before, [0, 0, 200]);
    g.move([10, 0, 8]);
    expect(c.positions[3 * mid0]).toBeCloseTo(before[3 * mid0], 4);
    expect(c.positions[3 * mid0 + 2] - before[3 * mid0 + 2]).toBeCloseTo(8, 3);
    for (let v = 0; v < c.vertexCount; v++) {
      const [x, y, z] = at(before, v);
      const m = nearest(before, [-x, y, z]);
      expect(c.positions[3 * m]).toBeCloseTo(-c.positions[3 * v], 3);
      expect(c.positions[3 * m + 2]).toBeCloseTo(c.positions[3 * v + 2], 3);
      expect(c.positions[3 * v + 2] - before[3 * v + 2]).toBeLessThanOrEqual(8 + 1e-3);
    }
    // A mask of another length is refused.
    expect(() => c.grab(at(before, mid0), 40, new Float32Array(3))).toThrow();
    // On the mirror plane the x pulls cancel.
    const { s: m } = surface();
    const mid = nearest(before, [0, 0, 200]);
    m.grab([10, 0, at(before, mid)[2]], 40, undefined, true).move([10, 0, 0]);
    expect(m.positions[3 * mid]).toBeCloseTo(before[3 * mid], 4);
  });

  it('shows a lower level with the top level positions at the same grid points', () => {
    const cage = boxMesh([200, 200, 200]);
    const top = multiresBase(cage, 4);
    for (const k of [1, 2, 3, 4]) {
      const lower = multiresBase(cage, k);
      const map = multiresDisplayVertices(top, lower);
      expect(map.length).toBe(lower.positions.length / 3);
      expect(new Set(map).size).toBe(map.length);
      // Every grid point of the lower level (not only each vertex's owner) lands on the top
      // level's vertex at the same grid point, and the place moves only by the extra smoothing.
      const s = 1 << (4 - k);
      for (let g = 0; g < lower.gridVertex.length; g++) {
        const c = Math.floor(g / lower.grid ** 2),
          j = Math.floor((g % lower.grid ** 2) / lower.grid),
          i = g % lower.grid;
        const t = top.gridVertex[c * top.grid ** 2 + j * s * top.grid + i * s];
        expect(map[lower.gridVertex[g]]).toBe(t);
        const lv = at(lower.positions, lower.gridVertex[g]),
          tv = at(top.positions, t);
        const cos =
          (lv[0] * tv[0] + lv[1] * tv[1] + lv[2] * tv[2]) / (Math.hypot(...lv) * Math.hypot(...tv));
        expect(cos).toBeGreaterThan(0.97);
      }
    }
    expect(multiresDisplayVertices(top, top)).toEqual(
      Uint32Array.from(top.positions.keys()).slice(0, top.positions.length / 3),
    );
    expect(() => multiresDisplayVertices(multiresBase(cage, 2), top)).toThrow();
  });
});
