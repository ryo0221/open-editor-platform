import { describe, expect, it } from 'vitest';
import { f87OfficeCranes, type Crane } from '@editor-platform/construction-core';
import {
  beamBox,
  craneSolid,
  formatLoadChart,
  formatTonnes,
  nextLiftId,
  parseLoadChart,
  parsePoint3,
  siteCraneId,
} from './index';

const zs = (s: ReturnType<typeof craneSolid>) =>
  s.meshes!.flatMap((m) => [...m.mesh.positions].filter((_, i) => i % 3 === 2));

describe('CS3b crane view and forms (ST-546, TS-2078)', () => {
  it('draws a closed box along any axis (ST-546#1)', () => {
    for (const [a, b] of [
      [
        [0, 0, 0],
        [0, 0, 1000],
      ],
      [
        [0, 0, 0],
        [3000, 4000, 0],
      ],
      [
        [100, 200, 300],
        [1100, -800, 2300],
      ],
    ] as [number, number, number][][]) {
      const { positions: p, indices } = beamBox(a!, b!, 200, 100);
      // Volume by the divergence theorem: positive (outward faces) and length × section.
      let v = 0;
      for (let k = 0; k < indices.length; k += 3) {
        const [i, j, l] = [indices[k]! * 3, indices[k + 1]! * 3, indices[k + 2]! * 3];
        v +=
          (p[i]! * (p[j + 1]! * p[l + 2]! - p[j + 2]! * p[l + 1]!) -
            p[i + 1]! * (p[j]! * p[l + 2]! - p[j + 2]! * p[l]!) +
            p[i + 2]! * (p[j]! * p[l + 1]! - p[j + 1]! * p[l]!)) /
          6;
      }
      const len = Math.hypot(b![0] - a![0], b![1] - a![1], b![2] - a![2]);
      expect(v).toBeCloseTo(len * 200 * 100, 0);
    }
  });

  it('draws a tower crane at rest and at a lift state (ST-546#1)', () => {
    const crane = f87OfficeCranes().site!.cranes![0]!;
    const rest = craneSolid(crane, 100, undefined, false);
    expect(rest.instances[0]!.path).toEqual([siteCraneId('tc-1')]);
    // From the base to the top of the jib (30 m up, the jib 1.2 m deep).
    expect(Math.min(...zs(rest))).toBeCloseTo(100, 3);
    expect(Math.max(...zs(rest))).toBeCloseTo(100 + 30000 + 1200, 3);
    // Slewed toward the building's corner, the hook hangs at the given point.
    const at = craneSolid(
      crane,
      0,
      { slew: Math.PI, radius: 20000, hook: [1600, -6000, 5000] },
      true,
    );
    expect(at.instances[0]!.selected).toBe(true);
    expect(at.bounds[0][0]).toBeLessThanOrEqual(21600 - 50000 + 1);
    expect(Math.min(...zs(at).filter((z) => z > 1000))).toBeCloseTo(5000, 3);
  });

  it('draws a mobile crane with its boom to the radius (ST-546#1)', () => {
    const mobile: Crane = {
      id: 'mc',
      name: 'Mobile',
      kind: 'mobile',
      base: [0, 0],
      height: 3000,
      jibLength: 30000,
      minRadius: 3000,
      loadChart: [{ radius: 18000, capacityKg: 10000 }],
      fromTaskId: 'site',
    };
    const s = craneSolid(mobile, 0, { slew: 0, radius: 18000, hook: [18000, 0, 4000] }, false);
    // The boom tip at 3 m + √(30² − 18²) = 27 m, plus half the boom's depth.
    expect(Math.max(...zs(s))).toBeCloseTo(27000 + 600 * (18000 / 30000), -1);
    expect(s.bounds[1][0]).toBeGreaterThan(18000);
  });

  it('reads and writes the crane form fields (ST-546#2)', () => {
    const chart = [
      { radius: 25000, capacityKg: 10000 },
      { radius: 50000, capacityKg: 5000 },
    ];
    expect(formatLoadChart(chart)).toBe('25000, 10000\n50000, 5000');
    expect(parseLoadChart('25000,10000; 50000 5000')).toEqual(chart);
    expect(parseLoadChart('far, 1')).toBe('"far, 1" is not "radius, kg"');
    expect(parsePoint3(' 52000, 11000 , 1000 ')).toEqual([52000, 11000, 1000]);
    expect(parsePoint3('1, 2')).toBe('"1, 2" is not "x, y, z" in mm');
    expect(formatTonnes(3456)).toBe('3.5 t');
  });

  it('names new lifts apart from every site ID, within 128 code points (ST-546#2)', () => {
    const taken = new Set(['lift-c-1', 'lift-c-1-2']);
    expect(nextLiftId('c-1', taken)).toBe('lift-c-1-3');
    expect(taken.has('lift-c-1-3')).toBe(true);
    expect(nextLiftId('c-2', taken)).toBe('lift-c-2');
    // A 128-code-point element ID: cut to leave room for the prefix and a counter.
    const long = '柱'.repeat(128);
    const first = nextLiftId(long, taken);
    const second = nextLiftId(long, taken);
    expect(Array.from(first).length).toBeLessThanOrEqual(128);
    expect(Array.from(second).length).toBeLessThanOrEqual(128);
    expect(second).toBe(`${first}-2`);
    // A cut that would end in a space does not.
    expect(nextLiftId(`${'a'.repeat(116)} b`, taken)).toBe(`lift-${'a'.repeat(116)}`);
  });
});
