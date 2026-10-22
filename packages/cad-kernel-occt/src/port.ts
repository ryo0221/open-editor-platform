import type { CadEvaluateRequest, CadEvaluation, CadKernelPort } from '@editor-platform/cad-core';
import type { CadKernelBuild, CadMesh, CadWorkerRequest, CadWorkerResponse } from './protocol';

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
  /** Receives meshes of every successful evaluation; ownership of the buffers moves to the callee. */
  onMeshes?(contentHash: string, meshes: CadMesh[]): void;
  timers?: { set(fn: () => void, ms: number): unknown; clear(id: unknown): void };
}
interface Job {
  request: CadEvaluateRequest;
  resolve(evaluation: CadEvaluation): void;
  timer?: unknown;
}
const failed = (request: CadEvaluateRequest, code: string, retryable: boolean): CadEvaluation => ({
  status: 'error',
  contentHash: request.candidateHash,
  code,
  retryable,
});

/**
 * One Worker per session: one running job plus the latest waiting job. A newer request replaces
 * the waiting one. Cancel is cooperative first; a missing acknowledgement, a job timeout or a
 * crash terminates the Worker, and the next job starts on a fresh instance.
 */
export class WorkerKernelPort implements CadKernelPort {
  private worker: WorkerLike | undefined;
  private ready: Promise<boolean> | undefined;
  private running: Job | undefined;
  private waiting: Job | undefined;
  private settleReady: ((ok: boolean) => void) | undefined;
  private disposed = false;
  private readonly timers;
  /** Number of Worker instances created; diagnostics for CAD24. */
  spawned = 0;
  constructor(private readonly options: WorkerKernelPortOptions) {
    this.timers = options.timers ?? {
      set: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clear: (id: unknown) => clearTimeout(id as number),
    };
  }

  evaluate(request: CadEvaluateRequest): Promise<CadEvaluation> {
    return new Promise((resolve) => {
      if (this.disposed) return resolve(failed(request, 'kernel-unavailable', true));
      if (this.waiting) this.waiting.resolve(failed(this.waiting.request, 'superseded', true));
      this.waiting = { request, resolve };
      void this.pump();
    });
  }
  cancel(requestId: string) {
    if (this.waiting?.request.requestId === requestId) {
      this.waiting.resolve(failed(this.waiting.request, 'cancelled', true));
      this.waiting = undefined;
      return;
    }
    const job = this.running;
    if (!job || job.request.requestId !== requestId) return;
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
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.resolve(failed(waiting.request, 'kernel-unavailable', true));
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
    if (this.disposed || this.running || !this.waiting) return;
    const job = (this.running = this.waiting);
    this.waiting = undefined;
    // The deadline covers start-up too: a Worker that never reports ready is stopped.
    let started = false;
    job.timer = this.timers.set(
      () =>
        started ? this.stop(job, 'timeout', false) : this.stop(job, 'kernel-unavailable', true),
      this.options.jobTimeoutMs ?? 30_000,
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
    this.worker!.postMessage({ type: 'evaluate', ...job.request });
  }
  private receive(data: CadWorkerResponse) {
    const job = this.running;
    if (!job || !('requestId' in data) || data.requestId !== job.request.requestId) return;
    if (data.type === 'cancelled') return this.finish(job, failed(job.request, 'cancelled', true));
    if (data.type === 'result') {
      if (data.evaluation.status === 'ok')
        this.options.onMeshes?.(data.evaluation.contentHash, data.meshes);
      this.finish(job, data.evaluation);
    }
  }
  /** Forced stop: the late result of this instance can never arrive after terminate. */
  private stop(job: Job, code: string, retryable: boolean) {
    this.reset();
    this.finish(job, failed(job.request, code, retryable));
  }
  private finish(job: Job, evaluation: CadEvaluation) {
    if (this.running !== job) return;
    this.timers.clear(job.timer);
    this.running = undefined;
    job.resolve(evaluation);
    void this.pump();
  }
}
