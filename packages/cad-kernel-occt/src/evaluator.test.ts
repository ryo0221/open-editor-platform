import { f11OnPlate } from '@editor-platform/cad-core';
import { describe, expect, it } from 'vitest';
import { displayDeflectionMm, meshDeflection, placementIdentity } from './evaluator';
import { meshBytes, type CadMesh } from './protocol';

describe('display mesh deflection (#372)', () => {
  it('is 0.1% of the bounding-box diagonal, so it scales with the body', () => {
    const cube = (side: number) =>
      displayDeflectionMm([
        [0, 0, 0],
        [side, side, side],
      ]);
    // A 3,600 mm sphere: diagonal 7,200·√3 mm.
    expect(cube(7200)).toBeCloseTo(7200 * Math.sqrt(3) * 0.001, 9);
    expect(cube(7200) / cube(7.2)).toBeCloseTo(1000, 9);
    // The 80 × 50 × 5 mm plate stays finer than a tenth of a millimetre.
    expect(
      displayDeflectionMm([
        [0, 0, 0],
        [80, 50, 5],
      ]),
    ).toBeCloseTo(Math.hypot(80, 50, 5) * 0.001, 12);
  });

  it('keeps a floor for tiny or flat bodies and accepts another share', () => {
    expect(
      displayDeflectionMm([
        [5, 5, 5],
        [5, 5, 5],
      ]),
    ).toBe(meshDeflection.minMm);
    expect(
      displayDeflectionMm(
        [
          [0, 0, 0],
          [1000, 0, 0],
        ],
        0.01,
      ),
    ).toBeCloseTo(10, 12);
  });
});

describe('literal-placement identity (CAD25) with sketches (R1d)', () => {
  it('keeps a placement a sketch is attached to out of the fast path', () => {
    const { movable, isolated } = placementIdentity(f11OnPlate());
    // Moving the plate moves the sketch on it and so the bracket: only the bracket can move alone.
    expect([...movable]).toEqual(['bracket']);
    // The bracket reads the plate's face for its plane, not its faces: no shared triangulation.
    expect(isolated).toBe(true);
  });
});

describe('evaluation output bytes (R2a-4)', () => {
  it('counts a mesh’s node curvature toward the output limit', () => {
    const mesh = {
      bodyId: 'a',
      origin: [0, 0, 0],
      positions: new Float32Array(30),
      normals: new Float32Array(30),
      indices: new Uint32Array(3),
      faceIds: new Uint32Array(1),
      vertices: new Float64Array(0),
      faceBase: 0,
      edgeBase: 0,
      edges: new Float32Array(0),
      edgeIds: new Uint32Array(0),
      topology: { faces: [], edges: [], vertices: [] },
    } as unknown as CadMesh;
    const plain = meshBytes([mesh]);
    // Two Float32 values per node: 10 nodes, 80 bytes.
    const curved = {
      ...mesh,
      curvature: { mean: new Float32Array(10), gauss: new Float32Array(10) },
    };
    expect(meshBytes([curved]) - plain).toBe(80);
  });
});
