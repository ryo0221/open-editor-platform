import { describe, expect, it } from 'vitest';
import { ElasticError, meshComponents, solveElastic } from './elastic';
import type { FemMesh } from './fem';
import { boxTetMesh } from './primitives';

/** Two meshes side by side as one, the second shifted along x (its faces and edges after the first's). */
function joined(a: FemMesh, b: FemMesh, dx: number): FemMesh {
  const n = a.nodes.length / 3;
  const nodes = new Float64Array(a.nodes.length + b.nodes.length);
  nodes.set(a.nodes);
  for (let i = 0; i < b.nodes.length; i++)
    nodes[a.nodes.length + i] = b.nodes[i]! + (i % 3 ? 0 : dx);
  const shift = (x: Uint32Array, by: number) => Uint32Array.from(x, (v) => v + by);
  const elementsA = a.elements.length / (a.type === 'tet10' ? 10 : 4);
  return {
    type: a.type,
    nodes,
    elements: Uint32Array.from([...a.elements, ...shift(b.elements, n)]),
    shapeFaces: a.shapeFaces + b.shapeFaces,
    shapeEdges: a.shapeEdges + b.shapeEdges,
    boundary: {
      elements: Uint32Array.from([
        ...a.boundary.elements,
        ...shift(b.boundary.elements, elementsA),
      ]),
      localFaces: Uint8Array.from([...a.boundary.localFaces, ...b.boundary.localFaces]),
      tags: Uint32Array.from([...a.boundary.tags, ...shift(b.boundary.tags, a.shapeFaces)]),
    },
    edges: {
      offsets: Uint32Array.from([
        ...a.edges.offsets,
        ...shift(b.edges.offsets.subarray(1), a.edges.nodes.length),
      ]),
      nodes: Uint32Array.from([...a.edges.nodes, ...shift(b.edges.nodes, n)]),
    },
  };
}

/** TS-1357 (ST-191#1): each connected piece of the mesh is checked for free rigid motions. */
describe('rigid motions per connected piece (A1 review)', () => {
  const box = boxTetMesh({ size: [10, 10, 10], divisions: [1, 1, 1], type: 'tet10' });
  const two = joined(box, box, 30);
  const steel = { youngsModulus: 210_000, poissonsRatio: 0.3, density: 7.85e-9 };
  const solver = { tolerance: 1e-10, maxIterations: 100_000 };

  it('labels the pieces', () => {
    expect(meshComponents(box).count).toBe(1);
    const { label, count } = meshComponents(two);
    expect(count).toBe(2);
    const n = box.nodes.length / 3;
    expect(new Set(label.subarray(0, n))).toEqual(new Set([0]));
    expect(new Set(label.subarray(n))).toEqual(new Set([1]));
  });

  it('refuses a mesh whose second piece is not held, and solves when both are', () => {
    const run = (faces: number[]) =>
      solveElastic({
        mesh: two,
        material: steel,
        constraints: [{ faces, edges: [], displacement: [0, 0, 0] }],
        loads: [{ kind: 'face-force', faces: [1], force: [100, 0, 0] }],
        solver,
      });
    let error: unknown;
    try {
      run([0]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ElasticError);
    expect((error as ElasticError).problem).toBe('rigid-body-mode');
    expect((error as ElasticError).message).toContain('piece 2 of 2');
    expect((error as ElasticError).modes).toHaveLength(6);
    // Face 0 of the second box is shape face 6.
    expect(run([0, box.shapeFaces]).converged).toBe(true);
  });
});
