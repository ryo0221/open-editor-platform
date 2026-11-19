import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { cadContentHash, type CadDocument } from '@editor-platform/cad-core';
import { evaluateCad } from '@editor-platform/cad-kernel-occt';
import {
  f98SealSimulation,
  showerStudy,
  type SimulationDocument,
  type SimulationShowerStudy,
} from '@editor-platform/simulation-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';
import { showerMesh } from './results';
import { runStudy } from './run';
import { placed, samePlace, type ShowerRunFields } from './run-shower';

/**
 * TS-2258 (ST-632): a shower study on F98 (the gap box) through `runStudy` with the kernel: a
 * nozzle into the slot in front of the lid with the box rolled 5° (its −y side up, so the water
 * on the pocket floor runs to the seal). Shut, nothing goes in; with the lid 20 mm off the floor,
 * the water goes in at the front. Then rain on the box shut: nothing goes in.
 */
const root = path.resolve(__dirname, '../../..');
const kernel = process.env.CAD_OCCT_DIST ?? path.join(root, 'work/cad-kernel');
const available = existsSync(path.join(kernel, cadKernelBuild.wasm));

describe.skipIf(!available)('F98 shower study through the kernel (VS10b)', () => {
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
      'shower',
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
    return { r, f: r.fields as ShowerRunFields, metrics: r.levels[0]!.metrics };
  };

  const shower = (clearance: number, settings: Partial<SimulationShowerStudy['shower']> = {}) => {
    const { cad, doc } = f98SealSimulation({ clearance });
    const s = showerStudy('shower');
    s.shower = {
      ...s.shower,
      rain: null,
      nozzles: [
        {
          id: 'front',
          name: 'Front slot',
          origin: [0, -121, 400],
          direction: [0, 0, -1],
          coneDeg: 0,
          speedMmPerS: 3000,
          flowLPerMin: 0.1,
        },
      ],
      slopeDeg: [0, -5],
      particlesPerS: 100,
      durationS: 3,
      stepS: 0.002,
      emitUntilS: 0.5,
      ...settings,
    };
    doc.studies.push(s);
    return run({ cad, doc });
  };

  it('holds the nozzle’s water at the shut seal and lets it in with the lid lifted', async () => {
    const shut = await shower(10);
    expect(shut.r.status.status).toBe('reference');
    expect(shut.r.levels[0]!.checks.map((c) => [c.name, c.pass])).toEqual([
      ['mapping', true],
      ['seal', true],
      ['shower', true],
    ]);
    expect(shut.f.particles).toBe(50);
    expect(shut.metrics['entered-volume']).toBe(0);
    expect(shut.metrics['leak-length']).toBe(0);
    expect(shut.metrics['pond-volume']).toBeCloseTo(50 * shut.f.particleVolumeMm3, 6);
    expect(shut.f.frames.length).toBeGreaterThan(50);
    const open = await shower(20);
    expect(open.f.counts.entered).toBe(50);
    expect(open.metrics['entered-volume']).toBeCloseTo(50 * open.f.particleVolumeMm3, 6);
    for (const e of open.f.entries) expect(e.position[1]).toBeLessThan(-100);
    // The view's markers follow the frame: none gone in at the first frame, all at the last,
    // each drawn at the seal (Codex on #1271).
    const big = (frame: number) => {
      const m = showerMesh(open.f, frame, false);
      let n = 0;
      for (let i = 0; i < m.water.length; i++) if (m.water[i] === 6) n++;
      return n / 6;
    };
    expect(big(0)).toBe(0);
    expect(big(open.f.frames.length - 1)).toBe(50);
    const last = open.f.frames.at(-1)!;
    for (let i = 0; i < last.states.length; i++)
      expect(last.positions[3 * i + 1]!).toBeLessThan(-100);
  }, 600_000);

  it('takes two ways of writing one hinge as the same turn', () => {
    // Codex on #1271: the axis's length and the origin along the axis do not change the turn.
    const a = placed({ origin: [0, 0, 0], axis: [0, 0, 1], angleDeg: 20 });
    expect(samePlace(a, placed({ origin: [0, 0, 10], axis: [0, 0, 2], angleDeg: 20 }))).toBe(true);
    expect(samePlace(a, placed({ origin: [0, 0, 0], axis: [0, 0, 1], angleDeg: 21 }))).toBe(false);
    expect(samePlace(placed(), placed({ origin: [5, 0, 0], axis: [1, 0, 0], angleDeg: 0 }))).toBe(
      true,
    );
  });

  it('refuses two seals that turn one closure differently', async () => {
    const { cad, doc } = f98SealSimulation({ clearance: 10 });
    const seal = doc.seals![0]!;
    doc.seals!.push({ ...structuredClone(seal), id: 'lid-seal-2', name: 'Lid 2' });
    doc.seals![1]!.hinge = { ...seal.hinge!, angleDeg: 1 };
    doc.studies.push(showerStudy('shower'));
    const hash = cadContentHash(cad);
    const d = { ...doc, source: { ...doc.source, contentHash: hash } };
    const display = await evaluateCad(oc, cad, hash);
    const r = await runStudy(
      d,
      cad,
      hash,
      'shower',
      display.meshes.find((m) => m.bodyId === d.source.bodyId)!.topology,
      {
        builds: { kernel: cadKernelBuild.wasmSha256, mesher: 'none', solver: 'seal-measure' },
        surface: () => {
          throw new Error('no surface');
        },
        mesh: () => {
          throw new Error('no mesh');
        },
      },
    );
    expect(r.failure?.code).toBe('simulation-invalid');
    expect(r.failure?.detail).toMatch(/lid-seal and lid-seal-2 turn closure/);
  }, 600_000);

  it('keeps rain out of the shut box', async () => {
    const rain = await shower(10, {
      rain: { rateMmPerH: 50, angleDeg: 10, azimuthDeg: 90 },
      nozzles: [],
      particlesPerS: 2000,
      durationS: 2,
      stepS: 0.004,
      emitUntilS: 1,
    });
    expect(rain.f.particles).toBe(2000);
    expect(rain.f.counts.entered).toBe(0);
    // Rain past the box (about half the rained plan) drains; on its tops it runs as film (slowly
    // on a 5° slope) or ponds.
    expect(rain.f.counts.drained).toBeGreaterThan(0);
    expect(rain.f.counts.film + rain.f.counts.pond).toBeGreaterThan(600);
  }, 600_000);
});
