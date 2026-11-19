import { describe, expect, it } from 'vitest';
import {
  ExplicitSolver,
  explicitDefaults,
  explicitWeldNodes,
  quadPlate,
  runExplicit,
  type ExplicitModel,
} from './explicit';

/** TS-2218 (ST-615, VS6b): spot welds as rigid links in the explicit solver. */
const steel = { density: 7.85e-9, youngsModulus: 210_000, poissonRatio: 0.3 };

/** Two sheets (parts 0 and 1), each a × b with nx × ny shells, the second moved by `shift`. */
function sheets(
  a: number,
  b: number,
  nx: number,
  ny: number,
  t: number,
  shift: [number, number, number],
): ExplicitModel {
  const one = quadPlate(a, b, nx, ny);
  const nn = one.nodes.length / 3;
  const ne = nx * ny;
  const nodes = new Float64Array(6 * nn);
  nodes.set(one.nodes);
  for (let k = 0; k < nn; k++)
    for (let q = 0; q < 3; q++) nodes[3 * (nn + k) + q] = one.nodes[3 * k + q]! + shift[q]!;
  const shells = new Uint32Array(8 * ne);
  shells.set(one.shells);
  shells.set(
    one.shells.map((i) => i + nn),
    4 * ne,
  );
  const shellPart = new Uint16Array(2 * ne);
  shellPart.fill(1, ne);
  return {
    nodes,
    shells,
    thickness: new Float64Array(2 * ne).fill(t),
    shellMaterial: new Uint16Array(2 * ne),
    shellPart,
    materials: [steel],
  };
}

describe('explicit spot welds (VS6b)', () => {
  it('turns two welded sheets a quarter turn as one body, the offset turning with them', () => {
    // 40 × 20 sheets 1 mm thick, midsurfaces 2 mm apart, two welds; spun about x at 2000 rad/s.
    const model = sheets(40, 20, 8, 4, 1, [0, 0, 2]);
    model.welds = [
      { point: [10, 10, 1], radius: 1.5, parts: [0, 1] },
      { point: [30, 10, 1], radius: 1.5, parts: [0, 1] },
    ];
    const n = model.nodes.length / 3;
    const omega = 2000;
    model.velocity = new Float64Array(3 * n);
    model.rotation = new Float64Array(3 * n);
    for (let k = 0; k < n; k++) {
      const y = model.nodes[3 * k + 1]! - 10;
      const z = model.nodes[3 * k + 2]! - 1;
      model.velocity[3 * k + 1] = -omega * z;
      model.velocity[3 * k + 2] = omega * y;
      model.rotation[3 * k] = omega;
    }
    const r = runExplicit(model, {
      ...explicitDefaults,
      endTime: Math.PI / 2 / omega,
      frameEvery: Math.PI / 20 / omega,
    });
    const last = r.energies.at(-1)!;
    expect((last.internal + last.hourglass) / r.energies[0]!.kinetic).toBeLessThan(1e-3);
    for (const c of r.checks) expect(c.pass, c.detail).toBe(true);
    // The weld's nodes (10, 10, 0) and (10, 10, 2): their offset (0, 0, 2) is now (0, −2, 0).
    const nn = n / 2;
    const lower = 2 + 9 * 2;
    const upper = nn + lower;
    const u = r.frames.at(-1)!.displacement;
    const d = [0, 1, 2].map(
      (q) =>
        model.nodes[3 * upper + q]! +
        u[3 * upper + q]! -
        model.nodes[3 * lower + q]! -
        u[3 * lower + q]!,
    );
    expect(Math.abs(d[0]!)).toBeLessThan(1e-6);
    expect(d[1]! / -2).toBeCloseTo(1, 4);
    // Turned by 90° within 0.2° (the sheets' own vibration moves the angle a little).
    expect(Math.abs(d[2]!)).toBeLessThan(2 * Math.sin((0.2 * Math.PI) / 180));
  });

  it('carries a lap joint’s pull through the weld', () => {
    // Strips 50 × 10, overlapping 10 mm; the lower's left end clamped, the upper's right end
    // pulled at 1000 mm/s. Welded, the clamp holds the pull; not welded, nothing reaches it.
    const run = (welded: boolean) => {
      const model = sheets(50, 10, 10, 2, 1, [40, 0, 1.2]);
      const nn = model.nodes.length / 6;
      const n = 2 * nn;
      if (welded) model.welds = [{ point: [45, 5, 0.6], radius: 1, parts: [0, 1] }];
      model.fixed = new Uint8Array(n);
      model.velocity = new Float64Array(3 * n);
      const left: number[] = [];
      for (let k = 0; k < nn; k++)
        if (model.nodes[3 * k]! === 0) {
          model.fixed[k] = 63;
          left.push(k);
        }
      for (let k = nn; k < n; k++)
        if (model.nodes[3 * k]! === 90) {
          model.fixed[k] = 63;
          model.velocity[3 * k] = 1000;
        }
      const s = new ExplicitSolver(model, { ...explicitDefaults, endTime: 5e-5, frameEvery: 1e-5 });
      while (!s.done) s.advance(10_000);
      return { reaction: s.reaction(left), result: s.result() };
    };
    const welded = run(true);
    const loose = run(false);
    expect(-welded.reaction[0]).toBeGreaterThan(100);
    expect(loose.reaction[0]).toBe(0);
    expect(welded.result.checks[0]!.pass, welded.result.checks[0]!.detail).toBe(true);
  });

  it('starts a weld’s link with its nodes’ angular momentum', () => {
    // 10 × 10 sheets 2 mm apart, one weld taking all 8 nodes; the upper at +100 mm/s along x,
    // the lower at −100: no net momentum, but a turn about y (v = ω × r: 2ω_y = v_up − v_low).
    const model = sheets(10, 10, 1, 1, 1, [0, 0, 2]);
    model.welds = [{ point: [5, 5, 1], radius: 10, parts: [0, 1] }];
    model.velocity = new Float64Array(24);
    for (let k = 0; k < 8; k++) model.velocity[3 * k] = k < 4 ? -100 : 100;
    const r = runExplicit(model, {
      ...explicitDefaults,
      endTime: 1e-7,
      frameEvery: 1e-7,
      minStep: 1e-8,
      historyNodes: [0, 4],
    });
    const [low, up] = r.history;
    const turn = (up!.velocity[0]! - low!.velocity[0]!) / 2;
    // L_y = Σ m·1·100 over I_yy = Σ m (x² + z²) and the nodes' rotary inertia m·A/3: about
    // 100 / (26 + 33) rad/s (it was 0, the sliding lost).
    expect(turn).toBeGreaterThan(1.5);
    expect(turn).toBeLessThan(2);
    expect(r.energies[0]!.kinetic).toBeGreaterThan(0);
  });

  it('keeps a welded body’s added mass where the body put it', () => {
    // A one-node body at the origin (node 0, mass 1 t) and both sheets in one weld: the body's
    // centre stays near the origin, so a y force there moves it without turning it.
    const model = sheets(10, 10, 1, 1, 1, [0, 0, 2]);
    model.welds = [{ point: [5, 5, 1], radius: 10, parts: [0, 1] }];
    model.rigidBodies = [{ nodes: [0], mass: 1, inertia: [1, 1, 1] }];
    model.forces = [{ node: 0, force: [0, 1, 0] }];
    const r = runExplicit(model, {
      ...explicitDefaults,
      endTime: 1e-4,
      frameEvery: 1e-4,
      minStep: 1e-5,
      historyNodes: [0, 7],
    });
    const [at, far] = r.history;
    const k = at!.time.length - 1;
    const vy = at!.velocity[3 * k + 1]!;
    expect(vy).toBeGreaterThan(0);
    // The far corner (10, 10, 2) moves as the origin does, within 1 %.
    expect(Math.abs(far!.velocity[3 * k]! - at!.velocity[3 * k]!)).toBeLessThan(0.01 * vy);
    expect(Math.abs(far!.velocity[3 * k + 1]! / vy - 1)).toBeLessThan(0.01);
  });

  it('keeps a welded turning body’s velocity at its own centre', () => {
    // A one-node body at the origin (no mass of its own) turning about z at 100 rad/s, welded to
    // both sheets: the joined body's centre is the sheets', yet it still turns about the origin (node 0 starts at rest, the far corner (10, 10)
    // at ω × r = (−1000, 1000)). Held in translation, the pivot would move: refused.
    const make = (held?: number) => {
      const model = sheets(10, 10, 1, 1, 1, [0, 0, 2]);
      model.welds = [{ point: [5, 5, 1], radius: 10, parts: [0, 1] }];
      model.rigidBodies = [{ nodes: [0], rotation: [0, 0, 100], held }];
      return model;
    };
    const settings = {
      ...explicitDefaults,
      endTime: 1e-7,
      frameEvery: 1e-7,
      minStep: 1e-8,
      historyNodes: [0, 7],
    };
    const r = runExplicit(make(), settings);
    const [at, far] = r.history;
    expect(Math.hypot(at!.velocity[0]!, at!.velocity[1]!)).toBeLessThan(1e-3);
    expect(far!.velocity[0]! / -1000).toBeCloseTo(1, 3);
    expect(far!.velocity[1]! / 1000).toBeCloseTo(1, 3);
    expect(() => runExplicit(make(63), settings)).toThrow(/pivot/);
  });

  it('ties the nodes within the radius, or the nearest shell’s', () => {
    const model = sheets(20, 20, 4, 4, 1, [0, 0, 2]);
    const part0 = [...Array(16).keys()];
    // A node at (5, 5, 0): within 1.5 of (5, 5, 1).
    expect(explicitWeldNodes(model, part0, [5, 5, 1], 1.5)).toEqual([6]);
    // (7.5, 7.5): no node within 1: the four corners of the shell under it.
    expect(explicitWeldNodes(model, part0, [7.5, 7.5, 1], 1)).toEqual([6, 7, 11, 12]);
    // VS8c-2 (TS-2236): with `nearestNode`, the nearest of them alone.
    expect(explicitWeldNodes(model, part0, [6, 6.5, 1], 1, true)).toEqual([6]);
    expect(explicitWeldNodes(model, part0, [5, 5, 1], 1.5, true)).toEqual([6]);
  });

  it('joins welds that share a node into one link, and refuses what it cannot tie', () => {
    const settings = { ...explicitDefaults, endTime: 1e-5, frameEvery: 1e-5 };
    const model = sheets(20, 20, 4, 4, 1, [0, 0, 2]);
    model.welds = [
      { point: [7.5, 7.5, 1], radius: 1, parts: [0, 1] },
      { point: [10, 7.5, 1], radius: 1, parts: [0, 1] },
    ];
    expect(() => new ExplicitSolver(model, settings)).not.toThrow();
    const bad = (f: (m: ExplicitModel) => void) => {
      const m = sheets(20, 20, 4, 4, 1, [0, 0, 2]);
      m.welds = [{ point: [5, 5, 1], radius: 1.5, parts: [0, 1] }];
      f(m);
      return () => new ExplicitSolver(m, settings);
    };
    expect(bad((m) => (m.welds![0]!.radius = 0))).toThrow(/weld/);
    expect(bad((m) => (m.welds![0]!.parts = [0, 0]))).toThrow(/weld/);
    expect(bad((m) => (m.shellPart = undefined))).toThrow(/part per shell/);
    expect(
      bad((m) => {
        m.fixed = new Uint8Array(m.nodes.length / 3);
        m.fixed[6] = 63;
      }),
    ).toThrow(/weld and fixed/);
    expect(
      bad((m) => {
        m.rigidBodies = [{ nodes: [6] }, { nodes: [25 + 6] }];
      }),
    ).toThrow(/join rigid bodies/);
  });

  it('ties a seam node by node, so the joined sheets still bend, at the cost of plain nodes (VS8c)', () => {
    // TS-2235 (ST-624, Codex on #1225): two 100 × 20 sheets 1 mm thick, midsurfaces 2 mm apart,
    // every node of the upper beyond x = 10 tied to the node under it; the lower held at x = 0,
    // both moving up at 1 m/s. Ties keep each pair to itself: the cantilever bends along its
    // length. Point welds of a small radius onto the sheet below take the nearest shell's
    // corners, so neighbouring welds share nodes and the seam becomes one rigid piece that stays
    // straight beyond the first column.
    const make = (tied: boolean, nearestNode?: boolean) => {
      const model = sheets(100, 20, 10, 2, 1, [0, 0, 2]);
      const n = model.nodes.length / 3;
      const nn = n / 2;
      model.fixed = new Uint8Array(n);
      model.velocity = new Float64Array(3 * n);
      const ties: number[] = [];
      model.welds = [];
      for (let k = 0; k < nn; k++) {
        model.velocity[3 * (nn + k) + 2] = 1000;
        if (model.nodes[3 * k]! < 1e-9) {
          model.fixed[k] = 63;
          continue;
        }
        model.velocity[3 * k + 2] = 1000;
        // The first column is left untied, off the held nodes' shells.
        if (model.nodes[3 * k]! < 15) continue;
        const p = [0, 1, 2].map((q) => model.nodes[3 * (nn + k) + q]!) as [number, number, number];
        if (tied) ties.push(nn + k, k);
        else
          model.welds.push({
            point: p,
            radius: 0.01,
            parts: [1, 0],
            ...(nearestNode ? { nearestNode } : {}),
          });
      }
      if (tied) model.ties = Uint32Array.from(ties);
      return model;
    };
    const settings = { ...explicitDefaults, endTime: 2e-3, frameEvery: 1e-3 };
    const seam = runExplicit(make(true), settings);
    const rigid = runExplicit(make(false), settings);
    for (const c of seam.checks) expect(c.pass, c.detail).toBe(true);
    // The lower sheet's sag at x = 60 off the chord from x = 20 to x = 100 (y = 0).
    const base = make(true);
    const nn = base.nodes.length / 6;
    const at = (x: number) =>
      [...Array(nn).keys()].find(
        (k) => Math.abs(base.nodes[3 * k]! - x) < 1e-9 && Math.abs(base.nodes[3 * k + 1]!) < 1e-9,
      )!;
    const sag = (r: typeof seam) => {
      const w = (x: number) => r.frames.at(-1)!.displacement[3 * at(x) + 2]!;
      return Math.abs(w(60) - (w(20) + w(100)) / 2);
    };
    expect(sag(seam)).toBeGreaterThan(0.02);
    expect(sag(rigid)).toBeLessThan(sag(seam) / 20);
    // VS8c-2 (TS-2236, Codex on #1256): the same welds taking the nearest node alone stay pairs
    // and bend as the seam does.
    const paired = runExplicit(make(false, true), settings);
    expect(sag(paired)).toBeGreaterThan(sag(seam) / 2);
    // Each tied pair keeps its 2 mm arm (the follower on its rigid arm).
    const u = seam.frames.at(-1)!.displacement;
    for (const k of [at(50), at(100)]) {
      const d = [0, 1, 2].map(
        (q) =>
          base.nodes[3 * (nn + k) + q]! +
          u[3 * (nn + k) + q]! -
          base.nodes[3 * k + q]! -
          u[3 * k + q]!,
      );
      expect(Math.hypot(...d)).toBeCloseTo(2, 6);
    }
    // A tie's own two nodes, a node following two, a circle and a held follower are refused.
    const bad = (ties: number[], fix?: number) => () => {
      const m = make(true);
      m.ties = Uint32Array.from([...m.ties!, ...ties]);
      if (fix !== undefined) m.fixed![fix] = 63;
      return new ExplicitSolver(m, settings);
    };
    expect(bad([3, 3])).toThrow(/two different nodes/);
    expect(bad([nn + 5, 6])).toThrow(/follows two nodes/);
    expect(bad([5, nn + 5])).toThrow(/circle/);
    expect(bad([], nn + 5)).toThrow(/follows a tie and is fixed/);
  });

  it('scales the mass of the smallest shells up to the given share (VS8c)', () => {
    // TS-2235 (ST-624): two 100 × 20 sheets of 10 × 2 shells, one column of the first squeezed
    // to 0.5 mm (2 of the 40 shells). Its shells alone set the step; a 1 % share gives them mass
    // for a longer step, adding no more.
    const model = sheets(100, 20, 10, 2, 1, [0, 0, 2]);
    const n = model.nodes.length / 3;
    for (let k = 0; k < n / 2; k++) {
      const x = model.nodes[3 * k]!;
      if (Math.abs(x - 50) < 1e-9) model.nodes[3 * k] = 59.5;
    }
    model.velocity = new Float64Array(3 * n).fill(0);
    const settings = { ...explicitDefaults, endTime: 1e-4, frameEvery: 1e-4 };
    const plain = runExplicit(model, settings);
    const scaled = runExplicit(model, { ...settings, massScalingShare: 0.01 });
    expect(plain.addedMassShare).toBe(0);
    // The squeezed shells are 0.25 % of the mass: 1 % more takes them to √5 times their step.
    expect(scaled.step / plain.step).toBeCloseTo(Math.sqrt(5), 2);
    expect(scaled.addedMassShare).toBeGreaterThan(0.009);
    expect(scaled.addedMassShare).toBeLessThanOrEqual(0.01 + 1e-9);
    // None needed: none added.
    const even = sheets(100, 20, 10, 2, 1, [0, 0, 2]);
    expect(runExplicit(even, { ...settings, massScalingShare: 0.01 }).addedMassShare).toBe(0);
    expect(() => new ExplicitSolver(model, { ...settings, massScalingShare: 0.1 })).toThrow(
      /0\.\.0\.05/,
    );
  });

  it('counts the share of mass scaling against the whole model’s mass (VS8c-2)', () => {
    // TS-2236 (ST-625): the squeezed sheets above with a point mass as heavy as the shells: the
    // 1 % budget is now 2 % of the shells' mass, so the squeezed shells (0.25 %) take 8 times
    // their mass, 3 times their step; the share is still 1 % of the model.
    const model = sheets(100, 20, 10, 2, 1, [0, 0, 2]);
    const n = model.nodes.length / 3;
    for (let k = 0; k < n / 2; k++) {
      const x = model.nodes[3 * k]!;
      if (Math.abs(x - 50) < 1e-9) model.nodes[3 * k] = 59.5;
    }
    model.velocity = new Float64Array(3 * n).fill(0);
    const settings = { ...explicitDefaults, endTime: 1e-4, frameEvery: 1e-4 };
    const plain = runExplicit(model, settings);
    const shells = 2 * 100 * 20 * 1 * 7.85e-9;
    model.masses = [{ node: 0, mass: shells }];
    const scaled = runExplicit(model, { ...settings, massScalingShare: 0.01 });
    expect(scaled.step / plain.step).toBeCloseTo(3, 2);
    expect(scaled.addedMassShare).toBeGreaterThan(0.009);
    expect(scaled.addedMassShare).toBeLessThanOrEqual(0.01 + 1e-9);
  });

  it('moves a tie group as one rigid piece: free fall without a turn, held pairs, no parts (VS8c)', () => {
    // TS-2235 (Codex on #1225): two 10 × 10 sheets 2 mm apart, every upper node tied to the one
    // under it (arms along z), falling under gravity along x: the coupled group falls as one,
    // with no turn and the same velocity at both ends of each arm.
    const make = () => {
      const model = sheets(10, 10, 1, 1, 1, [0, 0, 2]);
      const nn = model.nodes.length / 6;
      model.ties = Uint32Array.from([...Array(nn).keys()].flatMap((k) => [nn + k, k]));
      return model;
    };
    const fall = make();
    fall.gravity = [9810, 0, 0];
    const settings = { ...explicitDefaults, endTime: 1e-3, frameEvery: 1e-3 };
    const solver = new ExplicitSolver(fall, settings);
    while (!solver.done) solver.advance(1000);
    const r = solver.result();
    const nn = fall.nodes.length / 6;
    const u = r.frames.at(-1)!.displacement;
    // ½ g t² along x everywhere, nothing across.
    for (let k = 0; k < 2 * nn; k++) {
      expect(u[3 * k]! / (0.5 * 9810 * 1e-6)).toBeCloseTo(1, 3);
      expect(Math.abs(u[3 * k + 1]!) + Math.abs(u[3 * k + 2]!)).toBeLessThan(1e-9);
    }
    for (const c of r.checks) expect(c.pass, c.detail).toBe(true);
    // Both nodes of every tie held: a held group.
    const held = make();
    held.fixed = new Uint8Array(2 * nn).fill(63);
    expect(() => new ExplicitSolver(held, settings)).not.toThrow();
    // A sheet tied to a rigid one, with no part indices (no welds need them).
    const rigid = make();
    delete rigid.shellPart;
    rigid.rigidBodies = [{ nodes: [...Array(nn).keys()] }];
    // Every tie joins the body, so the whole is rigid (and needs a smallest step).
    expect(() => new ExplicitSolver(rigid, { ...settings, minStep: 1e-7 })).not.toThrow();
  });

  it('keeps the automatic mass scaling under the beams’ own steps (VS8c)', () => {
    // Codex on #1225: a 10 × 10 shell and a 0.01 mm beam: the beam gets no mass from the share,
    // so the step stays the beam's.
    const model: ExplicitModel = {
      ...quadPlate(10, 10, 1, 1),
      thickness: new Float64Array([1]),
      shellMaterial: new Uint16Array(1),
      materials: [steel],
    };
    const x = model.nodes;
    model.nodes = Float64Array.from([...x, 0, 0, 0.01]);
    model.beams = new Uint32Array([0, x.length / 3]);
    model.beamSection = new Uint16Array(1);
    model.beamMaterial = new Uint16Array(1);
    model.sections = [{ area: 1, i2: 1 / 12, i3: 1 / 12, j: 0.14 }];
    model.beamOrientation = new Float64Array([0, 1, 0]);
    const settings = {
      ...explicitDefaults,
      endTime: 1e-6,
      frameEvery: 1e-6,
      massScalingShare: 0.01,
    };
    const r = runExplicit(model, settings);
    expect(r.addedMassShare).toBe(0);
  });
});
