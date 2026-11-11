import { describe, expect, it } from 'vitest';
import { boxTetMesh } from './primitives';
import { meshShapeQuality, tetShape } from './quality';

type V = [number, number, number];

describe('element shape quality (R3e-3)', () => {
  it('gives a regular tetrahedron ratio 1 and dihedral acos(1/3)', () => {
    const p: [V, V, V, V] = [
      [1, 1, 1],
      [-1, 1, -1],
      [1, -1, -1],
      [-1, -1, 1],
    ];
    const q = tetShape(p);
    expect(q.radiusRatio).toBeCloseTo(1, 12);
    expect(q.dihedralDeg).toBeCloseTo((Math.acos(1 / 3) * 180) / Math.PI, 10);
    // Translated and scaled: the same shape.
    const far = p.map((v) => v.map((x) => 1e6 + 3 * x) as V) as [V, V, V, V];
    expect(tetShape(far).radiusRatio).toBeCloseTo(1, 6);
  });

  it('finds a sliver: four nearly coplanar corners of a square', () => {
    const q = tetShape(
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0.01],
        [0, 1, 0],
      ].map((v) => v as V) as [V, V, V, V],
    );
    // Orientation: make the volume positive whichever way round.
    const r =
      q.radiusRatio > 0
        ? q
        : tetShape([
            [0, 0, 0],
            [0, 1, 0],
            [1, 1, 0.01],
            [1, 0, 0],
          ]);
    expect(r.radiusRatio).toBeLessThan(0.05);
    expect(r.dihedralDeg).toBeLessThan(2);
  });

  it('passes a box mesh and lists the elements below the limits', () => {
    const mesh = boxTetMesh({ size: [10, 10, 10], divisions: [2, 2, 2], type: 'tet10' });
    const q = meshShapeQuality(mesh);
    expect(q.below).toEqual([]);
    expect(q.minRadiusRatio).toBeGreaterThan(0.5);
    expect(meshShapeQuality(mesh, { radiusRatio: 2, dihedralDeg: 0 }).below.length).toBe(
      mesh.elements.length / 10,
    );
  });
});
