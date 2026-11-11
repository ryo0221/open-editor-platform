import { describe, expect, it } from 'vitest';
import { cadBuilder } from './builder';
import { fixtureKernel } from './fixtures';
import {
  spurGearFlankEnd,
  spurGearHalfAngle,
  spurGearProblem,
  spurGearRadii,
  spurGearSketch,
  type InvoluteGearSpec,
  type CycloidalGearSpec,
} from './gear';
import { sketchRegion } from './sketch';
import { validateCad } from './validation';

const deg = (d: number) => (d * Math.PI) / 180;
const spec = (o: Partial<InvoluteGearSpec> = {}): InvoluteGearSpec => ({
  module: 0.15,
  teeth: 48,
  pressureAngle: deg(20),
  profileShift: 0,
  addendum: 1,
  dedendum: 1.25,
  bore: 0,
  ...o,
});

describe('WM1a spur gear geometry (ST-440, TS-1880)', () => {
  it('has the standard circles and tooth thickness', () => {
    const g = spec();
    const r = spurGearRadii(g);
    expect(r.pitch).toBeCloseTo(3.6, 12);
    expect(r.tip).toBeCloseTo(3.75, 12);
    expect(r.root).toBeCloseTo(3.4125, 12);
    expect(r.base).toBeCloseTo(3.6 * Math.cos(deg(20)), 12);
    // Arc thickness at the pitch circle is half the circular pitch, πm/2 …
    expect(2 * r.pitch * spurGearHalfAngle(g, r.pitch)).toBeCloseTo((Math.PI * 0.15) / 2, 12);
    // … plus 2xm·tanα with a profile shift.
    const s = spec({ profileShift: 0.3 });
    expect(2 * r.pitch * spurGearHalfAngle(s, r.pitch)).toBeCloseTo(
      (Math.PI * 0.15) / 2 + 2 * 0.3 * 0.15 * Math.tan(deg(20)),
      12,
    );
  });

  it('refuses undercut, pointed, too-wide spokes, bores and out-of-range values', () => {
    expect(spurGearProblem(spec({ teeth: 12 }))?.code).toBe('gear-undercut');
    expect(spurGearProblem(spec({ teeth: 12, profileShift: 0.3 }))).toBeUndefined();
    expect(spurGearProblem(spec({ teeth: 8, profileShift: 1 }))?.code).toBe('gear-tip-pointed');
    expect(spurGearProblem(spec({ teeth: 5 }))?.code).toBe('gear-teeth');
    expect(spurGearProblem(spec({ teeth: 48.5 }))?.code).toBe('gear-teeth');
    expect(spurGearProblem(spec({ module: 0.01 }))?.code).toBe('gear-module');
    expect(spurGearProblem(spec({ pressureAngle: deg(10) }))?.code).toBe('gear-pressure-angle');
    expect(spurGearProblem(spec({ dedendum: 1 }))?.code).toBe('gear-dedendum');
    expect(spurGearProblem(spec({ bore: 7 }))?.code).toBe('gear-bore');
    const spokes = { count: 5, rim: 0.3, hub: 0.3, width: 0.25 };
    expect(spurGearProblem(spec({ bore: 0.24, spokes }))).toBeUndefined();
    expect(spurGearProblem(spec({ bore: 0.24, spokes: { ...spokes, rim: 3 } }))?.code).toBe(
      'gear-spokes-too-wide',
    );
    expect(spurGearProblem(spec({ bore: 0.24, spokes: { ...spokes, width: 1.2 } }))?.code).toBe(
      'gear-spokes-too-wide',
    );
    expect(spurGearProblem(spec({ spokes: { ...spokes, count: 2 } }))?.code).toBe('gear-spokes');
  });

  it(
    'makes a valid region for small and large gears, with and without windows',
    { timeout: 60_000 },
    () => {
      for (const g of [
        spec({ teeth: 12, profileShift: 0.3 }),
        spec(),
        spec({
          teeth: 40,
          module: 0.12,
          bore: 0.24,
          spokes: { count: 4, rim: 0.3, hub: 0.25, width: 0.2 },
        }),
        spec({
          teeth: 400,
          module: 0.1,
          bore: 2,
          spokes: { count: 12, rim: 1, hub: 1, width: 0.6 },
        }),
      ]) {
        const { sketch, region } = spurGearSketch(g);
        const r = sketchRegion(sketch, region);
        expect('code' in r ? r : 'ok').toBe('ok');
        expect(region.holes.length).toBe((g.bore > 0 ? 1 : 0) + (g.spokes?.count ?? 0));
        // Every outline point lies between the root and tip circles.
        const { root, tip } = spurGearRadii(g);
        for (const [id, [u, v]] of Object.entries(sketch.solved)) {
          if (!/^t\d+[lr](\d|f)$/.test(id) || /[lr][1-5]$/.test(id)) continue;
          const d = Math.hypot(u, v);
          expect(d).toBeGreaterThan(root - 1e-9);
          expect(d).toBeLessThan(tip + 1e-9);
        }
      }
    },
  );

  it('builds a valid document with a spurGear body and refuses a bad one', () => {
    const b = cadBuilder(fixtureKernel);
    b.spurGear('Wheel', {
      module: 0.15,
      teeth: 48,
      faceWidth: 0.25,
      bore: 0.24,
      spokes: { count: 5, rim: 0.3, hub: 0.3, width: 0.25 },
    });
    const doc = b.build().document;
    const errors = (d: unknown) => validateCad(d).filter((x) => x.severity === 'error');
    expect(errors(doc)).toEqual([]);
    const bad = structuredClone(doc);
    const f = bad.features.find((x) => x.type === 'spurGear')!;
    if (f.type === 'spurGear') f.args.teeth = { literal: 10 };
    expect(errors(bad).map((e) => [e.code, e.path])).toEqual([
      ['gear-undercut', '$.features[0].args.teeth'],
    ]);
    if (f.type === 'spurGear') (f.args as { profile: string }).profile = 'helical';
    expect(errors(bad).map((e) => e.code)).toContain('gear-profile');
  });
});

describe('WM1b cycloidal watch tooth (ST-441, TS-1883)', () => {
  const watch = (o: Partial<CycloidalGearSpec> = {}): CycloidalGearSpec => ({
    profile: 'cycloidal',
    module: 0.1,
    teeth: 80,
    matingTeeth: 10,
    toothThickness: 0.5,
    addendum: 1.3,
    dedendum: 1.6,
    bore: 0,
    ...o,
  });

  it('has radial flanks below the pitch circle and an epicycloid above it', () => {
    const g = watch();
    const r = spurGearRadii(g);
    expect(r.pitch).toBeCloseTo(4, 12);
    expect(r.base).toBe(r.pitch);
    // Half the circular pitch thick at the pitch circle, the same angle all the way down.
    const half = spurGearHalfAngle(g, r.pitch);
    expect(2 * r.pitch * half).toBeCloseTo(0.5 * Math.PI * 0.1, 12);
    expect(spurGearHalfAngle(g, r.root)).toBe(half);
    // Above it the tooth narrows; a point of the flank lies on the epicycloid rolled by a circle
    // of half the pinion's pitch radius (0.25 mm): its distance to the rolling circle's centre.
    const rg = (0.1 * 10) / 4;
    for (const rr of [4.02, 4.06, 4.1]) {
      const a = spurGearHalfAngle(g, rr);
      expect(a).toBeLessThan(half);
      const p = [rr * Math.cos(half - a), rr * Math.sin(half - a)];
      // The rolling circle touches the pitch circle at angle φ with its centre at R + rg; some φ
      // puts the point on it.
      let best = Infinity;
      for (let i = 0; i <= 20000; i++) {
        const phi = (i / 20000) * 0.2;
        const cx = (4 + rg) * Math.cos(phi);
        const cy = (4 + rg) * Math.sin(phi);
        best = Math.min(best, Math.abs(Math.hypot(p[0]! - cx, p[1]! - cy) - rg));
      }
      expect(best).toBeLessThan(1e-4);
    }
  });

  it('closes a long addendum into an ogival point and makes valid regions', () => {
    const pointed = watch({ addendum: 2 });
    expect(spurGearFlankEnd(pointed).pointed).toBe(true);
    expect(spurGearFlankEnd(pointed).radius).toBeLessThan(spurGearRadii(pointed).tip);
    expect(spurGearFlankEnd(watch()).pointed).toBe(false);
    for (const g of [
      watch(),
      pointed,
      watch({ teeth: 10, matingTeeth: 80, toothThickness: 0.4, addendum: 0.7, dedendum: 1.6 }),
      watch({ teeth: 6, matingTeeth: 60, toothThickness: 0.35, addendum: 0.6, dedendum: 1.5 }),
      watch({ bore: 0.3, spokes: { count: 4, rim: 0.4, hub: 0.3, width: 0.25 } }),
    ]) {
      expect(spurGearProblem(g)).toBeUndefined();
      const { sketch, region } = spurGearSketch(g);
      const r = sketchRegion(sketch, region);
      expect('code' in r ? r : 'ok').toBe('ok');
      // Pointed teeth have no tip arc.
      const tips = sketch.entities.filter((e) => /^t\d+tip$/.test(e.id)).length;
      expect(tips).toBe(spurGearFlankEnd(g).pointed ? 0 : g.teeth);
    }
  });

  it('refuses its own bad values and the other profile’s fields', () => {
    expect(spurGearProblem(watch({ matingTeeth: 3 }))?.code).toBe('gear-mating-teeth');
    expect(spurGearProblem(watch({ toothThickness: 0.8 }))?.code).toBe('gear-tooth-thickness');
    expect(spurGearProblem(watch({ addendum: 3 }))?.code).toBe('gear-addendum');
    const b = cadBuilder(fixtureKernel);
    b.spurGear('Wheel', {
      profile: 'cycloidal',
      module: 0.1,
      teeth: 80,
      matingTeeth: 10,
      faceWidth: 0.2,
    });
    const doc = b.build().document;
    const errors = (d: unknown) => validateCad(d).filter((x) => x.severity === 'error');
    expect(errors(doc)).toEqual([]);
    const f = doc.features[0]!;
    if (f.type !== 'spurGear') throw new Error('no gear');
    expect(f.args).toMatchObject({
      profile: 'cycloidal',
      toothThickness: 0.5,
      addendum: 1.3,
      dedendum: 1.6,
    });
    const bad = structuredClone(doc);
    const g = bad.features[0]!;
    if (g.type === 'spurGear') g.args.pressureAngle = { literalRad: 0.35 };
    expect(errors(bad).map((e) => e.path)).toContain('$.features[0].args.pressureAngle');
    if (g.type === 'spurGear') {
      delete g.args.pressureAngle;
      g.args.matingTeeth = { literal: 2 };
    }
    expect(errors(bad).map((e) => e.code)).toContain('gear-mating-teeth');
  });
});
