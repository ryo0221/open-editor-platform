import { InstancedMesh, Matrix4, Raycaster, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  disposeInstances,
  instancePath,
  instancesBytes,
  instancesGroup,
  movedKey,
  poseInstances,
  type ViewMesh,
  type ViewSolid,
} from './instances';

/** A unit square in z = 0, as two triangles. */
const square: ViewMesh = {
  origin: [0, 0, 0],
  positions: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};
const at = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
const solid = (): ViewSolid => ({
  meshes: [{ mesh: square, color: '#888888', opacity: 1, sheet: false }],
  bounds: [
    [0, 0, 0],
    [10, 10, 0],
  ],
  instances: [
    { path: ['e1'], matrix: at(0), selected: false },
    { path: ['e2'], matrix: at(100), selected: true },
  ],
});
const down = (x: number, y: number) => new Raycaster(new Vector3(x, y, 50), new Vector3(0, 0, -1));

describe('geometry-view instancing (R2c-3b)', () => {
  it('draws every instance of a solid from one set of buffers', () => {
    const group = instancesGroup([solid()]);
    const meshes = group.children.filter((o) => (o as InstancedMesh).isInstancedMesh);
    expect(meshes).toHaveLength(1);
    expect((meshes[0] as InstancedMesh).count).toBe(2);
    // Each buffer is counted once: another instance adds only its matrix and colour.
    const one = instancesGroup([{ ...solid(), instances: [solid().instances[0]!] }]);
    expect(instancesBytes(group) - instancesBytes(one)).toBe(16 * 4 + 3 * 4);
    disposeInstances(group);
    expect(group.children).toHaveLength(0);
  });

  it('picks the instance under a ray and moves instances by their matrices only', () => {
    const group = instancesGroup([solid()]);
    const hit = (x: number) => down(x, 5).intersectObjects(group.children, false)[0];
    expect(instancePath(hit(105))).toEqual(['e2']);
    expect(instancePath(hit(5))).toEqual(['e1']);
    const parts = [solid()];
    const key = movedKey(parts, new Set(['e2']));
    poseInstances(group, new Set(['e2']), new Matrix4().makeTranslation(0, 1000, 0));
    group.updateMatrixWorld(true);
    expect(instancePath(hit(105))).toBeUndefined();
    expect(instancePath(down(105, 1005).intersectObjects(group.children, false)[0])).toEqual([
      'e2',
    ]);
    poseInstances(group, new Set(['e2']));
    group.updateMatrixWorld(true);
    expect(instancePath(hit(105))).toEqual(['e2']);
    // The key changes only when the placed matrices of the moved instances do.
    expect(movedKey([solid()], new Set(['e2']))).toBe(key);
    expect(
      movedKey([{ ...solid(), instances: [solid().instances[0]!] }], new Set(['e2'])),
    ).not.toBe(key);
  });

  it('moves each instance by the motion of its first path step when given one per step', () => {
    const group = instancesGroup([solid()]);
    poseInstances(
      group,
      new Set(['e1', 'e2']),
      new Map([
        ['e1', new Matrix4().makeTranslation(0, 1000, 0)],
        ['e2', new Matrix4().makeTranslation(0, 2000, 0)],
      ]),
    );
    group.updateMatrixWorld(true);
    expect(instancePath(down(5, 1005).intersectObjects(group.children, false)[0])).toEqual(['e1']);
    expect(instancePath(down(105, 2005).intersectObjects(group.children, false)[0])).toEqual([
      'e2',
    ]);
  });

  it('draws a solid without meshes as a box that can be picked', () => {
    const group = instancesGroup([{ ...solid(), meshes: undefined, box: 'unavailable' }]);
    expect(instancePath(down(105, 5).intersectObjects(group.children, false)[0])).toEqual(['e2']);
  });
});
