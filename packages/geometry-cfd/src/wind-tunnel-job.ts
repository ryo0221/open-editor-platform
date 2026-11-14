import { CfdError, type CfdErrorCode } from './errors';
import {
  runWindTunnel,
  type WindTunnelProgress,
  type WindTunnelRequest,
  type WindTunnelResult,
} from './wind-tunnel';

/** What the wind-tunnel worker sends back. */
export type WindTunnelMessage =
  | { kind: 'progress'; progress: WindTunnelProgress }
  | { kind: 'done'; result: WindTunnelResult }
  | { kind: 'failed'; code: CfdErrorCode | undefined; message: string };

export interface WindTunnelRunOptions {
  onProgress?: (p: WindTunnelProgress) => void;
  /** Aborting ends the run (the worker is terminated) and rejects with `cancelled`. */
  signal?: AbortSignal;
}

const failure = (code: CfdErrorCode | undefined, message: string) =>
  code ? Object.assign(new CfdError(code, ''), { message }) : new Error(message);

/**
 * Browser wind-tunnel runs (VS2b, docs/cad/vehicle-simulation.md), each in its own worker so a
 * run of minutes does not stop the page, and a cancel ends it at once. Where no worker can start
 * (no `Worker`, or it fails to load) the runs go on the page's thread in chunks, yielding to its
 * event loop between them, and a cancel takes effect at the next chunk.
 */
export class WindTunnelJobs {
  private broken = false;

  constructor(private readonly start: () => Worker = defaultWorker) {}

  run(request: WindTunnelRequest, options: WindTunnelRunOptions = {}): Promise<WindTunnelResult> {
    if (options.signal?.aborted)
      return Promise.reject(new CfdError('cancelled', 'the run was cancelled'));
    let worker: Worker | undefined;
    if (!this.broken && (typeof Worker !== 'undefined' || this.start !== defaultWorker)) {
      try {
        worker = this.start();
      } catch {
        this.broken = true;
      }
    } else this.broken = true;
    if (!worker) return this.here(request, options);
    const w = worker;
    return new Promise<WindTunnelResult>((resolve, reject) => {
      let settled = false;
      const end = () => {
        settled = true;
        w.terminate();
        options.signal?.removeEventListener('abort', abort);
      };
      const abort = () => {
        if (settled) return;
        end();
        reject(new CfdError('cancelled', 'the run was cancelled'));
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      w.onmessage = ({ data }: MessageEvent<WindTunnelMessage>) => {
        if (settled) return;
        if (data.kind === 'progress') return options.onProgress?.(data.progress);
        end();
        if (data.kind === 'done') resolve(data.result);
        else reject(failure(data.code, data.message));
      };
      w.onerror = (event) => {
        event.preventDefault();
        if (settled) return;
        end();
        // A worker that does not load is not tried again; this run goes on here instead.
        this.broken = true;
        this.here(request, options).then(resolve, reject);
      };
      try {
        w.postMessage({ request });
      } catch (e) {
        end();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private here(request: WindTunnelRequest, options: WindTunnelRunOptions) {
    return runWindTunnel(request, {
      ...options,
      pause: () => new Promise((resolve) => setTimeout(resolve, 0)),
    });
  }
}

const defaultWorker = () =>
  new Worker(new URL('./wind-tunnel-worker.ts', import.meta.url), { type: 'module' });
