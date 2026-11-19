import { describe, expect, it } from 'vitest';
import { f146Mirror, f146Package, f146Wheel, f146WheelFit, f145Panels } from './car-look-detail';
import { f82Rules } from './car-look-package';
import { f141BodyLines, f141CanopyLines } from './car-look-skin';
import { cadLimits } from './model';
import { validateCad } from './validation';

describe('F146: 「翔」 with its wheels’ faces and mirrors (CL8d, TS-2034)', () => {
  it('sizes the rims from the tyres (20" front, 21" rear) inside the tyres’ beads', () => {
    expect(f146Wheel.rim.front * 2).toBeCloseTo(20 * 25.4, 6);
    expect(f146Wheel.rim.rear * 2).toBeCloseTo(21 * 25.4, 6);
    expect(f146Wheel.rim.front).toBeLessThan(f82Rules.tyre.front.diameter / 2);
    expect(f146Wheel.spoke.from).toBeLessThan(f146Wheel.cap.radius);
  });
  it('reads CLF8’s wheel fit: the fenders just outside the tyres, the arch gap kept', () => {
    const fit = f146WheelFit();
    expect(fit.map((f) => f.axle)).toEqual(['front', 'rear']);
    for (const f of fit) {
      // The tyres sit within 10–40 mm inside the fender (the flare), never outside it.
      expect(f.stanceMm, f.axle).toBeGreaterThan(10);
      expect(f.stanceMm).toBeLessThan(40);
      expect(f.archGapMm).toBe(f82Rules.archGap);
    }
    // The front's inner tread corner swings a little past the arch's radius on lock (a
    // wheelhouse matter); the rear does not steer.
    expect(fit[0]!.innerSwingPastArchMm).toBeGreaterThan(0);
    expect(fit[0]!.innerSwingPastArchMm).toBeLessThan(5);
    expect(fit[1]!.innerSwingPastArchMm).toBeLessThan(0);
  });
  it('puts the mirror above the door, outside the canopy and the body', () => {
    const lines = f141BodyLines();
    const canopy = f141CanopyLines();
    const door = f145Panels.find((p) => p.id === 'door')!.outline.flat();
    const doorTop = Math.max(...door.map((p) => p[1]));
    for (const s of f146Mirror.sections) {
      expect(f146Mirror.centre[0] - s.a, `at ${s.x}`).toBeGreaterThan(canopy(s.x).foot[0]);
      expect(f146Mirror.centre[0] - s.a).toBeGreaterThan(lines(s.x).shoulder[0]);
      expect(f146Mirror.centre[1] - s.b).toBeGreaterThan(doorTop);
    }
  });
  it('runs the stalk into the housing along its whole length, so the union is one piece', () => {
    const { centre, sections, stalk } = f146Mirror;
    const [x0, y0, z0] = stalk.origin;
    const [dx, dy, dz] = stalk.size;
    // The stalk starts at the shoulder (inside the body), and its outer end's top face lies
    // inside the housing's section at every x of the stalk (sections lofted linearly).
    expect(y0).toBeLessThan(f141BodyLines()(x0).shoulder[0]);
    for (const x of [x0, x0 + dx]) {
      const k = sections.findIndex((s) => s.x >= x);
      const [p, q] = [sections[Math.max(0, k - 1)]!, sections[k]!];
      const t = q.x === p.x ? 0 : (x - p.x) / (q.x - p.x);
      const a = p.a + (q.a - p.a) * t;
      const b = p.b + (q.b - p.b) * t;
      const y = y0 + dy - centre[0];
      expect(Math.abs(y), `y at ${x}`).toBeLessThan(a);
      const bottom = centre[1] - b * Math.sqrt(1 - (y / a) ** 2);
      expect(z0 + dz, `z at ${x}`).toBeGreaterThan(bottom + 5);
      expect(z0 + dz).toBeLessThan(centre[1] + b);
    }
  });
  it('validates, with a rim per wheel and the mirror’s parts on both sides, at the body limit', () => {
    const doc = f146Package();
    expect(validateCad(doc)).toEqual([]);
    const names = doc.bodies.map((b) => b.name);
    for (const w of ['Front right', 'Front left', 'Rear right', 'Rear left'])
      expect(names).toContain(`${w} rim`);
    expect(doc.bodies.length).toBeLessThanOrEqual(cadLimits.bodies);
    for (const p of ['Mirror housing', 'Mirror glass'])
      expect(names).toEqual(expect.arrayContaining([`${p} right`, `${p} left`]));
  });
});
