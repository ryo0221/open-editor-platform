import { describe, expect, it } from 'vitest';
import {
  resultDisplay,
  runResult,
  showerMarkScale,
  showerMesh,
  showerWaterColors,
  showerWaterLabels,
} from './results';
import type { ShowerRunFields } from './run-shower';

/**
 * TS-2260 (ST-633): a shower's water at a car's scale. The particle and entry marks grow with the
 * bodies' box (a fixed 4 mm cross was under a pixel on 凪), are closed solids seen from any side,
 * and each kind of water takes its own colour, the same in every frame.
 */
const fields = (size: number, states: number[]): ShowerRunFields => ({
  kind: 'shower',
  seals: [],
  // One triangle spanning a box of `size` along x and y.
  surface: {
    points: new Float64Array([0, 0, 0, size, 0, 0, 0, size, 0]),
    triangles: new Uint32Array([0, 1, 2]),
  },
  particles: states.length,
  particleVolumeMm3: 1,
  counts: { drop: 0, film: 0, pond: 0, entered: 0, drained: 0 },
  entries: [],
  ponds: [],
  enteredBySeal: {},
  frames: [
    {
      timeS: 1,
      positions: new Float32Array(states.flatMap((_, i) => [i * 10, 0, 100])),
      states: new Uint8Array(states),
    },
  ],
});
/** Half the x span of the mark of the first particle (after the six box nodes). */
const halfSize = (m: ReturnType<typeof showerMesh>, mark: number) => {
  const xs = [...m.nodes.slice(18 + mark * 18, 18 + (mark + 1) * 18)].filter((_, k) => k % 3 === 0);
  return (Math.max(...xs) - Math.min(...xs)) / 2;
};

describe('shower water at a car scale (VS10 follow-up)', () => {
  it('sizes the marks from the bodies, with the old sizes as the least', () => {
    const car = Math.hypot(4000, 4000);
    const m = showerMesh(fields(4000, [0, 3]), 0, false);
    expect(halfSize(m, 0)).toBeCloseTo(car * showerMarkScale.particle, 3);
    expect(halfSize(m, 1)).toBeCloseTo(car * showerMarkScale.entry, 3);
    // On a 100 mm test piece the marks keep 4 mm and 15 mm.
    const small = showerMesh(fields(100, [0, 3]), 0, false);
    expect(halfSize(small, 0)).toBeCloseTo(4, 6);
    expect(halfSize(small, 1)).toBeCloseTo(15, 6);
  });

  it('draws each mark as a closed octahedron, outward', () => {
    const m = showerMesh(fields(1000, [1]), 0, false);
    // Two empty box triangles, then eight faces.
    expect(m.triangles.length / 3).toBe(2 + 8);
    const c = [0, 1, 2].map((k) => m.nodes[18 + k]! - (m.nodes[18 + k]! - m.nodes[21 + k]!) / 2);
    for (let t = 6; t < m.triangles.length; t += 3) {
      const p = [0, 1, 2].map((j) => [0, 1, 2].map((k) => m.nodes[m.triangles[t + j]! * 3 + k]!));
      const e1 = [0, 1, 2].map((k) => p[1]![k]! - p[0]![k]!);
      const e2 = [0, 1, 2].map((k) => p[2]![k]! - p[0]![k]!);
      const n = [
        e1[1]! * e2[2]! - e1[2]! * e2[1]!,
        e1[2]! * e2[0]! - e1[0]! * e2[2]!,
        e1[0]! * e2[1]! - e1[1]! * e2[0]!,
      ];
      const out = [0, 1, 2].map((k) => (p[0]![k]! + p[1]![k]! + p[2]![k]!) / 3 - c[k]!);
      expect(n[0]! * out[0]! + n[1]! * out[1]! + n[2]! * out[2]!).toBeGreaterThan(0);
    }
  });

  it('colours each kind of water its own way, whatever the colour range', () => {
    const source = runResult(fields(4000, [0, 1, 2, 3]));
    const water = source.scalars[0]!;
    expect(water.classes?.map((c) => c.label)).toEqual([...showerWaterLabels]);
    // Every pair of kinds apart by a clear step in some channel.
    for (let a = 0; a < showerWaterColors.length; a++)
      for (let b = a + 1; b < showerWaterColors.length; b++)
        expect(
          Math.max(
            ...[0, 1, 2].map((k) =>
              Math.abs(showerWaterColors[a]![k]! - showerWaterColors[b]![k]!),
            ),
          ),
        ).toBeGreaterThan(0.2);
    for (const range of [
      [0, 6],
      [3, 4],
    ] as [number, number][]) {
      const shown = resultDisplay(source, 'water', 0, range);
      for (let v = 0; v < shown.values.length; v++) {
        const want = showerWaterColors[Math.round(shown.values[v]!)]!;
        for (let k = 0; k < 3; k++) expect(shown.colors[v * 3 + k]).toBeCloseTo(want[k]!, 5);
      }
      // Drop, film, pond and went in all show.
      expect(new Set(shown.values)).toEqual(new Set([0, 3, 4, 5, 6]));
    }
  });
});
