import { describe, expect, it } from 'vitest';
import { f148Package } from './car-look-colour';
import { f149Car, f149WheelCentre, f149Wheels } from './car-look-final';
import { jointLimitViolations } from './joints';
import { validateCad } from './validation';

describe('F149: 「翔」 in 紅 with turning wheels (CL9d, TS-2037)', () => {
  it('centres each wheel on its axle, out at half the track', () => {
    expect(f149WheelCentre(f149Wheels[0])).toEqual([0, 840, 339.75]);
    expect(f149WheelCentre(f149Wheels[3])[0]).toBe(2650);
    expect(f149WheelCentre(f149Wheels[3])[1]).toBeLessThan(0);
  });
  it('makes the four wheel faces parts on revolute joints, the rest of the car as F148 (紅)', () => {
    const { assembly, closure } = f149Car();
    expect(validateCad(assembly)).toEqual([]);
    const base = f148Package('rosso');
    expect(assembly.bodies.map((b) => b.id)).toEqual(
      base.bodies.filter((b) => !/-rim-body$/.test(b.id)).map((b) => b.id),
    );
    expect(assembly.components.map((c) => c.id)).toEqual(f149Wheels.map((w) => `c-wheel-${w.key}`));
    expect(assembly.joints.map((j) => [j.id, j.type])).toEqual(
      f149Wheels.map((w) => [`j-wheel-${w.key}`, 'revolute']),
    );
    expect(closure.size).toBe(4);
    for (const part of assembly.parts) {
      const content = closure.get(part.source.contentHash)!;
      expect(validateCad(content)).toEqual([]);
      expect(content.bodies).toHaveLength(1);
    }
    // Each joint's axis lies along the car's y through the wheel's centre.
    for (const [i, j] of assembly.joints.entries()) {
      const c = f149WheelCentre(f149Wheels[i]!);
      const t = j.parent.offset.translation.map((v) => ('literalMm' in v ? v.literalMm : NaN));
      expect(t).toEqual(c);
    }
    // A drive of several tyre circumferences turns each wheel past one revolution.
    const turns = new Map(assembly.joints.map((j) => [j.id, { angle: 20 * Math.PI }]));
    expect(assembly.joints.every((j) => j.continuous)).toBe(true);
    expect(jointLimitViolations(assembly, turns)).toEqual([]);
  }, 60_000);
});
