import { describe, expect, it } from 'vitest';
import { composePoses, stepPose } from './assembly';
import { assertCadOperation } from './commands';
import { compareCad } from './diff';
import { parameterValues } from './graph';
import { formPoses } from './interference';
import { invertPose, solveJoints } from './joints';
import { mr2ArmWingsForms, mr7ToolMount } from './mecha-fixtures';
import type { CadDocument } from './model';
import {
  ease,
  motionCameraAt,
  motionDeltas,
  motionUnsolvedJoints,
  motionDurationMs,
  motionSegmentAt,
  motionStaleForms,
  motionStateAt,
  withCameraKey,
  type CadMotion,
  type CadMotionCameraKey,
} from './motions';
import { applyCadOperation, type CadOperation } from './operations';
import { validateCad } from './validation';

const deg = Math.PI / 180;
const codes = (doc: unknown) => validateCad(doc).map((d) => d.code);
const run = (doc: CadDocument, op: CadOperation) => {
  assertCadOperation(op);
  return applyCadOperation(doc, op);
};
const motion = (over: Partial<CadMotion> = {}): CadMotion => ({
  id: 'motion-fold',
  name: 'Fold',
  startFormId: 'form-stand',
  steps: [
    { formId: 'form-flight', durationMs: 2000, easing: 'linear' },
    { formId: 'form-stand', durationMs: 1000, easing: 'easeInOut' },
  ],
  ...over,
});
const key = (atMs: number, x: number, fovDeg = 40): CadMotionCameraKey => ({
  atMs,
  camera: { position: [x, -1000, 500], target: [x, 0, 0], up: [0, 0, 1] },
  fovRad: fovDeg * deg,
});
const solutions = (doc: CadDocument, closure: Map<string, CadDocument>) =>
  solveJoints(
    doc,
    parameterValues(doc),
    (h) => closure.get(h),
    () => undefined,
    () => true,
  ).joints;

describe('#18 motions: form-to-form interpolation and camera paths', () => {
  it('stores motions as one edit, validates their shape and reports the change', () => {
    const { assembly } = mr2ArmWingsForms();
    const next = run(assembly, { type: 'setMotions', motions: [motion({ camera: [key(0, 0)] })] });
    expect(codes(next)).toEqual([]);
    expect(compareCad(assembly, next).map((c) => c.elementId)).toEqual(['motions']);
    expect(() => run(next, { type: 'setMotions', motions: next.motions! })).toThrow(
      'motions-unchanged',
    );
    expect(run(next, { type: 'setMotions', motions: [] }).motions).toBeUndefined();
  });
  it('refuses bad steps, easings, durations and camera keys', () => {
    const { assembly } = mr2ArmWingsForms();
    const bad = (m: unknown) => codes({ ...assembly, motions: [m] });
    expect(bad(motion({ steps: [] }))).toContain('motion-steps');
    expect(
      bad(motion({ steps: [{ formId: 'form-flight', durationMs: 0, easing: 'linear' }] })),
    ).toContain('motion-duration');
    expect(
      bad(
        motion({ steps: [{ formId: 'form-flight', durationMs: 10, easing: 'bounce' as never }] }),
      ),
    ).toContain('motion-easing');
    expect(bad(motion({ camera: [key(500, 0), key(500, 1)] }))).toContain('motion-camera-time');
    expect(bad(motion({ camera: [key(4000, 0)] }))).toContain('motion-camera-time');
    expect(bad(motion({ camera: [{ ...key(0, 0), fovRad: 0 }] }))).toContain('projection-fov');
    const along = key(0, 0);
    along.camera.up = [0, 1, 0];
    along.camera.target = [0, 1000, 500];
    expect(bad(motion({ camera: [along] }))).toContain('camera-degenerate');
    expect(codes({ ...assembly, motions: [motion(), motion()] })).toContain('duplicate-id');
  });
  it('eases and finds the step at a time', () => {
    expect(ease('linear', 0.25)).toBe(0.25);
    expect(ease('easeInOut', 0)).toBe(0);
    expect(ease('easeInOut', 0.5)).toBeCloseTo(0.5, 12);
    expect(ease('easeInOut', 1)).toBeCloseTo(1, 12);
    expect(ease('easeInOut', 0.1)).toBeLessThan(0.1);
    const m = motion();
    expect(motionDurationMs(m)).toBe(3000);
    expect(motionSegmentAt(m, -5)).toEqual({
      step: 0,
      from: 'form-stand',
      to: 'form-flight',
      u: 0,
    });
    expect(motionSegmentAt(m, 500)).toMatchObject({ step: 0, u: 0.25 });
    expect(motionSegmentAt(m, 2000)).toEqual({
      step: 1,
      from: 'form-flight',
      to: 'form-stand',
      u: 0,
    });
    expect(motionSegmentAt(m, 2500).u).toBeCloseTo(0.5, 12);
    expect(motionSegmentAt(m, 9000)).toEqual({
      step: 1,
      from: 'form-flight',
      to: 'form-stand',
      u: 1,
    });
  });
  it('interpolates every moving joint value between the two forms', () => {
    const { assembly } = mr2ArmWingsForms();
    const m = motion();
    const quarter = motionStateAt(assembly, m, 500)!;
    // Elbow 45° → 0°, wing 40° → 80°, shoulder angle2 −20° → −80°, a quarter of the way.
    expect(quarter.values.get('j-elbow')!.angle).toBeCloseTo(33.75 * deg, 12);
    expect(quarter.values.get('j-wing-l')!.angle).toBeCloseTo(50 * deg, 12);
    expect(quarter.values.get('j-shoulder')!.angle2).toBeCloseTo(-35 * deg, 12);
    // The coupled wing is not a form value: it follows through its coupling.
    expect(quarter.values.has('j-wing-r')).toBe(false);
    const end = motionStateAt(assembly, m, 2000)!;
    expect(end.values.get('j-wing-l')!.angle).toBeCloseTo(80 * deg, 12);
  });
  it('moves the parts to where the form puts them, at the end of the step', () => {
    const { assembly, closure } = mr2ArmWingsForms();
    const joints = solutions(assembly, closure);
    const state = motionStateAt(assembly, motion(), 2000)!;
    const deltas = motionDeltas(assembly, joints, state.values, state.mounts);
    const flight = assembly.configurations!.find((f) => f.id === 'form-flight')!;
    const want = formPoses(assembly, joints, flight);
    const params = parameterValues(assembly);
    for (const id of ['c-upper', 'c-fore', 'c-hand', 'c-wing-l', 'c-wing-r']) {
      const shown = stepPose(assembly, assembly.solvedPoses, id, params)!;
      const target = stepPose(assembly, want, id, params)!;
      const got = composePoses(deltas.get(id)!, shown);
      for (let i = 0; i < 3; i++)
        expect(got.translationMm[i]).toBeCloseTo(target.translationMm[i]!, 6);
      const dq = composePoses(got, invertPose(target)).rotation;
      expect(Math.abs(dq[3])).toBeCloseTo(1, 9);
    }
    // In the form the document stands in, nothing moves.
    const start = motionStateAt(assembly, motion(), 0)!;
    expect(motionDeltas(assembly, joints, start.values, start.mounts).size).toBe(0);
  });
  it('names the joints in effect that have not solved (Codex on #34)', () => {
    const { assembly, closure } = mr2ArmWingsForms();
    const joints = solutions(assembly, closure);
    expect(motionUnsolvedJoints(assembly, joints)).toEqual([]);
    const broken = { ...joints, 'j-elbow': { status: 'unavailable' as const } };
    expect(motionUnsolvedJoints(assembly, broken)).toEqual(['j-elbow']);
    const { 'j-wing-r': _gone, ...missing } = joints;
    expect(motionUnsolvedJoints(assembly, missing)).toEqual(['j-wing-r']);
  });
  it('switches a mount when the step ends', () => {
    const { assembly } = mr7ToolMount();
    const doc = structuredClone(assembly);
    const values = mr2ArmWingsForms().assembly.configurations!;
    doc.configurations = [
      { ...values[0]!, mounts: { 'm-tool': 'j-tool-hand' } },
      { ...values[1]!, mounts: { 'm-tool': 'j-tool-back' } },
    ];
    expect(codes(doc)).toEqual([]);
    const m = motion({ steps: [{ formId: 'form-flight', durationMs: 1000, easing: 'linear' }] });
    expect(motionStateAt(doc, m, 999)!.mounts).toEqual({ 'm-tool': 'j-tool-hand' });
    expect(motionStateAt(doc, m, 1000)!.mounts).toEqual({ 'm-tool': 'j-tool-back' });
  });
  it('is stale while a form it passes is gone', () => {
    const { assembly } = mr2ArmWingsForms();
    const m = motion({ steps: [{ formId: 'form-gone', durationMs: 10, easing: 'linear' }] });
    expect(motionStaleForms(assembly, m)).toEqual(['form-gone']);
    expect(motionStateAt(assembly, m, 5)).toBeUndefined();
  });
  it('is stale while a form it passes is past the joint limits now (Codex on #34)', () => {
    const { assembly } = mr2ArmWingsForms();
    const doc = structuredClone(assembly);
    doc.configurations![1]!.values['j-elbow'] = { angle: { literalRad: 170 * deg } };
    const m = motion();
    expect(motionStaleForms(doc, m)).toEqual(['form-flight']);
    expect(motionStateAt(doc, m, 500)).toBeUndefined();
    expect(motionStaleForms(assembly, m)).toEqual([]);
  });
  it('follows the camera keys: held outside them, through each key, smooth between', () => {
    expect(motionCameraAt(undefined, 0)).toBeUndefined();
    const keys = [key(0, 0, 30), key(1000, 1000, 50), key(2000, 1000, 50), key(3000, 0, 30)];
    expect(motionCameraAt(keys, -10)!.camera.position).toEqual([0, -1000, 500]);
    expect(motionCameraAt(keys, 5000)!.camera.position).toEqual([0, -1000, 500]);
    const at1 = motionCameraAt(keys, 1000)!;
    expect(at1.camera.position[0]).toBeCloseTo(1000, 9);
    expect(at1.fovRad).toBeCloseTo(50 * deg, 12);
    const mid = motionCameraAt(keys, 500)!;
    expect(mid.fovRad).toBeCloseTo(40 * deg, 12);
    // Catmull-Rom: halfway between the first two keys (the missing neighbour extended in line).
    expect(mid.camera.position[0]).toBeCloseTo(562.5, 9);
    expect(mid.camera.target[0]).toBeCloseTo(562.5, 9);
    expect(Math.hypot(...mid.camera.up)).toBeCloseTo(1, 12);
    // Two keys: a straight line.
    expect(motionCameraAt([key(0, 0), key(1000, 1000)], 250)!.camera.position[0]).toBeCloseTo(
      250,
      9,
    );
  });
  it('keeps a camera between keys on opposite sides of the target or with opposite ups (Codex on #37)', () => {
    const cam = (atMs: number, position: [number, number, number], up: [number, number, number]) =>
      ({
        atMs,
        camera: { position, target: [0, 0, 0], up },
        fovRad: 40 * deg,
      }) as CadMotionCameraKey;
    const valid = (c: NonNullable<ReturnType<typeof motionCameraAt>>['camera']) => {
      const view = c.position.map((v, i) => v - c.target[i]!);
      const d = Math.hypot(...view);
      expect(d).toBeGreaterThan(1);
      expect(Math.hypot(...c.up)).toBeCloseTo(1, 9);
      // The up is not along the view.
      expect(Math.abs(c.up.reduce((n, v, i) => n + v * view[i]!, 0) / d)).toBeLessThan(1e-6);
    };
    const across = [cam(0, [0, -1000, 0], [0, 0, 1]), cam(1000, [0, 1000, 0], [0, 0, 1])];
    for (const t of [250, 500, 750]) valid(motionCameraAt(across, t)!.camera);
    const mid = motionCameraAt(across, 500)!.camera;
    // Halfway round about the up, at the keys' distance.
    expect(Math.hypot(...mid.position)).toBeCloseTo(1000, 6);
    expect(mid.position[2]).toBeCloseTo(0, 6);
    // The path is continuous: no jump between neighbouring frames (Codex on #38).
    let was = motionCameraAt(across, 0)!.camera.position;
    for (let t = 1; t <= 1000; t++) {
      const now = motionCameraAt(across, t)!.camera.position;
      expect(Math.hypot(...now.map((v, i) => v - was[i]!))).toBeLessThan(10);
      was = now;
    }
    const flipped = [cam(0, [0, -1000, 0], [0, 0, 1]), cam(1000, [0, -1000, 0], [0, 0, -1])];
    for (const t of [250, 500, 750]) valid(motionCameraAt(flipped, t)!.camera);
    // The up turns about the view: halfway it is at right angles to both keys' ups.
    expect(motionCameraAt(flipped, 500)!.camera.up[2]).toBeCloseTo(0, 9);
  });
  it('carries the up with the view so the camera never rolls over (Codex on #38)', () => {
    const [c, sn] = [Math.cos(Math.PI / 8), Math.sin(Math.PI / 8)];
    const keys = [
      {
        atMs: 0,
        camera: { position: [1000 * c, 1000 * sn, -250], target: [0, 0, 0], up: [1, 0, 0] },
        fovRad: 40 * deg,
      },
      {
        atMs: 1000,
        camera: { position: [1000 * c, 1000 * sn, 750], target: [0, 0, 0], up: [0, 1, 0] },
        fovRad: 40 * deg,
      },
    ] as CadMotionCameraKey[];
    // The up as the camera shows it: off the view, as `lookAt` takes it.
    const shown = (t: number) => {
      const cam = motionCameraAt(keys, t)!.camera;
      const view = cam.position.map((v, i) => v - cam.target[i]!);
      const l = Math.hypot(...view);
      const d = cam.up.reduce((n, v, i) => n + (v * view[i]!) / l, 0);
      const up = cam.up.map((v, i) => v - (d * view[i]!) / l);
      const m = Math.hypot(...up);
      return up.map((v) => v / m);
    };
    let was = shown(0);
    for (let t = 0.5; t <= 1000; t += 0.5) {
      const now = shown(t);
      expect(now.reduce((n, v, i) => n + v * was[i]!, 0)).toBeGreaterThan(0.99);
      was = now;
    }
    // Through each key, its own up.
    expect(shown(999.999).reduce((n, v, i) => n + v * shown(1000)[i]!, 0)).toBeGreaterThan(0.999);
  });
  it('keeps the roll continuous through three keys (Codex on #38)', () => {
    const k = (atMs: number, position: number[], up: number[]) =>
      ({
        atMs,
        camera: { position, target: [0, 0, 0], up },
        fovRad: 40 * deg,
      }) as CadMotionCameraKey;
    const keys = [
      k(0, [0, 0, 1000], [0, 1, 0]),
      k(1000, [1000, 0, 0], [0, -Math.cos(0.05), -Math.sin(0.05)]),
      k(2000, [0, 1000, 1000], [0, 0, 1]),
    ];
    const shown = (t: number) => {
      const cam = motionCameraAt(keys, t)!.camera;
      const view = cam.position.map((v, i) => v - cam.target[i]!);
      const l = Math.hypot(...view);
      const d = cam.up.reduce((n, v, i) => n + (v * view[i]!) / l, 0);
      const up = cam.up.map((v, i) => v - (d * view[i]!) / l);
      const m = Math.hypot(...up);
      return up.map((v) => v / m);
    };
    let was = shown(0);
    for (let t = 0.5; t <= 2000; t += 0.5) {
      const now = shown(t);
      expect(now.reduce((n, v, i) => n + v * was[i]!, 0)).toBeGreaterThan(0.99);
      was = now;
    }
  });
  it('adds a camera key in time order, replacing one at the same time', () => {
    const keys = withCameraKey(withCameraKey(undefined, key(1000, 1)), key(0, 2));
    expect(keys.map((k) => k.atMs)).toEqual([0, 1000]);
    const replaced = withCameraKey(keys, key(1000, 9));
    expect(replaced.map((k) => k.camera.position[0])).toEqual([2, 9]);
  });
});
