import { describe, expect, it } from 'vitest';
import { CfdError } from './errors';
import { measureSeal, sealRibbon, type SealMeasureInput } from './seal';
import { TriangleGrid, turnSurface } from './triangle-grid';
import type { TriangleSurface } from './voxelize';

/** A flat plate over [x0, x1] × [y0, y1] at height z(x, y), n × m cells, wound up (+z). */
function plate(
  x: [number, number],
  y: [number, number],
  z: (x: number, y: number) => number,
  n = 40,
  m = 20,
): TriangleSurface {
  const positions: number[] = [];
  const triangles: number[] = [];
  for (let j = 0; j <= m; j++)
    for (let i = 0; i <= n; i++) {
      const px = x[0] + ((x[1] - x[0]) * i) / n;
      const py = y[0] + ((y[1] - y[0]) * j) / m;
      positions.push(px, py, z(px, py));
    }
  for (let j = 0; j < m; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      triangles.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
    }
  return { positions: new Float64Array(positions), triangles: new Uint32Array(triangles) };
}

/** A rounded rectangle's edges as chains (4 lines, 4 quarter arcs), as a CAD edge loop gives them. */
function roundedChains(w: number, h: number, r: number, z = 0): Float64Array[] {
  const line = (a: [number, number], b: [number, number]) =>
    new Float64Array([a[0], a[1], z, b[0], b[1], z]);
  const arc = (cx: number, cy: number, a0: number) => {
    const out: number[] = [];
    for (let k = 0; k <= 16; k++) {
      const a = a0 + ((Math.PI / 2) * k) / 16;
      out.push(cx + r * Math.cos(a), cy + r * Math.sin(a), z);
    }
    return new Float64Array(out);
  };
  return [
    line([r, 0], [w - r, 0]),
    arc(w - r, r, -Math.PI / 2),
    line([w, r], [w, h - r]),
    arc(w - r, h - r, 0),
    line([w - r, h], [r, h]),
    arc(r, h - r, Math.PI / 2),
    line([0, h - r], [0, r]),
    arc(r, r, Math.PI),
  ];
}

const section = { diameterMm: 16, compressionMin: 0.3, compressionMax: 0.5, minBendRadiusMm: 8 };
const input = (over: Partial<SealMeasureInput> = {}): SealMeasureInput => ({
  chains: roundedChains(200, 100, 25),
  base: plate([0, 200], [0, 100], () => 0),
  mating: plate([-20, 220], [-20, 120], () => 10),
  insetMm: 10,
  section,
  stepMm: 5,
  gapThresholdMm: 0.5,
  ...over,
});

describe('measureSeal (VS9)', () => {
  it('measures a parallel closure everywhere: (D − d) / D', () => {
    // TS-2250, ST-628: 16 mm bulb, 10 mm to the closure → 37.5 % all round, no leak.
    const m = measureSeal(input());
    expect(m.breaks).toEqual([]);
    expect(m.runs).toEqual([]);
    expect(m.leakLengthMm).toBe(0);
    expect(m.compression![0]).toBeCloseTo(0.375, 9);
    expect(m.compression![1]).toBeCloseTo(0.375, 9);
    // The loop inset 10 mm: a 180 × 80 rounded rectangle of corner radius 15.
    const perimeter = 2 * (150 + 50) + 2 * Math.PI * 15;
    expect(m.lengthMm).toBeGreaterThan(perimeter - 1);
    expect(m.lengthMm).toBeLessThan(perimeter + 1);
    for (const p of m.points) {
      expect(p.position[2]).toBeCloseTo(0, 9);
      expect(p.normal[2]).toBeCloseTo(1, 9);
      const inside =
        p.position[0] >= 10 - 1e-6 &&
        p.position[0] <= 190 + 1e-6 &&
        p.position[1] >= 10 - 1e-6 &&
        p.position[1] <= 90 + 1e-6;
      expect(inside).toBe(true);
    }
    // The corner arcs are bent to 15 mm (inset from 25 mm), above the 8 mm limit.
    const radii = m.points.map((p) => p.radiusMm).filter((r): r is number => r !== null);
    expect(Math.min(...radii)).toBeGreaterThan(13);
    expect(Math.min(...radii)).toBeLessThan(17);
    expect(m.bends).toEqual([]);
  });

  it('rates a tilted closure along the line and lists the runs out of range', () => {
    // TS-2250, ST-628: the closure from 6 mm (x = 0) to 18 mm (x = 200): compression 62.5 %
    // to a 2 mm gap. Over at the low end, under and then a gap at the high end.
    const m = measureSeal(input({ mating: plate([-20, 220], [-20, 120], (x) => 6 + 0.06 * x) }));
    const at = (x: number) =>
      m.points.reduce((a, b) =>
        Math.abs(b.position[0] - x) < Math.abs(a.position[0] - x) ? b : a,
      );
    expect(at(10).status).toBe('over');
    expect(at(10).compression).toBeCloseTo((16 - 6.6) / 16, 6);
    expect(at(60).status).toBe('ok');
    expect(at(190).status).toBe('gap');
    expect(at(190).gapMm).toBeCloseTo(6 + 0.06 * 190 - 16, 6);
    const kinds = new Set(m.runs.map((r) => r.status));
    expect(kinds).toEqual(new Set(['over', 'under', 'near', 'gap']));
    // A leak is under or a gap past 0.5 mm: x where d ≥ 16 · 0.7 = 11.2 and not within the
    // 0.5 mm of contact (16 ≤ d ≤ 16.5 is `near`).
    for (const p of m.points) {
      const d = 6 + 0.06 * p.position[0];
      expect(p.distanceMm).toBeCloseTo(d, 6);
      expect(p.leak).toBe((d > 11.2 && d < 16) || d > 16.5);
    }
    expect(m.leakLengthMm).toBeGreaterThan(0);
  });

  it('lists a break where chains do not meet, and the break leaks', () => {
    // TS-2250: one straight edge 40 mm short at its end.
    const chains = roundedChains(200, 100, 25);
    chains[0] = new Float64Array([25, 0, 0, 135, 0, 0]);
    const m = measureSeal(input({ chains }));
    expect(m.breaks).toHaveLength(1);
    expect(m.breaks[0]!.lengthMm).toBeCloseTo(40, 6);
    const broken = m.runs.filter((r) => r.status === 'break');
    expect(broken).toHaveLength(1);
    expect(broken[0]!.lengthMm).toBeGreaterThan(30);
    expect(m.leakLengthMm).toBeGreaterThan(30);
  });

  it('leaks at a break shorter than the point spacing', () => {
    // Codex on #1258: a 100 mm square whose loop ends 1 mm short of its start, 5 mm spacing.
    const square = new Float64Array([0, 1, 0, 0, 100, 0, 100, 100, 0, 100, 0, 0, 0, 0, 0]);
    const m = measureSeal(
      input({ chains: [square], base: plate([-20, 120], [-20, 120], () => 0), insetMm: 0 }),
    );
    expect(m.breaks).toHaveLength(1);
    expect(m.breaks[0]!.lengthMm).toBeCloseTo(1, 9);
    expect(m.runs.filter((r) => r.status === 'break')).toHaveLength(1);
    expect(m.leakLengthMm).toBeGreaterThan(0);
  });

  it('measures a loop of only a few points', () => {
    // Codex on #1258: a 1 mm square at 5 mm spacing has 3 points; its bends stay in the loop.
    const square = new Float64Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0]);
    const m = measureSeal(input({ chains: [square], insetMm: 0 }));
    expect(m.points).toHaveLength(3);
    expect(m.breaks).toEqual([]);
    expect(m.compression![0]).toBeCloseTo(0.375, 9);
  });

  it('joins chains in any order and direction', () => {
    const chains = roundedChains(200, 100, 25);
    const shuffled = [
      chains[5]!,
      chains[0]!.slice().reverse(),
      chains[3]!,
      chains[7]!,
      chains[1]!,
      chains[6]!,
      chains[2]!,
      chains[4]!,
    ];
    // A reversed polyline of points (x y z) reverses by point, not by number.
    const flip = (c: Float64Array) => {
      const out = new Float64Array(c.length);
      for (let i = 0; i < c.length; i += 3) out.set(c.subarray(c.length - 3 - i, c.length - i), i);
      return out;
    };
    shuffled[1] = flip(chains[0]!);
    const m = measureSeal(input({ chains: shuffled }));
    expect(m.breaks).toEqual([]);
    expect(m.runs).toEqual([]);
  });

  it('lists corners tighter than the smallest bend radius', () => {
    // TS-2250: sharp corners (radius 1 mm, inset 0) under an 8 mm limit.
    const m = measureSeal(input({ chains: roundedChains(200, 100, 1), insetMm: 0 }));
    expect(m.bends.length).toBe(4);
    for (const b of m.bends) expect(b.radiusMm).toBeLessThan(8);
  });

  it('opens a hinged closure: the far side gaps, the hinge side stays pressed', () => {
    // TS-2250: the closure turned 2° about the line x = −20, z = 10 (along y): at x = 190 it
    // lifts by 210 · tan 2° ≈ 7.3 mm.
    const closed = plate([-20, 220], [-20, 120], () => 10);
    const open = turnSurface(closed, [-20, 0, 10], [0, -1, 0], (2 * Math.PI) / 180);
    const m = measureSeal(input({ mating: open }));
    const at = (x: number) =>
      m.points.reduce((a, b) =>
        Math.abs(b.position[0] - x) < Math.abs(a.position[0] - x) ? b : a,
      );
    expect(at(10).status).toBe('ok');
    expect(at(190).status).toBe('gap');
    expect(at(190).distanceMm).toBeCloseTo(10 + 210 * Math.tan((2 * Math.PI) / 180), 1);
  });

  it('misses where no closure is in range, and leaks there', () => {
    const m = measureSeal(input({ mating: plate([-20, 100], [-20, 120], () => 10) }));
    expect(m.runs.some((r) => r.status === 'miss')).toBe(true);
    expect(m.points.filter((p) => p.position[0] > 110).every((p) => p.status === 'miss')).toBe(
      true,
    );
  });

  it('gives the ribbon up to the closure, or the free height where it does not touch', () => {
    const r = sealRibbon(measureSeal(input()), section);
    for (const p of r) expect(p.top[2] - p.base[2]).toBeCloseTo(10, 9);
    const miss = sealRibbon(
      measureSeal(
        input({ mating: { positions: new Float64Array(), triangles: new Uint32Array() } }),
      ),
      section,
    );
    for (const p of miss) {
      expect(p.top[2] - p.base[2]).toBeCloseTo(16, 9);
      expect(p.leak).toBe(true);
    }
    // A closure 20 mm off a 16 mm seal: the gap leaks, and the ribbon spans it (Codex on #1277).
    const gap = sealRibbon(
      measureSeal(input({ mating: plate([-20, 220], [-20, 120], () => 20) })),
      section,
    );
    for (const p of gap) {
      expect(p.leak).toBe(true);
      expect(p.top[2] - p.base[2]).toBeCloseTo(20, 6);
    }
  });

  it('refuses a section out of range and an empty line', () => {
    expect(() => measureSeal(input({ section: { ...section, compressionMin: 0.6 } }))).toThrow(
      CfdError,
    );
    expect(() => measureSeal(input({ chains: [] }))).toThrow(/chains/);
    expect(() => measureSeal(input({ stepMm: 0 }))).toThrow(/stepMm/);
    expect(() => measureSeal(input({ stepMm: 0.001 }))).toThrow(/points/);
  });
});

describe('TriangleGrid', () => {
  it('finds the first triangle on a ray and the nearest point', () => {
    const g = new TriangleGrid(plate([0, 100], [0, 100], (x) => x * 0.5, 10, 10));
    const hit = g.raycast([50, 50, 100], [0, 0, -1], 0, 1000)!;
    expect(hit.t).toBeCloseTo(75, 9);
    expect(g.raycast([50, 50, 100], [0, 0, 1], 0, 1000)).toBeNull();
    expect(g.raycast([50, 50, 100], [0, 0, -1], 0, 70)).toBeNull();
    const n = g.nearest([0, 50, 50], 100)!;
    // The plane z = x/2: the nearest point to (0, 50, 50) is at x = 20, z = 10.
    expect(n.point[0]).toBeCloseTo(20, 6);
    expect(n.point[2]).toBeCloseTo(10, 6);
  });
});
