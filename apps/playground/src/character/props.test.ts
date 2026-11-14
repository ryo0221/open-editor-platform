import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentConfigurationValues, mr1ArmWings, r2bJoints } from '@editor-platform/cad-core';

/** The prop view of a CAD version (C2b-3), over a stand-in for the CAD binding. */
const fake = vi.hoisted(() => ({
  snapshot: {} as Record<string, unknown>,
  meshes: new Map<string, unknown[]>(),
  coarse: new Map<string, unknown[]>(),
  simplified: new Set<string>(),
  later: new Map<string, { state: string }>(),
  notify: [] as (() => void)[],
  sweep: (_samples: { tick: number }[]): unknown => ({ error: 'unset' }),
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
      checkInterferenceAlong: async (samples: { tick: number }[]) => fake.sweep(samples),
    },
    dispose: () => {},
  }),
}));
const { CharacterPropEvaluation, kernelFailure, propVersionJoints } = await import('./props');

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
const evaluate = (doc = rig.assembly) =>
  new CharacterPropEvaluation(
    doc,
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
  it('gives a mesh its body’s finish and light, for the realistic lighting (CR7g-3, TS-1835)', () => {
    const plate = rig.closure.get(rig.plate.contentHash)!;
    const body = plate.bodies[0]!.id;
    const look = {
      color: '#cccccc',
      opacity: 1,
      roughness: 0.04,
      metalness: 1,
      emission: { color: '#ffffff', strength: 2 },
    };
    const lit = { ...plate, bodies: plate.bodies.map((b) => ({ ...b, appearance: look })) };
    const p = new CharacterPropEvaluation(
      rig.assembly,
      (h) => (h === rig.plate.contentHash ? lit : rig.closure.get(h)),
      () => {},
    );
    fake.meshes.set(rig.plate.contentHash, [mesh(body)]);
    fake.meshes.set(rig.shaft.contentHash, [mesh('other')]);
    fake.meshes.set(rig.pair.contentHash, []);
    settle({ evaluation: ok() });
    if (p.view.status !== 'ready') throw new Error(p.view.status);
    const drawn = p.view.draw(new Map());
    const plates = drawn.filter((i) => i.mesh.color === '#cccccc');
    expect(plates.length).toBeGreaterThan(0);
    for (const i of plates)
      expect(i.mesh.finish).toEqual({
        roughness: 0.04,
        metalness: 1,
        emission: { color: '#ffffff', strength: 2 },
      });
    // A body without a finish of its own keeps none: the view draws its plain finish.
    expect(drawn.filter((i) => i.mesh.color !== '#cccccc').every((i) => !i.mesh.finish)).toBe(true);
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
  it('lists the forms with their own values in radians and mm, and why one cannot be used (MR4b, TS-1712)', () => {
    const doc = structuredClone(rig.assembly);
    const now = currentConfigurationValues(doc);
    const past = structuredClone(now);
    past['j-slide'] = { distance: { literalMm: 30 } };
    const stale = structuredClone(now);
    delete stale['j-turn'];
    doc.configurations = [
      { id: 'f-now', name: 'Now', values: now },
      { id: 'f-past', name: 'Past', values: past },
      { id: 'f-stale', name: 'Stale', values: stale },
    ];
    const p = evaluate(doc);
    for (const v of [rig.plate, rig.shaft, rig.pair]) fake.meshes.set(v.contentHash, [mesh('b')]);
    settle({ evaluation: ok() });
    if (p.view.status !== 'ready') throw new Error(p.view.status);
    const forms = p.view.forms!;
    expect(forms.map((f) => [f.id, f.problem])).toEqual([
      ['f-now', undefined],
      ['f-past', 'joint-limit'],
      ['f-stale', 'configuration-stale'],
    ]);
    // The angle the parameter gave (30°) in radians, the slide in mm, as the keys store them.
    expect(forms[0]!.values['j-turn']).toEqual({ angle: Math.PI / 6 });
    expect(forms[0]!.values['j-slide']).toEqual({ distance: 12 });
    expect(forms[2]!.values).toEqual({});
  });
});

describe('kernelFailure (C8p, TS-1296)', () => {
  it('names a kernel that could not run, not an element that failed on its own', () => {
    const elements = (...codes: string[]) => ({
      elements: new Map(codes.map((code, i) => [`e${i}`, { status: 'error', code }])),
    });
    expect(kernelFailure({ elements: new Map([['w', { status: 'ok' }]]) })).toBeUndefined();
    expect(kernelFailure(elements('shape-too-large'))).toBeUndefined();
    expect(kernelFailure(elements('shape-too-large', 'kernel-crashed'))).toBe('kernel-crashed');
    expect(kernelFailure(elements('kernel-load-failed'))).toBe('kernel-load-failed');
  });
});

describe('propVersionJoints (MR4c, TS-1713)', () => {
  it('lists the keyable values with their limits, and the values that follow another joint', () => {
    const { assembly } = mr1ArmWings();
    const v = propVersionJoints(assembly);
    // The right wing follows the left: it has no value of its own to key, and is a follower.
    expect(v.joints.some((j) => j.id === 'j-wing-r')).toBe(false);
    expect(v.followers).toEqual([
      {
        joint: 'j-wing-r',
        key: 'angle',
        from: { joint: 'j-wing-l', key: 'angle' },
        ratio: -1,
        offset: 0,
        min: -Math.PI / 2,
        max: Math.PI / 2,
      },
    ]);
    const wing = v.joints.find((j) => j.id === 'j-wing-l')!;
    expect(wing.values).toEqual([
      { key: 'angle', saved: (40 * Math.PI) / 180, min: -Math.PI / 2, max: Math.PI / 2 },
    ]);
    // Without its own limits a follower still keeps the safety bound: one turn either way.
    const bare = structuredClone(assembly);
    const r = bare.joints.find((j) => j.id === 'j-wing-r')!;
    r.limits = [];
    expect(propVersionJoints(bare).followers[0]).toMatchObject({
      min: -2 * Math.PI,
      max: 2 * Math.PI,
    });
  });

  it('bounds a keyed angle by one turn, or a continuous joint and its followers by its bound (WM2a, TS-1886)', () => {
    const { assembly } = mr1ArmWings();
    const doc = structuredClone(assembly);
    for (const j of doc.joints.filter((x) => x.id.startsWith('j-wing'))) j.limits = [];
    const one = propVersionJoints(doc);
    expect(one.joints.find((j) => j.id === 'j-wing-l')!.values[0]).toMatchObject({
      min: -2 * Math.PI,
      max: 2 * Math.PI,
    });
    for (const j of doc.joints.filter((x) => x.id.startsWith('j-wing'))) j.continuous = true;
    const many = propVersionJoints(doc);
    const bound = { min: -1_000_000, max: 1_000_000 };
    expect(many.joints.find((j) => j.id === 'j-wing-l')!.values[0]).toMatchObject(bound);
    expect(many.followers[0]).toMatchObject(bound);
  });
});

describe('checkInterferenceAlong in the prop view (MR5, TS-1714)', () => {
  it('sends the keyed values as plain data and names the parts by their components', async () => {
    fake.notify = [];
    const p = evaluate();
    for (const v of [rig.plate, rig.shaft, rig.pair]) fake.meshes.set(v.contentHash, [mesh('b')]);
    settle({ evaluation: ok() });
    if (p.view.status !== 'ready') throw new Error(p.view.status);
    let sent: unknown;
    fake.sweep = (samples) => {
      sent = samples;
      return {
        content: rig.assembly,
        report: {
          status: 'ok',
          samples: samples.length,
          hits: [
            {
              tick: 1000,
              findings: [
                {
                  a: [],
                  b: ['c-pair', 'pair-b'],
                  kind: 'intersect',
                  depthMm: 1.5,
                  crossings: 3,
                  contained: 0,
                },
              ],
            },
          ],
          unchecked: [['c-shaft']],
          stale: [],
          jumps: [{ tick: 1000, mount: 'm-x', from: 'j-a', to: 'j-b', mm: 2, rad: 0 }],
        },
      };
    };
    const r = await p.view.checkInterferenceAlong!([
      { tick: 1000, values: new Map([['j-turn', { angle: 1 }]]) },
    ]);
    expect(sent).toEqual([{ tick: 1000, values: { 'j-turn': { angle: 1 } } }]);
    const names = rig.assembly.components.map((c) => [c.id, c.name]);
    const name = (id: string) => names.find(([i]) => i === id)![1];
    expect(r).toMatchObject({
      status: 'ok',
      samples: 1,
      hits: [{ tick: 1000, overlaps: [{ a: 'Own shape', kind: 'intersect', depthMm: 1.5 }] }],
      unchecked: [name('c-shaft')],
      // MR7: switches that move their part, as the check found them.
      jumps: [{ tick: 1000, mount: 'm-x', from: 'j-a', to: 'j-b', mm: 2, rad: 0 }],
    });
    // A nested part is named by the components on its path.
    if (r.status === 'ok')
      expect(r.hits[0]!.overlaps[0]!.b).toMatch(new RegExp(`^${name('c-pair')} / `));
    fake.sweep = () => ({ error: 'interference-not-ready' });
    expect(await p.view.checkInterferenceAlong!([])).toEqual({
      status: 'refused',
      code: 'interference-not-ready',
    });
  });
});
