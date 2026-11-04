import { describe, expect, it } from 'vitest';
import {
  CharacterValidationError,
  applyCharacterOperation,
  blockyFigure,
  boneRestMatrix,
  characterIds,
  emptyCharacter,
  identityTransform,
  poseAt,
  skinMatrices,
  skinnedPositions,
  worldMatrices,
  type CharacterDocument,
  type CharacterOperation,
} from './index';

const refused = (doc: CharacterDocument, op: CharacterOperation) => {
  try {
    applyCharacterOperation(doc, op);
  } catch (e) {
    if (e instanceof CharacterValidationError) return e.diagnostics.map((d) => d.code);
    throw e;
  }
  return [];
};
const at = (doc: CharacterDocument, skeleton: string, bone: string) =>
  boneRestMatrix(doc.skeletons.find((s) => s.id === skeleton)!, bone)
    .slice(12, 15)
    .map((x) => Math.round(x * 1e6) / 1e6);
const rest = (x: number, y: number, z: number) => ({
  ...identityTransform(),
  translation: [x, y, z] as [number, number, number],
});

describe('C5a skeleton and bone authoring (TS-1246)', () => {
  const start = () => {
    let d = emptyCharacter('Rig');
    d = applyCharacterOperation(d, {
      type: 'addSkeleton',
      skeleton: {
        id: 'rig',
        name: 'Rig',
        parentPartId: null,
        bones: [{ id: 'root', name: 'Root', parentId: null, rest: rest(0, 0, 900) }],
      },
    });
    d = applyCharacterOperation(d, {
      type: 'addBone',
      skeletonId: 'rig',
      bone: { id: 'spine', name: 'Spine', parentId: 'root', rest: rest(0, 0, 300) },
    });
    return applyCharacterOperation(d, {
      type: 'addBone',
      skeletonId: 'rig',
      bone: { id: 'head', name: 'Head', parentId: 'spine', rest: rest(0, 0, 250) },
    });
  };
  it('adds a skeleton and bones, and moves a bone at rest', () => {
    let d = start();
    expect(at(d, 'rig', 'head')).toEqual([0, 0, 1450]);
    d = applyCharacterOperation(d, {
      type: 'setBoneRest',
      skeletonId: 'rig',
      id: 'spine',
      rest: rest(0, 50, 300),
    });
    expect(at(d, 'rig', 'head')).toEqual([0, 50, 1450]);
  });
  it('re-parents a bone and keeps where it rests; refuses a cycle', () => {
    let d = start();
    d = applyCharacterOperation(d, {
      type: 'setBoneParent',
      skeletonId: 'rig',
      id: 'head',
      parentId: 'root',
    });
    expect(d.skeletons[0]!.bones.find((b) => b.id === 'head')!.parentId).toBe('root');
    expect(at(d, 'rig', 'head')).toEqual([0, 0, 1450]);
    d = applyCharacterOperation(d, {
      type: 'setBoneParent',
      skeletonId: 'rig',
      id: 'head',
      parentId: null,
    });
    expect(at(d, 'rig', 'head')).toEqual([0, 0, 1450]);
    expect(
      refused(start(), { type: 'setBoneParent', skeletonId: 'rig', id: 'root', parentId: 'head' }),
    ).toEqual(['cycle']);
  });
  it('removes a bone: its children keep their place; its ID is not reused', () => {
    let d = start();
    d = applyCharacterOperation(d, { type: 'removeBone', skeletonId: 'rig', id: 'spine' });
    const head = d.skeletons[0]!.bones.find((b) => b.id === 'head')!;
    expect(head.parentId).toBe('root');
    expect(at(d, 'rig', 'head')).toEqual([0, 0, 1450]);
    expect(characterIds(d).has('spine')).toBe(true);
    expect(
      refused(d, {
        type: 'addBone',
        skeletonId: 'rig',
        bone: { id: 'spine', name: 'Spine', parentId: null, rest: rest(0, 0, 0) },
      }),
    ).toContain('retired-id');
  });
  it('refuses the last bone, a weighted bone and a bound skeleton', () => {
    const one = applyCharacterOperation(emptyCharacter('Rig'), {
      type: 'addSkeleton',
      skeleton: {
        id: 'rig',
        name: 'Rig',
        parentPartId: null,
        bones: [{ id: 'root', name: 'Root', parentId: null, rest: identityTransform() }],
      },
    });
    expect(refused(one, { type: 'removeBone', skeletonId: 'rig', id: 'root' })).toEqual([
      'last-bone',
    ]);
    expect(
      refused(emptyCharacter('Rig'), {
        type: 'addSkeleton',
        skeleton: { id: 'rig', name: 'Rig', parentPartId: null, bones: [] },
      }),
    ).toEqual(['empty-skeleton']);
    const fig = blockyFigure().doc;
    expect(refused(fig, { type: 'removeBone', skeletonId: 'rig', id: 'forearm.L' })).toEqual([
      'bone-in-use',
    ]);
    expect(refused(fig, { type: 'removeSkeleton', id: 'rig' })).toEqual(['skeleton-in-use']);
    expect(
      refused(fig, {
        type: 'addBone',
        skeletonId: 'rig',
        bone: { id: 'tail', name: 'Tail', parentId: 'nope', rest: identityTransform() },
      }),
    ).toContain('parent');
  });
  it('keeps a bound mesh where it rests when its bones move or re-parent', () => {
    const f = blockyFigure();
    const mesh = f.meshes.get('mesh-body')!;
    const restShape = (d: CharacterDocument) =>
      skinnedPositions(
        mesh,
        skinMatrices(d.skins[0]!, mesh, worldMatrices(d, poseAt(d, null, 0)).bones),
      );
    const before = restShape(f.doc);
    let d = applyCharacterOperation(f.doc, {
      type: 'setBoneRest',
      skeletonId: 'rig',
      id: 'arm.L',
      rest: {
        ...identityTransform(),
        translation: [250, 0, 300],
        rotation: [0, 0.3826834, 0, 0.9238795],
      },
    });
    d = applyCharacterOperation(d, {
      type: 'setBoneParent',
      skeletonId: 'rig',
      id: 'forearm.L',
      parentId: 'hip',
    });
    const after = restShape(d);
    expect(Math.max(...after.map((x, i) => Math.abs(x - before[i]!)))).toBeLessThan(1e-3);
    // Posing still moves it: the forearm now follows the hip.
    expect(d.skeletons[0]!.bones.find((b) => b.id === 'forearm.L')!.parentId).toBe('hip');
  });
  it('removes a skeleton with the tracks that key its bones', () => {
    let d = start();
    d.actions.push({
      id: 'act',
      name: 'Act',
      frameRate: { numerator: 30, denominator: 1 },
      duration: 9600,
      tracks: [
        {
          id: 'trk',
          target: { kind: 'bone', id: 'head', property: 'rotation' },
          keys: [{ id: 'k0', tick: 0, value: [0, 0, 0, 1], easing: { type: 'linear' } }],
        },
      ],
    });
    d = applyCharacterOperation(d, { type: 'removeSkeleton', id: 'rig' });
    expect(d.skeletons).toEqual([]);
    expect(d.actions[0]!.tracks).toEqual([]);
    expect(characterIds(d).has('head')).toBe(true);
  });
});
