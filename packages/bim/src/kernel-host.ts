import {
  createKernelJobs,
  evaluateGeometry,
  KernelJobCancelled,
  type GeometryEvaluation,
  type KernelBuild,
  type OcModule,
} from '@editor-platform/geometry-kernel-occt';
import type { BimWorkerRequest, BimWorkerResponse } from './protocol';

export interface BimKernelHostOptions {
  /** Fetches the Wasm, verifies `build.buildHash` and instantiates the module. */
  load(build: KernelBuild): Promise<OcModule>;
  post(message: BimWorkerResponse, transfer: ArrayBuffer[]): void;
  /** A macrotask boundary so `cancel` messages are delivered between nodes. */
  yieldTask(): Promise<void>;
}

const transferables = (evaluation: GeometryEvaluation) =>
  evaluation.status === 'ok'
    ? evaluation.results.flatMap((r) =>
        r.status === 'ok' && r.mesh
          ? ([
              r.mesh.positions.buffer,
              r.mesh.normals.buffer,
              r.mesh.indices.buffer,
              r.mesh.faceIndices.buffer,
            ] as ArrayBuffer[])
          : [],
      )
    : [];

/** Worker-side message handler: one job at a time, cooperative cancel between nodes. */
export function createBimKernelHost(options: BimKernelHostOptions) {
  let oc: OcModule | undefined;
  const jobs = createKernelJobs();
  async function run(message: Extract<BimWorkerRequest, { type: 'run' }>) {
    const { requestId, graph, requests, assets } = message;
    if (!jobs.take(requestId)) return options.post({ type: 'cancelled', requestId }, []);
    try {
      // The port only sends work after `ready`.
      const evaluation = await evaluateGeometry(oc!, graph, requests, {
        assets: new Map(Object.entries(assets)),
        checkpoint: async () => {
          await options.yieldTask();
          if (jobs.cancelled(requestId)) throw new KernelJobCancelled();
        },
      });
      options.post({ type: 'result', requestId, evaluation }, transferables(evaluation));
    } catch (error) {
      if (!(error instanceof KernelJobCancelled)) throw error;
      options.post({ type: 'cancelled', requestId }, []);
    } finally {
      jobs.finish(requestId);
    }
  }
  return async function handle(message: BimWorkerRequest) {
    if (message.type === 'cancel') return jobs.cancel(message.requestId);
    if (message.type === 'init') {
      try {
        oc = await options.load(message.build);
        options.post({ type: 'ready', buildHash: message.build.buildHash }, []);
      } catch {
        options.post({ type: 'init-failed', code: 'kernel-load-failed' }, []);
      }
      return;
    }
    return jobs.enqueue(() => run(message));
  };
}
