import { BakeError } from '@editor-platform/geometry-mesh';
import { runBake, type BakeDone, type BakeRequest, type BakeResponse } from './bake-protocol';

/** A running bake: its result, and a way to stop it (the promise then rejects `cancelled`). */
export interface BakeRun {
  done: Promise<BakeDone>;
  cancel(): void;
}

/**
 * C7d normal-map bakes, each in a worker of its own: stopping one ends its worker. Where no worker
 * can start, the bake runs on the main thread (it cannot be stopped there part way).
 */
export class BakeJobs {
  private sequence = 0;
  private running = new Set<Worker>();

  constructor(private readonly start: () => Worker = defaultWorker) {}

  run(request: Omit<BakeRequest, 'id'>, progress?: (rows: number, size: number) => void): BakeRun {
    let worker: Worker | undefined;
    try {
      worker = this.start();
    } catch {
      worker = undefined;
    }
    if (!worker) {
      let stopped = false;
      return {
        done: runBake(request, (rows, size) => {
          progress?.(rows, size);
          return stopped;
        }),
        cancel: () => {
          stopped = true;
        },
      };
    }
    const w = worker;
    this.running.add(w);
    const id = ++this.sequence;
    let settle: { resolve(d: BakeDone): void; reject(e: Error): void } | undefined;
    const done = new Promise<BakeDone>((resolve, reject) => (settle = { resolve, reject }));
    const end = (fn: () => void) => {
      if (!settle) return;
      w.terminate();
      this.running.delete(w);
      fn();
      settle = undefined;
    };
    w.onmessage = ({ data }: MessageEvent<BakeResponse>) => {
      if (data.id !== id) return;
      if (data.status === 'progress') progress?.(data.rows, data.size);
      else if (data.status === 'done') {
        const { png, size, covered, missed } = data;
        end(() => settle!.resolve({ png, size, covered, missed }));
      } else if (data.status === 'refused')
        end(() => settle!.reject(new BakeError(data.problem, data.detail, data.faces)));
      else end(() => settle!.reject(new Error(data.message)));
    };
    w.onerror = (event) => {
      event.preventDefault();
      end(() => settle!.reject(new Error('bake-worker-failed')));
    };
    const message: BakeRequest = { ...request, id, displacements: request.displacements.slice() };
    try {
      w.postMessage(message, [message.displacements.buffer as ArrayBuffer]);
    } catch (e) {
      end(() => settle!.reject(e instanceof Error ? e : new Error(String(e))));
    }
    return {
      done,
      cancel: () => end(() => settle!.reject(new BakeError('cancelled', 'the bake was stopped'))),
    };
  }

  dispose() {
    for (const w of this.running) w.terminate();
    this.running.clear();
  }
}

const defaultWorker = () =>
  new Worker(new URL('./bake-worker.ts', import.meta.url), { type: 'module' });
