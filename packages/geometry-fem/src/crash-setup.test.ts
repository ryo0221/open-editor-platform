import { describe, expect, it } from 'vitest';
import { crashMeasures, crashSetup, kmhToMmPerS } from './crash-setup';
import {
  ExplicitSolver,
  explicitDefaults,
  type ExplicitModel,
  type ExplicitResult,
} from './explicit';
import { f97SquareTube } from './explicit-tube';

/**
 * TS-2221 (ST-618, VS7b): crash set-ups (wall, pole, gravity) and the measures of a run, on a
 * sled: two square steel rails along x (F97's tube, coarse) whose rear rings are one rigid body
 * carrying the sled's mass.
 */
function sled(mass: number): { model: ExplicitModel; rear: number } {
  const one = f97SquareTube({ perSide: 6, length: 180 }).model;
  const n1 = one.nodes.length / 3;
  const s1 = one.shells.length / 4;
  const nodes = new Float64Array(6 * n1);
  for (const [r, y0] of [
    [0, -300],
    [1, 300],
  ] as const)
    for (let i = 0; i < n1; i++) {
      const [x, y, z] = [0, 1, 2].map((q) => one.nodes[3 * i + q]!);
      // (x, y, z) → (z, x, y): the tube's axis along x, its dented top at the front.
      nodes.set([z!, x! + y0, y! + 300], 3 * (r * n1 + i));
    }
  const shells = new Uint32Array(8 * s1);
  shells.set(one.shells);
  shells.set(
    one.shells.map((i) => i + n1),
    4 * s1,
  );
  const shellPart = new Uint16Array(2 * s1).fill(1, s1);
  const rearNodes: number[] = [];
  for (let i = 0; i < 2 * n1; i++) if (nodes[3 * i]! === 0) rearNodes.push(i);
  return {
    rear: rearNodes[0]!,
    model: {
      nodes,
      shells,
      thickness: new Float64Array(2 * s1).fill(1.5),
      shellMaterial: new Uint16Array(2 * s1),
      shellPart,
      materials: one.materials,
      rigidBodies: [{ nodes: rearNodes, mass }],
    },
  };
}

describe('crash set-ups and measures (VS7b)', () => {
  it('stops a sled on the wall: the impulse is the momentum, the rails take the energy', () => {
    const speed = 56 * kmhToMmPerS;
    const { model, rear } = sled(0.03);
    const setup = crashSetup(model, { barrier: { kind: 'wall' }, speed });
    expect(setup.direction).toEqual([1, 0, 0]);
    expect(setup.model.walls![setup.barrier.index]!.point[0]).toBeCloseTo(181.75, 9);
    // No self contact (the folds may pass through each other): the wall is what is measured.
    const T = 0.04;
    const s = new ExplicitSolver(setup.model, {
      ...explicitDefaults,
      thicknessPoints: 3,
      hourglass: 0.03,
      endTime: T,
      frameEvery: T / 10,
      historyNodes: [rear],
    });
    while (!s.done) s.advance(10_000);
    const r = s.result();
    // The energy balances; the hourglass share of these coarse rails (6 shells a side, F97 needs
    // 20 for its 8 %) is only held under 15 %.
    for (const c of r.checks)
      if (c.name !== 'hourglass-energy') expect(c.pass, c.detail).toBe(true);
    const end = r.energies.at(-1)!;
    expect(end.hourglass / end.internal).toBeLessThan(0.15);
    const m = crashMeasures(r, {
      accelerometer: rear,
      direction: setup.direction,
      barrier: setup.barrier,
      intrusions: [{ name: 'rail', p: rear, q: 0, axis: [1, 0, 0] }],
    });
    // The mass: the body's and the rails' (7.85e-9 t/mm³ × the shells' volume).
    const steel = 7.85e-9 * 4 * 50 * 1.5 * 180 * 2;
    const momentum = (0.03 + steel) * (speed / 1000);
    const h = r.history[0]!;
    const last = h.velocity[3 * (h.time.length - 1)]! / 1000;
    const lost = (0.03 + steel) * (speed / 1000 - last);
    expect(m.barrierImpulse / 1000 / lost).toBeCloseTo(1, 2);
    // The velocity from the filtered deceleration ends near the body's.
    expect(Math.abs(m.velocity.at(-1)! - last)).toBeLessThan(0.05 * (speed / 1000));
    expect(m.barrierImpulse / 1000).toBeLessThan(2.1 * momentum);
    expect(m.crush.max).toBeGreaterThan(20);
    expect(m.crush.max).toBeLessThan(180);
    expect(m.peakG.cfc60).toBeGreaterThan(10);
    expect(m.peakG.cfc180).toBeGreaterThanOrEqual(m.peakG.cfc60 * 0.99);
    // The two rails alike, sharing the energy.
    expect(m.parts.length).toBe(2);
    expect(m.parts[0]!.share + m.parts[1]!.share).toBeCloseTo(1, 9);
    expect(Math.abs(m.parts[0]!.share - 0.5)).toBeLessThan(0.1);
    expect(m.intrusions[0]!.frames.length).toBe(r.frames.length);
    // The sled stops within a few ms and springs back: the occupant then flies 65 mm free and
    // slows over 235 mm from about 16 m/s relative, v²/(2·0.235 m) ≈ 57 g.
    expect(m.olc).not.toBeNull();
    expect(m.olc!.olcG).toBeGreaterThan(40);
    expect(m.olc!.olcG).toBeLessThan(75);
    if (process.env.VS7B_PRINT)
      console.log(
        JSON.stringify({
          impulse: m.barrierImpulse / 1000,
          lost,
          momentum,
          crush: m.crush,
          peakG: m.peakG,
          olc: m.olc,
          parts: m.parts,
          end: m.velocity.at(-1),
          hg: end.hourglass / end.internal,
          steps: r.steps,
        }),
      );
  }, 180_000);

  it('places a pole on the struck side, at the angle, clear of the shell faces by the gap', () => {
    const { model } = sled(0.03);
    const speed = 32 * kmhToMmPerS;
    const setup = crashSetup(model, {
      barrier: { kind: 'pole', side: 'right', at: [90, 300] },
      speed,
    });
    const a = (75 * Math.PI) / 180;
    expect(setup.direction[0]).toBeCloseTo(Math.cos(a), 12);
    expect(setup.direction[1]).toBeCloseTo(-Math.sin(a), 12);
    const pole = setup.model.poles![setup.barrier.index]!;
    expect(pole.radius).toBe(127);
    expect(pole.axis).toEqual([0, 0, 1]);
    const n = model.nodes.length / 3;
    let near = Infinity;
    for (let i = 0; i < n; i++)
      near = Math.min(
        near,
        Math.hypot(model.nodes[3 * i]! - pole.point[0], model.nodes[3 * i + 1]! - pole.point[1]),
      );
    expect(near - 127).toBeCloseTo(1.75, 6);
    // On the right (−y) of the struck rail, ahead along the travel.
    expect(pole.point[1]).toBeLessThan(-325);
    const v = setup.model.velocity!;
    expect(v[0]).toBeCloseTo(speed * Math.cos(a), 6);
    expect(setup.model.rigidBodies![0]!.velocity![1]).toBeCloseTo(-speed * Math.sin(a), 6);
  });

  it('adds gravity with the ground under the lowest node, and refuses what is not a crash', () => {
    const { model } = sled(0.03);
    const setup = crashSetup(model, { barrier: { kind: 'wall' }, speed: 1000, gravity: true });
    expect(setup.model.gravity).toEqual([0, 0, -9806.65]);
    const ground = setup.model.walls!.at(-1)!;
    expect(ground.normal).toEqual([0, 0, 1]);
    expect(ground.point[2]).toBeCloseTo(275 - 0.75 - 1, 9);
    expect(setup.barrier.index).toBe(0);
    // Without the option, gravity the model came with is taken away (no ground to stand on).
    const falling = { ...model, gravity: [0, 0, -1] as [number, number, number] };
    const off = crashSetup(falling, { barrier: { kind: 'wall' }, speed: 1000 });
    expect(off.model.gravity).toBeUndefined();
    expect(off.model.walls).toHaveLength(1);
    const held = { ...model, fixed: new Uint8Array(model.nodes.length / 3).fill(1) };
    expect(() => crashSetup(held, { barrier: { kind: 'wall' }, speed: 1 })).toThrow(/held/);
    expect(() => crashSetup(model, { barrier: { kind: 'wall' }, speed: 0 })).toThrow(/speed/);
    expect(() =>
      crashSetup(model, { barrier: { kind: 'pole', side: 'left', at: [5000, 0] }, speed: 1 }),
    ).toThrow(/no node/);
  });

  it('stops a pole at the first node it would touch, however close to the line', () => {
    // Two nodes just inside the pole's radius either side of its line and one far behind: the
    // pole stops ahead of the near pair (ρ = 500 + 1 + 0.5 half thickness), not behind the far one.
    const model: ExplicitModel = {
      nodes: new Float64Array([-499.9999, 0, 0, 499.9999, 0, 0, 0, -1050, 0]),
      shells: new Uint32Array([0, 1, 2, 2]),
      thickness: new Float64Array([1]),
      shellMaterial: new Uint16Array(1),
      materials: [{ density: 7.85e-9, youngsModulus: 210_000, poissonRatio: 0.3 }],
    };
    const setup = crashSetup(model, {
      barrier: { kind: 'pole', side: 'left', at: [0, 0], diameter: 1000, angleDeg: 90 },
      speed: 1,
    });
    const pole = setup.model.poles![0]!;
    expect(pole.point[0]).toBeCloseTo(0, 9);
    expect(pole.point[1]).toBeCloseTo(Math.sqrt(501.5 ** 2 - 499.9999 ** 2), 6);
  });

  it('measures the crush from the contact time, between sparse samples', () => {
    // History at 0, 1, 2 ms with the forward travel 0, 7.5, 10 mm; the wall first pushes at
    // 1 ms: 2.5 mm of crush, not the free travel before it.
    const time = new Float64Array([0, 0.001, 0.002]);
    const result = {
      history: [
        {
          node: 0,
          time,
          displacement: new Float64Array([0, 0, 0, 7.5, 0, 0, 10, 0, 0]),
          velocity: new Float64Array([7500, 0, 0, 5000, 0, 0, 0, 0, 0]),
        },
      ],
      barriers: [
        {
          kind: 'wall',
          index: 0,
          time,
          force: new Float64Array([0, 0, 0, 1000, 0, 0, 2000, 0, 0]),
        },
      ],
      frames: [],
      energies: [],
    } as unknown as ExplicitResult;
    const m = crashMeasures(result, {
      accelerometer: 0,
      direction: [1, 0, 0],
      barrier: { kind: 'wall', index: 0 },
    });
    expect(m.crush.max).toBeCloseTo(2.5, 12);
    expect(m.crush.end).toBeCloseTo(2.5, 12);
  });
});
