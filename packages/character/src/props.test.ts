import { describe, expect, it } from 'vitest';
import {
  applyCharacterOperation,
  blockyFigure,
  poseAt,
  type CharacterDocument,
} from '@editor-platform/character-core';
import {
  besidePlacement,
  instanceBounds,
  missingJoints,
  propFrames,
  propSourceProblems,
  unionBounds,
  type CharacterPropMesh,
  type CharacterPropView,
} from './props';
import { sweepSampleTicks, sweepTicksWithSwitches } from './prop-sweep';

const mesh: CharacterPropMesh = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
  color: '#888888',
  opacity: 1,
};
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function withProp(): CharacterDocument {
  return applyCharacterOperation(blockyFigure().doc, {
    type: 'addProp',
    prop: {
      id: 'arm',
      name: 'Arm',
      source: { kind: 'cad', artifactId: 'a', versionId: 'v', contentHash: 'b'.repeat(64) },
      placement: { translation: [100, 0, 0], rotation: [0, 0, 0, 1] },
      visible: true,
    },
  });
}

describe('prop frames (C2b)', () => {
  it('asks the view for the keyed joint values and places its meshes', () => {
    let d = withProp();
    d = applyCharacterOperation(d, {
      type: 'setKey',
      actionId: 'wave',
      target: { kind: 'prop-joint', id: 'arm', joint: 'j', property: 'angle' },
      tick: 0,
      value: 0.5,
      trackId: 't',
      keyId: 'k',
    });
    const asked: unknown[] = [];
    const view: CharacterPropView = {
      status: 'ready',
      joints: [{ id: 'j', name: 'J', values: [{ key: 'angle', saved: 0 }] }],
      draw: (values) => {
        asked.push(Object.fromEntries(values));
        return [{ mesh, matrix: identity }];
      },
    };
    const frames = propFrames(d, new Map([['arm', view]]), poseAt(d, d.actions[0]!, 0));
    expect(asked).toEqual([{ j: { angle: 0.5 } }]);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.instances[0]!.matrix.slice(12, 15)).toEqual([100, 0, 0]);
    // Rest pose: no keyed values, the version's own.
    propFrames(d, new Map([['arm', view]]), poseAt(d, null, 0));
    expect(asked[1]).toEqual({});
    expect(missingJoints(d, 'arm', view)).toEqual([]);
    // A view without that joint names it; a pending or failed view draws nothing.
    expect(missingJoints(d, 'arm', { ...view, joints: [] })).toEqual(['j']);
    expect(propFrames(d, new Map([['arm', { status: 'pending' }]]), poseAt(d, null, 0))).toEqual(
      [],
    );
  });
});

describe('placing a new prop beside the character (#718, TS-1302)', () => {
  it('measures instances where their matrices put them, and joins boxes', () => {
    const moved = [1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1];
    expect(instanceBounds([{ mesh, matrix: moved }])).toEqual([
      [10, 20, 30],
      [11, 22, 30],
    ]);
    expect(instanceBounds([])).toBeUndefined();
    expect(
      unionBounds(
        [
          [0, 0, 0],
          [1, 1, 1],
        ],
        [
          [-1, 2, 0],
          [0, 3, 5],
        ],
      ),
    ).toEqual([
      [-1, 0, 0],
      [1, 3, 5],
    ]);
    expect(unionBounds(undefined, undefined)).toBeUndefined();
  });

  it('stands the prop on the floor beside the scene, centred on its depth, at its own size', () => {
    // A figure 600 wide, 300 deep, 1,800 tall; a 200 mm box whose origin is its corner.
    const figure: [[number, number, number], [number, number, number]] = [
      [-300, -150, 0],
      [300, 150, 1800],
    ];
    const box: [[number, number, number], [number, number, number]] = [
      [0, 0, 0],
      [200, 200, 200],
    ];
    const at = besidePlacement(figure, box);
    // Gap: 10% of the wider of the two, at least 100 mm.
    expect(at).toEqual([300 + 100, -100, 0]);
    const placed = [0, 1].map((k) => [box[k]![0] + at[0], box[k]![1] + at[1], box[k]![2] + at[2]]);
    expect(placed[0]![0]).toBeGreaterThan(figure[1][0]);
    expect((placed[0]![1] + placed[1]![1]) / 2).toBe(0);
    // A building far larger than the figure, centred on its origin and below the floor.
    const building: [[number, number, number], [number, number, number]] = [
      [-10000, -5000, -500],
      [10000, 5000, 9000],
    ];
    expect(besidePlacement(figure, building)).toEqual([300 + 2000 + 10000, 0, 500]);
    // Unknown size: the origin stands beside; nothing shown: the origin.
    expect(besidePlacement(figure, undefined)).toEqual([400, 0, 0]);
    expect(besidePlacement(undefined, box)).toEqual([0, 0, 0]);
  });
});

describe('propSourceProblems (MR4c, TS-1713)', () => {
  it('lists each joint track another version cannot play, and nothing for one it can', () => {
    let doc = applyCharacterOperation(blockyFigure().doc, {
      type: 'addProp',
      prop: {
        id: 'robot',
        name: 'Robot',
        source: { kind: 'cad', artifactId: 'a', versionId: 'v1', contentHash: 'a'.repeat(64) },
        placement: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
        visible: true,
      },
    });
    const actionId = doc.actions[0]!.id;
    for (const [joint, property, tick, value] of [
      ['j-gone', 'angle', 0, 0],
      ['j-hinge', 'angle2', 0, 0],
      ['j-wing-r', 'angle', 0, 0],
      ['j-hinge', 'angle', 0, 0.1],
      ['j-hinge', 'angle', 1000, 2],
      ['j-wing-l', 'angle', 0, 0.2],
      ['j-wing-l', 'angle', 1000, 1.2],
    ] as const)
      doc = applyCharacterOperation(doc, {
        type: 'setKey',
        actionId,
        target: { kind: 'prop-joint', id: 'robot', joint, property },
        tick,
        value,
        trackId: `${joint}/${property}`,
        keyId: `${joint}/${property}#${tick}`,
      });
    const next = {
      joints: [
        {
          id: 'j-hinge',
          name: 'Hinge',
          values: [{ key: 'angle' as const, saved: 0, min: 0, max: 1 }],
        },
        { id: 'j-wing-l', name: 'Wing', values: [{ key: 'angle' as const, saved: 0 }] },
      ],
      // The right wing follows the left at −1 and may not pass −1 rad.
      followers: [
        {
          joint: 'j-wing-r',
          key: 'angle' as const,
          from: { joint: 'j-wing-l', key: 'angle' as const },
          ratio: -1,
          offset: 0,
          min: -1,
          max: 1,
        },
      ],
    };
    expect(propSourceProblems(doc, 'robot', next).map((p) => [p.trackId, p.code])).toEqual([
      ['j-gone/angle', 'joint-missing'],
      ['j-hinge/angle2', 'value-missing'],
      ['j-wing-r/angle', 'value-coupled'],
      ['j-hinge/angle', 'key-out-of-limits'],
      ['j-wing-l/angle', 'follower-out-of-limits'],
    ]);
    expect(propSourceProblems(doc, 'robot', next).at(-2)).toMatchObject({ tick: 1000 });
    expect(propSourceProblems(doc, 'robot', next).at(-1)).toMatchObject({
      tick: 1000,
      follower: { joint: 'j-wing-r', key: 'angle' },
    });
    expect(propSourceProblems(doc, 'other', next)).toEqual([]);
  });
  it('finds a Bézier easing that overshoots the new limits between keys', async () => {
    const { trackExtremes } = await import('./props');
    const ease = { type: 'bezier' as const, x1: 0.5, y1: 2, x2: 0.5, y2: 2 };
    const keys = [
      { id: 'k0', tick: 0, value: 0, easing: ease },
      { id: 'k1', tick: 1000, value: 1, easing: { type: 'linear' as const } },
    ];
    const peak = Math.max(...trackExtremes(keys).map((e) => e.value));
    // y(½) = 3·¼·½·2·2 + ⅛ = 1.625; the true peak is a little past it.
    expect(peak).toBeGreaterThanOrEqual(1.625);
    expect(peak).toBeLessThan(1.7);
    // A plain easing reaches only its keys.
    expect(trackExtremes([{ ...keys[0]!, easing: { type: 'linear' } }, keys[1]!])).toHaveLength(2);
  });
  it('follows a chain of followers: A drives B, B drives C, C past its limits', () => {
    let doc = applyCharacterOperation(blockyFigure().doc, {
      type: 'addProp',
      prop: {
        id: 'robot',
        name: 'Robot',
        source: { kind: 'cad', artifactId: 'a', versionId: 'v1', contentHash: 'a'.repeat(64) },
        placement: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
        visible: true,
      },
    });
    doc = applyCharacterOperation(doc, {
      type: 'setKey',
      actionId: doc.actions[0]!.id,
      target: { kind: 'prop-joint', id: 'robot', joint: 'a', property: 'angle' },
      tick: 0,
      value: 1,
      trackId: 'a/angle',
      keyId: 'a/angle#0',
    });
    const follower = (joint: string, from: string, max: number) => ({
      joint,
      key: 'angle' as const,
      from: { joint: from, key: 'angle' as const },
      ratio: 1,
      offset: 0,
      min: -max,
      max,
    });
    const joints = [{ id: 'a', name: 'A', values: [{ key: 'angle' as const, saved: 0 }] }];
    expect(
      propSourceProblems(doc, 'robot', {
        joints,
        followers: [follower('b', 'a', 2), follower('c', 'b', 0.5)],
      }),
    ).toMatchObject([{ code: 'follower-out-of-limits', follower: { joint: 'c' } }]);
    expect(
      propSourceProblems(doc, 'robot', {
        joints,
        followers: [follower('b', 'a', 2), follower('c', 'b', 2)],
      }),
    ).toEqual([]);
  });
});

describe('sampling an action for overlaps (MR5, TS-1714)', () => {
  it('samples from 0 every step and at the end, and groups each pair from first to last', async () => {
    const { sweepTicks, sweepTickCount, sweepPairs } = await import('./prop-sweep');
    expect(sweepTicks(240_000, 100_000)).toEqual([0, 100_000, 200_000, 240_000]);
    expect(sweepTicks(240_000, 120_000)).toEqual([0, 120_000, 240_000]);
    expect(sweepTickCount(240_000, 100_000)).toBe(4);
    expect(sweepTickCount(240_000, 120_000)).toBe(3);
    // Counted without building: a 10-day action at 1 tick.
    expect(sweepTickCount(864_000_000, 1)).toBe(864_000_001);
    const o = (a: string, depthMm: number, aId = a) => ({
      a,
      b: 'Body',
      aId,
      bId: 'body',
      kind: 'intersect' as const,
      depthMm,
    });
    expect(
      sweepPairs({
        status: 'ok',
        samples: 3,
        hits: [
          { tick: 10, overlaps: [o('Wing', 1)] },
          { tick: 20, overlaps: [o('Wing', 3), o('Arm', 0.5)] },
          // Another occurrence also named Wing stays its own pair.
          { tick: 30, overlaps: [o('Wing', 2, 'wing-2')] },
        ],
        unchecked: [],
      }),
    ).toEqual([
      {
        a: 'Wing',
        b: 'Body',
        aId: 'Wing',
        bId: 'body',
        kind: 'intersect',
        depthMm: 3,
        first: 10,
        last: 20,
      },
      {
        a: 'Arm',
        b: 'Body',
        aId: 'Arm',
        bId: 'body',
        kind: 'intersect',
        depthMm: 0.5,
        first: 20,
        last: 20,
      },
      {
        a: 'Wing',
        b: 'Body',
        aId: 'wing-2',
        bId: 'body',
        kind: 'intersect',
        depthMm: 2,
        first: 30,
        last: 30,
      },
    ]);
  });
});

describe('MR7 mounts in the character package (TS-1719)', () => {
  const keyed = () => {
    let doc = withProp();
    const actionId = doc.actions[0]!.id;
    for (const [tick, value] of [
      [0, 'j-hand'],
      [120_000, 'j-back'],
    ] as const)
      doc = applyCharacterOperation(doc, {
        type: 'setKey',
        actionId,
        target: { kind: 'prop-mount', id: 'arm', mount: 'm-tool', property: 'joint' },
        tick,
        value,
        trackId: 'track-mount',
        keyId: `key-${tick}`,
      });
    return doc;
  };
  it('draws a prop with its keyed mounts', () => {
    const doc = keyed();
    const seen: (string | undefined)[] = [];
    const view: CharacterPropView = {
      status: 'ready',
      joints: [],
      draw: (_, mounts) => {
        seen.push(mounts?.get('m-tool'));
        return [{ mesh, matrix: identity }];
      },
    };
    const views = new Map([['arm', view]]);
    propFrames(doc, views, poseAt(doc, doc.actions[0]!, 60_000));
    propFrames(doc, views, poseAt(doc, doc.actions[0]!, 120_000));
    expect(seen).toEqual(['j-hand', 'j-back']);
  });
  it('lists a mount track another version has no mount or candidate for (mount-missing)', () => {
    const doc = keyed();
    const base = { joints: [], followers: [] };
    expect(
      propSourceProblems(doc, 'arm', {
        ...base,
        mounts: [{ id: 'm-tool', joints: ['j-hand', 'j-back'] }],
      }),
    ).toEqual([]);
    expect(propSourceProblems(doc, 'arm', base)).toEqual([
      {
        actionId: doc.actions[0]!.id,
        trackId: 'track-mount',
        code: 'mount-missing',
        mount: 'm-tool',
      },
    ]);
    expect(
      propSourceProblems(doc, 'arm', {
        ...base,
        mounts: [{ id: 'm-tool', joints: ['j-hand', 'j-hip'] }],
      }),
    ).toEqual([
      {
        actionId: doc.actions[0]!.id,
        trackId: 'track-mount',
        code: 'mount-missing',
        mount: 'm-tool',
        joint: 'j-back',
      },
    ]);
  });
  it('samples the sweep at each mount switch as well', () => {
    const doc = keyed();
    const action = { ...doc.actions[0]!, duration: 240_000 };
    expect(sweepTicksWithSwitches(action, 'arm', 100_000)).toEqual([
      0, 100_000, 120_000, 200_000, 240_000,
    ]);
  });
  it('counts each switch time once against the sweep limit', () => {
    const action = keyed().actions[0]!;
    const step = 1_000;
    // 64 mounts switching together at ten sample times: 640 keys, but no time added.
    const tracks = Array.from({ length: 64 }, (_, m) => ({
      ...action.tracks[0]!,
      id: `track-${m}`,
      target: {
        kind: 'prop-mount' as const,
        id: 'arm',
        mount: `m-${m}`,
        property: 'joint' as const,
      },
      keys: Array.from({ length: 10 }, (_, i) => ({
        ...action.tracks[0]!.keys[0]!,
        id: `k-${m}-${i}`,
        tick: i * step,
      })),
    }));
    const many = { ...action, duration: 10 * step, tracks };
    expect(sweepSampleTicks(many, 'arm', step)).toHaveLength(11);
    // A grid already over the limit is refused before it is built.
    expect(sweepSampleTicks({ ...many, duration: 1_000 * step }, 'arm', step)).toEqual({
      count: 1001,
    });
  });
});
