import { describe, expect, it } from 'vitest';
import {
  ExplicitSolver,
  explicitDefaults,
  flowStress,
  planeStressReturn,
  quadPlate,
  type ExplicitModel,
  type ExplicitPlasticity,
} from './explicit';

/** TS-2215 (ST-612, VS5b): plasticity, strain rate, erosion and mass scaling of the shells. */
const E = 210_000;
const nu = 0.3;
const mild: ExplicitPlasticity = { strain: [0, 0.1], stress: [250, 450] };
const steel = (plastic: ExplicitPlasticity = mild) => ({
  density: 7.85e-9,
  youngsModulus: E,
  poissonRatio: nu,
  plastic,
});
const seq = (s: [number, number, number]) =>
  Math.sqrt(s[0] ** 2 + s[1] ** 2 - s[0] * s[1] + 3 * s[2] ** 2);

describe('plane-stress J2 return (VS5b)', () => {
  const flat: ExplicitPlasticity = { strain: [0], stress: [250] };
  it('brings uniaxial, equibiaxial and shear trials onto the von Mises surface', () => {
    for (const trial of [
      [600, 0, 0],
      [500, 500, 0],
      [0, 0, 400],
      [300, -200, 150],
    ] as [number, number, number][]) {
      const r = planeStressReturn(trial, E, nu, flat, 0);
      expect(seq(r.stress) / 250).toBeCloseTo(1, 9);
      expect(r.dEps).toBeGreaterThan(0);
    }
    // Pure shear yields at σy/√3.
    expect(planeStressReturn([0, 0, 400], E, nu, flat, 0).stress[2]).toBeCloseTo(
      250 / Math.sqrt(3),
      6,
    );
    // Inside the surface: the trial itself.
    expect(planeStressReturn([100, 50, 20], E, nu, flat, 0)).toEqual({
      stress: [100, 50, 20],
      dEps: 0,
    });
  });

  it('hardens along the flow curve and scales it with the strain rate', () => {
    const r = planeStressReturn([700, 0, 0], E, nu, mild, 0.01);
    expect(seq(r.stress) / flowStress(mild, 0.01 + r.dEps)).toBeCloseTo(1, 9);
    const fast = planeStressReturn([1400, 0, 0], E, nu, mild, 0.01, 2);
    expect(seq(fast.stress) / (2 * flowStress(mild, 0.01 + fast.dEps))).toBeCloseTo(1, 9);
    expect(flowStress(mild, 0.05)).toBeCloseTo(350, 9);
    expect(flowStress(mild, 0.5)).toBe(450);
  });
});

/** One 10 × 10 × 1 mm shell pulled along x at V (mm/s): the left edge held in x, the right edge moving. */
function pull(V: number, plastic: ExplicitPlasticity, strain: number) {
  const { nodes, shells } = quadPlate(10, 10, 1, 1);
  const model: ExplicitModel = {
    nodes,
    shells,
    thickness: new Float64Array([1]),
    shellMaterial: new Uint16Array(1),
    materials: [steel(plastic)],
    // Membrane only: z and the rotations held; node 0 also in y.
    fixed: new Uint8Array([63, 61, 61, 61]),
    velocity: new Float64Array([0, 0, 0, V, 0, 0, 0, 0, 0, V, 0, 0]),
  };
  const solver = new ExplicitSolver(model, {
    ...explicitDefaults,
    endTime: (strain * 10) / V,
    frameEvery: (strain * 10) / V / 10,
  });
  while (!solver.done) solver.advance(1000);
  return { solver, result: solver.result() };
}

describe('plastic shells (VS5b)', () => {
  it('follows the flow curve in a slow pull', () => {
    const { result } = pull(100, mild, 0.05);
    const last = result.frames.at(-1)!;
    const eps = last.plasticStrain[0]!;
    // Small strain: εp ≈ ε − σ/E at 5 % (true strain ln 1.05).
    const sigma = flowStress(mild, eps);
    expect(Math.abs(eps - (Math.log(1.05) - sigma / E))).toBeLessThan(0.002);
    expect(result.checks.find((c) => c.name === 'energy-balance')!.pass).toBe(true);
  });

  it('carries the flow stress as the pulling force', () => {
    const { solver, result } = pull(100, mild, 0.05);
    const eps = result.frames.at(-1)!.plasticStrain[0]!;
    // The width has narrowed (plastic flow keeps the volume; the thickness is not updated, so
    // the width takes it): the force is σ times the current width × thickness.
    const u = result.frames.at(-1)!.displacement;
    const width = 10 + u[3 * 2 + 1]! - u[1]!;
    const force = Math.abs(solver.reaction([1, 3])[0]);
    expect(force / (flowStress(mild, eps) * width * 1)).toBeCloseTo(1, 1);
  });

  it('raises the flow stress with the strain rate (Cowper–Symonds)', () => {
    const cs: ExplicitPlasticity = { ...mild, cowperSymonds: { C: 40.4, p: 5 } };
    // 100/s: σ/σ₀ = 1 + (100/40.4)^(1/5).
    const fast = pull(1000, cs, 0.03);
    const slow = pull(1000, mild, 0.03);
    const ratio =
      Math.abs(fast.solver.reaction([1, 3])[0]) / Math.abs(slow.solver.reaction([1, 3])[0]);
    expect(ratio / (1 + (100 / 40.4) ** 0.2)).toBeCloseTo(1, 1);
  });

  it('strengthens bending with its own strain rate', () => {
    // One held shell bent by opposite edge rotations (±1000 rad/s about y): the membrane rates
    // are 0, the surface rate about 100/s; Cowper–Symonds holds back the plastic strain.
    const bend = (plastic: ExplicitPlasticity) => {
      const { nodes, shells } = quadPlate(10, 10, 1, 1);
      const model: ExplicitModel = {
        nodes,
        shells,
        thickness: new Float64Array([1]),
        shellMaterial: new Uint16Array(1),
        materials: [steel(plastic)],
        fixed: new Uint8Array(4).fill(63),
        rotation: new Float64Array([0, -1000, 0, 0, 1000, 0, 0, -1000, 0, 0, 1000, 0]),
      };
      const s = new ExplicitSolver(model, { ...explicitDefaults, endTime: 5e-5, frameEvery: 5e-5 });
      while (!s.done) s.advance(1000);
      return s.result().frames.at(-1)!.plasticStrain[0]!;
    };
    const slow = bend(mild);
    const fast = bend({ ...mild, cowperSymonds: { C: 40.4, p: 5 } });
    expect(slow).toBeGreaterThan(0);
    expect(fast).toBeLessThan(0.9 * slow);
  });

  it('counts the work of prescribed velocities from both ends of each step', () => {
    // One unstressed elastic shell, every component held, its sides pulled apart at ±100 mm/s:
    // the strain energy and the work of the holders agree after one step and after ten.
    for (const steps of [1, 10]) {
      const { nodes, shells } = quadPlate(10, 10, 1, 1);
      const model: ExplicitModel = {
        nodes,
        shells,
        thickness: new Float64Array([1]),
        shellMaterial: new Uint16Array(1),
        materials: [{ density: 7.85e-9, youngsModulus: E, poissonRatio: nu }],
        fixed: new Uint8Array(4).fill(63),
        velocity: new Float64Array([-100, 0, 0, 100, 0, 0, -100, 0, 0, 100, 0, 0]),
      };
      const step = new ExplicitSolver(model, { ...explicitDefaults, endTime: 1, frameEvery: 1 })
        .step;
      const s = new ExplicitSolver(model, {
        ...explicitDefaults,
        endTime: steps * step,
        frameEvery: steps * step,
      });
      s.advance(steps);
      const r = s.result();
      const last = r.energies.at(-1)!;
      expect(last.internal).toBeGreaterThan(0);
      expect(last.external / last.internal).toBeCloseTo(1, 6);
      expect(r.checks[0]!.pass, r.checks[0]!.detail).toBe(true);
    }
  });

  it('balances the work on the step that erases a shell', () => {
    // One held shell pulled apart at ±10 000 mm/s, perfectly plastic at 250 MPa, failing at 2 %:
    // the holders' work and the shell's agree through its erasure.
    for (const failureStrain of [0.02, undefined]) {
      const { nodes, shells } = quadPlate(10, 10, 1, 1);
      const model: ExplicitModel = {
        nodes,
        shells,
        thickness: new Float64Array([1]),
        shellMaterial: new Uint16Array(1),
        materials: [steel({ strain: [0], stress: [250], failureStrain })],
        fixed: new Uint8Array(4).fill(63),
        velocity: new Float64Array([-1e4, 0, 0, 1e4, 0, 0, -1e4, 0, 0, 1e4, 0, 0]),
      };
      const s = new ExplicitSolver(model, { ...explicitDefaults, endTime: 1e-5, frameEvery: 1e-6 });
      while (!s.done) s.advance(1000);
      const r = s.result();
      expect(r.frames.at(-1)!.erased[0]).toBe(failureStrain ? 1 : 0);
      expect(r.checks[0]!.pass, r.checks[0]!.detail).toBe(true);
    }
  });

  it('erases a shell past its failure strain', () => {
    const { solver, result } = pull(100, { ...mild, failureStrain: 0.02 }, 0.05);
    expect(result.frames.at(-1)!.erased[0]).toBe(1);
    expect(result.frames[1]!.erased[0]).toBe(0);
    expect(solver.reaction([1, 3])[0]).toBe(0);
  });
});

describe('mass scaling (VS5b)', () => {
  it('adds mass to the small shells to hold the smallest step, and reports its share', () => {
    const { nodes, shells } = quadPlate(100, 10, 10, 1);
    // The first column of elements 0.5 mm wide instead of 10.
    for (const k of [1, 12]) nodes[3 * k] = 0.5;
    const model: ExplicitModel = {
      nodes,
      shells,
      thickness: new Float64Array(10).fill(1),
      shellMaterial: new Uint16Array(10),
      materials: [steel()],
    };
    const settings = { ...explicitDefaults, endTime: 1e-5, frameEvery: 1e-5 };
    const plain = new ExplicitSolver(model, settings);
    const wave = Math.sqrt(E / (7.85e-9 * (1 - nu * nu)));
    expect(plain.step).toBeCloseTo((0.9 * 0.5) / wave, 12);
    const target = (0.9 * 9.5) / wave;
    const scaled = new ExplicitSolver(model, { ...settings, minStep: target });
    expect(scaled.step).toBe(target);
    // The narrow column: mass ρ·0.5·10·1, scaled by (9.5/0.5)² − 1.
    const added = 7.85e-9 * 5 * ((9.5 / 0.5) ** 2 - 1);
    expect(scaled.addedMass / added).toBeCloseTo(1, 9);
    scaled.advance(1e6);
    const check = scaled.result().checks.find((c) => c.name === 'mass-scaling')!;
    // 360 × the narrow column's mass on a 1000 mm³ plate: far above 5 %.
    expect(check.pass).toBe(false);
    expect(scaled.result().addedMassShare).toBeCloseTo(added / (added + 7.85e-9 * 1000), 9);
  });
});
