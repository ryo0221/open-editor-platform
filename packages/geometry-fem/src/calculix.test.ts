import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  boxTetMesh,
  calculixNumber,
  FrdError,
  prepareElastic,
  readCalculixFrd,
  solveElastic,
  writeCalculixInp,
  type CalculixUnits,
  type ElasticInput,
} from './index';

const steel = { youngsModulus: 210_000, poissonsRatio: 0.3, density: 7.85e-9 };
const solver = { tolerance: 1e-12, maxIterations: 100_000 };
const cantilever = (d: number): ElasticInput => ({
  mesh: boxTetMesh({ size: [200, 20, 20], divisions: [d, 2, 2], type: 'tet10' }),
  material: steel,
  constraints: [{ faces: [0], edges: [], displacement: [0, 0, 0] }],
  loads: [{ kind: 'face-force', faces: [1], force: [0, 0, -1000] }],
  solver,
});
/** CalculiX on the server side: only where the `ccx` binary is installed (never bundled, U3). */
const ccx = spawnSync('ccx', ['-v'], { encoding: 'utf8' });
const hasCcx = /Version \d/.test(`${ccx.stdout ?? ''}${ccx.stderr ?? ''}`);
function runCcx(inp: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccx-'));
  try {
    writeFileSync(join(dir, 'job.inp'), inp);
    const r = spawnSync('ccx', ['-i', 'job'], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
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
    expect(e).toBeInstanceOf(FrdError);
    return e as FrdError;
  }
  throw new Error('not refused');
};

/** A small `.frd` in CalculiX's long ASCII layout (format 1) for 2 nodes. */
const v = (x: number) =>
  x
    .toExponential(5)
    .replace(/e([-+])(\d)$/, 'E$10$2')
    .padStart(12);
const frd = (opts: {
  disp?: number[][];
  stress?: number[][];
  force?: number[][];
  nodes?: number;
}) => {
  const n = opts.nodes ?? 2;
  const rec = (id: number, xs: number[]) => ` -1${String(id).padStart(10)}${xs.map(v).join('')}`;
  const block = (name: string, comps: string[], rows: number[][], all: boolean) => [
    '  100CL  101 1.000000000           2                     0    1           1',
    ` -4  ${name.padEnd(8)}${String(comps.length + (all ? 1 : 0)).padStart(4)}    1`,
    ...comps.map((c) => ` -5  ${c.padEnd(8)}    1    2    1    0`),
    ...(all ? [' -5  ALL         1    2    0    0    1ALL'] : []),
    ...rows.map((r, k) => rec(k + 1, r)),
    ' -3',
  ];
  return [
    '    1C',
    `    2C${String(n).padStart(30)}${''.padStart(37)}1`,
    ...Array.from({ length: n }, (_, k) => rec(k + 1, [k, 0, 0])),
    ' -3',
    '    1PSTEP                         1           1           1',
    ...block(
      'DISP',
      ['D1', 'D2', 'D3'],
      opts.disp ?? [
        [1, 2, 3],
        [4, 5, 6],
      ],
      true,
    ),
    ...block(
      'STRESS',
      ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'],
      opts.stress ?? [
        [1, 2, 3, 4, 5, 6],
        [-1, -2, -3, -4, -5, -6],
      ],
      false,
    ),
    ...block(
      'FORC',
      ['F1', 'F2', 'F3'],
      opts.force ?? [
        [0, 0, 1],
        [0, 0, -1],
      ],
      true,
    ),
    ' 9999',
    '',
  ].join('\n');
};

describe('CalculiX exchange (R3f-1)', () => {
  it('writes nodes, C3D10 elements, material, prescribed DOFs and the nodal forces', () => {
    const input = cantilever(2);
    const prepared = prepareElastic(input);
    const inp = writeCalculixInp({ mesh: input.mesh, material: steel, prepared });
    const n = input.mesh.nodes.length / 3;
    const m = input.mesh.elements.length / 10;
    const section = (name: string) => {
      const lines = inp.split('\n');
      const start = lines.findIndex((l) => l.startsWith(name));
      const end = lines.findIndex((l, k) => k > start && l.startsWith('*'));
      return lines.slice(start + 1, end);
    };
    expect(section('*NODE,')).toHaveLength(n);
    expect(section('*ELEMENT, TYPE=C3D10')).toHaveLength(m);
    expect(section('*ELEMENT')[0]!.split(', ').map(Number)).toEqual([
      1,
      ...[...input.mesh.elements.subarray(0, 10)].map((p) => p + 1),
    ]);
    expect(section('*ELASTIC')).toEqual(['210000, 0.3']);
    expect(section('*BOUNDARY')).toHaveLength(prepared.prescribed.size);
    const loads = section('*CLOAD').map((l) => l.split(', ').map(Number));
    expect(loads.reduce((s, l) => s + (l[1] === 3 ? l[2]! : 0), 0)).toBeCloseTo(-1000, 9);
    // Exact round trip of the written numbers.
    const first = section('*NODE,')[5]!.split(', ').map(Number);
    expect(first.slice(1)).toEqual([...input.mesh.nodes.subarray(15, 18)]);
    for (const x of [Math.PI * 1e-300, -1 / 3, 123456.789, 1e21, -Number.MIN_VALUE]) {
      const t = calculixNumber(x);
      expect(t.length).toBeLessThanOrEqual(20);
      expect(Math.abs(Number(t) / x - 1)).toBeLessThan(1e-13);
    }
    // Nothing but declarative data: no names, paths or document content.
    expect(inp).not.toMatch(/INCLUDE|\*USER|\*RESTART/i);
    const metres = writeCalculixInp({ mesh: input.mesh, material: steel, prepared, units: 'm' });
    expect(metres.split('\n').find((l) => l.startsWith('2100'))).toBe('210000000000, 0.3');
  });

  it('reads DISP, STRESS and FORC of a long-format ASCII .frd', () => {
    const r = readCalculixFrd(frd({}), 2);
    expect([...r.displacement]).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...r.stress]).toEqual([1, 2, 3, 4, 5, 6, -1, -2, -3, -4, -5, -6]);
    expect([...r.force]).toEqual([0, 0, 1, 0, 0, -1]);
    const m = readCalculixFrd(frd({}), 2, 'm');
    expect(m.displacement[0]).toBeCloseTo(1000, 9);
    expect(m.stress[0]).toBeCloseTo(1e-6, 15);
  });

  it('refuses a .frd that does not fit the study, and repairs nothing', () => {
    expect(refusal(() => readCalculixFrd(frd({}), 3)).problem).toBe('length');
    expect(refusal(() => readCalculixFrd(frd({ nodes: 3 }), 2)).problem).toBe('index');
    const short = frd({}).replace(/^( -1 {9}2 4\.00000E\+00).*$/m, '$1');
    expect(refusal(() => readCalculixFrd(short, 2)).problem).toBe('length');
    const twice = frd({}).replace(' -1         2 4.00000E+00', ' -1         1 4.00000E+00');
    expect(refusal(() => readCalculixFrd(twice, 2)).problem).toBe('index');
    const nan = frd({}).replace(' 4.00000E+00', '         NaN');
    expect(refusal(() => readCalculixFrd(nan, 2)).problem).toBe('format');
    const huge = frd({}).replace(' 4.00000E+00', ' 4.00000E+99'.replace('E+99', 'E999'));
    expect(['format', 'not-finite']).toContain(refusal(() => readCalculixFrd(huge, 2)).problem);
    const noStress = frd({}).replace(
      / -4 {2}STRESS[\s\S]*? -3\n/,
      ' -4  OTHER      1    1\n -5  X           1    1    1    0\n -1         1 1.00000E+00\n -1         2 1.00000E+00\n -3\n',
    );
    expect(refusal(() => readCalculixFrd(noStress, 2)).problem).toBe('missing');
    const binary = frd({}).replace(/^( {4}2C.*)1$/m, '$12');
    expect(refusal(() => readCalculixFrd(binary, 2)).problem).toBe('format');
    expect(refusal(() => readCalculixFrd(frd({}), 2, 'mm', { bytes: 100 })).problem).toBe(
      'too-large',
    );
    expect(refusal(() => readCalculixFrd('', 2)).problem).toBe('length');
  });

  it('writes many nodal forces and refuses a value that overflows in mm (#839 review)', () => {
    const mesh = boxTetMesh({ size: [10, 10, 10], divisions: [1, 1, 1], type: 'tet4' });
    const n = mesh.nodes.length / 3;
    // 150 000 force records on a stand-in study: the export does not spread them into a call.
    const big = { ...mesh, nodes: new Float64Array(150_000).fill(0) };
    const force = new Float64Array(150_000).fill(1);
    const inp = writeCalculixInp({
      mesh: { ...big, elements: new Uint32Array() },
      material: steel,
      prepared: { prescribed: new Map(), force, loadChecks: [], constrainedNodes: [] },
    });
    expect(inp.split('\n').filter((l) => /^\d+, [123], 1$/.test(l))).toHaveLength(150_000);
    expect(n).toBe(8);
    const overflow = frd({
      disp: [
        [1e308, 0, 0],
        [0, 0, 0],
      ],
    });
    expect(readCalculixFrd(overflow, 2).displacement[0]).toBe(1e308);
    expect(refusal(() => readCalculixFrd(overflow, 2, 'm')).problem).toBe('not-finite');
  });

  it('takes all results from the last frame and skips other results unread (#839 review)', () => {
    // A later step that wrote only DISP is not mixed with the earlier STRESS and FORC.
    const later = frd({}).replace(
      ' 9999',
      [
        '    1PSTEP                         4           1           2',
        '  100CL  102 2.000000000           2                     0    2           1',
        ' -4  DISP        4    1',
        ' -5  D1          1    2    1    0',
        ' -5  D2          1    2    2    0',
        ' -5  D3          1    2    3    0',
        ' -5  ALL         1    2    0    0    1ALL',
        ' -1         1 9.00000E+00 9.00000E+00 9.00000E+00',
        ' -1         2 9.00000E+00 9.00000E+00 9.00000E+00',
        ' -3',
        ' 9999',
      ].join('\n'),
    );
    expect(refusal(() => readCalculixFrd(later, 2)).problem).toBe('missing');
    // An unknown result with many components (and continuation records) is skipped, not kept.
    const other = frd({}).replace(
      ' 9999',
      [
        '  100CL  101 1.000000000           2                     0    1           1',
        ' -4  OTHER   10000    1',
        ...Array.from({ length: 10_000 }, (_, k) => ` -5  C${k}          1    1    1    0`),
        ' -1         1 1.00000E+00',
        ' -2           1.00000E+00',
        ' -3',
        ' 9999',
      ].join('\n'),
    );
    expect([...readCalculixFrd(other, 2).displacement]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it.skipIf(!hasCcx)(
    'FX1: CalculiX on the same nodal data agrees with the browser solver, in mm and in m',
    () => {
      const input = cantilever(10);
      const mine = solveElastic(input);
      const prepared = prepareElastic(input);
      const n = input.mesh.nodes.length / 3;
      for (const units of ['mm', 'm'] as CalculixUnits[]) {
        const text = runCcx(
          writeCalculixInp({ mesh: input.mesh, material: steel, prepared, units }),
        );
        const r = readCalculixFrd(text, n, units);
        const max = (a: Float64Array) => a.reduce((s, x) => Math.max(s, Math.abs(x)), 0);
        const diff = (a: Float64Array, b: Float64Array) =>
          a.reduce((s, x, k) => Math.max(s, Math.abs(x - b[k]!)), 0);
        // CalculiX writes 6 significant digits: agree to 1e-4 of the largest value.
        expect(diff(r.displacement, mine.displacement) / max(mine.displacement)).toBeLessThan(1e-4);
        expect(diff(r.stress, mine.stress) / max(mine.stress)).toBeLessThan(1e-3);
        // Reactions: K u − f at held DOFs balance the load.
        let rz = 0;
        for (const [d] of prepared.prescribed)
          if (d % 3 === 2) rz += r.force[d]! - prepared.force[d]!;
        expect(rz).toBeCloseTo(1000, 1);
      }
    },
    120_000,
  );
});
