import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers';
import {
  bearingSeries02,
  cadContentHash,
  eaxleParts,
  type CadDocument,
} from '@editor-platform/cad-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { createKernelHost } from './host';
import type { CadMesh, CadWorkerRequest, CadWorkerResponse } from './protocol';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';

/** Signed volume of a closed triangle mesh (divergence theorem). */
function volume(m: CadMesh): number {
  const p = m.positions;
  let v = 0;
  for (let i = 0; i < m.indices.length; i += 3) {
    const [a, b, c] = [m.indices[i]!, m.indices[i + 1]!, m.indices[i + 2]!].map((k) => 3 * k);
    v +=
      (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) -
        p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) +
        p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) /
      6;
  }
  return Math.abs(v);
}
const bounds = (m: CadMesh) => {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i++) {
    const v = m.positions[i]! + m.origin[i % 3]!;
    lo[i % 3] = Math.min(lo[i % 3]!, v);
    hi[i % 3] = Math.max(hi[i % 3]!, v);
  }
  return [lo, hi];
};

// Opt-in: the development kernel (scripts/cad-kernel) built outside the repository.
const dist = process.env.CAD_OCCT_DIST;
describe.skipIf(!dist)('DW7c e-Axle parts in the kernel (ST-717, TS-2455)', () => {
  const host = { evaluate: undefined as unknown as (d: CadDocument) => Promise<CadWorkerResponse> };
  beforeAll(async () => {
    const wasm = readFileSync(`${dist}/${cadKernelBuild.wasm}`);
    const sha = createHash('sha256').update(wasm).digest('hex');
    if (sha !== cadKernelBuild.wasmSha256)
      throw new Error(`kernel Wasm ${sha} is not the pinned build`);
    globalThis.require ??= createRequire(import.meta.url);
    const posted: CadWorkerResponse[] = [];
    const handle = createKernelHost({
      load: async () => {
        const { default: factory } = await import(
          pathToFileURL(`${dist}/${cadKernelBuild.js}`).href
        );
        return factory({ wasmBinary: wasm });
      },
      post: (m) => void posted.push(m),
      yieldTask: () => new Promise((resolve) => setImmediate(resolve)),
    });
    await handle({
      type: 'init',
      build: { buildHash: `sha256:${sha}`, moduleUrl: '', wasmUrl: '' },
    });
    let n = 0;
    host.evaluate = async (document) => {
      const requestId = `gear-${n++}`;
      await handle({
        type: 'evaluate',
        requestId,
        generation: n,
        baseHash: '',
        candidateHash: cadContentHash(document),
        document,
      } as CadWorkerRequest);
      return posted.find(
        (x) => 'requestId' in x && x.requestId === requestId && x.type !== 'progress',
      )!;
    };
  }, 120_000);

  const parts = eaxleParts({ id: 'occt', buildHash: `sha256:${cadKernelBuild.wasmSha256}` });
  const evaluated = new Map<string, CadMesh[]>();
  const meshes = async (key: string) => {
    if (!evaluated.has(key)) {
      const m = await host.evaluate(parts.find((p) => p.key === key)!.content);
      if (m.type !== 'result' || m.evaluation.status !== 'ok')
        throw new Error(`${key}: ${JSON.stringify(m).slice(0, 1500)}`);
      evaluated.set(key, m.meshes);
    }
    return evaluated.get(key)!;
  };

  // The parts of more than one body: the stator's core and coil ends, the drive shaft's joints,
  // bar and boots.
  const solids: Record<string, number> = { 'motor-stator': 3, 'drive-shaft': 5 };
  it.each(parts.map((p) => p.key))(
    'evaluates %s to closed solids',
    async (key) => {
      const m = await meshes(key);
      expect(m.length, key).toBe(solids[key] ?? 1);
      for (const x of m) expect(volume(x)).toBeGreaterThan(0);
    },
    120_000,
  );

  it('keeps the bearing envelope of series 02 and its balls inside it', async () => {
    const [d, D, B] = bearingSeries02['6208']!;
    const [m] = await meshes('bearing-6208');
    const [lo, hi] = bounds(m!);
    expect(hi[0]! - lo[0]!).toBeCloseTo(D, 0);
    expect(hi[2]! - lo[2]!).toBeCloseTo(B, 0);
    // The rings' annulus minus the race gap, plus the balls: well under the full annulus.
    const annulus = (Math.PI * (D * D - d * d) * B) / 4;
    const v = volume(m!);
    expect(v).toBeGreaterThan(annulus * 0.55);
    expect(v).toBeLessThan(annulus * 0.85);
  }, 120_000);

  it('cuts 48 stator slots and 8 magnet pockets out of the cores', async () => {
    const [core] = await meshes('motor-stator');
    const ring = (Math.PI * (110 ** 2 - 70 ** 2) * 160) / 1;
    const slots = 48 * (87 - 70) * 5 * 160;
    expect(Math.abs(volume(core!) - (ring - slots)) / ring).toBeLessThan(0.01);
  }, 120_000);
});
