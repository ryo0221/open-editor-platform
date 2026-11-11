import { describe, expect, it } from 'vitest';
import {
  boxMesh,
  checkMultiresLevel,
  decodeMultiresChunk,
  deleteFaces,
  editInput,
  encodeMultiresChunk,
  MeshEditError,
  MultiresAssetError,
  multiresBase,
  multiresChunkCorners,
  multiresChunkCount,
  multiresChunks,
  multiresDisplacementsFrom,
  multiresFrames,
  multiresGridSize,
  multiresJoin,
  multiresPositions,
  multiresRaise,
  multiresTopology,
  multiresVertexCount,
  setEdgeCreases,
  subdivideMesh,
  type EpmMesh,
} from './index';

/** A pentagonal prism: two n-gon caps and five quads. */
function prism(): EpmMesh {
  const positions: number[] = [];
  for (const z of [0, 100])
    for (let k = 0; k < 5; k++)
      positions.push(60 * Math.cos((2 * Math.PI * k) / 5), 60 * Math.sin((2 * Math.PI * k) / 5), z);
  const faces = [
    [4, 3, 2, 1, 0],
    [5, 6, 7, 8, 9],
    ...[0, 1, 2, 3, 4].map((k) => [k, (k + 1) % 5, 5 + ((k + 1) % 5), 5 + k]),
  ];
  return {
    positions: new Float32Array(positions),
    faceSizes: new Uint32Array(faces.map((f) => f.length)),
    faceIndices: new Uint32Array(faces.flat()),
    faceMaterials: new Uint16Array(faces.length),
    boneIds: [],
    morphs: [],
  };
}
const creasedBox = () =>
  setEdgeCreases(
    editInput(boxMesh([200, 200, 200])),
    [
      [4, 5],
      [5, 7],
      [7, 6],
    ],
    0.7,
  );
const openBox = () => deleteFaces(editInput(boxMesh([200, 200, 200])), [1]);

/** Each face's corner positions, face after face (to compare surfaces numbered differently). */
const corners = (positions: ArrayLike<number>, faces: ArrayLike<number>) =>
  Array.from(faces, (v) => [positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]]);

describe('multires base (C7a, TS-1273)', () => {
  it('is the C3 subdivision surface, face for face, at every level it shares', () => {
    for (const cage of [boxMesh([200, 200, 200]), creasedBox(), openBox(), prism()])
      for (const level of [1, 2, 3]) {
        const base = multiresBase(cage, level);
        const want = subdivideMesh(cage, level);
        expect(base.quads.length).toBe(want.faceIndices.length);
        expect(base.positions.length / 3).toBe(want.positions.length / 3);
        expect(base.positions.length / 3).toBe(multiresVertexCount(cage, level));
        const a = corners(base.positions, base.quads);
        const b = corners(want.positions, want.faceIndices);
        for (let i = 0; i < a.length; i++)
          for (let k = 0; k < 3; k++) expect(Math.abs(a[i][k] - b[i][k])).toBeLessThan(1e-3);
      }
  });

  it('lays each corner grid out from the cage vertex to the face centre', () => {
    const cage = prism();
    const level = 3;
    const base = multiresBase(cage, level);
    const G = multiresGridSize(level);
    expect(G).toBe(5);
    expect(base.gridVertex.length).toBe(cage.faceIndices.length * G * G);
    const at = (c: number, i: number, j: number) => base.gridVertex[c * G * G + j * G + i];
    const edges = new Set<string>();
    for (let f = 0; f < base.quads.length; f += 4)
      for (let k = 0; k < 4; k++) {
        const a = base.quads[f + k],
          b = base.quads[f + ((k + 1) % 4)];
        edges.add(`${Math.min(a, b)}-${Math.max(a, b)}`);
      }
    const joined = (a: number, b: number) => edges.has(`${Math.min(a, b)}-${Math.max(a, b)}`);
    let c = 0;
    for (let f = 0; f < cage.faceSizes.length; f++) {
      const n = cage.faceSizes[f];
      // All the face's grids meet at its centre (G−1, G−1).
      for (let k = 1; k < n; k++) expect(at(c + k, G - 1, G - 1)).toBe(at(c, G - 1, G - 1));
      for (let k = 0; k < n; k++) {
        // The next corner's j axis runs back along this corner's i axis edge... the shared edge
        // from the edge midpoint to the centre: (G−1, j) here is (j, G−1) of the next grid.
        const next = c + ((k + 1) % n);
        for (let j = 0; j < G; j++) expect(at(c + k, G - 1, j)).toBe(at(next, j, G - 1));
        // Grid neighbours are joined by an edge of the surface.
        for (let j = 0; j < G; j++)
          for (let i = 0; i + 1 < G; i++) {
            expect(joined(at(c + k, i, j), at(c + k, i + 1, j))).toBe(true);
            expect(joined(at(c + k, j, i), at(c + k, j, i + 1))).toBe(true);
          }
      }
      c += n;
    }
    // Every vertex has an owner grid point that names it.
    for (let v = 0; v < base.vertexOwner.length; v++)
      expect(base.gridVertex[base.vertexOwner[v]]).toBe(v);
  });

  it('moves points by their displacement in the tangent frame, and reads it back', () => {
    const cage = boxMesh([200, 200, 200]);
    const base = multiresBase(cage, 3);
    const frames = multiresFrames(base);
    const zero = new Float32Array(3 * base.gridVertex.length);
    expect(multiresPositions(base, frames, zero)).toEqual(base.positions);
    // 10 mm out along the normal everywhere: every point moves 10 mm along its normal.
    const out = zero.map((_, i) => (i % 3 === 2 ? 10 : 0));
    const moved = multiresPositions(base, frames, out);
    for (let v = 0; v < base.positions.length / 3; v++) {
      const d = [0, 1, 2].map((k) => moved[3 * v + k] - base.positions[3 * v + k]);
      expect(Math.hypot(...d)).toBeCloseTo(10, 3);
      const n = [0, 1, 2].map((k) => frames.normals[3 * v + k]);
      expect(d[0] * n[0] + d[1] * n[1] + d[2] * n[2]).toBeCloseTo(10, 3);
    }
    // Any shape: read back as displacements, then applied, gives the same shape.
    const target = moved.map((x, i) => x + 3 * Math.sin(i));
    const back = multiresDisplacementsFrom(base, frames, target);
    const again = multiresPositions(base, frames, back);
    for (let i = 0; i < target.length; i++) expect(again[i]).toBeCloseTo(target[i], 2);
    // The detail follows the cage: a moved cage moves the displaced surface with it.
    const shifted = {
      ...cage,
      positions: cage.positions.map((x, i) => (i % 3 === 0 ? x + 50 : x)),
    };
    const base2 = multiresBase(shifted, 3);
    const moved2 = multiresPositions(base2, multiresFrames(base2), back);
    for (let i = 0; i < target.length; i++)
      expect(moved2[i]).toBeCloseTo(target[i] + (i % 3 === 0 ? 50 : 0), 2);
  });

  it('raises a level: grid points kept, new ones between them', () => {
    const cage = prism();
    const base = multiresBase(cage, 2);
    const corners = base.corners;
    const d = new Float32Array(3 * base.gridVertex.length).map((_, i) => (i % 3 === 2 ? 5 : 0));
    const up = multiresRaise(d, corners, 2);
    expect(up.length).toBe(3 * corners * multiresGridSize(3) ** 2);
    expect(up.every((x, i) => x === (i % 3 === 2 ? 5 : 0))).toBe(true);
    const ramp = new Float32Array(3 * corners * 9);
    for (let c = 0; c < corners; c++)
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) ramp[3 * (c * 9 + j * 3 + i) + 2] = i;
    const r = multiresRaise(ramp, corners, 2);
    // Along i the values are 0, 0.5, 1, 1.5, 2.
    expect([0, 1, 2, 3, 4].map((i) => r[3 * (2 * 25 + 3 * 5 + i) + 2])).toEqual([
      0, 0.5, 1, 1.5, 2,
    ]);
    expect(() => multiresRaise(new Float32Array(3), corners, 2)).toThrow(MeshEditError);
    expect(() => multiresRaise(new Float32Array(3 * corners * 65 * 65), corners, 7)).toThrow(
      MeshEditError,
    );
  });

  it('refuses levels out of range and surfaces past the vertex limit, before the work', () => {
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
    refused(() => multiresBase(prism(), 0), 'selection');
    refused(() => multiresBase(prism(), 8), 'selection');
    refused(() => multiresBase(prism(), 1.5), 'selection');
    // A box at level 7 is 98,306 vertices; with 24 boxes' worth of faces it passes 2,100,000.
    expect(multiresVertexCount(boxMesh([1, 1, 1]), 7)).toBe(98306);
    const many: EpmMesh = (() => {
      const b = boxMesh([1, 1, 1]);
      const n = 24;
      const positions = new Float32Array(b.positions.length * n);
      const faceIndices = new Uint32Array(b.faceIndices.length * n);
      for (let i = 0; i < n; i++) {
        positions.set(
          b.positions.map((x, k) => (k % 3 === 0 ? x + 3 * i : x)),
          i * b.positions.length,
        );
        faceIndices.set(
          b.faceIndices.map((v) => v + 8 * i),
          i * b.faceIndices.length,
        );
      }
      return {
        ...b,
        positions,
        faceIndices,
        faceSizes: new Uint32Array(6 * n).fill(4),
        faceMaterials: new Uint16Array(6 * n),
      };
    })();
    expect(multiresVertexCount(many, 7)).toBeGreaterThan(2_100_000);
    refused(() => multiresBase(many, 7), 'limit');
    refused(() => checkMultiresLevel(many, 7), 'limit');
    refused(() => checkMultiresLevel(many, 8), 'selection');
  });

  it('walks a vertex of very high valence in linear time (a fan of 100,000 triangles)', () => {
    const n = 100_000;
    const positions = new Float32Array(3 * (n + 1));
    for (let k = 0; k < n; k++) {
      positions[3 * (k + 1)] = 100 * Math.cos((2 * Math.PI * k) / n);
      positions[3 * (k + 1) + 1] = 100 * Math.sin((2 * Math.PI * k) / n);
    }
    const faceIndices = new Uint32Array(3 * n);
    for (let k = 0; k < n; k++) faceIndices.set([0, 1 + k, 1 + ((k + 1) % n)], 3 * k);
    const fan: EpmMesh = {
      positions,
      faceSizes: new Uint32Array(n).fill(3),
      faceIndices,
      faceMaterials: new Uint16Array(n),
      boneIds: [],
      morphs: [],
    };
    const base = multiresBase(fan, 1);
    expect(base.positions.length / 3).toBe(multiresVertexCount(fan, 1));
  });
});

describe('multires chunks (C7a, TS-1274)', () => {
  it('splits displacements into EPMR chunks and joins them back', () => {
    const cage = prism();
    for (const level of [1, 4, 7]) {
      const G = multiresGridSize(level);
      const n = cage.faceIndices.length;
      const d = new Float32Array(3 * n * G * G).map((_, i) => ((i * 7) % 13) - 6);
      const chunks = multiresChunks(d, n, level);
      expect(chunks.length).toBe(multiresChunkCount(n, level));
      expect(
        chunks.every((c) => c.displacements.length / 3 / G / G <= multiresChunkCorners(level)),
      ).toBe(true);
      const decoded = chunks.map((c) => decodeMultiresChunk(encodeMultiresChunk(c)));
      expect(multiresJoin(decoded, n, level)).toEqual(d);
    }
    expect(multiresChunkCorners(7)).toBe(1);
    expect(multiresChunkCorners(1)).toBe(1056);
  });

  it('refuses malformed chunks', () => {
    const problem = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        if (e instanceof MultiresAssetError) return e.problem;
        throw e;
      }
      return undefined;
    };
    const good = encodeMultiresChunk({
      level: 2,
      firstCorner: 0,
      displacements: new Float32Array(27),
    });
    expect(problem(() => decodeMultiresChunk(good.slice(0, 10)))).toBe('header');
    const bad = (offset: number, value: number) => {
      const b = good.slice();
      new DataView(b.buffer).setUint32(offset, value, true);
      return b;
    };
    expect(problem(() => decodeMultiresChunk(bad(4, 2)))).toBe('header');
    expect(problem(() => decodeMultiresChunk(bad(8, 9)))).toBe('level');
    expect(problem(() => decodeMultiresChunk(bad(16, 0)))).toBe('corners');
    expect(problem(() => decodeMultiresChunk(bad(16, 2)))).toBe('length');
    const nan = good.slice();
    new DataView(nan.buffer).setFloat32(24, NaN, true);
    expect(problem(() => decodeMultiresChunk(nan))).toBe('not-finite');
    expect(
      problem(() =>
        encodeMultiresChunk({
          level: 2,
          firstCorner: 0,
          displacements: new Float32Array(27).fill(1e6),
        }),
      ),
    ).toBe('not-finite');
    // Chunks out of order or of another level do not join.
    const c = multiresChunks(new Float32Array(3 * 2000 * 4), 2000, 1);
    expect(problem(() => multiresJoin([c[1], c[0]], 2000, 1))).toBe('corners');
    expect(problem(() => multiresJoin(c.slice(0, 1), 2000, 1))).toBe('corners');
    expect(problem(() => multiresJoin(c, 2000, 2))).toBe('corners');
  });

  it('hashes the cage topology, not its positions', () => {
    const a = boxMesh([200, 200, 200]);
    const moved = { ...a, positions: a.positions.map((x) => x * 2) };
    expect(multiresTopology(moved)).toBe(multiresTopology(a));
    expect(multiresTopology(openBox())).not.toBe(multiresTopology(a));
    expect(multiresTopology(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
