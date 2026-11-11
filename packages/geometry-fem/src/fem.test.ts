import { describe, expect, it } from 'vitest';
import {
  boxEdges,
  boxTetMesh,
  decodeFem,
  encodeFem,
  femLimits,
  femSha256,
  femVolume,
  FemAssetError,
  localFaces,
  nodesPerElement,
  type FemMesh,
} from './index';

const clone = (m: FemMesh): FemMesh => ({
  ...m,
  nodes: m.nodes.slice(),
  elements: m.elements.slice(),
  boundary: {
    elements: m.boundary.elements.slice(),
    localFaces: m.boundary.localFaces.slice(),
    tags: m.boundary.tags.slice(),
  },
  edges: { offsets: m.edges.offsets.slice(), nodes: m.edges.nodes.slice() },
});
const problem = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(FemAssetError);
    return (e as FemAssetError).problem;
  }
  throw new Error('not refused');
};
/** Area of each shape face from the boundary triangles' corners. */
function faceAreas(m: FemMesh) {
  const npe = nodesPerElement(m.type);
  const areas = new Array<number>(m.shapeFaces).fill(0);
  for (let i = 0; i < m.boundary.elements.length; i++) {
    const e = m.boundary.elements[i]!;
    const [a, b, c] = localFaces[m.boundary.localFaces[i]!]!.map(
      (k) => m.elements[e * npe + k]! * 3,
    );
    const u = [0, 1, 2].map((d) => m.nodes[b! + d]! - m.nodes[a! + d]!);
    const v = [0, 1, 2].map((d) => m.nodes[c! + d]! - m.nodes[a! + d]!);
    const cr = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ];
    areas[m.boundary.tags[i]!]! += Math.hypot(...cr) / 2;
  }
  return areas;
}

describe('FEM 1 assets', () => {
  const tet10 = boxTetMesh({ size: [200, 20, 20], divisions: [10, 1, 1], type: 'tet10' });
  const tet4 = boxTetMesh({ size: [1, 2, 3], divisions: [2, 2, 2], type: 'tet4' });

  it('meshes a box with conforming, positive tetrahedra and tagged faces and edges', () => {
    expect(tet4.elements.length / 4).toBe(48);
    expect(femVolume(tet4)).toBeCloseTo(6, 9);
    expect(femVolume(tet10)).toBeCloseTo(200 * 20 * 20, 6);
    expect(faceAreas(tet10).map((a) => Math.round(a))).toEqual([400, 400, 4000, 4000, 4000, 4000]);
    // 10 cells along x → 21 nodes (corners and mid-edge nodes) on the 4 long edges, 3 on the others.
    const chainLength = (k: number) => tet10.edges.offsets[k + 1]! - tet10.edges.offsets[k]!;
    expect(boxEdges.map((_, k) => chainLength(k))).toEqual([
      21, 21, 21, 21, 3, 3, 3, 3, 3, 3, 3, 3,
    ]);
  });

  it('round-trips byte for byte and names the bytes', () => {
    for (const m of [tet4, tet10]) {
      const bytes = encodeFem(m);
      expect(encodeFem(decodeFem(bytes))).toEqual(bytes);
      expect(decodeFem(bytes).nodes).toEqual(m.nodes);
      expect(femSha256(bytes)).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(femSha256(encodeFem(tet10))).toBe(femSha256(encodeFem(clone(tet10))));
  });

  it('refuses malformed meshes without repairing them', () => {
    const flipped = clone(tet4);
    [flipped.elements[1], flipped.elements[2]] = [flipped.elements[2]!, flipped.elements[1]!];
    expect(problem(() => encodeFem(flipped))).toBe('orientation');
    const outOfRange = clone(tet4);
    outOfRange.elements[0] = 10_000;
    expect(problem(() => encodeFem(outOfRange))).toBe('index');
    const repeated = clone(tet4);
    repeated.elements[1] = repeated.elements[0]!;
    expect(problem(() => encodeFem(repeated))).toBe('element');
    const nan = clone(tet4);
    nan.nodes[4] = Number.NaN;
    expect(problem(() => encodeFem(nan))).toBe('not-finite');
    const twice = clone(tet4);
    twice.boundary = {
      elements: Uint32Array.of(twice.boundary.elements[0]!, twice.boundary.elements[0]!),
      localFaces: Uint8Array.of(twice.boundary.localFaces[0]!, twice.boundary.localFaces[0]!),
      tags: Uint32Array.of(0, 0),
    };
    expect(problem(() => encodeFem(twice))).toBe('boundary');
    // An inner face (shared by two elements) is not a boundary face.
    const inner = clone(tet4);
    const shared = (() => {
      for (let e = 0; e < 48; e++)
        for (let lf = 0; lf < 4; lf++)
          if (
            ![...Array(inner.boundary.elements.length).keys()].some(
              (i) => inner.boundary.elements[i] === e && inner.boundary.localFaces[i] === lf,
            )
          )
            return [e, lf] as const;
      throw new Error('no inner face');
    })();
    inner.boundary = {
      elements: Uint32Array.of(shared[0]),
      localFaces: Uint8Array.of(shared[1]),
      tags: Uint32Array.of(0),
    };
    expect(problem(() => encodeFem(inner))).toBe('boundary');
    const badTag = clone(tet4);
    badTag.boundary.tags[0] = 6;
    expect(problem(() => encodeFem(badTag))).toBe('index');
    const loneNode = clone(tet4);
    loneNode.edges = { offsets: new Uint32Array(13).fill(1, 1), nodes: Uint32Array.of(0) };
    expect(problem(() => encodeFem(loneNode))).toBe('edge');
    expect(problem(() => encodeFem(tet10, { ...femLimits, nodes: 10 }))).toBe('limit');
  });

  it('refuses malformed bytes', () => {
    const bytes = encodeFem(tet4);
    const magic = bytes.slice();
    magic[0] = 0;
    expect(problem(() => decodeFem(magic))).toBe('header');
    expect(problem(() => decodeFem(bytes.slice(0, 10)))).toBe('header');
    expect(problem(() => decodeFem(bytes.slice(0, bytes.length - 64)))).toBe('sections');
    expect(problem(() => decodeFem(bytes, { ...femLimits, bytes: 100 }))).toBe('too-large');
    // Meta that claims more nodes than the section holds.
    const view = new DataView(bytes.buffer.slice(0));
    const metaAt = view.getUint32(16 + 4, true);
    const metaLen = view.getUint32(16 + 8, true);
    const text = new TextDecoder().decode(new Uint8Array(view.buffer, metaAt, metaLen));
    const edited = text.replace(
      /"nodes":(\d+)/,
      (_, d) => `"nodes":${String(Number(d) + 1).padStart(d.length, '0')}`,
    );
    const lied = new Uint8Array(view.buffer);
    if (edited.length === text.length) {
      lied.set(new TextEncoder().encode(edited), metaAt);
      expect(['length', 'meta']).toContain(problem(() => decodeFem(lied)));
    }
  });
});
