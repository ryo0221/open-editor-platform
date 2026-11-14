import { describe, expect, it } from 'vitest';
import {
  mr2ArmWingsForms,
  parameterValues,
  solveJoints,
  type CadInterferenceMesh,
  type CadInterferenceReport,
  type CadSweepReport,
} from '@editor-platform/cad-core';
import {
  CadInterferenceJobs,
  runInterference,
  type CadInterferenceRequest,
} from './interference-job';

const plate = (): CadInterferenceMesh[] => [
  {
    bodyId: 'plate',
    origin: [0, 0, 0],
    positions: Float32Array.from([
      -5, -5, 0, 85, -5, 0, 85, 5, 0, -5, 5, 0, -5, -5, 5, 85, -5, 5, 85, 5, 5, -5, 5, 5,
    ]),
    indices: Uint32Array.from([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3,
      0, 4, 3, 4, 7,
    ]),
  },
];
function request(): CadInterferenceRequest {
  const f = mr2ArmWingsForms();
  const hash = f.assembly.parts[0]!.source.contentHash;
  return {
    doc: f.assembly,
    parts: { [hash]: f.closure.get(hash)! },
    meshes: { [hash]: plate() },
    ownMeshes: plate(),
    joints: {},
  };
}

describe('MR5 interference along a motion in a job (TS-1714)', () => {
  it('checks each sampled time from plain joint values', () => {
    const base = request();
    // The joint solutions the evaluation gives (where each parent connector is).
    const { joints } = solveJoints(
      base.doc,
      parameterValues(base.doc),
      (h) => base.parts[h],
      () => undefined,
      () => true,
    );
    const r = runInterference({
      ...base,
      joints,
      samples: [
        { tick: 0, values: { 'j-elbow': { angle: 0 } } },
        { tick: 240_000, values: { 'j-elbow': { angle: Math.PI / 2 } } },
      ],
    }) as CadSweepReport;
    expect(r.status === 'ok' && [r.samples, r.hits.map((h) => h.tick)]).toEqual([2, [0, 240_000]]);
  });
});

describe('MR3 interference jobs (TS-1709)', () => {
  it('reads plain data: versions and meshes by content hash', () => {
    const r = runInterference(request()) as CadInterferenceReport;
    expect(r.status === 'ok' && r.findings.map((f) => `${f.a}–${f.b}`)).toEqual([
      'c-upper–c-fore',
      'c-fore–c-hand',
    ]);
    expect(r.status === 'ok' && r.unchecked).toEqual([]);
  });
  it('runs on the main thread when no worker starts, and through one that answers', async () => {
    const here = new CadInterferenceJobs(() => {
      throw new Error('no worker');
    });
    expect((await here.run(request())).status).toBe('ok');
    // A worker stand-in that runs the request as the worker script does.
    const fake = {
      onmessage: null as ((e: MessageEvent) => void) | null,
      onerror: null as ((e: ErrorEvent) => void) | null,
      postMessage(data: { id: number; request: CadInterferenceRequest }) {
        queueMicrotask(() =>
          this.onmessage?.({
            data: { id: data.id, status: 'done', report: runInterference(data.request) },
          } as MessageEvent),
        );
      },
      terminate() {},
    };
    const jobs = new CadInterferenceJobs(() => fake as unknown as Worker);
    const original = globalThis.Worker;
    globalThis.Worker ??= class {} as unknown as typeof Worker;
    try {
      const r = (await jobs.run(request())) as CadInterferenceReport;
      expect(r.status === 'ok' && r.findings.length).toBe(2);
      jobs.dispose();
      await expect(jobs.run(request())).resolves.toMatchObject({ status: 'ok' });
    } finally {
      if (!original) delete (globalThis as { Worker?: unknown }).Worker;
    }
  });
});

describe('clearance in a job (CR7c, TS-1814)', () => {
  it('measures between two components from plain data', () => {
    const base = request();
    const [first, second] = base.doc.components;
    const r = runInterference({ ...base, clearance: { a: [first!.id], b: [second!.id] } });
    expect(r.status).toBe('ok');
    expect(runInterference({ ...base, clearance: { a: [first!.id], b: [first!.id] } })).toEqual({
      status: 'refused',
      code: 'clearance-same',
    });
  });
});
