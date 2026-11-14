import { describe, expect, it } from 'vitest';
import { parameterValues } from './graph';
import { posesForJointValues, solveJoints } from './joints';
import { applyCadOperation } from './operations';
import {
  f59Boxes,
  f59Hinge,
  f59LowBoxes,
  f59LowHinge,
  f59LowHPoint,
  f59Ranges,
  f59Seat,
} from './seat-fixtures';
import { validateCad } from './validation';

const codes = (doc: unknown) => validateCad(doc).map((d) => `${d.code}@${d.path}`);

describe('F59 seat assembly (CR6f, TS-1802)', () => {
  it('slides the seat 0–240 mm and reclines its back −10° to +40° about the hinge', () => {
    const { assembly: doc, closure } = f59Seat();
    expect(codes(doc)).toEqual([]);
    expect(doc.bodies.filter((b) => b.state === 'active').map((b) => b.id)).toEqual([
      'rail-left-body',
      'rail-right-body',
    ]);
    expect(doc.components.map((c) => c.id)).toEqual([
      'c-frame',
      'c-pan',
      'c-cushion',
      'c-back',
      'c-back-shell',
    ]);
    expect(closure.size).toBe(5);
    for (const content of closure.values()) expect(codes(content)).toEqual([]);
    const s = solveJoints(
      doc,
      parameterValues(doc),
      (h) => closure.get(h),
      () => undefined,
      () => true,
    );
    expect(s.mismatch).toEqual([]);
    expect(Object.values(s.joints).every((j) => j.status === 'solved')).toBe(true);
    const moved = posesForJointValues(
      doc,
      s,
      new Map([
        ['j-slide', { distance: 240 }],
        ['j-recline', { angle: (30 * Math.PI) / 180 }],
      ]),
    );
    // The whole seat goes 240 mm forward with the frame.
    for (const id of ['c-frame', 'c-pan', 'c-cushion'])
      expect(moved[id]!.translationMm.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([240, 0, 0]);
    // The back turns about the hinge (moved with the frame): the hinge stays, its top leans back.
    const apply = (p: (typeof moved)[string], v: [number, number, number]) => {
      const [x, y, z, w] = p.rotation;
      const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
      return [
        v[0] + w * t[0]! + (y * t[2]! - z * t[1]!) + p.translationMm[0],
        v[1] + w * t[1]! + (z * t[0]! - x * t[2]!) + p.translationMm[1],
        v[2] + w * t[2]! + (x * t[1]! - y * t[0]!) + p.translationMm[2],
      ];
    };
    const hinge = apply(moved['c-back']!, f59Hinge);
    expect(hinge[0]).toBeCloseTo(f59Hinge[0] + 240, 6);
    expect(hinge[2]).toBeCloseTo(f59Hinge[2], 6);
    const top = apply(moved['c-back']!, [f59Hinge[0], 0, 720]);
    expect(top[0]).toBeCloseTo(f59Hinge[0] + 240 - 540 * Math.sin(Math.PI / 6), 6);
    expect(top[2]).toBeCloseTo(f59Hinge[2] + 540 * Math.cos(Math.PI / 6), 6);
    // The shell follows the back.
    expect(moved['c-back-shell']).toEqual(moved['c-back']);
    // Out of range is refused.
    const slide = doc.joints.find((j) => j.id === 'j-slide')!;
    expect(() =>
      applyCadOperation(doc, {
        type: 'updateJoint',
        joint: { ...slide, values: { distance: { literalMm: f59Ranges.slide[1] + 10 } } },
      }),
    ).toThrow();
    const recline = doc.joints.find((j) => j.id === 'j-recline')!;
    expect(() =>
      applyCadOperation(doc, {
        type: 'updateJoint',
        joint: { ...recline, values: { angle: { literalRad: (-20 * Math.PI) / 180 } } },
      }),
    ).toThrow();
  });
});

describe('F59’s low version (CR7d, TS-1819)', () => {
  it('is the same assembly with the cushion’s top 100 mm lower and its back hinge 50 mm lower', () => {
    const std = f59Seat();
    const low = f59Seat(undefined, 'low');
    expect(codes(low.assembly)).toEqual([]);
    for (const content of low.closure.values()) expect(codes(content)).toEqual([]);
    expect(low.assembly.components.map((c) => c.id)).toEqual(
      std.assembly.components.map((c) => c.id),
    );
    expect(
      low.assembly.parts.map((p) => p.source.kind === 'version' && p.source.artifactId),
    ).toEqual([
      'seat-low-frame',
      'seat-low-pan',
      'seat-low-cushion',
      'seat-low-back',
      'seat-low-back-shell',
    ]);
    const top = (b: { at: number[]; size: number[] }) => b.at[2]! + b.size[2]!;
    expect(top(f59Boxes.cushion) - top(f59LowBoxes.cushion)).toBe(100);
    expect(f59Hinge[2] - f59LowHinge[2]).toBe(50);
    // The H-point sits over the cushion, in front of the back.
    expect(f59LowHPoint[2]).toBeGreaterThan(top(f59LowBoxes.cushion) + 100);
    expect(f59LowHPoint[0]).toBeGreaterThan(
      f59LowBoxes.back.at[0] + f59LowBoxes.back.size[0] + 100,
    );
    const s = solveJoints(
      low.assembly,
      parameterValues(low.assembly),
      (h) => low.closure.get(h),
      () => undefined,
      () => true,
    );
    expect(s.mismatch).toEqual([]);
  });
});
