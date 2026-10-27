import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers';
import { cadContentHash, f41Bridge, type CadEvaluateRequest } from '@editor-platform/cad-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { FeatureCache, type OcModule } from './evaluator';
import { createKernelHost } from './host';
import { WorkerKernelPort, type WorkerLike } from './port';
import type { CadWorkerRequest } from './protocol';
import { cadKernelBuild } from '../../../scripts/cad-kernel/build.mjs';

// Opt-in: the development kernel (scripts/cad-kernel) built outside the repository.
const dist = process.env.CAD_OCCT_DIST;
describe.skipIf(!dist)('split evaluation with the development build (CM-4, P3)', () => {
  let buildHash = '';
  let oc: OcModule;
  beforeAll(async () => {
    const wasm = readFileSync(`${dist}/${cadKernelBuild.wasm}`);
    const sha = createHash('sha256').update(wasm).digest('hex');
    if (sha !== cadKernelBuild.wasmSha256)
      throw new Error(`kernel Wasm ${sha} is not the pinned build`);
    buildHash = `sha256:${sha}`;
    globalThis.require ??= createRequire(import.meta.url);
    const { default: factory } = await import(pathToFileURL(`${dist}/${cadKernelBuild.js}`).href);
    oc = await factory({ wasmBinary: wasm });
  }, 300_000);

  /** The port with an in-process Worker on the loaded module, and what it was sent. */
  function rig(sliceMs: number) {
    const sent: CadWorkerRequest[] = [];
    const progress: [string, number, number][] = [];
    const features = new FeatureCache();
    const built: string[] = [];
    const port = new WorkerKernelPort({
      build: { buildHash, moduleUrl: '', wasmUrl: '' },
      sliceMs,
      // A cooperative cancel: a forced stop would start a new Worker with an empty cache.
      cancelAckMs: 120_000,
      onProgress: ({ requestId }, done, total) => void progress.push([requestId, done, total]),
      spawn: (): WorkerLike => {
        const worker: WorkerLike = {
          onmessage: null,
          onerror: null,
          postMessage: (m) => {
            sent.push(m);
            void host(m);
          },
          terminate: () => {},
        };
        const host = createKernelHost({
          load: async () => oc,
          post: (m) => worker.onmessage?.({ data: m }),
          yieldTask: () => new Promise((resolve) => setImmediate(resolve)),
          features,
          evaluate: { timing: (phase, id) => void (phase === 'feature' && built.push(id)) },
        });
        return worker;
      },
    });
    return { port, sent, progress, features, built };
  }

  it('the bridge (F41) evaluates in several jobs under the job limit, and a stop keeps what was built', async () => {
    const doc = f41Bridge({ id: cadKernelBuild.id, buildHash });
    const request = (id: string): CadEvaluateRequest => ({
      requestId: id,
      generation: 1,
      baseHash: '',
      candidateHash: cadContentHash(doc),
      document: doc,
    });
    const jobs = (sent: CadWorkerRequest[], id: string) =>
      sent.filter((m) => (m.type === 'evaluate' || m.type === 'continue') && m.requestId === id)
        .length;

    // Stopped after its first job: what that job built stays in the Worker's cache.
    const first = rig(2000);
    try {
      const stopped = first.port.evaluate(request('stopped'));
      while (!first.progress.length) await new Promise((resolve) => setTimeout(resolve, 50));
      first.port.cancel('stopped');
      expect(await stopped).toMatchObject({ status: 'error', code: 'cancelled' });
      const before = first.built.length;
      expect(before).toBeGreaterThan(0);
      expect(before).toBeLessThan(doc.features.length);
      const evaluated = await first.port.evaluate(request('again'));
      expect(evaluated.status).toBe('ok');
      expect(jobs(first.sent, 'again')).toBeGreaterThan(1);
      // The second evaluation built only what the stopped one had not (and the shapes the
      // cache did not keep because a later feature changed them in place).
      expect(first.built.length - before).toBeLessThan(doc.features.length);
      expect(new Set(first.built)).toEqual(new Set(doc.features.map((f) => f.id)));
      // Each job reported how far it got, in dependency order, of the same total.
      const again = first.progress.filter(([id]) => id === 'again').map(([, d]) => d);
      expect(again.slice(1).every((d, i) => d > again[i]!)).toBe(true);
      expect(new Set(first.progress.map(([, , total]) => total)).size).toBe(1);
    } finally {
      first.port.dispose();
      first.features.release();
    }
  }, 600_000);
});
