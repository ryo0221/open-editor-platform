import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers';
import {
  ballBearings,
  cadContentHash,
  f153CaseBack,
  f153Sizes,
  f154StandardParts,
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
describe.skipIf(!dist)('PD4 standard parts in the kernel (ST-761, TS-2529)', () => {
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
      const requestId = `std-${n++}`;
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

  const kernel = { id: 'occt', buildHash: `sha256:${cadKernelBuild.wasmSha256}` };
  const parts = f154StandardParts(kernel);
  const evaluate = async (what: string, doc: CadDocument) => {
    const m = await host.evaluate(doc);
    if (m.type !== 'result' || m.evaluation.status !== 'ok')
      throw new Error(`${what}: ${JSON.stringify(m).slice(0, 1500)}`);
    return m.meshes;
  };
  const size = (m: CadMesh) => {
    const [lo, hi] = bounds(m);
    return [0, 1, 2].map((i) => hi[i]! - lo[i]!);
  };

  it.each(parts.map((p) => [p.designation, p] as const))(
    'evaluates %s to one closed solid of its size',
    async (designation, p) => {
      const meshes = await evaluate(designation, p.content);
      expect(meshes, designation).toHaveLength(1);
      const m = meshes[0]!;
      const v = volume(m);
      expect(v).toBeGreaterThan(0);
      const [x, y, z] = size(m);
      const dim = p.dimensions;
      // Envelopes within 2 % (the mesh's chords sit inside round outlines).
      const near = (a: number, b: number) =>
        expect(Math.abs(a - b) / b, designation).toBeLessThan(0.02);
      switch (p.spec.family) {
        case 'screw': {
          near(x, dim.dk!);
          near(y, dim.dk!);
          near(z, dim.length! + dim.k!);
          // Less than the head and shank as full cylinders (the drive is cut out).
          const full = (Math.PI / 4) * (dim.dk! ** 2 * dim.k! + dim.d! ** 2 * dim.length!);
          expect(v).toBeLessThan(full);
          expect(v).toBeGreaterThan(full * 0.75);
          break;
        }
        case 'o-ring': {
          near(x, dim.d1! + 2 * dim.d2!);
          near(z, dim.d2!);
          const torus = Math.PI ** 2 * ((dim.d1! + dim.d2!) / 2) * (dim.d2! / 2) ** 2 * 2;
          near(v, torus);
          break;
        }
        case 'parallel-pin':
          near(x, dim.d!);
          near(z, dim.length!);
          break;
        case 'ball-bearing': {
          const [d, D, B] = ballBearings[p.spec.code]!;
          near(x, D);
          near(z, B);
          const annulus = (Math.PI * (D * D - d * d) * B) / 4;
          expect(v, designation).toBeGreaterThan(annulus * 0.5);
          expect(v, designation).toBeLessThan(annulus * 0.9);
          break;
        }
        case 'hole-jewel':
        case 'cap-jewel':
          near(x, dim.diameter!);
          near(z, dim.height!);
          break;
        case 'spring-bar':
          near(x, dim.diameter!);
          near(z, dim.extended!);
          break;
      }
    },
    120_000,
  );

  it("cuts F153's gasket groove out of the case back (TS-2530)", async () => {
    const { back, gland, gasket } = f153CaseBack(kernel);
    const [m] = await evaluate('F153', back);
    const s = f153Sizes;
    // The same back without the groove, so both meshes carry the same chord error.
    const plain = await evaluate('F153 plain', f153CaseBack(kernel, { groove: false }).back);
    const groove = (Math.PI / 4) * (s.spigot ** 2 - gland.inner ** 2) * gland.width;
    const removed = volume(plain[0]!) - volume(m!);
    expect(Math.abs(removed - groove) / groove).toBeLessThan(0.05);
    // The gasket fits the groove: its section in the groove's depth plus squeeze, its ring on
    // the groove's bottom.
    const [g] = await evaluate('F153 gasket', gasket.content);
    const [gx] = size(g!);
    expect(gx! - 2 * s.gasket.section).toBeLessThan(gland.inner);
  }, 120_000);
});
