import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assembleStiffness,
  boxTetMesh,
  jacobianRatio,
  ElasticError,
  prepareElastic,
  readCalculixFrd,
  solveElastic,
  solveTransientThermal,
  thermalForce,
  writeCalculixModel,
  type ElasticConstraint,
  type ElasticInput,
} from './index';

const steel = { youngsModulus: 210_000, poissonsRatio: 0.3, density: 7.85e-9 };
const alpha = 1.2e-5;
const solver = { tolerance: 1e-12, maxIterations: 20_000 };
const hold = (faces: number[], d: [number | null, number | null, number | null]) =>
  ({ faces, edges: [], displacement: d }) satisfies ElasticConstraint;
// Symmetry planes x = 0, y = 0, z = 0 of a box: no rigid motion, free to expand.
const symmetry = [
  hold([0], [0, null, null]),
  hold([2], [null, 0, null]),
  hold([4], [null, null, 0]),
];
const uniform = (n: number, t: number) => new Float64Array(n).fill(t);

describe('thermal stress (VS11c, TS-2277, ST-636)', () => {
  const mesh = boxTetMesh({ size: [100, 10, 10], divisions: [10, 1, 1], type: 'tet10' });
  const n = mesh.nodes.length / 3;
  const base = (constraints: ElasticConstraint[], temperature: Float64Array): ElasticInput => ({
    mesh,
    material: steel,
    loads: [],
    constraints,
    thermal: { temperature, reference: 293, expansion: alpha },
    solver,
  });

  it('lets a free bar grow by α ΔT L with no stress', () => {
    const r = solveElastic(base(symmetry, uniform(n, 393)));
    expect(r.converged).toBe(true);
    for (let p = 0; p < n; p++) {
      for (let d = 0; d < 3; d++)
        expect(r.displacement[3 * p + d]!).toBeCloseTo(alpha * 100 * mesh.nodes[3 * p + d]!, 9);
      expect(r.vonMises[p]!).toBeLessThan(1e-6);
    }
    for (let d = 0; d < 3; d++) expect(Math.abs(r.appliedTotal[d]!)).toBeLessThan(1e-8);
  });

  it('gives −E α ΔT in a bar held at both ends, and −E α ΔT / (1 − 2ν) held all round', () => {
    const ends = solveElastic(base([...symmetry, hold([1], [0, null, null])], uniform(n, 393)));
    for (let p = 0; p < n; p++) {
      expect(ends.stress[6 * p]! / (-210_000 * alpha * 100)).toBeCloseTo(1, 6);
      expect(Math.abs(ends.stress[6 * p + 1]!)).toBeLessThan(1e-6);
    }
    // The held end pushes back (towards −x) with E α ΔT A.
    let rx = 0;
    for (let p = 0; p < n; p++) if (mesh.nodes[3 * p]! > 99.999) rx += ends.reaction[3 * p]!;
    expect(rx / (-210_000 * alpha * 100 * 100)).toBeCloseTo(1, 6);
    const all = solveElastic(
      base(
        [
          ...symmetry,
          hold([1], [0, null, null]),
          hold([3], [null, 0, null]),
          hold([5], [null, null, 0]),
        ],
        uniform(n, 393),
      ),
    );
    for (let p = 0; p < n; p++)
      for (let d = 0; d < 3; d++)
        expect(all.stress[6 * p + d]! / ((-210_000 * alpha * 100) / 0.4)).toBeCloseTo(1, 6);
  });

  it('lets a uniformly heated curved tet10 body expand freely: K (α ΔT x) = f', () => {
    // Bend the box smoothly, moving the mid-edge nodes off the straight edges too.
    const curved = boxTetMesh({ size: [100, 10, 10], divisions: [10, 2, 2], type: 'tet10' });
    const q = curved.nodes;
    for (let p = 0; p < q.length / 3; p++) {
      const [x, y, z] = [q[3 * p]!, q[3 * p + 1]!, q[3 * p + 2]!];
      q[3 * p + 1] = y + 1.5 * Math.sin((Math.PI * x) / 50) + 0.4 * Math.sin((Math.PI * z) / 10);
      q[3 * p + 2] = z + 0.6 * Math.cos((Math.PI * x) / 25) * (y / 10);
    }
    const m = curved.elements.length / 10;
    let worst = 1;
    for (let e = 0; e < m; e++) worst = Math.min(worst, jacobianRatio(curved, e));
    expect(worst).toBeLessThan(0.999); // really curved
    expect(worst).toBeGreaterThan(0.5);
    const nn = q.length / 3;
    const f = thermalForce(curved, steel, {
      temperature: uniform(nn, 393),
      reference: 293,
      expansion: alpha,
    });
    const u = new Float64Array(3 * nn).map((_, k) => alpha * 100 * q[k]!);
    const Ku = assembleStiffness(curved, steel).multiply(u);
    let diff = 0,
      scale = 0;
    for (let k = 0; k < 3 * nn; k++) {
      diff = Math.max(diff, Math.abs(Ku[k]! - f[k]!));
      scale = Math.max(scale, Math.abs(f[k]!));
    }
    expect(diff / scale).toBeLessThan(1e-12);
  });

  it('puts forces summing to 0 on the body', () => {
    const T = new Float64Array(n).map(
      (_, p) => 293 + 3 * mesh.nodes[3 * p]! - mesh.nodes[3 * p + 1]!,
    );
    const f = thermalForce(mesh, steel, { temperature: T, reference: 293, expansion: alpha });
    for (let d = 0; d < 3; d++) {
      let sum = 0,
        scale = 0;
      for (let p = 0; p < n; p++) {
        sum += f[3 * p + d]!;
        scale = Math.max(scale, Math.abs(f[3 * p + d]!));
      }
      expect(Math.abs(sum) / scale).toBeLessThan(1e-12);
    }
  });

  it('takes a transient heat result as its temperature', () => {
    const heat = solveTransientThermal({
      mesh,
      material: { conductivity: 50, density: 7.85e-9, specificHeat: 4.6e8 },
      conditions: [{ kind: 'temperature', faces: [0], edges: [], temperature: 493 }],
      initialTemperature: 293,
      time: { end: 300, step: 10, theta: 1 },
      output: { every: 30 },
      solver,
    });
    const T = heat.temperatures.at(-1)!;
    const r = solveElastic(base([...symmetry, hold([1], [0, null, null])], T));
    // Held at both ends, the bar's axial stress is −E α times the mean rise along it (1-D), the
    // mean rise from the stored heat: ΔT̄ = E / (ρ c V). After 300 s the field varies slowly along
    // the bar, so the 3-D effects of the gradient are small.
    const rise = heat.history.stored.at(-1)! / (7.85e-9 * 4.6e8 * 10_000);
    const mid = [...Array(n).keys()].filter((p) => Math.abs(mesh.nodes[3 * p]! - 50) < 1e-9);
    const mean = mid.reduce((s, p) => s + r.stress[6 * p]!, 0) / mid.length;
    expect(mean / (-210_000 * alpha * rise)).toBeGreaterThan(0.95);
    expect(mean / (-210_000 * alpha * rise)).toBeLessThan(1.05);
  });

  it('refuses a temperature field that does not fit', () => {
    const refusal = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        expect(e).toBeInstanceOf(ElasticError);
        return (e as ElasticError).problem;
      }
      throw new Error('not refused');
    };
    expect(refusal(() => solveElastic(base(symmetry, uniform(3, 300))))).toBe('material');
    expect(refusal(() => solveElastic(base(symmetry, uniform(n, Number.NaN))))).toBe('material');
    expect(
      refusal(() =>
        solveElastic({
          ...base(symmetry, uniform(n, 300)),
          thermal: { temperature: uniform(n, 300), reference: 293, expansion: -1 },
        }),
      ),
    ).toBe('material');
  });
});

const ccx = spawnSync('ccx', ['-v'], { encoding: 'utf8' });
const hasCcx = /Version \d/.test(`${ccx.stdout ?? ''}${ccx.stderr ?? ''}`);

describe('thermal stress on CalculiX (VS11c, TS-2277)', { timeout: 300_000 }, () => {
  it('writes *EXPANSION, the initial and the step temperatures, and refuses a modal one', () => {
    const mesh = boxTetMesh({ size: [10, 10, 10], divisions: [1, 1, 1], type: 'tet10' });
    const n = mesh.nodes.length / 3;
    const prepared = prepareElastic({ mesh, material: steel, loads: [], constraints: symmetry });
    const model = {
      nodes: mesh.nodes,
      parts: [
        { type: mesh.type, elements: mesh.elements, material: { ...steel, expansion: alpha } },
      ],
      prescribed: prepared.prescribed,
      force: prepared.force,
      thermal: { temperature: uniform(n, 393), reference: 293 },
    };
    const inp = writeCalculixModel(model);
    expect(inp).toContain('*EXPANSION, ZERO=293\n0.000012');
    expect(inp).toContain('*INITIAL CONDITIONS, TYPE=TEMPERATURE\nNALL, 293');
    expect(
      inp
        .split('*TEMPERATURE\n')[1]!
        .split('\n')
        .slice(0, n)
        .every((l) => l.endsWith(', 393')),
    ).toBe(true);
    expect(() => writeCalculixModel({ ...model, modes: 1 })).toThrow(RangeError);
    expect(() =>
      writeCalculixModel({ ...model, parts: [{ ...model.parts[0]!, material: steel }] }),
    ).toThrow(RangeError);
  });

  it.skipIf(!hasCcx)(
    'matches the browser solver on a bar with a gradient held at both ends',
    () => {
      const mesh = boxTetMesh({ size: [100, 10, 10], divisions: [10, 1, 1], type: 'tet10' });
      const n = mesh.nodes.length / 3;
      const T = new Float64Array(n).map(
        (_, p) => 293 + mesh.nodes[3 * p]! + 2 * mesh.nodes[3 * p + 2]!,
      );
      const constraints = [...symmetry, hold([1], [0, null, null])];
      const browser = solveElastic({
        mesh,
        material: steel,
        loads: [],
        constraints,
        thermal: { temperature: T, reference: 293, expansion: alpha },
        solver,
      });
      const prepared = prepareElastic({ mesh, material: steel, loads: [], constraints });
      const inp = writeCalculixModel({
        nodes: mesh.nodes,
        parts: [
          { type: mesh.type, elements: mesh.elements, material: { ...steel, expansion: alpha } },
        ],
        prescribed: prepared.prescribed,
        force: prepared.force,
        thermal: { temperature: T, reference: 293 },
      });
      const dir = mkdtempSync(join(tmpdir(), 'ccx-thermal-'));
      let frd: string;
      try {
        writeFileSync(join(dir, 'job.inp'), inp);
        const run = spawnSync('ccx', ['-i', 'job'], {
          cwd: dir,
          encoding: 'utf8',
          timeout: 300_000,
        });
        if (run.status !== 0) throw new Error(`ccx failed: ${run.stdout}${run.stderr}`);
        frd = readFileSync(join(dir, 'job.frd'), 'utf8');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      const host = readCalculixFrd(frd, n);
      let du = 0,
        umax = 0,
        ds = 0,
        smax = 0;
      for (let k = 0; k < 3 * n; k++) {
        du = Math.max(du, Math.abs(host.displacement[k]! - browser.displacement[k]!));
        umax = Math.max(umax, Math.abs(browser.displacement[k]!));
      }
      for (let k = 0; k < 6 * n; k++) {
        ds = Math.max(ds, Math.abs(host.stress[k]! - browser.stress[k]!));
        smax = Math.max(smax, Math.abs(browser.stress[k]!));
      }
      // CalculiX integrates the expansion from its own Gauss-point temperatures.
      expect(du / umax).toBeLessThan(1e-4);
      // CalculiX extrapolates stresses from its integration points: within 2 % of the largest.
      expect(ds / smax).toBeLessThan(0.02);
    },
  );
});
