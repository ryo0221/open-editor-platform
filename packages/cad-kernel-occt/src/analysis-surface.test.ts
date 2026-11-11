import { describe, expect, it } from 'vitest';
import {
  AnalysisSurfaceLimit,
  finishSurface,
  flipSurface,
  improveSurface,
  nearSize,
  seedSurface,
  refineSurface,
  smoothSurface,
  type RawSurface,
  type SurfaceSizing,
  type Xyz,
} from './analysis-surface';

/**
 * A unit cube as the kernel would give it: two triangles per face, each face's UV its two other
 * coordinates, its twelve edges as straight chains with parameters 0 and 1.
 */
function cube(): RawSurface {
  const points: number[] = [];
  for (let i = 0; i < 8; i++) points.push(i & 1, (i >> 1) & 1, (i >> 2) & 1);
  const id = (x: number, y: number, z: number) => x + 2 * y + 4 * z;
  // Faces x0, x1, y0, y1, z0, z1: corners counter-clockwise seen from outside.
  const quads: [number, number, number, number][] = [
    [id(0, 0, 0), id(0, 0, 1), id(0, 1, 1), id(0, 1, 0)],
    [id(1, 0, 0), id(1, 1, 0), id(1, 1, 1), id(1, 0, 1)],
    [id(0, 0, 0), id(1, 0, 0), id(1, 0, 1), id(0, 0, 1)],
    [id(0, 1, 0), id(0, 1, 1), id(1, 1, 1), id(1, 1, 0)],
    [id(0, 0, 0), id(0, 1, 0), id(1, 1, 0), id(1, 0, 0)],
    [id(0, 0, 1), id(1, 0, 1), id(1, 1, 1), id(0, 1, 1)],
  ];
  const axisOf = (f: number) => f >> 1;
  const uvOf = (f: number, p: number): [number, number] => {
    const c = [points[3 * p]!, points[3 * p + 1]!, points[3 * p + 2]!];
    const others = [0, 1, 2].filter((d) => d !== axisOf(f));
    return [c[others[0]!]!, c[others[1]!]!];
  };
  const triangles: RawSurface['triangles'] = [];
  quads.forEach((q, f) => {
    for (const t of [
      [q[0], q[1], q[2]],
      [q[0], q[2], q[3]],
    ] as [number, number, number][])
      triangles.push({ v: t, face: f, uv: [uvOf(f, t[0]), uvOf(f, t[1]), uvOf(f, t[2])] });
  });
  const edges: [number, number][] = [];
  for (let a = 0; a < 8; a++)
    for (let b = a + 1; b < 8; b++) if ([1, 2, 4].includes(a ^ b)) edges.push([a, b]);
  return {
    points,
    triangles,
    shapeFaces: 6,
    chains: edges.map((e) => ({ nodes: [...e], params: [0, 1] })),
    surfaceAt(face, u, v) {
      const others = [0, 1, 2].filter((d) => d !== axisOf(face));
      const p: Xyz = [0, 0, 0];
      p[axisOf(face)] = face & 1;
      p[others[0]!] = u;
      p[others[1]!] = v;
      return p;
    },
    uvAt(face, p) {
      const others = [0, 1, 2].filter((d) => d !== axisOf(face));
      return [p[others[0]!]!, p[others[1]!]!];
    },
    curveAt(edge, t) {
      const [a, b] = edges[edge]!;
      return [0, 1, 2].map((d) => points[3 * a + d]! * (1 - t) + points[3 * b + d]! * t) as Xyz;
    },
  };
}

/** The unit cube scaled to sx × sy × sz (its UV stays the unit square's). */
function box(sx: number, sy: number, sz: number): RawSurface {
  const c = cube();
  const k = [sx, sy, sz];
  const scale = (p: Xyz): Xyz => [p[0] * sx, p[1] * sy, p[2] * sz];
  return {
    ...c,
    points: c.points.map((x, i) => x * k[i % 3]!),
    surfaceAt: (f, u, v) => scale(c.surfaceAt(f, u, v)!),
    uvAt: (f, p, start) => c.uvAt(f, [p[0] / sx, p[1] / sy, p[2] / sz], start),
    curveAt: (e, t) => scale(c.curveAt(e, t)!),
  };
}

/** The same surface with every face's UV turned 45° (a strip runs diagonally through its UV box). */
function turned(raw: RawSurface): RawSurface {
  const r = Math.SQRT1_2;
  const to = ([u, v]: [number, number]): [number, number] => [r * (u - v), r * (u + v)];
  const from = (u: number, v: number): [number, number] => [r * (u + v), r * (v - u)];
  return {
    ...raw,
    triangles: raw.triangles.map((t) => ({
      ...t,
      uv: t.uv!.map(to) as [[number, number], [number, number], [number, number]],
    })),
    surfaceAt: (f, u, v) => raw.surfaceAt(f, ...from(u, v)),
    uvAt: (f, p, start) => {
      const w = raw.uvAt(f, p, start);
      return w && to(w);
    },
  };
}

const longest = (s: ReturnType<typeof finishSurface>, face?: number) => {
  let max = 0;
  for (let t = 0; t < s.faces.length; t++) {
    if (face !== undefined && s.faces[t] !== face) continue;
    for (let j = 0; j < 3; j++) {
      const a = s.triangles[3 * t + j]!,
        b = s.triangles[3 * t + ((j + 1) % 3)]!;
      max = Math.max(
        max,
        Math.hypot(...[0, 1, 2].map((d) => s.points[3 * a + d]! - s.points[3 * b + d]!)),
      );
    }
  }
  return max;
};
/** Each directed edge once and its reverse once: closed and consistently wound. */
const closed = (s: ReturnType<typeof finishSurface>) => {
  const np = s.points.length / 3;
  const directed = new Set<number>();
  for (let t = 0; t < s.faces.length; t++)
    for (let j = 0; j < 3; j++) {
      const k = s.triangles[3 * t + j]! * np + s.triangles[3 * t + ((j + 1) % 3)]!;
      if (directed.has(k)) return false;
      directed.add(k);
    }
  for (const k of directed) if (!directed.has((k % np) * np + Math.floor(k / np))) return false;
  return true;
};
/** The smallest corner angle of all triangles (degrees). */
const smallestAngle = (s: ReturnType<typeof finishSurface>) => {
  let min = 180;
  const P = (i: number) => [0, 1, 2].map((d) => s.points[3 * i + d]!);
  for (let t = 0; t < s.faces.length; t++)
    for (let j = 0; j < 3; j++) {
      const o = P(s.triangles[3 * t + j]!),
        a = P(s.triangles[3 * t + ((j + 1) % 3)]!),
        b = P(s.triangles[3 * t + ((j + 2) % 3)]!);
      const u = a.map((x, d) => x - o[d]!),
        v = b.map((x, d) => x - o[d]!);
      const cos =
        (u[0]! * v[0]! + u[1]! * v[1]! + u[2]! * v[2]!) / (Math.hypot(...u) * Math.hypot(...v));
      min = Math.min(min, (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI);
    }
  return min;
};
/** Triangles whose normal points away from the origin. */
const outwardCount = (s: ReturnType<typeof finishSurface>) => {
  let n = 0;
  for (let t = 0; t < s.faces.length; t++) {
    const P = (j: number) => [0, 1, 2].map((d) => s.points[3 * s.triangles[3 * t + j]! + d]!);
    const [a, b, c] = [P(0), P(1), P(2)];
    const u = b.map((x, d) => x - a[d]!),
      v = c.map((x, d) => x - a[d]!);
    const nrm = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ];
    const centroid = [0, 1, 2].map((d) => (a[d]! + b[d]! + c[d]!) / 3);
    if (nrm[0]! * centroid[0]! + nrm[1]! * centroid[1]! + nrm[2]! * centroid[2]! > 0) n++;
  }
  return n;
};
const volume = (s: ReturnType<typeof finishSurface>) => {
  let v = 0;
  for (let t = 0; t < s.faces.length; t++) {
    const [a, b, c] = [0, 1, 2].map((j) => 3 * s.triangles[3 * t + j]!);
    const p = (i: number, d: number) => s.points[i + d]!;
    v +=
      p(a!, 0) * (p(b!, 1) * p(c!, 2) - p(b!, 2) * p(c!, 1)) -
      p(a!, 1) * (p(b!, 0) * p(c!, 2) - p(b!, 2) * p(c!, 0)) +
      p(a!, 2) * (p(b!, 0) * p(c!, 1) - p(b!, 1) * p(c!, 0));
  }
  return v / 6;
};

describe('analysis surface refinement (R3d-2b)', () => {
  it('keeps the kernel triangles without a size', () => {
    const raw = cube();
    refineSurface(raw, { maxEdgeMm: Infinity, maxTriangles: 1000 });
    expect(finishSurface(raw).faces.length).toBe(12);
  });

  it('splits edges until none is longer than the size, keeping the surface closed and its chains', () => {
    const raw = cube();
    refineSurface(raw, { maxEdgeMm: 0.3, maxTriangles: 100_000 });
    const s = finishSurface(raw);
    expect(longest(s)).toBeLessThanOrEqual(0.3);
    expect(closed(s)).toBe(true);
    expect(volume(s)).toBeCloseTo(1, 12);
    // Each chain runs from its corner to its corner along surface edges, with no gaps.
    const np = s.points.length / 3;
    const undirected = new Set<number>();
    for (let t = 0; t < s.faces.length; t++)
      for (let j = 0; j < 3; j++) {
        const a = s.triangles[3 * t + j]!,
          b = s.triangles[3 * t + ((j + 1) % 3)]!;
        undirected.add(Math.min(a, b) * np + Math.max(a, b));
      }
    for (let k = 0; k < s.shapeEdges; k++) {
      const c = s.edges.nodes.subarray(s.edges.offsets[k]!, s.edges.offsets[k + 1]!);
      expect(c.length).toBeGreaterThan(2);
      expect(c[0]).toBe(raw.chains[k]!.nodes[0]);
      for (let i = 1; i < c.length; i++)
        expect(undirected.has(Math.min(c[i - 1]!, c[i]!) * np + Math.max(c[i - 1]!, c[i]!))).toBe(
          true,
        );
    }
    // A cube has no curved mid points.
    expect(s.midpoints.pairs.length).toBe(0);
  });

  it('refines one face further, the edges it shares included', () => {
    const raw = cube();
    refineSurface(raw, { maxEdgeMm: 0.5, faces: new Map([[1, 0.1]]), maxTriangles: 100_000 });
    const s = finishSurface(raw);
    expect(longest(s, 1)).toBeLessThanOrEqual(0.1);
    expect(longest(s, 0)).toBeLessThanOrEqual(0.5);
    expect(longest(s, 0)).toBeGreaterThan(0.1);
    expect(closed(s)).toBe(true);
  });

  it('grades the refinement into the faces around a finely sized one (longest-edge propagation)', () => {
    const raw = cube();
    refineSurface(raw, { maxEdgeMm: Infinity, faces: new Map([[1, 0.02]]), maxTriangles: 200_000 });
    const s = finishSurface(raw);
    expect(longest(s, 1)).toBeLessThanOrEqual(0.02);
    expect(closed(s)).toBe(true);
    // Without propagation the neighbours become fans of 0.2° slivers; Rivara's bound keeps
    // half the starting smallest angle (45°).
    expect(smallestAngle(s)).toBeGreaterThanOrEqual(22.5 - 1e-9);
  });

  it('puts a split point of a curved edge at its own UV on a flat face', () => {
    // A quarter disc on z = 0: a fan of two triangles from the centre, its arc a chain.
    const arc = (t: number): Xyz => [Math.cos(t), Math.sin(t), 0];
    const points = [0, 0, 0, ...arc(0), ...arc(Math.PI / 4), ...arc(Math.PI / 2)];
    const raw: RawSurface = {
      points,
      triangles: [
        {
          v: [0, 1, 2],
          face: 0,
          uv: [
            [0, 0],
            [1, 0],
            [Math.SQRT1_2, Math.SQRT1_2],
          ],
        },
        {
          v: [0, 2, 3],
          face: 0,
          uv: [
            [0, 0],
            [Math.SQRT1_2, Math.SQRT1_2],
            [0, 1],
          ],
        },
      ],
      shapeFaces: 1,
      chains: [{ nodes: [1, 2, 3], params: [0, Math.PI / 4, Math.PI / 2] }],
      surfaceAt: (_, u, v) => [u, v, 0],
      curveAt: (_, t) => arc(t),
      uvAt: (_, p) => [p[0], p[1]],
    };
    refineSurface(raw, { maxEdgeMm: 0.1, maxTriangles: 100_000 });
    for (const T of raw.triangles) {
      // Every corner's UV is its point, and every triangle still faces +z.
      T.v.forEach((p, j) => {
        expect(T.uv![j]![0]).toBeCloseTo(raw.points[3 * p]!, 12);
        expect(T.uv![j]![1]).toBeCloseTo(raw.points[3 * p + 1]!, 12);
      });
      const [a, b, c] = T.v.map((p) => [raw.points[3 * p]!, raw.points[3 * p + 1]!]);
      expect(
        (b![0]! - a![0]!) * (c![1]! - a![1]!) - (b![1]! - a![1]!) * (c![0]! - a![0]!),
      ).toBeGreaterThan(0);
    }
  });

  it("never folds the surface at a sphere's poles, where UV middles jump", () => {
    // A unit sphere, 16 longitudes × 8 latitude steps, the seam u = 0 ≡ 2π a chain from pole to
    // pole, each pole one point whose UV in every triangle has longitude π.
    const S = (u: number, v: number): Xyz => [
      Math.cos(v) * Math.cos(u),
      Math.cos(v) * Math.sin(u),
      Math.sin(v),
    ];
    const nu = 16,
      nv = 8;
    const points: number[] = [...S(0, -Math.PI / 2), ...S(0, Math.PI / 2)];
    const ring = new Map<string, number>();
    const id = (i: number, j: number) => {
      if (j === 0) return 0;
      if (j === nv) return 1;
      const key = `${i % nu},${j}`;
      let n = ring.get(key);
      if (n === undefined) {
        n = points.length / 3;
        ring.set(key, n);
        points.push(...S((2 * Math.PI * i) / nu, -Math.PI / 2 + (Math.PI * j) / nv));
      }
      return n;
    };
    const uv = (i: number, j: number): [number, number] => [
      j === 0 || j === nv ? Math.PI : (2 * Math.PI * i) / nu,
      -Math.PI / 2 + (Math.PI * j) / nv,
    ];
    const triangles: RawSurface['triangles'] = [];
    const add = (c: [number, number][]) =>
      triangles.push({
        v: c.map(([i, j]) => id(i, j)) as [number, number, number],
        face: 0,
        uv: c.map(([i, j]) => uv(i, j)) as [[number, number], [number, number], [number, number]],
      });
    for (let i = 0; i < nu; i++)
      for (let j = 0; j < nv; j++) {
        if (j === 0)
          add([
            [i, 0],
            [i + 1, 1],
            [i, 1],
          ]);
        else if (j === nv - 1)
          add([
            [i, j],
            [i + 1, j],
            [i, nv],
          ]);
        else {
          add([
            [i, j],
            [i + 1, j],
            [i + 1, j + 1],
          ]);
          add([
            [i, j],
            [i + 1, j + 1],
            [i, j + 1],
          ]);
        }
      }
    const raw: RawSurface = {
      points,
      triangles: triangles.filter((t) => new Set(t.v).size === 3),
      shapeFaces: 1,
      chains: [
        {
          nodes: Array.from({ length: nv + 1 }, (_, j) => id(0, j)),
          params: Array.from({ length: nv + 1 }, (_, j) => -Math.PI / 2 + (Math.PI * j) / nv),
        },
      ],
      surfaceAt: (_, u, v) => S(u, v),
      curveAt: (_, t) => S(0, t),
      uvAt: (_, p, start) => {
        let u = Math.atan2(p[1], p[0]);
        while (u < start[0] - Math.PI) u += 2 * Math.PI;
        while (u > start[0] + Math.PI) u -= 2 * Math.PI;
        return [u, Math.asin(Math.max(-1, Math.min(1, p[2])))];
      },
    };
    const before = finishSurface({
      ...raw,
      triangles: raw.triangles.slice(),
      points: points.slice(),
    });
    expect(closed(before)).toBe(true);
    expect(outwardCount(before)).toBe(before.faces.length);
    refineSurface(raw, { maxEdgeMm: 0.2, maxTriangles: 100_000 });
    const s = finishSurface(raw);
    expect(closed(s)).toBe(true);
    expect(s.faces.length).toBeGreaterThan(before.faces.length);
    expect(outwardCount(s)).toBe(s.faces.length);
    expect(longest(s)).toBeLessThanOrEqual(0.2);
  });

  it('stops at the triangle limit', () => {
    expect(() => refineSurface(cube(), { maxEdgeMm: 0.01, maxTriangles: 5000 })).toThrow(
      AnalysisSurfaceLimit,
    );
  });

  it('puts new points on the shape: a curve bulging outward moves its split points', () => {
    const raw = cube();
    // Edge 0 (from corner 0 to 1) bows out to −y by t(1 − t).
    const straight = raw.curveAt;
    raw.curveAt = (edge, t) => {
      const p = straight(edge, t)!;
      if (edge === 0) p[1] -= t * (1 - t);
      return p;
    };
    refineSurface(raw, { maxEdgeMm: 0.4, maxTriangles: 100_000 });
    const s = finishSurface(raw);
    const c = s.edges.nodes.subarray(s.edges.offsets[0]!, s.edges.offsets[1]!);
    for (const p of c) {
      const x = s.points[3 * p]!;
      expect(s.points[3 * p + 1]!).toBeCloseTo(-x * (1 - x), 12);
    }
    // Its mid points are on the curve too (the flat faces of this fake cube add others nearby).
    for (let i = 1; i < c.length; i++) {
      const [a, b] = [Math.min(c[i - 1]!, c[i]!), Math.max(c[i - 1]!, c[i]!)];
      let k = 0;
      while (!(s.midpoints.pairs[2 * k] === a && s.midpoints.pairs[2 * k + 1] === b)) k++;
      const x = s.midpoints.points[3 * k]!;
      expect(s.midpoints.points[3 * k + 1]!).toBeCloseTo(-x * (1 - x), 12);
    }
  });
});

describe('analysis surface quality (R3e-3)', () => {
  it('flips only where the Delaunay test asks, keeping the surface closed', () => {
    // A cube's faces are two right triangles each, already Delaunay; after bisection the flips
    // keep it closed and never lower the smallest angle.
    const raw = cube();
    const before = smallestAngle(finishSurface(raw));
    expect(flipSurface(raw)).toBe(0); // a cube's two triangles per face are already Delaunay
    refineSurface(raw, { maxEdgeMm: 0.3, maxTriangles: 100_000 });
    flipSurface(raw);
    const s = finishSurface(raw);
    expect(closed(s)).toBe(true);
    expect(volume(s)).toBeCloseTo(1, 12);
    expect(smallestAngle(s)).toBeGreaterThanOrEqual(before - 1e-9);
  });

  it('improves a cube with one finely sized face: closed, same volume, chains kept, no slivers', () => {
    const raw = cube();
    improveSurface(raw, {
      maxEdgeMm: Infinity,
      faces: new Map([[1, 0.02]]),
      maxTriangles: 400_000,
    });
    const s = finishSurface(raw);
    expect(longest(s, 1)).toBeLessThanOrEqual(0.02);
    expect(closed(s)).toBe(true);
    expect(volume(s)).toBeCloseTo(1, 12);
    expect(smallestAngle(s)).toBeGreaterThanOrEqual(22.5 - 1e-9);
    // Graded: the neighbours' triangles grow away from the fine face instead of staying at 0.02.
    expect(longest(s, 0)).toBeGreaterThan(0.1);
  });

  it('meshes a sheet face by face: a narrow strip across, a wide face on a lattice (CR5e)', () => {
    // TS-1580, ST-272: a 40 × 1 × 1 bar at size 2, like a sheet's 3 mm bend 1200 mm long at
    // 30 mm. Its chains are split to the size first and flipped, so each long strip is one row of
    // triangles across it; the bisection alone fills such a strip with points.
    const bar = box(40, 1, 1);
    improveSurface(bar, { maxEdgeMm: 2, maxTriangles: 1e6, seed: true });
    const s = finishSurface(bar);
    expect(longest(s)).toBeLessThanOrEqual(2 + 1e-9);
    // 32 segments a side (40 / 2 rounded up to a power of two): 64 triangles a strip, no more.
    for (const f of [2, 3, 4, 5])
      expect(Array.from(s.faces).filter((x) => x === f)).toHaveLength(64);
    expect(smallestAngle(s)).toBeGreaterThan(20);
    // A 10 × 10 × 1 slab: its square faces get lattice points, about one per 0.85² × √3/2 mm²
    // (160 a face) less those near the edges.
    const slab = box(10, 10, 1);
    refineSurface(slab, { maxEdgeMm: 1, maxTriangles: 1e6, chainsOf: new Set([0, 1, 2, 3, 4, 5]) });
    flipSurface(slab);
    const seeded = seedSurface(slab, { maxEdgeMm: 1, maxTriangles: 1e6 });
    expect(seeded).toBeGreaterThan(200);
    expect(seeded).toBeLessThan(320);
    improveSurface(slab, { maxEdgeMm: 1, maxTriangles: 1e6 });
    const t = finishSurface(slab);
    expect(longest(t)).toBeLessThanOrEqual(1 + 1e-9);
    expect(smallestAngle(t)).toBeGreaterThan(15);
    // Codex on #1010: the limit counts the triangles the points add, not the face's UV box. The
    // bar with its UV turned 45° has long strips running diagonally through their UV boxes (about
    // 600 lattice sites each) but the same few triangles as the bar.
    const diagonal = turned(box(40, 1, 1));
    expect(() =>
      improveSurface(diagonal, { maxEdgeMm: 2, maxTriangles: 600, seed: true }),
    ).not.toThrow();
    expect(finishSurface(diagonal).faces.length).toBeLessThanOrEqual(600);
  });

  it('sizes around points, growing by the distance beyond their radius (CR5e-2)', () => {
    // TS-1582, ST-273: a spot weld's size, 1 within 0.5 of the point, then the distance beyond;
    // nothing farther than where it reaches the cap of 4 counts.
    const at = nearSize({ points: [0, 0, 0, 100, 0, 0], radiusMm: 0.5, sizeMm: 1 }, 4)!;
    expect(at(0.3, 0, 0)).toBe(1);
    expect(at(2.5, 0, 0)).toBeCloseTo(3, 12);
    expect(at(99, 0, 0)).toBeCloseTo(1.5, 12);
    expect(at(50, 0, 0)).toBe(Infinity);
    expect(nearSize({ points: [], radiusMm: 1, sizeMm: 1 }, 4)).toBeUndefined();
    expect(nearSize({ points: [0, 0, 0], radiusMm: 1, sizeMm: 4 }, 4)).toBeUndefined();
    // A 10 × 10 × 1 slab at 4 with a point at a corner of its top face: fine there, 4 elsewhere.
    const slab = box(10, 10, 1);
    improveSurface(slab, {
      maxEdgeMm: 4,
      maxTriangles: 1e6,
      seed: true,
      near: { points: [0, 0, 1], radiusMm: 0.5, sizeMm: 1 },
    });
    const s = finishSurface(slab);
    const edgesNear = (x: number, y: number, r: number) => {
      let max = 0;
      for (let t = 0; t < s.faces.length; t++) {
        const v = [0, 1, 2].map((j) => s.triangles[3 * t + j]!);
        const mid = (d: number) => v.reduce((a, n) => a + s.points[3 * n + d]!, 0) / 3;
        if (s.faces[t] !== 5 || Math.hypot(mid(0) - x, mid(1) - y) > r) continue;
        for (let j = 0; j < 3; j++) {
          const [a, b] = [v[j]!, v[(j + 1) % 3]!];
          max = Math.max(
            max,
            Math.hypot(...[0, 1, 2].map((d) => s.points[3 * a + d]! - s.points[3 * b + d]!)),
          );
        }
      }
      return max;
    };
    expect(edgesNear(0, 0, 1)).toBeLessThanOrEqual(1.5 + 1e-9);
    expect(edgesNear(9, 9, 1.5)).toBeGreaterThan(2);
    expect(smallestAngle(s)).toBeGreaterThan(15);
    // Codex on #1018: the last flips and moves keep the point sizes too: a point in the middle of
    // the face, and the result needs no split to meet them.
    const mid: SurfaceSizing = {
      maxEdgeMm: 4,
      maxTriangles: 1e6,
      seed: true,
      near: { points: [5, 5, 1], radiusMm: 0.5, sizeMm: 1 },
    };
    const middle = box(10, 10, 1);
    improveSurface(middle, mid);
    expect(refineSurface(middle, { ...mid, seed: false })).toBe(0);
  });

  it('moves a crowded point inside a face, never a chain point', () => {
    const raw = cube();
    refineSurface(raw, { maxEdgeMm: 0.4, maxTriangles: 100_000 });
    const chainPoints = new Set(raw.chains.flatMap((c) => c.nodes));
    const kept = [...chainPoints].map((n) => raw.points.slice(3 * n, 3 * n + 3));
    // Push one inner point of face 0 close to a neighbour.
    const inner = raw.triangles.find((t) => t.face === 0 && t.v.some((n) => !chainPoints.has(n)))!;
    const x = inner.v.find((n) => !chainPoints.has(n))!;
    const y = inner.v.find((n) => n !== x)!;
    // On face 0 (x = 0) the UV is (y, z): move the point 30 % of the way to a neighbour.
    const to = [1, 2].map(
      (d) => raw.points[3 * x + d]! + 0.3 * (raw.points[3 * y + d]! - raw.points[3 * x + d]!),
    );
    raw.points[3 * x + 1] = to[0]!;
    raw.points[3 * x + 2] = to[1]!;
    for (const t of raw.triangles)
      t.v.forEach((n, j) => {
        if (n === x) t.uv![j] = [to[0]!, to[1]!];
      });
    const before = smallestAngle(finishSurface(raw));
    expect(smoothSurface(raw, 3)).toBeGreaterThan(0);
    const s = finishSurface(raw);
    expect(closed(s)).toBe(true);
    expect(volume(s)).toBeCloseTo(1, 12);
    expect(smallestAngle(s)).toBeGreaterThanOrEqual(before - 1e-9);
    expect([...chainPoints].map((n) => raw.points.slice(3 * n, 3 * n + 3))).toEqual(kept);
  });

  it('keeps the size limits through flips and smoothing (a 1 × 2.168 × 0.901 box, #800 review)', () => {
    const raw = cube();
    const k = [1, 2.168, 0.901] as const;
    for (let i = 0; i < raw.points.length; i++) raw.points[i]! *= k[i % 3]!;
    const unitAt = raw.surfaceAt.bind(raw);
    const unitUv = raw.uvAt.bind(raw);
    raw.surfaceAt = (f, u, v) => unitAt(f, u, v)?.map((x, d) => x * k[d]!) as Xyz;
    raw.uvAt = (f, p, start) => unitUv(f, p.map((x, d) => x / k[d]!) as Xyz, start);
    improveSurface(raw, { maxEdgeMm: 0.3, minEdgeMm: 0.06, maxTriangles: 400_000 });
    const s = finishSurface(raw);
    expect(longest(s)).toBeLessThanOrEqual(0.3);
    expect(closed(s)).toBe(true);
    expect(volume(s)).toBeCloseTo(1 * 2.168 * 0.901, 10);
  });
});
