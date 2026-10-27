import {
  createKernelJobs,
  kernelLoadMarksOf,
  KernelJobCancelled,
  loadKernelBuild,
} from '@editor-platform/geometry-kernel-occt';
import {
  CadEvaluationCancelled,
  CadKernelError,
  decodeKernelException,
  evaluateCad,
  FeatureCache,
  PlacementCache,
  type EvaluateOptions,
  type OcModule,
} from './evaluator';
import type {
  CadKernelBuild,
  CadMesh,
  CadStepAssemblyResult,
  CadWorkerRequest,
  CadWorkerResponse,
} from './protocol';
import { writeAssemblyStep } from './step-assembly';
import { importStep, type CadStepImportResult } from './step-import';
import { importStepAssembly, type CadStepAssemblyImportResult } from './step-assembly-import';

export interface KernelHostOptions {
  /** Fetches the Wasm, verifies `build.buildHash` and instantiates the module; never trusts document data. */
  load(build: CadKernelBuild): Promise<OcModule>;
  post(message: CadWorkerResponse, transfer: ArrayBuffer[]): void;
  /** A macrotask boundary so `cancel` messages are delivered between features. */
  yieldTask(): Promise<void>;
  evaluate?: EvaluateOptions;
  /** The kept shapes for placement-only changes (CAD25); a new one by default. */
  placement?: PlacementCache;
  /** Each feature's shape by its dependency closure (CM-3); a new one by default. */
  features?: FeatureCache;
}
const transferables = (meshes: CadMesh[]) =>
  meshes.flatMap(
    (m) =>
      [
        m.positions.buffer,
        m.normals.buffer,
        m.indices.buffer,
        m.faceIds.buffer,
        m.vertices.buffer,
        m.edges.buffer,
        m.edgeIds.buffer,
        ...(m.curvature ? [m.curvature.mean.buffer, m.curvature.gauss.buffer] : []),
      ] as ArrayBuffer[],
  );

/** Worker-side message handler: one job at a time, cooperative cancel between features. */
export function createKernelHost(options: KernelHostOptions) {
  let oc: OcModule | undefined;
  let buildHash: string | undefined;
  const jobs = createKernelJobs();
  /** The last full display evaluation's shapes, for a later placement-only change (CAD25). */
  const placement = options.placement ?? new PlacementCache();
  /** The shapes of display evaluations by dependency closure, for any later edit (CM-3). */
  const features = options.features ?? new FeatureCache();
  /** The evaluation paused between its jobs (CM-4): `continue` resumes it, anything else ends it. */
  let paused: { requestId: string; resume(): void; stop(): void } | undefined;
  /** Ends the paused evaluation (its handles are released as after a cancel). */
  const endPaused = () => {
    const p = paused;
    paused = undefined;
    p?.stop();
  };
  async function run(message: Extract<CadWorkerRequest, { type: 'evaluate' }>) {
    const {
      requestId,
      generation,
      candidateHash,
      document,
      deflectionMm,
      reference,
      step,
      brep: brepWanted,
      assets,
      connectors,
      continuity: edge,
      curvature,
      comb: combEdge,
      coarse,
      slice,
    } = message;
    if (!jobs.take(requestId)) return options.post({ type: 'cancelled', requestId }, []);
    if (!oc || (document.kernelProfile.buildHash !== buildHash && !reference))
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
      // A STEP file is written from exact shapes only, never from a reference evaluation.
      const {
        evaluation,
        meshes,
        step: file,
        brep,
        continuity,
        comb,
      } = await evaluateCad(oc, document, candidateHash, {
        ...options.evaluate,
        ...(deflectionMm === undefined ? {} : { deflectionMm }),
        ...(step && !reference ? { step } : {}),
        // A part's shape, like a STEP file, comes from exact shapes only.
        ...(brepWanted && !reference ? { brep: brepWanted } : {}),
        ...(assets ? { assets: new Map(Object.entries(assets)) } : {}),
        ...(connectors ? { connectors } : {}),
        ...(edge ? { continuity: edge } : {}),
        ...(curvature ? { curvature } : {}),
        ...(combEdge ? { comb: combEdge } : {}),
        ...(coarse ? { coarse } : {}),
        // A substitute build's reference display never feeds or uses the exact shapes, and
        // gives no measurements: not even of the bodies outside a failure.
        ...(reference ? { partial: false as const } : { placement, features }),
        // A long display evaluation pauses between jobs, keeping all it has built (CM-4).
        ...(slice
          ? {
              slice: {
                ms: slice.ms,
                pause: (done: number, total: number) =>
                  new Promise<void>((resume, stop) => {
                    paused = { requestId, resume, stop: () => stop(new CadEvaluationCancelled()) };
                    options.post({ type: 'continued', requestId, done, total }, []);
                  }),
              },
            }
          : {}),
        checkpoint: async (elementId) => {
          // Lets the port name what was being calculated if it has to stop the Worker.
          options.post({ type: 'progress', requestId, elementId }, []);
          await options.yieldTask();
          if (jobs.cancelled(requestId)) throw new CadEvaluationCancelled();
        },
      });
      // A reference result names the build that produced it, never the document's own.
      const result =
        reference && evaluation.status === 'ok'
          ? { ...evaluation, buildHash: buildHash!, reference: true as const }
          : evaluation;
      options.post(
        {
          type: 'result',
          requestId,
          generation,
          evaluation: result,
          meshes,
          ...(file ? { step: file } : {}),
          ...(brep ? { brep } : {}),
          ...(continuity ? { continuity } : {}),
          ...(comb ? { comb } : {}),
        },
        [
          ...transferables(meshes),
          ...(file ? [file.buffer as ArrayBuffer] : []),
          ...(brep ? [brep.bytes.buffer as ArrayBuffer] : []),
        ],
      );
    } catch (error) {
      if (!(error instanceof KernelJobCancelled)) throw error;
      // Handles are already released by evaluateCad's finally.
      options.post({ type: 'cancelled', requestId }, []);
    } finally {
      jobs.finish(requestId);
    }
  }
  /** One STEP read with the loaded build; the BRep bytes are transferred to the caller. */
  async function runImport(message: Extract<CadWorkerRequest, { type: 'import-step' }>) {
    const { requestId, bytes } = message;
    if (!jobs.take(requestId)) return options.post({ type: 'cancelled', requestId }, []);
    const result: CadStepImportResult = oc
      ? importStep(oc, bytes, buildHash!)
      : { status: 'rejected', code: 'step-import-unsupported-build' };
    options.post(
      { type: 'import-result', requestId, result },
      result.status === 'ok' ? [result.brep.buffer as ArrayBuffer] : [],
    );
  }
  /** R2b-5: one STEP assembly read with the loaded build; the BReps are transferred. */
  async function runImportAssembly(
    message: Extract<CadWorkerRequest, { type: 'import-step-assembly' }>,
  ) {
    const { requestId, bytes } = message;
    if (!jobs.take(requestId)) return options.post({ type: 'cancelled', requestId }, []);
    const result: CadStepAssemblyImportResult = oc
      ? importStepAssembly(oc, bytes, buildHash!)
      : { status: 'rejected', code: 'step-import-unsupported-build' };
    jobs.finish(requestId);
    options.post(
      { type: 'import-assembly-result', requestId, result },
      result.status === 'ok' ? result.breps.map((b) => b.buffer as ArrayBuffer) : [],
    );
  }
  /** R2b-5: one assembly STEP file from its plan and the products' BReps. */
  async function runStepAssembly(message: Extract<CadWorkerRequest, { type: 'step-assembly' }>) {
    const { requestId, plan, breps } = message;
    if (!jobs.take(requestId)) return options.post({ type: 'cancelled', requestId }, []);
    let result: CadStepAssemblyResult;
    try {
      if (!oc) throw new CadKernelError('kernel-build-unavailable');
      result = { status: 'ok', step: writeAssemblyStep(oc, plan, new Map(Object.entries(breps))) };
    } catch (error) {
      // An OCCT exception is decoded so its object is released.
      if (oc && !(error instanceof CadKernelError)) decodeKernelException(oc, error);
      result =
        error instanceof CadKernelError
          ? {
              status: 'error',
              code: error.code,
              ...(error.featureId ? { elementId: error.featureId } : {}),
              retryable: false,
            }
          : { status: 'error', code: 'step-write-failed', retryable: false };
    } finally {
      jobs.finish(requestId);
    }
    options.post(
      { type: 'step-assembly-result', requestId, result },
      result.status === 'ok' ? [result.step.buffer as ArrayBuffer] : [],
    );
  }
  return async function handle(message: CadWorkerRequest) {
    if (message.type === 'continue') {
      if (paused?.requestId !== message.requestId) return;
      const p = paused;
      paused = undefined;
      p.resume();
      return;
    }
    if (message.type === 'cancel') {
      jobs.cancel(message.requestId);
      if (paused?.requestId === message.requestId) endPaused();
      return;
    }
    // Any other request ends a paused evaluation first: the port has given it up.
    endPaused();
    if (message.type === 'init') {
      try {
        // Kept shapes are handles into the module being replaced.
        placement.release();
        features.release();
        oc = await options.load(message.build);
        buildHash = message.build.buildHash;
        options.post({ type: 'ready', buildHash }, []);
      } catch {
        options.post({ type: 'init-failed', code: 'kernel-load-failed' }, []);
      }
      return;
    }
    return jobs.enqueue(() =>
      message.type === 'import-step'
        ? runImport(message)
        : message.type === 'import-step-assembly'
          ? runImportAssembly(message)
          : message.type === 'step-assembly'
            ? runStepAssembly(message)
            : run(message),
    );
  };
}

/**
 * Marks in the Worker's performance timeline for the start-up phases, read by the performance
 * harness (experiments/cad-perf): fetched, verified, module loaded, compiled, instantiated.
 */
export const kernelLoadMarks = kernelLoadMarksOf('cad-kernel');
/** Browser loader: fetch Wasm from the Host-approved URL, verify SHA-256, then instantiate. */
export const loadVerifiedBuild = (build: CadKernelBuild): Promise<OcModule> =>
  loadKernelBuild(build, kernelLoadMarks);
