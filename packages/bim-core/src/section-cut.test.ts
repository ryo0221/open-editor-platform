import { describe, expect, it } from 'vitest';
import { bimClipRegion, bimColumnSection } from './section-cut';
import type { Vec2 } from './model';

// DW5b (Codex on #1238): sections from faces, cuts that rebuild the boundary. ST-711, TS-2439.
const square = (h: number): Vec2[] => [
  [-h, -h],
  [h, -h],
  [h, h],
  [-h, h],
];
const area = (l: Vec2[]) =>
  l.reduce((a, p, i) => {
    const q = l[(i + 1) % l.length]!;
    return a + (p[0] * q[1] - q[0] * p[1]) / 2;
  }, 0);

describe('column sections (DW5b)', () => {
  it('cuts a straight column at its top as its outline, and a ring through its void as a C', () => {
    const ax = {
      origin: [0, 0, 0] as [number, number, number],
      x: [1, 0, 0] as [number, number, number],
      y: [0, 1, 0] as [number, number, number],
      z: [0, 0, 1] as [number, number, number],
      length: 3000,
    };
    const ring = [square(300), square(250)];
    for (const z of [1500, 3000]) {
      const cut = bimColumnSection(ax, 1, ring, z)!;
      expect(cut).toHaveLength(2);
      expect(Math.abs(cut.reduce((a, l) => a + Math.abs(area(l)), 0))).toBeCloseTo(
        600 * 600 + 500 * 500,
        6,
      );
    }
    expect(bimColumnSection(ax, 1, ring, 3001)).toEqual([]);
    // A top rebuilt a hair under its level (1000.2 as 1000.1999999999999) is still cut there.
    const fractional = {
      ...ax,
      origin: [0, 0, -100.1] as [number, number, number],
      length: 1100.3,
    };
    expect(fractional.origin[2] + fractional.length).toBeLessThan(1000.2);
    expect(bimColumnSection(fractional, 1, ring, 1000.2)).toHaveLength(2);
    // Cut across the void: one loop, the half ring.
    const half = bimClipRegion(ring, (p) => p[0])!;
    expect(half).toHaveLength(1);
    expect(Math.abs(area(half[0]!))).toBeCloseTo((600 * 600 - 500 * 500) / 2, 6);
    // Cut beside the void: the outer cut, the hole whole.
    const side = bimClipRegion(ring, (p) => p[0] - 280)!;
    expect(side).toHaveLength(2);
    expect(bimClipRegion(ring, (p) => p[0] + 400)).toEqual([]);
  });
});
