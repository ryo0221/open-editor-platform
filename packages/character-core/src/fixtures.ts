import { boxMesh, encodeEpm, epmSha256, type EpmMesh } from '@editor-platform/geometry-mesh';
import { axisAngleQuat, composeMat4, invertMat4 } from './math';
import {
  characterAssetMediaTypes,
  emptyCharacter,
  identityTransform,
  type CharacterBone,
  type CharacterDocument,
  type Vec3,
} from './model';

/** A fixture document and the bytes of its assets, by asset ID. */
export interface CharacterFixture {
  doc: CharacterDocument;
  assets: Map<string, Uint8Array>;
  meshes: Map<string, EpmMesh>;
}

/** Bone joint positions (character space, mm) and parents of the blocky figure. */
const joints: [string, string | null, Vec3][] = [
  ['hip', null, [0, 0, 950]],
  ['spine', 'hip', [0, 0, 1150]],
  ['head', 'spine', [0, 0, 1450]],
  ['arm.L', 'spine', [200, 0, 1400]],
  ['forearm.L', 'arm.L', [480, 0, 1400]],
  ['arm.R', 'spine', [-200, 0, 1400]],
  ['forearm.R', 'arm.R', [-480, 0, 1400]],
  ['thigh.L', 'hip', [100, 0, 900]],
  ['shin.L', 'thigh.L', [100, 0, 480]],
  ['thigh.R', 'hip', [-100, 0, 900]],
  ['shin.R', 'thigh.R', [-100, 0, 480]],
];
/** Boxes: bone, size, centre, material slot. */
const boxes: [string, Vec3, Vec3, number][] = [
  ['hip', [300, 180, 150], [0, 0, 950], 0],
  ['spine', [360, 200, 450], [0, 0, 1200], 0],
  ['head', [200, 220, 240], [0, 0, 1570], 1],
  ['arm.L', [280, 90, 90], [340, 0, 1400], 0],
  ['forearm.L', [260, 80, 80], [610, 0, 1400], 0],
  ['arm.R', [280, 90, 90], [-340, 0, 1400], 0],
  ['forearm.R', [260, 80, 80], [-610, 0, 1400], 0],
  ['thigh.L', [130, 130, 420], [100, 0, 690], 0],
  ['shin.L', [110, 110, 420], [100, 0, 270], 0],
  ['thigh.R', [130, 130, 420], [-100, 0, 690], 0],
  ['shin.R', [110, 110, 420], [-100, 0, 270], 0],
];

/** One mesh of boxes, each vertex weighted fully to its box's bone. */
function figureMesh(): EpmMesh {
  const boneIds = joints.map(([id]) => id);
  const pos: number[] = [],
    sizes: number[] = [],
    idx: number[] = [],
    mats: number[] = [],
    bones: number[] = [],
    chest: number[] = [];
  for (const [bone, size, center, slot] of boxes) {
    const b = boxMesh(size, center);
    const base = pos.length / 3;
    pos.push(...b.positions);
    sizes.push(...b.faceSizes);
    idx.push(...[...b.faceIndices].map((i) => i + base));
    mats.push(...[...b.faceMaterials].map(() => slot));
    for (let i = 0; i < 8; i++) {
      bones.push(boneIds.indexOf(bone));
      chest.push(bone === 'spine' ? 0.2 * b.positions[3 * i] : 0, 0, 0);
    }
  }
  const v = pos.length / 3;
  return {
    positions: new Float32Array(pos),
    faceSizes: new Uint32Array(sizes),
    faceIndices: new Uint32Array(idx),
    faceMaterials: new Uint16Array(mats),
    weights: {
      offsets: new Uint32Array(Array.from({ length: v + 1 }, (_, i) => i)),
      bones: new Uint16Array(bones),
      values: new Float32Array(v).fill(1),
    },
    boneIds,
    morphs: [{ id: 'chest-wide', deltas: new Float32Array(chest) }],
  };
}

/**
 * F-C1: a blocky figure (11 boxes, 88 vertices), one skeleton of 11 bones, two materials, one
 * morph and two actions (`wave`: the right arm up and down with the chest morph; `walk`: the legs
 * swing). Generated, so no outside model is committed.
 */
export function blockyFigure(): CharacterFixture {
  const mesh = figureMesh();
  const bytes = encodeEpm(mesh);
  const doc = emptyCharacter('Blocky figure');
  doc.assets.push({
    id: 'mesh-body',
    kind: 'mesh-epm',
    sha256: epmSha256(bytes),
    byteLength: bytes.length,
    mediaType: characterAssetMediaTypes['mesh-epm'],
  });
  const mat = (id: string, name: string, color: string) => ({
    id,
    name,
    color,
    opacity: 1,
    roughness: 0.6,
    metalness: 0,
    maps: {},
    doubleSided: false,
  });
  doc.materials.push(mat('mat-body', 'Body', '#4a7bd0'), mat('mat-face', 'Face', '#f0c8a0'));
  doc.parts.push({
    id: 'body',
    name: 'Body',
    parentId: null,
    transform: identityTransform(),
    mesh: 'mesh-body',
    materials: ['mat-body', 'mat-face'],
    visible: true,
  });
  const world = new Map(joints.map(([id, , p]) => [id, p]));
  const bones: CharacterBone[] = joints.map(([id, parent, p]) => {
    const at = parent ? world.get(parent)! : ([0, 0, 0] as Vec3);
    return {
      id,
      name: id,
      parentId: parent,
      rest: { ...identityTransform(), translation: [p[0] - at[0], p[1] - at[1], p[2] - at[2]] },
    };
  });
  doc.skeletons.push({ id: 'rig', name: 'Rig', parentPartId: null, bones });
  doc.skins.push({
    id: 'skin-body',
    partId: 'body',
    skeletonId: 'rig',
    inverseBind: joints.map(([id, , p]) => ({
      boneId: id,
      matrix: invertMat4(composeMat4({ ...identityTransform(), translation: p }))!,
    })),
  });
  doc.morphs.push({ id: 'chest-wide', partId: 'body', name: 'Chest wide', weight: 0 });
  const linear = { type: 'linear' as const };
  const up = axisAngleQuat([0, 1, 0], 1.2);
  doc.actions.push(
    {
      id: 'wave',
      name: 'Wave',
      duration: 240000,
      frameRate: { numerator: 30, denominator: 1 },
      tracks: [
        {
          id: 'wave-arm',
          target: { kind: 'bone', id: 'arm.R', property: 'rotation' },
          keys: [
            { id: 'wave-arm-0', tick: 0, value: [0, 0, 0, 1], easing: linear },
            { id: 'wave-arm-1', tick: 120000, value: up, easing: linear },
            { id: 'wave-arm-2', tick: 240000, value: [0, 0, 0, 1], easing: linear },
          ],
        },
        {
          id: 'wave-chest',
          target: { kind: 'morph', id: 'chest-wide', property: 'weight' },
          keys: [
            { id: 'wave-chest-0', tick: 0, value: 0, easing: linear },
            { id: 'wave-chest-1', tick: 120000, value: 1, easing: linear },
            { id: 'wave-chest-2', tick: 240000, value: 0, easing: { type: 'hold' } },
          ],
        },
      ],
    },
    {
      id: 'walk',
      name: 'Walk',
      duration: 240000,
      frameRate: { numerator: 30, denominator: 1 },
      tracks: (['L', 'R'] as const).map((side, i) => {
        const swing = (a: number) => axisAngleQuat([1, 0, 0], (i ? -a : a) * 0.5);
        return {
          id: `walk-thigh-${side}`,
          target: { kind: 'bone' as const, id: `thigh.${side}`, property: 'rotation' as const },
          keys: [
            { id: `walk-${side}-0`, tick: 0, value: swing(1), easing: linear },
            { id: `walk-${side}-1`, tick: 120000, value: swing(-1), easing: linear },
            { id: `walk-${side}-2`, tick: 240000, value: swing(1), easing: linear },
          ],
        };
      }),
    },
  );
  return { doc, assets: new Map([['mesh-body', bytes]]), meshes: new Map([['mesh-body', mesh]]) };
}

/**
 * C6d (CH60): the blocky figure with a hat, an unskinned part under the body with a morph of its
 * own. Wave also moves the hat and keys its morph, so a round trip carries part tracks, two
 * parts' morphs and a skinned part together.
 */
export function hattedFigure(): CharacterFixture {
  const f = blockyFigure();
  const hat = boxMesh([160, 160, 80]);
  // Grow lifts the top four corners by 60 mm.
  const deltas = new Float32Array(hat.positions.length);
  for (let v = 0; v < hat.positions.length / 3; v++)
    if (hat.positions[3 * v + 2] > 0) deltas[3 * v + 2] = 60;
  hat.morphs = [{ id: 'hat-grow', deltas }];
  const bytes = encodeEpm(hat);
  const doc = f.doc;
  doc.assets.push({
    id: 'mesh-hat',
    kind: 'mesh-epm',
    sha256: epmSha256(bytes),
    byteLength: bytes.length,
    mediaType: characterAssetMediaTypes['mesh-epm'],
  });
  doc.parts.push({
    id: 'hat',
    name: 'Hat',
    parentId: 'body',
    transform: { ...identityTransform(), translation: [0, 0, 1740] },
    mesh: 'mesh-hat',
    materials: ['mat-face'],
    visible: true,
  });
  doc.morphs.push({ id: 'hat-grow', partId: 'hat', name: 'Grow', weight: 0.25 });
  const linear = { type: 'linear' as const };
  doc.actions[0].tracks.push(
    {
      id: 'wave-hat',
      target: { kind: 'part', id: 'hat', property: 'translation' },
      keys: [
        { id: 'wave-hat-0', tick: 0, value: [0, 0, 1740], easing: linear },
        { id: 'wave-hat-1', tick: 160000, value: [40, 0, 1780], easing: linear },
      ],
    },
    {
      id: 'wave-grow',
      target: { kind: 'morph', id: 'hat-grow', property: 'weight' },
      keys: [
        { id: 'wave-grow-0', tick: 60000, value: 0, easing: linear },
        { id: 'wave-grow-1', tick: 240000, value: 1, easing: linear },
      ],
    },
  );
  f.assets.set('mesh-hat', bytes);
  f.meshes.set('mesh-hat', hat);
  return f;
}
