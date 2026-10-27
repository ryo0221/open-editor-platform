import {
  cadContentHash,
  type CadDocument,
  type CadEvaluateRequest,
  type CadEvaluation,
  type CadKernelPort,
  type CadStepPlan,
} from '@editor-platform/cad-core';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type {
  CadBodyCurvature,
  CadBrepExport,
  CadCombResult,
  CadContinuityResult,
  CadKernelBuild,
  CadMesh,
  CadStepAssemblyResult,
  CadWorkerRequest,
  CadWorkerResponse,
} from './protocol';
import type { CadStepAssemblyImportResult } from './step-assembly-import';
import type { CadStepImportResult } from './step-import';

/** The subset of a dedicated Worker the port uses (also satisfied by test doubles). */
export interface WorkerLike {
  postMessage(message: CadWorkerRequest): void;
  terminate(): void;
  onmessage: ((event: { data: CadWorkerResponse }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
export interface WorkerKernelPortOptions {
  spawn(): WorkerLike;
  build: CadKernelBuild;
  /** Forced stop when a cancel is not acknowledged in time (initial deadline 500 ms). */
  cancelAckMs?: number;
  /** Forced stop for one job, Worker start-up included (initial limit 30 s). */
  jobTimeoutMs?: number;
  /**
   * Receives meshes of every successful evaluation, and of a failed one that shows the bodies
   * outside the failure (U4); ownership of the buffers moves to the callee.
   */
  onMeshes?(contentHash: string, meshes: CadMesh[]): void;
  /**
   * D2 asset bytes from the Host's closure, by `sha256:<hex>`. A document whose imported
   * features need bytes this does not return evaluates to `asset-missing`.
   */
  assets?(sha256: string): Uint8Array | undefined;
  timers?: { set(fn: () => void, ms: number): unknown; clear(id: unknown): void };
  /**
   * CM-4 (P3): a display evaluation runs as jobs of about this long (initial 20 s), each ending
   * at a feature boundary; the job limit still applies to each job.
   */
  sliceMs?: number;
  /** CM-4: the limit of one evaluation over all its jobs (initial 5 min). */
  totalTimeoutMs?: number;
  /** Milliseconds for `totalTimeoutMs`; `performance.now` by default. */
  now?: () => number;
  /**
   * CM-4: after each job of a display evaluation that goes on, the features and sketches
   * evaluated so far of all (in dependency order).
   */
  onProgress?(
    request: { requestId: string; candidateHash: string },
    done: number,
    total: number,
  ): void;
}
/** One queued Worker request: an evaluation (display, export) or a STEP read. */
interface Job {
  requestId: string;
  message: Exclude<CadWorkerRequest, { type: 'init' | 'cancel' }>;
  /** Settles the job without a Worker answer (superseded, cancelled, timeout, crash). */
  fail(code: string, retryable: boolean, featureId?: string): void;
  /** Settles the job with the Worker's answer. */
  done(
    data: Extract<
      CadWorkerResponse,
      { type: 'result' | 'import-result' | 'import-assembly-result' | 'step-assembly-result' }
    >,
  ): void;
  timer?: unknown;
  /** The feature or body the Worker reported last; named as the cause of a timeout. */
  elementId?: string;
  /** CM-4: a cancel was asked for; a job that ends with `continued` is not sent again. */
  cancelling?: true;
  /** CM-4: when the evaluation's first job was sent, for `totalTimeoutMs`. */
  began?: number;
}
const failed = (
  request: CadEvaluateRequest,
  code: string,
  retryable: boolean,
  featureId?: string,
): CadEvaluation => ({
  status: 'error',
  contentHash: request.candidateHash,
  code,
  ...(featureId ? { featureId } : {}),
  retryable,
});

/**
 * The part of a display request the document's own shapes depend on (CM-3b): the document with
 * its placed parts, components, joints and solved poses cleared, the connector references and
 * the coarse mesh asked for, and whether it is a reference display.
 */
const ownKey = (request: CadEvaluateRequest, reference: boolean) => {
  const own: CadDocument = {
    ...request.document,
    parts: [],
    components: [],
    componentPatterns: [],
    joints: [],
    solvedPoses: {},
  };
  return `${cadContentHash(own)} ${JSON.stringify([request.connectors ?? [], !!request.coarse, reference])}`;
};
/**
 * One Worker per session: one running job plus the latest waiting job, and the latest waiting
 * export beside it. A newer request replaces the waiting one of its kind, so an export never
 * supersedes an edit's evaluation (CAD21) and runs after it. Cancel is cooperative first; a missing acknowledgement, a job timeout or a
 * crash terminates the Worker, and the next job starts on a fresh instance.
 */
export class WorkerKernelPort implements CadKernelPort {
  private worker: WorkerLike | undefined;
  private ready: Promise<boolean> | undefined;
  private running: Job | undefined;
  private waiting: Job | undefined;
  /** An export of exact content, which waits beside the evaluations instead of replacing them. */
  private waitingExport: Job | undefined;
  private settleReady: ((ok: boolean) => void) | undefined;
  private disposed = false;
  private readonly timers;
  /** Number of Worker instances created; diagnostics for CAD24. */
  spawned = 0;
  /**
   * CM-3b: the last ok display evaluation and its meshes, by the request's own part. An edit of
   * placed parts or joints alone keeps the document's own shapes: it sends no Worker job.
   */
  private own:
    | { key: string; evaluation: CadEvaluation & { status: 'ok' }; meshes: CadMesh[] }
    | undefined;
  /** Display evaluations answered from `own` without a Worker job; diagnostics for CM-3b. */
  reused = 0;
  constructor(private readonly options: WorkerKernelPortOptions) {
    this.timers = options.timers ?? {
      set: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clear: (id: unknown) => clearTimeout(id as number),
    };
  }

  /** `reference`: only for a substitution the Host approved (CatalogKernelPort decides). */
  evaluate(
    request: CadEvaluateRequest,
    { reference, part }: { reference?: true; part?: true } = {},
  ): Promise<CadEvaluation> {
    // A placed part's evaluation is cached by its content hash elsewhere (R2b): it neither
    // reads nor replaces the editor document's kept result.
    const key = part ? undefined : ownKey(request, !!reference);
    const kept = this.own;
    if (
      key !== undefined &&
      !this.disposed &&
      kept?.key === key &&
      kept.evaluation.contentHash !== request.candidateHash &&
      // The hash the result is given is the document's own; the bytes it reads are still here,
      // and still the bytes the document names (the Worker would refuse others).
      cadContentHash(request.document) === request.candidateHash &&
      request.document.assets.every((a) => {
        if (a.kind !== 'normalized-brep') return true;
        const bytes = this.options.assets?.(a.sha256);
        return (
          !!bytes &&
          bytes.byteLength === a.byteLength &&
          `sha256:${bytesToHex(sha256(bytes))}` === a.sha256
        );
      })
    ) {
      // As a newer job would, it supersedes the one waiting.
      if (this.waiting) this.waiting.fail('superseded', true);
      this.waiting = undefined;
      this.reused++;
      const evaluation = { ...kept.evaluation, contentHash: request.candidateHash };
      this.own = { ...kept, evaluation };
      this.options.onMeshes?.(request.candidateHash, kept.meshes);
      return Promise.resolve(evaluation);
    }
    return new Promise((resolve) =>
      this.enqueue(
        this.evaluation(
          request,
          {
            ...(reference ? { reference } : {}),
            // Only a display evaluation is split; an export or analysis runs as one job.
            slice: { ms: this.options.sliceMs ?? 20_000 },
          },
          (data) => {
            if (key !== undefined && data.evaluation.status === 'ok')
              this.own = { key, evaluation: data.evaluation, meshes: data.meshes };
            if (data.evaluation.status === 'ok' || data.meshes.length)
              this.options.onMeshes?.(data.evaluation.contentHash, data.meshes);
            resolve(data.evaluation);
          },
          resolve,
        ),
      ),
    );
  }
  /**
   * Evaluates the same exact document again with an export triangulation. It waits in the export
   * slot (a newer export supersedes it, an evaluation does not) and leaves the display meshes alone.
   */
  exportMeshes(
    request: CadEvaluateRequest,
    deflectionMm: number,
  ): Promise<{ evaluation: CadEvaluation; meshes: CadMesh[] }> {
    return new Promise((resolve) =>
      this.enqueueExport(
        this.evaluation(
          request,
          { deflectionMm },
          (data) => resolve({ evaluation: data.evaluation, meshes: data.meshes }),
          (evaluation) => resolve({ evaluation, meshes: [] }),
        ),
      ),
    );
  }
  /** Evaluates the same exact document again and writes its active bodies as STEP. */
  exportStep(
    request: CadEvaluateRequest,
  ): Promise<{ evaluation: CadEvaluation; step?: Uint8Array }> {
    return new Promise((resolve) =>
      this.enqueueExport(
        this.evaluation(
          request,
          { step: true },
          (data) => resolve(data.step ? { evaluation: data.evaluation, step: data.step } : data),
          (evaluation) => resolve({ evaluation }),
        ),
      ),
    );
  }
  /**
   * Evaluates an exact document and writes its active bodies as one normalized BRep: the shape a
   * building places as a part (R2c-U2). Waits in the export slot like an export.
   */
  exportBrep(
    request: CadEvaluateRequest,
  ): Promise<{ evaluation: CadEvaluation; brep?: CadBrepExport }> {
    return new Promise((resolve) =>
      this.enqueueExport(
        this.evaluation(
          request,
          { brep: true },
          (data) => resolve(data.brep ? { evaluation: data.evaluation, brep: data.brep } : data),
          (evaluation) => resolve({ evaluation }),
        ),
      ),
    );
  }
  /**
   * Evaluates the same exact document again and samples one edge's continuity (R2a-4). Waits in
   * the export slot like an export; the display meshes are left alone.
   */
  analyzeContinuity(
    request: CadEvaluateRequest,
    edge: { bodyId: string; edge: number },
  ): Promise<{ evaluation: CadEvaluation; continuity?: CadContinuityResult }> {
    return new Promise((resolve) =>
      this.enqueueExport(
        this.evaluation(
          request,
          { continuity: edge },
          (data) =>
            resolve(
              data.continuity
                ? { evaluation: data.evaluation, continuity: data.continuity }
                : { evaluation: data.evaluation },
            ),
          (evaluation) => resolve({ evaluation }),
        ),
      ),
    );
  }
  /**
   * Evaluates the same exact document again with each node's mean and Gauss curvature (R2a-4),
   * in the export slot; the display meshes are left alone. The curvature is given by body, in
   * the order of that body's mesh nodes.
   */
  analyzeCurvature(
    request: CadEvaluateRequest,
  ): Promise<{ evaluation: CadEvaluation; curvature?: CadBodyCurvature[] }> {
    return new Promise((resolve) =>
      this.enqueueExport(
        this.evaluation(
          request,
          { curvature: true },
          (data) =>
            resolve({
              evaluation: data.evaluation,
              curvature: data.meshes.flatMap((m) =>
                m.curvature ? [{ bodyId: m.bodyId, ...m.curvature }] : [],
              ),
            }),
          (evaluation) => resolve({ evaluation }),
        ),
      ),
    );
  }
  /** Evaluates the same exact document again and samples one edge's curvature comb (R2a-4). */
  analyzeComb(
    request: CadEvaluateRequest,
    edge: { bodyId: string; edge: number },
  ): Promise<{ evaluation: CadEvaluation; comb?: CadCombResult }> {
    return new Promise((resolve) =>
      this.enqueueExport(
        this.evaluation(
          request,
          { comb: edge },
          (data) =>
            resolve(
              data.comb
                ? { evaluation: data.evaluation, comb: data.comb }
                : { evaluation: data.evaluation },
            ),
          (evaluation) => resolve({ evaluation }),
        ),
      ),
    );
  }
  /**
   * D2: reads one STEP file with this build into a normalized BRep and its preflight report.
   * Queues like an evaluation; the bytes are copied, the caller keeps them.
   */
  importStep(requestId: string, bytes: Uint8Array): Promise<CadStepImportResult> {
    return new Promise((resolve) =>
      this.enqueue({
        requestId,
        message: { type: 'import-step', requestId, bytes },
        fail: (code) =>
          resolve({
            status: 'rejected',
            code: code === 'timeout' ? 'step-import-timeout' : 'step-import-interrupted',
            detail: code,
          }),
        done: (data) => {
          if (data.type === 'import-result') resolve(data.result);
        },
      }),
    );
  }
  /**
   * R2b-5: reads one STEP assembly with this build into its shapes' BReps and flattened
   * instances. Queues like an evaluation; the bytes are copied, the caller keeps them.
   */
  importStepAssembly(requestId: string, bytes: Uint8Array): Promise<CadStepAssemblyImportResult> {
    return new Promise((resolve) =>
      this.enqueue({
        requestId,
        message: { type: 'import-step-assembly', requestId, bytes },
        fail: (code) =>
          resolve({
            status: 'rejected',
            code: code === 'timeout' ? 'step-import-timeout' : 'step-import-interrupted',
            detail: code,
          }),
        done: (data) => {
          if (data.type === 'import-assembly-result') resolve(data.result);
        },
      }),
    );
  }
  /**
   * R2b-5: writes an assembly as STEP AP242 from its plan and each shaped product's BRep
   * (`exportBrep`). Waits in the export slot like an export; the bytes are copied.
   */
  exportAssemblyStep(
    requestId: string,
    plan: CadStepPlan,
    breps: ReadonlyMap<string, Uint8Array>,
  ): Promise<CadStepAssemblyResult> {
    return new Promise((resolve) =>
      this.enqueueExport({
        requestId,
        message: { type: 'step-assembly', requestId, plan, breps: Object.fromEntries(breps) },
        fail: (code, retryable) => resolve({ status: 'error', code, retryable }),
        done: (data) => {
          if (data.type === 'step-assembly-result') resolve(data.result);
        },
      }),
    );
  }
  private evaluation(
    request: CadEvaluateRequest,
    extra: {
      deflectionMm?: number;
      reference?: true;
      step?: true;
      brep?: true;
      continuity?: { bodyId: string; edge: number };
      curvature?: true;
      comb?: { bodyId: string; edge: number };
      slice?: { ms: number };
    },
    onResult: (data: Extract<CadWorkerResponse, { type: 'result' }>) => void,
    onFailure: (evaluation: CadEvaluation) => void,
  ): Job {
    const assets: Record<string, Uint8Array> = {};
    for (const a of request.document.assets)
      if (a.kind === 'normalized-brep') {
        const bytes = this.options.assets?.(a.sha256);
        if (bytes) assets[a.sha256] = bytes;
      }
    return {
      requestId: request.requestId,
      message: {
        type: 'evaluate',
        ...request,
        ...extra,
        ...(Object.keys(assets).length ? { assets } : {}),
      },
      fail: (code, retryable, featureId) => onFailure(failed(request, code, retryable, featureId)),
      done: (data) => {
        if (data.type === 'result') onResult(data);
      },
    };
  }
  private enqueue(job: Job) {
    if (this.disposed) return job.fail('kernel-unavailable', true);
    if (this.waiting) this.waiting.fail('superseded', true);
    this.waiting = job;
    void this.pump();
  }
  private enqueueExport(job: Job) {
    if (this.disposed) return job.fail('kernel-unavailable', true);
    if (this.waitingExport) this.waitingExport.fail('superseded', true);
    this.waitingExport = job;
    void this.pump();
  }
  cancel(requestId: string) {
    if (this.waiting?.requestId === requestId) {
      this.waiting.fail('cancelled', true);
      this.waiting = undefined;
      return;
    }
    if (this.waitingExport?.requestId === requestId) {
      this.waitingExport.fail('cancelled', true);
      this.waitingExport = undefined;
      return;
    }
    const job = this.running;
    if (!job || job.requestId !== requestId) return;
    job.cancelling = true;
    this.worker?.postMessage({ type: 'cancel', requestId });
    this.timers.clear(job.timer);
    job.timer = this.timers.set(
      () => this.stop(job, 'cancelled', true),
      this.options.cancelAckMs ?? 500,
    );
  }
  /** Terminates the Worker, idle or not; pending and later work resolves as unavailable. */
  dispose() {
    this.disposed = true;
    const waiting = [this.waiting, this.waitingExport];
    this.waiting = this.waitingExport = undefined;
    for (const job of waiting) job?.fail('kernel-unavailable', true);
    if (this.running) this.stop(this.running, 'kernel-unavailable', true);
    this.reset();
  }

  private start(): Promise<boolean> {
    if (this.ready) return this.ready;
    const worker = this.options.spawn();
    this.spawned++;
    this.worker = worker;
    this.ready = new Promise((resolve) => {
      this.settleReady = resolve;
      worker.onmessage = ({ data }) => {
        if (data.type === 'ready') resolve(data.buildHash === this.options.build.buildHash);
        else if (data.type === 'init-failed') resolve(false);
        else this.receive(data);
      };
      worker.onerror = () => {
        resolve(false);
        if (this.running) this.stop(this.running, 'kernel-unavailable', true);
        else this.reset();
      };
    });
    worker.postMessage({ type: 'init', build: this.options.build });
    return this.ready;
  }
  private reset() {
    this.worker?.terminate();
    this.worker = undefined;
    this.ready = undefined;
    // A start-up that can no longer answer settles as failed instead of hanging its job.
    this.settleReady?.(false);
    this.settleReady = undefined;
  }
  private async pump() {
    if (this.disposed || this.running || !(this.waiting || this.waitingExport)) return;
    // An edit's evaluation goes first; the export of what was confirmed waits for it.
    const job = (this.running = (this.waiting ?? this.waitingExport)!);
    if (job === this.waiting) this.waiting = undefined;
    else this.waitingExport = undefined;
    // The deadline covers start-up too: a Worker that never reports ready is stopped.
    let started = false;
    job.began = this.now();
    job.timer = this.timers.set(
      () =>
        started
          ? this.stop(job, 'timeout', false, job.elementId)
          : this.stop(job, 'kernel-unavailable', true),
      this.limit(job),
    );
    let ok: boolean;
    try {
      ok = await this.start();
    } catch {
      // Worker construction itself can throw (e.g. SecurityError): same path as a failed start.
      ok = false;
    }
    if (this.running !== job) return;
    if (!ok) return this.stop(job, 'kernel-unavailable', true);
    started = true;
    this.worker!.postMessage(job.message);
  }
  private receive(data: CadWorkerResponse) {
    const job = this.running;
    if (!job || !('requestId' in data) || data.requestId !== job.requestId) return;
    if (data.type === 'progress') {
      job.elementId = data.elementId;
      return;
    }
    if (data.type === 'cancelled') return this.finish(job, () => job.fail('cancelled', true));
    if (data.type === 'continued') return this.continue(job, data);
    if (
      data.type === 'result' ||
      data.type === 'import-result' ||
      data.type === 'import-assembly-result' ||
      data.type === 'step-assembly-result'
    )
      this.finish(job, () => job.done(data));
  }
  /**
   * CM-4 (P3): lets a paused evaluation go on as the next job, unless it was cancelled meanwhile,
   * newer work waits (it supersedes this one; the Worker ends the paused one on the next request,
   * and what it built stays in the feature cache) or the evaluation's total limit is reached.
   * Each job has its own job limit.
   */
  private continue(job: Job, data: Extract<CadWorkerResponse, { type: 'continued' }>) {
    if (job.message.type !== 'evaluate' || !job.message.slice) return;
    if (job.cancelling) return this.finish(job, () => job.fail('cancelled', true));
    if (this.waiting) return this.finish(job, () => job.fail('superseded', true));
    if (this.now() - job.began! >= (this.options.totalTimeoutMs ?? 300_000)) {
      // The Worker ends the paused evaluation as cancelled.
      this.worker!.postMessage({ type: 'cancel', requestId: job.requestId });
      return this.finish(job, () => job.fail('timeout', false, job.elementId));
    }
    const { requestId, candidateHash } = job.message;
    this.options.onProgress?.({ requestId, candidateHash }, data.done, data.total);
    this.timers.clear(job.timer);
    job.timer = this.timers.set(
      () => this.stop(job, 'timeout', false, job.elementId),
      this.limit(job),
    );
    this.worker!.postMessage({ type: 'continue', requestId });
  }
  /** A job's limit: the job limit, and for a split evaluation no later than its total limit. */
  private limit(job: Job) {
    const each = this.options.jobTimeoutMs ?? 30_000;
    if (job.message.type !== 'evaluate' || !job.message.slice) return each;
    const left = (this.options.totalTimeoutMs ?? 300_000) - (this.now() - job.began!);
    return Math.max(0, Math.min(each, left));
  }
  private now() {
    return this.options.now?.() ?? performance.now();
  }
  /** Forced stop: the late result of this instance can never arrive after terminate. */
  private stop(job: Job, code: string, retryable: boolean, featureId?: string) {
    this.reset();
    this.finish(job, () => job.fail(code, retryable, featureId));
  }
  private finish(job: Job, settle: () => void) {
    if (this.running !== job) return;
    this.timers.clear(job.timer);
    this.running = undefined;
    settle();
    void this.pump();
  }
}
