import { describe, expect, it } from 'vitest';
import {
  applyCadOperation,
  composePoses,
  fixtureComponent,
  fixtureConnector,
  fixtureJoint,
  identityPose,
  invertPose,
  mm,
  mr1ArmWings,
  mr7ToolMount,
  parameterValues,
  position,
  posesForJointValues,
  solveJoints,
  r2bJoints,
  validateCad,
  type CadSolvedPose,
  type CadTopologyTable,
} from '@editor-platform/cad-core';
import type { CadMesh } from '@editor-platform/cad-kernel-occt';
import {
  connectorFromPick,
  followerMotions,
  jointFollowerSteps,
  jointMoveFrames,
  jointMoves,
  keptOffset,
  newJoint,
  originChoice,
} from './joint-authoring';
import { editedJointValues, jointFieldValue } from './joint-values';

const table: CadTopologyTable = {
  faces: [
    { name: ['end'], centroid: [40, 25, 5], area: 4000 },
    { name: ['side:+u'], centroid: [80, 25, 2.5], area: 250 },
    { name: ['side:+v'], centroid: [40, 50, 2.5], area: 400 },
    { name: null, centroid: [0, 0, 0], area: 1 },
  ],
  edges: [
    { faces: [0, 1], vertices: [0, 1], centroid: [80, 25, 5], length: 50 },
    { faces: [0, 2], vertices: [1, 2], centroid: [40, 50, 5], length: 80 },
    { faces: [1, 2], vertices: [1, 3], centroid: [80, 50, 2.5], length: 5 },
    { faces: [3, 0], vertices: [2, 4], centroid: [0, 0, 0], length: 1 },
  ],
  vertices: [
    { centroid: [80, 0, 5] },
    { centroid: [80, 50, 5] },
    { centroid: [0, 50, 5] },
    { centroid: [80, 50, 0] },
    { centroid: [0, 0, 0] },
  ],
};
const mesh = { bodyId: 'plate', topology: table } as CadMesh;

describe('making a joint (R2b-2c)', () => {
  const { assembly, closure } = r2bJoints();
  const lookup = (h: string) => closure.get(h);

  it('makes connectors from picks on this document and inside a placed part', () => {
    const own = connectorFromPick(
      assembly,
      lookup,
      { mesh, kind: 'vertex', index: 1, point: [80, 50, 5] },
      'parent',
    );
    if (typeof own === 'string') throw new Error(own);
    expect(own.connector).toMatchObject({
      componentPath: [],
      ref: {
        kind: 'vertex',
        featureId: 'plate-cut-placement',
        name: [['end'], ['side:+u'], ['side:+v']],
        hint: { centroid: [80, 50, 5], size: 0 },
      },
      flip: false,
    });
    expect(own.label).toBe('This document · Vertex end | side:+u | side:+v');
    // Inside the pair's plate `pair-b`: the child moves `c-pair`, its connector names the rest.
    const inner = connectorFromPick(
      assembly,
      lookup,
      { path: ['c-pair', 'pair-b'], mesh, kind: 'face', index: 0, point: [0, 0, 0] },
      'child',
    );
    if (typeof inner === 'string') throw new Error(inner);
    expect(inner.componentId).toBe('c-pair');
    expect(inner.connector.componentPath).toEqual(['pair-b']);
    expect(inner.connector.ref).toMatchObject({ kind: 'face', name: [['end']] });
  });

  it('refuses a child on this document, an unnamed element and a missing body', () => {
    const pick = {
      mesh,
      kind: 'face' as const,
      index: 0,
      point: [0, 0, 0] as [number, number, number],
    };
    expect(connectorFromPick(assembly, lookup, pick, 'child')).toBe('joint-child-own');
    expect(connectorFromPick(assembly, lookup, { ...pick, index: 3 }, 'parent')).toBe(
      'reference-unnamed',
    );
    const other = { ...pick, mesh: { ...mesh, bodyId: 'gone' } as CadMesh };
    expect(connectorFromPick(assembly, lookup, other, 'parent')).toBe('joint-connector-body');
    expect(originChoice(assembly, undefined, 'child')).toBe('joint-child-own');
    expect(originChoice(assembly, 'nowhere', 'parent')).toBe('target-missing');
  });

  it('hangs a joint from a pattern copy, never moves one (R2b-3)', () => {
    const doc = applyCadOperation(assembly, {
      type: 'insertComponentPattern',
      pattern: {
        id: 'p-pair',
        name: 'Pairs',
        seedComponentId: 'c-pair',
        layout: { type: 'linear', direction: [0, 1, 0], count: { literal: 3 }, spacing: mm(60) },
      },
    });
    const pick = {
      path: ['copy:p-pair:2', 'pair-b'],
      mesh,
      kind: 'face' as const,
      index: 0,
      point: [0, 0, 0] as [number, number, number],
    };
    const parent = connectorFromPick(doc, lookup, pick, 'parent');
    if (typeof parent === 'string') throw new Error(parent);
    expect(parent.connector.componentPath).toEqual(['copy:p-pair:2', 'pair-b']);
    expect(parent.label).toBe('Pairs 3 › pair-b · Face end');
    expect(connectorFromPick(doc, lookup, pick, 'child')).toBe('joint-child-copy');
    const origin = originChoice(doc, 'copy:p-pair:1', 'parent');
    expect(typeof origin === 'object' && origin.label).toBe('Pairs 2 · Origin');
    expect(originChoice(doc, 'copy:p-pair:1', 'child')).toBe('joint-child-copy');
    // Past the count there is no copy.
    expect(originChoice(doc, 'copy:p-pair:3', 'parent')).toBe('target-missing');
    // Turning the shaft turns its copies about their own places, and what hangs from them.
    const turned = applyCadOperation(doc, {
      type: 'insertComponentPattern',
      pattern: {
        id: 'p-shaft',
        name: 'Shafts',
        seedComponentId: 'c-shaft',
        layout: { type: 'linear', direction: [1, 0, 0], count: { literal: 2 }, spacing: mm(200) },
      },
    });
    const turn = turned.joints.find((j) => j.id === 'j-turn')!;
    const frames = jointMoveFrames(turned, turn);
    expect(frames.get('c-shaft')).toEqual({ translationMm: [0, 0, 0], rotation: [0, 0, 0, 1] });
    expect(frames.get('copy:p-shaft:1')?.translationMm).toEqual([200, 0, 0]);
    expect([...jointMoves(turned, turn)].sort()).toEqual(['c-plate-2', 'c-plate-3', 'c-shaft']);
    // What hangs from a copy moves about the copy's place: a drag cannot start on it.
    const hung = structuredClone(turned);
    hung.joints.push({
      ...structuredClone(turn),
      id: 'j-cap',
      parent: { ...structuredClone(turn.parent), componentPath: ['copy:p-shaft:1'] },
      child: { ...structuredClone(turn.child), componentId: 'c-plate-1' },
    });
    expect(jointMoveFrames(hung, turn).get('c-plate-1')?.translationMm).toEqual([200, 0, 0]);
    expect(jointMoves(hung, turn).has('c-plate-1')).toBe(false);
  });

  it('starts a joint at zero values under a free name, and drags move its subtree', () => {
    const parent = originChoice(assembly, undefined, 'parent');
    const child = originChoice(assembly, 'c-plate-1', 'child');
    if (typeof parent === 'string' || typeof child === 'string') throw new Error('choice');
    const joint = newJoint(assembly, 'j-new', parent, child, 'planar', true);
    expect(joint).toMatchObject({
      id: 'j-new',
      name: 'Joint 6',
      parent: { componentPath: [], ref: { origin: true } },
      child: { componentId: 'c-plate-1', connector: { componentPath: [], flip: true } },
      values: { u: { literalMm: 0 }, v: { literalMm: 0 }, angle: { literalRad: 0 } },
      limits: [],
    });
    const slide = assembly.joints.find((j) => j.id === 'j-slide')!;
    expect([...jointMoves(assembly, slide)].sort()).toEqual(['c-plate-2', 'c-plate-3']);
    const turn = assembly.joints.find((j) => j.id === 'j-turn')!;
    expect([...jointMoves(assembly, turn)].sort()).toEqual(['c-plate-2', 'c-plate-3', 'c-shaft']);
  });
  it('drags nothing through a mount candidate not in effect (MR7a, TS-1717)', () => {
    const { assembly } = mr7ToolMount();
    const wrist = assembly.joints.find((j) => j.child.componentId === 'c-hand')!;
    const back = assembly.joints.find((j) => j.id === 'j-tool-back')!;
    // In the hand: the wrist's drag carries the tool; the back's candidate moves nothing.
    expect(jointMoveFrames(assembly, wrist).has('c-tool')).toBe(true);
    expect(jointMoveFrames(assembly, back).size).toBe(0);
    expect(jointMoves(assembly, back).size).toBe(0);
    // On the back: the wrist no longer carries it.
    const onBack = { ...assembly, mounts: [{ ...assembly.mounts![0]!, active: 'j-tool-back' }] };
    expect(jointMoveFrames(onBack, wrist).has('c-tool')).toBe(false);
    expect(jointMoves(onBack, onBack.joints.find((j) => j.id === 'j-tool-back')!)).toEqual(
      new Set(['c-tool']),
    );
  });
  it('moves coupled followers with their driver during a drag, each by its own motion (MR1, TS-1701)', () => {
    const { assembly: base } = mr1ArmWings();
    // A flap on the right wing's tip that follows the right wing's angle: a follower of a follower.
    const assembly = structuredClone(base);
    assembly.components.push({ ...fixtureComponent('c-flap', 'part-plate'), placement: null });
    assembly.solvedPoses['c-flap'] = identityPose();
    assembly.joints.push({
      ...fixtureJoint(
        'j-flap',
        'revolute',
        {
          ...fixtureConnector(['c-wing-r']),
          offset: { translation: position(80, 0, 0), rotation: [0, 0, 0, 1] },
        },
        'c-flap',
        fixtureConnector(),
      ),
      couplings: [{ of: 'angle', from: { joint: 'j-wing-r', of: 'angle' }, ratio: 1, offset: 0 }],
    });
    const solved = solveJoints(
      assembly,
      parameterValues(assembly),
      () => undefined,
      () => undefined,
      () => true,
    );
    const left = assembly.joints.find((j) => j.id === 'j-wing-l')!;
    const right = assembly.joints.find((j) => j.id === 'j-wing-r')!;
    const steps = jointFollowerSteps(assembly, left);
    expect([...steps].sort()).toEqual(['c-flap', 'c-wing-r']);
    // The right wing's own drag carries the flap and turns it; nothing drives the left wing back.
    expect([...jointFollowerSteps(assembly, right)]).toEqual(['c-flap']);
    const values = { angle: (60 * Math.PI) / 180 };
    const motions = followerMotions(assembly, left, solved, steps, values);
    // Each shown part moved by its motion lands where the committed values place it.
    const after = posesForJointValues(assembly, solved, new Map([[left.id, values]]));
    for (const c of ['c-wing-r', 'c-flap']) {
      const shown = composePoses(motions.get(c)!, solved.poses[c]!);
      shown.translationMm.forEach((v, i) => expect(v).toBeCloseTo(after[c]!.translationMm[i]!, 9));
      const turn = composePoses(invertPose(shown), after[c]!).rotation;
      expect(Math.abs(turn[3])).toBeCloseTo(1, 9);
    }
    // The flap turns twice as far as the wing it hangs from: not just carried along.
    const angle = (q: readonly number[]) => 2 * Math.acos(Math.min(1, Math.abs(q[3]!)));
    expect(angle(motions.get('c-flap')!.rotation)).toBeCloseTo(
      2 * angle(motions.get('c-wing-r')!.rotation),
      9,
    );
  });
  it('turns a follower that hangs from the dragged child by its own motion too (MR1, TS-1701)', () => {
    const assembly = structuredClone(mr1ArmWings().assembly);
    // A flap on the forearm that follows the elbow: the elbow's drag carries it and turns it.
    assembly.components.push({ ...fixtureComponent('c-flap', 'part-plate'), placement: null });
    assembly.solvedPoses['c-flap'] = identityPose();
    assembly.joints.push({
      ...fixtureJoint(
        'j-flap',
        'revolute',
        {
          ...fixtureConnector(['c-fore']),
          offset: { translation: position(40, 0, 0), rotation: [0, 0, 0, 1] },
        },
        'c-flap',
        fixtureConnector(),
      ),
      couplings: [{ of: 'angle', from: { joint: 'j-elbow', of: 'angle' }, ratio: 1, offset: 0 }],
    });
    const solved = solveJoints(
      assembly,
      parameterValues(assembly),
      () => undefined,
      () => undefined,
      () => true,
    );
    const elbow = assembly.joints.find((j) => j.id === 'j-elbow')!;
    expect(jointMoveFrames(assembly, elbow).has('c-flap')).toBe(true);
    const steps = jointFollowerSteps(assembly, elbow);
    expect([...steps]).toEqual(['c-flap']);
    const values = { angle: (75 * Math.PI) / 180 };
    const motions = followerMotions(assembly, elbow, solved, steps, values);
    const after = posesForJointValues(assembly, solved, new Map([[elbow.id, values]]));
    const shown = composePoses(motions.get('c-flap')!, solved.poses['c-flap']!);
    shown.translationMm.forEach((v, i) =>
      expect(v).toBeCloseTo(after['c-flap']!.translationMm[i]!, 9),
    );
    // A 30° drag turns the flap 60°: the forearm's 30° and its own 30°.
    const angle = (q: readonly number[]) => 2 * Math.acos(Math.min(1, Math.abs(q[3]!)));
    expect((angle(motions.get('c-flap')!.rotation) * 180) / Math.PI).toBeCloseTo(60, 9);
  });
});

describe('keeping the child where it stands (CR3e-2)', () => {
  it('offsets the parent connector onto the child connector where the child stands', () => {
    // TS-1521, ST-258.
    const q = (deg: number): CadSolvedPose['rotation'] => {
      const h = (deg * Math.PI) / 360;
      return [0, 0, Math.sin(h), Math.cos(h)];
    };
    // The opening's edge 3.5 mm left of the door's hinge edge, both along +y.
    const parent: CadSolvedPose = { translationMm: [38.25, -30, 0], rotation: q(90) };
    const child: CadSolvedPose = { translationMm: [41.75, -30, 0], rotation: q(90) };
    const stood: CadSolvedPose = { translationMm: [0, 0, 0], rotation: [0, 0, 0, 1] };
    const offset = keptOffset({ parent, child }, stood);
    expect(offset.translation).toEqual([mm(0), mm(-3.5), mm(0)]);
    // With the offset the child solves to where it stood: parent ∘ offset ∘ child⁻¹ = stood.
    const placed = composePoses(
      composePoses(parent, {
        translationMm: offset.translation.map((l) => ('literalMm' in l ? l.literalMm : 0)) as [
          number,
          number,
          number,
        ],
        rotation: offset.rotation,
      }),
      invertPose(child),
    );
    expect(placed.translationMm.map((x) => +x.toFixed(9) + 0)).toEqual([0, 0, 0]);
    expect(placed.rotation.map((x) => +x.toFixed(9) + 0)).toEqual([0, 0, 0, 1]);
  });
});

describe('joint ranges (CR3e-2)', () => {
  it('converts a range as the value field does, so its displayed ends are reachable', () => {
    // TS-1521, ST-258 (Codex on #956): 13° by division gave 0.22689280275926282, the field 0.…285.
    const joint = structuredClone(r2bJoints().assembly.joints.find((j) => j.type === 'revolute')!);
    for (const deg of [13, 70, 0.1, 179.9]) {
      const typed = editedJointValues(joint, ['x'], [String(deg)]).angle;
      expect(typed).toEqual({ literalRad: jointFieldValue('angle', deg) });
    }
    expect(jointFieldValue('distance', 13)).toBe(13);
    // Dividing by 180/π, as the range once did, lands on another float than the field.
    expect(13 / (180 / Math.PI)).not.toBe(jointFieldValue('angle', 13));
    // A joint at 13° with its range ending at 13°, both as typed, is valid.
    const doc = structuredClone(r2bJoints().assembly);
    const at = doc.joints.find((j) => j.id === joint.id)!;
    at.values = editedJointValues(at, ['x'], ['13']);
    at.limits = [{ of: 'angle', min: 0, max: jointFieldValue('angle', 13) }];
    expect(validateCad(doc).filter((d) => d.code.startsWith('joint-limit'))).toEqual([]);
  });
});
