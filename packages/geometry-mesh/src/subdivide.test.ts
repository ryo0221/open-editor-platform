import { describe, expect, it } from 'vitest';
import {
  boxMesh,
  decodeEpm,
  encodeEpm,
  editInput,
  meshBounds,
  meshEdges,
  MeshEditError,
  meshTopology,
  setEdgeCreases,
  deleteFaces,
  subdivideMesh,
  subdividedFaceCount,
  type EpmMesh,
} from './index';

const refused = (fn: () => unknown, problem: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MeshEditError);
    expect((e as MeshEditError).problem).toBe(problem);
    return;
  }
  throw new Error('not refused');
};
const euler = (m: EpmMesh) =>
  m.positions.length / 3 - meshEdges(m, meshTopology(m)).length + m.faceSizes.length;
const radius = (m: EpmMesh, v: number) =>
  Math.hypot(m.positions[3 * v], m.positions[3 * v + 1], m.positions[3 * v + 2]);

describe('Catmull-Clark subdivision (TS-1221)', () => {
  it('a box at level 1: 26 vertices, 24 quads, the known Catmull-Clark positions', () => {
    const m = subdivideMesh(boxMesh([2, 2, 2]), 1);
    expect(m.positions.length / 3).toBe(26);
    expect(m.faceSizes.length).toBe(24);
    expect([...m.faceSizes].every((n) => n === 4)).toBe(true);
    expect(euler(m)).toBe(2);
    // Cube corner (1,1,1), valence 3: Q = (2/3)·(1,1,1)·… → (5/9, 5/9, 5/9).
    const corners = [...Array(26).keys()].filter((v) =>
      [0, 1, 2].every((k) => Math.abs(Math.abs(m.positions[3 * v + k]) - 5 / 9) < 1e-5),
    );
    expect(corners).toHaveLength(8);
    // Face points stay at the face centres; edge points at (3/4, 3/4, 0).
    const edges = [...Array(26).keys()].filter((v) => {
      const a = [0, 1, 2].map((k) => Math.abs(m.positions[3 * v + k])).sort();
      return Math.abs(a[0]) < 1e-6 && Math.abs(a[1] - 0.75) < 1e-6 && Math.abs(a[2] - 0.75) < 1e-6;
    });
    expect(edges).toHaveLength(12);
  });
  it('converges toward a smooth shape: level 3 is closer to round than level 1', () => {
    const spread = (m: EpmMesh) => {
      const r = [...Array(m.positions.length / 3).keys()].map((v) => radius(m, v));
      return Math.max(...r) / Math.min(...r);
    };
    const l1 = subdivideMesh(boxMesh([2, 2, 2]), 1),
      l3 = subdivideMesh(boxMesh([2, 2, 2]), 3);
    expect(l3.faceSizes.length).toBe(384);
    expect(spread(l3)).toBeLessThan(spread(l1));
    expect(euler(l3)).toBe(2);
    expect(decodeEpm(encodeEpm(l3)).faceSizes.length).toBe(384);
  });
  it('a crease of 1 keeps an edge sharp at every level', () => {
    const creased = setEdgeCreases(
      editInput(boxMesh([2, 2, 2])),
      [
        [4, 5],
        [5, 7],
        [7, 6],
        [6, 4],
      ],
      1,
    );
    const m = subdivideMesh(creased, 2);
    // The top ring stays on z = 1 along the creased square's edges.
    const top = [...Array(m.positions.length / 3).keys()].filter(
      (v) => Math.abs(m.positions[3 * v + 2] - 1) < 1e-6,
    );
    expect(top.length).toBeGreaterThan(9);
    expect(meshBounds(m)!.max[2]).toBeCloseTo(1);
    expect(m.creases!.values.length).toBe(16);
    // A half crease puts the edge point half-way between the smooth one (z 0.75) and the edge.
    const half = setEdgeCreases(editInput(boxMesh([2, 2, 2])), [[4, 5]], 0.5);
    const h = subdivideMesh(half, 1);
    const ep = [...Array(26).keys()].find(
      (v) =>
        Math.abs(h.positions[3 * v]) < 1e-6 &&
        h.positions[3 * v + 1] < -0.8 &&
        h.positions[3 * v + 2] > 0.5,
    )!;
    expect(h.positions[3 * ep + 1]).toBeCloseTo(-0.875);
    expect(h.positions[3 * ep + 2]).toBeCloseTo(0.875);
  });
  it('keeps borders: an open box keeps its rim and a single quad its corners', () => {
    const open = deleteFaces(editInput(boxMesh([2, 2, 2])), [1]);
    const m = subdivideMesh(open, 2);
    expect(meshTopology(m).twin.filter((x) => x < 0).length).toBe(16);
    const quad: EpmMesh = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      faceSizes: new Uint32Array([4]),
      faceIndices: new Uint32Array([0, 1, 2, 3]),
      faceMaterials: new Uint16Array(1),
      boneIds: [],
      morphs: [],
    };
    const q = subdivideMesh(quad, 1);
    expect(meshBounds(q)).toEqual({ min: [0, 0, 0], max: [1, 1, 0] });
  });
  it('carries UVs, weights, morphs and materials', () => {
    const src = boxMesh([2, 2, 2]);
    src.uvs = new Float32Array(48).map((_, i) => (i % 2 ? 0.5 : 0.25));
    src.faceMaterials = new Uint16Array([0, 1, 0, 1, 0, 1]);
    src.boneIds = ['a', 'b'];
    src.weights = {
      offsets: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]),
      bones: new Uint16Array([0, 0, 0, 0, 1, 1, 1, 1]),
      values: new Float32Array(8).fill(1),
    };
    src.morphs = [{ id: 'up', deltas: new Float32Array(24).map((_, i) => (i % 3 === 2 ? 1 : 0)) }];
    const m = subdivideMesh(src, 1);
    expect(m.uvs!.every((x, i) => Math.abs(x - (i % 2 ? 0.5 : 0.25)) < 1e-6)).toBe(true);
    expect(m.faceMaterials.filter((x) => x === 1)).toHaveLength(12);
    // A middle vertex blends both bones.
    let mixed = 0;
    for (let v = 0; v < 26; v++)
      if (m.weights!.offsets[v + 1] - m.weights!.offsets[v] === 2) mixed++;
    expect(mixed).toBeGreaterThan(0);
    // A constant morph stays constant (the stencils sum to 1).
    for (let v = 0; v < 26; v++) expect(m.morphs[0].deltas[3 * v + 2]).toBeCloseTo(1);
  });
  it('checks the face count first and refuses bad levels', () => {
    expect(subdividedFaceCount(boxMesh([1, 1, 1]), 0)).toBe(6);
    expect(subdividedFaceCount(boxMesh([1, 1, 1]), 4)).toBe(1536);
    expect(subdivideMesh(boxMesh([1, 1, 1]), 0).faceSizes.length).toBe(6);
    refused(() => subdivideMesh(boxMesh([1, 1, 1]), 5), 'selection');
    refused(() => subdivideMesh(boxMesh([1, 1, 1]), 1.5), 'selection');
    // A mesh whose level-4 face count is past the limit is refused before any work.
    const many: EpmMesh = { ...boxMesh([1, 1, 1]) };
    Object.defineProperty(many, 'faceIndices', { value: new Uint32Array(20_000) });
    refused(() => subdivideMesh(many, 4), 'limit');
  });
});
