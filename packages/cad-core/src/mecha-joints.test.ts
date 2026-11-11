import { describe, expect, it } from 'vitest';
import { composePoses, posesDiffer, rotateVector } from './assembly';
import { parameterValues } from './graph';
import {
  coupledJointValues,
  jointLimitViolations,
  jointMotion,
  ownJointValueKeys,
  posesForJointValues,
  solveJoints,
} from './joints';
import { jointsReading } from './joints-operations';
import { mr1ArmWings } from './mecha-fixtures';
import type { CadDocument } from './model';
import { validateCad } from './validation';

const deg = Math.PI / 180;
const codes = (doc: unknown) => validateCad(doc).map((d) => d.code);
const near = (a: number[], b: number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 9));
const solve = (doc: CadDocument) =>
  solveJoints(
    doc,
    parameterValues(doc),
    () => undefined,
    () => undefined,
    () => true,
  );
const wings = (doc: CadDocument) => doc.joints.find((j) => j.id === 'j-wing-r')!;

describe('MR1 multi-axis joints (TS-1700)', () => {
  it('turns a spherical joint about z, then the turned y, then the turned x', () => {
    const r = jointMotion('spherical', { angle: 90 * deg, angle2: 90 * deg, angle3: 0 }).rotation;
    // The same as the single turns composed in order (intrinsic z, then y).
    const z = jointMotion('revolute', { angle: 90 * deg });
    const y = {
      translationMm: [0, 0, 0] as [number, number, number],
      rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] as [number, number, number, number],
    };
    const composed = composePoses(z, y).rotation;
    for (const v of [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ] as [number, number, number][])
      near(rotateVector(r, v), rotateVector(composed, v));
    // A third angle only: a turn about x.
    near(
      rotateVector(jointMotion('spherical', { angle3: 90 * deg }).rotation, [0, 1, 0]),
      [0, 0, 1],
    );
  });
  it('turns a universal joint about z, then the turned x', () => {
    const r = jointMotion('universal', { angle: 90 * deg, angle2: 90 * deg }).rotation;
    // x goes to y by the first turn; z, turned about the new x (world y), goes to +x.
    near(rotateVector(r, [1, 0, 0]), [0, 1, 0]);
    near(rotateVector(r, [0, 0, 1]), [1, 0, 0]);
  });
  it('validates the fixture and its stored poses solve again', () => {
    const { assembly } = mr1ArmWings();
    expect(codes(assembly)).toEqual([]);
    const s = solve(assembly);
    expect(s.mismatch).toEqual([]);
    expect(Object.values(s.joints).every((j) => j.status === 'solved')).toBe(true);
  });
  it('needs every angle of its type and checks each axis against its own limit', () => {
    const { assembly } = mr1ArmWings();
    const missing = structuredClone(assembly);
    delete missing.joints[0]!.values.angle3;
    expect(codes(missing)).toContain('missing-field');
    const past = structuredClone(assembly);
    past.joints[0]!.values.angle2 = { literalRad: -100 * deg };
    expect(codes(past)).toContain('joint-limit');
    const badOf = structuredClone(assembly);
    badOf.joints[2]!.limits = [{ of: 'angle3', min: 0, max: 1 }];
    expect(codes(badOf)).toContain('joint-limit-of');
  });
});

describe('MR1 couplings (TS-1701)', () => {
  it('moves the follower by ratio × driver + offset, mirroring the wings', () => {
    const { assembly } = mr1ArmWings();
    const values = coupledJointValues(assembly, parameterValues(assembly));
    expect(values.get('j-wing-r')!.angle).toBeCloseTo(-40 * deg, 12);
    expect(ownJointValueKeys(wings(assembly))).toEqual([]);
    const s = solve(assembly);
    const l = s.poses['c-wing-l']!.rotation;
    const r = s.poses['c-wing-r']!.rotation;
    expect(l[2]).toBeCloseTo(-r[2], 12);
    expect(l[3]).toBeCloseTo(r[3], 12);
  });
  it('keyed values move followers too, and never set a follower directly', () => {
    const { assembly } = mr1ArmWings();
    const s = solve(assembly);
    const keyed = new Map([
      ['j-wing-l', { angle: 60 * deg }],
      ['j-wing-r', { angle: 10 * deg }],
    ]);
    const poses = posesForJointValues(assembly, s, keyed);
    const moved = structuredClone(assembly);
    moved.joints.find((j) => j.id === 'j-wing-l')!.values.angle = { literalRad: 60 * deg };
    const again = solve(moved);
    expect(posesDiffer(poses['c-wing-r']!, again.poses['c-wing-r']!)).toBe(false);
    expect(posesDiffer(poses['c-wing-l']!, again.poses['c-wing-l']!)).toBe(false);
  });
  it('reports a followed value past its own limits', () => {
    const { assembly } = mr1ArmWings();
    const past = structuredClone(assembly);
    wings(past).limits = [{ of: 'angle', min: -30 * deg, max: 90 * deg }];
    expect(codes(past)).toContain('joint-limit');
    const values = coupledJointValues(past, parameterValues(past));
    expect(jointLimitViolations(past, values)).toEqual([
      { joint: 'j-wing-r', of: 'angle', value: expect.closeTo(-40 * deg, 12) },
    ]);
  });
  it('refuses a stored follower value, a wrong source, a kind mismatch and a cycle', () => {
    const { assembly } = mr1ArmWings();
    const stored = structuredClone(assembly);
    wings(stored).values = { angle: { literalRad: 0 } };
    expect(codes(stored)).toContain('unknown-field');
    const self = structuredClone(assembly);
    wings(self).couplings![0]!.from.joint = 'j-wing-r';
    expect(codes(self)).toContain('coupling-from');
    const nowhere = structuredClone(assembly);
    wings(nowhere).couplings![0]!.from.joint = 'j-gone';
    expect(codes(nowhere)).toContain('coupling-from');
    const noValue = structuredClone(assembly);
    wings(noValue).couplings![0]!.from = { joint: 'j-elbow', of: 'angle2' };
    expect(codes(noValue)).toContain('coupling-from');
    const kind = structuredClone(assembly);
    kind.joints.push({
      id: 'j-slide',
      name: 'j-slide',
      type: 'slider',
      parent: structuredClone(kind.joints[0]!.parent),
      child: {
        componentId: 'c-extra',
        connector: structuredClone(kind.joints[0]!.child.connector),
      },
      values: { distance: { literalMm: 1 } },
      limits: [],
    });
    kind.components.push({
      ...structuredClone(kind.components[0]!),
      id: 'c-extra',
      name: 'c-extra',
    });
    kind.solvedPoses['c-extra'] = { translationMm: [0, 0, 0], rotation: [0, 0, 0, 1] };
    wings(kind).couplings![0]!.from = { joint: 'j-slide', of: 'distance' };
    expect(codes(kind)).toContain('coupling-kind');
    const cycle = structuredClone(assembly);
    const left = cycle.joints.find((j) => j.id === 'j-wing-l')!;
    left.values = {};
    left.couplings = [
      { of: 'angle', from: { joint: 'j-wing-r', of: 'angle' }, ratio: -1, offset: 0 },
    ];
    expect(codes(cycle)).toContain('coupling-cycle');
    const twice = structuredClone(assembly);
    wings(twice).couplings!.push({ ...wings(twice).couplings![0]! });
    expect(codes(twice)).toContain('coupling-of');
    const ratio = structuredClone(assembly);
    wings(ratio).couplings![0]!.ratio = 1e6;
    expect(codes(ratio)).toContain('coupling-ratio');
    const empty = structuredClone(assembly);
    wings(empty).couplings = [];
    expect(codes(empty)).toContain('joint-couplings');
  });
  it('removes a follower with the joint it follows', () => {
    const { assembly } = mr1ArmWings();
    const none = new Set<string>();
    expect(
      jointsReading(assembly, new Set(['j-wing-l']), {
        parameters: none,
        features: none,
        components: none,
        patterns: none,
      }),
    ).toEqual(['j-wing-l', 'j-wing-r']);
  });
});

describe('MR1a coupled keys stay within the safety bounds (TS-1701)', () => {
  it('reports a follower driven past one turn even without limits of its own', () => {
    const { assembly } = mr1ArmWings();
    const doc = structuredClone(assembly);
    const r = wings(doc);
    r.limits = [];
    r.couplings![0]!.ratio = 10;
    doc.joints.find((j) => j.id === 'j-wing-l')!.values.angle = { literalRad: 0 };
    const keyed = coupledJointValues(
      doc,
      parameterValues(doc),
      new Map([['j-wing-l', { angle: 1 }]]),
    );
    expect(jointLimitViolations(doc, keyed)).toEqual([
      { joint: 'j-wing-r', of: 'angle', value: 10 },
    ]);
  });
});
