import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  boxTetMesh,
  calculixTetFace,
  FrdError,
  localFaces,
  readCalculixTemperatures,
  solveTransientThermal,
  transientCalculixModel,
  writeCalculixHeat,
  type CalculixHeatModel,
  type TransientInput,
} from './index';

const steel = { conductivity: 50, density: 7.85e-9, specificHeat: 4.6e8 };
const solver = { tolerance: 1e-12, maxIterations: 20_000 };

describe('transient heat transfer on CalculiX (VS11d-3, TS-2282, ST-637)', () => {
  it('labels each local face as CalculiX numbers the tetrahedron faces', () => {
    // C3D4/C3D10: 1: 1-2-3, 2: 1-4-2, 3: 2-4-3, 4: 3-4-1 (corners from 1).
    const calculix = [
      [1, 2, 3],
      [1, 4, 2],
      [2, 4, 3],
      [3, 4, 1],
    ];
    localFaces.forEach((corners, lf) => {
      const label = calculixTetFace[lf]!;
      expect([...corners].map((c) => c + 1).sort()).toEqual([...calculix[label - 1]!].sort());
    });
  });

  it('writes the material, amplitudes, start, holds and face conditions, and refuses the rest', () => {
    const mesh = boxTetMesh({ size: [10, 10, 10], divisions: [1, 1, 1], type: 'tet10' });
    const n = mesh.nodes.length / 3;
    const model: CalculixHeatModel = {
      nodes: mesh.nodes,
      type: 'tet10',
      elements: mesh.elements,
      material: steel,
      initialTemperature: new Float64Array(n).fill(300),
      time: { end: 25, step: 10 },
      amplitudes: [{ times: [0, 10], factors: [0.5, 1] }],
      holds: [{ nodes: [0, 1], temperature: 600, amplitude: 0 }],
      faces: [
        { kind: 'flux', element: 0, face: 0, flux: 2 },
        { kind: 'film', element: 0, face: 1, coefficient: 0.01, ambient: 290, amplitude: 0 },
        { kind: 'radiation', element: 0, face: 2, emissivity: 0.8, ambient: 280 },
      ],
    };
    const inp = writeCalculixHeat(model);
    expect(inp).toContain('*CONDUCTIVITY\n50\n*DENSITY\n7.85e-9\n*SPECIFIC HEAT\n460000000');
    expect(inp).toContain('STEFAN BOLTZMANN=5.670374419e-11');
    expect(inp).toContain('*AMPLITUDE, NAME=A1\n0, 0.5, 10, 1');
    expect(inp).toContain('*STEP, INC=13\n*HEAT TRANSFER, DIRECT\n10, 25');
    expect(inp).toContain('*BOUNDARY, AMPLITUDE=A1\n1, 11, 11, 600\n2, 11, 11, 600');
    expect(inp).toContain('*DFLUX\n1, S3, 2');
    expect(inp).toContain('*FILM, FILM AMPLITUDE=A1\n1, F4, 290, 0.01');
    expect(inp).toContain('*RADIATE\n1, R2, 280, 0.8');
    expect(inp).toContain('*NODE FILE, FREQUENCY=1\nNT\n*END STEP');
    expect(() => writeCalculixHeat({ ...model, time: { end: 0, step: 1 } })).toThrow(RangeError);
    expect(() => writeCalculixHeat({ ...model, initialTemperature: [300] })).toThrow(RangeError);
    expect(() =>
      writeCalculixHeat({ ...model, holds: [{ nodes: [0], temperature: 600, amplitude: 3 }] }),
    ).toThrow(RangeError);
    expect(() =>
      writeCalculixHeat({ ...model, faces: [{ kind: 'flux', element: 9, face: 0, flux: 1 }] }),
    ).toThrow(RangeError);
    expect(() =>
      writeCalculixHeat({
        ...model,
        faces: [{ kind: 'radiation', element: 0, face: 0, emissivity: 1.5, ambient: 0 }],
      }),
    ).toThrow(RangeError);
  });

  it('reads each step’s temperatures and refuses a result without them or out of order', () => {
    const head = (t: string) => [
      `  100CL  101${t.padStart(12)}           2                     1    1           1`,
      ' -4  NDTEMP      1    1',
      ' -5  T           1    1    0    0',
    ];
    const geometry = [
      '    2C                             2                                     1',
      ' -1         1 0.00000E+00 0.00000E+00 0.00000E+00',
      ' -1         2 1.00000E+00 0.00000E+00 0.00000E+00',
      ' -3',
    ];
    const block = (t: string, a: number, b: number) => [
      ...head(t),
      ` -1         1${a.toExponential(5).padStart(12)}`,
      ` -1         2${b.toExponential(5).padStart(12)}`,
      ' -3',
    ];
    const frd = (...blocks: string[][]) => [...geometry, ...blocks.flat(), '9999'].join('\n');
    const r = readCalculixTemperatures(
      frd(block('10.00000000', 300, 310), block('20.00000000', 305, 320)),
      2,
    );
    expect(r.times).toEqual([10, 20]);
    expect([...r.temperatures[1]!]).toEqual([305, 320]);
    expect(() => readCalculixTemperatures(frd(), 2)).toThrow(FrdError);
    expect(() =>
      readCalculixTemperatures(frd(block('20.00000000', 300, 310), block('10.00000000', 1, 1)), 2),
    ).toThrow(FrdError);
  });
});

describe('the CalculiX model of a transient input (Codex on #1272, TS-2282)', () => {
  it('gives each node one summed CFLUX and each condition one amplitude', () => {
    const mesh = boxTetMesh({ size: [20, 10, 10], divisions: [2, 1, 1], type: 'tet10' });
    const input: TransientInput = {
      mesh,
      material: steel,
      conditions: [
        {
          kind: 'temperature',
          faces: [0],
          edges: [],
          temperature: 400,
          amplitude: { times: [0, 20], factors: [0.75, 1] },
        },
        {
          kind: 'temperature',
          faces: [1],
          edges: [],
          temperature: 300,
          amplitude: { times: [0, 40], factors: [1, 2] },
        },
        {
          kind: 'convection',
          faces: [2, 3, 4, 5],
          coefficient: 0.01,
          ambient: 300,
          amplitude: { times: [0, 40], factors: [1, 0.5] },
        },
      ],
      initialTemperature: 300,
      time: { end: 40, step: 10, theta: 1 },
      output: { every: 1 },
      solver,
    };
    const model = transientCalculixModel(input);
    const nodes = model.nodal!.map((c) => c.node);
    expect(new Set(nodes).size).toBe(nodes.length);
    // Two holds, the film, and the couplings: no amplitude per element face.
    const filmFaces = model.faces.filter((f) => f.kind === 'film');
    expect(filmFaces.length).toBeGreaterThan(4);
    expect(new Set(filmFaces.map((f) => f.amplitude)).size).toBe(1);
    expect(model.amplitudes.length).toBeLessThan(3 + 2 + nodes.length);
    // A free node next to both holds (in the middle) takes both rates, summed, at each step.
    const at = (a: { times: number[]; factors: number[] }, t: number) => {
      const i = a.times.findIndex((x) => x >= t);
      return i <= 0 ? a.factors[Math.max(i, 0)]! : a.factors[i]!;
    };
    const both = model.nodal!.filter((c) => {
      const x = mesh.nodes[3 * c.node]!;
      return x > 5 && x < 15;
    });
    expect(both.length).toBeGreaterThan(0);
    for (const c of both) {
      const a = model.amplitudes[c.amplitude!]!;
      // Step 3 (20…30 s): only the second hold changes, by 300 K × 0.25 per 10 s.
      expect(Math.abs(c.heat * at(a, 30))).toBeGreaterThan(0);
      // Step 2 (10…20 s): both change.
      expect(Number.isFinite(c.heat * at(a, 20))).toBe(true);
    }
  });
});

const ccx = spawnSync('ccx', ['-v'], { encoding: 'utf8' });
const hasCcx = /Version \d/.test(`${ccx.stdout ?? ''}${ccx.stderr ?? ''}`);

describe('fluxes and films that overlap on a face (Codex on #1272, TS-2282)', () => {
  it('writes one flux history per face, the sum of the conditions', () => {
    const mesh = boxTetMesh({ size: [10, 10, 10], divisions: [1, 1, 1], type: 'tet4' });
    const input: TransientInput = {
      mesh,
      material: steel,
      conditions: [
        { kind: 'heat-flux', faces: [0], flux: 1, amplitude: { times: [0, 10], factors: [0, 1] } },
        { kind: 'heat-flux', faces: [0], flux: 2, amplitude: { times: [0, 10], factors: [1, 0] } },
        { kind: 'convection', faces: [1], coefficient: 0.01, ambient: 300 },
        { kind: 'convection', faces: [1], coefficient: 0.02, ambient: 300 },
      ],
      initialTemperature: 300,
      time: { end: 10, step: 5, theta: 1 },
      output: { every: 1 },
      solver,
      nonlinear: { tolerance: 1e-9, maxIterations: 50 },
    };
    const model = transientCalculixModel(input);
    const flux = model.faces.filter((f) => f.kind === 'flux');
    const keys = flux.map((f) => `${f.element} ${f.face}`);
    expect(new Set(keys).size).toBe(keys.length);
    // 2 at the start, 1 at the end.
    const f = flux[0]!;
    if (f.kind !== 'flux' || f.amplitude === undefined) throw new Error('no flux history');
    const a = model.amplitudes[f.amplitude]!;
    expect(f.flux * a.factors[0]!).toBeCloseTo(2, 12);
    expect(f.flux * a.factors.at(-1)!).toBeCloseTo(1, 12);
    // The two films to the same air are one of 0.03.
    const film = model.faces.filter((x) => x.kind === 'film');
    expect(new Set(film.map((x) => `${x.element} ${x.face}`)).size).toBe(film.length);
    for (const x of film) if (x.kind === 'film') expect(x.coefficient).toBeCloseTo(0.03, 12);
    // Films to different air on one face are the browser's only.
    const apart = structuredClone(input.conditions);
    apart[3] = { kind: 'convection', faces: [1], coefficient: 0.02, ambient: 350 };
    expect(() => transientCalculixModel({ ...input, conditions: apart })).toThrow(/browser only/);
  });
});

describe('replaying a rounded field (Codex on #1272, TS-2282)', () => {
  it('takes a radiating body at equilibrium rounded to the .frd’s digits', () => {
    // A 1 000 mm cube radiating to 293.1514 K, at that temperature, one 100 000 s step.
    const mesh = boxTetMesh({ size: [1000, 1000, 1000], divisions: [1, 1, 1], type: 'tet4' });
    const n = mesh.nodes.length / 3;
    const input: TransientInput = {
      mesh,
      material: { conductivity: 0.04, density: 3e-11, specificHeat: 1e9 },
      conditions: [
        { kind: 'radiation', faces: [0, 1, 2, 3, 4, 5], emissivity: 0.9, ambient: 293.1514 },
      ],
      initialTemperature: 293.1514,
      time: { end: 1e5, step: 1e5, theta: 1 },
      output: { every: 1 },
      solver,
      nonlinear: { tolerance: 1e-9, maxIterations: 50 },
      capacityRule: 'conduction',
    };
    const rounded = [new Float64Array(n).fill(Number((293.1514).toPrecision(6)))];
    expect(solveTransientThermal({ ...input, replay: rounded }).replayResidual).toBeLessThan(2e-3);
  });
});

describe.skipIf(!hasCcx)('CalculiX against the browser solver (VS11d-3, TS-2282)', () => {
  it('heats a bar from a ramped end, with a film, a flux and radiation, as the browser does', () => {
    const mesh = boxTetMesh({ size: [100, 10, 10], divisions: [10, 1, 1], type: 'tet10' });
    const n = mesh.nodes.length / 3;
    const ramp = { times: [0, 30], factors: [0.5, 1] };
    const end = 120,
      step = 5;
    // Faces 0/1 are x = 0 / x = 100, 2/3 y, 4/5 z.
    const input: TransientInput = {
      mesh,
      material: steel,
      conditions: [
        { kind: 'temperature', faces: [0], edges: [], temperature: 800, amplitude: ramp },
        { kind: 'convection', faces: [1], coefficient: 0.05, ambient: 300 },
        {
          kind: 'heat-flux',
          faces: [4],
          flux: 0.2,
          amplitude: { times: [0, 60], factors: [1, 0] },
        },
        { kind: 'radiation', faces: [5], emissivity: 0.9, ambient: 300 },
      ],
      initialTemperature: 300,
      time: { end, step, theta: 1 },
      output: { every: 1 },
      solver,
      nonlinear: { tolerance: 1e-9, maxIterations: 50 },
      // CalculiX's capacity rule, which a Host run solves (the browser's own default is exact).
      capacityRule: 'conduction',
    };
    const browser = solveTransientThermal(input);
    // The exact (full-rank) capacity, the browser's default, gives nearly the same run.
    const exact = solveTransientThermal({ ...input, capacityRule: undefined });
    const end0 = browser.temperatures.at(-1)!;
    const end1 = exact.temperatures.at(-1)!;
    let apart = 0;
    for (let p = 0; p < n; p++) apart = Math.max(apart, Math.abs(end0[p]! - end1[p]!));
    expect(apart).toBeGreaterThan(0);
    expect(apart / 500).toBeLessThan(0.02);
    // The same input as CalculiX's model: holds, faces, the start and the held ramp's coupling.
    const model = transientCalculixModel(input);
    expect(model.nodal!.length).toBeGreaterThan(0);
    // One CFLUX per node, and one amplitude per condition (the hold, its coupling, the flux).
    expect(new Set(model.nodal!.map((c) => c.node)).size).toBe(model.nodal!.length);
    expect(model.amplitudes).toHaveLength(3);
    const inp = writeCalculixHeat(model);
    const dir = mkdtempSync(join(tmpdir(), 'ccx-heat-'));
    let frd: string;
    try {
      writeFileSync(join(dir, 'job.inp'), inp);
      const run = spawnSync('ccx', ['-i', 'job'], { cwd: dir, encoding: 'utf8', timeout: 300_000 });
      if (run.status !== 0) throw new Error(`ccx failed: ${run.stdout}${run.stderr}`);
      frd = readFileSync(join(dir, 'job.frd'), 'utf8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const host = readCalculixTemperatures(frd, n);
    expect(host.times).toEqual(browser.times.slice(1));
    let worst = 0;
    host.temperatures.forEach((T, s) => {
      const b = browser.temperatures[s + 1]!;
      for (let p = 0; p < n; p++) worst = Math.max(worst, Math.abs(T[p]! - b[p]!));
    });
    // 500 K of rise; CalculiX writes 6 significant digits.
    // CalculiX's own Newton tolerance on the radiation leaves about 0.01 K.
    expect(worst / 500).toBeLessThan(1e-4);
    // Replayed through the browser's equations: the same run, its balance and a small residual.
    const replayed = solveTransientThermal({ ...input, replay: host.temperatures });
    // CalculiX writes 6 significant digits: about 1e-3 K on 800 K, against each step’s change.
    expect(replayed.replayResidual).toBeLessThan(2e-3);
    expect(replayed.balance / replayed.energyScale).toBeLessThan(1e-4);
    expect(replayed.conditionHeat[0]! / browser.conditionHeat[0]!).toBeCloseTo(1, 4);
    // The browser's own run replays with no residual.
    const self = solveTransientThermal({ ...input, replay: browser.temperatures.slice(1) });
    expect(self.replayResidual).toBeLessThan(1e-9);
    expect(() => solveTransientThermal({ ...input, replay: host.temperatures.slice(1) })).toThrow();
    // A replayed field that does not hold the held temperatures is refused.
    const off = host.temperatures.map((T) => Float64Array.from(T));
    off[3]![model.holds[0]!.nodes[0]!]! += 1;
    expect(() => solveTransientThermal({ ...input, replay: off })).toThrow(/held at/);
    // Rounding of the held values within the `.frd`'s digits is taken.
    const rounded = host.temperatures.map((T) =>
      Float64Array.from(T, (v) => Number(v.toPrecision(6))),
    );
    expect(solveTransientThermal({ ...input, replay: rounded }).replayResidual).toBeLessThan(2e-3);
    // CalculiX steps backward Euler, and radiation between faces stays in the browser.
    expect(() => transientCalculixModel({ ...input, time: { end, step, theta: 0.5 } })).toThrow();
    expect(() =>
      transientCalculixModel({
        ...input,
        conditions: [{ kind: 'enclosure', faces: [2, 3], emissivity: 0.5 }],
        enclosure: { ambient: 300, raysPerPatch: 16 },
      }),
    ).toThrow();
  });
});
