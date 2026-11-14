import type {
  GeometryGraph,
  GeometryRequest,
  GeometryStepRequest,
} from '@editor-platform/geometry-core';
import {
  createKernelJobs,
  evaluateGeometry,
  KernelJobCancelled,
  type GeometryEvaluation,
  type KernelBuild,
  type OcModule,
} from '@editor-platform/geometry-kernel-occt';

/**
 * The board's kernel (PB7b): the shared `geometry-kernel-occt` evaluation in a dedicated Worker,
 * one job at a time. A job past its time, or a crash, stops the Worker; the next job starts a
 * fresh one. The circuit board domain shares only the op graph and its evaluation (ADR 021).
 */
export type PcbWorkerRequest =
  | { type: 'init'; build: KernelBuild }
  | {
      type: 'run';
      requestId: string;
      graph: GeometryGraph;
      requests: GeometryRequest[];
      /** PB7c: also write these nodes as one STEP file. */
      step?: GeometryStepRequest;
    }
  | { type: 'cancel'; requestId: string };
export type PcbWorkerResponse =
  | { type: 'ready'; buildHash: string }
  | { type: 'init-failed'; code: 'kernel-load-failed' }
  | { type: 'result'; requestId: string; evaluation: GeometryEvaluation }
  | { type: 'cancelled'; requestId: string };

export type PcbKernelOutcome =
  | GeometryEvaluation
  | { status: 'cancelled' }
  | { status: 'timeout' }
  | { status: 'error'; code: string };

export interface PcbKernel {
  run(
    graph: GeometryGraph,
    requests: GeometryRequest[],
    signal?: AbortSignal,
    step?: GeometryStepRequest,
  ): Promise<PcbKernelOutcome>;
  dispose(): void;
}

const transferables = (evaluation: GeometryEvaluation) =>
  evaluation.status === 'ok'
    ? evaluation.results.flatMap((r) =>
        r.status === 'ok' && r.mesh
          ? ([
              r.mesh.positions.buffer,
              r.mesh.normals.buffer,
              r.mesh.uvs.buffer,
              r.mesh.indices.buffer,
              r.mesh.faceIndices.buffer,
            ] as ArrayBuffer[])
          : [],
      )
    : [];

/** The Worker side: loads the build once, then runs each graph, cancellable between nodes. */
export function createPcbKernelHost(options: {
  load(build: KernelBuild): Promise<OcModule>;
  post(message: PcbWorkerResponse, transfer: ArrayBuffer[]): void;
  yieldTask(): Promise<void>;
}) {
  let oc: OcModule | undefined;
  const jobs = createKernelJobs();
  async function run(message: Extract<PcbWorkerRequest, { type: 'run' }>) {
    const { requestId, graph, requests, step } = message;
    if (!jobs.take(requestId)) return options.post({ type: 'cancelled', requestId }, []);
    try {
      const evaluation = await evaluateGeometry(oc!, graph, requests, {
        ...(step ? { step } : {}),
        checkpoint: async () => {
          await options.yieldTask();
          if (jobs.cancelled(requestId)) throw new KernelJobCancelled();
        },
      });
      const transfer = transferables(evaluation);
      if (evaluation.status === 'ok' && evaluation.step?.status === 'ok')
        transfer.push(evaluation.step.bytes.buffer as ArrayBuffer);
      options.post({ type: 'result', requestId, evaluation }, transfer);
    } catch (error) {
      if (!(error instanceof KernelJobCancelled)) throw error;
      options.post({ type: 'cancelled', requestId }, []);
    } finally {
      jobs.finish(requestId);
    }
  }
  return async function handle(message: PcbWorkerRequest) {
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

/** The subset of a dedicated Worker the port uses (test doubles satisfy it too). */
export interface PcbWorkerLike {
  postMessage(message: PcbWorkerRequest): void;
  terminate(): void;
  onmessage: ((event: { data: PcbWorkerResponse }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export const pcbKernelLimits = Object.freeze({
  /** A board's whole model is one job; the same limit as a CAD or building job. */
  jobTimeoutMs: 30_000,
  cancelAckMs: 500,
});

interface Job {
  message: Extract<PcbWorkerRequest, { type: 'run' }>;
  signal: AbortSignal | undefined;
  settle(outcome: PcbKernelOutcome): void;
}

/** The kernel in a dedicated Worker, jobs in arrival order. */
export class WorkerPcbKernel implements PcbKernel {
  private worker: PcbWorkerLike | undefined;
  private ready: Promise<string | undefined> | undefined;
  private settleReady: ((code: string | undefined) => void) | undefined;
  private finishRunning: ((outcome: PcbKernelOutcome) => void) | undefined;
  private running: Job | undefined;
  private readonly queue: Job[] = [];
  private sequence = 0;
  private disposed = false;

  constructor(
    private readonly options: {
      spawn(): PcbWorkerLike;
      build: KernelBuild | undefined;
      jobTimeoutMs?: number;
    },
  ) {}

  run(
    graph: GeometryGraph,
    requests: GeometryRequest[],
    signal?: AbortSignal,
    step?: GeometryStepRequest,
  ) {
    if (this.disposed) return Promise.resolve<PcbKernelOutcome>({ status: 'cancelled' });
    if (!this.options.build)
      return Promise.resolve<PcbKernelOutcome>({ status: 'error', code: 'kernel-unavailable' });
    const requestId = `pcb-${++this.sequence}`;
    return new Promise<PcbKernelOutcome>((settle) => {
      this.queue.push({
        message: { type: 'run', requestId, graph, requests, ...(step ? { step } : {}) },
        signal,
        settle,
      });
      this.next();
    });
  }

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
    let ack: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      if (!done) this.stop({ status: 'timeout' });
    }, this.options.jobTimeoutMs ?? pcbKernelLimits.jobTimeoutMs);
    const onAbort = () => {
      if (done) return;
      this.worker?.postMessage({ type: 'cancel', requestId: job.message.requestId });
      ack = setTimeout(() => {
        if (!done) this.stop({ status: 'cancelled' });
      }, pcbKernelLimits.cancelAckMs);
    };
    const finish = (outcome: PcbKernelOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (ack) clearTimeout(ack);
      job.signal?.removeEventListener('abort', onAbort);
      job.settle(outcome);
      if (this.running === job) this.running = undefined;
      this.next();
    };
    this.finishRunning = finish;
    job.signal?.addEventListener('abort', onAbort);
    const failed = await this.ensureWorker();
    if (done) return;
    if (failed) return finish({ status: 'error', code: failed });
    if (job.signal?.aborted) return finish({ status: 'cancelled' });
    this.worker!.postMessage(job.message);
  }

  private ensureWorker(): Promise<string | undefined> {
    if (this.ready) return this.ready;
    const worker = this.options.spawn();
    this.worker = worker;
    this.ready = new Promise((resolve) => (this.settleReady = resolve));
    worker.onmessage = ({ data }) => {
      if (worker !== this.worker) return;
      if (data.type === 'ready') this.settleReady?.(undefined);
      else if (data.type === 'init-failed') {
        // The waiting job fails; the next one starts a fresh Worker and tries again (a load
        // may fail for a moment, such as a dropped network).
        this.settleReady?.(data.code);
        worker.terminate();
        this.worker = undefined;
        this.ready = undefined;
        this.settleReady = undefined;
      } else if (data.requestId === this.running?.message.requestId)
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

  private stop(outcome: PcbKernelOutcome) {
    this.worker?.terminate();
    this.worker = undefined;
    this.settleReady?.('kernel-stopped');
    this.ready = undefined;
    this.settleReady = undefined;
    this.finishRunning?.(outcome);
  }
}
