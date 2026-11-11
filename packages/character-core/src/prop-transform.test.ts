import { describe, expect, it } from 'vitest';
import {
  applyCharacterOperation,
  blockyFigure,
  changedJoints,
  exportGlb,
  freshCharacterId,
  poseAt,
  propJointChannel,
  propTransformKeys,
  validateCharacter,
  type CharacterDocument,
  type PropTransformInput,
  type PropTransformKey,
} from './index';

const codes = (v: unknown) => validateCharacter(v).map((d) => `${d.code} ${d.path}`);
const robot = {
  id: 'robot',
  name: 'Robot',
  source: {
    kind: 'cad' as const,
    artifactId: 'art-1',
    versionId: 'v-1',
    contentHash: 'a'.repeat(64),
  },
  placement: {
    translation: [500, 0, 0] as [number, number, number],
    rotation: [0, 0, 0, 1] as [number, number, number, number],
  },
  visible: true,
};
const withRobot = () =>
  applyCharacterOperation(blockyFigure().doc, { type: 'addProp', prop: robot });
const second = 240_000;
const stand = {
  'j-pitch': { angle: 0 },
  'j-wing-l': { angle: 0.4 },
  'j-shoulder-r': { angle: 0, angle2: 1.5, angle3: 0 },
  'j-neck': { angle: 0, angle2: 0 },
};
const flight = {
  'j-pitch': { angle: 1.5 },
  'j-wing-l': { angle: 1.4 },
  'j-shoulder-r': { angle: 0, angle2: -1.8, angle3: 3 },
  'j-neck': { angle: 0, angle2: 0 },
};
const input = (over: Partial<PropTransformInput> = {}): PropTransformInput => ({
  propId: 'robot',
  duration: second,
  from: stand,
  to: flight,
  groups: [
    { joints: ['j-shoulder-r'], start: 0, length: second / 2, easing: { type: 'linear' } },
    {
      joints: ['j-pitch', 'j-wing-l'],
      start: second / 4,
      length: (second * 3) / 4,
      easing: { type: 'bezier', x1: 0.4, y1: 0, x2: 0.2, y2: 1 },
    },
  ],
  ...over,
});
/** The transform's keys put into the figure's first action, with fresh IDs. */
function put(doc: CharacterDocument, i = input()) {
  const r = propTransformKeys(i);
  if (r.status !== 'ok') throw new Error(r.problem.code);
  const action = doc.actions[0]!;
  return applyCharacterOperation(doc, {
    type: 'putPropTransform',
    actionId: action.id,
    propId: 'robot',
    from: r.from,
    to: r.to,
    keys: r.keys.map((k) => {
      const name = `${action.id}/robot/${at(k)}/${k.target.property}`;
      return {
        ...k,
        trackId: freshCharacterId(doc, name),
        keyId: freshCharacterId(doc, `${name}#${k.tick}`),
      };
    }),
  });
}

/** The joint (or MR7 mount) a key names. */
const at = (k: PropTransformKey) =>
  k.target.kind === 'prop-joint' ? k.target.joint : k.target.mount;

describe('MR4 transform keys between two forms (TS-1711)', () => {
  it('keys each grouped value at its group start and end, with the group easing', () => {
    expect(changedJoints(stand, flight)).toEqual(['j-pitch', 'j-wing-l', 'j-shoulder-r']);
    const r = propTransformKeys(input());
    expect(r.status === 'ok' && [r.from, r.to, r.keys.length]).toEqual([0, second, 10]);
    if (r.status !== 'ok') return;
    const pitch = r.keys.filter((k) => at(k) === 'j-pitch');
    expect(pitch.map((k) => [k.tick, k.value, k.easing.type])).toEqual([
      [second / 4, 0, 'bezier'],
      [second, 1.5, 'linear'],
    ]);
    // A spherical joint keys all three of its values.
    expect(r.keys.filter((k) => at(k) === 'j-shoulder-r').map((k) => k.target.property)).toEqual([
      'angle',
      'angle',
      'angle2',
      'angle2',
      'angle3',
      'angle3',
    ]);
    // An unchanged joint needs no group.
    expect(r.keys.some((k) => at(k) === 'j-neck')).toBe(false);
    // Nor is it keyed when grouped with one that changes.
    const grouped = propTransformKeys(
      input({
        groups: [{ ...input().groups[0]!, joints: ['j-shoulder-r', 'j-neck'] }, input().groups[1]!],
      }),
    );
    expect(grouped.status === 'ok' && grouped.keys.length).toBe(10);
    expect(grouped.status === 'ok' && grouped.keys.some((k) => at(k) === 'j-neck')).toBe(false);
  });
  it('refuses groups that leave a changed joint out, repeat one, or run past the action', () => {
    const problem = (over: Partial<PropTransformInput>) => {
      const r = propTransformKeys(input(over));
      return r.status === 'refused' ? r.problem : r.status;
    };
    expect(problem({ groups: [] })).toEqual({ code: 'transform-groups' });
    const g = input().groups;
    expect(problem({ groups: [g[0]!] })).toEqual({
      code: 'transform-joint-ungrouped',
      joint: 'j-pitch',
    });
    expect(problem({ groups: [...g, { ...g[0]!, joints: [] }] })).toEqual({
      code: 'transform-group-empty',
      group: 2,
    });
    expect(problem({ groups: [...g, { ...g[0]!, joints: ['j-pitch'] }] })).toEqual({
      code: 'transform-joint-twice',
      joint: 'j-pitch',
    });
    for (const bad of [{ start: -1 }, { length: 0 }, { start: second, length: 1 }, { start: 0.5 }])
      expect(problem({ groups: [{ ...g[0]!, ...bad }, g[1]!] })).toEqual({
        code: 'transform-time',
        group: 0,
      });
    // The two forms must name the same values of a grouped joint.
    expect(problem({ to: { ...flight, 'j-shoulder-r': { angle: 0, angle2: -1.8 } } })).toEqual({
      code: 'transform-values',
      joint: 'j-shoulder-r',
    });
    expect(problem({ from: { ...stand, 'j-pitch': {} } })).toEqual({
      code: 'transform-values',
      joint: 'j-pitch',
    });
  });
  it('puts the keys in one edit, replacing only the keys of those values within the span', () => {
    let d = withRobot();
    const action = d.actions[0]!;
    // A key before the span and one inside it, on a transformed value; one on another joint.
    for (const [joint, tick, value] of [
      ['j-pitch', 0, 0.2],
      ['j-pitch', second / 2, 0.9],
      ['j-elbow-r', second / 2, 0.3],
    ] as const)
      d = applyCharacterOperation(d, {
        type: 'setKey',
        actionId: action.id,
        target: { kind: 'prop-joint', id: 'robot', joint, property: 'angle' },
        tick,
        value,
        trackId: freshCharacterId(d, `t/${joint}`),
        keyId: freshCharacterId(d, `k/${joint}/${tick}`),
      });
    // The shoulder group starts at second/8, so the span is [second/8, second].
    d = put(
      d,
      input({ groups: [input().groups[1]!, { ...input().groups[0]!, start: second / 8 }] }),
    );
    expect(codes(d)).toEqual([]);
    const track = (joint: string, property = 'angle') =>
      d.actions[0]!.tracks.find(
        (t) =>
          t.target.kind === 'prop-joint' &&
          t.target.joint === joint &&
          t.target.property === property,
      )!;
    // 0 (before the span) stays, second/2 (inside) is replaced by the span's two keys.
    expect(track('j-pitch').keys.map((k) => [k.tick, k.value])).toEqual([
      [0, 0.2],
      [second / 4, 0],
      [second, 1.5],
    ]);
    expect(track('j-elbow-r').keys.map((k) => k.value)).toEqual([0.3]);
    // Played back: half-way through the shoulder group, its angle2 is half-way.
    const pose = poseAt(d, d.actions[0]!, (second * 3) / 8);
    expect(pose.joints.get('robot')!.get('j-shoulder-r')!.angle2).toBeCloseTo(-0.15, 9);
    // Made again: the same keys, the tracks not doubled.
    const again = put(d);
    expect(again.actions[0]!.tracks.length).toBe(d.actions[0]!.tracks.length);
    // Keys outside the span, of another prop, or of a placement are refused.
    const r = propTransformKeys(input());
    if (r.status !== 'ok') throw new Error('expected keys');
    const op =
      (keys: unknown[], from = r.from, to = r.to) =>
      () =>
        applyCharacterOperation(d, {
          type: 'putPropTransform',
          actionId: action.id,
          propId: 'robot',
          from,
          to,
          keys: keys as never,
        });
    const k0 = { ...r.keys[0]!, trackId: 'x-track', keyId: 'x-key' };
    expect(op([k0], second / 2)).toThrow(/keys/);
    expect(op([{ ...k0, target: { ...k0.target, id: 'other' } }])).toThrow(/keys/);
    expect(op([], 0, second)).toThrow(/keys/);
    expect(op([k0], 0, second * 2)).toThrow(/keys/);
    // IDs with spaces never stand for another prop's joint: prop `robot arm`, joint `hinge`
    // is not prop `robot`, joint `arm hinge`.
    let spaced = applyCharacterOperation(d, {
      type: 'addProp',
      prop: { ...robot, id: 'robot arm', name: 'Robot arm' },
    });
    spaced = applyCharacterOperation(spaced, {
      type: 'setKey',
      actionId: action.id,
      target: { kind: 'prop-joint', id: 'robot arm', joint: 'hinge', property: 'angle' },
      tick: second / 2,
      value: 1,
      trackId: 'other-hinge',
      keyId: 'other-hinge#1',
    });
    spaced = applyCharacterOperation(spaced, {
      type: 'putPropTransform',
      actionId: action.id,
      propId: 'robot',
      from: 0,
      to: second,
      keys: [0, second].map((tick) => ({
        target: {
          kind: 'prop-joint' as const,
          id: 'robot',
          joint: 'arm hinge',
          property: 'angle' as const,
        },
        tick,
        value: 0,
        easing: { type: 'linear' as const },
        trackId: 'arm-hinge',
        keyId: `arm-hinge#${tick}`,
      })),
    });
    expect(spaced.actions[0]!.tracks.find((t) => t.id === 'other-hinge')?.keys).toHaveLength(1);
  });
});

describe('MR4 prop placement keys and version update (TS-1711)', () => {
  const keyPlacement = (
    d: CharacterDocument,
    property: 'translation' | 'rotation',
    tick: number,
    value: number[],
  ) =>
    applyCharacterOperation(d, {
      type: 'setKey',
      actionId: d.actions[0]!.id,
      target: { kind: 'prop', id: 'robot', property },
      tick,
      value: value as never,
      trackId: freshCharacterId(d, `fly/${property}`),
      keyId: freshCharacterId(d, `fly/${property}#${tick}`),
    });
  it('keys where a prop is: translation lerped, rotation slerped, the rest pose its own', () => {
    let d = withRobot();
    d = keyPlacement(d, 'translation', 0, [500, 0, 0]);
    d = keyPlacement(d, 'translation', second, [500, 0, 1000]);
    const s = Math.SQRT1_2;
    d = keyPlacement(d, 'rotation', 0, [0, 0, 0, 1]);
    d = keyPlacement(d, 'rotation', second, [s, 0, 0, s]);
    expect(codes(d)).toEqual([]);
    const half = poseAt(d, d.actions[0]!, second / 2).props.get('robot')!;
    expect(half.translation).toEqual([500, 0, 500]);
    expect(half.rotation[0]).toBeCloseTo(Math.sin(Math.PI / 8), 9);
    // Without an action the prop is where its placement puts it.
    expect(poseAt(d, null, 0).props.get('robot')).toEqual(robot.placement);
    // A placement target is a translation or rotation of a prop, of the right size.
    const bad = structuredClone(d);
    (bad.actions[0]!.tracks.at(-1)!.target as { property: string }).property = 'scale';
    expect(codes(bad)).toContain(
      `target $.actions[0].tracks[${bad.actions[0]!.tracks.length - 1}].target`,
    );
    const short = structuredClone(d);
    short.actions[0]!.tracks.at(-1)!.keys[0]!.value = [0, 0, 1];
    expect(codes(short).some((c) => c.startsWith('value '))).toBe(true);
    // Removing the prop removes its placement tracks too; glTF reports them as left out.
    const glb = exportGlb(d, blockyFigure().meshes, new Map());
    expect(glb.losses).toContain('prop-joint-track ×2');
    const gone = applyCharacterOperation(d, { type: 'removeProp', id: 'robot' });
    expect(gone.actions[0]!.tracks.some((t) => t.target.kind === 'prop')).toBe(false);
    expect(codes(gone)).toEqual([]);
  });
  it('points a prop at another version of its Artifact, keeping its ID, placement and tracks', () => {
    let d = keyPlacement(withRobot(), 'translation', 0, [0, 0, 0]);
    const source = { ...robot.source, versionId: 'v-2', contentHash: 'b'.repeat(64) };
    d = applyCharacterOperation(d, { type: 'setPropSource', id: 'robot', source });
    expect(d.props[0]!.source).toEqual(source);
    expect(d.props[0]!.placement).toEqual(robot.placement);
    expect(d.actions[0]!.tracks.some((t) => t.target.kind === 'prop')).toBe(true);
    expect(() =>
      applyCharacterOperation(d, {
        type: 'setPropSource',
        id: 'robot',
        source: { ...source, artifactId: 'art-2' },
      }),
    ).toThrow(/prop-source/);
    expect(() =>
      applyCharacterOperation(d, { type: 'setPropSource', id: 'gone', source }),
    ).toThrow();
    // The unfit joint tracks the Host found can be removed in the same edit, no other track.
    d = applyCharacterOperation(d, {
      type: 'setKey',
      actionId: d.actions[0]!.id,
      target: { kind: 'prop-joint', id: 'robot', joint: 'j-pitch', property: 'angle' },
      tick: 0,
      value: 3,
      trackId: 'pitch',
      keyId: 'pitch#0',
    });
    const v1 = { ...robot.source };
    const back = applyCharacterOperation(d, {
      type: 'setPropSource',
      id: 'robot',
      source: v1,
      dropTracks: [{ actionId: d.actions[0]!.id, trackId: 'pitch' }],
    });
    expect(back.props[0]!.source).toEqual(v1);
    expect(back.actions[0]!.tracks.some((t) => t.id === 'pitch')).toBe(false);
    expect(back.actions[0]!.tracks.some((t) => t.target.kind === 'prop')).toBe(true);
    const placementTrack = d.actions[0]!.tracks.find((t) => t.target.kind === 'prop')!;
    expect(() =>
      applyCharacterOperation(d, {
        type: 'setPropSource',
        id: 'robot',
        source: v1,
        dropTracks: [{ actionId: d.actions[0]!.id, trackId: placementTrack.id }],
      }),
    ).toThrow(/prop-source/);
  });
});

describe('MR7 mount keys: a prop part switching its candidate joint (TS-1719)', () => {
  const mounts = { from: { 'm-rifle': 'j-hand' }, to: { 'm-rifle': 'j-back' } };
  const mountKeys = (doc: CharacterDocument) =>
    doc.actions[0]!.tracks.filter((t) => t.target.kind === 'prop-mount');
  it('keys a switching mount held at its switch, with form A from the start when later', () => {
    const atStart = propTransformKeys(input({ mounts }));
    if (atStart.status !== 'ok') throw new Error(atStart.problem.code);
    expect(
      atStart.keys.filter((k) => k.target.kind === 'prop-mount').map((k) => [k.tick, k.value]),
    ).toEqual([[0, 'j-back']]);
    const later = propTransformKeys(
      input({ mounts: { ...mounts, switches: { 'm-rifle': second / 2 } } }),
    );
    if (later.status !== 'ok') throw new Error(later.problem.code);
    expect(
      later.keys
        .filter((k) => k.target.kind === 'prop-mount')
        .map((k) => [k.tick, k.value, k.easing.type]),
    ).toEqual([
      [0, 'j-hand', 'hold'],
      [second / 2, 'j-back', 'hold'],
    ]);
    // A switch outside the transform, or forms naming other mounts, is refused.
    const outside = propTransformKeys(
      input({ mounts: { ...mounts, switches: { 'm-rifle': second + 1 } } }),
    );
    expect(outside.status === 'refused' && outside.problem).toEqual({
      code: 'transform-switch-time',
      mount: 'm-rifle',
    });
    const other = propTransformKeys(input({ mounts: { from: mounts.from, to: { 'm-x': 'j' } } }));
    expect(other.status === 'refused' && other.problem.code).toBe('transform-mounts');
    // Unchanged mounts get no keys; only mounts that differ need a switch.
    const same = propTransformKeys(input({ mounts: { from: mounts.from, to: mounts.from } }));
    expect(same.status === 'ok' && same.keys.some((k) => k.target.kind === 'prop-mount')).toBe(
      false,
    );
  });
  it('makes a switch between forms that differ only in their mounts', () => {
    const empty = [{ joints: [], start: 0, length: second, easing: { type: 'linear' as const } }];
    const only = propTransformKeys(
      input({
        to: stand,
        groups: empty,
        mounts: { ...mounts, switches: { 'm-rifle': second / 2 } },
      }),
    );
    if (only.status !== 'ok') throw new Error(only.problem.code);
    expect(only.keys.map((k) => [k.tick, k.value])).toEqual([
      [0, 'j-hand'],
      [second / 2, 'j-back'],
    ]);
    // A group without joints still needs a reason: joints that change, or no mount that does.
    for (const over of [
      { groups: empty, mounts },
      { to: stand, groups: empty },
    ]) {
      const r = propTransformKeys(input(over));
      expect(r.status === 'refused' && r.problem.code).toBe('transform-group-empty');
    }
  });
  it('never takes a joint key for a mount key of another prop', () => {
    const joint = {
      kind: 'prop-joint' as const,
      id: 'mount',
      joint: 'robot',
      property: 'angle' as const,
    };
    const mount = {
      kind: 'prop-mount' as const,
      id: 'robot',
      mount: 'angle',
      property: 'joint' as const,
    };
    expect(propJointChannel(joint)).not.toBe(propJointChannel(mount));
  });
  it('holds each key until the next and keeps the version’s choice before the first', () => {
    const doc = put(
      withRobot(),
      input({ mounts: { ...mounts, switches: { 'm-rifle': second / 2 } } }),
    );
    expect(codes(doc)).toEqual([]);
    const action = doc.actions[0]!;
    const mount = (tick: number) => poseAt(doc, action, tick).mounts.get('robot')?.get('m-rifle');
    expect([mount(0), mount(second / 2 - 1), mount(second / 2), mount(second)]).toEqual([
      'j-hand',
      'j-hand',
      'j-back',
      'j-back',
    ]);
    const atStart = put(withRobot(), input({ mounts }));
    // Moved later, the first key leaves the start to the version's own choice.
    const moved = applyCharacterOperation(atStart, {
      type: 'moveKeys',
      actionId: action.id,
      keys: mountKeys(atStart).flatMap((t) => t.keys.map((k) => ({ trackId: t.id, keyId: k.id }))),
      delta: second / 4,
    });
    expect(poseAt(moved, moved.actions[0]!, 0).mounts.get('robot')).toBeUndefined();
    expect(
      poseAt(moved, moved.actions[0]!, second / 4)
        .mounts.get('robot')
        ?.get('m-rifle'),
    ).toBe('j-back');
  });
  it('validates a mount track: a joint ID per key, held, one track per mount', () => {
    const doc = put(withRobot(), input({ mounts }));
    const bad = structuredClone(doc);
    const track = bad.actions[0]!.tracks.find((t) => t.target.kind === 'prop-mount')!;
    track.keys[0]!.value = 3;
    expect(codes(bad)).toContain(
      `value $.actions[0].tracks[${bad.actions[0]!.tracks.indexOf(track)}].keys[0].value`,
    );
    track.keys[0]!.value = 'j-back';
    track.keys[0]!.easing = { type: 'linear' };
    expect(codes(bad).some((c) => c.startsWith('mount-easing '))).toBe(true);
    track.keys[0]!.easing = { type: 'hold' };
    bad.actions[0]!.tracks.push({ ...structuredClone(track), id: 'track-2' });
    expect(codes(bad).some((c) => c.startsWith('duplicate-target '))).toBe(true);
    // A set key on a mount holds by default and replaces a key at its tick.
    const set = applyCharacterOperation(doc, {
      type: 'setKey',
      actionId: doc.actions[0]!.id,
      target: { kind: 'prop-mount', id: 'robot', mount: 'm-rifle', property: 'joint' },
      tick: second,
      value: 'j-hand',
      trackId: 'unused',
      keyId: 'key-new',
    });
    expect(mountKeys(set)).toHaveLength(1);
    expect(mountKeys(set)[0]!.keys.map((k) => [k.tick, k.value, k.easing.type])).toEqual([
      [0, 'j-back', 'hold'],
      [second, 'j-hand', 'hold'],
    ]);
  });
  it('removes and drops mount tracks with the prop; glTF leaves them out like joint tracks', () => {
    const doc = put(withRobot(), input({ mounts }));
    const track = mountKeys(doc)[0]!;
    const dropped = applyCharacterOperation(doc, {
      type: 'setPropSource',
      id: 'robot',
      source: { ...robot.source, versionId: 'v-2', contentHash: 'b'.repeat(64) },
      dropTracks: [{ actionId: doc.actions[0]!.id, trackId: track.id }],
    });
    expect(mountKeys(dropped)).toEqual([]);
    const removed = applyCharacterOperation(doc, { type: 'removeProp', id: 'robot' });
    expect(mountKeys(removed)).toEqual([]);
    expect(codes(removed)).toEqual([]);
    // Five joint value tracks and the mount's.
    const glb = exportGlb(doc, blockyFigure().meshes, new Map());
    expect(glb.losses).toContain('prop-joint-track ×6');
  });
});
