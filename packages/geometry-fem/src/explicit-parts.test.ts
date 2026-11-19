import { describe, expect, it } from 'vitest';
import {
  ExplicitSolver,
  explicitDefaults,
  quadPlate,
  runExplicit,
  type ExplicitModel,
} from './explicit';

/** TS-2216 (ST-613, VS5c): beams and rigid bodies in the explicit solver. */
const steel = { density: 7.85e-9, youngsModulus: 210_000, poissonRatio: 0.3 };
const none = {
  shells: new Uint32Array(0),
  thickness: new Float64Array(0),
  shellMaterial: new Uint16Array(0),
};

/** A straight line of `n` beams along x from 0 to `length`, axis 2 along y. */
function line(length: number, n: number, section: { b: number; h: number }): ExplicitModel {
  const nodes = new Float64Array(3 * (n + 1));
  for (let k = 0; k <= n; k++) nodes[3 * k] = (k * length) / n;
  const beams = new Uint32Array(2 * n);
  for (let k = 0; k < n; k++) beams.set([k, k + 1], 2 * k);
  const { b, h } = section;
  // Rectangle b (along axis 2) × h (along axis 3); torsion constant of a rectangle (Roark).
  const a = Math.max(b, h) / 2;
  const c = Math.min(b, h) / 2;
  const j = a * c ** 3 * (16 / 3 - 3.36 * (c / a) * (1 - c ** 4 / (12 * a ** 4)));
  return {
    nodes,
    ...none,
    materials: [steel],
    beams,
    beamSection: new Uint16Array(n),
    beamMaterial: new Uint16Array(n),
    sections: [{ area: b * h, i2: (b * h ** 3) / 12, i3: (h * b ** 3) / 12, j }],
    beamOrientation: new Float64Array(3 * n).map((_, k) => (k % 3 === 1 ? 1 : 0)),
  };
}

describe('explicit beams and rigid bodies (VS5c)', () => {
  it('carries a step of force along a beam bar at the bar wave speed', () => {
    const n = 200;
    const model = line(1000, n, { b: 10, h: 10 });
    const F = 1000;
    model.forces = [{ node: 0, force: [-F, 0, 0] }];
    const c = Math.sqrt(steel.youngsModulus / steel.density);
    const arrival = 1000 / c;
    const r = runExplicit(model, {
      ...explicitDefaults,
      endTime: 1.5 * arrival,
      frameEvery: arrival / 10,
      historyNodes: [n],
    });
    const v = F / 100 / (steel.density * c);
    const h = r.history[0]!;
    let crossed = NaN;
    for (let k = 0; k < h.time.length; k++)
      if (-h.velocity[3 * k]! > v) {
        crossed = h.time[k]!;
        break;
      }
    expect(Math.abs(crossed / arrival - 1)).toBeLessThan(0.02);
    expect(r.checks.every((k) => k.pass)).toBe(true);
  });

  it('swings a clamped beam at its first bending period in both planes', () => {
    // 200 mm cantilever, 4 × 8 mm: f1 = 1.8751²/(2π L²) √(EI/(ρA)), I about each axis.
    const L = 200;
    const n = 40;
    for (const [dir, I] of [
      [2, (4 * 8 ** 3) / 12],
      [1, (8 * 4 ** 3) / 12],
    ] as const) {
      const model = line(L, n, { b: 4, h: 8 });
      model.fixed = new Uint8Array(n + 1);
      model.fixed[0] = 63;
      model.velocity = new Float64Array(3 * (n + 1));
      for (let k = 0; k <= n; k++) model.velocity[3 * k + dir] = 500 * (k / n) ** 2;
      const f1 =
        (1.8751 ** 2 / (2 * Math.PI * L * L)) *
        Math.sqrt((steel.youngsModulus * I) / (steel.density * 32));
      const r = runExplicit(model, {
        ...explicitDefaults,
        endTime: 2.2 / f1,
        frameEvery: 0.1 / f1,
        historyNodes: [n],
      });
      const h = r.history[0]!;
      const downs: number[] = [];
      for (let k = 1; k < h.time.length; k++) {
        const a = h.displacement[3 * (k - 1) + dir]!;
        const b = h.displacement[3 * k + dir]!;
        if (a > 0 && b <= 0)
          downs.push(h.time[k - 1]! + ((h.time[k]! - h.time[k - 1]!) * a) / (a - b));
      }
      expect(downs.length).toBeGreaterThanOrEqual(2);
      expect(Math.abs((downs[1]! - downs[0]!) * f1 - 1)).toBeLessThan(0.03);
      expect(r.checks.every((k) => k.pass)).toBe(true);
    }
  });

  it('twists a clamped shaft at its torsion period', () => {
    // Square 10 × 10 shaft, 400 mm, started in its first mode. The rotational inertia on the
    // nodes is the lumped one (scaled up for the step: ρA·max(l², 3·max I/A)/3 per length), so
    // the period checks the torsion stiffness GJ against that inertia: f = (1/4L) √(GJ/(ρA·r)).
    // The twist is read off a massless node 10 mm off the free end, held to it by a rigid body.
    const L = 400;
    const n = 40;
    const base = line(L, n, { b: 10, h: 10 });
    const q = base.sections![0]!;
    const nodes = new Float64Array(3 * (n + 2));
    nodes.set(base.nodes);
    nodes.set([L, 10, 0], 3 * (n + 1));
    const model: ExplicitModel = {
      ...base,
      nodes,
      fixed: new Uint8Array(n + 2),
      rotation: new Float64Array(3 * (n + 2)),
      rigidBodies: [{ nodes: [n, n + 1], rotation: [100, 0, 0] }],
    };
    model.fixed![0] = 63;
    for (let k = 0; k <= n; k++) model.rotation![3 * k] = 100 * Math.sin((Math.PI * k) / (2 * n));
    const G = steel.youngsModulus / (2 * (1 + steel.poissonRatio));
    const le = L / n;
    const r = Math.max(le * le, (3 * Math.max(q.i2, q.i3, q.j)) / q.area) / 3;
    const f = (1 / (4 * L)) * Math.sqrt((G * q.j) / (steel.density * q.area * r));
    const res = runExplicit(model, {
      ...explicitDefaults,
      endTime: 2.2 / f,
      frameEvery: 0.1 / f,
      historyNodes: [n + 1],
    });
    const h = res.history[0]!;
    const downs: number[] = [];
    for (let k = 1; k < h.time.length; k++) {
      const a = h.displacement[3 * (k - 1) + 2]!;
      const b = h.displacement[3 * k + 2]!;
      if (a > 0 && b <= 0)
        downs.push(h.time[k - 1]! + ((h.time[k]! - h.time[k - 1]!) * a) / (a - b));
    }
    expect(downs.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs((downs[1]! - downs[0]!) * f - 1)).toBeLessThan(0.03);
    expect(res.checks.every((c) => c.pass)).toBe(true);
  });

  it('turns a free beam as a rigid body about each axis without straining it', () => {
    for (const axis of [0, 1, 2]) {
      const model = line(100, 10, { b: 4, h: 8 });
      const omega = 2000;
      const nn = 11;
      model.velocity = new Float64Array(3 * nn);
      model.rotation = new Float64Array(3 * nn);
      for (let k = 0; k < nn; k++) {
        const xk = model.nodes[3 * k]! - 50;
        // ω × r with r along x.
        if (axis === 1) model.velocity[3 * k + 2] = -omega * xk;
        if (axis === 2) model.velocity[3 * k + 1] = omega * xk;
        model.rotation[3 * k + axis] = omega;
      }
      const r = runExplicit(model, {
        ...explicitDefaults,
        endTime: Math.PI / 2 / omega,
        frameEvery: Math.PI / 20 / omega,
      });
      const last = r.energies.at(-1)!;
      expect((last.internal + last.hourglass) / r.energies[0]!.kinetic).toBeLessThan(1e-3);
      expect(r.checks.every((k) => k.pass)).toBe(true);
      const u = r.frames.at(-1)!.displacement;
      const len = Math.hypot(100 + u[30]! - u[0]!, u[31]! - u[1]!, u[32]! - u[2]!);
      expect(Math.abs(len / 100 - 1)).toBeLessThan(1e-3);
    }
  });

  it('keeps a free tumbling rigid body rigid, with its momentum and energy', () => {
    // Eight point masses at the corners of a 40 × 20 × 10 box, unequal: spun about a mix of
    // axes (near the middle one, which tumbles).
    const nodes = new Float64Array(24);
    let k = 0;
    for (const x of [0, 40])
      for (const y of [0, 20]) for (const z of [0, 10]) nodes.set([x, y, z], 3 * k++);
    const model: ExplicitModel = {
      nodes,
      ...none,
      materials: [steel],
      masses: [...Array(8).keys()].map((node) => ({ node, mass: 1e-3 * (1 + node / 4) })),
      rigidBodies: [{ nodes: [...Array(8).keys()], velocity: [100, 0, 0], rotation: [5, 200, 20] }],
    };
    const r = runExplicit(model, {
      ...explicitDefaults,
      endTime: 0.1,
      frameEvery: 0.01,
      minStep: 1e-5,
    });
    const e0 = r.energies[0]!.kinetic;
    for (const q of r.energies) expect(Math.abs(q.kinetic / e0 - 1)).toBeLessThan(2e-3);
    expect(r.checks.every((c) => c.pass)).toBe(true);
    // Rigid: every distance between the corners holds.
    const u = r.frames.at(-1)!.displacement;
    const at = (i: number) => [0, 1, 2].map((a) => nodes[3 * i + a]! + u[3 * i + a]!);
    for (let i = 0; i < 8; i++)
      for (let j = i + 1; j < 8; j++) {
        const d0 = Math.hypot(...[0, 1, 2].map((a) => nodes[3 * j + a]! - nodes[3 * i + a]!));
        const p = at(i);
        const q = at(j);
        const d = Math.hypot(...[0, 1, 2].map((a) => q[a]! - p[a]!));
        expect(Math.abs(d - d0)).toBeLessThan(1e-3);
      }
    // The centre moves on at 100 mm/s.
    let cx = 0;
    let m = 0;
    for (const p of model.masses!) {
      cx += p.mass * u[3 * p.node]!;
      m += p.mass;
    }
    expect(cx / m / 10).toBeCloseTo(1, 3);
  });

  it('drops a rigid body with gravity and balances the work', () => {
    const model: ExplicitModel = {
      nodes: new Float64Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
      ...none,
      materials: [steel],
      rigidBodies: [{ nodes: [0, 1, 2], mass: 0.01, inertia: [1, 1, 1] }],
      gravity: [0, 0, -9810],
    };
    const T = 0.01;
    const r = runExplicit(model, { ...explicitDefaults, endTime: T, frameEvery: T, minStep: 1e-4 });
    const last = r.energies.at(-1)!;
    expect(last.kinetic / (0.5 * 0.01 * (9810 * T) ** 2)).toBeCloseTo(1, 6);
    expect(last.external / last.kinetic).toBeCloseTo(1, 6);
    expect(r.frames.at(-1)!.displacement[2]! / (-0.5 * 9810 * T * T)).toBeCloseTo(1, 6);
  });

  it('drops a body with uneven nodal masses and an added mass without turning it', () => {
    // Nodes at x = 0 and 10 with masses 1 and 3, 4 added at their centroid: the whole body's
    // gravity acts at its centre of mass, so both nodes fall ½ g t² together.
    const model: ExplicitModel = {
      nodes: new Float64Array([0, 0, 0, 10, 0, 0]),
      ...none,
      materials: [steel],
      masses: [
        { node: 0, mass: 1 },
        { node: 1, mass: 3 },
      ],
      rigidBodies: [{ nodes: [0, 1], mass: 4, inertia: [10, 10, 10] }],
      gravity: [0, -10, 0],
    };
    const T = 0.1;
    const r = runExplicit(model, { ...explicitDefaults, endTime: T, frameEvery: T, minStep: 1e-3 });
    const u = r.frames.at(-1)!.displacement;
    expect(u[1]! / -0.05).toBeCloseTo(1, 6);
    expect(u[4]! / -0.05).toBeCloseTo(1, 6);
    const last = r.energies.at(-1)!;
    expect(last.external / last.kinetic).toBeCloseTo(1, 6);
  });

  it('reports what holds a held rigid body, once per body', () => {
    const model: ExplicitModel = {
      nodes: new Float64Array([0, 0, 0, 5, 0, 0]),
      ...none,
      materials: [steel],
      rigidBodies: [{ nodes: [0, 1], mass: 1, inertia: [1, 1, 1], held: 63 }],
      forces: [
        { node: 0, force: [100, 0, 0] },
        { node: 1, force: [0, 20, 0] },
      ],
    };
    const s = new ExplicitSolver(model, {
      ...explicitDefaults,
      endTime: 1e-3,
      frameEvery: 1e-3,
      minStep: 1e-4,
    });
    while (!s.done) s.advance(1000);
    const r = s.reaction([0, 1]);
    expect(r[0]).toBeCloseTo(-100, 9);
    expect(r[1]).toBeCloseTo(-20, 9);
    expect(r[2]).toBeCloseTo(0, 9);
    expect(s.reaction([1])).toEqual(r);
  });

  it('books no work on a held turning body with an off-centre force', () => {
    // Nodes at x = 0 and 2, held turning at 10 rad/s, 1000 N along y on the second: what holds
    // it does the force's work back, so the external work stays zero through a quarter turn.
    const model: ExplicitModel = {
      nodes: new Float64Array([0, 0, 0, 2, 0, 0]),
      ...none,
      materials: [steel],
      rigidBodies: [{ nodes: [0, 1], mass: 1, inertia: [1, 1, 1], rotation: [0, 0, 10], held: 63 }],
      forces: [{ node: 1, force: [0, 1000, 0] }],
    };
    const r = runExplicit(model, {
      ...explicitDefaults,
      endTime: Math.PI / 20,
      frameEvery: Math.PI / 20,
      minStep: 1e-3,
    });
    const last = r.energies.at(-1)!;
    expect(last.kinetic).toBeCloseTo(50, 9);
    expect(Math.abs(last.external)).toBeLessThan(1e-9);
    expect(r.checks[0]!.pass, r.checks[0]!.detail).toBe(true);
  });

  it('leaves a beam between two bodies turning together unstrained', () => {
    // Bodies {(1,0,0), (−1,0,0)} and {(2,0,0), (−2,0,0)}, both centred on the origin and held
    // turning about z at 10 rad/s; a soft 1 mm beam joins (1,0,0) to (2,0,0). Steps near 1 ms.
    const soft = { density: 7.85e-9, youngsModulus: 0.01, poissonRatio: 0.3 };
    const model: ExplicitModel = {
      nodes: new Float64Array([1, 0, 0, -1, 0, 0, 2, 0, 0, -2, 0, 0]),
      ...none,
      materials: [soft],
      beams: new Uint32Array([0, 2]),
      beamSection: new Uint16Array(1),
      beamMaterial: new Uint16Array(1),
      sections: [{ area: 1, i2: 1 / 12, i3: 1 / 12, j: 0.14 }],
      beamOrientation: new Float64Array([0, 1, 0]),
      rigidBodies: [
        { nodes: [0, 1], mass: 1, inertia: [1, 1, 1], rotation: [0, 0, 10], held: 63 },
        { nodes: [2, 3], mass: 1, inertia: [1, 1, 1], rotation: [0, 0, 10], held: 63 },
      ],
    };
    const s = new ExplicitSolver(model, {
      ...explicitDefaults,
      endTime: Math.PI / 20,
      frameEvery: Math.PI / 20,
    });
    while (!s.done) s.advance(10_000);
    expect(s.result().step).toBeGreaterThan(5e-4);
    const force = (s as unknown as { beamForce: Float64Array }).beamForce;
    // Axial strain N / (E A): rounding only (end-of-step velocities gave 0.6 %). Shear strain
    // Q / (G A): the chord's 2 tan(θ/2) against the turn θ per step, (ωdt)²/12, over the run.
    expect(Math.abs(force[0]! / 0.01)).toBeLessThan(1e-7);
    const GA = 0.01 / (2 * 1.3);
    expect(Math.hypot(force[1]!, force[2]!) / GA).toBeLessThan(1e-4);
  });

  it('swings a rigid tip mass on a cantilever beam at the spring–mass period', () => {
    // 200 mm, 4 × 8 beam (axis 3 bending, I = 170.7 mm⁴): k = 3EI/L³; a 2 kg rigid block at the
    // tip (its centre on the tip): f = √(k/(m + 0.24 m_beam))/2π.
    const L = 200;
    const n = 20;
    const base = line(L, n, { b: 4, h: 8 });
    const nodes = new Float64Array(3 * (n + 2));
    nodes.set(base.nodes);
    nodes.set([L + 5, 0, 0], 3 * (n + 1));
    const model: ExplicitModel = {
      ...base,
      nodes,
      fixed: new Uint8Array(n + 2),
      rigidBodies: [{ nodes: [n, n + 1], mass: 2e-3, inertia: [1e-3, 1e-3, 1e-3] }],
      velocity: new Float64Array(3 * (n + 2)),
    };
    model.fixed![0] = 63;
    model.rigidBodies![0]!.velocity = [0, 0, 100];
    const I = (4 * 8 ** 3) / 12;
    const k = (3 * steel.youngsModulus * I) / L ** 3;
    const mBeam = steel.density * 32 * L;
    const f = Math.sqrt(k / (2e-3 + 0.24 * mBeam)) / (2 * Math.PI);
    const r = runExplicit(model, {
      ...explicitDefaults,
      endTime: 2.2 / f,
      frameEvery: 0.1 / f,
      historyNodes: [n],
    });
    const h = r.history[0]!;
    const downs: number[] = [];
    for (let q = 1; q < h.time.length; q++) {
      const a = h.displacement[3 * (q - 1) + 2]!;
      const b = h.displacement[3 * q + 2]!;
      if (a > 0 && b <= 0)
        downs.push(h.time[q - 1]! + ((h.time[q]! - h.time[q - 1]!) * a) / (a - b));
    }
    expect(downs.length).toBeGreaterThanOrEqual(2);
    // The block's turning inertia (and its centre 5 mm past the tip) lowers it a little.
    expect(Math.abs((downs[1]! - downs[0]!) * f - 1)).toBeLessThan(0.05);
    expect(r.checks.every((c) => c.pass)).toBe(true);
  });

  it('pulls a beam with a held rigid body, balancing the work', () => {
    // A rigid block held at 1000 mm/s along x pulls a clamped bar: its work goes into the bar.
    const n = 20;
    const model = line(100, n, { b: 10, h: 10 });
    model.fixed = new Uint8Array(n + 1);
    model.fixed[0] = 63;
    model.rigidBodies = [
      { nodes: [n], mass: 1e-3, inertia: [1, 1, 1], velocity: [1000, 0, 0], held: 63 },
    ];
    const r = runExplicit(model, { ...explicitDefaults, endTime: 1e-4, frameEvery: 1e-5 });
    const last = r.energies.at(-1)!;
    expect(last.external).toBeGreaterThan(0);
    expect(r.checks[0]!.pass, r.checks[0]!.detail).toBe(true);
    expect(r.frames.at(-1)!.displacement[3 * n]!).toBeCloseTo(0.1, 6);
  });

  it('carries a plate made rigid as one body without straining it', () => {
    const { nodes, shells } = quadPlate(100, 50, 10, 5);
    const nn = nodes.length / 3;
    const model: ExplicitModel = {
      nodes,
      shells,
      thickness: new Float64Array(50).fill(2),
      shellMaterial: new Uint16Array(50),
      materials: [steel],
      rigidBodies: [{ nodes: [...Array(nn).keys()], rotation: [2000, 0, 0] }],
    };
    const r = runExplicit(model, {
      ...explicitDefaults,
      endTime: Math.PI / 2 / 2000,
      frameEvery: Math.PI / 20 / 2000,
      minStep: 1e-6,
    });
    // Its shells set no step: the smallest step is the one given.
    expect(r.step).toBe(1e-6);
    expect(r.energies.at(-1)!.internal).toBe(0);
    expect(Math.abs(r.energies.at(-1)!.kinetic / r.energies[0]!.kinetic - 1)).toBeLessThan(1e-3);
  });

  it('refuses beams and rigid bodies it cannot run', () => {
    const settings = { ...explicitDefaults, endTime: 1e-4, frameEvery: 1e-5 };
    const bad = (f: (m: ExplicitModel) => void) => {
      const m = line(10, 2, { b: 1, h: 1 });
      f(m);
      return () => new ExplicitSolver(m, settings);
    };
    expect(bad((m) => (m.beamOrientation = new Float64Array([1, 0, 0, 1, 0, 0])))).toThrow(
      /orientation/,
    );
    expect(bad((m) => (m.beams![1] = 0))).toThrow(/one node twice/);
    expect(bad((m) => (m.sections = [{ area: 0, i2: 1, i3: 1, j: 1 }]))).toThrow(/section/);
    expect(
      bad((m) => {
        m.rigidBodies = [{ nodes: [0] }];
        m.fixed = new Uint8Array([63, 0, 0]);
      }),
    ).toThrow(/fixed/);
    expect(bad((m) => (m.rigidBodies = [{ nodes: [0, 1] }, { nodes: [1, 2] }]))).toThrow(
      /two rigid bodies/,
    );
    expect(bad((m) => (m.rigidBodies = [{ nodes: [1], held: 8 }]))).toThrow(/rotation/);
    expect(
      () =>
        new ExplicitSolver(
          {
            nodes: new Float64Array([0, 0, 0, 1, 0, 0]),
            ...none,
            materials: [steel],
            rigidBodies: [{ nodes: [0, 1], mass: 1, inertia: [1, 1, 1] }],
          },
          settings,
        ),
    ).toThrow(/minStep/);
  });
});
