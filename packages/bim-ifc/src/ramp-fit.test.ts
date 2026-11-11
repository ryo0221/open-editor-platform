import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readIfc, slabSlopeFromEdge } from './import';
import { bimStairProfile, deriveBim } from '@editor-platform/bim-core';
import {
  bimFitSlopedPlate,
  bimFitSpiralRamp,
  bimFitStraightStair,
  type BimFacets,
} from './ramp-fit';

type Vec3 = [number, number, number];

interface SpiralOptions {
  n?: number;
  sweep?: number;
  center?: [number, number];
  /** The outer radius at each station. */
  outer?: (i: number) => number;
  /** Moves a corner. */
  shift?: (i: number) => Vec3;
  /** A corner halfway up the outer side at this station, on both faces beside it. */
  splitOuter?: number;
}

/** A spiral ramp's faces, `n` steps round, rising 3,000 mm, 200 mm thick (radii 2,000/5,000). */
function spiral(o: SpiralOptions = {}): BimFacets {
  const n = o.n ?? 48;
  const sweep = o.sweep ?? 2 * Math.PI;
  const [cx, cy] = o.center ?? [100, -50];
  const points: Vec3[] = [];
  const at = (i: number, j: number, k: number) => (i * 2 + j) * 2 + k;
  for (let i = 0; i <= n; i++) {
    const a = 0.3 + (sweep * i) / n;
    for (const rho of [2000, o.outer?.(i) ?? 5000])
      for (const k of [0, 1]) {
        const d = o.shift?.(points.length) ?? [0, 0, 0];
        points.push([
          cx + rho * Math.cos(a) + d[0],
          cy + rho * Math.sin(a) + d[1],
          (3000 * i) / n - 200 * k + d[2],
        ]);
      }
  }
  const loops: number[][] = [];
  for (let i = 0; i < n; i++) {
    loops.push(
      [at(i, 0, 0), at(i, 1, 0), at(i + 1, 1, 0)],
      [at(i, 0, 0), at(i + 1, 1, 0), at(i + 1, 0, 0)],
    );
    loops.push(
      [at(i, 0, 1), at(i + 1, 1, 1), at(i, 1, 1)],
      [at(i, 0, 1), at(i + 1, 0, 1), at(i + 1, 1, 1)],
    );
    loops.push([at(i, 1, 0), at(i, 1, 1), at(i + 1, 1, 1), at(i + 1, 1, 0)]);
    loops.push([at(i, 0, 0), at(i + 1, 0, 0), at(i + 1, 0, 1), at(i, 0, 1)]);
  }
  loops.push([at(0, 0, 0), at(0, 0, 1), at(0, 1, 1), at(0, 1, 0)]);
  loops.push([at(n, 0, 0), at(n, 1, 0), at(n, 1, 1), at(n, 0, 1)]);
  if (o.splitOuter !== undefined) {
    const [lo, hi] = [at(o.splitOuter, 1, 0), at(o.splitOuter, 1, 1)];
    const m = points.length;
    points.push(points[lo]!.map((c, k) => (c + points[hi]![k]!) / 2) as Vec3);
    for (const l of loops)
      for (let k = 0; k < l.length; k++) {
        const [a, b] = [l[k]!, l[(k + 1) % l.length]!];
        if ((a === lo && b === hi) || (a === hi && b === lo)) {
          l.splice(k + 1, 0, m);
          break;
        }
      }
  }
  const edges = loops.flatMap((l) =>
    l.map((a, k): [number, number] => [a, l[(k + 1) % l.length]!]),
  );
  return { points, edges, loops };
}

describe('fitting a spiral ramp to faceted corners (FU2a)', () => {
  it('finds the axis, radii, turn, heights and thickness of a full turn', () => {
    const s = bimFitSpiralRamp(spiral())!;
    expect(s.center[0]).toBeCloseTo(100, 6);
    expect(s.center[1]).toBeCloseTo(-50, 6);
    expect(s.innerRadius).toBeCloseTo(2000, 6);
    expect(s.outerRadius).toBeCloseTo(5000, 6);
    expect(s.startAngle).toBeCloseTo(0.3, 9);
    expect(s.sweep).toBeCloseTo(2 * Math.PI, 9);
    expect(s.zStart).toBeCloseTo(0, 6);
    expect(s.zEnd).toBeCloseTo(3000, 6);
    expect(s.thickness).toBeCloseTo(200, 6);
  });

  it('accepts corners within 1 mm and refuses one 2 mm off (FU-U3)', () => {
    expect(bimFitSpiralRamp(spiral({ shift: (i) => [0, 0, i % 2 ? 0.4 : -0.4] }))).toBeDefined();
    expect(
      bimFitSpiralRamp(spiral({ shift: (i) => (i === 37 ? [0, 0, 2] : [0, 0, 0]) })),
    ).toBeUndefined();
  });

  it('finds the sides of a partial turn whose corners are a little off in plan (Codex)', () => {
    const shift = (i: number): Vec3 => [0.4 * Math.sin(1.5 * i), 0.4 * Math.cos(2 * i), 0];
    const s = bimFitSpiralRamp(spiral({ sweep: (100 * Math.PI) / 180, shift }));
    expect(s).toBeDefined();
    expect(s!.innerRadius).toBeCloseTo(2000, 0);
    expect(s!.outerRadius).toBeCloseTo(5000, 0);
  });

  it('accepts a corner on a side between the top and the underside (Codex)', () => {
    expect(bimFitSpiralRamp(spiral({ splitOuter: 20 }))!.outerRadius).toBeCloseTo(5000, 6);
  });

  it('refuses a ramp narrower over part of its turn (Codex)', () => {
    const narrow = spiral({ outer: (i) => (i >= 16 && i <= 32 ? 4000 : 5000) });
    expect(bimFitSpiralRamp(narrow)).toBeUndefined();
  });

  it('fits a short turn far from the origin as well as near it (Codex)', () => {
    const short = { n: 48, sweep: Math.PI / 12 };
    const near = bimFitSpiralRamp(spiral(short))!;
    const far = bimFitSpiralRamp(spiral({ ...short, center: [900000, 900000] }))!;
    expect(far.center[0] - 900000).toBeCloseTo(near.center[0] - 100, 3);
    expect(far.innerRadius).toBeCloseTo(near.innerRadius, 3);
    expect(far.sweep).toBeCloseTo(near.sweep, 9);
  });

  it('fits every partial turn, the axis from the upright sides (Codex)', () => {
    for (const deg of [15, 100, 110, 120, 200, 270, 400]) {
      const s = bimFitSpiralRamp(spiral({ sweep: (deg * Math.PI) / 180 }));
      expect(s, `${deg}°`).toBeDefined();
      expect(s!.innerRadius, `${deg}°`).toBeCloseTo(2000, 6);
      expect(s!.outerRadius, `${deg}°`).toBeCloseTo(5000, 6);
      expect(s!.sweep, `${deg}°`).toBeCloseTo((deg * Math.PI) / 180, 9);
    }
  });

  it('fits a short turn of few faces, whatever the ends pull (Codex)', () => {
    for (const n of [4, 12, 48])
      for (const deg of [15, 30]) {
        const s = bimFitSpiralRamp(spiral({ n, sweep: (deg * Math.PI) / 180 }));
        expect(s, `${n} faces ${deg}°`).toBeDefined();
        expect(s!.center[0], `${n} faces ${deg}°`).toBeCloseTo(100, 6);
        expect(s!.innerRadius, `${n} faces ${deg}°`).toBeCloseTo(2000, 6);
        expect(s!.outerRadius, `${n} faces ${deg}°`).toBeCloseTo(5000, 6);
      }
  });

  it('leaves corners inside the top near a circle out of the circle fits (Codex)', () => {
    // A corner 10 mm out from the inner end of every radial edge of the top, on the faces both
    // sides of it: the same surface, more corners.
    const m = spiral();
    const n = 48;
    const at = (i: number, j: number, k: number) => (i * 2 + j) * 2 + k;
    for (let i = 0; i <= n; i++) {
      const [a, b] = [at(i, 0, 0), at(i, 1, 0)];
      const [p, q] = [m.points[a]!, m.points[b]!];
      const t = 10 / 3000;
      const mid = m.points.length;
      m.points.push(p.map((c, k) => c + (q[k]! - c) * t) as Vec3);
      for (const l of m.loops)
        for (let k = 0; k < l.length; k++) {
          const [x, y] = [l[k]!, l[(k + 1) % l.length]!];
          if ((x === a && y === b) || (x === b && y === a)) {
            l.splice(k + 1, 0, mid);
            break;
          }
        }
    }
    m.edges = m.loops.flatMap((l) =>
      l.map((a, k): [number, number] => [a, l[(k + 1) % l.length]!]),
    );
    const s = bimFitSpiralRamp(m)!;
    expect(s).toBeDefined();
    expect(s.innerRadius).toBeCloseTo(2000, 6);
    expect(s.outerRadius).toBeCloseTo(5000, 6);
  });

  it('fits a top and an underside faceted at different densities (Codex)', () => {
    // 10 corners along each radial edge of the top at stations 0–23 and of the underside at
    // stations 24–48: the same surfaces, many more corners on one than the other in places.
    const m = spiral();
    const at = (i: number, j: number, k: number) => (i * 2 + j) * 2 + k;
    const split = (a: number, b: number) => {
      const [p, q] = [m.points[a]!, m.points[b]!];
      const ids: number[] = [];
      for (let k = 1; k <= 10; k++) {
        ids.push(m.points.length);
        m.points.push(p.map((c, d) => c + ((q[d]! - c) * k) / 11) as Vec3);
      }
      for (const l of m.loops)
        for (let k = 0; k < l.length; k++) {
          const [x, y] = [l[k]!, l[(k + 1) % l.length]!];
          if (x === a && y === b) l.splice(k + 1, 0, ...ids);
          else if (x === b && y === a) l.splice(k + 1, 0, ...[...ids].reverse());
          else continue;
          break;
        }
    };
    for (let i = 0; i <= 48; i++) {
      const k = i < 24 ? 0 : 1;
      split(at(i, 0, k), at(i, 1, k));
    }
    m.edges = m.loops.flatMap((l) =>
      l.map((a, k): [number, number] => [a, l[(k + 1) % l.length]!]),
    );
    const s = bimFitSpiralRamp(m)!;
    expect(s).toBeDefined();
    expect(s.zEnd - s.zStart).toBeCloseTo(3000, 6);
    expect(s.thickness).toBeCloseTo(200, 6);
  });

  it('refuses a flat ring', () => {
    const level = spiral();
    level.points = level.points.map((p, i): Vec3 => [p[0], p[1], i % 2 ? -200 : 0]);
    expect(bimFitSpiralRamp(level)).toBeUndefined();
  });
});

const area = (l: readonly (readonly number[])[]) =>
  l.reduce(
    (n, p, k) => n + p[0]! * l[(k + 1) % l.length]![1]! - l[(k + 1) % l.length]![0]! * p[1]!,
    0,
  ) / 2;

/** A plate 6 m by 1.5 m rising 1 m along x, 200 mm deep, as triangles; `dz` moves corners. */
function plate(dz: (i: number) => number = () => 0): BimFacets {
  const base: Vec3[] = [
    [0, 0, 0],
    [6000, 0, 1000],
    [6000, 1500, 1000],
    [0, 1500, 0],
    [0, 0, -200],
    [6000, 0, 800],
    [6000, 1500, 800],
    [0, 1500, -200],
  ];
  const points = base.map((p, i): Vec3 => [p[0], p[1], p[2] + dz(i)]);
  const loops = [
    [0, 1, 2],
    [0, 2, 3],
    [4, 7, 6],
    [4, 6, 5],
    [0, 4, 5, 1],
    [1, 5, 6, 2],
    [2, 6, 7, 3],
    [3, 7, 4, 0],
  ];
  const edges = loops.flatMap((l) =>
    l.map((a, k): [number, number] => [a, l[(k + 1) % l.length]!]),
  );
  return { points, edges, loops };
}

describe('fitting a sloped plate to faceted corners (FU2b)', () => {
  it('finds the outline, the grade, the top and the vertical thickness', () => {
    const p = bimFitSlopedPlate(plate())!;
    expect(p.outer).toHaveLength(4);
    expect(p.holes).toEqual([]);
    expect(p.grade[0]).toBeCloseTo(1 / 6, 12);
    expect(p.grade[1]).toBeCloseTo(0, 12);
    expect(p.c).toBeCloseTo(0, 9);
    expect(p.thickness).toBeCloseTo(200, 9);
  });

  it('accepts corners inside the underside (Codex)', () => {
    const m = plate();
    m.points.push([3000, 750, 300]);
    m.loops.splice(2, 2, [4, 7, 8], [7, 6, 8], [6, 5, 8], [5, 4, 8]);
    m.edges = m.loops.flatMap((l) =>
      l.map((a, k): [number, number] => [a, l[(k + 1) % l.length]!]),
    );
    expect(bimFitSlopedPlate(m)!.thickness).toBeCloseTo(200, 9);
  });

  it('accepts corners on an upright side between the top and the underside (Codex)', () => {
    const m = plate();
    m.points.push([3000, 0, 400]);
    m.loops.splice(4, 1, [0, 4, 8], [4, 5, 8], [5, 1, 8], [1, 0, 8]);
    m.edges = m.loops.flatMap((l) =>
      l.map((a, k): [number, number] => [a, l[(k + 1) % l.length]!]),
    );
    expect(bimFitSlopedPlate(m)!.thickness).toBeCloseTo(200, 9);
  });

  it('takes sides 0.4 mm off upright as upright (FU-U3, Codex)', () => {
    const m = plate();
    for (const i of [4, 5, 6, 7]) m.points[i]![0] += 0.4;
    const p = bimFitSlopedPlate(m)!;
    expect(p.grade[0]).toBeCloseTo(1 / 6, 9);
    expect(Math.abs(p.thickness - 200)).toBeLessThan(0.1);
  });

  it('keeps a strip of the top narrower than the tolerance on the top (Codex)', () => {
    // The unchanged top cut into strips at x = 3000 and 3000.5 mm.
    const m = plate();
    const z = (x: number) => x / 6;
    m.points.push([3000, 0, z(3000)], [3000, 1500, z(3000)], [3000.5, 0, z(3000.5)]);
    m.points.push([3000.5, 1500, z(3000.5)]);
    m.loops.splice(0, 2, [0, 8, 9, 3], [8, 10, 11, 9], [10, 1, 2, 11]);
    m.loops[m.loops.findIndex((l) => l.join() === '0,4,5,1')] = [0, 4, 5, 1, 10, 8];
    m.loops[m.loops.findIndex((l) => l.join() === '2,6,7,3')] = [2, 6, 7, 3, 9, 11];
    m.edges = m.loops.flatMap((l) =>
      l.map((a, k): [number, number] => [a, l[(k + 1) % l.length]!]),
    );
    const p = bimFitSlopedPlate(m)!;
    expect(p.holes).toEqual([]);
    expect(p.thickness).toBeCloseTo(200, 9);
    expect(Math.abs(area(p.outer))).toBeCloseTo(6000 * 1500, 3);
  });

  it("checks the slab made from a level edge against the body's own corners (Codex)", () => {
    // Each fit stays within 1 mm, but the two together put the far underside corner 1.5 mm off.
    const off = [-0.7, 0.1, 0.6, 0.7, -0.4, -1, 1, -0.3];
    const p = bimFitSlopedPlate(plate((i) => off[i]!))!;
    const outer = p.outer.map(([x, y]): [number, number] => [x, y]);
    const corners = { ...p.corners, thickness: p.thickness };
    // Every slab accepted from a level edge keeps every corner of the body within 1 mm.
    let accepted = 0;
    outer.forEach(([x0, y0], k) => {
      const f = slabSlopeFromEdge(outer, [], p.grade, p.c, k, corners);
      if (!f) return;
      accepted++;
      const [x1, y1] = outer[(k + 1) % outer.length]!;
      const len = Math.hypot(x1 - x0, y1 - y0);
      const n = [-(y1 - y0) / len, (x1 - x0) / len];
      const run = Math.max(...outer.map(([x, y]) => Math.abs((x - x0) * n[0]! + (y - y0) * n[1]!)));
      const top = ([x, y]: readonly number[]) =>
        f.zTop + ((f.zEnd - f.zTop) * Math.abs((x! - x0) * n[0]! + (y! - y0) * n[1]!)) / run;
      for (const c of p.corners.top) expect(Math.abs(top(c) - c[2])).toBeLessThanOrEqual(1);
      for (const c of p.corners.under)
        expect(Math.abs(top(c) - p.thickness - c[2])).toBeLessThanOrEqual(1);
    });
    expect(accepted).toBeGreaterThan(0);
    // A corner 1.5 mm off the slab one edge would make refuses that edge.
    const low = outer.findIndex(([x], k) => x === 0 && outer[(k + 1) % 4]![0] === 0);
    const far = {
      ...corners,
      under: [...corners.under, [6000, 1500, 798.5] as [number, number, number]],
    };
    expect(slabSlopeFromEdge(outer, [], p.grade, p.c, low, corners)).toBeDefined();
    expect(slabSlopeFromEdge(outer, [], p.grade, p.c, low, far)).toBeUndefined();
  });

  it("fits the top through its corners' spread, not its highest corner (Codex)", () => {
    // The top triangulated about two inner corners 0.8 mm above and below it.
    const m = plate();
    m.points.push([2000, 750, 2000 / 6 + 0.8], [4000, 750, 4000 / 6 - 0.8]);
    m.loops.splice(0, 2, [0, 8, 3], [0, 1, 9], [0, 9, 8], [1, 2, 9], [2, 3, 8], [2, 8, 9]);
    m.edges = m.loops.flatMap((l) =>
      l.map((a, k): [number, number] => [a, l[(k + 1) % l.length]!]),
    );
    const p = bimFitSlopedPlate(m)!;
    expect(p.c).toBeCloseTo(0, 6);
    expect(p.thickness).toBeCloseTo(200, 6);
  });

  it('refuses a wedge and a corner 4 mm off the others (FU-U3)', () => {
    expect(bimFitSlopedPlate(plate((i) => (i === 5 ? 300 : 0)))).toBeUndefined();
    expect(bimFitSlopedPlate(plate((i) => (i === 6 ? 4 : 0)))).toBeUndefined();
  });
});

interface FlightOptions {
  risers?: number;
  riser?: number;
  tread?: number;
  waist?: number;
  width?: number;
  direction?: number;
  start?: [number, number];
  z?: number;
  /** Splits each face but the sides into triangles. */
  triangles?: boolean;
  /** Moves a corner. */
  shift?: (i: number) => Vec3;
}

/** A straight flight's faces as the LS6 `stair` makes it, outward. */
function flight(o: FlightOptions = {}): BimFacets {
  const n = o.risers ?? 17;
  const shape = bimStairProfile(n, o.riser ?? 3000 / 17, o.tread ?? 260, o.waist ?? 150);
  if (typeof shape === 'string') throw new Error(shape);
  const prof = shape.profile;
  const a = o.direction ?? 0.4;
  const d = [Math.cos(a), Math.sin(a)];
  const nr = [-d[1]!, d[0]!];
  const [sx, sy] = o.start ?? [1000, -2000];
  const w = o.width ?? 1200;
  const points: Vec3[] = [];
  for (const k of [-1, 1])
    for (const [u, z] of prof) {
      const dl = o.shift?.(points.length) ?? [0, 0, 0];
      points.push([
        sx + u! * d[0]! + ((k * w) / 2) * nr[0]! + dl[0],
        sy + u! * d[1]! + ((k * w) / 2) * nr[1]! + dl[1],
        (o.z ?? 0) + z! + dl[2],
      ]);
    }
  const m = prof.length;
  // The profile's orientation in (u, z): its outward normals are to one side of each edge.
  let area = 0;
  prof.forEach((p, i) => {
    const q = prof[(i + 1) % m]!;
    area += p[0]! * q[1]! - q[0]! * p[1]!;
  });
  const ccw = area > 0 ? 1 : -1;
  const normal = (loop: number[]): Vec3 => {
    const v: Vec3 = [0, 0, 0];
    loop.forEach((i, k) => {
      const p = points[i]!;
      const q = points[loop[(k + 1) % loop.length]!]!;
      v[0] += (p[1] - q[1]) * (p[2] + q[2]);
      v[1] += (p[2] - q[2]) * (p[0] + q[0]);
      v[2] += (p[0] - q[0]) * (p[1] + q[1]);
    });
    return v;
  };
  const loops: number[][] = [];
  const add = (loop: number[], out: Vec3) => {
    const v = normal(loop);
    const l = v[0] * out[0] + v[1] * out[1] + v[2] * out[2] < 0 ? [...loop].reverse() : loop;
    if (o.triangles && l.length === 4) loops.push([l[0]!, l[1]!, l[2]!], [l[0]!, l[2]!, l[3]!]);
    else loops.push(l);
  };
  add([...Array(m).keys()], [-nr[0]!, -nr[1]!, 0]);
  add(
    [...Array(m).keys()].map((i) => i + m),
    [nr[0]!, nr[1]!, 0],
  );
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const [du, dz] = [prof[j]![0]! - prof[i]![0]!, prof[j]![1]! - prof[i]![1]!];
    // Right of the edge for a counter-clockwise profile, left for a clockwise one.
    const [ou, oz] = [ccw * dz, -ccw * du];
    add([i, j, j + m, i + m], [ou * d[0]!, ou * d[1]!, oz]);
  }
  const edges: [number, number][] = [];
  for (const l of loops) l.forEach((x, k) => edges.push([x, l[(k + 1) % l.length]!]));
  return { points, edges, loops };
}

describe('fitting a straight stair (LS7)', () => {
  it('reads back the stair its faces stand for, from polygons or triangles', () => {
    for (const triangles of [false, true]) {
      const s = bimFitStraightStair(flight({ triangles }))!;
      expect(s).toBeDefined();
      expect(s.risers).toBe(17);
      expect(s.riser).toBeCloseTo(3000 / 17, 9);
      expect(s.tread).toBeCloseTo(260, 9);
      expect(s.waist).toBeCloseTo(150, 9);
      expect(s.width).toBeCloseTo(1200, 9);
      expect(s.directionRad).toBeCloseTo(0.4, 12);
      expect(s.start[0]).toBeCloseTo(1000, 9);
      expect(s.start[1]).toBeCloseTo(-2000, 9);
      expect(s.zBase).toBeCloseTo(0, 9);
    }
    // A thick waist (no foot on the floor, its underside reaching the top): the same.
    const thick = bimFitStraightStair(
      flight({ risers: 10, riser: 180, tread: 280, waist: 200, direction: -2, z: 3000 }),
    )!;
    expect(thick).toMatchObject({ risers: 10 });
    expect(thick.waist).toBeCloseTo(200, 9);
    expect(thick.directionRad).toBeCloseTo(-2, 12);
    expect(thick.zBase).toBeCloseTo(3000, 9);
    // Two risers: one tread.
    expect(
      bimFitStraightStair(flight({ risers: 2, riser: 170, tread: 300, waist: 200 })),
    ).toMatchObject({
      risers: 2,
    });
  });

  it('keeps corners within 1 mm of the fitted stair, and refuses others', () => {
    // 0.4 mm off: kept.
    const near = flight({ shift: (i) => (i === 5 ? [0, 0, 0.4] : [0, 0, 0]) });
    expect(bimFitStraightStair(near)).toBeDefined();
    // A nosing 3 mm out, or a tread 5 mm lower: not this stair.
    expect(
      bimFitStraightStair(flight({ shift: (i) => (i === 5 ? [3, 0, 0] : [0, 0, 0]) })),
    ).toBeUndefined();
    expect(
      bimFitStraightStair(flight({ shift: (i) => (i === 6 || i === 7 ? [0, 0, -5] : [0, 0, 0]) })),
    ).toBeUndefined();
    // A tread's triangle split at its centroid: the same solid (Codex).
    const split = flight({ triangles: true });
    const up = split.loops.findIndex((l) => {
      const zs = l.map((i) => split.points[i]![2]);
      return zs.every((z) => Math.abs(z - zs[0]!) < 1e-9) && zs[0]! > 1000;
    });
    const [a, b, c] = split.loops[up]!;
    const m = split.points.length;
    split.points.push(
      [0, 1, 2].map(
        (k) => (split.points[a!]![k]! + split.points[b!]![k]! + split.points[c!]![k]!) / 3,
      ) as Vec3,
    );
    split.loops.splice(up, 1, [a!, b!, m], [b!, c!, m], [c!, a!, m]);
    expect(bimFitStraightStair(split)).toMatchObject({ risers: 17 });
    // A tread on the 500 mm limit, the flight turned: rounding does not refuse it (Codex).
    const wide = bimFitStraightStair(
      flight({ tread: 500, riser: 180, risers: 10, waist: 300, direction: Math.PI / 6 }),
    )!;
    expect(wide.tread).toBe(500);
    // Its underside meeting the floor 0.5 mm from the first riser: the waist kept (Codex).
    const foot = bimFitStraightStair(
      flight({ riser: 180, tread: 300, waist: 154.60597450597174, direction: 0 }),
    )!;
    expect(foot.waist).toBeCloseTo(154.60597450597174, 6);
    // Its underside reaching the top end 0.5 mm above the floor: that corner is not the foot
    // (Codex).
    const low = bimFitStraightStair(
      flight({
        risers: 2,
        riser: 180,
        tread: 300,
        waist: 308.26870679365965,
        direction: 0,
        start: [0, 0],
      }),
    )!;
    expect(low.waist).toBeCloseTo(308.26870679365965, 6);
    // Treads 0.6 mm low on one side, 0.6 mm high on the other: within 1 mm, the same (Codex).
    const tilted = flight({ direction: 0, start: [0, 0], waist: 200 });
    const half = tilted.points.length / 2;
    tilted.points.forEach((p, i) => {
      const k = p[2] / (3000 / 17);
      if (k > 0.5 && Math.abs(k - Math.round(k)) < 1e-9) p[2] += i < half ? -0.6 : 0.6;
    });
    expect(bimFitStraightStair(tilted)).toMatchObject({ risers: 17, width: 1200 });
    // The same tilted flight with its first tread in 20 strips across it: their mean heights
    // spread 1.14 mm, one tread still (Codex).
    const strips = flight({ riser: 180, tread: 300, waist: 200, direction: 0, start: [0, 0] });
    const sh = strips.points.length / 2;
    strips.points.forEach((p, i) => {
      const k = p[2] / 180;
      if (k > 0.5 && Math.abs(k - Math.round(k)) < 1e-9) p[2] += i < sh ? -0.6 : 0.6;
    });
    expect(bimFitStraightStair(strips)).toBeDefined();
    const first = strips.loops.findIndex(
      (l) =>
        l.length === 4 &&
        l.every((i) => Math.abs(Math.abs(strips.points[i]![2] - 180) - 0.6) < 1e-9),
    );
    const [sa, sb, sc, sd] = strips.loops[first]!.map((i) => strips.points[i]!);
    // a–b and d–c run along the tread (same side), a–d across it.
    const along = Math.abs(sa![1] - sb![1]) < 1e-9;
    const [p0, p1, q0, q1] = along ? [sa!, sd!, sb!, sc!] : [sa!, sb!, sd!, sc!];
    const lerp = (a: Vec3, b: Vec3, t: number) =>
      [0, 1, 2].map((k) => a[k]! + (b[k]! - a[k]!) * t) as Vec3;
    const at0 = strips.points.length;
    for (let j = 0; j <= 20; j++) strips.points.push(lerp(p0, p1, j / 20), lerp(q0, q1, j / 20));
    const cut: number[][] = [];
    for (let j = 0; j < 20; j++)
      cut.push([at0 + 2 * j, at0 + 2 * j + 1, at0 + 2 * j + 3, at0 + 2 * j + 2]);
    strips.loops = strips.loops.filter((_, k) => k !== first).concat(cut);
    const means = cut.map((l) => l.reduce((a, i) => a + strips.points[i]![2], 0) / 4);
    expect(Math.max(...means) - Math.min(...means)).toBeGreaterThan(1);
    expect(bimFitStraightStair(strips)).toMatchObject({ risers: 17, width: 1200 });
    // A triangular hole through it across its width: its corners within the sides' profile,
    // its faces inside the solid. Not this stair (Codex).
    const holed = flight({ riser: 180, tread: 300, waist: 300, direction: 0, start: [0, 0] });
    expect(bimFitStraightStair(holed)).toBeDefined();
    const tri: [number, number][] = [
      [1000, 480],
      [1100, 520],
      [1040, 600],
    ];
    const at = holed.points.length;
    for (const y of [-600, 600]) for (const [u, z] of tri) holed.points.push([u, y, z]);
    holed.loops.push([at, at + 1, at + 2], [at + 5, at + 4, at + 3]);
    for (let k = 0; k < 3; k++) {
      const j = (k + 1) % 3;
      holed.loops.push([at + j, at + k, at + 3 + k, at + 3 + j]);
    }
    expect(bimFitStraightStair(holed)).toBeUndefined();
    // One tread split into a 400 × 400 grid (160,000 more corners): the same stair, not an
    // argument-limit error (Codex).
    const dense = flight({ direction: 0, start: [0, 0], waist: 200 });
    const t = dense.loops.findIndex((l) => {
      const zs = l.map((i) => dense.points[i]![2]);
      return l.length === 4 && zs.every((z) => Math.abs(z - zs[0]!) < 1e-9) && zs[0]! > 1000;
    });
    const [qa, qb, , qd] = dense.loops[t]!.map((i) => dense.points[i]!);
    const n = 400;
    const base = dense.points.length;
    for (let i = 0; i <= n; i++)
      for (let j = 0; j <= n; j++)
        dense.points.push(
          [0, 1, 2].map(
            (k) => qa![k]! + ((qb![k]! - qa![k]!) * i) / n + ((qd![k]! - qa![k]!) * j) / n,
          ) as Vec3,
        );
    const g = (i: number, j: number) => base + i * (n + 1) + j;
    const cells: number[][] = [];
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        cells.push(
          [g(i, j), g(i + 1, j), g(i + 1, j + 1)],
          [g(i, j), g(i + 1, j + 1), g(i, j + 1)],
        );
    dense.loops = dense.loops.filter((_, k) => k !== t).concat(cells);
    expect(dense.points.length).toBeGreaterThan(160_000);
    expect(bimFitStraightStair(dense)).toMatchObject({ risers: 17, width: 1200 });
    // A spiral ramp, a sloped plate: no treads, not a stair.
    expect(bimFitStraightStair(spiral())).toBeUndefined();
  });

  it('imports a flight near its least waist with a waist its rounded stair keeps (Codex)', () => {
    // F56's Flight C given the faces of 17 risers of 160 mm, 300 mm treads and a waist
    // 141.1773617647059 mm, its least: rounded to 141.177 it would cut the steps.
    const f = flight({
      riser: 160,
      tread: 300,
      waist: 141.1773617647059,
      direction: 0,
      start: [0, 0],
    });
    expect(bimFitStraightStair(f)).toBeDefined();
    expect(typeof bimStairProfile(17, 160, 300, 141.177)).toBe('string');
    const m = (v: number) => (v / 1000).toPrecision(17);
    const pts = f.points.map((p) => `(${p.map(m).join(',')})`).join(',');
    const faces = f.loops.map(
      (l, k) => `#${5000 + k}=IFCINDEXEDPOLYGONALFACE((${l.map((i) => i + 1).join(',')}));`,
    );
    const text = new TextDecoder()
      .decode(readFileSync(new URL('../fixtures/f56-foreign-stairs.ifc', import.meta.url)))
      .replace(/^#1401=.*$/m, `#1401=IFCCARTESIANPOINTLIST3D((${pts}),$);`)
      .replace(
        /^#1402=.*$/m,
        `#1402=IFCPOLYGONALFACESET(#1401,.T.,(${f.loops.map((_, k) => `#${5000 + k}`).join(',')}),$);\n${faces.join('\n')}`,
      );
    const r = readIfc(new TextEncoder().encode(text), { acceptLoss: true });
    if (r.status !== 'imported') throw new Error(r.status);
    expect(r.report.losses.map((l) => l.name)).toEqual(['Stair B']);
    const c = r.document.elements.find((e) => e.name === 'Flight C')!;
    expect(c).toMatchObject({ kind: 'stair', risers: 17, treadMm: 300 });
    expect(deriveBim(r.document).diagnostics).toEqual([]);
  });
});
