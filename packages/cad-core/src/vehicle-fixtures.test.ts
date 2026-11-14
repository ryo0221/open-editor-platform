import { describe, expect, it } from 'vitest';
import { validateCad } from './validation';
import { f95Nagi, f95NagiAero, f95Section, f95SectionX } from './vehicle-fixtures';

describe('F95 凪 for the analyses (VS1a)', () => {
  it('builds the aero shape from main tools as separate closed bodies', () => {
    // TS-2202, ST-601.
    const closed = f95NagiAero();
    expect(validateCad(closed)).toEqual([]);
    expect(closed.bodies.map((b) => b.id)).toEqual([
      'skin',
      'hard-top',
      'wheel-fl',
      'wheel-fr',
      'wheel-rl',
      'wheel-rr',
      'mirror-l',
      'mirror-r',
    ]);
    const open = f95NagiAero({ roof: 'open', mirrors: false });
    expect(validateCad(open)).toEqual([]);
    expect(open.bodies.map((b) => b.id)).toEqual([
      'skin',
      'windscreen',
      'wheel-fl',
      'wheel-fr',
      'wheel-rl',
      'wheel-rr',
    ]);
    // Only lofts and cylinders (and their placements): nothing from the look model's tools.
    expect(new Set(closed.features.map((f) => f.type))).toEqual(
      new Set(['loft', 'cylinder', 'transform']),
    );
  });

  it('keeps the drawing sizes in every skin section', () => {
    // TS-2202, ST-601.
    expect(f95Nagi.axles.front - f95Nagi.axles.rear).toBe(f95Nagi.wheelbase);
    expect(f95SectionX).toHaveLength(18);
    for (let i = 1; i < f95SectionX.length; i++)
      expect(f95SectionX[i]!).toBeLessThan(f95SectionX[i - 1]!);
    for (const d of f95SectionX) {
      const s = f95Section(d);
      expect(s).toHaveLength(19);
      // Mirror image across y = 0, the floor flat, the crown on the centre line.
      for (let k = 1; k < s.length; k++) {
        const m = s[s.length - k]!;
        expect(m[0]).toBeCloseTo(-s[k]![0], 9);
        expect(m[1]).toBeCloseTo(s[k]![1], 9);
      }
      expect(s[0]![0]).toBe(0);
      const ys = s.map(([y]) => Math.abs(y));
      // The drawing's 880 mm, plus the curve's small overshoot between its points.
      expect(Math.max(...ys)).toBeLessThanOrEqual(f95Nagi.halfWidth + 5);
      const zs = s.map(([, z]) => z);
      expect(Math.max(...zs)).toBe(s[0]![1]);
      expect(new Set(s.slice(8, 12).map(([, z]) => z)).size).toBe(1);
      expect(Math.min(...zs)).toBe(s[8]![1]);
    }
  });
});
