import {
  applyCharacterOperation,
  emptyCharacter,
  identityTransform,
  poseAt,
  worldMatrices,
  type CharacterBone,
  type CharacterDocument,
  type CharacterIkChain,
  type Vec3,
} from '@editor-platform/character-core';
import { describe, expect, it } from 'vitest';
import { ikDropOperation } from './ik-inspector';

const at = (x: number, y: number, z: number) => ({
  ...identityTransform(),
  translation: [x, y, z] as Vec3,
});
const chain = (over: Partial<CharacterIkChain>): CharacterIkChain => ({
  id: 'c',
  name: 'C',
  tipBoneId: 'b2',
  length: 1,
  target: [0, 0, 0],
  pole: null,
  enabled: false,
  ...over,
});
/** Root at the origin, two 300 mm bones along +x; a free chain turns b1 and comes first, a
 * solving chain after it turns b0 so the middle joint is pinned at [0, 300, 0]. */
function rig(): CharacterDocument {
  const bones: CharacterBone[] = [
    { id: 'b0', name: 'B0', parentId: null, rest: at(0, 0, 0) },
    { id: 'b1', name: 'B1', parentId: 'b0', rest: at(300, 0, 0) },
    { id: 'b2', name: 'B2', parentId: 'b1', rest: at(300, 0, 0) },
  ];
  let d = applyCharacterOperation(emptyCharacter('Arm'), {
    type: 'addSkeleton',
    skeleton: { id: 'rig', name: 'Rig', parentPartId: null, bones },
  });
  d = applyCharacterOperation(d, {
    type: 'addIkChain',
    skeletonId: 'rig',
    chain: chain({ id: 'free' }),
  });
  d = applyCharacterOperation(d, {
    type: 'addIkChain',
    skeletonId: 'rig',
    chain: chain({ id: 'pin', tipBoneId: 'b1', target: [0, 300, 0], enabled: true }),
  });
  return {
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
  };
}
const tip = (d: CharacterDocument) => {
  const m = worldMatrices(d, poseAt(d, d.actions[0]!, 0)).bones.get('b2')!;
  return [m[12]!, m[13]!, m[14]!];
};

describe('IK handle drops (C5d2, TS-1258)', () => {
  it('keys a free chain so its tip lands on the point, after the solving chains', () => {
    const d = rig();
    const free = d.skeletons[0]!.ik![0]!;
    const op = ikDropOperation(d, { skeletonId: 'rig', chain: free }, [300, 300, 0], 'act', 0);
    expect(op?.type).toBe('setKeys');
    const [x, y, z] = tip(applyCharacterOperation(d, op!));
    expect(Math.hypot(x - 300, y - 300, z)).toBeLessThan(1e-3);
  });
  it("moves a solving chain's target, and makes nothing for a chain changed during the drag", () => {
    const d = rig();
    const pin = d.skeletons[0]!.ik![1]!;
    expect(ikDropOperation(d, { skeletonId: 'rig', chain: pin }, [0, 0, 300], 'act', 0)).toEqual({
      type: 'setIkChain',
      skeletonId: 'rig',
      chain: { ...pin, target: [0, 0, 300] },
    });
    const free = d.skeletons[0]!.ik![0]!;
    const changed = applyCharacterOperation(d, {
      type: 'setIkChain',
      skeletonId: 'rig',
      chain: { ...free, length: 2 },
    });
    expect(
      ikDropOperation(changed, { skeletonId: 'rig', chain: free }, [300, 300, 0], 'act', 0),
    ).toBeUndefined();
    expect(
      ikDropOperation(d, { skeletonId: 'rig', chain: free }, [300, 300, 0], undefined, 0),
    ).toBeUndefined();
  });
});
