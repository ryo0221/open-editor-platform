import { describe, expect, it } from 'vitest';
import { bomRows } from './bom';
import { f130Eaxle } from './eaxle-assembly';
import { eaxleLayout } from './eaxle-parts';
import { gearTrainRatios } from './gear-mesh';
import { coupledJointValues } from './joints';
import { parameterValues } from './graph';

describe('DW7d e-Axle assembly F130 (ST-718, TS-2456)', () => {
  const f = f130Eaxle();
  const doc = f.assembly;

  it('drives the wheels at 1/9 of the motor through two helical meshes', () => {
    const ratios = gearTrainRatios(doc, 'j-input');
    expect(ratios.find((r) => r.joint === 'j-counter')!.ratio).toBeCloseTo(-17 / 51, 12);
    expect(ratios.find((r) => r.joint === 'j-final')!.ratio).toBeCloseTo(1 / eaxleLayout.ratio, 12);
    // Turning the motor: the final gear (and the differential and drive shafts on it) follows.
    const turned = structuredClone(doc);
    turned.joints.find((j) => j.id === 'j-input')!.values = { angle: { literalRad: 9 } };
    const before = coupledJointValues(doc, parameterValues(doc)).get('j-final')!.angle!;
    const after = coupledJointValues(turned, parameterValues(turned)).get('j-final')!.angle!;
    expect(after - before).toBeCloseTo(1, 9);
    const poses = f.solve(turned).poses;
    const final = poses['c-final']!;
    const shaft = poses['c-shaft-r']!;
    // The drive shaft turned with the final gear: the same rotation, on the output axis.
    shaft.rotation.forEach((q, i) => expect(q).toBeCloseTo(final.rotation[i]!, 9));
    expect(shaft.translationMm[0]).toBeCloseTo(eaxleLayout.outputX, 9);
  });

  it('lists the parts with their quantities', () => {
    const rows = bomRows(doc, f.lookup, 'flat');
    const qty = (name: string) => rows.find((r) => r.name === name)?.quantity;
    expect(qty('Rotor magnet')).toBe(8);
    expect(qty('Ball bearing 6206')).toBe(2);
    expect(qty('Ball bearing 6207')).toBe(2);
    expect(qty('Ball bearing 6208')).toBe(2);
    expect(qty('Ball bearing 6210')).toBe(2);
    expect(qty('Side gear')).toBe(2);
    expect(qty('Differential pinion')).toBe(2);
    expect(qty('Drive shaft')).toBe(2);
    expect(qty('Phase terminal')).toBe(3);
    expect(qty('Motor housing')).toBe(1);
    expect(rows.reduce((n, r) => n + r.quantity, 0)).toBe(doc.components.length);
  });
});
