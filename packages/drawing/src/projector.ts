import type {
  DrawingDirection,
  DrawingMeshBody,
  DrawingProjectedView,
  DrawingViewFrame,
} from '@editor-platform/drawing-core';
import type { DrawingProjectRequest } from './project-worker';

type WorkerLike = Pick<Worker, 'postMessage' | 'terminate'> & {
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
};

/** DW-U9: one view's projection may run this long in its Worker; then it is refused. */
export const drawingProjectionTimeMs = 5 * 60 * 1000;

/**
 * DW2: projections run in one Worker, one after another. An aborted request that is running
 * terminates the Worker (the next request starts a fresh one); one still waiting is dropped. A
 * request running longer than the time limit terminates the Worker and answers `limit-time`.
 */
export class DrawingProjector {
  private worker: WorkerLike | undefined;
  private next = 1;
  private chain: Promise<unknown> = Promise.resolve();
  private disposed = false;
  /** Ends the running request (dispose): its timer cleared, its answer `aborted`. */
  private cancel: (() => void) | undefined;
  constructor(
    private readonly spawn: () => WorkerLike,
    private readonly timeMs = drawingProjectionTimeMs,
  ) {}

  project(
    bodies: DrawingMeshBody[],
    direction: DrawingDirection | DrawingViewFrame,
    options: DrawingProjectRequest['options'],
    signal?: AbortSignal,
  ): Promise<DrawingProjectedView | { code: string }> {
    const run = () =>
      new Promise<DrawingProjectedView | { code: string }>((resolve) => {
        // Disposed: queued requests end without a Worker (Codex on #1207).
        if (signal?.aborted || this.disposed) return resolve({ code: 'aborted' });
        const worker = (this.worker ??= this.spawn());
        const id = this.next++;
        const timer = setTimeout(() => {
          worker.terminate();
          if (this.worker === worker) this.worker = undefined;
          done({ code: 'limit-time' });
        }, this.timeMs);
        const done = (r: DrawingProjectedView | { code: string }) => {
          clearTimeout(timer);
          if (this.cancel === cancel) this.cancel = undefined;
          signal?.removeEventListener('abort', abort);
          worker.onmessage = null;
          worker.onerror = null;
          resolve(r);
        };
        const abort = () => {
          worker.terminate();
          if (this.worker === worker) this.worker = undefined;
          done({ code: 'aborted' });
        };
        const cancel = () => done({ code: 'aborted' });
        this.cancel = cancel;
        signal?.addEventListener('abort', abort);
        worker.onmessage = (
          e: MessageEvent<{ id: number; view?: DrawingProjectedView; code?: string }>,
        ) => {
          if (e.data.id !== id) return;
          done(e.data.view ?? { code: e.data.code ?? 'project-failed' });
        };
        worker.onerror = () => {
          worker.terminate();
          if (this.worker === worker) this.worker = undefined;
          done({ code: 'project-failed' });
        };
        worker.postMessage({ id, bodies, direction, options } satisfies DrawingProjectRequest);
      });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
  dispose() {
    this.disposed = true;
    this.cancel?.();
    this.worker?.terminate();
    this.worker = undefined;
  }
}
