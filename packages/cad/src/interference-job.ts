/**
 * MR3 interference checks off the main thread (docs/cad/mecha-design.md, MR3（干渉の検査）):
 * one at a time in a worker. Where no worker can start (no `Worker`, or it fails to load), the
 * next ones run here instead. The documents and meshes are copied to the worker; the report
 * comes back.
 */
import {
  checkCadInterference,
  checkCadInterferenceAlong,
  type CadConfiguration,
  type CadDocument,
  type CadInterferenceMesh,
  type CadInterferenceReport,
  type CadJointSolution,
  type CadResolvedJointValues,
  type CadSweepReport,
} from '@editor-platform/cad-core';

/** What a check reads, as plain data a worker can receive. */
export interface CadInterferenceRequest {
  doc: CadDocument;
  /** Every version the assembly reaches, by content hash. */
  parts: Record<string, CadDocument>;
  /** Each reached version's meshes (positions and indices only), when they are at hand. */
  meshes: Record<string, CadInterferenceMesh[]>;
  ownMeshes?: CadInterferenceMesh[];
  joints: Record<string, CadJointSolution>;
  form?: CadConfiguration;
  /** MR5: check at each of these times instead (joint values by joint ID), not with `form`. */
  samples?: {
    tick: number;
    values: Record<string, CadResolvedJointValues>;
    /** MR7: each mount's joint in effect then. */
    mounts?: Record<string, string>;
  }[];
}
export type CadInterferenceResponse =
  | { id: number; status: 'done'; report: CadInterferenceReport | CadSweepReport }
  | { id: number; status: 'failed'; message: string };

export function runInterference(
  request: CadInterferenceRequest,
): CadInterferenceReport | CadSweepReport {
  const input = {
    doc: request.doc,
    lookup: (hash: string) => request.parts[hash],
    meshesOf: (hash: string) => request.meshes[hash],
    ...(request.ownMeshes ? { ownMeshes: request.ownMeshes } : {}),
    joints: request.joints,
  };
  if (request.samples)
    return checkCadInterferenceAlong(
      input,
      request.samples.map((s) => ({
        tick: s.tick,
        values: new Map(Object.entries(s.values)),
        ...(s.mounts ? { mounts: new Map(Object.entries(s.mounts)) } : {}),
      })),
    );
  return checkCadInterference({ ...input, ...(request.form ? { form: request.form } : {}) });
}

export class CadInterferenceJobs {
  private worker: Worker | undefined;
  private broken = false;
  private sequence = 0;
  private readonly pending = new Map<
    number,
    { resolve(report: CadInterferenceReport | CadSweepReport): void; reject(error: Error): void }
  >();

  constructor(private readonly start: () => Worker = defaultWorker) {}

  run(request: CadInterferenceRequest): Promise<CadInterferenceReport | CadSweepReport> {
    const worker = this.ensure();
    if (!worker)
      return new Promise((resolve, reject) => {
        try {
          resolve(runInterference(request));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, request });
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
    for (const p of this.pending.values()) p.reject(new Error('interference-cancelled'));
    this.pending.clear();
  }

  private ensure(): Worker | undefined {
    if (this.worker || this.broken) return this.worker;
    if (typeof Worker === 'undefined') {
      this.broken = true;
      return undefined;
    }
    try {
      const worker = this.start();
      worker.onmessage = ({ data }: MessageEvent<CadInterferenceResponse>) => {
        const p = this.pending.get(data.id);
        if (!p) return;
        this.pending.delete(data.id);
        if (data.status === 'done') p.resolve(data.report);
        else p.reject(new Error(data.message));
      };
      worker.onerror = (event) => {
        event.preventDefault();
        // A worker that failed (to load or to run) is not used again; what it had fails.
        worker.terminate();
        if (this.worker === worker) this.worker = undefined;
        this.broken = true;
        const failed = [...this.pending.values()];
        this.pending.clear();
        for (const p of failed) p.reject(new Error('interference-worker-failed'));
      };
      this.worker = worker;
    } catch {
      this.broken = true;
    }
    return this.worker;
  }
}

const defaultWorker = () =>
  new Worker(new URL('./interference-worker.ts', import.meta.url), { type: 'module' });
