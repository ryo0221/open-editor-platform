import {
  CadEvaluationCancelled,
  evaluateCad,
  type EvaluateOptions,
  type OcModule,
} from './evaluator';
import type { CadKernelBuild, CadMesh, CadWorkerRequest, CadWorkerResponse } from './protocol';

export interface KernelHostOptions {
  /** Fetches the Wasm, verifies `build.buildHash` and instantiates the module; never trusts document data. */
  load(build: CadKernelBuild): Promise<OcModule>;
  post(message: CadWorkerResponse, transfer: ArrayBuffer[]): void;
  /** A macrotask boundary so `cancel` messages are delivered between features. */
  yieldTask(): Promise<void>;
  evaluate?: EvaluateOptions;
}
const transferables = (meshes: CadMesh[]) =>
  meshes.flatMap(
    (m) =>
      [m.positions.buffer, m.normals.buffer, m.indices.buffer, m.faceIds.buffer] as ArrayBuffer[],
  );

/** Worker-side message handler: one job at a time, cooperative cancel between features. */
export function createKernelHost(options: KernelHostOptions) {
  let oc: OcModule | undefined;
  let buildHash: string | undefined;
  const cancelled = new Set<string>();
  let queue = Promise.resolve();
  async function run(message: Extract<CadWorkerRequest, { type: 'evaluate' }>) {
    const { requestId, generation, candidateHash, document } = message;
    if (cancelled.delete(requestId)) return options.post({ type: 'cancelled', requestId }, []);
    if (!oc || document.kernelProfile.buildHash !== buildHash)
      return options.post(
        {
          type: 'result',
          requestId,
          generation,
          evaluation: {
            status: 'error',
            contentHash: candidateHash,
            code: 'kernel-build-unavailable',
            retryable: false,
          },
          meshes: [],
        },
        [],
      );
    try {
      const { evaluation, meshes } = await evaluateCad(oc, document, candidateHash, {
        ...options.evaluate,
        checkpoint: async () => {
          await options.yieldTask();
          if (cancelled.has(requestId)) throw new CadEvaluationCancelled();
        },
      });
      options.post(
        { type: 'result', requestId, generation, evaluation, meshes },
        transferables(meshes),
      );
    } catch (error) {
      if (!(error instanceof CadEvaluationCancelled)) throw error;
      // Handles are already released by evaluateCad's finally.
      options.post({ type: 'cancelled', requestId }, []);
    } finally {
      cancelled.delete(requestId);
    }
  }
  return async function handle(message: CadWorkerRequest) {
    if (message.type === 'cancel') {
      cancelled.add(message.requestId);
      return;
    }
    if (message.type === 'init') {
      try {
        oc = await options.load(message.build);
        buildHash = message.build.buildHash;
        options.post({ type: 'ready', buildHash }, []);
      } catch {
        options.post({ type: 'init-failed', code: 'kernel-load-failed' }, []);
      }
      return;
    }
    queue = queue.then(() => run(message));
    return queue;
  };
}

/** Browser loader: fetch Wasm from the Host-approved URL, verify SHA-256, then instantiate. */
export async function loadVerifiedBuild(build: CadKernelBuild): Promise<OcModule> {
  const bytes = new Uint8Array(
    await (await fetch(build.wasmUrl, { credentials: 'same-origin' })).arrayBuffer(),
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  if (`sha256:${hex}` !== build.buildHash) throw new Error('kernel-build-hash');
  // The Emscripten module factory itself (e.g. opencascade.full.js), not a wrapper that locates files.
  const { default: factory } = await import(/* @vite-ignore */ build.moduleUrl);
  return factory({ wasmBinary: bytes });
}
