import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { cadContentHash, type CadDocument } from '@editor-platform/cad-core';
import { evaluateCad, type CadAnalysisSurface } from '@editor-platform/cad-kernel-occt';
import { runShower, sealRibbon, type TriangleSurface } from '@editor-platform/geometry-cfd';
import { f98SealSimulation, type SimulationDocument } from '@editor-platform/simulation-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { runStudy } from './run';
import type { SealRunFields } from './run-seal';

/**
 * TS-2256 (ST-631): water on F98 (the gap box) with the kernel's surfaces: a nozzle sprays into the
 * slot in front of the lid on a 5° slope (the water on the pocket floor runs towards the seal).
 * Shut, the seal holds it (it ponds against the seal); with the lid 20 mm off the floor the seal
 * does not touch and the water goes in.
 */
const root = path.resolve(__dirname, '../../..');
const kernel = process.env.CAD_OCCT_DIST ?? path.join(root, 'work/cad-kernel');
const available = existsSync(path.join(kernel, cadKernelBuild.wasm));

describe.skipIf(!available)('F98 shower through the kernel (VS10a)', () => {
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

  const run = async ({ cad, doc }: { cad: CadDocument; doc: SimulationDocument }) => {
    const hash = cadContentHash(cad);
    const d = { ...doc, source: { ...doc.source, contentHash: hash } };
    const display = await evaluateCad(oc, cad, hash);
    const r = await runStudy(
      d,
      cad,
      hash,
      'seals',
      display.meshes.find((m) => m.bodyId === d.source.bodyId)!.topology,
      {
        builds: { kernel: cadKernelBuild.wasmSha256, mesher: 'none', solver: 'seal-measure' },
        surface: async (c, request) =>
          (await evaluateCad(oc, c, cadContentHash(c), { analysisSurface: request }))
            .analysisSurface!,
        mesh: () => {
          throw new Error('no mesh');
        },
      },
    );
    expect(r.failure, JSON.stringify(r.failure)).toBeUndefined();
    const seal = (r.fields as SealRunFields).seals[0]!;
    // Every surface the water meets: the box and the lid, at the seal run's deflection.
    const parts: CadAnalysisSurface[] = [];
    for (const bodyId of ['box', 'lid']) {
      const s = await evaluateCad(oc, cad, hash, {
        analysisSurface: { bodyId, deflectionMm: 0.2, clampDeflection: true },
      });
      parts.push((s.analysisSurface as { surface: CadAnalysisSurface }).surface);
    }
    return { seal, surface: merged(parts) };
  };

  const merged = (parts: CadAnalysisSurface[]): TriangleSurface => {
    const positions: number[] = [];
    const triangles: number[] = [];
    for (const s of parts) {
      const first = positions.length / 3;
      positions.push(...s.points);
      for (const t of s.triangles) triangles.push(first + t);
    }
    return { positions: new Float64Array(positions), triangles: new Uint32Array(triangles) };
  };

  const spray = async (clearance: number) => {
    const { seal, surface } = await run(f98SealSimulation({ clearance }));
    const tilt = (5 * Math.PI) / 180;
    return runShower({
      surface,
      seals: [
        {
          id: seal.sealId,
          ribbon: sealRibbon(seal.measurement, {
            diameterMm: seal.diameterMm,
            compressionMin: seal.compression[0],
            compressionMax: seal.compression[1],
            minBendRadiusMm: 0,
          }),
        },
      ],
      // The front slot runs y = −122 to −118 (the walls 2 mm outside the lid's outline, the lid
      // 2 mm inside); the seal is at y = −110, 12 mm in from the wall.
      emitters: [
        {
          kind: 'nozzle',
          origin: [0, -121, 400],
          direction: [0, 0, -1],
          coneDeg: 0,
          speedMmPerS: 3000,
          flowLPerMin: 0.1,
        },
      ],
      gravity: [0, 9810 * Math.sin(tilt), -9810 * Math.cos(tilt)],
      durationS: 3,
      stepS: 0.002,
      particlesPerS: 100,
      emitUntilS: 0.5,
    });
  };

  it('holds the water at the shut seal and lets it in with the lid lifted', async () => {
    const shut = await spray(10);
    expect(shut.particles).toBe(50);
    expect(shut.counts.entered).toBe(0);
    expect(shut.counts.pond).toBe(50);
    // Against the outside of the seal's ribbon (y = −110), on the pocket floor (z = 260).
    for (const p of shut.ponds) {
      expect(p.position[1]).toBeGreaterThan(-112);
      expect(p.position[1]).toBeLessThan(-109);
      expect(p.position[2]).toBeCloseTo(260, 3);
    }
    const open = await spray(20);
    expect(open.counts.entered).toBe(50);
    expect(open.enteredBySeal['lid-seal']).toBeCloseTo(50 * open.particleVolumeMm3, 6);
    for (const e of open.entries) expect(Math.abs(e.position[0])).toBeLessThan(10);
  }, 600_000);
});
