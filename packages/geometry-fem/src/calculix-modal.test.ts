import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bondedModalHostModel,
  calculixEigenvalueAgreement,
  calculixModalSummary,
  bondedModalResultFromFrd,
  boxTetMesh,
  calculixModeCount,
  ElasticError,
  FrdError,
  modalHostModel,
  modalResultFromFrd,
  readCalculixModes,
  shellModalHostModel,
  shellModalResultFromFrd,
  solveBondedModal,
  solveModal,
  solveShellModal,
  writeCalculixModel,
  type BondedModalInput,
  type CalculixModel,
  type FrdMode,
  type FemMesh,
  type ModalInput,
  type ShellMesh,
  type ShellModalInput,
} from './index';

/**
 * TS-1461 (ST-235#1): natural modes on the reference Host (R3j-5c). A solid, a shell (as its
 * 15-node wedges) and bonded bodies solved by CalculiX's `*FREQUENCY` against the browser's
 * LOBPCG (`solveModal`, `solveShellModal`, `solveBondedModal`), with the checks the run makes from
 * the `.frd` alone: the Rayleigh quotients and K-orthogonality of the modes.
 */
const steel = { youngsModulus: 210_000, poissonsRatio: 0.3, density: 7.85e-9 };
const modal = { tolerance: 1e-6, maxIterations: 5000 };
const zero: [number, number, number] = [0, 0, 0];
/** What the run allows for the `.frd`'s 6 digits (compute.ts `computeModalTolerance`). */
const tolerance = 1e-4;
const ccx = spawnSync('ccx', ['-v'], { encoding: 'utf8' });
const hasCcx = /Version \d/.test(`${ccx.stdout ?? ''}${ccx.stderr ?? ''}`);
function runCcx(inp: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccx-modal-'));
  try {
    writeFileSync(join(dir, 'job.inp'), inp);
    const r = spawnSync('ccx', ['-i', 'job'], { cwd: dir, encoding: 'utf8', timeout: 300_000 });
    if (r.status !== 0) throw new Error(`ccx failed: ${r.stdout}${r.stderr}`);
    return readFileSync(join(dir, 'job.frd'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const refusal = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ElasticError);
    return (e as ElasticError).problem;
  }
  throw new Error('not refused');
};
const close = (a: number, b: number, relative: number) =>
  expect(Math.abs(a / b - 1), `${a} for ${b}`).toBeLessThan(relative);

/** A flat grid shell over [x0, x1] × [y0, y1] at z; edges 0 y = y0, 1 x = x1, 2 y = y1, 3 x = x0. */
function grid(
  nu: number,
  nv: number,
  [x0, x1]: [number, number],
  [y0, y1]: [number, number],
  thickness: number,
): ShellMesh {
  const nodes: number[] = [];
  for (let j = 0; j <= nv; j++)
    for (let i = 0; i <= nu; i++)
      nodes.push(x0 + ((x1 - x0) * i) / nu, y0 + ((y1 - y0) * j) / nv, 0);
  const id = (i: number, j: number) => j * (nu + 1) + i;
  const tris: number[] = [];
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const [a, b, c, d] = [id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)];
      if ((i + j) % 2) tris.push(a, b, c, a, c, d);
      else tris.push(a, b, d, b, c, d);
    }
  const chains = [
    Array.from({ length: nu + 1 }, (_, i) => id(i, 0)),
    Array.from({ length: nv + 1 }, (_, j) => id(nu, j)),
    Array.from({ length: nu + 1 }, (_, i) => id(i, nv)),
    Array.from({ length: nv + 1 }, (_, j) => id(0, j)),
  ];
  const offsets = [0];
  for (const c of chains) offsets.push(offsets.at(-1)! + c.length);
  const m = tris.length / 3;
  return {
    nodes: Float64Array.from(nodes),
    triangles: Uint32Array.from(tris),
    thickness: new Float64Array(m).fill(thickness),
    faces: new Int32Array(m),
    shapeFaces: 1,
    shapeEdges: 4,
    edges: { offsets: Uint32Array.from(offsets), nodes: Uint32Array.from(chains.flat()) },
  };
}
const shifted = (mesh: FemMesh, dx: number): FemMesh => {
  const nodes = mesh.nodes.slice();
  for (let p = 0; p < nodes.length / 3; p++) nodes[3 * p]! += dx;
  return { ...mesh, nodes };
};
const clampEdges = (edges: number[]) => [{ faces: [], edges, displacement: zero, rotation: zero }];

describe.skipIf(!hasCcx)('natural modes on the Host (R3j-5c)', { timeout: 300_000 }, () => {
  it('FX4: the cantilever’s modes, masses and effective masses as the browser', () => {
    const input: ModalInput = {
      mesh: boxTetMesh({ size: [200, 20, 20], divisions: [20, 2, 2], type: 'tet10' }),
      material: steel,
      constraints: [{ faces: [0], edges: [], displacement: zero }],
      modes: 6,
      // As modal.test.ts: the browser's FX4 to 1e-4.
      solver: { tolerance: 1e-4, maxIterations: 2000 },
    };
    const host = modalHostModel(input);
    const text = runCcx(writeCalculixModel(host.model));
    const r = modalResultFromFrd(
      input,
      host,
      readCalculixModes(text, host.model.nodes.length / 3, 6),
    );
    const mine = solveModal(input);
    expect(r.modes).toHaveLength(6);
    r.modes.forEach((m, k) => close(m.frequency, mine.modes[k]!.frequency, 2e-3));
    expect(r.mass).toBeCloseTo(mine.mass, 15);
    expect(r.orthogonality).toBeLessThan(tolerance);
    for (const m of r.modes) expect(m.residual).toBeLessThan(tolerance);
    // The first bending pair carries the cantilever's 61 % in y and z, as in the browser.
    for (const i of [1, 2]) {
      const host2 = r.modes[0]!.effectiveMass[i] + r.modes[1]!.effectiveMass[i];
      const mine2 = mine.modes[0]!.effectiveMass[i] + mine.modes[1]!.effectiveMass[i];
      expect(Math.abs(host2 - mine2)).toBeLessThan(1e-3);
    }
    // Mass-normalised shapes: the tip moves as the browser's, up to the sign.
    const tip = r.modes[0]!.shape.reduce((s, x) => Math.max(s, Math.abs(x)), 0);
    const tipMine = mine.modes[0]!.shape.reduce((s, x) => Math.max(s, Math.abs(x)), 0);
    close(tip, tipMine, 0.01);
  });

  it('a clamped plate as wedges: frequencies and shapes as the browser’s shell', () => {
    const input: ShellModalInput = {
      mesh: grid(24, 24, [0, 100], [0, 100], 1),
      material: steel,
      constraints: clampEdges([0, 1, 2, 3]),
      modes: 3,
      solver: modal,
    };
    const host = shellModalHostModel(input);
    const r = shellModalResultFromFrd(
      input,
      host,
      readCalculixModes(runCcx(writeCalculixModel(host.model)), host.model.nodes.length / 3, 3),
    );
    const mine = solveShellModal(input);
    // Clamped square plate: f1 = 35.99 / 2π a² √(D / ρ t) (Leissa), 0.87–0.97 for coarse wedges.
    const D = (210_000 * 1) / (12 * (1 - 0.09));
    const exact = (35.99 / (2 * Math.PI * 100 ** 2)) * Math.sqrt(D / (7.85e-9 * 1));
    close(r.modes[0]!.frequency, exact, 0.04);
    close(r.modes[0]!.frequency, mine.modes[0]!.frequency, 0.04);
    // The two symmetric second modes of the square.
    close(r.modes[1]!.frequency, r.modes[2]!.frequency, 0.01);
    expect(r.mass).toBeCloseTo(mine.mass, 15);
    expect(r.orthogonality).toBeLessThan(tolerance);
    expect(r.modes[0]!.shape).toHaveLength(6 * 25 * 25);
    // The first mode moves the plate's middle out of plane, and carries most of the z mass.
    const centre = 12 * 25 + 12;
    expect(Math.abs(r.modes[0]!.shape[6 * centre + 2]!)).toBeGreaterThan(0);
    expect(Math.abs(r.modes[0]!.effectiveMass[2] - mine.modes[0]!.effectiveMass[2])).toBeLessThan(
      0.02,
    );
  });

  it('a cantilever cut in two along non-matching faces, bonded on the Host', () => {
    const input: BondedModalInput = {
      parts: [
        {
          kind: 'solid',
          mesh: boxTetMesh({ size: [100, 20, 20], divisions: [5, 2, 2], type: 'tet10' }),
          material: steel,
          loads: [],
          constraints: [{ faces: [0], edges: [], displacement: zero }],
        },
        {
          kind: 'solid',
          mesh: shifted(
            boxTetMesh({ size: [100, 20, 20], divisions: [4, 3, 3], type: 'tet10' }),
            100,
          ),
          material: steel,
          loads: [],
          constraints: [],
        },
      ],
      bonds: [
        {
          follower: { part: 1, faces: [0], edges: [] },
          on: { part: 0, faces: [1], edges: [] },
          tolerance: 1e-6,
        },
      ],
      modes: 2,
      solver: modal,
    };
    const host = bondedModalHostModel(input);
    const r = bondedModalResultFromFrd(
      input,
      host,
      readCalculixModes(runCcx(writeCalculixModel(host.model)), host.model.nodes.length / 3, 2),
    );
    const mine = solveBondedModal(input);
    r.modes.forEach((m, k) => close(m.frequency, mine.modes[k]!.frequency, 0.01));
    expect(r.mass).toBeCloseTo(mine.mass, 15);
    expect(r.orthogonality).toBeLessThan(tolerance);
    expect(r.modes[0]!.shapes.map((s) => s.length)).toEqual(
      mine.modes[0]!.shapes.map((s) => s.length),
    );
    for (let i = 0; i < 3; i++)
      expect(
        Math.abs(r.modes[0]!.effectiveMass[i]! - mine.modes[0]!.effectiveMass[i]!),
      ).toBeLessThan(0.01);
  });

  it('shell plates bonded along non-matching edges, as the browser', () => {
    const input: BondedModalInput = {
      parts: [
        {
          kind: 'shell',
          mesh: grid(12, 24, [0, 50], [0, 100], 1),
          material: steel,
          loads: [],
          constraints: clampEdges([0, 2, 3]),
        },
        {
          kind: 'shell',
          mesh: grid(10, 20, [50, 100], [0, 100], 1),
          material: steel,
          loads: [],
          constraints: clampEdges([0, 1, 2]),
        },
      ],
      bonds: [
        {
          follower: { part: 1, faces: [], edges: [3] },
          on: { part: 0, faces: [], edges: [1] },
          tolerance: 1e-6,
        },
      ],
      modes: 3,
      solver: modal,
    };
    const host = bondedModalHostModel(input);
    const r = bondedModalResultFromFrd(
      input,
      host,
      readCalculixModes(runCcx(writeCalculixModel(host.model)), host.model.nodes.length / 3, 3),
    );
    const mine = solveBondedModal(input);
    r.modes.forEach((m, k) => close(m.frequency, mine.modes[k]!.frequency, 0.04));
    expect(r.mass).toBeCloseTo(7.85e-9 * 100 * 100 * 1, 12);
    expect(r.orthogonality).toBeLessThan(tolerance);
    expect(r.modes[0]!.shapes.map((s) => s.length)).toEqual([6 * 13 * 25, 6 * 11 * 21]);
  });
});

describe('modal models and their results (R3j-5c)', () => {
  const input: ModalInput = {
    mesh: boxTetMesh({ size: [20, 10, 10], divisions: [2, 1, 1], type: 'tet4' }),
    material: steel,
    constraints: [{ faces: [0], edges: [], displacement: zero }],
    modes: 2,
    solver: modal,
  };

  it('writes a frequency step with densities, and no load or stress output', () => {
    const inp = writeCalculixModel(modalHostModel(input).model);
    expect(inp).toContain('*DENSITY\n7.85e-9');
    expect(inp).toContain('*FREQUENCY\n2');
    expect(inp).not.toContain('*STATIC');
    expect(inp).not.toContain('*CLOAD');
    expect(inp).not.toContain('*EL FILE');
    const { model } = modalHostModel(input);
    expect(() => writeCalculixModel({ ...model, units: 'm' })).toThrow(RangeError);
    expect(() =>
      writeCalculixModel({
        ...model,
        parts: [{ ...model.parts[0]!, material: { youngsModulus: 1, poissonsRatio: 0.3 } }],
      }),
    ).toThrow(RangeError);
  });

  it('refuses as the browser: no density, a held value other than 0, nothing free', () => {
    expect(refusal(() => modalHostModel({ ...input, material: { ...steel, density: 0 } }))).toBe(
      'material',
    );
    expect(
      refusal(() =>
        modalHostModel({
          ...input,
          constraints: [{ faces: [0], edges: [], displacement: [0.1, 0, 0] }],
        }),
      ),
    ).toBe('constraint-conflict');
    expect(
      refusal(() =>
        modalHostModel({
          ...input,
          constraints: [{ faces: [0, 1, 2, 3, 4, 5], edges: [], displacement: zero }],
        }),
      ),
    ).toBe('constraint-conflict');
  });

  it('refuses a held rotation about a bonded shell’s normal other than 0, which wedges would drop', () => {
    const shell = (rotation: [number, number, number]): BondedModalInput => ({
      parts: [
        {
          kind: 'shell',
          mesh: grid(2, 2, [0, 50], [0, 50], 1),
          material: steel,
          loads: [],
          constraints: [{ faces: [], edges: [3], displacement: zero, rotation }],
        },
        {
          kind: 'shell',
          mesh: grid(2, 2, [50, 100], [0, 50], 1),
          material: steel,
          loads: [],
          constraints: [],
        },
      ],
      bonds: [
        {
          follower: { part: 1, faces: [], edges: [3] },
          on: { part: 0, faces: [], edges: [1] },
          tolerance: 1e-6,
        },
      ],
      modes: 1,
      solver: modal,
    });
    expect(() => bondedModalHostModel(shell([0, 0, 0]))).not.toThrow();
    expect(refusal(() => bondedModalHostModel(shell([0, 0, 0.01])))).toBe('constraint-conflict');
  });

  it.skipIf(!hasCcx)(
    'asks for no more modes than there are free DOFs, as the browser (#885 review)',
    () => {
      // One cell clamped at x = 0, the other faces held in y and z: 4 free DOFs.
      const few: ModalInput = {
        mesh: boxTetMesh({ size: [20, 10, 10], divisions: [1, 1, 1], type: 'tet4' }),
        material: steel,
        constraints: [
          { faces: [0], edges: [], displacement: zero },
          { faces: [1, 2, 3, 4, 5], edges: [], displacement: [null, 0, 0] },
        ],
        modes: 6,
        solver: { tolerance: 1e-8, maxIterations: 2000 },
      };
      const host = modalHostModel(few);
      const mine = solveModal(few);
      expect(host.model.modes).toBe(mine.modes.length);
      const r = modalResultFromFrd(
        few,
        host,
        readCalculixModes(
          runCcx(writeCalculixModel(host.model)),
          host.model.nodes.length / 3,
          calculixModeCount(host.model),
        ),
      );
      // CalculiX's Lanczos solver stops one short of all the free DOFs.
      expect(r.modes).toHaveLength(mine.modes.length - 1);
    },
  );

  it.skipIf(!hasCcx)(
    'counts the held rows’ mass coupling in the effective masses, as the browser (#885 review)',
    () => {
      // One coarse tet10 cell (CalculiX integrates C3D4's mass otherwise): the clamped end's rows
      // carry much of the consistent mass.
      const coarse: ModalInput = {
        mesh: boxTetMesh({ size: [20, 10, 10], divisions: [1, 1, 1], type: 'tet10' }),
        material: steel,
        constraints: [{ faces: [0], edges: [], displacement: zero }],
        modes: 2,
        solver: { tolerance: 1e-8, maxIterations: 2000 },
      };
      const host = modalHostModel(coarse);
      const r = modalResultFromFrd(
        coarse,
        host,
        readCalculixModes(runCcx(writeCalculixModel(host.model)), host.model.nodes.length / 3, 2),
      );
      const mine = solveModal(coarse);
      // CalculiX integrates C3D10's mass a little differently (0.2 % on the frequencies); without
      // the held rows the shares came out far lower on a cell like this.
      r.modes.forEach((m, k) => {
        close(m.frequency, mine.modes[k]!.frequency, 5e-3);
        for (let i = 0; i < 3; i++)
          expect(
            Math.abs(m.effectiveMass[i] - mine.modes[k]!.effectiveMass[i]),
            `${k} ${i} ${m.effectiveMass[i]} ${mine.modes[k]!.effectiveMass[i]}`,
          ).toBeLessThan(0.01);
      });
    },
  );

  it.skipIf(!hasCcx)('refuses a result with modes missing, out of order or without forces', () => {
    const host = modalHostModel(input);
    const n = host.model.nodes.length / 3;
    const text = runCcx(writeCalculixModel(host.model));
    expect(readCalculixModes(text, n, 2)).toHaveLength(2);
    const problem = (t: string, modes = 2) => {
      try {
        readCalculixModes(t, n, modes);
      } catch (e) {
        expect(e).toBeInstanceOf(FrdError);
        return (e as FrdError).problem;
      }
      throw new Error('not refused');
    };
    expect(problem(text, 3)).toBe('missing');
    // The second mode's frame numbered 3.
    const lines = text.split('\n');
    const frames = lines.flatMap((l, i) => (l.startsWith('  100CL') ? [i] : []));
    const renumbered = lines.map((l, i) =>
      frames.slice(2).includes(i) ? l.slice(0, 58) + '    3' + l.slice(63) : l,
    );
    expect(problem(renumbered.join('\n'))).toBe('structure');
    // The FORC blocks dropped: renamed to a block that is skipped.
    expect(problem(text.replace(/ -4 {2}FORC /g, ' -4  XXXX '))).toBe('missing');
    // A static result is not a modal one.
    const frame = lines[frames[0]!]!;
    expect(
      problem(text.split(frame).join(frame.slice(0, 63) + 'STATIC    ' + frame.slice(73))),
    ).toBe('structure');
  });
});

/**
 * TS-1477 (ST-244, CR0a #895): each frequency comes from its mode's Rayleigh quotient φᵀ F, and
 * CalculiX's printed eigenvalue only has to agree with it within 1e-3; the K-orthogonality of
 * distinct modes is still checked at the Host's tolerance.
 */
describe('Rayleigh-quotient frequencies of the Host’s modes (CR0a)', () => {
  // Two nodes, two modes along x: φ₁ = (1, 0, 0, 0, 0, 0), φ₂ = (0, 0, 0, 1, 0, 0), K = diag(λ).
  const model = { nodes: new Float64Array(6) } as unknown as CalculixModel;
  const mode = (at: number, lambda: number, printed: number, leak = 0): FrdMode => {
    const shape = new Float64Array(6);
    shape[at] = 1;
    const force = new Float64Array(6);
    force[at] = lambda;
    force[3 - at] = leak;
    return { frequency: Math.sqrt(printed) / (2 * Math.PI), eigenvalue: printed, shape, force };
  };
  it('takes the frequency from φᵀ F and measures CalculiX’s eigenvalue against it', () => {
    // #895: the printed eigenvalue 2.85e-4 off, as on the bonded car body.
    const s = calculixModalSummary(model, [mode(0, 100, 100 * (1 + 2.85e-4)), mode(3, 400, 400)]);
    expect(s.modes[0]!.eigenvalue).toBe(100);
    expect(s.modes[0]!.frequency).toBeCloseTo(10 / (2 * Math.PI), 12);
    expect(s.modes[0]!.rayleigh).toBeCloseTo(2.85e-4, 6);
    expect(s.orthogonality).toBe(0);
    // Off by more than 1e-3: the agreement shows it (the run's check refuses above 1e-3).
    const off = calculixModalSummary(model, [mode(0, 100, 100 * (1 + 2e-3)), mode(3, 400, 400)]);
    expect(off.modes[0]!.rayleigh).toBeGreaterThan(calculixEigenvalueAgreement);
    expect(calculixEigenvalueAgreement).toBe(1e-3);
    // Coupled shapes are still refused by the K-orthogonality.
    const coupled = calculixModalSummary(model, [mode(0, 100, 100), mode(3, 400, 400, 1)]);
    expect(coupled.orthogonality).toBeCloseTo(1 / 200, 12);
    expect(coupled.orthogonality).toBeGreaterThan(tolerance);
  });
});
