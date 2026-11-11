import { describe, expect, it } from 'vitest';
import type { CadMesh } from '@editor-platform/cad-kernel-occt';
import { placedMesh } from './assembly-glb';

describe('placing a display mesh for an assembly GLB (MR6, TS-1716)', () => {
  it('turns positions and normals with the pose and places the origin', () => {
    const mesh = {
      bodyId: 'b',
      origin: [10, 0, 0],
      positions: Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: Uint32Array.from([0, 1, 2]),
    } as unknown as CadMesh;
    // A quarter turn about z, then 100 mm up.
    const s = Math.SQRT1_2;
    const placed = placedMesh(mesh, { translationMm: [0, 0, 100], rotation: [0, 0, s, s] });
    const near = (a: ArrayLike<number>) => Array.from(a, (v) => Math.round(v * 1e6) / 1e6 + 0);
    expect(near(placed.origin)).toEqual([0, 10, 100]);
    expect(near(placed.positions)).toEqual([0, 1, 0, -1, 0, 0, 0, 0, 1]);
    expect(near(placed.normals)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect(placed.indices).toBe(mesh.indices);
  });
  it('places a far origin in double precision', () => {
    const mesh = {
      bodyId: 'b',
      origin: [9000000.25, 0, 0],
      positions: new Float32Array(9),
      normals: new Float32Array(9),
      indices: Uint32Array.from([0, 1, 2]),
    } as unknown as CadMesh;
    const placed = placedMesh(mesh, { translationMm: [-9000000, 0, 0], rotation: [0, 0, 0, 1] });
    expect(placed.origin).toEqual([0.25, 0, 0]);
  });
});
