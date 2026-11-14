import { describe, expect, it } from 'vitest';
import {
  aeroCase,
  aeroCommands,
  aeroLimits,
  ahmedBody,
  ahmedSizes,
  checkAeroJob,
  checkSurface,
  parseForceCoeffs,
  parseSurfacePressure,
  parseSurfaceSample,
} from './index';

const ahmed = ahmedBody(25);
const job = (over: Record<string, unknown> = {}) => ({
  kind: 'aero',
  surface: { positions: Array.from(ahmed.positions), triangles: Array.from(ahmed.triangles) },
  speed: 40,
  yawDeg: 0,
  ground: 'fixed',
  mesh: { baseMm: 160, level: 4 },
  iterations: 600,
  referenceAreaMm2: ahmedSizes.width * ahmedSizes.height,
  ...over,
});

// TS-2204 (ST-602 #1, #2): the Ahmed body, the job's check, the case's templates and the parsers.
describe('F96 Ahmed body', () => {
  it('is closed at its sizes for 0°, 25° and 35°', () => {
    for (const slant of [0, 25, 35]) {
      const s = ahmedBody(slant);
      expect(() => checkSurface(s)).not.toThrow();
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      s.positions.forEach((v, i) => {
        lo[i % 3] = Math.min(lo[i % 3]!, v);
        hi[i % 3] = Math.max(hi[i % 3]!, v);
      });
      expect(hi.map((v, a) => v - lo[a]!)).toEqual([1044, 389, 288]);
      expect(lo[2]).toBe(50);
    }
    // The 25° slant drops 222 sin 25° at the tail.
    const tail = Array.from({ length: 4 }, (_, k) => ahmed.positions[3 * k + 2]!);
    expect(Math.max(...tail)).toBeCloseTo(338 - 222 * Math.sin((25 * Math.PI) / 180), 9);
  });
});

describe('aero job (VS3)', () => {
  it('checks every field and refuses what it does not know', () => {
    // TS-2204, ST-602.
    expect(checkAeroJob(job()).speed).toBe(40);
    const refused = (over: Record<string, unknown>, re: RegExp) =>
      expect(() => checkAeroJob(job(over))).toThrow(re);
    refused({ extra: 1 }, /job-invalid.*unknown field "extra"/);
    refused({ kind: 'thermal' }, /job-invalid/);
    refused({ speed: 0 }, /speed/);
    refused({ speed: '40' }, /speed/);
    refused({ yawDeg: 30 }, /yawDeg/);
    refused({ ground: 'rolling' }, /ground/);
    refused({ mesh: { baseMm: 160, level: 4, dict: '#include "x"' } }, /unknown field "dict"/);
    refused({ mesh: { baseMm: 160, level: 2.5 } }, /whole number/);
    refused({ iterations: aeroLimits.iterations + 1 }, /iterations/);
    refused({ mesh: { baseMm: 10, level: 4 } }, /background cells/);
    refused({ mesh: { baseMm: 2000, level: 0 } }, /higher level/);
    const below = Array.from(ahmed.positions, (v, i) => (i % 3 === 2 ? v - 100 : v));
    refused(
      { surface: { positions: below, triangles: Array.from(ahmed.triangles) } },
      /above the ground/,
    );
    refused(
      {
        surface: {
          positions: Array.from(ahmed.positions),
          triangles: Array.from(ahmed.triangles).slice(3),
        },
      },
      /surface-open/,
    );
    refused(
      {
        surface: {
          positions: Array.from(ahmed.positions),
          triangles: Array.from(ahmed.triangles),
          path: '/etc',
        },
      },
      /unknown field "path"/,
    );
    // An index past the points (here one that a 32-bit array would wrap back into range).
    refused(
      {
        surface: {
          positions: Array.from(ahmed.positions),
          triangles: Array.from(ahmed.triangles, (v) => v + 2 ** 32),
        },
      },
      /point indices/,
    );
  });

  it('writes the case from fixed templates with nothing that runs commands', () => {
    // TS-2204, ST-602.
    const c = aeroCase(checkAeroJob(job({ yawDeg: 10, ground: 'moving' })));
    expect(Object.keys(c.files).sort()).toEqual([
      '0/U',
      '0/k',
      '0/nut',
      '0/omega',
      '0/p',
      'constant/transportProperties',
      'constant/triSurface/body.stl',
      'constant/turbulenceProperties',
      'system/blockMeshDict',
      'system/controlDict',
      'system/decomposeParDict',
      'system/fvSchemes',
      'system/fvSolution',
      'system/snappyHexMeshDict',
    ]);
    for (const [path, text] of Object.entries(c.files)) {
      // No directive (#include, #codeStream, #calc) and no coded function object.
      expect(text, path).not.toMatch(/#(include|codeStream|calc|eval)|\bcoded\b|systemCall/);
    }
    expect(c.files['system/controlDict']).toContain('allowSystemOperations 0;');
    // The wall shear on the body is sampled with p, for Cf and the heat transfer coefficient.
    expect(c.files['system/controlDict']).toMatch(/type wallShearStress;[\s\S]*patches \(body\);/);
    expect(c.files['system/controlDict']).toContain('fields (p wallShearStress);');
    // The STL is in metres; the air comes from the front turned 10° from the left.
    expect(c.files['constant/triSurface/body.stl']).toMatch(/vertex 1\.044\d* /);
    const u = /internalField uniform \(([^)]*)\)/.exec(c.files['0/U']!)![1]!.split(' ').map(Number);
    expect(u[0]).toBeCloseTo(-40 * Math.cos(Math.PI / 18), 6);
    expect(u[1]).toBeCloseTo(40 * Math.sin(Math.PI / 18), 6);
    expect(c.files['0/U']).toMatch(/ground \{ type fixedValue; value uniform \(-39\.39/);
    // With a yaw the crosswind passes through the sides; the top stays a slip wall.
    expect(c.files['0/U']).toMatch(
      /sides \{ type freestreamVelocity; freestreamValue uniform \(-39\.39/,
    );
    expect(c.files['0/p']).toMatch(/sides \{ type freestreamPressure;/);
    expect(c.files['0/k']).toMatch(/sides \{ type inletOutlet;/);
    expect(c.files['0/U']).toMatch(/top \{ type slip; \}/);
    const straight = aeroCase(checkAeroJob(job()));
    expect(straight.files['0/U']).toMatch(/sides \{ type slip; \}/);
    expect(c.files['system/decomposeParDict']).toContain('numberOfSubdomains 4;');
    expect(aeroCommands(c.processes).map((s) => s.program)).toEqual([
      'blockMesh',
      'snappyHexMesh',
      'checkMesh',
      'decomposePar',
      'mpirun',
    ]);
    expect(aeroCommands(1).at(-1)).toEqual({ program: 'simpleFoam', args: [] });
  });

  it('reads the coefficients and the surface pressure', () => {
    // TS-2204, ST-602.
    const dat = [
      '# Force coefficients',
      '# Time Cd Cs Cl CmRoll CmPitch CmYaw Cd(f) Cd(r) Cs(f) Cs(r) Cl(f) Cl(r)',
      ...Array.from({ length: 10 }, (_, i) =>
        [i + 1, i < 8 ? 0.5 : 0.3, 0.01, 0.2, 0, 0, 0, 0.15, 0.15, 0, 0, 0.05, 0.15].join('\t'),
      ),
    ].join('\n');
    const r = parseForceCoeffs(dat);
    expect(r.cd).toBeCloseTo(0.3, 12);
    expect(r.cl).toBeCloseTo(0.2, 12);
    expect(r.clFront).toBeCloseTo(0.05, 12);
    expect(r.clRear).toBeCloseTo(0.15, 12);
    expect(r.history).toHaveLength(10);
    expect(() => parseForceCoeffs('# nothing')).toThrow(/column/);
    // A run that blew up at the end is refused, not averaged over its earlier iterations.
    const blown = dat.replace(/\n10\t0\.3/, '\n10\tnan');
    expect(() => parseForceCoeffs(blown)).toThrow(/unstable/);
    const raw = '#  x  y  z  p\n0.1 0 0.2 800\n0.2 0 0.2 -400\n';
    const s = parseSurfacePressure(raw, 40);
    expect(Array.from(s.points)).toEqual([100, 0, 200, 200, 0, 200]);
    expect(Array.from(s.cp)).toEqual([1, -0.5]);
    // TS-2208 (ST-606): Cf and the heat transfer coefficient from the wall shear, face by face.
    const shear =
      '#  x  y  z  wallShearStress_x wallShearStress_y wallShearStress_z\n0.1 0 0.2 1.6 0 0\n0.2 0 0.2 0 1.2 1.6\n';
    const both = parseSurfaceSample(raw, shear, 40);
    expect(both.points).toEqual([100, 0, 200, 200, 0, 200]);
    expect(both.cp).toEqual([1, -0.5]);
    expect(both.cf).toEqual([0.002, 0.0025]);
    // h = ½ ρ cp U Cf = 0.5 · 1.2 · 1005 · 40 · 0.002.
    expect(both.htc[0]).toBeCloseTo(48.24, 10);
    expect(both.htc[1]).toBeCloseTo(60.3, 10);
    expect(() => parseSurfaceSample(raw, shear.replace('0.2 0 0.2 0', '0.3 0 0.2 0'), 40)).toThrow(
      /different faces/,
    );
    expect(() => parseSurfaceSample(raw, shear.split('\n').slice(0, 2).join('\n'), 40)).toThrow(
      /different faces/,
    );
    // Codex on #1185: no sampled face (missing outputs read as empty) is not a field of zeros.
    expect(() => parseSurfaceSample('', '', 40)).toThrow(/hold no face/);
    expect(() => parseSurfaceSample(raw, shear.replace('1.6 0 0', 'nan 0 0'), 40)).toThrow(
      /unstable/,
    );
  });
});

describe('OpenFOAM runner (VS3)', () => {
  it('stops the whole step, with the processes it started, on the time limit', async () => {
    // TS-2204, ST-602: mpirun starts solvers; a timeout must not wait for them.
    const { existsSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { runOpenFoamCase } = await import('../../../scripts/cfd/openfoam-run.mjs');
    const dir = mkdtempSync(path.join(tmpdir(), 'of-run-'));
    try {
      const rc = path.join(dir, 'rc.sh');
      writeFileSync(rc, '');
      const started = Date.now();
      await expect(
        runOpenFoamCase({
          dir,
          files: {},
          commands: [{ program: 'bash', args: ['-c', 'sleep 5 & wait'] }],
          bashrc: rc,
          timeoutMs: 200,
        }),
      ).rejects.toThrow(/bash failed/);
      expect(Date.now() - started).toBeLessThan(2000);
      // Cancelled from the phase observer: the step does not start.
      const controller = new AbortController();
      await expect(
        runOpenFoamCase({
          dir,
          files: {},
          commands: [{ program: 'touch', args: ['ran'] }],
          bashrc: rc,
          timeoutMs: 5000,
          signal: controller.signal,
          onPhase: () => controller.abort(),
        }),
      ).rejects.toThrow(/cancelled/);
      expect(existsSync(path.join(dir, 'ran'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
