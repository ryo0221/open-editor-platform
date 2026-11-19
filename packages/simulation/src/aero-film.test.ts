import { boxSurface } from '@editor-platform/geometry-cfd';
import { simulationLimits, type SimulationTarget } from '@editor-platform/simulation-core';
import { describe, expect, it } from 'vitest';
import { aeroConvection, aeroFaceFilms, aeroRegionFilm, filmFromSi } from './aero-film';
import type { AeroRunFields } from './aero-view';

/**
 * TS-2294 (ST-638 #7, VS12c): the Host wind tunnel's heat transfer on a heat analysis's faces.
 * Two boxes in one tunnel, 1000 × 500 × 200 mm, the faces numbered as `boxSurface`'s quads
 * (bottom, top, −y, +y, −x, +x), two triangles each; 100 W/(m²·K) on the top points, 20 on the
 * bottom ones.
 */
const fields = (): AeroRunFields => {
  const a = boxSurface([0, 0, 100], [1000, 500, 300]);
  const b = boxSurface([2000, 0, 100], [3000, 500, 300]);
  const points = new Float64Array([...a.positions, ...b.positions]);
  const triangles = Uint32Array.from([...a.triangles, ...[...b.triangles].map((i) => i + 8)]);
  const htc = Float64Array.from({ length: 16 }, (_, i) => (i & 4 ? 100 : 20));
  return {
    kind: 'aero',
    points,
    triangles,
    cp: new Float64Array(16),
    htc,
    faces: Int32Array.from({ length: 24 }, (_, t) => t % 12 >> 1),
    bodies: { ids: ['front', 'rear'], triangles: Uint32Array.of(12, 12) },
  };
};

/** A face's target, and back. */
const faceOf = new Map<SimulationTarget, number>();
const target = (face: number): SimulationTarget => {
  const t = { kind: 'face', ref: { kind: 'face' } } as unknown as SimulationTarget;
  faceOf.set(t, face);
  return t;
};

describe('films from the wind tunnel (VS12c)', () => {
  it('gives each face of a body the area mean of its triangles', () => {
    const f = fields();
    const films = aeroFaceFilms(f, 'rear');
    expect([...films.keys()].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(films.get(1)!.film).toBeCloseTo(filmFromSi(100), 12);
    expect(films.get(0)!.film).toBeCloseTo(filmFromSi(20), 12);
    // A side: one triangle (20 + 20 + 100)/3, the other (20 + 100 + 100)/3, the same area.
    expect(films.get(2)!.film).toBeCloseTo(filmFromSi(60), 12);
    expect(films.get(1)!.area).toBeCloseTo(1000 * 500, 6);
    expect(films.get(1)!.triangles).toBe(2);
    // The top's centroid and outward normal.
    expect(films.get(1)!.centroid.map((x) => Math.round(x))).toEqual([2500, 250, 300]);
    expect(films.get(1)!.normal.map((x) => Math.round(x * 1e9) / 1e9)).toEqual([0, 0, 1]);
    // A triangle with no face (−1, a body without them) is left out.
    f.faces![12] = -1;
    f.faces![13] = -1;
    expect(aeroFaceFilms(f, 'rear').has(0)).toBe(false);
    expect(() => aeroFaceFilms(f, 'skin')).toThrow('was not in the tunnel');
    expect(() => aeroFaceFilms({ ...f, htc: undefined }, 'rear')).toThrow('no heat transfer');
    expect(() => aeroFaceFilms({ ...f, faces: undefined }, 'rear')).toThrow('keeps no faces');
  });

  it('gives the film over a box of the car, facing a way when asked', () => {
    const f = fields();
    // Both bottoms (facing down) between the boxes' heights.
    const box = { min: [-10, -10, 50], size: [3100, 600, 100] };
    expect(aeroRegionFilm(f, box, [0, 0, -1]).film).toBeCloseTo(filmFromSi(20), 12);
    expect(aeroRegionFilm(f, box, [0, 0, -1]).area).toBeCloseTo(2 * 1000 * 500, 6);
    // Without a direction: the bottoms only still (the sides' centroids are higher).
    expect(aeroRegionFilm(f, box).triangles).toBe(4);
    // The front box's +x face: its two triangles.
    const nose = { min: [990, -10, 90], size: [20, 520, 220] };
    expect(aeroRegionFilm(f, nose, [1, 0, 0]).film).toBeCloseTo(filmFromSi(60), 12);
    expect(() => aeroRegionFilm(f, nose, [-1, 0, 0])).toThrow('no tunnel triangle');
  });

  it('makes convection loads, the empirical film where the tunnel has none', () => {
    const films = aeroFaceFilms(fields(), 'front');
    films.delete(5);
    const c = aeroConvection([0, 1, 2, 3, 4, 5], films, () => 0.04, target, {
      id: 'air',
      name: 'Air',
      ambient: 300,
      area: (k) => films.get(k)?.area ?? 1e5,
    });
    expect(c.fallback).toEqual([5]);
    expect(c.faces.find((x) => x.face === 5)).toEqual({ face: 5, film: 0.04, from: 'empirical' });
    // 0.02 (bottom), 0.04 (+x, empirical), 0.06 (four sides), 0.1 (top).
    expect(c.loads.map((l) => [l.id, l.targets.length, l.coefficient])).toEqual([
      ['air-1', 1, 0.02],
      ['air-2', 1, 0.04],
      ['air-3', 3, expect.closeTo(0.06, 12)],
      ['air-4', 1, 0.1],
    ]);
    expect(c.loads.every((l) => l.kind === 'convection' && l.ambient === 300)).toBe(true);
    // Fewer loads: the ratio widens until they fit, the coefficient the area mean.
    const two = aeroConvection([0, 1, 2, 3, 4], films, () => 0.04, target, {
      id: 'air',
      name: 'Air',
      ambient: 300,
      area: (k) => films.get(k)!.area,
      maxLoads: 2,
    });
    expect(two.loads.length).toBeLessThanOrEqual(2);
    expect(two.loads.flatMap((l) => l.targets)).toHaveLength(5);
    const area = (k: number) => films.get(k)!.area;
    const all = [0, 1, 2, 3, 4];
    const mean =
      all.reduce((a, k) => a + films.get(k)!.film * area(k), 0) /
      all.reduce((a, k) => a + area(k), 0);
    const weighted = two.loads.reduce(
      (a, l) => a + l.coefficient * l.targets.reduce((w, t) => w + area(faceOf.get(t)!), 0),
      0,
    );
    expect(weighted / all.reduce((a, k) => a + area(k), 0)).toBeCloseTo(mean, 12);
    expect(() =>
      aeroConvection([5], new Map(), () => 0, target, {
        id: 'a',
        name: 'A',
        ambient: 300,
        area: () => 1,
      }),
    ).toThrow('no positive film');
    // Codex on #1288: a ratio below 1 or not finite would never widen.
    for (const ratio of [0, -1, Number.NaN, Infinity, 0.5])
      expect(() =>
        aeroConvection([0, 1], films, () => 0.04, target, {
          id: 'a',
          name: 'A',
          ambient: 300,
          area: () => 1,
          ratio,
          maxLoads: 1,
        }),
      ).toThrow('ratio must be');
  });

  it('splits a group into loads a load can hold (Codex on #1288)', () => {
    const per = simulationLimits.targetsPerItem;
    const many = Array.from({ length: per + 1 }, (_, i) => i);
    const make = (maxLoads: number) =>
      aeroConvection(many, new Map(), () => 0.04, target, {
        id: 'air',
        name: 'Air',
        ambient: 300,
        area: () => 1,
        maxLoads,
      });
    const c = make(2);
    expect(c.loads.map((l) => [l.targets.length, l.coefficient])).toEqual([
      [per, expect.closeTo(0.04, 12)],
      [1, expect.closeTo(0.04, 12)],
    ]);
    // Two films far apart and more faces than one load holds: three loads do not fit two.
    const mixed = aeroConvection(many, new Map(), (face) => (face === 0 ? 0.01 : 0.04), target, {
      id: 'air',
      name: 'Air',
      ambient: 300,
      area: () => 1,
      maxLoads: 2,
    });
    expect(mixed.loads).toHaveLength(2);
    expect(mixed.loads.flatMap((l) => l.targets)).toHaveLength(per + 1);
    expect(mixed.loads.every((l) => l.targets.length <= per)).toBe(true);
    expect(() => make(1)).toThrow('need more than 1 loads');
  });
});
