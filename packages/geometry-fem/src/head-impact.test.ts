import { describe, expect, it } from 'vitest';
import { headInjuryCriterion } from './crash-metrics';
import { explicitDefaults, runExplicit, type ExplicitModel, type ExplicitResult } from './explicit';
import { firstTouch, headImpactMeasures, headImpactSetup } from './head-impact';

/**
 * TS-2231 (ST-622, VS8b): the pedestrian head impact: the headform (a rigid sphere of shells)
 * placed gap clear on the impact line, its measures (CFC 1000 resultant, HIC15, deflection) on a
 * known pulse, and a run on a held steel plate whose thickness changes them.
 */

/** A square steel plate (side × side mm, z = 0, facing up) held at its edges. */
function plate(thickness: number, side = 400, per = 25): ExplicitModel {
  const n = per + 1;
  const nodes = new Float64Array(3 * n * n);
  const fixed = new Uint8Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      nodes.set([(side * i) / per - side / 2, (side * j) / per - side / 2, 0], 3 * (j * n + i));
      if (i === 0 || j === 0 || i === per || j === per) fixed[j * n + i] = 63;
    }
  const shells = new Uint32Array(4 * per * per);
  for (let j = 0; j < per; j++)
    for (let i = 0; i < per; i++)
      shells.set(
        [j * n + i, j * n + i + 1, (j + 1) * n + i + 1, (j + 1) * n + i],
        4 * (j * per + i),
      );
  return {
    nodes,
    shells,
    thickness: new Float64Array(per * per).fill(thickness),
    shellMaterial: new Uint16Array(per * per),
    materials: [
      {
        density: 7.85e-9,
        youngsModulus: 210_000,
        poissonRatio: 0.3,
        plastic: { strain: [0, 0.2], stress: [200, 340] },
      },
    ],
    fixed,
    contact: {},
  };
}

const run = (thickness: number) => {
  const s = headImpactSetup(plate(thickness), { target: [0, 0, 0] });
  const r = runExplicit(s.model, {
    ...explicitDefaults,
    thicknessPoints: 3,
    endTime: 0.02,
    frameEvery: 0.005,
    historyNodes: [s.centre],
    historyEvery: 1,
  });
  return {
    s,
    r,
    m: headImpactMeasures(r, { centre: s.centre, direction: s.direction, approach: s.approach }),
  };
};

describe('head impact (VS8b)', () => {
  it('puts the headform gap clear of the faces on the impact line, with its mass and speed', () => {
    const model = plate(0.8);
    const s = headImpactSetup(model, { target: [0, 0, 0] });
    const a = (65 * Math.PI) / 180;
    expect(s.direction[0]).toBeCloseTo(-Math.cos(a), 12);
    expect(s.direction[2]).toBeCloseTo(-Math.sin(a), 12);
    // Between the nodes (the plate's nodes are 16 mm apart, none under the line): the face is
    // what it first touches, so its centre is radius + gap + half the thickness over the plate.
    expect(s.start[2]).toBeCloseTo(82.5 + 1 + 0.4, 9);
    // On the line through the target.
    expect(s.start[0] / s.start[2]).toBeCloseTo(s.direction[0] / s.direction[2], 9);
    expect(s.start[1]).toBe(0);
    const n = model.nodes.length / 3;
    expect(s.centre).toBe(n);
    expect(s.nodes).toEqual({ first: n, count: 6 * 8 * 8 + 2 + 1 });
    const x = s.model.nodes;
    for (let i = n + 1; i < n + s.nodes.count; i++)
      expect(
        Math.hypot(x[3 * i]! - s.start[0], x[3 * i + 1]! - s.start[1], x[3 * i + 2]! - s.start[2]),
      ).toBeCloseTo(82, 9);
    const body = s.model.rigidBodies!.at(-1)!;
    expect(body.nodes.length).toBe(s.nodes.count);
    expect(body.mass).toBe(0.0045);
    // 2/5·m·r²: 12.25 kg·cm² = 12.25 t·mm².
    expect(body.inertia![0]).toBeCloseTo(0.4 * 0.0045 * 82.5 ** 2, 9);
    expect(Math.hypot(...body.velocity!)).toBeCloseTo(40_000_000 / 3600, 6);
    expect(s.model.fixed!.length).toBe(n + s.nodes.count);
    expect(s.model.shells.length / 4).toBe(25 * 25 + 6 * 64);
    // The gap is a clearance: along the 65° line the centre goes gap / sin 65° to the first touch.
    expect(s.approach).toBeCloseTo(1 / Math.sin(a), 9);
    // The child's headform: lighter, the same size, flatter.
    const child = headImpactSetup(model, { target: [0, 0, 0], headform: 'child' });
    expect(child.mass).toBe(3.5);
    expect(child.diameter).toBe(165);
    expect(child.start[2]).toBeCloseTo(82.5 + 1 + 0.4, 9);
    // 30° and a 10 mm gap: 20 mm to the first touch.
    expect(
      headImpactSetup(model, { target: [0, 0, 0], angleDeg: 30, gap: 10 }).approach,
    ).toBeCloseTo(20, 9);
    expect(child.direction[2]).toBeCloseTo(-Math.sin((50 * Math.PI) / 180), 12);
  });

  it('touches a node, an edge or a face first, whichever the sweep meets first', () => {
    // One triangle, the sphere (ρ = 10) coming straight down (d = −z) from s above the target.
    const tri = {
      nodes: new Float64Array([0, 0, 0, 100, 0, 0, 0, 100, 0]),
      shells: new Uint32Array([0, 1, 2, 2]),
      thickness: new Float64Array([0]),
    };
    const half = new Float64Array(3);
    const down = [0, 0, -1];
    // Over the face: at the plane + 10.
    expect(firstTouch(tri, [20, 20, 0], down, 10, half)).toBeCloseTo(10, 12);
    // Off the edge y = 0 by 6: √(10² − 6²) = 8 above it.
    expect(firstTouch(tri, [50, -6, 0], down, 10, half)).toBeCloseTo(8, 12);
    // Off the corner (0, 0) by (−6, −6): √(100 − 72).
    expect(firstTouch(tri, [-6, -6, 0], down, 10, half)).toBeCloseTo(Math.sqrt(28), 12);
    // A node off the shells (a point mass) is no obstacle: the contact leaves it out.
    const lone = { ...tri, nodes: new Float64Array([...tri.nodes, 20, 20, 500]) };
    expect(firstTouch(lone, [20, 20, 0], down, 10, new Float64Array(4))).toBeCloseTo(10, 12);
    // Clear of it all.
    expect(firstTouch(tri, [-20, 50, 0], down, 10, half)).toBe(-Infinity);
  });

  it('refuses a headform it cannot aim', () => {
    const model = plate(0.8);
    expect(() => headImpactSetup(model, { target: [0, 900, 0] })).toThrow(/misses the vehicle/);
    expect(() => headImpactSetup({ ...model, contact: undefined }, { target: [0, 0, 0] })).toThrow(
      /no contact/,
    );
    const moving = { ...model, velocity: new Float64Array(model.nodes.length).fill(1) };
    expect(() => headImpactSetup(moving, { target: [0, 0, 0] })).toThrow(/at rest/);
    const n = model.nodes.length / 3;
    const turning = {
      ...model,
      fixed: undefined,
      rigidBodies: [
        { nodes: [...Array(n).keys()], rotation: [0, 1, 0] as [number, number, number] },
      ],
    };
    expect(() => headImpactSetup(turning, { target: [0, 0, 0] })).toThrow(/at rest/);
    expect(() => headImpactSetup(model, { target: [0, 0, 0], perFace: 1 })).toThrow(/perFace/);
    expect(() => headImpactSetup(model, { target: [0, 0, 0], angleDeg: 0 })).toThrow(/angle/);
    expect(() => headImpactSetup(model, { target: [0, 0, 0], diameter: 2 })).toThrow(/diameter/);
  });

  it('reads a known pulse back: its peak, HIC15, deflection and end speed', () => {
    // A half-sine deceleration of 150 g for 6 ms from 10 m/s along −z, sampled every 2 µs.
    const g = 9.80665;
    const A = 150 * g * 1000;
    const tau = 0.006;
    const dt = 2e-6;
    const m = Math.round(0.012 / dt) + 1;
    const time = new Float64Array(m);
    const velocity = new Float64Array(3 * m);
    const displacement = new Float64Array(3 * m);
    for (let k = 0; k < m; k++) {
      const t = k * dt;
      const tt = Math.min(t, tau);
      // v = v0 − A·τ/π·(1 − cos(πt/τ)), u = ∫ v.
      const v = 10_000 - ((A * tau) / Math.PI) * (1 - Math.cos((Math.PI * tt) / tau));
      const u =
        10_000 * tt -
        ((A * tau) / Math.PI) * (tt - (tau / Math.PI) * Math.sin((Math.PI * tt) / tau)) +
        (t - tt) * v;
      time[k] = t;
      velocity[3 * k + 2] = -v;
      displacement[3 * k + 2] = -u;
    }
    const result = {
      history: [{ node: 7, time, velocity, displacement }],
    } as unknown as ExplicitResult;
    const r = headImpactMeasures(result, { centre: 7, direction: [0, 0, -1], approach: 1 });
    expect(r.peakG).toBeGreaterThan(148);
    expect(r.peakG).toBeLessThan(152);
    // HIC of a half sine of peak P g and length τ, the best window centred: about 0.6·... found
    // numerically here from the analytic pulse.
    const exact = headInjuryCriterion(
      Float64Array.from({ length: 601 }, (_, k) => (k * tau) / 600),
      Float64Array.from({ length: 601 }, (_, k) => 150 * Math.sin((Math.PI * k) / 600)),
    );
    expect(r.hic15!.hic / exact.hic).toBeGreaterThan(0.97);
    expect(r.hic15!.hic / exact.hic).toBeLessThan(1.03);
    const vEnd = 10 - (2 * 150 * g * tau) / Math.PI;
    expect(r.endSpeed).toBeCloseTo(vEnd, 6);
    expect(r.deflection).toBeCloseTo(-displacement[3 * (m - 1) + 2]! - 1, 6);
  });

  it('stops the headform on a held plate within its energy balance; a thicker plate gives way less', () => {
    const thin = run(0.6);
    const thick = run(1.0);
    for (const { r, m } of [thin, thick]) {
      expect(
        r.checks.find((c) => c.name === 'energy-balance')!.pass,
        JSON.stringify(r.checks),
      ).toBe(true);
      expect(m.hic15).not.toBeNull();
      expect(m.hic15!.t2 - m.hic15!.t1).toBeLessThanOrEqual(0.015 + 1e-12);
      // Slowed down from 11.1 m/s, and pushed back off the plate.
      expect(m.endSpeed).toBeLessThan(0);
      expect(m.peakG).toBeGreaterThan(50);
    }
    expect(thick.m.deflection).toBeLessThan(thin.m.deflection);
    expect(thick.m.hic15!.hic).toBeGreaterThan(thin.m.hic15!.hic);
    expect(thick.m.peakG).toBeGreaterThan(thin.m.peakG);
  }, 120_000);
});
