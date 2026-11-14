import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  cadContentHash,
  f95NagiAero,
  type CadDocument,
  type F95Options,
} from '@editor-platform/cad-core';
import { evaluateCad } from '@editor-platform/cad-kernel-occt';
import { aeroStudy, emptySimulation } from '@editor-platform/simulation-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { runStudy } from './run';
import { aeroAtYaw } from './run-aero';

/**
 * TS-2213 (ST-610 #2): 凪 (F95) in the browser wind tunnel through `runStudy`: the hard top, the
 * open car and the hard top without mirrors straight on, and a yaw sweep of the hard top. Opt-in
 * (`CFD_NAGI=1`, about 20 min per run at 60 mm on the CPU); `CFD_NAGI_CELL` (mm, default 60) and
 * `CFD_NAGI_STEPS` (default 4000) set the tunnel, `CFD_NAGI_OUT` writes the rows as JSON. The
 * numbers are for reference (V1): the test checks that the runs pass their checks and that the
 * roof and the mirrors change the drag.
 */
const root = path.resolve(__dirname, '../../..');
const kernel = process.env.CAD_OCCT_DIST ?? path.join(root, 'work/cad-kernel');
const run = !!process.env.CFD_NAGI && existsSync(path.join(kernel, cadKernelBuild.wasm));
const cellMm = Number(process.env.CFD_NAGI_CELL ?? 60);
const steps = Number(process.env.CFD_NAGI_STEPS ?? 4000);

describe.skipIf(!run)('凪 in the wind tunnel (VS4d)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let oc: any;
  beforeAll(async () => {
    const wasm = readFileSync(path.join(kernel, cadKernelBuild.wasm));
    expect(createHash('sha256').update(wasm).digest('hex')).toBe(cadKernelBuild.wasmSha256);
    globalThis.require ??= createRequire(import.meta.url);
    const { default: factory } = await import(
      pathToFileURL(path.join(kernel, cadKernelBuild.js)).href
    );
    oc = await factory({ wasmBinary: wasm });
  }, 300_000);

  /** The analysis of a variant: the skin with every other body, one wind tunnel. */
  const analysis = (cad: CadDocument) => {
    const doc = {
      ...emptySimulation(
        {
          artifactId: 'nagi',
          versionId: 'v1',
          contentHash: cadContentHash(cad),
          bodyId: 'skin',
        },
        '凪 wind tunnel',
      ),
      schemaVersion: 2 as const,
      bodies: cad.bodies
        .filter((b) => b.id !== 'skin')
        .map((b) => ({ bodyId: b.id, materialId: null })),
    };
    const study = aeroStudy('tunnel');
    study.aero.browserCellMm = cellMm;
    study.solver.maxIterations = steps;
    doc.studies.push(study);
    return doc;
  };
  const tunnel = async (options: F95Options, yawDeg = 0) => {
    const cad = f95NagiAero(options);
    const doc = aeroAtYaw(analysis(cad), 'tunnel', yawDeg);
    const started = Date.now();
    const r = await runStudy(
      doc,
      cad,
      cadContentHash(cad),
      'tunnel',
      (await evaluateCad(oc, cad, cadContentHash(cad))).meshes.find((m) => m.bodyId === 'skin')!
        .topology,
      {
        builds: { kernel: cadKernelBuild.wasmSha256, mesher: 'none', solver: 'geometry-cfd' },
        surface: async (c, request) =>
          (await evaluateCad(oc, c, cadContentHash(c), { analysisSurface: request }))
            .analysisSurface!,
        mesh: () => {
          throw new Error('no mesh');
        },
      },
    );
    expect(r.failure, JSON.stringify(r.failure)).toBeUndefined();
    const level = r.levels.at(-1)!;
    expect(level.checks.every((c) => c.pass)).toBe(true);
    return {
      roof: options.roof ?? 'hardtop',
      mirrors: options.mirrors ?? true,
      yawDeg,
      cd: level.metrics['drag-coefficient']!,
      cl: level.metrics['lift-coefficient']!,
      cs: level.metrics['side-force-coefficient']!,
      cells: level.nodes,
      seconds: Math.round((Date.now() - started) / 1000),
      solver: level.checks.find((c) => c.name === 'solver')!.detail,
    };
  };

  const rows: Awaited<ReturnType<typeof tunnel>>[] = [];
  const keep = (row: Awaited<ReturnType<typeof tunnel>>) => {
    rows.push(row);
    // Written after each run, so a long sweep leaves what it has.
    if (process.env.CFD_NAGI_OUT)
      writeFileSync(process.env.CFD_NAGI_OUT, JSON.stringify({ cellMm, steps, rows }, null, 2));
    return row;
  };
  const hour = 60 * 60 * 1000;

  it(
    'changes the drag with the roof and the mirrors',
    async () => {
      const hardtop = keep(await tunnel({}));
      const open = keep(await tunnel({ roof: 'open' }));
      const bare = keep(await tunnel({ mirrors: false }));
      // By how much is for reference (V1).
      expect(Math.abs(open.cd / hardtop.cd - 1)).toBeGreaterThan(0.01);
      expect(bare.cd).not.toBe(hardtop.cd);
    },
    hour,
  );

  it(
    'pushes the car to +y more as the yaw grows',
    async () => {
      const side = [];
      for (const yaw of [0, 5, 10, 15]) side.push(keep(await tunnel({}, yaw)).cs);
      expect(side[1]!).toBeGreaterThan(side[0]!);
      expect(side[3]!).toBeGreaterThan(side[1]!);
    },
    hour,
  );
});
