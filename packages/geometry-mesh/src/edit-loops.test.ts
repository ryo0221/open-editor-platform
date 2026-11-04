import { describe, expect, it } from 'vitest';
import {
  bevelEdges,
  boxMesh,
  editInput,
  edgeLoop,
  edgeRing,
  extrudeFaces,
  knifeFace,
  loopCut,
  meshBounds,
  meshEdges,
  MeshEditError,
  meshTopology,
  mirroredFaceSelection,
  mirroredVertexSelection,
  mirrorVertices,
  setEdgeCreases,
  translateSymmetric,
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
const closed = (m: EpmMesh) => meshTopology(m).twin.every((x) => x >= 0);
const withUvs = (m: EpmMesh) => {
  m.uvs = new Float32Array(m.faceIndices.length * 2).map((_, i) => (i % 3) / 3);
  return m;
};
/** A box centred on the origin, cut once around the middle of each axis: 26 vertices, 24 quads. */
function cutBox(): EpmMesh {
  let m = boxMesh([100, 100, 100]);
  m = loopCut(editInput(m), [0, 1], 1); // edge along x: the cut loop is x = 0
  m = loopCut(editInput(m), [0, 2], 1); // along y
  return loopCut(editInput(m), [0, 4], 1); // along z
}
const vertexAt = (m: EpmMesh, p: [number, number, number]) => {
  for (let v = 0; v < m.positions.length / 3; v++)
    if (p.every((x, k) => Math.abs(m.positions[3 * v + k] - x) < 1e-3)) return v;
  throw new Error(`no vertex at ${p}`);
};

describe('loops and loop cut (TS-1220)', () => {
  it('a loop cut on a box splits the four quads of the ring', () => {
    const m = loopCut(editInput(withUvs(boxMesh([100, 100, 100]))), [0, 1], 1);
    expect(m.positions.length / 3).toBe(12);
    expect(m.faceSizes.length).toBe(10);
    expect(closed(m)).toBe(true);
    expect(euler(m)).toBe(2);
    // The new loop is at x = 0.
    const xs = new Set<number>();
    for (let v = 8; v < 12; v++) xs.add(Math.round(m.positions[3 * v]));
    expect([...xs]).toEqual([0]);
    expect(m.uvs!.length).toBe(m.faceIndices.length * 2);
  });
  it('three cuts give 26 vertices and 24 quads, and loop/ring walk the cut', () => {
    const m = cutBox();
    expect(m.positions.length / 3).toBe(26);
    expect(m.faceSizes.length).toBe(24);
    expect(euler(m)).toBe(2);
    const inp = editInput(m);
    // The x = 0 loop through the top front edge's midpoint is 8 edges long and closed.
    const a = vertexAt(m, [0, -50, 50]),
      b = vertexAt(m, [0, 0, 50]);
    const loop = edgeLoop(inp, [a, b]);
    expect(loop).toHaveLength(8);
    for (const [x, y] of loop) {
      expect(Math.abs(m.positions[3 * x])).toBeLessThan(1e-3);
      expect(Math.abs(m.positions[3 * y])).toBeLessThan(1e-3);
    }
    const ring = edgeRing(inp, [a, b]);
    expect(ring.closed).toBe(true);
    expect(ring.faces).toHaveLength(8);
  });
  it('several cuts space evenly, and creases on split edges stay on every piece', () => {
    let m = setEdgeCreases(editInput(boxMesh([90, 90, 90])), [[0, 2]], 1);
    m = loopCut(editInput(m), [0, 2], 2);
    // [0,2] lies along y; cutting its ring (the y-ring) adds loops at y = -15 and +15.
    const ys = new Set<number>();
    for (let v = 8; v < m.positions.length / 3; v++) ys.add(Math.round(m.positions[3 * v + 1]));
    expect([...ys].sort((x, y) => x - y)).toEqual([-15, 15]);
    expect(m.creases!.values.length).toBe(3);
    refused(() => loopCut(editInput(m), [0, 2], 0), 'selection');
    refused(() => loopCut(editInput(m), [0, 7], 1), 'selection');
  });
  it('an open ring ends in a non-quad face, which gains the new vertex', () => {
    // A box with its top face cut into two triangles by the knife.
    let m = boxMesh([100, 100, 100]);
    m = knifeFace(editInput(m), 1, { vertex: 4 }, { vertex: 7 });
    // The ring across the -y face from edge 0-1 continues to the top (now triangles): stops there.
    const ring = edgeRing(editInput(m), [0, 1]);
    expect(ring.closed).toBe(false);
    const out = loopCut(editInput(m), [0, 1], 1);
    expect(closed(out)).toBe(true);
    expect(euler(out)).toBe(2);
    expect([...out.faceSizes].filter((n) => n === 4).length).toBeGreaterThan(0);
  });
});

describe('bevel (TS-1220)', () => {
  it('bevels one box edge: 10 vertices, 7 faces', () => {
    const m = bevelEdges(editInput(withUvs(boxMesh([100, 100, 100]))), [[4, 5]], 10);
    expect(m.positions.length / 3).toBe(10);
    expect(m.faceSizes.length).toBe(7);
    expect(closed(m)).toBe(true);
    expect(euler(m)).toBe(2);
    const b = meshBounds(m)!;
    expect(b.max[2]).toBeCloseTo(50);
    expect(b.min[1]).toBeCloseTo(-50);
  });
  it('bevels all twelve edges: a corner triangle at each vertex', () => {
    const all: [number, number][] = [];
    const m0 = boxMesh([100, 100, 100]);
    const inp = editInput(m0);
    for (const k of meshEdges(m0, inp.topology))
      all.push([Math.floor(k / (1 << 20)), k % (1 << 20)]);
    const m = bevelEdges(inp, all, 10);
    expect(m.positions.length / 3).toBe(24);
    expect(m.faceSizes.length).toBe(26);
    expect([...m.faceSizes].filter((n) => n === 3)).toHaveLength(8);
    // Every new vertex sits 10 mm in from two faces of the box: |x|,|y|,|z| are 40, 40, 50.
    for (let v = 0; v < 24; v++) {
      const c = [0, 1, 2].map((k) => Math.round(Math.abs(m.positions[3 * v + k]))).sort();
      expect(c).toEqual([40, 40, 50]);
    }
    expect(closed(m)).toBe(true);
    expect(euler(m)).toBe(2);
  });
  it('bevels two edges meeting at a corner, and an edge loop of a cut box', () => {
    const two = bevelEdges(
      editInput(boxMesh([100, 100, 100])),
      [
        [4, 5],
        [5, 7],
      ],
      10,
    );
    expect(closed(two)).toBe(true);
    expect(euler(two)).toBe(2);
    const m = cutBox();
    const inp = editInput(m);
    const loop = edgeLoop(inp, [vertexAt(m, [0, -50, 50]), vertexAt(m, [0, 0, 50])]);
    const out = bevelEdges(inp, loop, 5);
    expect(closed(out)).toBe(true);
    expect(euler(out)).toBe(2);
    // A loop bevel doubles the loop: 8 more vertices, 8 more quads.
    expect(out.positions.length / 3).toBe(34);
    expect(out.faceSizes.length).toBe(32);
  });
  it('refuses a width past an edge, a border edge and a bad width', () => {
    refused(() => bevelEdges(editInput(boxMesh([10, 10, 10])), [[4, 5]], 10), 'degenerate');
    refused(() => bevelEdges(editInput(boxMesh([10, 10, 10])), [[4, 5]], 0), 'selection');
    refused(() => bevelEdges(editInput(boxMesh([10, 10, 10])), [[4, 7]], 1), 'selection');
  });
});

describe('knife (TS-1220)', () => {
  it('cuts a quad corner to corner, and edge to edge with the neighbours gaining vertices', () => {
    const diag = knifeFace(
      editInput(withUvs(boxMesh([100, 100, 100]))),
      1,
      { vertex: 4 },
      { vertex: 7 },
    );
    expect(diag.faceSizes.length).toBe(7);
    expect(closed(diag)).toBe(true);
    const across = knifeFace(
      editInput(withUvs(boxMesh([100, 100, 100]))),
      1,
      { edge: [4, 5], t: 0.25 },
      { edge: [7, 6], t: 0.25 },
    );
    expect(across.positions.length / 3).toBe(10);
    expect(across.faceSizes.length).toBe(7);
    expect(closed(across)).toBe(true);
    expect(euler(across)).toBe(2);
    // The -y face gained a vertex at x = -25.
    expect(across.positions[3 * 8]).toBeCloseTo(-25);
  });
  it('refuses a cut along an edge, between neighbouring corners, or off the face', () => {
    const inp = editInput(boxMesh([1, 1, 1]));
    refused(() => knifeFace(inp, 1, { vertex: 4 }, { vertex: 5 }), 'selection');
    refused(() => knifeFace(inp, 1, { vertex: 4 }, { edge: [4, 5], t: 0.5 }), 'selection');
    refused(
      () => knifeFace(inp, 1, { edge: [4, 5], t: 0.2 }, { edge: [4, 5], t: 0.6 }),
      'selection',
    );
    refused(() => knifeFace(inp, 1, { vertex: 0 }, { vertex: 7 }), 'selection');
    refused(() => knifeFace(inp, 1, { vertex: 4 }, { edge: [7, 6], t: 1 }), 'selection');
  });
});

describe('review fixes (TS-1220)', () => {
  it('refuses a bevel whose offsets from opposite corners cross', () => {
    const m0 = boxMesh([100, 10, 100]);
    const inp = editInput(m0);
    const all = meshEdges(m0, inp.topology).map(
      (k) => [Math.floor(k / (1 << 20)), k % (1 << 20)] as [number, number],
    );
    refused(() => bevelEdges(inp, all, 8), 'degenerate');
    expect(closed(bevelEdges(inp, all, 4))).toBe(true);
  });
  it('refuses a knife cut across the notch of a concave face', () => {
    const outline = [
      [0, 0],
      [3, 0],
      [3, 3],
      [2, 3],
      [2, 1],
      [1, 1],
      [1, 3],
      [0, 3],
    ];
    const flat: EpmMesh = {
      positions: new Float32Array(outline.flatMap(([x, y]) => [x, y, 0])),
      faceSizes: new Uint32Array([8]),
      faceIndices: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7]),
      faceMaterials: new Uint16Array(1),
      boneIds: [],
      morphs: [],
    };
    refused(() => knifeFace(editInput(flat), 0, { vertex: 3 }, { vertex: 6 }), 'selection');
    // Inside cuts still work: corner 0 to corner 5 runs through the solid part.
    expect(knifeFace(editInput(flat), 0, { vertex: 1 }, { vertex: 5 }).faceSizes.length).toBe(2);
  });
  it('cuts the Y-facing sides of a box (projection keeps the winding)', () => {
    const box = boxMesh([100, 100, 100]);
    const inp = editInput(box);
    for (const f of [2, 3]) {
      const vs = [...box.faceIndices.subarray(4 * f, 4 * f + 4)];
      const out = knifeFace(inp, f, { vertex: vs[0] }, { vertex: vs[2] });
      expect(out.faceSizes.length).toBe(7);
    }
  });
  it('accepts a cut collinear with a distant edge', () => {
    const outline = [
      [0, 0],
      [5, 0],
      [5, 3],
      [4, 3],
      [4, 1],
      [3, 1],
      [3, 3],
      [2, 3],
      [2, 1],
      [1, 1],
      [1, 3],
      [0, 3],
    ];
    const comb: EpmMesh = {
      positions: new Float32Array(outline.flatMap(([x, y]) => [x, y, 0])),
      faceSizes: new Uint32Array([12]),
      faceIndices: new Uint32Array([...outline.keys()]),
      faceMaterials: new Uint16Array(1),
      boneIds: [],
      morphs: [],
    };
    const out = knifeFace(editInput(comb), 0, { edge: [11, 0], t: 2 / 3 }, { vertex: 9 });
    expect(out.faceSizes.length).toBe(2);
    // A cut that runs along a far edge's line and over it is still refused.
    refused(
      () => knifeFace(editInput(comb), 0, { edge: [11, 0], t: 2 / 3 }, { vertex: 4 }),
      'selection',
    );
  });
  it('refuses a loop cut through a concave quad', () => {
    const quad: EpmMesh = {
      positions: new Float32Array([0, 0, 0, 4, 0, 0, 0.5, 0.5, 0, 0, 4, 0]),
      faceSizes: new Uint32Array([4]),
      faceIndices: new Uint32Array([0, 1, 2, 3]),
      faceMaterials: new Uint16Array(1),
      boneIds: [],
      morphs: [],
    };
    refused(() => loopCut(editInput(quad), [0, 1], 1), 'degenerate');
  });
  it('gives each bevel corner the material of the faces around it', () => {
    const a = boxMesh([10, 10, 10]);
    const b2 = boxMesh([10, 10, 10], [100, 0, 0]);
    const two: EpmMesh = {
      positions: new Float32Array([...a.positions, ...b2.positions]),
      faceSizes: new Uint32Array(12).fill(4),
      faceIndices: new Uint32Array([...a.faceIndices, ...[...b2.faceIndices].map((v) => v + 8)]),
      faceMaterials: new Uint16Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]),
      boneIds: [],
      morphs: [],
    };
    const inp = editInput(two);
    const edges = meshEdges(two, inp.topology)
      .map((k) => [Math.floor(k / (1 << 20)), k % (1 << 20)] as [number, number])
      .filter(([x]) => x >= 8);
    const out = bevelEdges(inp, edges, 2);
    const t = meshTopology(out);
    for (let f = 0; f < out.faceSizes.length; f++)
      if (out.positions[3 * out.faceIndices[t.faceStart[f]]] > 50)
        expect(out.faceMaterials[f]).toBe(1);
  });
  it('keeps only mirror pairs that choose each other', () => {
    const a = boxMesh([10, 10, 10]);
    const b = boxMesh([10, 10, 10], [0, 0.0005, 0]);
    for (let v = 0; v < 8; v++) if (a.positions[3 * v] > 0) a.positions[3 * v + 1] += 0.0003;
    const two: EpmMesh = {
      positions: new Float32Array([...a.positions, ...b.positions]),
      faceSizes: new Uint32Array(12).fill(4),
      faceIndices: new Uint32Array([...a.faceIndices, ...[...b.faceIndices].map((v) => v + 8)]),
      faceMaterials: new Uint16Array(12),
      boneIds: [],
      morphs: [],
    };
    const { mirror, unmatched } = mirrorVertices(editInput(two), 0);
    for (let v = 0; v < 16; v++) if (mirror[v] >= 0) expect(mirror[mirror[v]]).toBe(v);
    expect(unmatched.length).toBeGreaterThan(0);
    expect(unmatched.length + [...mirror].filter((x) => x >= 0).length).toBe(16);
  });
});

describe('symmetry (TS-1220)', () => {
  it('pairs mirror vertices and moves both sides', () => {
    const m = cutBox();
    const inp = editInput(m);
    const { mirror, unmatched } = mirrorVertices(inp, 0);
    expect(unmatched).toEqual([]);
    const right = vertexAt(m, [50, 50, 50]),
      left = vertexAt(m, [-50, 50, 50]),
      mid = vertexAt(m, [0, 50, 50]);
    expect(mirror[right]).toBe(left);
    expect(mirror[mid]).toBe(mid);
    expect(mirroredVertexSelection(mirror, [right]).sort()).toEqual([right, left].sort());
    const out = translateSymmetric(inp, mirror, 0, [right, mid], [10, 0, 5]);
    expect(out.positions[3 * right]).toBeCloseTo(60);
    expect(out.positions[3 * left]).toBeCloseTo(-60);
    expect(out.positions[3 * left + 2]).toBeCloseTo(55);
    // The on-plane vertex stays on the plane.
    expect(out.positions[3 * mid]).toBeCloseTo(0);
    expect(out.positions[3 * mid + 2]).toBeCloseTo(55);
  });
  it('mirrors a face selection and extrudes both sides apart', () => {
    const m = cutBox();
    const inp = editInput(m);
    const { mirror } = mirrorVertices(inp, 0);
    const t = inp.topology;
    // A +x face (all its vertices at x = 50).
    const f = [...Array(m.faceSizes.length).keys()].find((g) =>
      [0, 1, 2, 3].every((k) => m.positions[3 * m.faceIndices[t.faceStart[g] + k]] > 49),
    )!;
    const faces = mirroredFaceSelection(inp, mirror, [f]);
    expect(faces).toHaveLength(2);
    const out = extrudeFaces(inp, faces, 30);
    const b = meshBounds(out)!;
    expect(b.max[0]).toBeCloseTo(80);
    expect(b.min[0]).toBeCloseTo(-80);
    expect(closed(out)).toBe(true);
  });
  it('lists vertices without an image and refuses a bad axis or tolerance', () => {
    const m = cutBox();
    m.positions[0] += 7; // break one vertex's symmetry
    const inp = editInput(m);
    expect(mirrorVertices(inp, 0).unmatched.length).toBe(2);
    refused(() => mirrorVertices(inp, 3 as 0), 'selection');
    refused(() => mirrorVertices(inp, 0, 0), 'selection');
  });
});
