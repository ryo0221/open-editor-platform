import { WorkerKernelPort } from '@editor-platform/cad-kernel-occt';
import CadKernelWorker from '@editor-platform/cad-kernel-occt/worker?worker';
import type { cadKernel } from '../model';
import type { BimPartKernel } from './parts';

/** A CAD kernel Worker for part shapes, started on first use; one export at a time. */
export function partKernel(
  build: NonNullable<typeof cadKernel>,
): BimPartKernel & { dispose(): void } {
  let port: WorkerKernelPort | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let n = 0;
  return {
    buildHash: build.buildHash,
    exportBrep(document, contentHash) {
      port ??= new WorkerKernelPort({ spawn: () => new CadKernelWorker() as never, build });
      const p = port;
      // The port's export slot keeps only the newest waiting export: send them one by one.
      const job = queue.then(async () => {
        const { evaluation, brep } = await p.exportBrep({
          requestId: `bim-part-${++n}`,
          generation: n,
          baseHash: '',
          candidateHash: contentHash,
          document,
        });
        if (evaluation.status !== 'ok') throw new Error(evaluation.code);
        if (!brep) throw new Error('brep-unavailable');
        return brep;
      });
      queue = job.catch(() => undefined);
      return job;
    },
    dispose: () => port?.dispose(),
  };
}
