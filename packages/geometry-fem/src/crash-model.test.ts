import { describe, expect, it } from 'vitest';
import { crashModel, nearestNode } from './crash-model';
import type { ShellMesh } from './shell';

/** TS-2223 (ST-619, VS7c): the explicit model of a crash run from shell meshes. */
const steel = { density: 7.85e-9, youngsModulus: 210_000, poissonRatio: 0.3 };

/** A flat a × a square at height z as two triangles, face 0. */
function square(a: number, z: number, t: number): ShellMesh {
  return {
    nodes: new Float64Array([0, 0, z, a, 0, z, a, a, z, 0, a, z]),
    triangles: new Uint32Array([0, 1, 2, 0, 2, 3]),
    thickness: new Float64Array([t, t]),
    faces: new Int32Array([0, 0]),
    shapeFaces: 1,
    shapeEdges: 0,
    edges: { offsets: new Uint32Array([0]), nodes: new Uint32Array(0) },
  };
}

describe('crash model from shell meshes (VS7c)', () => {
  it('joins the bodies as parts, spreads added masses by area and makes one weld per point', () => {
    const { model, nodeOffset, shellOffset } = crashModel(
      [
        { mesh: square(10, 0, 1), material: steel, masses: [{ faces: [0], mass: 0.003 }] },
        { mesh: square(10, 2, 2), material: { ...steel, density: 2.7e-9 } },
      ],
      [{ parts: [0, 1], points: [5, 5, 1, 2, 2, 1], radius: 3 }],
      0.2,
    );
    expect(nodeOffset).toEqual([0, 4]);
    expect(shellOffset).toEqual([0, 2]);
    expect(Array.from(model.shells)).toEqual([0, 1, 2, 2, 0, 2, 3, 3, 4, 5, 6, 6, 4, 6, 7, 7]);
    expect(Array.from(model.shellPart!)).toEqual([0, 0, 1, 1]);
    expect(Array.from(model.shellMaterial)).toEqual([0, 0, 1, 1]);
    expect(Array.from(model.thickness)).toEqual([1, 1, 2, 2]);
    expect(model.materials[1]!.density).toBe(2.7e-9);
    // 3 kg over two equal triangles: corners 0 and 2 on both (1/3 each), 1 and 3 on one.
    const m = new Map(model.masses!.map((x) => [x.node, x.mass]));
    expect(m.get(0)!).toBeCloseTo(0.001, 12);
    expect(m.get(1)!).toBeCloseTo(0.0005, 12);
    expect([...m.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(0.003, 12);
    expect(model.welds).toEqual([
      { point: [5, 5, 1], radius: 3, parts: [0, 1], nearestNode: true },
      { point: [2, 2, 1], radius: 3, parts: [0, 1], nearestNode: true },
    ]);
    expect(model.contact).toEqual({ friction: 0.2, ignoreInitial: true });
    expect(nearestNode(model.nodes, [9, 9, 3])).toBe(6);
  });

  it('refuses a weld within one part and a mass with no area', () => {
    const one = { mesh: square(10, 0, 1), material: steel };
    expect(() => crashModel([one, one], [{ parts: [1, 1], points: [], radius: 1 }])).toThrow(
      /two different parts/,
    );
    expect(() => crashModel([{ ...one, masses: [{ faces: [3], mass: 1 }] }], [])).toThrow(/area/);
    expect(() => crashModel([], [])).toThrow(/no parts/);
  });
});
