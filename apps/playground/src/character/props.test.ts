import { beforeEach, describe, expect, it, vi } from 'vitest';
import { r2bJoints } from '@editor-platform/cad-core';

/** The prop view of a CAD version (C2b-3), over a stand-in for the CAD binding. */
const fake = vi.hoisted(() => ({
  snapshot: {} as Record<string, unknown>,
  meshes: new Map<string, unknown[]>(),
  coarse: new Map<string, unknown[]>(),
  simplified: new Set<string>(),
  later: new Map<string, { state: string }>(),
  notify: [] as (() => void)[],
}));
vi.mock('@editor-platform/cad-kernel-occt/worker?worker', () => ({ default: class {} }));
vi.mock('../model', () => ({ cadKernel: { id: 'k' }, cadKernels: [] }));
vi.mock('@editor-platform/cad', async (real) => ({
  ...(await real<object>()),
  createCadBinding: (o: { parts: { get: (h: string) => unknown } }) => ({
    controller: {
      subscribe: (f: () => void) => (fake.notify.push(f), () => {}),
      getSnapshot: () => fake.snapshot,
      sync: async () => {},
    },
    assembly: {
      subscribe: (f: () => void) => (fake.notify.push(f), () => {}),
      lookup: o.parts.get,
      meshes: (h: string) => fake.meshes.get(h),
      coarseMeshes: (h: string) => fake.coarse.get(h),
      getSnapshot: () => ({ simplified: fake.simplified }),
      later: (h: string) => fake.later.get(h),
    },
    dispose: () => {},
  }),
}));
const { CharacterPropEvaluation } = await import('./props');

const rig = r2bJoints();
const mesh = (bodyId: string) => ({
  bodyId,
  origin: [0, 0, 0],
  positions: new Float32Array(9),
  normals: new Float32Array(9),
  indices: new Uint32Array([0, 1, 2]),
});
const ok = (pending: string[] = []) => ({
  status: 'ok',
  assembly: {
    poses: rig.assembly.solvedPoses,
    joints: {},
    versions: Object.fromEntries(
      [rig.plate, rig.shaft, rig.pair]
        .filter((v) => !pending.includes(v.contentHash))
        .map((v) => [v.contentHash, { state: 'available' }]),
    ),
    ...(pending.length ? { pending } : {}),
  },
});
const evaluate = () =>
  new CharacterPropEvaluation(
    rig.assembly,
    (h) => rig.closure.get(h),
    () => {},
  );
const settle = (snapshot: Record<string, unknown>) => {
  fake.snapshot = { busy: false, geometryState: 'ready', meshes: undefined, ...snapshot };
  for (const f of fake.notify) f();
};

describe('CharacterPropEvaluation', () => {
  beforeEach(() => {
    fake.notify = [];
    fake.meshes.clear();
    fake.coarse.clear();
    fake.simplified.clear();
    fake.later.clear();
    fake.snapshot = { busy: true, geometryState: 'reevaluating' };
  });
  it('shows a failure kept apart from the evaluation (the Worker could not start)', () => {
    const p = evaluate();
    settle({
      evaluation: undefined,
      geometryState: 'geometry-error',
      geometryFailure: 'no worker',
    });
    expect(p.view).toEqual({ status: 'failed', message: 'no worker' });
  });
  it('stays pending until versions evaluated in the background have meshes', () => {
    const p = evaluate();
    for (const v of [rig.plate, rig.shaft]) fake.meshes.set(v.contentHash, [mesh('b')]);
    settle({ evaluation: ok([rig.pair.contentHash]) });
    expect(p.view.status).toBe('pending');
    fake.later.set(rig.pair.contentHash, { state: 'available' });
    settle({ evaluation: ok([rig.pair.contentHash]) });
    expect(p.view.status).toBe('pending');
    fake.meshes.set(rig.pair.contentHash, [mesh('b')]);
    settle({ evaluation: ok([rig.pair.contentHash]) });
    expect(p.view.status).toBe('ready');
  });
  it('draws a simplified version by its coarse meshes, else as a box over its bounds', () => {
    const p = evaluate();
    fake.coarse.set(rig.plate.contentHash, [mesh('b')]);
    fake.meshes.set(rig.pair.contentHash, []);
    for (const v of [rig.plate, rig.shaft]) fake.simplified.add(v.contentHash);
    settle({ evaluation: ok() });
    if (p.view.status !== 'ready') throw new Error(p.view.status);
    const drawn = p.view.draw(new Map());
    const n = (h: string) =>
      [...drawn].filter((i) => i.mesh.positions.length === (h === 'box' ? 72 : 9)).length;
    // Every plate (three placed, two in the pair) by its coarse meshes, the shaft as a box.
    expect(n('mesh')).toBe(5);
    expect(n('box')).toBe(1);
  });
  it('draws a version that failed its checks as a box, not by the meshes it delivered', () => {
    const p = evaluate();
    for (const v of [rig.plate, rig.shaft]) fake.meshes.set(v.contentHash, [mesh('b')]);
    fake.meshes.set(rig.pair.contentHash, []);
    const evaluation = ok();
    evaluation.assembly.versions[rig.shaft.contentHash] = { state: 'failed' };
    settle({ evaluation });
    if (p.view.status !== 'ready') throw new Error(p.view.status);
    const drawn = p.view.draw(new Map());
    expect(drawn.filter((i) => i.mesh.positions.length === 72)).toHaveLength(1);
    expect(drawn.filter((i) => i.mesh.positions.length === 9)).toHaveLength(5);
  });
});
