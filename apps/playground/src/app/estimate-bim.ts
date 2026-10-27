import type { Artifact } from '@editor-platform/artifact-core';
import { contentHash } from '@editor-platform/artifact-core';
import { verifyEstimateArtifact } from '@editor-platform/estimate/host';
import type { QuantityVerification } from '@editor-platform/estimate-core';
import type { EstimateBimEvaluator } from '@editor-platform/estimate/bim-source';
import { cadKernel } from '../model';
/** Evaluation is Host-owned. Only requested BIM snapshots load the existing kernel Worker. */
export const evaluateEstimateBim: EstimateBimEvaluator = async (document, pin, signal) => {
  if (signal?.aborted) throw Error('cancelled');
  if (!cadKernel) throw Error('bim-kernel-unavailable');
  const [{ BimEvaluator, WorkerBimKernel }, { default: KernelWorker }] = await Promise.all([
    import('@editor-platform/bim'),
    import('@editor-platform/bim/worker?worker'),
  ]);
  const hash = await contentHash(document);
  if (hash !== pin.contentHash) throw Error('stale-bim-evaluation');
  const kernel = new WorkerBimKernel({
    spawn: () => new KernelWorker() as never,
    build: cadKernel,
  });
  const cancel = () => kernel.dispose();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted) throw Error('cancelled');
    const result = await new BimEvaluator(kernel).evaluate(document);
    if (signal?.aborted) throw Error('cancelled');
    return result.status === 'ok'
      ? {
          contentHash: hash,
          engine: cadKernel.buildHash,
          status: 'ok',
          elements: result.elements,
          quantities: result.kernelQuantities,
        }
      : {
          contentHash: hash,
          engine: cadKernel.buildHash,
          status: 'superseded',
          elements: new Map(),
          quantities: new Map(),
        };
  } finally {
    signal?.removeEventListener('abort', cancel);
    kernel.dispose();
  }
};
export const playgroundEstimateQuantities: QuantityVerification = {
  async verifySource(source, sources) {
    const { bimQuantityVerification } = await import('@editor-platform/estimate/bim-source');
    return bimQuantityVerification(evaluateEstimateBim).verifySource(source, sources);
  },
  async verifyQuantities(quantities, sources) {
    const { bimQuantityVerification } = await import('@editor-platform/estimate/bim-source');
    return bimQuantityVerification(evaluateEstimateBim).verifyQuantities(quantities, sources);
  },
};
export const verifyPlaygroundEstimate = (artifact: Artifact<unknown>) =>
  verifyEstimateArtifact(artifact, playgroundEstimateQuantities);
