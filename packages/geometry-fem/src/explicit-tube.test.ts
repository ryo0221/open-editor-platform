import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ExplicitSolver, explicitDefaults } from './explicit';
import { abramowiczJonesSquare, f97SquareTube } from './explicit-tube';

/**
 * TS-2219 (ST-616, VS6c): F97, a square steel tube crushed 100 mm along its axis at 10 m/s,
 * against Abramowicz–Jones. The crush takes about 8 minutes: it runs with VS6C_TUBE=1 (and
 * writes its force history to the file VS6C_TUBE_OUT names, when given).
 */
describe('F97 square tube (VS6c)', () => {
  it('builds the tube clamped below, driven above, dented near the top', () => {
    const { model, bottom, top, halfFold } = f97SquareTube();
    const n = model.nodes.length / 3;
    expect(n).toBe(80 * 81);
    expect(model.shells.length / 4).toBe(80 * 80);
    expect(bottom.every((i) => model.fixed![i] === 63 && model.velocity![3 * i + 2] === 0)).toBe(
      true,
    );
    expect(top.every((i) => model.fixed![i] === 63 && model.velocity![3 * i + 2] === -10_000)).toBe(
      true,
    );
    expect(halfFold).toBeCloseTo(15.38, 1);
    // The dent: at most a tenth of the thickness, only within 2H of the top.
    let most = 0;
    for (let i = 0; i < n; i++) {
      const x = model.nodes[3 * i]!;
      const y = model.nodes[3 * i + 1]!;
      const z = model.nodes[3 * i + 2]!;
      const off = Math.min(Math.abs(Math.abs(x) - 25), Math.abs(Math.abs(y) - 25));
      if (z < 200 - 2 * halfFold) expect(off).toBeLessThan(1e-12);
      most = Math.max(most, off);
    }
    expect(most).toBeCloseTo(0.15, 6);
    expect(abramowiczJonesSquare(300, 1.5, 50) / 1000).toBeCloseTo(28.35, 2);
  });

  it.skipIf(!process.env.VS6C_TUBE)(
    'crushes with the Abramowicz–Jones mean force and folds',
    () => {
      const { model, bottom, halfFold } = f97SquareTube();
      const crush = 100;
      const T = crush / 10_000;
      const s = new ExplicitSolver(model, {
        ...explicitDefaults,
        thicknessPoints: 3,
        hourglass: 0.03,
        endTime: T,
        frameEvery: T / 10,
      });
      const rows: [number, number][] = [];
      while (!s.done) {
        s.advance(200);
        rows.push([s.time * 10_000, s.reaction(bottom)[2]]);
      }
      const r = s.result();
      for (const c of r.checks) expect(c.pass, c.detail).toBe(true);
      // Mean force after the first peak (the first 10 mm), over the crush: the samples are not
      // evenly spaced (the step follows the shapes), so the force is integrated over the
      // displacement, the interval crossing 10 mm clipped there.
      let work = 0;
      let span = 0;
      for (let k = 1; k < rows.length; k++) {
        const [d0, f0] = rows[k - 1]!;
        const [d1, f1] = rows[k]!;
        if (d1 <= 10 || !(d1 > d0)) continue;
        const a = Math.max(d0, 10);
        const fa = f0 + ((f1 - f0) * (a - d0)) / (d1 - d0);
        work += 0.5 * (fa + f1) * (d1 - a);
        span += d1 - a;
      }
      const mean = work / span;
      const aj = abramowiczJonesSquare(300, 1.5, 50);
      // Folds: lobes along a face's centre line (in and out past the thickness), two per fold.
      const u = r.frames.at(-1)!.displacement;
      const ring = 80;
      const line: [number, number][] = [];
      for (let j = 0; j <= 80; j++) {
        const i = j * ring + 10;
        line.push([model.nodes[3 * i + 2]! + u[3 * i + 2]!, u[3 * i + 1]!]);
      }
      let lobes = 0;
      let side = 0;
      for (const [, off] of line) {
        const now = off > 1.5 ? 1 : off < -1.5 ? -1 : 0;
        if (now !== 0 && now !== side) {
          lobes++;
          side = now;
        }
      }
      const out = process.env.VS6C_TUBE_OUT;
      if (out)
        writeFileSync(
          out,
          JSON.stringify({
            steps: r.steps,
            checks: r.checks.map((c) => c.detail),
            meanN: mean,
            ajN: aj,
            lobes,
            halfFold,
            force: rows,
            centreLine: line,
          }),
        );
      expect(Math.abs(mean / aj - 1)).toBeLessThan(0.2);
      expect(lobes).toBeGreaterThanOrEqual(6);
    },
    3_600_000,
  );
});
