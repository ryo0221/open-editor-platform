import { describe, expect, it } from 'vitest';
import { eaxleGears, eaxleLayout, eaxleParts } from './eaxle-parts';
import { bearingSeries02 } from './machine-elements';
import { validateCad } from './validation';

describe('DW7c e-Axle parts F131–F135 (ST-717, TS-2454)', () => {
  it('builds every part as a valid document of ordinary features', () => {
    const parts = eaxleParts();
    expect(new Set(parts.map((p) => p.unit))).toEqual(
      new Set(['F131', 'F132', 'F133', 'F134', 'F135']),
    );
    for (const p of parts) expect(validateCad(p.content), p.key).toEqual([]);
    expect(parts.filter((p) => p.bought).map((p) => p.key)).toEqual([
      'bearing-6206',
      'bearing-6207',
      'bearing-6208',
      'bearing-6210',
      'seal-40',
    ]);
  });

  it('lays the reducer out for a ratio of 9 with meshing centre distances', () => {
    expect(eaxleLayout.ratio).toBeCloseTo(9, 12);
    // Normal module m at β: the transverse pitch radius is z·m / (2 cos β).
    const r = (g: { module: number; teeth: number; helix: number }) =>
      (g.teeth * g.module) / (2 * Math.cos(g.helix));
    const G = eaxleGears;
    expect(eaxleLayout.counterX).toBeCloseTo(r(G.input) + r(G.counter), 9);
    expect(eaxleLayout.outputX - eaxleLayout.counterX).toBeCloseTo(r(G.pinion) + r(G.final), 9);
    // Each pair has opposite hands; the counter shaft's two gears share one (thrust cancels).
    expect(G.input.helix + G.counter.helix).toBe(0);
    expect(G.pinion.helix + G.final.helix).toBe(0);
    expect(Math.sign(G.counter.helix)).toBe(Math.sign(G.pinion.helix));
    expect(bearingSeries02['6208']).toEqual([40, 80, 18]);
  });
});
