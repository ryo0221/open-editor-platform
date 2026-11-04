import { describe, expect, it } from 'vitest';
import { boxMesh, MeshEditError, subdivideMesh } from '@editor-platform/geometry-mesh';
import { SubdivisionJobs } from './subdivision-job';
import type { SubdivisionRequest, SubdivisionResponse } from './subdivision-protocol';

/** A worker that answers as the real one does, after a turn of the event loop. */
class FakeWorker {
  onmessage: ((e: MessageEvent<SubdivisionResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  constructor(private readonly fail = false) {}
  postMessage(data: SubdivisionRequest) {
    setTimeout(() => {
      if (this.fail) {
        this.onerror?.({ preventDefault() {} } as ErrorEvent);
        return;
      }
      let reply: SubdivisionResponse;
      try {
        reply = { id: data.id, status: 'done', mesh: subdivideMesh(data.mesh, data.levels) };
      } catch (e) {
        const m = e as MeshEditError;
        reply = { id: data.id, status: 'refused', problem: m.problem, detail: m.detail };
      }
      this.onmessage?.({ data: reply } as MessageEvent<SubdivisionResponse>);
    });
  }
  terminate() {
    this.terminated = true;
  }
}

describe('subdivision jobs (C3i, TS-1234)', () => {
  const cube = boxMesh([200, 200, 200]);
  it('smooths in the worker, and refuses what subdivision refuses', async () => {
    const worker = new FakeWorker();
    const jobs = new SubdivisionJobs(() => worker as unknown as Worker);
    const [one, two] = await Promise.all([jobs.run(cube, 1), jobs.run(cube, 2)]);
    expect(one.faceSizes.length).toBe(24);
    expect(two.faceSizes.length).toBe(96);
    await expect(jobs.run(cube, 9)).rejects.toBeInstanceOf(MeshEditError);
    jobs.dispose();
    expect(worker.terminated).toBe(true);
  });
  it('runs on the main thread where no worker starts, or after the worker failed', async () => {
    const none = new SubdivisionJobs(() => {
      throw new Error('no Worker');
    });
    expect((await none.run(cube, 1)).faceSizes.length).toBe(24);
    const failing = new FakeWorker(true);
    const jobs = new SubdivisionJobs(() => failing as unknown as Worker);
    await expect(jobs.run(cube, 1)).rejects.toThrow('subdivision-worker-failed');
    expect(failing.terminated).toBe(true);
    expect((await jobs.run(cube, 1)).faceSizes.length).toBe(24);
  });
  it('rejects what is pending when disposed', async () => {
    const jobs = new SubdivisionJobs(() => new FakeWorker() as unknown as Worker);
    const p = jobs.run(cube, 2);
    jobs.dispose();
    await expect(p).rejects.toThrow('subdivision-cancelled');
  });
});
