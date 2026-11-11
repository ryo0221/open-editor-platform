import { describe, expect, it } from 'vitest';
import {
  BakeError,
  boxMesh,
  editInput,
  meshEdges,
  multiresBase,
  unwrapMesh,
} from '@editor-platform/geometry-mesh';
import { geometryTextureImageSize } from '@editor-platform/geometry-core';
import { BakeJobs } from './bake-job';
import { runBake, type BakeRequest, type BakeResponse } from './bake-protocol';

const cube = editInput(boxMesh([200, 200, 200]));
const cage = unwrapMesh(cube, meshEdges(cube.mesh, cube.topology));
const request = () => ({
  cage,
  level: 2,
  displacements: new Float32Array(3 * multiresBase(cage, 2).gridVertex.length),
  size: 512,
});

/** A worker that runs the bake as the real one does, after a turn of the event loop. */
class FakeWorker {
  onmessage: ((e: MessageEvent<BakeResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  posted: BakeRequest | undefined;
  constructor(private readonly hold = false) {}
  postMessage(data: BakeRequest) {
    this.posted = data;
    if (this.hold) return;
    setTimeout(async () => {
      const send = (r: BakeResponse) =>
        !this.terminated && this.onmessage?.({ data: r } as MessageEvent<BakeResponse>);
      send({ id: data.id, status: 'progress', rows: 1, size: data.size });
      try {
        send({ id: data.id, status: 'done', ...(await runBake(data)) });
      } catch (e) {
        const b = e as BakeError;
        send({
          id: data.id,
          status: 'refused',
          problem: b.problem,
          detail: b.detail,
          faces: b.faces,
        });
      }
    });
  }
  terminate() {
    this.terminated = true;
  }
}

describe('bake jobs (C7d, TS-1282)', () => {
  it('bakes in a worker of its own, reports progress, and ends the worker', async () => {
    const worker = new FakeWorker();
    const jobs = new BakeJobs(() => worker as unknown as Worker);
    const seen: number[] = [];
    const req = request();
    const done = await jobs.run(req, (rows) => seen.push(rows)).done;
    expect(geometryTextureImageSize(done.png)).toEqual([512, 512]);
    expect(done.covered).toBeGreaterThan(0);
    expect(seen).toEqual([1]);
    expect(worker.terminated).toBe(true);
    // The caller keeps its displacements (the worker got a copy).
    expect(req.displacements.length).toBeGreaterThan(0);
  });

  it('passes on what the bake refuses, and stops a bake by ending its worker', async () => {
    const jobs = new BakeJobs(() => new FakeWorker() as unknown as Worker);
    await expect(jobs.run({ ...request(), cage: boxMesh([1, 1, 1]) }).done).rejects.toMatchObject({
      problem: 'uv',
    });
    const held = new FakeWorker(true);
    const run = new BakeJobs(() => held as unknown as Worker).run(request());
    run.cancel();
    await expect(run.done).rejects.toMatchObject({ problem: 'cancelled' });
    expect(held.terminated).toBe(true);
  });

  it('bakes on the main thread where no worker starts, and fails a broken worker', async () => {
    const jobs = new BakeJobs(() => {
      throw new Error('no workers here');
    });
    const done = await jobs.run(request()).done;
    expect(geometryTextureImageSize(done.png)).toEqual([512, 512]);
    const broken = new FakeWorker(true);
    const run = new BakeJobs(() => broken as unknown as Worker).run(request());
    broken.onerror?.({ preventDefault() {} } as ErrorEvent);
    await expect(run.done).rejects.toThrow('bake-worker-failed');
  });

  it('runBake times the surface, the bake phases and the PNG when asked (C7e, TS-1287)', async () => {
    const plain = await runBake(request());
    const phases: string[] = [];
    const timed = await runBake(request(), undefined, (phase) => phases.push(phase));
    expect(phases).toEqual(['surface', 'setup', 'raster', 'rays', 'dilate', 'png']);
    expect(timed).toEqual(plain);
  });
});
