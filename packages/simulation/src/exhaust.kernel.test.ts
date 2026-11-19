import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  cadContentHash,
  f102Exhaust,
  f102ExhaustFloor,
  type CadTopologyTable,
} from '@editor-platform/cad-core';
import { evaluateCad } from '@editor-platform/cad-kernel-occt';
import { meshSurfaceReport, type FemMesherModule } from '@editor-platform/fem-mesher';
import { validateSimulation } from '@editor-platform/simulation-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { exhaustAnalysis, regionMax, tankLimit } from './exhaust';
import { runStudy, type RunEnvironment } from './run';

/**
 * TS-2288 (ST-638 #4): the exhaust under the floor, without (F102) and with (F103) the heat
 * shield, 30 min with the gas at 873 K after a 2 min warm-up. The shield lowers the floor's and
 * the tank's temperature; both are compared with the tank's limit. `EXHAUST_OUT` writes the
 * numbers as JSON (the VS12 demo); `EXHAUST_UNDER_FILM` (mW/(mm²·K)) replaces the plate's film
 * under the car (VS12c: the Host wind tunnel's, TS-2295).
 */
const root = path.resolve(__dirname, '../../..');
const kernel = process.env.CAD_OCCT_DIST ?? path.join(root, 'work/cad-kernel');
const mesher = process.env.FEM_MESHER_DIST ?? path.join(root, 'work/fem-mesher');
const available =
  existsSync(path.join(kernel, cadKernelBuild.wasm)) &&
  existsSync(path.join(mesher, 'fem-mesher.wasm'));

describe.skipIf(!available)(
  'the exhaust’s heat in the floor and tank (VS12b, TS-2288, ST-638)',
  () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let oc: any;
    let fem: FemMesherModule;
    beforeAll(async () => {
      const wasm = readFileSync(path.join(kernel, cadKernelBuild.wasm));
      expect(createHash('sha256').update(wasm).digest('hex')).toBe(cadKernelBuild.wasmSha256);
      globalThis.require ??= createRequire(import.meta.url);
      const { default: factory } = await import(
        pathToFileURL(path.join(kernel, cadKernelBuild.js)).href
      );
      oc = await factory({ wasmBinary: wasm });
      const create = (await import(pathToFileURL(path.join(mesher, 'fem-mesher.mjs')).href)) as {
        default: () => Promise<FemMesherModule>;
      };
      fem = await create.default();
    }, 300_000);

    const env = (): RunEnvironment => ({
      builds: { kernel: cadKernelBuild.wasmSha256, mesher: 'fem-mesher', solver: 'geometry-fem' },
      surface: async (cad, request) =>
        (await evaluateCad(oc, cad, cadContentHash(cad), { analysisSurface: request }))
          .analysisSurface!,
      mesh: (surface, settings) => meshSurfaceReport(fem, surface, settings),
    });

    const solve = async (shield: boolean) => {
      const cad = f102ExhaustFloor({ shield });
      const bodyId = cad.bodies[0]!.id;
      const r = await evaluateCad(oc, cad, cadContentHash(cad));
      const evaluated = r.meshes.find((m) => m.bodyId === bodyId)!;
      const table: CadTopologyTable = evaluated.topology;
      const { doc, study, faces } = exhaustAnalysis(cad, cadContentHash(cad), bodyId, table, {
        scene: f102Exhaust,
        shield,
        gas: 873.15,
        gasAmplitude: { times: [0, 120], factors: [293.15 / 873.15, 1] },
        // VS12c: the Host wind tunnel's film on 凪's floor (TS-2295).
        ...(process.env.EXHAUST_UNDER_FILM
          ? { underFilm: Number(process.env.EXHAUST_UNDER_FILM) }
          : {}),
      });
      expect(faces.pipe.length).toBeGreaterThan(0);
      expect(faces.floorUnder).toHaveLength(1);
      expect(faces.shield.length > 0).toBe(shield);
      expect(validateSimulation(doc)).toEqual([]);
      const t0 = performance.now();
      const run = await runStudy(doc, cad, cadContentHash(cad), study.id, table, env());
      const seconds = (performance.now() - t0) / 1000;
      expect(
        run.failure,
        `${shield ? 'F103' : 'F102'}: ${JSON.stringify(run.failure)}`,
      ).toBeUndefined();
      const [level] = run.levels;
      for (const c of level!.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
      const fields = run.fields!;
      if (fields.kind !== 'transient-thermal') throw new Error('not transient');
      const { floor, tank } = f102Exhaust;
      const tankBox = { min: [tank.min[0], tank.min[1], tank.min[2] + 1], size: tank.size };
      const series = fields.temperatures.map((T, i) => ({
        time: fields.times[i]!,
        floor: regionMax(fields.mesh, T, floor),
        tank: regionMax(fields.mesh, T, tankBox),
      }));
      return {
        shield,
        nodes: fields.mesh.nodes.length / 3,
        seconds,
        series,
        last: series.at(-1)!,
      };
    };

    it('lowers the floor and tank temperatures with the shield', async () => {
      const bare = await solve(false);
      const shielded = await solve(true);
      // The floor warms over the run, and more without the shield.
      expect(bare.last.floor).toBeGreaterThan(bare.series[1]!.floor);
      expect(shielded.last.floor).toBeLessThan(bare.last.floor);
      expect(shielded.last.tank).toBeLessThan(bare.last.tank);
      for (const r of [bare, shielded])
        console.log(
          `${r.shield ? 'F103 with shield' : 'F102 bare'}: ${r.nodes} nodes, ${r.seconds.toFixed(1)} s, floor ${r.last.floor.toFixed(1)} K, tank ${r.last.tank.toFixed(1)} K (limit ${tankLimit} K: ${r.last.tank <= tankLimit ? 'within' : 'over'})`,
        );
      if (process.env.EXHAUST_OUT)
        writeFileSync(process.env.EXHAUST_OUT, JSON.stringify({ tankLimit, bare, shielded }));
    }, 1_800_000);
  },
);
