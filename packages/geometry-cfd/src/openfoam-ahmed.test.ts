import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { readAeroOutputs, runOpenFoamCase } from '../../../scripts/cfd/openfoam-run.mjs';
import {
  aeroCase,
  aeroCommands,
  ahmedBody,
  ahmedSizes,
  checkAeroJob,
  parseForceCoeffs,
} from './index';

/**
 * TS-2205 (ST-602 #3): the Ahmed body (F96) in OpenFOAM against Ahmed, Ramm and Faltin (1984):
 * Cd 0.285 at 25° (±15% of the 0.28–0.30 range), and 0° and 35° below 25°. A long run against a
 * real OpenFOAM (three cases, 4 processes each, one at a time); it runs only with CFD_OPENFOAM set,
 * to `1` for the default `bashrc` or to the path of another OpenFOAM's `etc/bashrc`. The mesh, the
 * times and the values are in docs/verification/vehicle-sim/README.md.
 */
const env = process.env.CFD_OPENFOAM;
const bashrc = env && env !== '1' ? env : undefined;
const base = Number(process.env.CFD_OPENFOAM_BASE ?? 160);
const level = Number(process.env.CFD_OPENFOAM_LEVEL ?? 6);
const iterations = Number(process.env.CFD_OPENFOAM_ITERATIONS ?? 400);

async function ahmedCd(slant: number): Promise<number> {
  const body = ahmedBody(slant);
  const job = checkAeroJob({
    kind: 'aero',
    surface: { positions: Array.from(body.positions), triangles: Array.from(body.triangles) },
    speed: 40,
    yawDeg: 0,
    ground: 'fixed',
    mesh: { baseMm: base, level },
    iterations,
    referenceAreaMm2: ahmedSizes.width * ahmedSizes.height,
  });
  const c = aeroCase(job);
  const dir = mkdtempSync(path.join(tmpdir(), `ahmed-${slant}-`));
  try {
    await runOpenFoamCase({
      dir,
      files: c.files,
      commands: aeroCommands(c.processes),
      bashrc,
      timeoutMs: 60 * 60 * 1000,
    });
    const out = await readAeroOutputs(dir);
    return parseForceCoeffs(out.coefficients).cd;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it.skipIf(!env)(
  'gives the Ahmed body drag at 25° within 15% of the experiment, with 0° and 35° below it',
  async () => {
    const cd25 = await ahmedCd(25);
    const cd0 = await ahmedCd(0);
    const cd35 = await ahmedCd(35);
    expect(cd25).toBeGreaterThan(0.28 * 0.85);
    expect(cd25).toBeLessThan(0.3 * 1.15);
    expect(cd0).toBeLessThan(cd25);
    expect(cd35).toBeLessThan(cd25);
  },
  3 * 60 * 60 * 1000,
);
