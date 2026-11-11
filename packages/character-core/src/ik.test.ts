import { describe, expect, it } from 'vitest';
import {
  CharacterValidationError,
  applyCharacterOperation,
  characterIds,
  diffCharacterIds,
  emptyCharacter,
  ikChainProblem,
  ikPoseRotations,
  eulerXyzToQuat,
  identityTransform,
  poseAt,
  quatToEulerXyz,
  restMatrices,
  solvedBones,
  worldMatrices,
  type CharacterBone,
  type CharacterDocument,
  type CharacterIkChain,
  type CharacterOperation,
  type Vec3,
} from './index';

const at = (x: number, y: number, z: number) => ({
  ...identityTransform(),
  translation: [x, y, z] as Vec3,
});
/** A shoulder at z = 1000 and `n` bones of 300 mm along x below it (the last one the tip). */
function arm(n = 2): CharacterDocument {
  const bones: CharacterBone[] = [{ id: 'b0', name: 'B0', parentId: null, rest: at(0, 0, 1000) }];
  for (let k = 1; k <= n; k++)
    bones.push({ id: `b${k}`, name: `B${k}`, parentId: `b${k - 1}`, rest: at(300, 0, 0) });
  return applyCharacterOperation(emptyCharacter('Arm'), {
    type: 'addSkeleton',
    skeleton: { id: 'rig', name: 'Rig', parentPartId: null, bones },
  });
}
const chain = (over: Partial<CharacterIkChain> = {}): CharacterIkChain => ({
  id: 'reach',
  name: 'Reach',
  tipBoneId: 'b2',
  length: 2,
  target: [400, 0, 1200],
  pole: null,
  enabled: true,
  ...over,
});
const withChain = (d: CharacterDocument, c: CharacterIkChain) =>
  applyCharacterOperation(d, { type: 'addIkChain', skeletonId: 'rig', chain: c });
const head = (d: CharacterDocument, id: string, ik = true) => {
  const m = worldMatrices(d, poseAt(d, null, 0), { ik }).bones.get(id)!;
  return [m[12]!, m[13]!, m[14]!] as Vec3;
};
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const refused = (d: CharacterDocument, op: CharacterOperation) => {
  try {
    applyCharacterOperation(d, op);
  } catch (e) {
    if (e instanceof CharacterValidationError) return e.diagnostics.map((x) => x.code);
    throw e;
  }
  return [];
};

describe('C5d IK chains (TS-1254)', () => {
  it('reaches a target with two bones exactly, keeping their lengths, and bends toward the pole', () => {
    const up = withChain(arm(), chain({ pole: [300, 0, 3000] }));
    expect(dist(head(up, 'b2'), [400, 0, 1200])).toBeLessThan(1e-3);
    expect(dist(head(up, 'b1'), head(up, 'b0'))).toBeCloseTo(300, 3);
    expect(dist(head(up, 'b2'), head(up, 'b1'))).toBeCloseTo(300, 3);
    // The elbow is on the pole's side of the shoulder–target line (above it), then below.
    expect(head(up, 'b1')[2]).toBeGreaterThan(1150);
    const down = withChain(arm(), chain({ pole: [300, 0, -3000] }));
    expect(dist(head(down, 'b2'), [400, 0, 1200])).toBeLessThan(1e-3);
    expect(head(down, 'b1')[2]).toBeLessThan(1050);
  });
  it('points straight at a target out of reach', () => {
    const d = withChain(arm(), chain({ target: [3000, 0, 1000] }));
    expect(dist(head(d, 'b2'), [600, 0, 1000])).toBeLessThan(1e-3);
  });
  it('solves a longer chain by FABRIK', () => {
    const d = withChain(arm(4), chain({ tipBoneId: 'b4', length: 4, target: [500, 300, 1400] }));
    expect(dist(head(d, 'b4'), [500, 300, 1400])).toBeLessThan(0.1);
    for (let k = 1; k <= 4; k++)
      expect(dist(head(d, `b${k}`), head(d, `b${k - 1}`))).toBeCloseTo(300, 2);
  });
  it('bends a straight chain toward its pole to reach a target on its own line', () => {
    const d = withChain(
      arm(4),
      chain({ tipBoneId: 'b4', length: 4, target: [500, 0, 1000], pole: [0, 500, 1000] }),
    );
    expect(dist(head(d, 'b4'), [500, 0, 1000])).toBeLessThan(0.1);
    // It bent toward the pole (+y).
    expect(head(d, 'b2')[1]).toBeGreaterThan(0);
  });
  it('turns a chain to a pole on the far side about the root–target line only', () => {
    // Three bones bent out to +x, the tip already on the target; the pole is on −x.
    const bones: CharacterBone[] = [
      { id: 'b0', name: 'B0', parentId: null, rest: at(0, 0, 0) },
      { id: 'b1', name: 'B1', parentId: 'b0', rest: at(300, 0, 200) },
      { id: 'b2', name: 'B2', parentId: 'b1', rest: at(0, 0, 200) },
      { id: 'b3', name: 'B3', parentId: 'b2', rest: at(-300, 0, 200) },
    ];
    let d = applyCharacterOperation(emptyCharacter('Arm'), {
      type: 'addSkeleton',
      skeleton: { id: 'rig', name: 'Rig', parentPartId: null, bones },
    });
    d = withChain(
      d,
      chain({ tipBoneId: 'b3', length: 3, target: [0, 0, 600], pole: [-500, 0, 0] }),
    );
    expect(dist(head(d, 'b3'), [0, 0, 600])).toBeLessThan(0.1);
    expect(head(d, 'b1')[0]).toBeLessThan(0);
    expect(dist(head(d, 'b1'), head(d, 'b0'))).toBeCloseTo(Math.hypot(300, 200), 2);
  });
  it('folds back onto a target at the root', () => {
    const d = withChain(arm(), chain({ target: [0, 0, 1000], pole: [0, 0, 2000] }));
    expect(dist(head(d, 'b2'), [0, 0, 1000])).toBeLessThan(1e-3);
    expect(dist(head(d, 'b1'), head(d, 'b0'))).toBeCloseTo(300, 3);
  });
  it('keeps a mirrored bone mirrored while it solves', () => {
    let d = withChain(arm(), chain());
    d = structuredClone(d);
    d.skeletons[0]!.bones[0]!.rest.scale = [1, -1, 1];
    expect(dist(head(d, 'b2'), [400, 0, 1200])).toBeLessThan(1e-3);
  });
  it('holds a bone inside its limits (the solution only, not the keys)', () => {
    let d = withChain(arm(), chain({ target: [300, 0, 1300] }));
    d = applyCharacterOperation(d, {
      type: 'setBoneLimits',
      skeletonId: 'rig',
      id: 'b1',
      limits: { min: [0, -10, 0], max: [0, 10, 0] },
    });
    const turn = quatToEulerXyz(solvedBones(d, poseAt(d, null, 0)).get('b1')!.rotation);
    expect(Math.abs(turn[1])).toBeLessThanOrEqual(10 + 1e-6);
    expect(Math.abs(turn[0]) + Math.abs(turn[2])).toBeLessThan(1e-6);
    // The elbow may bend only 10°: the tip does not reach the target.
    expect(dist(head(d, 'b2'), [300, 0, 1300])).toBeGreaterThan(10);
    // Keys are not clamped.
    expect(d.skeletons[0]!.bones[1]!.rest.rotation).toEqual([0, 0, 0, 1]);
  });
  it('bends the other way when the preferred bend is outside the limits', () => {
    // Root at the origin, two 300 mm bones along +x; the elbow may only bend −90…0° about z.
    const bones: CharacterBone[] = [
      { id: 'b0', name: 'B0', parentId: null, rest: at(0, 0, 0) },
      {
        id: 'b1',
        name: 'B1',
        parentId: 'b0',
        rest: at(300, 0, 0),
        limits: { min: [0, 0, -90], max: [0, 0, 0] },
      },
      { id: 'b2', name: 'B2', parentId: 'b1', rest: at(300, 0, 0) },
    ];
    let d = applyCharacterOperation(emptyCharacter('Arm'), {
      type: 'addSkeleton',
      skeleton: { id: 'rig', name: 'Rig', parentPartId: null, bones },
    });
    d = withChain(d, chain({ target: [300, 300, 0] }));
    expect(dist(head(d, 'b2'), [300, 300, 0])).toBeLessThan(1e-3);
  });
  it('takes a Y turn past 90° the limits allow for what it is, not for X and Z turns', () => {
    const bones: CharacterBone[] = [
      {
        id: 'b0',
        name: 'B0',
        parentId: null,
        rest: at(0, 0, 0),
        limits: { min: [0, 0, 0], max: [0, 150, 0] },
      },
      { id: 'b1', name: 'B1', parentId: 'b0', rest: at(300, 0, 0) },
    ];
    let d = applyCharacterOperation(emptyCharacter('Arm'), {
      type: 'addSkeleton',
      skeleton: { id: 'rig', name: 'Rig', parentPartId: null, bones },
    });
    d = withChain(d, chain({ tipBoneId: 'b1', length: 1, target: [-150, 0, -259.807621] }));
    expect(dist(head(d, 'b1'), [-150, 0, -259.807621])).toBeLessThan(1e-3);
  });
  it('restores the lengths of a folded chain it seeded a bend into', () => {
    // Folded back on itself with the tip already on the target.
    const bones: CharacterBone[] = [
      { id: 'b0', name: 'B0', parentId: null, rest: at(0, 0, 0) },
      { id: 'b1', name: 'B1', parentId: 'b0', rest: at(300, 0, 0) },
      { id: 'b2', name: 'B2', parentId: 'b1', rest: at(-300, 0, 0) },
      { id: 'b3', name: 'B3', parentId: 'b2', rest: at(300, 0, 0) },
    ];
    let d = applyCharacterOperation(emptyCharacter('Arm'), {
      type: 'addSkeleton',
      skeleton: { id: 'rig', name: 'Rig', parentPartId: null, bones },
    });
    d = withChain(d, chain({ tipBoneId: 'b3', length: 3, target: [300, 0, 0], pole: [0, 500, 0] }));
    expect(dist(head(d, 'b3'), [300, 0, 0])).toBeLessThan(0.1);
    for (let k = 1; k <= 3; k++)
      expect(dist(head(d, `b${k}`), head(d, `b${k - 1}`))).toBeCloseTo(300, 2);
  });
  it('turns a chain to its pole by the first interior joint off the root–target line', () => {
    const bones: CharacterBone[] = [
      { id: 'b0', name: 'B0', parentId: null, rest: at(0, 0, 0) },
      { id: 'b1', name: 'B1', parentId: 'b0', rest: at(0, 0, 300) },
      { id: 'b2', name: 'B2', parentId: 'b1', rest: at(300, 0, 0) },
      { id: 'b3', name: 'B3', parentId: 'b2', rest: at(-300, 0, 300) },
    ];
    let d = applyCharacterOperation(emptyCharacter('Arm'), {
      type: 'addSkeleton',
      skeleton: { id: 'rig', name: 'Rig', parentPartId: null, bones },
    });
    d = withChain(
      d,
      chain({ tipBoneId: 'b3', length: 3, target: [0, 0, 600], pole: [-500, 0, 0] }),
    );
    expect(dist(head(d, 'b3'), [0, 0, 600])).toBeLessThan(0.1);
    expect(head(d, 'b2')[0]).toBeLessThan(0);
  });
  it('keeps a rotation at Y = 90° that its limits allow as X and Z together', () => {
    const bones: CharacterBone[] = [
      {
        id: 'b0',
        name: 'B0',
        parentId: null,
        rest: { ...at(0, 0, 0), rotation: eulerXyzToQuat([30, 90, 0]) },
        limits: { min: [30, 90, -60], max: [60, 90, 0] },
      },
      { id: 'b1', name: 'B1', parentId: 'b0', rest: at(0, 300, 0) },
    ];
    let d = applyCharacterOperation(emptyCharacter('Arm'), {
      type: 'addSkeleton',
      skeleton: { id: 'rig', name: 'Rig', parentPartId: null, bones },
    });
    const tip = head(d, 'b1', false);
    d = withChain(d, chain({ tipBoneId: 'b1', length: 1, target: tip }));
    expect(dist(head(d, 'b1'), tip)).toBeLessThan(1e-3);
  });
  it('counts a lost chain as a change to the bones it moves (re-import review)', () => {
    const d = withChain(arm(), chain());
    const diff = diffCharacterIds(d, arm());
    expect(diff.changed.map((e) => e.id).sort()).toEqual(['b0', 'b1', 'b2']);
    expect(diffCharacterIds(arm(), arm()).changed).toEqual([]);
  });
  it('solves exactly under an unevenly scaled parent, and reports unevenly scaled chain bones (#752, TS-1300)', () => {
    // b0 scaled 2× along X: b1's head is at x = 600 and its bones are 600 mm long in the world
    // along X but 300 mm along Y. A 90° turn of b1 about Z brings b3 to [600, 600, 1000].
    const base = arm(3);
    base.skeletons[0]!.bones[0]!.rest.scale = [2, 1, 1];
    for (const target of [
      [600, 600, 1000],
      [900, 300, 1000],
      [400, 200, 1100],
    ] as Vec3[]) {
      const d = withChain(base, chain({ tipBoneId: 'b3', length: 2, target }));
      expect(dist(head(d, 'b3'), target)).toBeLessThan(1e-3);
    }
    const s = base.skeletons[0]!;
    expect(ikChainProblem(s, { tipBoneId: 'b3', length: 2 })).toBeUndefined();
    // The scaled bone inside the chain: approximate, and reported.
    expect(ikChainProblem(s, { tipBoneId: 'b2', length: 2 })).toBe('ik-chain-scaled');
    // Longer chains (FABRIK) too.
    const long = arm(4);
    long.skeletons[0]!.bones[0]!.rest.scale = [1, 3, 1];
    const d = withChain(long, chain({ tipBoneId: 'b4', length: 3, target: [500, 900, 1000] }));
    expect(dist(head(d, 'b4'), [500, 900, 1000])).toBeLessThan(1e-2);
  });
  it('never solves the rest pose or a disabled chain', () => {
    const d = withChain(arm(), chain());
    expect(restMatrices(d).bones.get('b2')!.slice(12, 15)).toEqual([600, 0, 1000]);
    expect(head(d, 'b2', false)).toEqual([600, 0, 1000]);
    const off = withChain(arm(), chain({ enabled: false }));
    expect(head(off, 'b2')).toEqual([600, 0, 1000]);
  });
  it('refuses a chain longer than its bones, bad limits and removing a bone a chain uses', () => {
    expect(
      refused(arm(), { type: 'addIkChain', skeletonId: 'rig', chain: chain({ length: 3 }) }),
    ).toEqual(['ik-chain']);
    expect(
      refused(arm(), {
        type: 'addIkChain',
        skeletonId: 'rig',
        chain: chain({ tipBoneId: 'nope' }),
      }),
    ).toEqual(['ik-chain']);
    expect(
      refused(arm(), {
        type: 'setBoneLimits',
        skeletonId: 'rig',
        id: 'b1',
        limits: { min: [10, 0, 0], max: [0, 0, 0] },
      }),
    ).toEqual(['bone-limits']);
    const d = withChain(arm(), chain());
    expect(refused(d, { type: 'removeBone', skeletonId: 'rig', id: 'b1' })).toEqual(['ik-in-use']);
    const gone = applyCharacterOperation(d, {
      type: 'removeIkChain',
      skeletonId: 'rig',
      id: 'reach',
    });
    expect(gone.skeletons[0]!.ik).toBeUndefined();
    expect(characterIds(gone).has('reach')).toBe(true);
    expect(refused(gone, { type: 'addIkChain', skeletonId: 'rig', chain: chain() })).toContain(
      'retired-id',
    );
  });
});

describe('C5d posing by IK (TS-1256)', () => {
  const withAction = (d: CharacterDocument): CharacterDocument => ({
    ...d,
    actions: [
      {
        id: 'act',
        name: 'Act',
        duration: 240000,
        frameRate: { numerator: 30, denominator: 1 },
        tracks: [],
      },
    ],
  });
  it('keys the rotations that bring a free chain to a point, all in one edit', () => {
    const d = withAction(withChain(arm(), chain({ enabled: false })));
    const pose = poseAt(d, d.actions[0]!, 0);
    const turns = ikPoseRotations(d, pose, 'rig', 'reach', [300, 300, 1100])!;
    expect([...turns.keys()]).toEqual(['b0', 'b1']);
    const keyed = applyCharacterOperation(d, {
      type: 'setKeys',
      actionId: 'act',
      keys: [...turns].map(([id, value]) => ({
        target: { kind: 'bone', id, property: 'rotation' },
        tick: 0,
        value,
        trackId: `t-${id}`,
        keyId: `k-${id}`,
      })),
    });
    expect(keyed.actions[0]!.tracks).toHaveLength(2);
    // The chain stays free; the keys alone pose the tip there.
    const m = worldMatrices(keyed, poseAt(keyed, keyed.actions[0]!, 0)).bones.get('b2')!;
    expect(dist([m[12]!, m[13]!, m[14]!], [300, 300, 1100])).toBeLessThan(1e-3);
    expect(ikPoseRotations(d, pose, 'rig', 'nope', [0, 0, 0])).toBeUndefined();
  });
  it('refuses two keys on one target in one setKeys', () => {
    const d = withAction(arm());
    const key = {
      target: { kind: 'bone' as const, id: 'b1', property: 'rotation' as const },
      tick: 0,
      value: [0, 0, 0, 1] as [number, number, number, number],
    };
    expect(
      refused(d, {
        type: 'setKeys',
        actionId: 'act',
        keys: [
          { ...key, trackId: 't1', keyId: 'k1' },
          { ...key, trackId: 't2', keyId: 'k2' },
        ],
      }),
    ).toEqual(['keys']);
    // The same channel spelled with its fields in another order.
    expect(
      refused(d, {
        type: 'setKeys',
        actionId: 'act',
        keys: [
          { ...key, trackId: 't1', keyId: 'k1' },
          {
            ...key,
            target: { property: 'rotation', id: 'b1', kind: 'bone' },
            trackId: 't2',
            keyId: 'k2',
          },
        ],
      }),
    ).toEqual(['keys']);
  });
});
