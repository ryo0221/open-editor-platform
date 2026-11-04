import { MeshEditError, subdivideMesh, type EpmMesh } from '@editor-platform/geometry-mesh';
import type { SubdivisionRequest, SubdivisionResponse } from './subdivision-protocol';

/**
 * Subdivisions for the view (C3i), one at a time in a worker. Where no worker can start (no
 * `Worker`, or it fails to load), the next ones run here instead, on the main thread. The cage
 * is copied to the worker (the document keeps its own); the result is moved back.
 */
export class SubdivisionJobs {
  private worker: Worker | undefined;
  private broken = false;
  private sequence = 0;
  private readonly pending = new Map<
    number,
    { resolve(mesh: EpmMesh): void; reject(error: Error): void }
  >();

  constructor(private readonly start: () => Worker = defaultWorker) {}

  run(mesh: EpmMesh, levels: number): Promise<EpmMesh> {
    const worker = this.ensure();
    if (!worker)
      return new Promise((resolve, reject) => {
        try {
          resolve(subdivideMesh(mesh, levels));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    const id = ++this.sequence;
    return new Promise<EpmMesh>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const request: SubdivisionRequest = { id, mesh, levels };
      try {
        worker.postMessage(request);
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = undefined;
    this.broken = true;
    for (const p of this.pending.values()) p.reject(new Error('subdivision-cancelled'));
    this.pending.clear();
  }

  private ensure(): Worker | undefined {
    if (this.worker || this.broken) return this.worker;
    try {
      const worker = this.start();
      worker.onmessage = ({ data }: MessageEvent<SubdivisionResponse>) => {
        const p = this.pending.get(data.id);
        if (!p) return;
        this.pending.delete(data.id);
        if (data.status === 'done') p.resolve(data.mesh);
        else if (data.status === 'refused')
          p.reject(new MeshEditError(data.problem as MeshEditError['problem'], data.detail));
        else p.reject(new Error(data.message));
      };
      worker.onerror = (event) => {
        event.preventDefault();
        // A worker that failed (to load or to run) is not used again; what it had runs here.
        worker.terminate();
        if (this.worker === worker) this.worker = undefined;
        this.broken = true;
        const failed = [...this.pending.values()];
        this.pending.clear();
        for (const p of failed) p.reject(new Error('subdivision-worker-failed'));
      };
      this.worker = worker;
    } catch {
      this.broken = true;
    }
    return this.worker;
  }
}

const defaultWorker = () =>
  new Worker(new URL('./subdivision-worker.ts', import.meta.url), { type: 'module' });
