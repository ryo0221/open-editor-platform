import { describe, expect, it } from 'vitest';
import {
  cadTopologyLimits,
  candidatesOf,
  elementName,
  prefixFaceName,
  resolveTopologyRef,
  selectFor,
  topologyRefOf,
  type CadFaceName,
  type CadTopologyTable,
  type CadTopoName,
} from './index';

const at = (x: number): [number, number, number] => [x, 0, 0];
/** Faces by name; edges as [face names, vertex indices, x of the centroid]. */
function table(
  faces: (CadFaceName | null)[],
  edges: [number[], number[], number][],
): CadTopologyTable {
  return {
    faces: faces.map((name, i) => ({ name, centroid: at(i), area: 1 })),
    edges: edges.map(([f, vertices, x]) => ({ faces: f, vertices, centroid: at(x), length: 1 })),
    vertices: Array.from({ length: Math.max(-1, ...edges.flatMap(([, v]) => v)) + 1 }, (_, i) => ({
      centroid: at(100 + i),
    })),
  };
}
const top = ['+z'];
// The top edge on +y, cut in two by a slot: both halves are +y|+z. The left half ends at the
// −x edge and the slot's side a, the right half at the +x edge and the slot's side b.
const split = table(
  [top, ['+y'], ['-x'], ['+x'], ['tool:c', 'a'], ['tool:c', 'b']],
  [
    [[0, 1], [0, 1], -10],
    [[0, 1], [2, 3], 10],
    [[0, 2], [0, 4], -20],
    [[0, 3], [3, 5], 20],
    [[0, 4], [1, 6], -5],
    [[0, 5], [2, 7], 5],
  ],
);
const edgeName: CadTopoName = [['+y'], ['+z']];
const ref = (name: CadTopoName, x: number, select?: { adjacent: CadTopoName[] }) => ({
  kind: 'edge' as const,
  name,
  hint: { centroid: at(x), size: 1 },
  ...(select ? { select } : {}),
});

describe('topology names and references (R1b, CAD30)', () => {
  it('names an edge by its two faces, sorted, and a seam edge by its face twice', () => {
    expect(elementName(split, 'edge', 4)).toEqual([['+z'], ['tool:c', 'a']]);
    const seam = table(
      [['side'], ['top']],
      [
        [[0], [0, 0], 0],
        [[0, 1], [0, 0], 0],
      ],
    );
    expect(elementName(seam, 'edge', 0)).toEqual([['side'], ['side']]);
    expect(elementName(table([null, top], [[[0, 1], [0, 1], 0]]), 'edge', 0)).toBeNull();
  });

  it('classifies resolved, ambiguous (nearest the hint first) and missing', () => {
    expect(resolveTopologyRef(split, ref([['+z'], ['-x']], 0))).toEqual({
      status: 'resolved',
      index: 2,
    });
    expect(candidatesOf(split, 'edge', edgeName)).toEqual([0, 1]);
    expect(resolveTopologyRef(split, ref(edgeName, 9))).toEqual({
      status: 'ambiguous',
      candidates: [1, 0],
    });
    expect(resolveTopologyRef(split, ref([['+z'], ['-y']], 0))).toEqual({ status: 'missing' });
  });

  it('selects a split edge by the fewest neighbour names, and keeps resolving it', () => {
    const select = selectFor(split, 'edge', 0)!;
    expect(select.adjacent).toHaveLength(1);
    expect(resolveTopologyRef(split, ref(edgeName, 10, select))).toEqual({
      status: 'resolved',
      index: 0,
    });
    // Unchanged when the table lists the same elements in another order.
    const reordered = table(
      [['tool:c', 'b'], ['tool:c', 'a'], ['+x'], ['-x'], ['+y'], top],
      [
        [[5, 0], [2, 7], 5],
        [[5, 4], [2, 3], 10],
        [[5, 1], [1, 6], -5],
        [[5, 4], [0, 1], -10],
        [[5, 3], [0, 4], -20],
        [[5, 2], [3, 5], 20],
      ],
    );
    expect(resolveTopologyRef(reordered, ref(edgeName, 10, select))).toEqual({
      status: 'resolved',
      index: 3,
    });
    // A name that already picks one element needs no select.
    expect(selectFor(split, 'edge', 2)).toBeUndefined();
  });

  it('refuses to select a symmetric candidate and an unnamed element', () => {
    const symmetric = table(
      [top, ['+y'], ['tool:c', 'a']],
      [
        [[0, 1], [0, 1], -10],
        [[0, 1], [2, 3], 10],
        [[0, 2], [1, 6], -5],
        [[0, 2], [2, 7], 5],
      ],
    );
    expect(() => selectFor(symmetric, 'edge', 0)).toThrow('reference-not-selectable');
    expect(() => selectFor(table([null], []), 'face', 0)).toThrow('reference-unnamed');
  });

  it('selects one of two faces of one name by the faces around it', () => {
    const faces = table(
      [top, top, ['-x'], ['+x']],
      [
        [[0, 2], [0, 1], 0],
        [[1, 3], [2, 3], 0],
      ],
    );
    const select = selectFor(faces, 'face', 1)!;
    expect(select).toEqual({ adjacent: [[['+x']]] });
    expect(
      resolveTopologyRef(faces, {
        kind: 'face',
        name: [top],
        select,
        hint: { centroid: at(0), size: 1 },
      }),
    ).toEqual({ status: 'resolved', index: 1 });
  });

  it('keeps minimizing a select past three names', () => {
    // Face 0 borders n0–n4; faces 1–4 share its name and n4, each missing one of n0–n3.
    const x = ['x'];
    const n = (i: number) => 5 + i;
    const edges: [number[], number[], number][] = [];
    for (let i = 0; i < 5; i++) edges.push([[0, n(i)], [], 0]);
    for (let o = 1; o <= 4; o++)
      for (let i = 0; i < 5; i++) if (i !== o - 1) edges.push([[o, n(i)], [], 0]);
    const faces = table([x, x, x, x, x, ['n0'], ['n1'], ['n2'], ['n3'], ['n4']], edges);
    const select = selectFor(faces, 'face', 0)!;
    expect(select.adjacent).toEqual([[['n0']], [['n1']], [['n2']], [['n3']]]);
    expect(
      resolveTopologyRef(faces, {
        kind: 'face',
        name: [x],
        select,
        hint: { centroid: at(0), size: 1 },
      }),
    ).toEqual({ status: 'resolved', index: 0 });
  });

  it('names a vertex by the faces of its edges, and tells two of one name apart (R2b-2c)', () => {
    const [a, b, c, d] = [['a'], ['b'], ['c'], ['d']];
    // v0 and v1 both lie on a|b only; v0's other edge runs to v2 on a|c, v1's to v3 on a|d.
    const t = table(
      [a, b, c, d],
      [
        [[0, 1], [0, 1], 0],
        [[0], [0, 2], -1],
        [[0], [1, 3], 1],
        [[0, 2], [2, 4], -2],
        [[0, 3], [3, 5], 2],
      ],
    );
    expect(elementName(t, 'vertex', 0)).toEqual([a, b]);
    expect(elementName(t, 'vertex', 2)).toEqual([a, c]);
    expect(candidatesOf(t, 'vertex', [a, b])).toEqual([0, 1]);
    const hint = { centroid: at(101), size: 0 };
    // Nearest the hint first: v1 sits at x = 101.
    expect(resolveTopologyRef(t, { kind: 'vertex', name: [a, b], hint })).toEqual({
      status: 'ambiguous',
      candidates: [1, 0],
    });
    const select = selectFor(t, 'vertex', 0)!;
    expect(select).toEqual({ adjacent: [[a, c]] });
    expect(resolveTopologyRef(t, { kind: 'vertex', name: [a, b], hint, select })).toEqual({
      status: 'resolved',
      index: 0,
    });
    const ref = topologyRefOf(t, 'vertex', 1, 'f');
    expect(ref).toEqual({
      kind: 'vertex',
      featureId: 'f',
      name: [a, b],
      select: { adjacent: [[a, d]] },
      hint: { centroid: at(101), size: 0 },
    });
    // A vertex on an unnamed face has no name, like an edge.
    expect(elementName(table([a, null], [[[0, 1], [0, 1], 0]]), 'vertex', 0)).toBeNull();
  });

  it('limits a name to 64 segments and 1,024 characters', () => {
    let name: CadFaceName = ['side'];
    for (let i = 1; i < cadTopologyLimits.nameSegments; i++) name = prefixFaceName('t', name);
    expect(name).toHaveLength(64);
    expect(() => prefixFaceName('t', name)).toThrow('topology-name-too-long');
    expect(() => prefixFaceName('x'.repeat(1021), ['side'])).toThrow('topology-name-too-long');
    expect(prefixFaceName('x'.repeat(1020), ['side'])).toHaveLength(2);
  });
});
