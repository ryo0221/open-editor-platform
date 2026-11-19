import { describe, expect, it } from 'vitest';
import { f140Variant } from './car-look-lines';
import { f82Rules } from './car-look-package';
import {
  f141Arch,
  f141FlareHeight,
  f141FlareLine,
  f141Intake,
  f141At,
  f141BodyLines,
  f141BodyStations,
  f141CanopyLines,
  f141CanopyStations,
  f141Package,
  f141Variant,
} from './car-look-skin';
import { validateCad } from './validation';

describe('F141: 「翔」’s skin from its lines (CL6, TS-2023)', () => {
  it('orders each section from the centre down, inside the width', () => {
    const body = f141BodyLines();
    for (const x of f141BodyStations) {
      const l = body(x);
      const z = [l.centre, l.deckEdge, l.shoulder, l.widest, l.lower].map((p) => p[1]);
      for (let i = 3; i < z.length; i++) expect(z[i], `x ${x} line ${i}`).toBeLessThan(z[i - 1]!);
      // The deck stays above the widest line; over the front wheels the fenders may stand up
      // to 40 mm above the hood's centre (CL6c), elsewhere the deck crowns over the shoulder.
      expect(Math.min(z[0]!, z[1]!), `x ${x}`).toBeGreaterThan(z[3]!);
      expect(z[2]! - z[0]!, `x ${x}`).toBeLessThan(x > -400 && x < 600 ? 40 : 0);
      expect(l.widest[0]).toBeLessThanOrEqual(975 + 1e-6);
    }
    const canopy = f141CanopyLines();
    for (const x of f141CanopyStations) {
      const l = canopy(x);
      expect(l.centre[1] - l.foot[1], `x ${x}`).toBeGreaterThan(40);
      expect(l.foot[0]).toBeLessThan(body(x).shoulder[0]);
    }
  });
  it('adds the two networks and their mirror copies', () => {
    const doc = f141Package(f140Variant);
    expect(doc.bodies.slice(-8).map((b) => b.name)).toEqual([
      'Body right',
      'Canopy right',
      'Intake duct right',
      'Intake duct left',
      'Body left',
      'Canopy left',
      'Nose',
      'Tail',
    ]);
    // The arches trimmed from the right half, the left its mirror after them (CL6b).
    const right = doc.bodies.find((b) => b.id === 'skin-body-body')!;
    const left = doc.features.find((f) => f.id === 'skin-body-left')!;
    expect((left.args as { source: { featureId: string } }).source.featureId).toBe(
      right.resultFeatureId,
    );
    expect(doc.features.filter((f) => f.type === 'trim').map((f) => f.id)).toEqual([
      'skin-front-arch',
      'skin-rear-arch',
      'skin-side-intake',
    ]);
    expect(validateCad(doc)).toEqual([]);
  });
});

describe('F141: the skin’s shape and arches (CL6b, TS-2024)', () => {
  it('makes the canopy a teardrop in plan and gives the deck its camber', () => {
    const g = f141Variant.plan.greenhouse;
    const mid = f141At(g, 1250)!;
    expect(g[0]![1]).toBe(300);
    expect(g.at(-1)![1]).toBe(300);
    expect(mid).toBeGreaterThan(1.9 * 300);
    // The camber against the shoulder as CL4 drew it (CL6c raises the fenders above it).
    const drawn = f141BodyLines(f140Variant);
    for (const x of f141BodyStations) {
      const l = drawn(x);
      expect(l.centre[1] - l.shoulder[1], `x ${x}`).toBeGreaterThanOrEqual(60 - 1e-6);
    }
  });
  it('cuts the arches round the tyres at full bump with the arch gap', () => {
    const doc = f141Package();
    for (const [id, d] of [
      ['skin-front-wheel', f82Rules.tyre.front.diameter],
      ['skin-rear-wheel', f82Rules.tyre.rear.diameter],
    ] as const) {
      const s = doc.sketches.find((k) => k.id === id)!;
      expect(Math.hypot(...s.solved['s']!)).toBeCloseTo(d / 2 + f82Rules.archGap);
      // Round the tyre bumped 70 mm: its top with the gap is the arch's top.
      expect('origin' in s.plane && s.plane.origin[2]).toEqual({
        literalMm: d / 2 + f82Rules.bump,
      });
      expect(f141Arch(d).z + f141Arch(d).r).toBe(d + f82Rules.bump + f82Rules.archGap);
    }
    expect(validateCad(doc)).toEqual([]);
  });
});

describe('F141: the flares and the side intake (CL6c, TS-2025)', () => {
  it('raises the front shoulder over the arch and its flare line', () => {
    const body = f141BodyLines();
    const top = (d: number, line: number) => f141Arch(d).z + f141Arch(d).r + line;
    expect(body(0).shoulder[1]).toBeGreaterThan(
      top(f82Rules.tyre.front.diameter, f141FlareLine.front) + 15,
    );
    expect(body(f82Rules.wheelbase).shoulder[1]).toBeGreaterThan(
      top(f82Rules.tyre.rear.diameter, f141FlareLine.rear) + 15,
    );
  });
  it('flares both arches after the trims and cuts the intake clear of the rear flare', () => {
    const doc = f141Package();
    const flares = doc.features.filter((f) => f.type === 'flare');
    expect(flares.map((f) => f.id)).toEqual(['skin-rear-flare', 'skin-front-flare']);
    for (const f of flares)
      expect((f.args as { height: { literalMm: number } }).height.literalMm).toBe(f141FlareHeight);
    const flareFront =
      f82Rules.wheelbase - (f141Arch(f82Rules.tyre.rear.diameter).r + f141FlareLine.rear);
    expect(Math.max(...f141Intake.map((p) => p[0]))).toBeLessThan(flareFront - 50);
    expect(validateCad(doc)).toEqual([]);
  });
});

describe('F141: a fair lower edge (CL7a, TS-2027)', () => {
  const body = f141BodyLines();
  const lower = (x: number) => body(x).lower[1];
  it('bends one way only from behind the front arch to the diffuser', () => {
    // The front arch cuts the lower edge away to about x 280 mm (the arch at the edge's height).
    for (let x = 300; x < 3400; x += 50) {
      const bend = lower(x - 50) - 2 * lower(x) + lower(x + 50);
      expect(bend, `bend at ${x}`).toBeGreaterThan(0);
    }
  });
  it("keeps CL6's points at the wheels and stays within 50 mm of the drawn rocker", () => {
    for (const [x, z] of [
      [0, 185],
      [2650, 260],
    ] as const)
      expect(lower(x)).toBeCloseTo(z, 6);
    const rocker = f141Variant.side.rocker;
    for (let x = rocker[0]![0]; x <= rocker.at(-1)![0]; x += 50)
      expect(Math.abs(lower(x) - f141At(rocker, x)!), `at ${x}`).toBeLessThanOrEqual(50);
  });
});
