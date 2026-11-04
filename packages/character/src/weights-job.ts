import {
  boneHeatWeights,
  MeshEditError,
  type EpmMesh,
  type WeightBone,
} from '@editor-platform/geometry-mesh';
import type { WeightsRequest, WeightsResponse } from './weights-protocol';

/**
 * Automatic weights (C5b), one job at a time in a worker. `cancel` stops it at once (the worker
 * is terminated; the next job starts a new one). Where no worker can start, the job runs here, on
 * the main thread, and cannot be cancelled.
 */
export class WeightJobs {
  private worker: Worker | undefined;
  private broken = false;
  private sequence = 0;
  private pending:
    | { id: number; resolve(mesh: EpmMesh): void; reject(error: Error): void }
    | undefined;

  constructor(private readonly start: () => Worker = defaultWorker) {}

  run(
    mesh: EpmMesh,
    bones: WeightBone[],
    boneIds: string[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<EpmMesh> {
    this.cancel();
    const worker = this.ensure();
    if (!worker)
      return new Promise((resolve, reject) => {
        try {
          resolve(boneHeatWeights(mesh, bones, boneIds, onProgress));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    const id = ++this.sequence;
    return new Promise<EpmMesh>((resolve, reject) => {
      this.pending = { id, resolve, reject };
      this.progress = onProgress;
      const request: WeightsRequest = { id, mesh, bones, boneIds };
      try {
        worker.postMessage(request);
      } catch (e) {
        this.pending = undefined;
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Stops a running job; its promise rejects with `character-weights-cancelled`. */
  cancel() {
    const p = this.pending;
    if (!p) return;
    this.pending = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    p.reject(new Error('character-weights-cancelled'));
  }

  dispose() {
    this.cancel();
    this.worker?.terminate();
    this.worker = undefined;
    this.broken = true;
  }

  private progress: ((done: number, total: number) => void) | undefined;

  private ensure(): Worker | undefined {
    if (this.worker || this.broken) return this.worker;
    try {
      const worker = this.start();
      worker.onmessage = ({ data }: MessageEvent<WeightsResponse>) => {
        const p = this.pending;
        if (!p || p.id !== data.id) return;
        if (data.status === 'progress') return this.progress?.(data.done, data.total);
        this.pending = undefined;
        if (data.status === 'done') p.resolve(data.mesh);
        else if (data.status === 'refused')
          p.reject(new MeshEditError(data.problem as MeshEditError['problem'], data.detail));
        else p.reject(new Error(data.message));
      };
      worker.onerror = (event) => {
        event.preventDefault();
        worker.terminate();
        if (this.worker === worker) this.worker = undefined;
        this.broken = true;
        const p = this.pending;
        this.pending = undefined;
        p?.reject(new Error('character-weights-worker-failed'));
      };
      this.worker = worker;
    } catch {
      this.broken = true;
    }
    return this.worker;
  }
}

const defaultWorker = () =>
  new Worker(new URL('./weights-worker.ts', import.meta.url), { type: 'module' });
