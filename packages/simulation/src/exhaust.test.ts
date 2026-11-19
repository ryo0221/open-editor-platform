import { f102Exhaust, type CadTopologyTable } from '@editor-platform/cad-core';
import { boxTetMesh } from '@editor-platform/geometry-fem';
import { describe, expect, it } from 'vitest';
import { kmh, stillFilm } from './brake';
import { exhaustFaces, plateFilm, regionMax } from './exhaust';

describe('the exhaust scene’s parts and air (VS12b, TS-2287, ST-638)', () => {
  it('gives a flat plate’s mean film coefficient, laminar and turbulent', () => {
    // 50 km/h over 600 mm: Re = 13 889 × 600 / 15.7 = 5.31e5, turbulent:
    // Nu = 0.037 Re^0.8 Pr^⅓ = 1 252, h = 0.0549 mW/(mm²·K) (55 W/(m²·K)).
    expect(plateFilm(kmh(50), 600)).toBeCloseTo(0.0549, 3);
    // 10 km/h: Re 1.06e5, laminar: Nu = 0.664 Re^½ Pr^⅓ = 193, h = 0.0085.
    expect(plateFilm(kmh(10), 600)).toBeCloseTo(0.0085, 3);
    expect(plateFilm(0, 600)).toBe(stillFilm);
    expect(() => plateFilm(1, 0)).toThrow(/length/);
  });

  it('sorts the faces onto the pipe, the shield, the floor’s underside and the inside', () => {
    const face = (c: [number, number, number]) => ({ name: null, centroid: c, area: 1 });
    const table: CadTopologyTable = {
      faces: [
        face([100, 0, -70]), // the pipe's underside
        face([0, 0, -50]), // a pipe end
        face([100, 0, -30]), // the pipe's top
        face([100, 0, -19]), // shield underside
        face([100, 0, -11]), // shield top
        face([100, 0, 0]), // floor underside
        face([100, 125, 12]), // floor top beside the tank
        face([100, 0, 72]), // tank top
        face([100, 100, 42]), // a tank side
        face([0, 0, 6]), // the floor's cut end (Codex on #1282)
        face([200, 0, 42]), // the tank's cut end
        face([0, 0, -15]), // the shield's cut end
      ],
      edges: [],
      vertices: [],
    };
    const shielded = exhaustFaces(table, f102Exhaust, true);
    expect(shielded).toEqual({
      pipe: [0, 1, 2],
      pipeUp: [2],
      shield: [3, 4],
      floorUnder: [5],
      above: [6, 7, 8],
      cut: [9, 10, 11],
    });
    // Without a shield a face there is on no part.
    expect(() => exhaustFaces(table, f102Exhaust, false)).toThrow(/face 3 .* no part/);
  });

  it('finds the hottest node of a region', () => {
    const mesh = boxTetMesh({ size: [10, 10, 10], divisions: [2, 2, 2], type: 'tet4' });
    const T = Array.from({ length: mesh.nodes.length / 3 }, (_, n) => mesh.nodes[3 * n + 2]!);
    expect(regionMax(mesh, T, { min: [0, 0, 0], size: [10, 10, 5] })).toBe(5);
    expect(regionMax(mesh, T, { min: [0, 0, 0], size: [10, 10, 10] })).toBe(10);
  });
});
