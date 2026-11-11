import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bondedModalHostModel,
  bondedModalResultFromFrd,
  boxTetMesh,
  ElasticError,
  modalHostModel,
  modalResultFromFrd,
  readCalculixModes,
  shellAddedMasses,
  shellModalHostModel,
  shellModalResultFromFrd,
  solidAddedMasses,
  solveBondedModal,
  solveElastic,
  solveModal,
  solveShell,
  solveShellModal,
  writeCalculixModel,
  type AddedMass,
  type BondedModalInput,
  type ModalInput,
  type ShellMesh,
  type ShellModalInput,
} from './index';

/**
 * FX-CR1 (ST-267, docs/cad/car-design.md CR5a): added masses on a cantilever. A plate (shell) and
 * a bar (solid) clamped at x = 0 carry 0×, 1× and 10× their own mass on their tip. Checked: the
 * total mass, the gravity reaction (ρV + M) g, and the first bending frequency against the exact
 * Euler–Bernoulli cantilever with a tip mass, as the ratio to the bare one (so E I drops out).
 * TS-1553 the browser, TS-1554 the Host (CalculiX MASS elements).
 */
const steel = { youngsModulus: 210_000, poissonsRatio: 0.3, density: 7.85e-9 };
const solver = { tolerance: 1e-8, maxIterations: 20_000 };
const modal = { tolerance: 1e-6, maxIterations: 5000 };
const zero: [number, number, number] = [0, 0, 0];
const g: [number, number, number] = [0, 0, -9810];
const close = (a: number, b: number, relative: number) =>
  expect(Math.abs(a / b - 1), `${a} for ${b}`).toBeLessThan(relative);
const refusal = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ElasticError);
    return (e as ElasticError).problem;
  }
  throw new Error('not refused');
};

/**
 * βL of the first bending mode of a cantilever with a tip mass `ratio` × its own mass:
 * 1 + cos βL cosh βL + ratio · βL (cos βL sinh βL − sin βL cosh βL) = 0, by bisection on (0, 1.8752].
 */
function tipMassBeta(ratio: number): number {
  const f = (b: number) =>
    1 +
    Math.cos(b) * Math.cosh(b) +
    ratio * b * (Math.cos(b) * Math.sinh(b) - Math.sin(b) * Math.cosh(b));
  let lo = 1e-6,
    hi = 1.8752;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (f(lo) * f(mid) <= 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}
/** f(tip mass) / f(bare) of the exact cantilever: (βL / βL₀)². */
const exactRatio = (ratio: number) => (tipMassBeta(ratio) / tipMassBeta(0)) ** 2;

/**
 * A cantilever plate [0, L] × [0, W] at z = 0: shape face 0 the plate, face 1 its last strip of
 * triangles (x > L − L/nu); edge 0 the clamped end x = 0.
 */
function plate(nu: number, nv: number, L: number, W: number, t: number): ShellMesh {
  const nodes: number[] = [];
  for (let j = 0; j <= nv; j++)
    for (let i = 0; i <= nu; i++) nodes.push((L * i) / nu, (W * j) / nv, 0);
  const id = (i: number, j: number) => j * (nu + 1) + i;
  const tris: number[] = [];
  const faces: number[] = [];
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const [a, b, c, d] = [id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)];
      if ((i + j) % 2) tris.push(a, b, c, a, c, d);
      else tris.push(a, b, d, b, c, d);
      faces.push(i === nu - 1 ? 1 : 0, i === nu - 1 ? 1 : 0);
    }
  const chain = Array.from({ length: nv + 1 }, (_, j) => id(0, j));
  return {
    nodes: Float64Array.from(nodes),
    triangles: Uint32Array.from(tris),
    thickness: new Float64Array(tris.length / 3).fill(t),
    faces: Int32Array.from(faces),
    shapeFaces: 2,
    shapeEdges: 1,
    edges: { offsets: Uint32Array.from([0, chain.length]), nodes: Uint32Array.from(chain) },
  };
}

const L = 200,
  W = 10,
  T = 2;
const plateMesh = plate(80, 4, L, W, T);
const plateMass = steel.density * L * W * T;
const clamped = [{ faces: [], edges: [0], displacement: zero, rotation: zero }];
const tip = (ratio: number, m: number): AddedMass[] =>
  ratio ? [{ faces: [1], mass: ratio * m }] : [];
const shellModal = (ratio: number): ShellModalInput => ({
  mesh: plateMesh,
  material: steel,
  constraints: clamped,
  masses: tip(ratio, plateMass),
  modes: 1,
  solver: modal,
});

const bar = boxTetMesh({ size: [200, 20, 20], divisions: [20, 2, 2], type: 'tet10' });
const barMass = steel.density * 200 * 20 * 20;
const solidModal = (ratio: number): ModalInput => ({
  mesh: bar,
  material: steel,
  constraints: [{ faces: [0], edges: [], displacement: zero }],
  // Face 1 is the box's x = 200 end.
  masses: tip(ratio, barMass),
  modes: 2,
  solver: { tolerance: 1e-6, maxIterations: 4000 },
});

describe('FX-CR1: added masses in the browser (CR5a, TS-1553)', { timeout: 300_000 }, () => {
  it('spreads a mass over its faces by area, all of it', () => {
    const shell = shellAddedMasses(plateMesh, [{ faces: [1], mass: 2 }]);
    expect(shell.reduce((s, m) => s + m, 0)).toBeCloseTo(2, 12);
    // Only nodes of the tip strip (x ≥ L − L/nu) get any.
    shell.forEach(
      (m, p) => m && expect(plateMesh.nodes[3 * p]!).toBeGreaterThanOrEqual(L - L / 80 - 1e-9),
    );
    const solid = solidAddedMasses(bar, [{ faces: [1], mass: 3 }]);
    expect(solid.reduce((s, m) => s + m, 0)).toBeCloseTo(3, 12);
    solid.forEach((m, p) => m && expect(bar.nodes[3 * p]!).toBeCloseTo(200, 9));
  });

  it('refuses a mass ≤ 0, a face the mesh does not have and a face with no triangle', () => {
    expect(refusal(() => shellAddedMasses(plateMesh, [{ faces: [1], mass: 0 }]))).toBe('material');
    expect(refusal(() => shellAddedMasses(plateMesh, [{ faces: [2], mass: 1 }]))).toBe(
      'target-index',
    );
    expect(refusal(() => solidAddedMasses(bar, [{ faces: [1], mass: -1 }]))).toBe('material');
    expect(refusal(() => solidAddedMasses(bar, [{ faces: [6], mass: 1 }]))).toBe('target-index');
    const noTip = { ...plateMesh, faces: new Int32Array(plateMesh.faces.length) };
    expect(refusal(() => shellAddedMasses(noTip, [{ faces: [1], mass: 1 }]))).toBe('empty-target');
  });

  it('the gravity reaction carries the body and its added masses', () => {
    for (const ratio of [0, 1, 10]) {
      const r = solveShell({
        mesh: plateMesh,
        material: steel,
        constraints: clamped,
        masses: tip(ratio, plateMass),
        loads: [{ kind: 'gravity', acceleration: g }],
        solver,
      });
      close(r.reactionTotal[2], (1 + ratio) * plateMass * 9810, 1e-6);
      const s = solveElastic({
        mesh: bar,
        material: steel,
        constraints: [{ faces: [0], edges: [], displacement: zero }],
        masses: tip(ratio, barMass),
        loads: [{ kind: 'gravity', acceleration: g }],
        solver,
      });
      close(s.reactionTotal[2], (1 + ratio) * barMass * 9810, 1e-6);
    }
  });

  it('a heavier tip lowers the first frequency as the exact cantilever with a tip mass', () => {
    const shell = [0, 1, 10].map((ratio) => solveShellModal(shellModal(ratio)));
    const solid = [0, 1, 10].map((ratio) => solveModal(solidModal(ratio)));
    [0, 1, 10].forEach((ratio, k) => {
      close(shell[k]!.mass, (1 + ratio) * plateMass, 1e-9);
      close(solid[k]!.mass, (1 + ratio) * barMass, 1e-9);
      if (!ratio) return;
      // The tip strip's mass sits 1.25 mm short of the tip on average, the bar's on its end face.
      close(
        shell[k]!.modes[0]!.frequency / shell[0]!.modes[0]!.frequency,
        exactRatio(ratio),
        0.015,
      );
      close(solid[k]!.modes[0]!.frequency / solid[0]!.modes[0]!.frequency, exactRatio(ratio), 0.02);
    });
    // The first mode with a heavy tip carries nearly all of the mass in z (a single degree of freedom).
    const heavy = shell[2]!.modes[0]!.effectiveMass[2];
    expect(heavy).toBeGreaterThan(0.95);
  });
});

const ccx = spawnSync('ccx', ['-v'], { encoding: 'utf8' });
const hasCcx = /Version \d/.test(`${ccx.stdout ?? ''}${ccx.stderr ?? ''}`);
function runCcx(inp: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccx-mass-'));
  try {
    writeFileSync(join(dir, 'job.inp'), inp);
    const r = spawnSync('ccx', ['-i', 'job'], { cwd: dir, encoding: 'utf8', timeout: 300_000 });
    if (r.status !== 0) throw new Error(`ccx failed: ${r.stdout}${r.stderr}`);
    return readFileSync(join(dir, 'job.frd'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('FX-CR1 on the Host (CR5a, TS-1554)', { timeout: 300_000 }, () => {
  it('writes MASS elements in a modal model only, every node mass once', () => {
    const host = shellModalHostModel(shellModal(10));
    const text = writeCalculixModel(host.model);
    expect(text).toMatch(/\*ELEMENT, TYPE=MASS, ELSET=AM1/);
    const values = [...text.matchAll(/\*MASS, ELSET=AM\d+\n(\S+)/g)].map((m) => Number(m[1]));
    expect(values.length).toBeGreaterThan(0);
    const total = host.model.masses!.reduce((s, [, m]) => s + m, 0);
    close(total, 10 * plateMass, 1e-12);
    // The static model of the same study has its weight in the forces, no MASS element.
    const statics = writeCalculixModel({
      ...host.model,
      modes: undefined,
      masses: host.model.masses,
    });
    expect(statics).not.toMatch(/TYPE=MASS/);
  });

  it.skipIf(!hasCcx)('the shell, the solid and bonded parts as the browser', () => {
    for (const ratio of [0, 10]) {
      const input = shellModal(ratio);
      const host = shellModalHostModel(input);
      const frd = readCalculixModes(
        runCcx(writeCalculixModel(host.model)),
        host.model.nodes.length / 3,
        1,
      );
      const r = shellModalResultFromFrd(input, host, frd);
      const mine = solveShellModal(input);
      close(r.mass, mine.mass, 1e-9);
      close(r.modes[0]!.frequency, mine.modes[0]!.frequency, 0.04);
      close(r.modes[0]!.effectiveMass[2], mine.modes[0]!.effectiveMass[2], 0.03);

      const sInput = solidModal(ratio);
      const sHost = modalHostModel(sInput);
      const sFrd = readCalculixModes(
        runCcx(writeCalculixModel(sHost.model)),
        sHost.model.nodes.length / 3,
        2,
      );
      const s = modalResultFromFrd(sInput, sHost, sFrd);
      const sMine = solveModal(sInput);
      close(s.mass, sMine.mass, 1e-9);
      close(s.modes[0]!.frequency, sMine.modes[0]!.frequency, 2e-3);
    }
    // The bar as two bonded halves, the tip mass on the far one.
    const half = boxTetMesh({ size: [100, 20, 20], divisions: [10, 2, 2], type: 'tet10' });
    const far = { ...half, nodes: half.nodes.map((x, i) => (i % 3 === 0 ? x + 100 : x)) };
    const bonded: BondedModalInput = {
      parts: [
        {
          kind: 'solid',
          mesh: half,
          material: steel,
          loads: [],
          constraints: [{ faces: [0], edges: [], displacement: zero }],
        },
        {
          kind: 'solid',
          mesh: far,
          material: steel,
          loads: [],
          constraints: [],
          masses: tip(10, barMass),
        },
      ],
      bonds: [
        {
          follower: { part: 1, faces: [0], edges: [] },
          on: { part: 0, faces: [1], edges: [] },
          tolerance: 0.01,
        },
      ],
      modes: 1,
      solver: { tolerance: 1e-6, maxIterations: 4000 },
    };
    const bHost = bondedModalHostModel(bonded);
    const b = bondedModalResultFromFrd(
      bonded,
      bHost,
      readCalculixModes(runCcx(writeCalculixModel(bHost.model)), bHost.model.nodes.length / 3, 1),
    );
    const bMine = solveBondedModal(bonded);
    close(b.mass, 11 * barMass, 1e-9);
    close(bMine.mass, 11 * barMass, 1e-9);
    close(b.partMasses[1]!, bMine.partMasses[1]!, 1e-9);
    close(b.modes[0]!.frequency, bMine.modes[0]!.frequency, 5e-3);
    close(
      bMine.modes[0]!.frequency / solveModal(solidModal(0)).modes[0]!.frequency,
      exactRatio(10),
      0.02,
    );
  });
});
