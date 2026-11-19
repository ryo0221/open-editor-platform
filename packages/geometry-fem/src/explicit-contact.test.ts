import { describe, expect, it } from 'vitest';
import { ContactSet } from './explicit-contact';
import {
  ExplicitSolver,
  explicitDefaults,
  quadPlate,
  runExplicit,
  type ExplicitModel,
  type ExplicitWall,
} from './explicit';

/** TS-2217 (ST-614, VS6a): contact of shells, rigid walls and poles, with friction. */
const steel = { density: 7.85e-9, youngsModulus: 210_000, poissonRatio: 0 };

function plate(a: number, b: number, nx: number, ny: number, t: number): ExplicitModel {
  const { nodes, shells } = quadPlate(a, b, nx, ny);
  const ne = nx * ny;
  return {
    nodes,
    shells,
    thickness: new Float64Array(ne).fill(t),
    shellMaterial: new Uint16Array(ne),
    materials: [steel],
  };
}

/** Two models' nodes and shells as one. */
function join(a: ExplicitModel, b: ExplicitModel): ExplicitModel {
  const na = a.nodes.length / 3;
  const shells = new Uint32Array(a.shells.length + b.shells.length);
  shells.set(a.shells);
  shells.set(
    b.shells.map((i) => i + na),
    a.shells.length,
  );
  const cat = <T extends Float64Array | Uint16Array>(p: T, q: T, make: (n: number) => T) => {
    const out = make(p.length + q.length);
    out.set(p);
    out.set(q, p.length);
    return out;
  };
  return {
    nodes: cat(a.nodes, b.nodes, (n) => new Float64Array(n)),
    shells,
    thickness: cat(a.thickness, b.thickness, (n) => new Float64Array(n)),
    shellMaterial: cat(a.shellMaterial, b.shellMaterial, (n) => new Uint16Array(n)),
    materials: a.materials,
  };
}

describe('explicit contact (VS6a)', () => {
  it('stops a bar on a rigid wall with the impedance force for the wave’s round trip', () => {
    // 200 × 10 × 1 mm strip at 1000 mm/s onto a wall: F = ρ c A v while the wave goes to the
    // far end and back (2L/c); then it leaves at 1000 mm/s the other way.
    const L = 200;
    const model = plate(L, 10, 100, 2, 1);
    const n = model.nodes.length / 3;
    model.velocity = new Float64Array(3 * n);
    for (let k = 0; k < n; k++) model.velocity[3 * k] = -1000;
    model.fixed = new Uint8Array(n).fill(4 | 8 | 16 | 32);
    model.walls = [{ point: [-0.5 - 1e-3, 0, 0], normal: [1, 0, 0] }];
    const c = Math.sqrt(steel.youngsModulus / steel.density);
    const T = (2 * L) / c;
    const r = runExplicit(model, {
      ...explicitDefaults,
      endTime: 1.5 * T,
      frameEvery: T / 10,
    });
    const b = r.barriers[0]!;
    const F = steel.density * c * 10 * 1 * 1000;
    const fx = (k: number) => b.force[3 * k]!;
    // Contact time: while the wall pushes over half of F (the penalty spring takes a few steps
    // to build up).
    let on = NaN;
    let off = NaN;
    for (let k = 0; k < b.time.length; k++) {
      if (Number.isNaN(on) && -fx(k) > 0.5 * F) on = b.time[k]!;
      if (!Number.isNaN(on) && Number.isNaN(off) && -fx(k) < 0.5 * F) off = b.time[k]!;
    }
    expect(Math.abs((off - on) / T - 1)).toBeLessThan(0.05);
    // The mean force over the middle of the contact.
    let sum = 0;
    let count = 0;
    for (let k = 0; k < b.time.length; k++)
      if (b.time[k]! > on + 0.2 * T && b.time[k]! < on + 0.8 * T) {
        sum += -fx(k);
        count++;
      }
    expect(Math.abs(sum / count / F - 1)).toBeLessThan(0.05);
    const e = r.energies.at(-1)!;
    expect(e.kinetic / r.energies[0]!.kinetic).toBeGreaterThan(0.95);
    expect(r.checks[0]!.pass, r.checks[0]!.detail).toBe(true);
  });

  it('slows a block sliding on a wall by μg', () => {
    // A rigid 20 × 20 × 2 mm plate resting on the floor at 1000 mm/s, μ = 0.3.
    const model = plate(20, 20, 2, 2, 2);
    const n = model.nodes.length / 3;
    for (let k = 0; k < n; k++) model.nodes[3 * k + 2] = 1;
    model.rigidBodies = [{ nodes: [...Array(n).keys()], velocity: [1000, 0, 0] }];
    model.gravity = [0, 0, -9810];
    model.walls = [{ point: [0, 0, 0], normal: [0, 0, 1], friction: 0.3 }];
    const T = 0.1;
    const s = new ExplicitSolver(model, {
      ...explicitDefaults,
      endTime: T,
      frameEvery: T,
      minStep: 1e-5,
      historyNodes: [0],
    });
    while (!s.done) s.advance(10_000);
    const r = s.result();
    const h = r.history[0]!;
    const vx = h.velocity[3 * (h.time.length - 1)]!;
    expect(Math.abs(vx / (1000 - 0.3 * 9810 * T) - 1)).toBeLessThan(0.01);
    expect(r.checks[0]!.pass, r.checks[0]!.detail).toBe(true);
  });

  it('takes a strip’s momentum on a pole without letting it through', () => {
    // 100 × 10 × 1 strip across a pole (axis z, r = 5 mm) at its middle, moving −y at 1000 mm/s.
    const model = plate(100, 10, 50, 2, 1);
    const n = model.nodes.length / 3;
    for (let k = 0; k < n; k++) {
      // Stand the strip up: x along, its width along z.
      const y = model.nodes[3 * k + 1]!;
      model.nodes[3 * k + 1] = 0;
      model.nodes[3 * k + 2] = y;
    }
    model.velocity = new Float64Array(3 * n);
    for (let k = 0; k < n; k++) model.velocity[3 * k + 1] = -1000;
    model.poles = [{ point: [50, -5.5 - 1e-3, 0], axis: [0, 0, 1], radius: 5 }];
    const T = 2e-4;
    const r = runExplicit(model, {
      ...explicitDefaults,
      endTime: T,
      frameEvery: T / 20,
      historyNodes: [...Array(n).keys()],
    });
    const b = r.barriers[0]!;
    // The impulse on the pole is the strip's lost momentum.
    let impulse = 0;
    for (let k = 1; k < b.time.length; k++)
      impulse += (b.time[k]! - b.time[k - 1]!) * b.force[3 * k + 1]!;
    // The strip's momentum now: lumped masses (a quarter of each shell on its corners).
    const share = new Float64Array(n);
    for (const k of model.shells) share[k] += (steel.density * 2 * 5 * 1) / 4;
    let p = 0;
    let m = 0;
    for (const h of r.history) {
      p += share[h.node]! * h.velocity[3 * (h.time.length - 1) + 1]!;
      m += share[h.node]!;
    }
    expect(Math.abs(-impulse / (p + 1000 * m) - 1)).toBeLessThan(0.02);
    const u = r.frames.at(-1)!.displacement;
    // No node got inside the pole by more than a tenth of its half thickness.
    for (let k = 0; k < n; k++) {
      const x = model.nodes[3 * k]! + u[3 * k]! - 50;
      const y = model.nodes[3 * k + 1]! + u[3 * k + 1]! + 5.5 + 1e-3;
      expect(Math.hypot(x, y)).toBeGreaterThan(5 + 0.45);
    }
    expect(r.checks[0]!.pass, r.checks[0]!.detail).toBe(true);
  });

  it('passes momentum from one plate to another through their surfaces', () => {
    // Two 20 × 20 plates 2 mm thick, 0.01 mm apart (midsurfaces 2.01 mm), the upper shifted by
    // half an element: the lower one moves up at 1000 mm/s into the resting one.
    const a = plate(20, 20, 4, 4, 2);
    const b = plate(20, 20, 4, 4, 2);
    for (let k = 0; k < b.nodes.length / 3; k++) {
      b.nodes[3 * k] += 2.5;
      b.nodes[3 * k + 2] = 2.01;
    }
    const model = join(a, b);
    model.contact = {};
    const na = a.nodes.length / 3;
    const n = model.nodes.length / 3;
    model.velocity = new Float64Array(3 * n);
    for (let k = 0; k < na; k++) model.velocity[3 * k + 2] = 1000;
    const T = 1e-4;
    const r = runExplicit(model, { ...explicitDefaults, endTime: T, frameEvery: T / 40 });
    let closest = Infinity;
    for (const f of r.frames) {
      // Mean gap between the plates' midsurfaces.
      let za = 0;
      let zb = 0;
      for (let k = 0; k < na; k++) za += f.displacement[3 * k + 2]! / na;
      for (let k = na; k < n; k++) zb += (2.01 + f.displacement[3 * k + 2]!) / (n - na);
      closest = Math.min(closest, zb - za);
    }
    expect(closest).toBeGreaterThan(1.8);
    // Momentum (equal masses: the mean speeds add up to 1000 mm/s): equal and opposite forces.
    const last = r.frames.at(-1)!;
    const prev = r.frames.at(-2)!;
    const dt = last.time - prev.time;
    const speed = (nodes: number[]) =>
      nodes.reduce(
        (sum, k) => sum + (last.displacement[3 * k + 2]! - prev.displacement[3 * k + 2]!) / dt,
        0,
      );
    const va = speed([...Array(na).keys()]) / na;
    const vb = speed([...Array(n - na).keys()].map((k) => k + na)) / (n - na);
    expect(Math.abs((va + vb) / 1000 - 1)).toBeLessThan(0.02);
    expect(vb).toBeGreaterThan(500);
    expect(r.checks[0]!.pass, r.checks[0]!.detail).toBe(true);
  });

  it('puts no force on an undeformed sheet thicker than its mesh pitch', () => {
    // 20 × 20 plate, 1 mm elements, 1.1 mm thick: its neighbouring segments lie within the gap.
    const model = plate(20, 20, 20, 20, 1.1);
    model.contact = {};
    const r = runExplicit(model, { ...explicitDefaults, endTime: 1e-6, frameEvery: 1e-6 });
    for (const u of r.frames.at(-1)!.displacement) expect(u).toBe(0);
  });

  /** A contact set on loose nodes and shells, for the force laws themselves. */
  const set = (
    nodes: number[],
    shells: number[],
    thickness: number[],
    mass: number[],
    bodyOf?: number[],
    friction = 0,
    walls: ExplicitWall[] = [],
  ) => {
    const n = nodes.length / 3;
    return new ContactSet({
      nodeCount: n,
      shells: Uint32Array.from(shells),
      thickness: Float64Array.from(thickness),
      mass: Float64Array.from(mass),
      x0: Float64Array.from(nodes),
      bodyOf: Int32Array.from(bodyOf ?? new Array(n).fill(-1)),
      erased: new Uint8Array(thickness.length),
      contact: { friction },
      walls,
      poles: [],
      step: 1e-6,
    });
  };

  it('shares a light node’s friction among the contacts on it', () => {
    // A deformable 10 × 10 quad (nodes 0–3, 1e-3 each) sliding along x at 1000 under a heavy
    // rigid 4 × 4 impactor (2 × 2 mm at its corner, 0.5 mm into it): the impactor's 25 nodes
    // all push the triangle near node 0. Together they may only stop its slip, not reverse it.
    const nodes = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0];
    const shells = [0, 1, 2, 3];
    for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) nodes.push(0.5 * i, 0.5 * j, 1.5);
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 4; i++) {
        const q = 4 + 5 * j + i;
        shells.push(q, q + 1, q + 6, q + 5);
      }
    const n = nodes.length / 3;
    const mass = [1e-3, 1e-3, 1e-3, 1e-3, ...new Array(25).fill(1)];
    const bodyOf = [-1, -1, -1, -1, ...new Array(25).fill(0)];
    const c = set(nodes, shells, new Array(17).fill(2), mass, bodyOf, 0.3);
    const x = Float64Array.from(nodes);
    const v = new Float64Array(3 * n);
    for (let k = 0; k < 4; k++) v[3 * k] = 1000;
    const ke = (u: Float64Array) => {
      let e = 0;
      for (let k = 0; k < 4; k++) e += 0.5 * 1e-3 * u[3 * k]! ** 2;
      return e;
    };
    let f = new Float64Array(3 * n);
    // The first call counts the contacts; the second is the one the shares hold for.
    for (let pass = 0; pass < 2; pass++) {
      f = new Float64Array(3 * n);
      c.forces(x, v, new Float64Array(3 * n), f, new Float64Array(3 * n));
    }
    const after = Float64Array.from(v);
    for (let k = 0; k < 4; k++) after[3 * k] += (f[3 * k]! * c.stepNow) / 1e-3;
    // Friction is acting, and it takes x kinetic energy (the impactor barely moves).
    expect(f[0]!).toBeLessThan(0);
    expect(ke(after)).toBeLessThan(ke(v));
    expect(after[0]!).toBeGreaterThanOrEqual(0);
  });

  it('keeps the angular momentum of offset plates sliding with friction', () => {
    // 10 × 10 quads at z = 0 and z = 1.5, 2 mm thick (overlapping 0.5), the upper sliding along x.
    const nodes = [
      0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 1.5, 10, 0, 1.5, 10, 10, 1.5, 0, 10, 1.5,
    ];
    const c = set(nodes, [0, 1, 2, 3, 4, 5, 6, 7], [2, 2], new Array(8).fill(1e-3), undefined, 0.3);
    const x = Float64Array.from(nodes);
    const v = new Float64Array(24);
    for (let k = 4; k < 8; k++) v[3 * k] = 1000;
    const f = new Float64Array(24);
    const m = new Float64Array(24);
    c.forces(x, v, new Float64Array(24), f, m);
    const net = [0, 0, 0];
    const moment = [0, 0, 0];
    for (let k = 0; k < 8; k++) {
      const [px, py, pz] = [x[3 * k]!, x[3 * k + 1]!, x[3 * k + 2]!];
      const [fx, fy, fz] = [f[3 * k]!, f[3 * k + 1]!, f[3 * k + 2]!];
      net[0] += fx;
      net[1] += fy;
      net[2] += fz;
      moment[0] += py * fz - pz * fy + m[3 * k]!;
      moment[1] += pz * fx - px * fz + m[3 * k + 1]!;
      moment[2] += px * fy - py * fx + m[3 * k + 2]!;
    }
    // Friction is acting: the lower plate is dragged along x.
    expect(f[0]! + f[3]! + f[6]! + f[9]!).toBeGreaterThan(0);
    const scale = Math.abs(f[0]!) * 10;
    for (const q of [...net, ...moment]) expect(Math.abs(q)).toBeLessThan(1e-9 * scale);
  });

  it('turns a plate sliding on a wall by the friction at the wall', () => {
    // A 2 mm plate, midsurface 0.9 mm over the floor, sliding along x: the friction acts at the
    // floor, 0.9 mm below the midsurface, so it turns the plate about y by 0.9 × the force.
    const nodes = [0, 0, 0.9, 10, 0, 0.9, 10, 10, 0.9, 0, 10, 0.9];
    const c = set(nodes, [0, 1, 2, 3], [2], new Array(4).fill(1e-3), undefined, 0, [
      { point: [0, 0, 0], normal: [0, 0, 1], friction: 0.3 },
    ]);
    const x = Float64Array.from(nodes);
    const v = new Float64Array(12);
    for (let k = 0; k < 4; k++) v[3 * k] = 1000;
    const f = new Float64Array(12);
    const m = new Float64Array(12);
    c.forces(x, v, new Float64Array(12), f, m);
    let fx = 0;
    let my = 0;
    for (let k = 0; k < 4; k++) {
      fx += f[3 * k]!;
      my += (x[3 * k + 2]! - 0.9) * f[3 * k]! - (x[3 * k]! - 5) * f[3 * k + 2]! + m[3 * k + 1]!;
    }
    expect(fx).toBeLessThan(0);
    expect(my / (0.9 * -fx)).toBeCloseTo(1, 9);
  });

  it('takes the slip of turning plates at their contact point', () => {
    // The plates of the friction test turning together about y at 10 rad/s (about z = 0.75),
    // the upper also sliding along x at 1 mm/s: the friction must take power, not give it.
    const nodes = [
      0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 1.5, 10, 0, 1.5, 10, 10, 1.5, 0, 10, 1.5,
    ];
    const c = set(nodes, [0, 1, 2, 3, 4, 5, 6, 7], [2, 2], new Array(8).fill(1e-3), undefined, 0.3);
    const x = Float64Array.from(nodes);
    const v = new Float64Array(24);
    const w = new Float64Array(24);
    for (let k = 0; k < 8; k++) {
      const rx = x[3 * k]! - 5;
      const rz = x[3 * k + 2]! - 0.75;
      v[3 * k] = 10 * rz + (k >= 4 ? 1 : 0);
      v[3 * k + 2] = -10 * rx;
      w[3 * k + 1] = 10;
    }
    const f = new Float64Array(24);
    const m = new Float64Array(24);
    c.forces(x, v, w, f, m);
    let power = 0;
    let drag = 0;
    for (let k = 0; k < 24; k++) power += f[k]! * v[k]! + m[k]! * w[k]!;
    for (let k = 4; k < 8; k++) drag += f[3 * k]!;
    // The normal springs' power: none (the plates keep their distance): what is left is friction.
    expect(drag).toBeLessThan(0);
    expect(power).toBeLessThan(0);
  });

  it('skips a quad’s flat triangle instead of failing', () => {
    // Corners (0,0,0), (5,0,0), (10,0,0), (0,10,0): the triangle (0, 1, 2) is a line. A node of
    // another shell on (5, 0, 0) meets the quad's other triangle, on its edge.
    const nodes = [0, 0, 0, 5, 0, 0, 10, 0, 0, 0, 10, 0, 5, 0, 0, 5, -3, -3, 6, -3, -3];
    const c = set(nodes, [0, 1, 2, 3, 4, 5, 6, 6], [1, 0.01], new Array(7).fill(1e-3));
    const f = new Float64Array(21);
    c.forces(
      Float64Array.from(nodes),
      new Float64Array(21),
      new Float64Array(21),
      f,
      new Float64Array(21),
    );
    for (const q of f) expect(Number.isFinite(q)).toBe(true);
  });

  it('holds a contact at a light vertex with that vertex’s mass', () => {
    // A heavy node 0.5 mm above the light corner of a triangle (corner masses 1e-6, 1, 1 t).
    const nodes = [0, 0, 0, 10, 0, 0, 0, 10, 0, 0.01, 0.01, 0.5, 0.01, 0.01, 0.5];
    const c = set(nodes, [0, 1, 2, 2, 3, 4, 4, 4], [1, 1], [1e-6, 1, 1, 1, 1]);
    const f = new Float64Array(15);
    c.forces(
      Float64Array.from(nodes),
      new Float64Array(15),
      new Float64Array(15),
      f,
      new Float64Array(15),
    );
    // The spring on the node, and the light corner's own on the node's shell: each within
    // 0.1 · (effective mass ≈ 1e-6) · 0.5 / Δt² (the corners' mean mass gave over 10⁵ times that).
    expect(f[11]!).toBeGreaterThan(0);
    expect(f[11]!).toBeLessThan((2 * 0.1 * 1.01e-6 * 0.5) / 1e-12);
  });

  it('lets a rigid body’s nodes touch its mixed shells’ other triangle', () => {
    // Quad 0–3 with corners 0, 1, 2 in body 0 and corner 3 free; body 0 also holds a small quad
    // 4–7 whose node 4 sits 0.5 mm over the quad's second triangle (0, 2, 3).
    const nodes = [
      0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 2, 8, 0.5, 3, 8, 0.5, 3, 9, 0.5, 2, 9, 0.5,
    ];
    const c = set(
      nodes,
      [0, 1, 2, 3, 4, 5, 6, 7],
      [1, 0.01],
      new Array(8).fill(1e-3),
      [0, 0, 0, -1, 0, 0, 0, 0],
    );
    const f = new Float64Array(24);
    c.forces(
      Float64Array.from(nodes),
      new Float64Array(24),
      new Float64Array(24),
      f,
      new Float64Array(24),
    );
    expect(f[14]!).toBeGreaterThan(0);
  });

  it('stops a rigid body whose mass is its own on a wall', () => {
    const model: ExplicitModel = {
      nodes: new Float64Array([1, 0, 0]),
      shells: new Uint32Array(0),
      thickness: new Float64Array(0),
      shellMaterial: new Uint16Array(0),
      materials: [steel],
      rigidBodies: [{ nodes: [0], mass: 1, inertia: [1, 1, 1], velocity: [-1000, 0, 0] }],
      walls: [{ point: [0, 0, 0], normal: [1, 0, 0] }],
    };
    const T = 3e-3;
    const r = runExplicit(model, {
      ...explicitDefaults,
      endTime: T,
      frameEvery: T / 30,
      minStep: 1e-6,
    });
    const b = r.barriers[0]!;
    let impulse = 0;
    for (let k = 1; k < b.time.length; k++)
      impulse += (b.time[k]! - b.time[k - 1]!) * b.force[3 * k]!;
    // It came back at 1000 mm/s: the wall took 2 m v.
    expect(Math.abs(-impulse / 2000 - 1)).toBeLessThan(0.05);
    for (const fr of r.frames) expect(1 + fr.displacement[0]!).toBeGreaterThan(-0.1);
    expect(r.checks[0]!.pass, r.checks[0]!.detail).toBe(true);
  });

  it('keeps a light-turning rigid body stable when it lands on one end', () => {
    // Nodes (−10, 0, 1) and (10, 0, 0.001), mass 1, inertia 0.01: at the low end the body's
    // effective mass along z is 1e-4 (turning), far below its 0.5 share per node.
    const model: ExplicitModel = {
      nodes: new Float64Array([-10, 0, 1, 10, 0, 0.001]),
      shells: new Uint32Array(0),
      thickness: new Float64Array(0),
      shellMaterial: new Uint16Array(0),
      materials: [steel],
      rigidBodies: [{ nodes: [0, 1], mass: 1, inertia: [0.01, 0.01, 0.01], velocity: [0, 0, -1] }],
      walls: [{ point: [0, 0, 0], normal: [0, 0, 1] }],
    };
    const r = runExplicit(model, {
      ...explicitDefaults,
      endTime: 0.05,
      frameEvery: 0.005,
      minStep: 1e-5,
    });
    for (const e of r.energies) expect(e.kinetic).toBeLessThan(0.5 * 1.05);
    expect(r.checks[0]!.pass, r.checks[0]!.detail).toBe(true);
  });

  it('stops a light-turning body’s slip at the floor without giving it energy', () => {
    // A rod standing on the floor on its low node (0, 0, 0), its mass 1 at (0, 0, 10), inertia
    // 0.01, under gravity, sliding along x with μ = 0.3: at the low node the slip meets the
    // rod's turning, an effective mass of about 1e-4 along x. Friction may only take energy.
    const model: ExplicitModel = {
      nodes: new Float64Array([0, 0, 0, 0, 0, 20]),
      shells: new Uint32Array(0),
      thickness: new Float64Array(0),
      shellMaterial: new Uint16Array(0),
      materials: [steel],
      rigidBodies: [{ nodes: [0, 1], mass: 1, inertia: [0.01, 0.01, 0.01], velocity: [1, 0, 0] }],
      gravity: [0, 0, -9810],
      walls: [{ point: [0, 0, 0], normal: [0, 0, 1], friction: 0.3 }],
    };
    const r = runExplicit(model, {
      ...explicitDefaults,
      endTime: 2e-3,
      frameEvery: 1e-4,
      minStep: 1e-5,
    });
    for (const e of r.energies) {
      expect(e.contact).toBeGreaterThanOrEqual(-1e-9);
      expect(e.kinetic).toBeLessThan(0.5 + e.external + 1e-6);
    }
    expect(r.checks[0]!.pass, r.checks[0]!.detail).toBe(true);
  });

  it('shares a light-turning body’s friction among its contacts', () => {
    // The rod of the last test standing on four low nodes 0.1 µm apart: each contact alone
    // would stop the whole slip, together four times it.
    const nodes = [0, 0, 20];
    for (let j = 0; j < 4; j++) nodes.push(0, j * 1e-4, 0);
    const model: ExplicitModel = {
      nodes: new Float64Array(nodes),
      shells: new Uint32Array(0),
      thickness: new Float64Array(0),
      shellMaterial: new Uint16Array(0),
      materials: [steel],
      rigidBodies: [
        { nodes: [0, 1, 2, 3, 4], mass: 1, inertia: [0.01, 0.01, 0.01], velocity: [1, 0, 0] },
      ],
      gravity: [0, 0, -9810],
      walls: [{ point: [0, 0, 0], normal: [0, 0, 1], friction: 0.3 }],
    };
    const r = runExplicit(model, {
      ...explicitDefaults,
      endTime: 2e-3,
      frameEvery: 1e-4,
      minStep: 1e-5,
    });
    for (const e of r.energies) {
      expect(e.contact).toBeGreaterThanOrEqual(-1e-9);
      expect(e.kinetic).toBeLessThan(0.5 + e.external + 1e-6);
    }
    expect(r.checks[0]!.pass, r.checks[0]!.detail).toBe(true);
  });

  it('keeps the penalty finite on a body that cannot move along the wall’s normal', () => {
    // A clamped one-node body 1 µm into a z-normal wall: it is infinitely heavy along z.
    const model: ExplicitModel = {
      nodes: new Float64Array([0, 0, -0.001]),
      shells: new Uint32Array(0),
      thickness: new Float64Array(0),
      shellMaterial: new Uint16Array(0),
      materials: [steel],
      rigidBodies: [{ nodes: [0], mass: 1, inertia: [1, 1, 1], held: 63 }],
      walls: [{ point: [0, 0, 0], normal: [0, 0, 1] }],
    };
    const r = runExplicit(model, {
      ...explicitDefaults,
      endTime: 1e-3,
      frameEvery: 1e-4,
      minStep: 1e-5,
    });
    for (const e of r.energies) {
      expect(Number.isFinite(e.contact)).toBe(true);
      expect(Number.isFinite(e.kinetic)).toBe(true);
    }
    for (const q of r.barriers[0]!.force) expect(Number.isFinite(q)).toBe(true);
  });

  it('takes a rigid body’s segment corners as one mass in friction', () => {
    // A 1000 kg-scale plate body (one quad, rotation held) under a light plate body (mass 1,
    // rotation held) overlapping it by 0.5 mm, sliding along x at 1 and pressed into it.
    // Friction is the only x load: x kinetic energy may only fall.
    const lower = plate(10, 10, 1, 1, 2);
    const upper = plate(2, 2, 1, 1, 2);
    for (let k = 0; k < 4; k++) {
      upper.nodes[3 * k] += 4;
      upper.nodes[3 * k + 1] += 4;
      upper.nodes[3 * k + 2] = 1.5;
    }
    const model: ExplicitModel = {
      ...join(lower, upper),
      rigidBodies: [
        { nodes: [0, 1, 2, 3], mass: 1000, inertia: [1, 1, 1], held: 56 },
        { nodes: [4, 5, 6, 7], mass: 1, inertia: [1, 1, 1], held: 56, velocity: [1, 0, -100] },
      ],
      contact: { friction: 0.3 },
    };
    const T = 2e-4;
    const r = runExplicit(model, {
      ...explicitDefaults,
      endTime: T,
      frameEvery: T / 40,
      minStep: 1e-7,
      historyNodes: [0, 4],
    });
    // x momentum: 1000 vₓ + 1·uₓ = 1, so x KE = ½(1000 vₓ² + uₓ²) ≤ ½.
    const [lo, up] = r.history;
    for (let k = 0; k < lo!.time.length; k++) {
      const vl = lo!.velocity[3 * k]!;
      const vu = up!.velocity[3 * k]!;
      expect(0.5 * (1000 * vl * vl + vu * vu)).toBeLessThan(0.5 * (1 + 1e-6));
    }
    // Friction acted.
    expect(up!.velocity[3 * (up!.time.length - 1)]!).toBeLessThan(1 - 1e-3);
  });

  it('keeps many springs on one light node stable', () => {
    // A rigid 2 × 2 mm patch of 20 × 20 quads (mass 1) at 1000 mm/s onto the corner of one
    // deformable 10 × 10 quad (1e-3 added on each node), 2 mm thick, 0.001 mm apart, no
    // friction: some 400 springs push the corner's triangle. Together they must stay stable.
    const lower = plate(10, 10, 1, 1, 2);
    const upper = plate(2, 2, 20, 20, 2);
    const nu = upper.nodes.length / 3;
    for (let k = 0; k < nu; k++) upper.nodes[3 * k + 2] = 2.001;
    const model: ExplicitModel = {
      ...join(lower, upper),
      masses: [0, 1, 2, 3].map((node) => ({ node, mass: 1e-3 })),
      rigidBodies: [
        {
          nodes: Array.from({ length: nu }, (_, k) => 4 + k),
          mass: 1,
          inertia: [1, 1, 1],
          velocity: [0, 0, -1000],
        },
      ],
      contact: {},
    };
    const T = 5e-6;
    const r = runExplicit(model, {
      ...explicitDefaults,
      endTime: T,
      frameEvery: T / 25,
      minStep: 1e-8,
    });
    const k0 = r.energies[0]!.kinetic;
    for (const e of r.energies) expect(e.kinetic).toBeLessThan(k0 * 1.01);
    expect(r.checks[0]!.pass, r.checks[0]!.detail).toBe(true);
  });

  it('keeps very thin sheets apart with a low penalty', () => {
    // Two 10 × 10 steel quads 0.001 mm thick, 0.002 mm apart, the lower clamped, the upper at
    // −1000 mm/s, with penalty 0.01: the step shrinks with √p so the softer springs still stop it.
    const lower = plate(10, 10, 1, 1, 0.001);
    const upper = plate(10, 10, 1, 1, 0.001);
    for (let k = 0; k < 4; k++) upper.nodes[3 * k + 2] = 0.002;
    const model: ExplicitModel = {
      ...join(lower, upper),
      fixed: new Uint8Array([63, 63, 63, 63, 0, 0, 0, 0]),
      velocity: new Float64Array([
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -1000, 0, 0, -1000, 0, 0, -1000, 0, 0, -1000,
      ]),
      contact: { penalty: 0.01 },
    };
    const r = runExplicit(model, {
      ...explicitDefaults,
      endTime: 4e-5,
      frameEvery: 2e-6,
      historyNodes: [4],
    });
    const z = r.history[0]!.displacement;
    for (let k = 2; k < z.length; k += 3) expect(0.002 + z[k]!).toBeGreaterThan(0);
  });

  it('shortens the step for a sheet that gravity starts moving', () => {
    // Two rigid 10 × 10 quads 0.001 mm thick and 0.002 mm apart, the lower clamped, the upper at
    // rest under gravity (not turning) with a 1 ms step: its first step alone would carry it
    // through.
    const lower = plate(10, 10, 1, 1, 0.001);
    const upper = plate(10, 10, 1, 1, 0.001);
    for (let k = 0; k < 4; k++) upper.nodes[3 * k + 2] = 0.002;
    const model: ExplicitModel = {
      ...join(lower, upper),
      rigidBodies: [
        { nodes: [0, 1, 2, 3], mass: 1, inertia: [1, 1, 1], held: 63 },
        { nodes: [4, 5, 6, 7], mass: 1, inertia: [1, 1, 1], held: 56 },
      ],
      gravity: [0, 0, -9810],
      contact: {},
    };
    const r = runExplicit(model, {
      ...explicitDefaults,
      endTime: 2e-3,
      frameEvery: 1e-4,
      minStep: 1e-3,
      historyNodes: [4],
    });
    const z = r.history[0]!.displacement;
    for (let k = 2; k < z.length; k += 3) expect(0.002 + z[k]!).toBeGreaterThan(0);
  });

  it('drops an eroded shell’s nodes from shell contact', () => {
    // Quads at z = 0 and 1.5, 2 mm thick (overlapping): once the lower is erased its nodes are
    // bare particles 1.5 mm from the upper's midsurface, outside its 1 mm half thickness.
    const nodes = [
      0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 1.5, 10, 0, 1.5, 10, 10, 1.5, 0, 10, 1.5,
    ];
    const erased = new Uint8Array(2);
    const c = new ContactSet({
      nodeCount: 8,
      shells: Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7]),
      thickness: Float64Array.from([2, 2]),
      mass: new Float64Array(8).fill(1e-3),
      x0: Float64Array.from(nodes),
      bodyOf: new Int32Array(8).fill(-1),
      erased,
      contact: {},
      walls: [],
      poles: [],
      step: 1e-6,
    });
    const x = Float64Array.from(nodes);
    const f = new Float64Array(24);
    const z = () => new Float64Array(24);
    c.forces(x, z(), z(), f, z());
    expect(Math.abs(f[2]!)).toBeGreaterThan(0);
    erased[0] = 1;
    c.forces(x, z(), z(), f, z());
    for (const q of f) expect(q).toBe(0);
  });

  it('keeps very thin sheets from passing through each other', () => {
    // Two 10 × 10 quads 0.001 mm thick, 0.002 mm apart, the upper at −1000 mm/s onto the fixed
    // lower: the step shrinks so that no node crosses the contact band in one step.
    const a = plate(10, 10, 1, 1, 0.001);
    const b = plate(10, 10, 1, 1, 0.001);
    for (let k = 0; k < 4; k++) b.nodes[3 * k + 2] = 0.002;
    const model = join(a, b);
    model.contact = {};
    model.fixed = new Uint8Array(8);
    for (let k = 0; k < 4; k++) model.fixed[k] = 63;
    model.velocity = new Float64Array(24);
    for (let k = 4; k < 8; k++) model.velocity[3 * k + 2] = -1000;
    const r = runExplicit(model, { ...explicitDefaults, endTime: 4e-5, frameEvery: 1e-6 });
    for (const f of r.frames)
      for (let k = 4; k < 8; k++) expect(0.002 + f.displacement[3 * k + 2]!).toBeGreaterThan(0);
    // It bounces off with its energy: the springs keep their stiffness through the impact.
    const last = r.energies.at(-1)!;
    expect(last.kinetic / r.energies[0]!.kinetic).toBeGreaterThan(0.95);
    expect(r.checks[0]!.pass, r.checks[0]!.detail).toBe(true);
  });

  it('starts parts that overlap at a joint without contact forces when told to (VS8c)', () => {
    // Two 20 × 20 plates 2 mm thick with midsurfaces 1 mm apart (their halves overlap 1 mm),
    // at rest: the overlap pushes them apart unless the contact ignores what overlaps at the
    // start. A third plate coming down from 5 mm above still lands on the upper one.
    const overlap = (ignoreInitial: boolean) => {
      const a = plate(20, 20, 4, 4, 2);
      const b = plate(20, 20, 4, 4, 2);
      const c = plate(20, 20, 4, 4, 2);
      for (let k = 0; k < b.nodes.length / 3; k++) {
        b.nodes[3 * k] += 2.5;
        b.nodes[3 * k + 2] = 1;
        c.nodes[3 * k + 2] = 8;
      }
      const model = join(join(a, b), c);
      model.contact = { ignoreInitial };
      const nb = (a.nodes.length + b.nodes.length) / 3;
      const n = model.nodes.length / 3;
      model.velocity = new Float64Array(3 * n);
      for (let k = nb; k < n; k++) model.velocity[3 * k + 2] = -1000;
      const T = 1e-5;
      const r = runExplicit(model, { ...explicitDefaults, endTime: T, frameEvery: T / 10 });
      const last = r.frames.at(-1)!;
      const lower = Math.max(
        ...[...Array(nb).keys()].map((k) => Math.abs(last.displacement[3 * k + 2]!)),
      );
      const fell = Math.min(
        ...[...Array(n - nb).keys()].map((k) => -last.displacement[3 * (k + nb) + 2]!),
      );
      return { lower, fell };
    };
    const pushed = overlap(false);
    expect(pushed.lower).toBeGreaterThan(1e-3);
    const kept = overlap(true);
    expect(kept.lower).toBe(0);
    expect(kept.fell).toBeCloseTo(0.01, 4);
    // A plate 0.05 mm clear (midsurfaces 2.05 mm apart) coming down at 1000 mm/s still lands
    // on the lower one and pushes it down.
    const a = plate(20, 20, 4, 4, 2);
    const c = plate(20, 20, 4, 4, 2);
    for (let k = 0; k < c.nodes.length / 3; k++) c.nodes[3 * k + 2] = 2.05;
    const model = join(a, c);
    model.contact = { ignoreInitial: true };
    const na = a.nodes.length / 3;
    const n = model.nodes.length / 3;
    model.velocity = new Float64Array(3 * n);
    for (let k = na; k < n; k++) model.velocity[3 * k + 2] = -1000;
    const T = 1e-4;
    const r = runExplicit(model, { ...explicitDefaults, endTime: T, frameEvery: T / 40 });
    const last = r.frames.at(-1)!;
    let gap = Infinity;
    for (const f of r.frames)
      gap = Math.min(gap, 2.05 + f.displacement[3 * na + 2]! - f.displacement[2]!);
    expect(gap).toBeGreaterThan(1.8);
    expect(last.displacement[2]!).toBeLessThan(-0.01);
  });

  it('refuses contact settings it cannot use', () => {
    const settings = { ...explicitDefaults, endTime: 1e-5, frameEvery: 1e-5 };
    const bad = (f: (m: ExplicitModel) => void) => {
      const m = plate(10, 10, 1, 1, 1);
      f(m);
      return () => new ExplicitSolver(m, settings);
    };
    expect(bad((m) => (m.contact = { friction: -1 }))).toThrow(/friction/);
    expect(bad((m) => (m.contact = { penalty: 2 }))).toThrow(/penalty/);
    expect(bad((m) => (m.contact = { ignoreInitial: 1 as unknown as boolean }))).toThrow(
      /ignoreInitial/,
    );
    expect(bad((m) => (m.walls = [{ point: [0, 0, 0], normal: [0, 0, 0] }]))).toThrow(/wall/);
    expect(bad((m) => (m.poles = [{ point: [0, 0, 0], axis: [0, 0, 1], radius: 0 }]))).toThrow(
      /pole/,
    );
  });
});
