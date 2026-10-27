import type { GeometryGraph, GeometryRequest } from '@editor-platform/geometry-core';
import type { KernelBuild } from '@editor-platform/geometry-kernel-occt';
import type { BimKernel, BimKernelOutcome } from './evaluate';
import type { BimWorkerRequest, BimWorkerResponse } from './protocol';

/** The subset of a dedicated Worker the port uses (also satisfied by test doubles). */
export interface BimWorkerLike {
  postMessage(message: BimWorkerRequest): void;
  terminate(): void;
  onmessage: ((event: { data: BimWorkerResponse }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
export interface WorkerBimKernelOptions {
  spawn(): BimWorkerLike;
  /** The Host's verified build; undefined when none is configured. */
  build: KernelBuild | undefined;
  /** Forced stop for one job, Worker start-up included (30 s, as in CAD). */
  jobTimeoutMs?: number;
  /** Forced stop when a cancel is not acknowledged in time (500 ms, as in CAD). */
  cancelAckMs?: number;
  timers?: { set(fn: () => void, ms: number): unknown; clear(id: unknown): void };
}
export const bimKernelLimits = Object.freeze({
  jobTimeoutMs: 30_000,
  cancelAckMs: 500,
  /**
   * A drawing's projection: hidden lines need every seen solid in one job, so it cannot be
   * split like the cuts. Five minutes (Ryo, 2026-10-25), for the sections of tall buildings.
   */
  projectionTimeoutMs: 300_000,
  /**
   * An IFC export's job with part meshes: a part's mesh cannot be split either. The same five
   * minutes as a projection (OH-U4, Ryo, 2026-10-26).
   */
  exportTimeoutMs: 300_000,
});

interface Job {
  requestId: string;
  message: Extract<BimWorkerRequest, { type: 'run' }>;
  signal: AbortSignal | undefined;
  timeoutMs: number;
  settle(outcome: BimKernelOutcome): void;
}

/**
 * The bim kernel in a dedicated Worker (docs/cad/r2c-architecture.md, 評価と規模): one job at a
 * time in arrival order. A job past the limit, a cancel not acknowledged in time, or a crash
 * terminates the Worker; the next job starts on a fresh instance.
 */
export class WorkerBimKernel implements BimKernel {
  private worker: BimWorkerLike | undefined;
  private ready: Promise<string | undefined> | undefined;
  private settleReady: ((code: string | undefined) => void) | undefined;
  private queue: Job[] = [];
  private running: Job | undefined;
  private sequence = 0;
  private disposed = false;
  private readonly timers;
  private readonly limits;
  /** Number of Worker instances created (diagnostics). */
  spawned = 0;
  constructor(private readonly options: WorkerBimKernelOptions) {
    this.timers = options.timers ?? {
      set: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clear: (id: unknown) => clearTimeout(id as number),
    };
    this.limits = {
      jobTimeoutMs: options.jobTimeoutMs ?? bimKernelLimits.jobTimeoutMs,
      cancelAckMs: options.cancelAckMs ?? bimKernelLimits.cancelAckMs,
    };
  }

  run(
    graph: GeometryGraph,
    requests: GeometryRequest[],
    assets: Map<string, Uint8Array>,
    signal?: AbortSignal,
    options: { timeoutMs?: number } = {},
  ): Promise<BimKernelOutcome> {
    if (this.disposed) return Promise.resolve({ status: 'cancelled' });
    if (!this.options.build)
      return Promise.resolve({ status: 'error', code: 'kernel-build-unavailable' });
    const requestId = `bim-${++this.sequence}`;
    return new Promise((resolve) => {
      this.queue.push({
        requestId,
        message: { type: 'run', requestId, graph, requests, assets: Object.fromEntries(assets) },
        signal,
        timeoutMs: options.timeoutMs ?? this.limits.jobTimeoutMs,
        settle: resolve,
      });
      this.next();
    });
  }

  /** Stops the Worker, idle or not, and settles every job as cancelled. */
  dispose() {
    this.disposed = true;
    for (const job of this.queue.splice(0)) job.settle({ status: 'cancelled' });
    this.stop({ status: 'cancelled' });
  }

  private next() {
    if (this.running) return;
    let job = this.queue.shift();
    while (job?.signal?.aborted) {
      job.settle({ status: 'cancelled' });
      job = this.queue.shift();
    }
    if (!job) return;
    this.running = job;
    void this.start(job);
  }

  private async start(job: Job) {
    let done = false;
    let ackTimer: unknown;
    const timer = this.timers.set(() => {
      if (!done) this.stop({ status: 'timeout' });
    }, job.timeoutMs);
    const finish = (outcome: BimKernelOutcome) => {
      if (done) return;
      done = true;
      this.timers.clear(timer);
      if (ackTimer !== undefined) this.timers.clear(ackTimer);
      job.signal?.removeEventListener('abort', onAbort);
      job.settle(outcome);
      if (this.running === job) this.running = undefined;
      this.next();
    };
    this.finishRunning = finish;
    const onAbort = () => {
      if (done) return;
      this.worker?.postMessage({ type: 'cancel', requestId: job.requestId });
      ackTimer = this.timers.set(() => {
        if (!done) this.stop({ status: 'cancelled' });
      }, this.limits.cancelAckMs);
    };
    job.signal?.addEventListener('abort', onAbort);
    const failed = await this.ensureWorker();
    if (done) return;
    if (failed) return finish({ status: 'error', code: failed });
    if (job.signal?.aborted) return finish({ status: 'cancelled' });
    this.worker!.postMessage(job.message);
  }
  /** Settles the running job; set by `start`. */
  private finishRunning: ((outcome: BimKernelOutcome) => void) | undefined;

  /** Starts a Worker and loads the build once; resolves an error code when that fails. */
  private ensureWorker(): Promise<string | undefined> {
    if (this.ready) return this.ready;
    const worker = this.options.spawn();
    this.spawned++;
    this.worker = worker;
    this.ready = new Promise((resolve) => (this.settleReady = resolve));
    worker.onmessage = ({ data }) => {
      if (worker !== this.worker) return;
      if (data.type === 'ready') this.settleReady?.(undefined);
      else if (data.type === 'init-failed') {
        // The build cannot load: later jobs fail the same way until the page reloads.
        this.settleReady?.(data.code);
      } else if (data.requestId === this.running?.requestId)
        this.finishRunning?.(data.type === 'result' ? data.evaluation : { status: 'cancelled' });
    };
    worker.onerror = () => {
      if (worker !== this.worker) return;
      this.settleReady?.('kernel-crashed');
      this.stop({ status: 'error', code: 'kernel-crashed' });
    };
    worker.postMessage({ type: 'init', build: this.options.build! });
    return this.ready;
  }

  /** Terminates the Worker and settles the running job. */
  private stop(outcome: BimKernelOutcome) {
    this.worker?.terminate();
    this.worker = undefined;
    // A start-up still waiting ends too; its job is the one settled below.
    this.settleReady?.('kernel-stopped');
    this.ready = undefined;
    this.settleReady = undefined;
    this.finishRunning?.(outcome);
  }
}
