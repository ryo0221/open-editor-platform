import { describe, expect, it } from 'vitest';
import {
  anglesAround,
  capAngle,
  closesRing,
  largestGap,
  preparationFaces,
  type FaceSample,
} from './preparation';

const turn = (from: number, to: number, n = 13) =>
  Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
/** Points at those angles on a circle of radius 10 about z. */
const round = (angles: number[]): [number, number, number][] =>
  angles.map((a) => [10 * Math.cos(a), 10 * Math.sin(a), 1]);
const z = {
  point: [0, 0, 0] as [number, number, number],
  dir: [0, 0, 1] as [number, number, number],
};
const plane: FaceSample = { kind: 'other', radius: Number.NaN };
const wall = (radius: number, from: number, to: number, concave = true): FaceSample => ({
  kind: 'cylinder',
  radius,
  axis: z,
  nodes: round(turn(from, to)),
  concave,
});
/** A plane face whose nodes lie within `r` of the z axis (a hole's bottom). */
const disc = (r: number): FaceSample => ({
  kind: 'other',
  radius: Number.NaN,
  nodes: [
    [0, 0, -5],
    ...round(turn(0, 2 * Math.PI, 9)).map(([x, y]): [number, number, number] => [
      (x * r) / 10,
      (y * r) / 10,
      -5,
    ]),
  ],
});
/** The point at that angle on the circle of `round` (an edge's centroid). */
const at = (angle: number) => round([angle])[0]!;
const none = { removeHolesBelow: null, removeFilletsBelow: null, removeFaces: [] };

describe('analysis preparation faces (R3c-2b)', () => {
  it('measures the largest gap around the axis, wrapping', () => {
    expect(largestGap(turn(0, Math.PI))).toBeCloseTo(Math.PI, 12);
    expect(largestGap([0.1, 6.2])).toBeCloseTo(6.1, 12);
    expect(largestGap([])).toBeCloseTo(2 * Math.PI, 12);
  });

  it('measures angles in one frame per axis', () => {
    const a = anglesAround(z, round([0, Math.PI / 2]));
    const b = anglesAround({ point: [0, 0, 5], dir: [0, 0, 1] }, round([0, Math.PI / 2]));
    expect(a[1]! - a[0]!).toBeCloseTo(Math.PI / 2, 12);
    expect(b).toEqual(a);
  });

  it('removes a hole kept as two half walls, below the diameter only', () => {
    // A plate (faces 0, 1 and four sides) with a through hole of r 5 in two halves (6, 7).
    const faces = [
      plane,
      plane,
      plane,
      plane,
      plane,
      plane,
      wall(5, 0, Math.PI),
      wall(5, Math.PI, 2 * Math.PI),
    ];
    const edges = [
      { faces: [0, 6] },
      { faces: [0, 7] },
      { faces: [1, 6] },
      { faces: [1, 7] },
      { faces: [6, 7], centroid: at(0) },
      { faces: [6, 7], centroid: at(Math.PI) },
      { faces: [0, 2] },
      { faces: [1, 2] },
    ];
    expect(preparationFaces(faces, edges, { ...none, removeHolesBelow: 11 }, 1e-6)).toEqual([6, 7]);
    expect(preparationFaces(faces, edges, { ...none, removeHolesBelow: 10 }, 1e-6)).toEqual([]);
    // Half a hole is no fillet, however small.
    expect(preparationFaces(faces, edges, { ...none, removeFilletsBelow: 100 }, 1e-6)).toEqual([]);
    // Another axis or radius does not close the turn.
    const apart = [
      ...faces.slice(0, 7),
      {
        ...wall(5, Math.PI, 2 * Math.PI),
        axis: { point: [1, 0, 0] as [number, number, number], dir: z.dir },
      },
    ];
    expect(preparationFaces(apart, edges, { ...none, removeHolesBelow: 11 }, 1e-6)).toEqual([]);
  });

  it('keeps apart walls that do not touch, and never takes a split wall for fillets', () => {
    // Two half grooves at different heights (faces 1, 2), each touching only the plane 0.
    const faces = [plane, wall(2, 0, Math.PI), wall(2, Math.PI, 2 * Math.PI), plane];
    const edges = [{ faces: [0, 1] }, { faces: [0, 2] }, { faces: [0, 3] }];
    expect(preparationFaces(faces, edges, { ...none, removeHolesBelow: 10 }, 1e-6)).toEqual([]);
    // A hole of r 2 in four quarter walls: a hole, not four fillets.
    const quarters = [0, 1, 2, 3].map((k) => wall(2, (k * Math.PI) / 2, ((k + 1) * Math.PI) / 2));
    const split = [plane, ...quarters, plane];
    const ring = [
      ...[1, 2, 3, 4].map((f) => ({ faces: [f, (f % 4) + 1], centroid: at((f * Math.PI) / 2) })),
      ...[1, 2, 3, 4].flatMap((f) => [{ faces: [0, f] }, { faces: [5, f] }]),
      { faces: [0, 5] },
    ];
    expect(preparationFaces(split, ring, { ...none, removeFilletsBelow: 3 }, 1e-6)).toEqual([]);
    expect(preparationFaces(split, ring, { ...none, removeHolesBelow: 5 }, 1e-6)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('takes a blind hole bottom past a blend at the bottom of its wall', () => {
    const blend: FaceSample = {
      kind: 'torus',
      radius: 1,
      axis: z,
      nodes: round(turn(0, 2 * Math.PI)),
    };
    // 0 top, 1 wall, 2 torus between the wall and 3, the bottom; 4 a side.
    const faces = [plane, wall(3, 0, 2 * Math.PI), blend, disc(2), plane];
    const edges = [
      { faces: [0, 1] },
      { faces: [1] },
      { faces: [1, 2] },
      { faces: [2, 3] },
      { faces: [0, 4] },
    ];
    expect(preparationFaces(faces, edges, { ...none, removeHolesBelow: 10 }, 1e-6)).toEqual([
      1, 2, 3,
    ]);
  });

  it('takes a blind hole bottom with its wall, and leaves a boss', () => {
    const faces = [
      plane,
      wall(3, 0, 2 * Math.PI, true),
      disc(3),
      wall(3, 0, 2 * Math.PI, false),
      disc(3),
    ];
    // 0 top, 1 hole wall, 2 hole bottom (only next to 1), 3 boss side, 4 boss top.
    const edges = [
      { faces: [0, 1] },
      { faces: [1] },
      { faces: [1, 2] },
      { faces: [0, 3] },
      { faces: [3] },
      { faces: [3, 4] },
    ];
    expect(preparationFaces(faces, edges, { ...none, removeHolesBelow: 10 }, 1e-6)).toEqual([1, 2]);
  });

  it('removes small fillets (cylinder, torus, sphere) and keeps larger ones', () => {
    const faces: FaceSample[] = [
      plane,
      plane,
      wall(2, 0, Math.PI / 2, false),
      { kind: 'torus', radius: 2, axis: z, nodes: round(turn(0, Math.PI / 2)) },
      wall(8, 0, Math.PI / 2, true),
      { kind: 'sphere', radius: 1, axis: z, nodes: round(turn(0, 0.3)) },
    ];
    const edges = [
      { faces: [0, 1] },
      { faces: [0, 2] },
      { faces: [1, 2] },
      { faces: [0, 4] },
      { faces: [1, 4] },
    ];
    expect(preparationFaces(faces, edges, { ...none, removeFilletsBelow: 5 }, 1e-6)).toEqual([
      2, 3, 5,
    ]);
    expect(preparationFaces(faces, edges, { ...none, removeFilletsBelow: 10 }, 1e-6)).toEqual([
      2, 3, 4, 5,
    ]);
  });

  it('takes a rim blend round a removed hole, and treats any small torus as a fillet', () => {
    const rim: FaceSample = {
      kind: 'torus',
      radius: 1,
      axis: z,
      nodes: round(turn(0, 2 * Math.PI)),
    };
    // 0 top, 1 bottom, 2 hole wall, 3 rim torus between 0 and 2, 4 a side.
    const faces = [plane, plane, wall(6, 0, 2 * Math.PI), rim, plane];
    const edges = [
      { faces: [0, 3] },
      { faces: [3, 2] },
      { faces: [2] },
      { faces: [2, 1] },
      { faces: [0, 4] },
      { faces: [1, 4] },
    ];
    expect(preparationFaces(faces, edges, { ...none, removeHolesBelow: 13 }, 1e-6)).toEqual([2, 3]);
    expect(preparationFaces(faces, edges, { ...none, removeFilletsBelow: 2 }, 1e-6)).toEqual([3]);
  });

  it('keeps a face enclosed by removed fillets (the top of a block filleted all round)', () => {
    // 0 top, 1–4 fillets round it, 5–8 sides, 9 bottom.
    const fillet = wall(3, 0, Math.PI / 2, false);
    const faces = [plane, fillet, fillet, fillet, fillet, plane, plane, plane, plane, plane];
    const edges = [1, 2, 3, 4].flatMap((f) => [{ faces: [0, f] }, { faces: [f, f + 4] }]);
    edges.push(...[5, 6, 7, 8].map((f) => ({ faces: [f, 9] })));
    expect(preparationFaces(faces, edges, { ...none, removeFilletsBelow: 4 }, 1e-6)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('takes no open groove for a hole, however nearly it closes', () => {
    // 300° of a concave cylinder of r 2 in the plane 0: in one face, then in two side by side.
    const one = [plane, wall(2, 0, (5 * Math.PI) / 3)];
    expect(closesRing([1], [{ faces: [0, 1] }], one, z)).toBe(false);
    expect(
      preparationFaces(one, [{ faces: [0, 1] }], { ...none, removeHolesBelow: 10 }, 1e-6),
    ).toEqual([]);
    const two = [
      plane,
      wall(2, 0, (5 * Math.PI) / 6),
      wall(2, (5 * Math.PI) / 6, (5 * Math.PI) / 3),
    ];
    const edges = [
      { faces: [0, 1] },
      { faces: [0, 2] },
      { faces: [1, 2], centroid: at((5 * Math.PI) / 6) },
    ];
    expect(preparationFaces(two, edges, { ...none, removeHolesBelow: 10 }, 1e-6)).toEqual([]);
    // In a 2×2 grid (1, 2 below; 3, 4 above): the faces form a cycle that does not wind round.
    const lift = (f: FaceSample, dz: number): FaceSample => ({
      ...f,
      nodes: f.nodes!.map(([x, y, zz]): [number, number, number] => [x, y, zz + dz]),
    });
    const grid = [plane, two[1]!, two[2]!, lift(two[1]!, 1), lift(two[2]!, 1)];
    const cells = [
      { faces: [1, 2], centroid: at((5 * Math.PI) / 6) },
      {
        faces: [3, 4],
        centroid: [...at((5 * Math.PI) / 6).slice(0, 2), 2] as [number, number, number],
      },
      {
        faces: [1, 3],
        centroid: [...at((5 * Math.PI) / 12).slice(0, 2), 1.5] as [number, number, number],
      },
      {
        faces: [2, 4],
        centroid: [...at((15 * Math.PI) / 12).slice(0, 2), 1.5] as [number, number, number],
      },
      ...[1, 2, 3, 4].map((f) => ({ faces: [0, f] })),
    ];
    expect(closesRing([1, 2, 3, 4], cells, grid, z)).toBe(false);
    expect(preparationFaces(grid, cells, { ...none, removeHolesBelow: 10 }, 1e-6)).toEqual([]);
    // Nor is it a fillet, however it is split: three 100° faces side by side.
    const thirds = [
      plane,
      ...[0, 1, 2].map((k) => wall(2, (k * 5 * Math.PI) / 9, ((k + 1) * 5 * Math.PI) / 9)),
    ];
    const sides = [
      { faces: [1, 2], centroid: at((5 * Math.PI) / 9) },
      { faces: [2, 3], centroid: at((10 * Math.PI) / 9) },
      ...[1, 2, 3].map((f) => ({ faces: [0, f] })),
    ];
    expect(preparationFaces(thirds, sides, { ...none, removeFilletsBelow: 3 }, 1e-6)).toEqual([]);
    expect(
      preparationFaces(one, [{ faces: [0, 1] }], { ...none, removeFilletsBelow: 3 }, 1e-6),
    ).toEqual([]);
    // Closed by a seam, or by halves meeting along two edges, it is a hole.
    expect(closesRing([1], [{ faces: [0, 1] }, { faces: [1] }], one, z)).toBe(true);
    const halves = [plane, wall(2, 0, Math.PI), wall(2, Math.PI, 2 * Math.PI)];
    const meet = [
      { faces: [1, 2], centroid: at(0) },
      { faces: [1, 2], centroid: at(Math.PI) },
    ];
    expect(closesRing([1, 2], meet, halves, z)).toBe(true);
    // A 350° face sampled coarser than the 10° face beside it: its own middle decides.
    const deg = Math.PI / 180;
    const wide: FaceSample = {
      ...wall(2, 0, 350 * deg),
      nodes: round(turn(0, 350 * deg, 17)),
      middle: at(175 * deg),
    };
    const narrow: FaceSample = {
      ...wall(2, 350 * deg, 360 * deg),
      nodes: round(turn(350 * deg, 360 * deg, 3)),
      middle: at(355 * deg),
    };
    const sliver = [plane, wide, narrow];
    const joins = [
      { faces: [1, 2], centroid: at(0) },
      { faces: [1, 2], centroid: at(350 * deg) },
      { faces: [0, 1] },
      { faces: [0, 2] },
    ];
    expect(closesRing([1, 2], joins, sliver, z)).toBe(true);
    expect(preparationFaces(sliver, joins, { ...none, removeHolesBelow: 5 }, 1e-6)).toEqual([1, 2]);
  });

  it('takes a blind hole bottom kept as several faces, and never the rest of a body', () => {
    // 0 top, 1 wall (with its seam), 2 and 3 the bottom in two halves, 4 a side.
    const half = disc(3);
    const faces = [plane, wall(3, 0, 2 * Math.PI), half, half, plane];
    const edges = [
      { faces: [0, 1] },
      { faces: [1] },
      { faces: [1, 2] },
      { faces: [1, 3] },
      { faces: [2, 3] },
      { faces: [0, 4] },
    ];
    expect(preparationFaces(faces, edges, { ...none, removeHolesBelow: 10 }, 1e-6)).toEqual([
      1, 2, 3,
    ]);
    // A body whose only other faces the through hole borders (top 0 and bottom 2, joined by 3):
    // they lie outside the hole and stay.
    const far: FaceSample = { kind: 'other', radius: Number.NaN, nodes: [[50, 0, 0]] };
    const body = [far, wall(3, 0, 2 * Math.PI), far, far];
    const through = [
      { faces: [0, 1] },
      { faces: [1] },
      { faces: [1, 2] },
      { faces: [0, 3] },
      { faces: [2, 3] },
    ];
    expect(preparationFaces(body, through, { ...none, removeHolesBelow: 10 }, 1e-6)).toEqual([1]);
  });

  it('measures a sphere patch from its centre, whatever its parameter axis', () => {
    // A corner blend: the octant of a sphere of r 1 at the origin.
    const octant: [number, number, number][] = [];
    for (let i = 0; i <= 6; i++)
      for (let j = 0; j <= 6; j++) {
        const [t, f] = [(i * Math.PI) / 12, (j * Math.PI) / 12];
        octant.push([Math.sin(t) * Math.cos(f), Math.sin(t) * Math.sin(f), Math.cos(t)]);
      }
    // About 0.3 π from its middle (more with nodes crowded at a pole), well within 0.45 π.
    const cap = capAngle([0, 0, 0], octant);
    expect(cap).toBeGreaterThan(0.29 * Math.PI);
    expect(cap).toBeLessThan(0.4 * Math.PI);
    const o = Math.SQRT1_2;
    for (const dir of [
      [0, 0, 1],
      [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)],
      [o, 0, o],
    ] as [number, number, number][]) {
      const sphere: FaceSample = {
        kind: 'sphere',
        radius: 1,
        axis: { point: [0, 0, 0], dir },
        nodes: octant,
      };
      expect(
        preparationFaces(
          [plane, sphere],
          [{ faces: [0, 1] }],
          { ...none, removeFilletsBelow: 2 },
          1e-6,
        ),
      ).toEqual([1]);
      // A hemisphere is no blend.
      const dome = {
        ...sphere,
        nodes: octant.flatMap(
          ([x, y, zz]) =>
            [
              [x, y, zz],
              [-x, y, zz],
              [x, -y, zz],
              [-x, -y, zz],
            ] as [number, number, number][],
        ),
      };
      expect(
        preparationFaces(
          [plane, dome],
          [{ faces: [0, 1] }],
          { ...none, removeFilletsBelow: 2 },
          1e-6,
        ),
      ).toEqual([]);
    }
  });

  it('never takes a boss split into quarters for fillets, and measures dense sphere patches', () => {
    // A boss of r 2 on the plane 0, in four convex quarters, with its top 5.
    const quarters = [0, 1, 2, 3].map((k) =>
      wall(2, (k * Math.PI) / 2, ((k + 1) * Math.PI) / 2, false),
    );
    const boss = [plane, ...quarters, plane];
    const ring = [
      ...[1, 2, 3, 4].map((f) => ({ faces: [f, (f % 4) + 1], centroid: at((f * Math.PI) / 2) })),
      ...[1, 2, 3, 4].flatMap((f) => [{ faces: [0, f] }, { faces: [5, f] }]),
    ];
    expect(preparationFaces(boss, ring, { ...none, removeFilletsBelow: 3 }, 1e-6)).toEqual([]);
    expect(preparationFaces(boss, ring, { ...none, removeHolesBelow: 10 }, 1e-6)).toEqual([]);
    // One quarter alone is a fillet.
    expect(
      preparationFaces(
        [plane, quarters[0]!],
        [{ faces: [0, 1] }],
        { ...none, removeFilletsBelow: 3 },
        1e-6,
      ),
    ).toEqual([1]);
    // A sphere of r 1 in eight octants (each touching its three neighbours): no blends.
    const octants: FaceSample[] = [];
    for (const sx of [1, -1])
      for (const sy of [1, -1])
        for (const sz of [1, -1])
          octants.push({
            kind: 'sphere',
            radius: 1,
            axis: z,
            nodes: Array.from({ length: 49 }, (_, n): [number, number, number] => {
              const [t, f] = [((n % 7) * Math.PI) / 12, (Math.floor(n / 7) * Math.PI) / 12];
              return [
                sx * Math.sin(t) * Math.cos(f),
                sy * Math.sin(t) * Math.sin(f),
                sz * Math.cos(t),
              ];
            }),
          });
    const touching = octants.flatMap((_, a) =>
      octants.flatMap((_, b) => (a < b && [1, 2, 4].includes(a ^ b) ? [{ faces: [a, b] }] : [])),
    );
    expect(preparationFaces(octants, touching, { ...none, removeFilletsBelow: 2 }, 1e-6)).toEqual(
      [],
    );
    // Each octant on its own is a corner blend.
    expect(preparationFaces(octants, [], { ...none, removeFilletsBelow: 2 }, 1e-6)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    const dense = Array.from({ length: 200_000 }, (_, i): [number, number, number] => {
      const a = (i / 200_000) * 0.5;
      return [Math.sin(a), 0, Math.cos(a)];
    });
    expect(capAngle([0, 0, 0], dense)).toBeCloseTo(0.25, 2);
  });

  it('keeps explicit faces and nothing else when the thresholds are null', () => {
    expect(
      preparationFaces(
        [plane, plane, plane],
        [{ faces: [0, 1] }, { faces: [1, 2] }, { faces: [0, 2] }],
        { ...none, removeFaces: [1] },
        1e-6,
      ),
    ).toEqual([1]);
    expect(preparationFaces([plane, wall(1, 0, 6.28)], [{ faces: [0, 1] }], none, 1e-6)).toEqual(
      [],
    );
  });
});
