import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  cadContentHash,
  f99BrakeDisc,
  f99Disc,
  type CadDocument,
  type CadTopologyTable,
} from '@editor-platform/cad-core';
import { evaluateCad } from '@editor-platform/cad-kernel-occt';
import { meshSurfaceReport, type FemMesherModule } from '@editor-platform/fem-mesher';
import { femVolume } from '@editor-platform/geometry-fem';
import { validateSimulation } from '@editor-platform/simulation-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import {
  brakeDiscAnalysis,
  brakeFilmAmplitude,
  brakeTimes,
  discFilm,
  lumpedBrake,
  nagiBrakeCycle,
  type BrakeCycle,
} from './brake';
import { runStudy, type RunEnvironment } from './run';

/**
 * TS-2286 (ST-638 #2, #3): the F99 disc through `runStudy`. One stop with nothing cooling it
 * stores the stop's heat; the ten stops of 凪's fade test heat it stop by stop, its mean
 * temperature against a disc of one temperature with the same heat, film and radiation.
 * The ten stops run with `BRAKE_TEN=1`; `BRAKE_OUT` writes their history as JSON (the VS12 demo),
 * `BRAKE_FILM_SCALE` scales Limpert's film (VS12c: by the Host wind tunnel's, TS-2295).
 */
const root = path.resolve(__dirname, '../../..');
const kernel = process.env.CAD_OCCT_DIST ?? path.join(root, 'work/cad-kernel');
const mesher = process.env.FEM_MESHER_DIST ?? path.join(root, 'work/fem-mesher');
const available =
  existsSync(path.join(kernel, cadKernelBuild.wasm)) &&
  existsSync(path.join(mesher, 'fem-mesher.wasm'));

describe.skipIf(!available)('a brake test on the F99 disc (VS12a, TS-2286, ST-638)', () => {
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
  /** The disc, its table and its rubbed faces: the planes through the axis at y 0 and 18. */
  const disc = async () => {
    const cad: CadDocument = f99BrakeDisc();
    const bodyId = cad.bodies[0]!.id;
    const r = await evaluateCad(oc, cad, cadContentHash(cad));
    const table: CadTopologyTable = r.meshes.find((m) => m.bodyId === bodyId)!.topology;
    const onAxis = (y: number) =>
      table.faces.flatMap((f, i) =>
        Math.hypot(f.centroid[0], f.centroid[2]) < 0.5 && Math.abs(f.centroid[1] - y) < 0.5
          ? [i]
          : [],
      );
    const friction = [...onAxis(0), ...onAxis(f99Disc.ringThickness)];
    return { cad, bodyId, table, friction };
  };
  const ring = (inner: number) => Math.PI * (f99Disc.outerRadius ** 2 - inner ** 2);

  it('stores one stop’s heat when nothing cools it', async () => {
    const { cad, bodyId, table, friction } = await disc();
    expect(friction).toHaveLength(2);
    const cycle: BrakeCycle = { ...nagiBrakeCycle, stops: 1, period: 20 };
    const { doc, study, frictionArea } = brakeDiscAnalysis(
      cad,
      cadContentHash(cad),
      bodyId,
      table,
      {
        cycle,
        diameter: 2 * f99Disc.outerRadius,
        friction,
        film: false,
        emissivity: 0,
        step: 0.25,
        outputEvery: 8,
      },
    );
    // The outboard face runs 80–129 mm, the inboard 86–129.
    expect(frictionArea / (ring(f99Disc.hatRadius) + ring(f99Disc.ringInnerRadius))).toBeCloseTo(
      1,
      3,
    );
    expect(validateSimulation(doc)).toEqual([]);
    const run = await runStudy(doc, cad, cadContentHash(cad), study.id, table, env());
    expect(run.failure, JSON.stringify(run.failure)).toBeUndefined();
    const [level] = run.levels;
    for (const c of level!.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
    const fields = run.fields!;
    if (fields.kind !== 'transient-thermal') throw new Error('not transient');
    const iron = doc.materials[0]!;
    const capacity = iron.density * iron.specificHeat! * femVolume(fields.mesh);
    const h = fields.history;
    const stored = h.stored.at(-1)!;
    // The stored heat is the heat put in; against the stop's 127.6 kJ it is short by about the
    // right-end sampling of the falling heat, ½ Δt / t_brake ≈ 2.6 %.
    expect(Math.abs(stored - h.heatIn.at(-1)!) / stored).toBeLessThan(1e-4);
    const { energyPerStop, brake } = brakeTimes(cycle);
    expect(stored / energyPerStop).toBeGreaterThan(1 - 0.25 / brake);
    expect(stored / energyPerStop).toBeLessThan(1);
    // Its mean rise is the lumped disc's with the same steps.
    const lumped = lumpedBrake(
      cycle,
      {
        capacity,
        filmArea: 0,
        film: 0,
        radiantArea: 0,
        emissivity: 0,
        ambient: 293.15,
        start: 293.15,
      },
      brakeFilmAmplitude(cycle, 258, 0.25),
      0.25,
    );
    expect(stored / capacity / (lumped.temperature.at(-1)! - 293.15)).toBeCloseTo(1, 3);
    // The rubbed faces are hotter than the mean.
    expect(level!.metrics['max-temperature']!).toBeGreaterThan(293.15 + stored / capacity);
  }, 600_000);

  // About 10 min on the CPU (1 200 steps of 25 000 nodes): opt-in with `BRAKE_TEN=1`.
  it.skipIf(!process.env.BRAKE_TEN)(
    'heats the disc stop by stop through 凪’s ten stops, its mean as a lumped disc’s',
    async () => {
      const { cad, bodyId, table, friction } = await disc();
      const cycle = nagiBrakeCycle;
      const diameter = 2 * f99Disc.outerRadius;
      const { doc, study } = brakeDiscAnalysis(cad, cadContentHash(cad), bodyId, table, {
        cycle,
        diameter,
        friction,
        step: 1,
        outputEvery: 60,
        // VS12c: the Host wind tunnel's film near the wheel over Limpert's (TS-2295).
        ...(process.env.BRAKE_FILM_SCALE
          ? { filmScale: Number(process.env.BRAKE_FILM_SCALE) }
          : {}),
      });
      expect(validateSimulation(doc)).toEqual([]);
      const t0 = performance.now();
      const run = await runStudy(doc, cad, cadContentHash(cad), study.id, table, env());
      const seconds = (performance.now() - t0) / 1000;
      expect(run.failure, JSON.stringify(run.failure)).toBeUndefined();
      const [level] = run.levels;
      for (const c of level!.checks) expect(c.pass, `${c.name}: ${c.detail}`).toBe(true);
      const fields = run.fields!;
      if (fields.kind !== 'transient-thermal') throw new Error('not transient');
      const iron = doc.materials[0]!;
      const capacity = iron.density * iron.specificHeat! * femVolume(fields.mesh);
      const area = table.faces.reduce((a, f) => a + f.area, 0);
      const lumped = lumpedBrake(
        cycle,
        {
          capacity,
          filmArea: area,
          film: discFilm(cycle.speed, diameter) * Number(process.env.BRAKE_FILM_SCALE ?? 1),
          radiantArea: area,
          emissivity: 0.55,
          ambient: 293.15,
          start: 293.15,
        },
        brakeFilmAmplitude(cycle, diameter, 1),
        1,
      );
      const h = fields.history;
      const mean = Array.from(h.stored, (e) => 293.15 + e / capacity);
      const peak = (k: number) => {
        let hi = 0;
        h.time.forEach((s, i) => {
          if (s > k * 60 && s <= k * 60 + 10) hi = Math.max(hi, h.maxTemperature[i]!);
        });
        return hi;
      };
      const peaks = Array.from({ length: cycle.stops }, (_, k) => peak(k));
      const at = (s: number) => h.time.findIndex((x) => Math.abs(x - s) < 1e-6);
      let worst = 0;
      let signed = 0;
      h.time.forEach((_, i) => {
        const d = mean[i]! - lumped.temperature[i]!;
        if (Math.abs(d) > worst) [worst, signed] = [Math.abs(d), d];
      });
      expect(Number.isFinite(signed)).toBe(true);
      const rise = Math.max(...lumped.temperature) - 293.15;
      const out = {
        cycle,
        nodes: fields.mesh.nodes.length / 3,
        elements: fields.mesh.elements.length / (fields.mesh.type === 'tet10' ? 10 : 4),
        seconds,
        capacity,
        area,
        peaks,
        worstMeanVsLumped: signed,
        time: Array.from(h.time),
        max: Array.from(h.maxTemperature),
        min: Array.from(h.minTemperature),
        mean,
        lumped: Array.from(lumped.temperature),
      };
      console.log(
        `F99 ten stops: ${out.nodes} nodes, ${seconds.toFixed(1)} s, peaks ${peaks.map((p) => p.toFixed(0)).join(' ')} K, mean vs lumped ${worst.toFixed(1)} K of ${rise.toFixed(0)} K`,
      );
      if (process.env.BRAKE_OUT) writeFileSync(process.env.BRAKE_OUT, JSON.stringify(out));
      // Each stop's highest temperature is above the last; between stops the disc cools.
      for (let k = 1; k < cycle.stops; k++) expect(peaks[k]!).toBeGreaterThan(peaks[k - 1]!);
      expect(mean[at(59)]!).toBeLessThan(mean[at(10)]!);
      // The mean temperature follows the lumped disc's within 15 % of its rise. It runs above it:
      // the hat stays cooler than the mean and so gives off less than a disc of one temperature.
      expect(worst / rise).toBeLessThan(0.15);
    },
    1_800_000,
  );
});
