import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkFrameModel,
  FrameModelError,
  FrdError,
  readCalculixFrame,
  writeCalculixFrame,
  type FrameModel,
  type FrameSection,
} from './index';

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

const steel = { youngsModulus: 210000, poissonsRatio: 0.3 };
/** A rectangle `d` deep and `w` wide. */
const rect = (d: number, w: number): FrameSection => ({
  area: d * w,
  i11: (w * d ** 3) / 12,
  i22: (d * w ** 3) / 12,
  torsion: 0.229 * d * w ** 3,
  c1: d / 2,
  c2: w / 2,
});

/** A straight member from `a` to `b` in `count` 2-node elements, held at `a`. */
function line(
  a: [number, number, number],
  b: [number, number, number],
  count: number,
  section: FrameSection,
  depthDirection: [number, number, number],
): FrameModel {
  const nodes: number[] = [];
  for (let k = 0; k <= count; k++) nodes.push(...a.map((x, i) => x + ((b[i]! - x) * k) / count));
  const elements: number[] = [];
  for (let e = 0; e < count; e++) elements.push(e, e + 1);
  return {
    nodes,
    groups: [{ section, depthDirection, material: steel, elements }],
    fixed: [0],
    force: [],
  };
}

describe('CS4 frame of beam elements on CalculiX (ST-547, TS-2080)', () => {
  it('refuses a frame that is not one (ST-547#1)', () => {
    const ok = line([0, 0, 0], [2000, 0, 0], 2, rect(200, 100), [0, 0, 1]);
    expect(checkFrameModel(JSON.parse(JSON.stringify(ok)))).toEqual(ok);
    const problem = (f: (m: FrameModel) => void) => {
      const m = structuredClone(ok);
      f(m);
      try {
        checkFrameModel(m);
      } catch (e) {
        expect(e).toBeInstanceOf(FrameModelError);
        return (e as FrameModelError).problem;
      }
      return 'accepted';
    };
    expect(problem((m) => (m.groups[0]!.depthDirection = [1, 0, 0]))).toBe('shape');
    expect(problem((m) => (m.groups[0]!.section.i22 = 0))).toBe('section');
    expect(problem((m) => (m.groups[0]!.material.poissonsRatio = 0.5))).toBe('material');
    expect(problem((m) => (m.groups[0]!.elements[1] = 99))).toBe('index');
    expect(problem((m) => (m.groups[0]!.elements = [0, 1, 2]))).toBe('shape');
    expect(problem((m) => (m.fixed = [0, 0]))).toBe('index');
    expect(problem((m) => (m.fixed = []))).toBe('shape');
    expect(
      problem(
        (m) =>
          (m.force = [
            [1, 0, 0, 1],
            [1, 0, 0, 1],
          ]),
      ),
    ).toBe('index');
    expect(problem((m) => (m.nodes[3] = Infinity))).toBe('not-finite');
    expect(problem((m) => Object.assign(m, { extra: 1 }))).toBe('shape');
    expect(problem((m) => Object.assign(m.groups[0]!.section, { j: 1 }))).toBe('shape');
    expect(problem((m) => Object.assign(m.groups[0]!.section, { round: false }))).toBe('section');
  });

  it('writes CalculiX user beams with their sections and loads (ST-547#1)', () => {
    const m = line([0, 0, 0], [2000, 0, 0], 1, rect(200, 100), [0, 0, 1]);
    m.force = [[1, 0, 0, -1000]];
    const inp = writeCalculixFrame(m);
    expect(inp).toContain('*USER ELEMENT, TYPE=U1, INTEGRATION POINTS=2, MAXDOF=6, NODES=2');
    expect(inp).toContain('*ELEMENT, TYPE=U1, ELSET=G1\n1, 1, 2');
    expect(inp).toContain(
      '*USER SECTION, ELSET=G1, MATERIAL=M1, CONSTANTS=10\n20000, 66666666.666666664, 0, 16666666.666666666, 45800000.00000001, 0, 0, 1, 0, 0\n',
    );
    expect(inp).toContain('*BOUNDARY\n1, 1, 6, 0');
    expect(inp).toContain('*CLOAD\n2, 3, -1000');
  });

  it.skipIf(!hasCcx)('bends and stretches a cantilever as the beam theory says (ST-547#2)', () => {
    // 2 m, 100 × 200 mm, 1 kN down and 10 kN along at the tip: PL³/3EI, and N/A + M/W at the root.
    const s = rect(200, 100);
    const m = line([0, 0, 0], [2000, 0, 0], 4, s, [0, 0, 1]);
    m.force = [[4, 10000, 0, -1000]];
    const r = readCalculixFrame(m, runCcx(writeCalculixFrame(m)));
    const tip = (1000 * 2000 ** 3) / (3 * 210000 * s.i11);
    expect(r.displacement[3 * 4 + 2]! / -tip).toBeCloseTo(1, 4);
    expect(r.displacement[3 * 4]! / ((10000 * 2000) / (210000 * s.area))).toBeCloseTo(1, 4);
    expect(r.stress[0]! / (10000 / s.area + (1000 * 2000 * 100) / s.i11)).toBeCloseTo(1, 4);
    // Along the span the moment falls to 0 at the tip: the last element's root end, P·L/4 (the
    // .frd's 6 digits give it to about 4e-4).
    expect(Math.abs(r.forces[3]!.moment1[0]) / (1000 * 500)).toBeCloseTo(1, 3);
    expect(Math.abs(r.forces[3]!.moment1[1])).toBeLessThan(1000 * 500 * 1e-3);
    // An upright column pushed sideways, across its width: the second bending.
    const cs = rect(300, 200);
    const c = line([0, 0, 0], [0, 0, 3000], 2, cs, [1, 0, 0]);
    c.force = [[2, 0, 1000, 0]];
    const rc = readCalculixFrame(c, runCcx(writeCalculixFrame(c)));
    expect(rc.stress[0]! / ((1000 * 3000 * 100) / cs.i22)).toBeCloseTo(1, 4);
    const sway = (1000 * 3000 ** 3) / (3 * 210000 * cs.i22);
    expect(rc.displacement[3 * 2 + 1]! / sway).toBeCloseTo(1, 4);
  });

  it.skipIf(!hasCcx)('bends a round section about its resultant moment (ST-547#2)', () => {
    // A 100 mm bar, 1 m, pushed 1 kN sideways and 1 kN down at its tip: √2 kN·m at the root.
    const i = (Math.PI * 100 ** 4) / 64;
    const round: FrameSection = {
      area: (Math.PI * 100 ** 2) / 4,
      i11: i,
      i22: i,
      torsion: 2 * i,
      c1: 50,
      c2: 50,
      round: true,
    };
    const m = line([0, 0, 0], [1000, 0, 0], 4, round, [0, 0, 1]);
    m.force = [[4, 0, 1000, -1000]];
    expect(checkFrameModel(JSON.parse(JSON.stringify(m)))).toEqual(m);
    const r = readCalculixFrame(m, runCcx(writeCalculixFrame(m)));
    expect(r.stress[0]! / ((Math.SQRT2 * 1e6 * 50) / i)).toBeCloseTo(1, 4);
    // As a square corner it would be the sum: 20.4 MPa, not 14.4 MPa.
    const { round: _r, ...corner } = round;
    const c = { ...m, groups: [{ ...m.groups[0]!, section: corner }] };
    expect(
      readCalculixFrame(c, runCcx(writeCalculixFrame(c))).stress[0]! / r.stress[0]!,
    ).toBeCloseTo(Math.SQRT2, 4);
  });

  it.skipIf(!hasCcx)(
    'reads a portal frame, and refuses a result that does not fit (ST-547#2)',
    () => {
      // Two columns and a beam sharing their corners; the beam loaded in its middle.
      const nodes = [0, 0, 0, 0, 0, 3000, 2000, 0, 3000, 4000, 0, 3000, 4000, 0, 0];
      const m: FrameModel = {
        nodes,
        groups: [
          {
            section: rect(300, 300),
            depthDirection: [1, 0, 0],
            material: steel,
            elements: [0, 1, 4, 3],
          },
          {
            section: rect(400, 200),
            depthDirection: [0, 0, 1],
            material: steel,
            elements: [1, 2, 2, 3],
          },
        ],
        fixed: [0, 4],
        force: [[2, 0, 0, -10000]],
      };
      const frd = runCcx(writeCalculixFrame(m));
      const r = readCalculixFrame(m, frd);
      // Symmetric: the corners sink alike and sway apart alike, the middle sinks most.
      expect(r.displacement[3 * 2 + 2]!).toBeLessThan(r.displacement[3 * 1 + 2]!);
      expect(r.displacement[3 * 1 + 2]!).toBeCloseTo(r.displacement[3 * 3 + 2]!, 8);
      expect(r.displacement[3 * 1]!).toBeCloseTo(-r.displacement[3 * 3]!, 8);
      // Each column carries half the load; the joint's moments balance (beam end = column top).
      expect(r.forces[0]!.axial[0] / -5000).toBeCloseTo(1, 2);
      const beamEnd = Math.abs(r.forces[2]!.moment1[0]);
      expect(beamEnd / Math.abs(r.forces[0]!.moment1[1])).toBeCloseTo(1, 2);
      // A frd of another model, or cut short, is refused.
      expect(() => readCalculixFrame({ ...m, nodes: [...nodes, 0, 0, 9] }, frd)).toThrow(FrdError);
      expect(() => readCalculixFrame(m, frd.slice(0, frd.indexOf(' -4  DISP')))).toThrow(FrdError);
    },
  );
});
