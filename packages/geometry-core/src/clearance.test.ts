import { describe, expect, it } from 'vitest';
import { closestOnSegments, closestOnTriangles, meshClearance } from './clearance';
import type { InterferenceMesh, InterferencePose, InterferenceVec3 } from './interference';

const still: InterferencePose = { rotation: [0, 0, 0, 1], translationMm: [0, 0, 0] };
/** An axis-aligned box, each face cut into cells of about `cell` mm. */
function box(lo: InterferenceVec3, hi: InterferenceVec3, cell = Infinity): InterferenceMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let axis = 0; axis < 3; axis++)
    for (const side of [0, 1]) {
      const u = (axis + 1) % 3;
      const v = (axis + 2) % 3;
      const nu = Math.max(1, Math.ceil((hi[u]! - lo[u]!) / cell));
      const nv = Math.max(1, Math.ceil((hi[v]! - lo[v]!) / cell));
      const base = positions.length / 3;
      for (let i = 0; i <= nu; i++)
        for (let j = 0; j <= nv; j++) {
          const p: InterferenceVec3 = [0, 0, 0];
          p[axis] = side ? hi[axis]! : lo[axis]!;
          p[u] = lo[u]! + ((hi[u]! - lo[u]!) * i) / nu;
          p[v] = lo[v]! + ((hi[v]! - lo[v]!) * j) / nv;
          positions.push(...p);
        }
      for (let i = 0; i < nu; i++)
        for (let j = 0; j < nv; j++) {
          const a = base + i * (nv + 1) + j;
          const b = a + nv + 1;
          indices.push(a, b, b + 1, a, b + 1, a + 1);
        }
    }
  return { positions: Float64Array.from(positions), indices: Uint32Array.from(indices) };
}
const near = (a: readonly number[], b: readonly number[]) =>
  a.forEach((v, k) => expect(v).toBeCloseTo(b[k]!, 9));

describe('clearance between posed meshes (CR7c, TS-1813)', () => {
  it('finds the closest points of segments and triangles', () => {
    const [p, q] = closestOnSegments([0, 0, 0], [10, 0, 0], [5, -5, 3], [5, 5, 3]);
    near(p, [5, 0, 0]);
    near(q, [5, 0, 3]);
    // Edge against edge, then a vertex over a face.
    const [a, b, d] = closestOnTriangles(
      [
        [0, 0, 0],
        [10, 0, 0],
        [0, 10, 0],
      ],
      [
        [2, 2, 4],
        [3, 3, 9],
        [2, 3, 9],
      ],
    );
    expect(d).toBeCloseTo(4, 9);
    near(a, [2, 2, 0]);
    near(b, [2, 2, 4]);
    // Crossing triangles are 0 apart.
    expect(
      closestOnTriangles(
        [
          [0, 0, 0],
          [10, 0, 0],
          [0, 10, 0],
        ],
        [
          [2, 2, -1],
          [3, 2, 1],
          [2, 3, 1],
        ],
      )[2],
    ).toBe(0);
  });

  it('measures the gap between two posed groups and where it runs', () => {
    // A 10 mm cube and a finely meshed 20 mm cube turned 90° about z and moved 25 mm along x:
    // its near face at x 25 − 0 … the gap from x 10 is 15 mm.
    const small = { meshes: [box([0, 0, 0], [10, 10, 10])], pose: still };
    const s = Math.SQRT1_2;
    const big = {
      meshes: [box([0, -20, 0], [20, 0, 20], 2)],
      pose: {
        rotation: [0, 0, s, s] as InterferencePose['rotation'],
        translationMm: [25, 0, 0] as InterferenceVec3,
      },
    };
    const r = meshClearance([small], [big])!;
    expect(r.distanceMm).toBeCloseTo(15, 9);
    expect(r.a[0]).toBeCloseTo(10, 9);
    expect(r.b[0]).toBeCloseTo(25, 9);
    expect(r.triangles).toEqual([12, 12 * 100]);
    // Two groups at once: the nearer piece decides.
    const nearer = {
      meshes: [box([0, 0, 0], [1, 1, 1])],
      pose: { ...still, translationMm: [20, 0, 0] as InterferenceVec3 },
    };
    expect(meshClearance([small], [big, nearer])!.distanceMm).toBeCloseTo(10, 9);
    // Overlapping boxes are 0 apart; an empty group has no clearance.
    expect(
      meshClearance([small], [{ meshes: [box([5, 5, 5], [15, 15, 15])], pose: still }])!.distanceMm,
    ).toBe(0);
    expect(meshClearance([small], [])).toBeUndefined();
  });

  it('refuses past the triangle limit before copying shared meshes into world coordinates', () => {
    // One 120,000-triangle mesh placed 20 times shares its arrays: counted, not copied.
    const big = box([0, 0, 0], [100, 100, 100], 1);
    const many = Array.from({ length: 20 }, () => ({ meshes: [big], pose: still }));
    expect(() =>
      meshClearance(many, [{ meshes: [box([0, 0, 0], [1, 1, 1])], pose: still }]),
    ).toThrow('clearance-limit');
  });
});
