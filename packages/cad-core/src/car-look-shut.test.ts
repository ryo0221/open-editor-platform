import { describe, expect, it } from 'vitest';
import { f143Openings, f145Gap, f145Panels, f145Package, f144Lamps } from './car-look-detail';
import { f141Arch, f141BodyLines, f141FlareLine, f141Intake } from './car-look-skin';
import { f82Rules } from './car-look-package';
import { validateCad } from './validation';

type V2 = readonly [number, number];
const pts = (o: (readonly V2[])[]) => o.flat();
const panel = (id: string) => pts(f145Panels.find((p) => p.id === id)!.outline);

describe('F145: 「翔」 with its shut lines (CL8c, TS-2033)', () => {
  it('keeps the door on the side, clear of the vent, the flare and the intake', () => {
    const lines = f141BodyLines();
    const arch = f141Arch(f82Rules.tyre.front.diameter);
    const vent = pts(f143Openings.find((o) => o.id === 'fender-vent')!.outlines[0]!);
    const ventRear = Math.max(...vent.map((p) => p[0]));
    const intakeFront = Math.min(...f141Intake.map((p) => p[0]));
    for (const [x, z] of panel('door')) {
      expect(z, `at ${x}`).toBeGreaterThan(lines(x).lower[1] + 60);
      expect(z).toBeLessThan(lines(x).shoulder[1]);
      expect(x).toBeGreaterThan(ventRear);
      expect(x).toBeLessThan(intakeFront);
      expect(Math.hypot(x, z - arch.z)).toBeGreaterThan(arch.r + f141FlareLine.front);
    }
  });
  it('keeps the hood and engine cover inside the lamps, intakes and outlets, over the deck', () => {
    const lines = f141BodyLines();
    const others = [
      ...pts(f144Lamps.find((l) => l.id === 'headlamp')!.outline),
      ...f143Openings.filter((o) => o.view === 'plan').flatMap((o) => o.outlines.flatMap(pts)),
    ];
    for (const id of ['hood', 'engine-cover']) {
      const own = panel(id);
      const [x0, x1] = [Math.min(...own.map((p) => p[0])), Math.max(...own.map((p) => p[0]))];
      // The lamps and openings over the same stretch of the car lie at least 40 mm outside.
      const beside = others.filter(([x]) => x >= x0 && x <= x1);
      expect(beside.length, id).toBeGreaterThan(0);
      const inner = Math.min(...beside.map((p) => p[1]));
      for (const [x, y] of own) {
        expect(Math.abs(y), `${id} at ${x}`).toBeLessThan(inner - 40);
        expect(Math.abs(y)).toBeLessThan(lines(x).lower[0] - 10);
      }
    }
    expect(f145Gap).toBeGreaterThanOrEqual(0.5);
    expect(f145Gap).toBeLessThanOrEqual(10);
  });
  it('validates, with each panel on both sides and both halves cut along its line', () => {
    const doc = f145Package();
    expect(validateCad(doc)).toEqual([]);
    expect(doc.bodies.filter((b) => b.id.startsWith('shut-')).map((b) => b.name)).toEqual(
      f145Panels.flatMap((p) => [`${p.name} right`, `${p.name} left`]),
    );
    expect(doc.features.filter((f) => f.type === 'trim' && f.id.startsWith('shut-')).length).toBe(
      2 * f145Panels.length,
    );
  });
});
