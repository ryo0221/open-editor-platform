import { describe, expect, it } from 'vitest';
import {
  f28B2Car,
  f28B2CarParts,
  f28GapParameter,
  f28HingePose,
  f28Outlines,
} from './car-fixtures';
import { posesDiffer } from './assembly';
import { posesForJointValues, solveJoints } from './joints';
import { parameterValues } from './graph';
import { applyCadOperation } from './operations';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);

describe('F28 B2 car sample (CR3f)', () => {
  it('cuts the door, hood and hatch as panels and the windows from the B1 skin', () => {
    // TS-1523, ST-259.
    const doc = f28B2Car();
    expect(codes(doc)).toEqual([]);
    const ids = doc.bodies.filter((b) => b.state === 'active').map((b) => b.id);
    for (const id of ['skin-body', 'door-body', 'hood-body', 'hatch-body'])
      expect(ids).toContain(id);
    const skin = doc.bodies.find((b) => b.id === 'skin-body')!;
    expect(skin.resultFeatureId).toBe('windows-placement');
    // Every opening and panel reads the same gap; one edit changes it everywhere it is used.
    const gaps = doc.features.flatMap((f) =>
      f.type === 'trim' || f.type === 'panel' ? [[f.id, f.args.gap]] : [],
    );
    expect(gaps.filter(([, g]) => g).map(([id]) => id)).toEqual([
      'door-opening',
      'door',
      'hood-opening',
      'hood',
      'hatch-opening',
      'hatch',
    ]);
    expect(new Set(gaps.flatMap(([, g]) => (g ? [JSON.stringify(g)] : [])))).toEqual(
      new Set([JSON.stringify({ parameterId: f28GapParameter })]),
    );
    // Changing it is one ordinary parameter edit; a gap outside 0.5–10 mm is refused.
    const wider = applyCadOperation(doc, {
      type: 'setParameter',
      parameterId: f28GapParameter,
      value: 6,
    });
    expect(codes(wider)).toEqual([]);
    expect(wider.parameters.find((p) => p.id === f28GapParameter)).toMatchObject({ value: 6 });
    expect(() =>
      applyCadOperation(doc, { type: 'setParameter', parameterId: f28GapParameter, value: 12 }),
    ).toThrow(/panel-gap/);
    expect(f28Outlines.windows).toHaveLength(2);
  });

  it('makes the door and hood parts on hinges that turn them about their own edges', () => {
    // TS-1524, ST-259.
    const { assembly: doc, closure } = f28B2CarParts();
    expect(codes(doc)).toEqual([]);
    expect(doc.bodies.some((b) => b.id === 'door-body' || b.id === 'hood-body')).toBe(false);
    expect(doc.bodies.some((b) => b.id === 'hatch-body' && b.state === 'active')).toBe(true);
    expect(doc.components.map((c) => c.id)).toEqual(['c-door', 'c-hood']);
    expect(closure.size).toBe(2);
    for (const content of closure.values()) {
      expect(codes(content)).toEqual([]);
      expect(content.kernelProfile).toEqual(doc.kernelProfile);
    }
    const s = solveJoints(
      doc,
      parameterValues(doc),
      (h) => closure.get(h),
      () => undefined,
      () => true,
    );
    expect(s.mismatch).toEqual([]);
    expect(Object.values(s.joints).map((j) => j.status)).toEqual(['solved', 'solved']);
    // At 0° both stand where they were cut.
    for (const name of ['door', 'hood'] as const)
      expect(posesDiffer(s.poses[`c-${name}`]!, f28HingePose(name, 0))).toBe(false);
    const open = posesForJointValues(
      doc,
      s,
      new Map([
        ['j-door', { angle: Math.PI / 3 }],
        ['j-hood', { angle: Math.PI / 4 }],
      ]),
    );
    expect(posesDiffer(open['c-door']!, f28HingePose('door', Math.PI / 3))).toBe(false);
    expect(posesDiffer(open['c-hood']!, f28HingePose('hood', Math.PI / 4))).toBe(false);
    // The hinge point stays put; the door's rear corner swings out (−y), the hood's front up.
    const apply = (p: (typeof open)[string], v: [number, number, number]) => {
      const [x, y, z, w] = p.rotation;
      const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
      return [
        v[0] + w * t[0]! + (y * t[2]! - z * t[1]!) + p.translationMm[0],
        v[1] + w * t[1]! + (z * t[0]! - x * t[2]!) + p.translationMm[1],
        v[2] + w * t[2]! + (x * t[1]! - y * t[0]!) + p.translationMm[2],
      ];
    };
    const rear = apply(open['c-door']!, [f28Outlines.door[0], -810, 580]);
    expect(rear[1]!).toBeLessThan(-810 - 900);
    const front = apply(open['c-hood']!, [f28Outlines.hood[1], -300, 1000]);
    expect(front[2]!).toBeGreaterThan(1000 + 600);
    // The ranges hold: 80° on the door is refused.
    const door = doc.joints.find((j) => j.id === 'j-door')!;
    expect(() =>
      applyCadOperation(doc, {
        type: 'updateJoint',
        joint: { ...door, values: { angle: { literalRad: (80 * Math.PI) / 180 } } },
      }),
    ).toThrow();
  });
});
