import { describe, expect, it } from 'vitest';
import {
  boxMesh,
  decodeEpm,
  deleteFaces,
  editInput,
  encodeEpm,
  epmLimits,
  extrudeFaces,
  faceNormal,
  insetFaces,
  meshBounds,
  meshEdges,
  MeshEditError,
  meshTopology,
  mergeVertices,
  setEdgeCreases,
  transformVertices,
  translateVertices,
  type EpmMesh,
} from './index';

/** A box with UVs, two bones and a morph, so every attribute is carried through edits. */
function attributedBox(): EpmMesh {
  const m = boxMesh([100, 100, 100]);
  m.uvs = new Float32Array(48).map((_, i) => (i % 4) / 4);
  const offsets = new Uint32Array(9);
  const bones: number[] = [];
  const values: number[] = [];
  for (let i = 0; i < 8; i++) {
    if (i & 4) {
      bones.push(1);
      values.push(1);
    } else {
      bones.push(0, 1);
      values.push(0.5, 0.5);
    }
    offsets[i + 1] = bones.length;
  }
  m.weights = { offsets, bones: new Uint16Array(bones), values: new Float32Array(values) };
  m.boneIds = ['hip', 'chest'];
  m.morphs = [{ id: 'puff', deltas: new Float32Array(24).fill(1) }];
  return m;
}
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
/** Euler characteristic V − E + F, 2 for a closed sphere-like mesh. */
const euler = (m: EpmMesh) =>
  m.positions.length / 3 - meshEdges(m, meshTopology(m)).length + m.faceSizes.length;
const closed = (m: EpmMesh) => meshTopology(m).twin.every((x) => x >= 0);
// +z face of boxMesh is face 1.
const TOP = 1;

describe('mesh topology (TS-1219)', () => {
  it('pairs every half-edge of a closed box', () => {
    const t = meshTopology(boxMesh([1, 1, 1]));
    expect(t.twin.every((x) => x >= 0)).toBe(true);
    expect(meshEdges(boxMesh([1, 1, 1]), t)).toHaveLength(12);
    expect(euler(boxMesh([1, 1, 1]))).toBe(2);
  });
  it('refuses an edge used twice in one direction and a vertex joining two fans', () => {
    const flipped = boxMesh([1, 1, 1]);
    flipped.faceIndices.set([1, 3, 2, 0], 0); // the -z face wound the wrong way
    refused(() => meshTopology(flipped), 'non-manifold');
    // Two triangles meeting only at vertex 0.
    const bowtie: EpmMesh = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1, 0]),
      faceSizes: new Uint32Array([3, 3]),
      faceIndices: new Uint32Array([0, 1, 2, 0, 3, 4]),
      faceMaterials: new Uint16Array(2),
      boneIds: [],
      morphs: [],
    };
    refused(() => meshTopology(bowtie), 'non-manifold');
    // Three faces on one edge.
    const fin: EpmMesh = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1]),
      faceSizes: new Uint32Array([3, 3, 3]),
      faceIndices: new Uint32Array([0, 1, 2, 1, 0, 3, 0, 1, 4]),
      faceMaterials: new Uint16Array(3),
      boneIds: [],
      morphs: [],
    };
    refused(() => meshTopology(fin), 'non-manifold');
  });
  it('accepts an open mesh with a border', () => {
    const open = deleteFaces(editInput(boxMesh([1, 1, 1])), [TOP]);
    const t = meshTopology(open);
    expect([...t.twin].filter((x) => x < 0)).toHaveLength(4);
  });
});

describe('mesh edits (TS-1219)', () => {
  it('extrudes one face: 4 new vertices and side quads, attributes carried', () => {
    const src = attributedBox();
    const out = extrudeFaces(editInput(src), [TOP], 50);
    expect(out.positions.length / 3).toBe(12);
    expect(out.faceSizes.length).toBe(10);
    expect(closed(out)).toBe(true);
    expect(euler(out)).toBe(2);
    expect(meshBounds(out)!.max[2]).toBeCloseTo(100);
    // The new vertices copy their originals' weights and morph deltas.
    for (let v = 8; v < 12; v++) {
      expect(out.weights!.offsets[v + 1] - out.weights!.offsets[v]).toBe(1);
      expect(out.morphs[0].deltas[3 * v]).toBeCloseTo(1);
    }
    expect(out.uvs!.length).toBe(out.faceIndices.length * 2);
    // Valid EPM bytes, round-trip.
    expect(decodeEpm(encodeEpm(out)).faceSizes).toEqual(out.faceSizes);
    // The input is untouched.
    expect(src.positions.length).toBe(24);
  });
  it('extrudes a region of two faces as one block', () => {
    const once = extrudeFaces(editInput(boxMesh([100, 100, 100])), [TOP], 50);
    const t = meshTopology(once);
    const side = [...Array(once.faceSizes.length).keys()].filter((f) => {
      const n = faceNormal(once, t, f);
      return n[0] > 0.5 && Math.abs(n[2]) < 1e-6;
    });
    expect(side).toHaveLength(2); // +x of the box and of the extruded ring
    const out = extrudeFaces(editInput(once), side, 20);
    expect(closed(out)).toBe(true);
    expect(euler(out)).toBe(2);
    // Region extrude: the shared edge is not doubled, so 6 new vertices, not 8.
    expect(out.positions.length / 3 - once.positions.length / 3).toBe(6);
  });
  it('moves creases inside an extruded region with it', () => {
    let m = extrudeFaces(editInput(boxMesh([100, 100, 100])), [TOP], 50);
    // An inner edge between the two +x faces.
    const t = meshTopology(m);
    const side = [...Array(m.faceSizes.length).keys()].filter((f) => faceNormal(m, t, f)[0] > 0.5);
    const a = new Set(m.faceIndices.subarray(t.faceStart[side[0]], t.faceStart[side[0]] + 4));
    const shared = [...m.faceIndices.subarray(t.faceStart[side[1]], t.faceStart[side[1]] + 4)]
      .filter((v) => a.has(v))
      .sort((x, y) => x - y) as [number, number];
    m = setEdgeCreases(editInput(m), [shared], 1);
    const out = extrudeFaces(editInput(m), side, 20);
    expect(out.creases!.values.length).toBe(1);
    const [x, y] = out.creases!.edges;
    expect(out.positions[3 * x]).toBeCloseTo(70);
    expect(out.positions[3 * y]).toBeCloseTo(70);
  });
  it('refuses extruding every face of a closed box (no direction) and a corner-only selection', () => {
    refused(() => extrudeFaces(editInput(boxMesh([1, 1, 1])), [0, 1, 2, 3, 4, 5], 1), 'degenerate');
    // Two faces sharing only one vertex: +z (1) and a side face that touches only its corner?
    // On a box every face pair shares an edge or nothing, so build a 2×2 grid diagonal instead.
    const grid: EpmMesh = {
      positions: new Float32Array([0, 1, 2].flatMap((y) => [0, 1, 2].flatMap((x) => [x, y, 0]))),
      faceSizes: new Uint32Array([4, 4, 4, 4]),
      faceIndices: new Uint32Array([0, 1, 4, 3, 1, 2, 5, 4, 3, 4, 7, 6, 4, 5, 8, 7]),
      faceMaterials: new Uint16Array(4),
      boneIds: [],
      morphs: [],
    };
    refused(() => extrudeFaces(editInput(grid), [0, 3], 1), 'non-manifold');
    expect(meshTopology(extrudeFaces(editInput(grid), [0, 1], 1)).twin.length).toBe(16 + 24);
  });
  it('insets a face: a ring of quads and a smaller face, UVs blended', () => {
    const out = insetFaces(editInput(attributedBox()), [TOP], 0.5);
    expect(out.faceSizes.length).toBe(10);
    expect(out.positions.length / 3).toBe(12);
    expect(closed(out)).toBe(true);
    // Inner vertices at a quarter of the way in on x, y (half-way to the centre).
    for (let v = 8; v < 12; v++) {
      expect(Math.abs(out.positions[3 * v])).toBeCloseTo(25);
      expect(out.positions[3 * v + 2]).toBeCloseTo(50);
    }
    refused(() => insetFaces(editInput(boxMesh([1, 1, 1])), [TOP], 1), 'selection');
  });
  it('deletes faces and unused vertices; refuses deleting all', () => {
    const out = deleteFaces(editInput(attributedBox()), [TOP]);
    expect(out.faceSizes.length).toBe(5);
    expect(out.positions.length / 3).toBe(8);
    const two = deleteFaces(editInput(boxMesh([1, 1, 1])), [0, 1, 2, 3]);
    // Only the ±x faces remain; they share no vertex.
    expect(two.positions.length / 3).toBe(8);
    refused(() => deleteFaces(editInput(boxMesh([1, 1, 1])), [0, 1, 2, 3, 4, 5]), 'degenerate');
  });
  it('refuses a deletion that leaves faces touching at one vertex', () => {
    const grid: EpmMesh = {
      positions: new Float32Array([0, 1, 2].flatMap((y) => [0, 1, 2].flatMap((x) => [x, y, 0]))),
      faceSizes: new Uint32Array([4, 4, 4, 4]),
      faceIndices: new Uint32Array([0, 1, 4, 3, 1, 2, 5, 4, 3, 4, 7, 6, 4, 5, 8, 7]),
      faceMaterials: new Uint16Array(4),
      boneIds: [],
      morphs: [],
    };
    refused(() => deleteFaces(editInput(grid), [1, 2]), 'non-manifold');
  });
  it('merges an edge into its centre: the box top becomes a wedge-like prism', () => {
    const src = attributedBox();
    // Top face vertices 4, 5, 7, 6; merge 4 and 5 (the -y top edge).
    const out = mergeVertices(editInput(src), [4, 5]);
    expect(out.positions.length / 3).toBe(7);
    expect(closed(out)).toBe(true);
    expect(euler(out)).toBe(2);
    // The -y face (0,1,5,4) became a triangle.
    expect([...out.faceSizes].sort()).toEqual([3, 3, 4, 4, 4, 4]);
    refused(() => mergeVertices(editInput(src), [4]), 'selection');
  });
  it('refuses a merge that would make a face use one vertex twice', () => {
    // Merging diagonal corners of one quad.
    refused(() => mergeVertices(editInput(boxMesh([1, 1, 1])), [4, 7]), 'non-manifold');
  });
  it('moves vertices; a bad matrix or selection is refused', () => {
    const src = attributedBox();
    const out = translateVertices(editInput(src), [4, 5, 6, 7], [0, 0, 10]);
    expect(meshBounds(out)!.max[2]).toBeCloseTo(60);
    expect(out.morphs[0].deltas).toEqual(src.morphs[0].deltas);
    const scaled = transformVertices(
      editInput(src),
      [0, 1, 2, 3, 4, 5, 6, 7],
      [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1],
    );
    expect(meshBounds(scaled)!.max[0]).toBeCloseTo(100);
    refused(() => translateVertices(editInput(src), [8], [0, 0, 1]), 'selection');
    refused(() => translateVertices(editInput(src), [1, 1], [0, 0, 1]), 'selection');
    refused(() => translateVertices(editInput(src), [1], [0, 0, NaN]), 'selection');
    refused(() => translateVertices(editInput(src), [1], [0, 0, 1e13]), 'degenerate');
  });
  it('sets and clears edge creases, only on real edges', () => {
    const m = setEdgeCreases(editInput(boxMesh([1, 1, 1])), [[4, 5]], 0.5);
    expect([...m.creases!.edges]).toEqual([4, 5]);
    expect(m.creases!.values[0]).toBe(0.5);
    const cleared = setEdgeCreases(editInput(m), [[5, 4]], 0);
    expect(cleared.creases).toBeUndefined();
    refused(() => setEdgeCreases(editInput(m), [[4, 7]], 1), 'selection');
    refused(() => setEdgeCreases(editInput(m), [[4, 5]], 2), 'selection');
  });
  it('refuses an edit whose asset would be past the byte limit', () => {
    const limits = { ...epmLimits, bytes: 450 };
    expect(encodeEpm(boxMesh([1, 1, 1]), limits).length).toBeLessThan(450);
    refused(() => insetFaces(editInput(boxMesh([1, 1, 1]), limits), [TOP], 0.5, limits), 'limit');
  });
  it('refuses editing a part past 200,000 vertices', () => {
    const big: EpmMesh = { ...boxMesh([1, 1, 1]), positions: new Float32Array(200_001 * 3) };
    big.positions.set(boxMesh([1, 1, 1]).positions);
    refused(() => editInput(big), 'limit');
  });
});
