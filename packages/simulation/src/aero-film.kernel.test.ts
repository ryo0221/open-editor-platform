import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  cadContentHash,
  f95Nagi,
  f95NagiAero,
  f99Disc,
  f102Exhaust,
} from '@editor-platform/cad-core';
import { evaluateCad } from '@editor-platform/cad-kernel-occt';
import type { AeroHostResult, AeroJob } from '@editor-platform/geometry-cfd';
import { aeroStudy, emptySimulation } from '@editor-platform/simulation-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { createSimulationJobs, referenceAero } from '../../../scripts/dev/simulation-host.mjs';
import { aeroFaceFilms, aeroRegionFilm, type AeroFilm } from './aero-film';
import { brakeAir, discFilm, kmh } from './brake';
import { plateFilm } from './exhaust';
import { runStudy } from './run';

/**
 * TS-2295 (ST-638 #7, VS12c): 凪 (F95, hard top) in the Host's wind tunnel (OpenFOAM, 30 m/s,
 * moving ground), its heat transfer on the faces and on the parts of the car the VS12 examples
 * stand for: the floor ahead of the rear axle (the exhaust and the tank, F102) and the front wheels'
 * outer faces (the disc, F99), each against the empirical film the examples use. Opt-in: the CAD
 * kernel and `CFD_OPENFOAM` (the env file, as in TS-2209); `CFD_NAGI_LEVEL` (default 5) and
 * `CFD_NAGI_ITERATIONS` (default 400) set the case, `CFD_NAGI_FILMS_OUT` writes the films as JSON
 * (the demo feeds them to TS-2286 and TS-2288 through `BRAKE_FILM_SCALE` and `EXHAUST_UNDER_FILM`).
 */
const root = path.resolve(__dirname, '../../..');
const kernel = process.env.CAD_OCCT_DIST ?? path.join(root, 'work/cad-kernel');
const openfoam = process.env.CFD_OPENFOAM;
const run = !!openfoam && existsSync(path.join(kernel, cadKernelBuild.wasm));

const servers: Server[] = [];
const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
  for (const s of servers) s.close();
});

/** The reference Host on a local port, its wind tunnel on `bashrc`. */
async function host(bashrc: string) {
  const jobs = createSimulationJobs({
    limits: { bytes: 64 * 1024 * 1024 },
    toInp: async () => ({ inp: '' }),
    aero: referenceAero((m: string) => import(/* @vite-ignore */ m), bashrc),
  });
  closers.push(jobs.close);
  const server = createServer((req, res) => {
    void jobs.handle(req, res, () => {
      res.writeHead(404);
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__simulation-host`;
  return async (job: AeroJob): Promise<AeroHostResult> => {
    const posted = await fetch(`${url}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(job),
    });
    const { id } = (await posted.json()) as { id: string };
    let s: { state: string; message?: string } = { state: 'queued' };
    while (!['done', 'failed'].includes(s.state)) {
      await new Promise((r) => setTimeout(r, 2000));
      s = (await (await fetch(`${url}/jobs/${id}`)).json()) as typeof s;
    }
    if (s.state !== 'done') throw new Error(`the Host's wind tunnel failed: ${s.message}`);
    return (await (await fetch(`${url}/jobs/${id}/result`)).json()) as AeroHostResult;
  };
}

/** Turbulent flat plate, local (Incropera 7.36), at `x` (mm) from the nose: mW/(mm²·K). */
const plateLocal = (speed: number, x: number) =>
  (0.0296 * ((speed * x) / brakeAir.viscosity) ** 0.8 * 0.71 ** (1 / 3) * brakeAir.conductivity) /
  x;

describe.skipIf(!run)('凪’s films from the Host wind tunnel (VS12c, TS-2295)', () => {
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

  it(
    'maps the heat transfer onto the faces and compares it with the empirical films',
    async () => {
      const cad = f95NagiAero({});
      const hash = cadContentHash(cad);
      const doc = {
        ...emptySimulation(
          { artifactId: 'nagi', versionId: 'v1', contentHash: hash, bodyId: 'skin' },
          '凪 wind tunnel',
        ),
        schemaVersion: 2 as const,
        bodies: cad.bodies
          .filter((b) => b.id !== 'skin')
          .map((b) => ({ bodyId: b.id, materialId: null })),
      };
      const study = aeroStudy('tunnel', '凪 wind tunnel', f95Nagi.length);
      study.aero.host.level = Number(process.env.CFD_NAGI_LEVEL ?? 5);
      study.aero.host.iterations = Number(process.env.CFD_NAGI_ITERATIONS ?? 400);
      doc.studies.push(study);
      const solveAero = await host(openfoam!);
      const evaluated = await evaluateCad(oc, cad, hash);
      const started = Date.now();
      const r = await runStudy(
        doc,
        cad,
        hash,
        'tunnel',
        evaluated.meshes.find((m) => m.bodyId === 'skin')!.topology,
        {
          builds: { kernel: cadKernelBuild.wasmSha256, mesher: 'none', solver: 'openfoam' },
          surface: async (c, request) =>
            (await evaluateCad(oc, c, cadContentHash(c), { analysisSurface: request }))
              .analysisSurface!,
          mesh: () => {
            throw new Error('no mesh');
          },
          remote: {
            name: 'Host',
            limits: { nodes: 1, elements: 1 },
            solve: () => Promise.reject(new Error('not a mesh')),
            solveAero,
          },
        },
      );
      const seconds = Math.round((Date.now() - started) / 1000);
      expect(r.failure, JSON.stringify(r.failure)).toBeUndefined();
      const fields = r.fields;
      if (fields?.kind !== 'aero') throw new Error('no wind-tunnel fields');
      const speed = study.aero.speed * 1000;
      const summary = (f: AeroFilm) => ({
        film: f.film,
        area: Math.round(f.area),
        centroid: f.centroid.map(Math.round),
        normal: f.normal.map((x) => Math.round(x * 100) / 100),
      });
      // Every face of every body the tunnel saw, with its film.
      const faces = Object.fromEntries(
        fields.bodies!.ids.map((id) => [
          id,
          [...aeroFaceFilms(fields, id)].map(([face, f]) => ({ face, ...summary(f) })),
        ]),
      );
      for (const id of fields.bodies!.ids) expect(faces[id]!.length).toBeGreaterThan(0);
      // The floor ahead of the rear axle, facing the road: where F102 stands for.
      const rear = f95Nagi.axles.rear;
      const floorBox = { min: [rear + 300, -400, 0], size: [600, 800, 600] };
      const floor = aeroRegionFilm(fields, floorBox, [0, 0, -1]);
      const fromNose = f95Nagi.length - floor.centroid[0];
      // The front wheels' outer faces (the wheels are cylinders along y): the face of each front
      // wheel whose normal points away from the car's middle. F95 has no wheel wells and its
      // wheels do not turn: the outer face lies about on the skin's side (853 mm out), so its air
      // is the side's, not a turning wheel's (Limpert's).
      const wheels = ['wheel-fl', 'wheel-fr'].map((id) => {
        const outer = [...aeroFaceFilms(fields, id).values()]
          .filter((f) => Math.abs(f.normal[1]) > 0.9 && f.normal[1] * f.centroid[1] > 0)
          .sort((a, b) => Math.abs(b.centroid[1]) - Math.abs(a.centroid[1]))[0];
        if (!outer) throw new Error(`${id} has no outer face in the tunnel`);
        return { id, ...summary(outer) };
      });
      const wheel =
        wheels.reduce((a, w) => a + w.film * w.area, 0) / wheels.reduce((a, w) => a + w.area, 0);
      const diameter = 2 * f99Disc.outerRadius;
      // What the VS12 examples use: Limpert at the car's speed, the plate at half of 100 km/h.
      const exhaustSpeed = kmh(50);
      const out = {
        speedMmS: speed,
        level: study.aero.host.level,
        iterations: study.aero.host.iterations,
        seconds,
        cd: r.levels.at(-1)!.metrics['drag-coefficient'],
        triangles: fields.triangles.length / 3,
        floor: {
          ...summary(floor),
          fromNose,
          plateLocal: plateLocal(speed, fromNose),
          plateMean: plateFilm(speed, fromNose),
          // The exhaust example's air: the tunnel's film scaled to its speed (h ∝ U^0.8).
          atExhaustSpeed: floor.film * (exhaustSpeed / speed) ** 0.8,
          exhaustPlate: plateFilm(exhaustSpeed, f102Exhaust.floor.size[0]),
        },
        wheels,
        wheel: {
          film: wheel,
          limpert: discFilm(speed, diameter),
          scale: wheel / discFilm(speed, diameter),
        },
        faces,
      };
      console.log(
        `凪 on the Host (level ${out.level}, ${seconds} s): Cd ${out.cd?.toFixed(3)}, floor ${(floor.film * 1e3).toFixed(1)} W/m²K (plate local ${(out.floor.plateLocal * 1e3).toFixed(1)}), front wheels ${(wheel * 1e3).toFixed(1)} W/m²K (Limpert ${(out.wheel.limpert * 1e3).toFixed(1)})`,
      );
      if (process.env.CFD_NAGI_FILMS_OUT)
        writeFileSync(process.env.CFD_NAGI_FILMS_OUT, JSON.stringify(out, null, 2));
      // Air cools: films above still air and below what a plate a centimetre from its edge gets.
      for (const h of [floor.film, wheel]) {
        expect(h).toBeGreaterThan(0.002);
        expect(h).toBeLessThan(plateLocal(speed, 10));
      }
    },
    2 * 60 * 60 * 1000,
  );
});
