import { describe, expect, it } from 'vitest';
import {
  cyclesToFailure,
  fatigueField,
  repeated,
  minerDamage,
  rainflow,
  reversals,
  signedVonMises,
  steelSn,
  type RainflowCycle,
} from './fatigue';

const byRange = (cycles: RainflowCycle[]) => {
  const out: Record<number, number> = {};
  for (const c of cycles) out[c.range] = (out[c.range] ?? 0) + c.count;
  return out;
};

describe('stress-life fatigue (VS13a, TS-2289, ST-639)', () => {
  it('counts ASTM E1049’s rainflow example', () => {
    // ASTM E1049-85 Fig. 6 (A … I): ranges 3 ×½, 4 ×1½, 6 ×½, 8 ×1, 9 ×½.
    const cycles = rainflow([-2, 1, -3, 5, -1, 3, -4, 4, -2]);
    expect(byRange(cycles)).toEqual({ 3: 0.5, 4: 1.5, 6: 0.5, 8: 1, 9: 0.5 });
    // Points between turning points and repeats do not count.
    expect(reversals([0, 1, 2, 2, 1, 0, 3])).toEqual([0, 2, 0, 3]);
    expect(() => rainflow([0, Number.NaN])).toThrow(/not finite/);
    // A fully reversed block: 200 ranges of 2 about 0, 100 cycles in all (ASTM counts them as
    // halves, each holding the start point).
    const block = Array.from({ length: 201 }, (_, i) => (i % 2 ? 1 : -1));
    const counted = rainflow(block);
    expect(counted.reduce((a, c) => a + c.count, 0)).toBe(100);
    expect(counted.every((c) => c.range === 2 && c.mean === 0)).toBe(true);
  });

  it('gives a Basquin life with Goodman’s mean correction and an endurance limit', () => {
    const sn = { ...steelSn, endurance: 100 };
    expect(cyclesToFailure(sn, 250, 0)).toBeCloseTo(1e6, 6);
    expect(cyclesToFailure(sn, 500, 0) / (1e6 * 2 ** -10)).toBeCloseTo(1, 9);
    expect(cyclesToFailure(sn, 99, 0)).toBe(Infinity);
    // A tensile mean of Su/2 doubles the amplitude; a compressive one changes nothing.
    expect(cyclesToFailure(sn, 125, 255)).toBeCloseTo(cyclesToFailure(sn, 250, 0), 6);
    expect(cyclesToFailure(sn, 250, -200)).toBeCloseTo(1e6, 6);
    expect(cyclesToFailure(sn, 10, 600)).toBe(0);
    // k cycles at the reference amplitude: damage k / 10⁶.
    const k = 1000;
    const cycles = Array.from({ length: k }, () => ({ range: 500, mean: 0, count: 1 as const }));
    expect(minerDamage(sn, cycles)).toBeCloseTo(k / 1e6, 12);
    expect(() =>
      fatigueField({ cases: [new Float64Array(6)], history: [[0, 1]], sn: { ...sn, slope: 0 } }),
    ).toThrow(/S-N/);
  });

  it('signs von Mises by the trace', () => {
    expect(signedVonMises([100, 0, 0, 0, 0, 0])).toBeCloseTo(100, 12);
    expect(signedVonMises([-100, 0, 0, 0, 0, 0])).toBeCloseTo(-100, 12);
    expect(signedVonMises([0, 0, 0, 50, 0, 0])).toBeCloseTo(50 * Math.sqrt(3), 12);
  });

  it('keeps a reversed shear reversed when it is split into cases (Codex on #1283)', () => {
    const shear = new Float64Array([0, 0, 0, 100, 0, 0]);
    const zero = new Float64Array(6);
    expect(signedVonMises([0, 0, 0, -100, 0, 0], 0, shear)).toBeCloseTo(-100 * Math.sqrt(3), 9);
    const one = fatigueField({
      cases: [shear],
      history: [[-1, 1, -1, 1, -1]],
      sn: { ...steelSn, endurance: 0 },
    });
    const two = fatigueField({
      cases: [shear, zero],
      history: [
        [-1, 1, -1, 1, -1],
        [0, 0, 0, 0, 0],
      ],
      sn: { ...steelSn, endurance: 0 },
    });
    expect(one.damage[0]).toBeGreaterThan(0);
    expect(two.damage[0]).toBeCloseTo(one.damage[0]!, 12);
  });

  it('counts a history as one pass of a load that repeats, and bounds the work (Codex on #1283)', () => {
    const sn = { ...steelSn, endurance: 0, ultimate: 100_000 };
    const stress = new Float64Array([250, 0, 0, 0, 0, 0]);
    const a = fatigueField({ cases: [stress], history: [[0, 1, -1, 0]], sn });
    const b = fatigueField({ cases: [stress], history: [[-1, 0, 1, -1]], sn });
    expect(a.damage[0]).toBeCloseTo(1 / cyclesToFailure(sn, 250, 0), 15);
    expect(b.damage[0]! / a.damage[0]!).toBeCloseTo(1, 12);
    expect(repeated([0, 1, -2, 0])).toEqual([-2, 0, 0, 1, -2]);
    // One case is bounded as several are: nodes × points.
    const big = new Float64Array(6 * 30_001);
    expect(() =>
      fatigueField({
        cases: [big],
        history: [Array.from({ length: 100_000 }, (_, i) => i % 2)],
        sn,
      }),
    ).toThrow(/over/);
  });

  it('gives every node its damage and life from the load history', () => {
    // Two nodes in tension at 250 and 500 MPa under the unit case, the case fully reversed 1 000
    // times: 1 000 cycles at those amplitudes.
    const stress = new Float64Array([250, 0, 0, 0, 0, 0, 500, 0, 0, 0, 0, 0]);
    const history = [Array.from({ length: 2001 }, (_, i) => (i % 2 ? 1 : -1))];
    const sn = { ...steelSn, endurance: 0 };
    const one = fatigueField({ cases: [stress], history, sn });
    const n0 = cyclesToFailure(sn, 250, 0);
    const n1 = cyclesToFailure(sn, 500, 0);
    expect(one.damage[0]! / (1000 / n0)).toBeCloseTo(1, 9);
    expect(one.damage[1]! / (1000 / n1)).toBeCloseTo(1, 9);
    expect(one.worst.node).toBe(1);
    expect(one.life[1]!).toBeCloseTo(n1 / 1000, 6);
    // The same as two cases, the second zero, counted node by node.
    const two = fatigueField({
      cases: [stress, new Float64Array(12)],
      history: [history[0]!, history[0]!.map(() => 0)],
      sn,
    });
    expect(two.damage[0]! / one.damage[0]!).toBeCloseTo(1, 12);
    expect(two.damage[1]! / one.damage[1]!).toBeCloseTo(1, 12);
    // Below the endurance limit: no damage, an infinite life.
    const safe = fatigueField({ cases: [stress], history, sn: steelSn });
    expect(safe.damage[0]).toBe(0);
    expect(safe.life[0]).toBe(Infinity);
    expect(() => fatigueField({ cases: [stress], history: [[1]], sn })).toThrow(/history/);
  });
});
