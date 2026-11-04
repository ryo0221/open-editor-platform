import {
  boneHeatWeights,
  decodeEpm,
  paintWeights,
  type EpmMesh,
} from '@editor-platform/geometry-mesh';
import { describe, expect, it } from 'vitest';
import {
  applyCharacterOperation,
  axisAngleQuat,
  characterCubePart,
  characterBindMesh,
  characterSkinBind,
  characterSkinUnbind,
  characterSkinWeights,
  characterWeightBones,
  checkCharacterMeshes,
  emptyCharacter,
  identityMat4,
  invertMat4,
  multiplyMat4,
  identityTransform,
  poseAt,
  skinMatrices,
  skinnedPositions,
  worldMatrices,
  type CharacterDocument,
} from './index';

/** A part: a 200 × 200 × 1000 mm column from z = 0, cut into rings; a two-bone skeleton. */
function column() {
  let d = emptyCharacter('Column');
  const cube = characterCubePart(d);
  d = applyCharacterOperation(d, cube.op);
  const part = d.parts[0]!.id;
  // Eleven square rings 100 mm apart, capped.
  const pos: number[] = [];
  const corners = [
    [-100, -100],
    [100, -100],
    [100, 100],
    [-100, 100],
  ];
  for (let r = 0; r <= 10; r++) for (const [x, y] of corners) pos.push(x!, y!, 100 * r);
  const faces: number[] = [];
  for (let r = 0; r < 10; r++)
    for (let k = 0; k < 4; k++) {
      const a = 4 * r + k,
        b = 4 * r + ((k + 1) % 4);
      faces.push(a, b, b + 4, a + 4);
    }
  faces.push(3, 2, 1, 0, 40, 41, 42, 43);
  const mesh: EpmMesh = {
    positions: Float32Array.from(pos),
    faceSizes: new Uint32Array(42).fill(4),
    faceIndices: Uint32Array.from(faces),
    faceMaterials: new Uint16Array(42),
    boneIds: [],
    morphs: [],
  };
  d = applyCharacterOperation(d, {
    type: 'addSkeleton',
    skeleton: {
      id: 'rig',
      name: 'Rig',
      parentPartId: null,
      bones: [
        { id: 'lower', name: 'Lower', parentId: null, rest: identityTransform() },
        {
          id: 'upper',
          name: 'Upper',
          parentId: 'lower',
          rest: { ...identityTransform(), translation: [0, 0, 500] },
        },
      ],
    },
  });
  return { d, part, mesh };
}
/** 1 when face f's normal (Newell) points away from the column's axis along y. */
const outward = (m: EpmMesh, f: number) => {
  const p = m.positions;
  const idx = m.faceIndices.slice(4 * f, 4 * f + 4);
  const c = [0, 1, 2].map((k) => idx.reduce((s, v) => s + p[3 * v + k]!, 0) / 4);
  let ny = 0;
  for (let k = 0; k < 4; k++) {
    const a = idx[k]! * 3,
      b = idx[(k + 1) % 4]! * 3;
    ny += (p[a + 2]! - p[b + 2]!) * (p[a]! + p[b]!);
  }
  return Math.sign(ny) * Math.sign(c[1]!);
};
const shape = (d: CharacterDocument, mesh: EpmMesh, tick = 0) => {
  const pose = poseAt(d, d.actions[0] ?? null, tick);
  return skinnedPositions(mesh, skinMatrices(d.skins[0]!, mesh, worldMatrices(d, pose).bones));
};

describe('C5b binding with automatic weights (TS-1249)', () => {
  it('binds a part: weights over the bones, the mesh stays at rest, posing bends it', () => {
    const { d, part, mesh } = column();
    const { bones, boneIds } = characterWeightBones(d, part, 'rig');
    // The upper bone (a leaf) continues half its parent's length: 500 → 750.
    expect(bones[1]).toEqual({ head: [0, 0, 500], tail: [0, 0, 750] });
    const bind = characterSkinBind(d, part, 'rig', boneHeatWeights(mesh, bones, boneIds));
    const bound = applyCharacterOperation(d, bind.op);
    const meshes = new Map([[bind.ref.id, decodeEpm(bind.bytes)]]);
    expect(checkCharacterMeshes(bound, meshes)).toEqual([]);
    const weighted = meshes.get(bind.ref.id)!;
    const rest = shape(bound, weighted);
    expect(Math.max(...rest.map((x, i) => Math.abs(x - weighted.positions[i]!)))).toBeLessThan(
      1e-3,
    );
    // Bending the upper bone 90° about x moves the top; the bottom keeps nearly all of its
    // weight on the lower bone (heat leaks a little, as in bone heat).
    bound.actions.push({
      id: 'bend',
      name: 'Bend',
      frameRate: { numerator: 30, denominator: 1 },
      duration: 9600,
      tracks: [
        {
          id: 'bend-upper',
          target: { kind: 'bone', id: 'upper', property: 'rotation' },
          keys: [
            {
              id: 'k',
              tick: 0,
              value: axisAngleQuat([1, 0, 0], Math.PI / 2),
              easing: { type: 'linear' },
            },
          ],
        },
      ],
    });
    const bent = shape(bound, weighted);
    const n = weighted.positions.length / 3;
    for (let v = 0; v < n; v++) {
      const z = weighted.positions[3 * v + 2]!;
      const moved = Math.hypot(...[0, 1, 2].map((k) => bent[3 * v + k]! - rest[3 * v + k]!));
      if (z === 0) expect(moved).toBeLessThan(30);
      if (z === 1000) expect(moved).toBeGreaterThan(300);
    }
  });
  it('refuses binding a bound part, and unbinds back to a mesh without weights', () => {
    const { d, part, mesh } = column();
    const { bones, boneIds } = characterWeightBones(d, part, 'rig');
    const bind = characterSkinBind(d, part, 'rig', boneHeatWeights(mesh, bones, boneIds));
    const bound = applyCharacterOperation(d, bind.op);
    expect(() => applyCharacterOperation(bound, bind.op)).toThrow(/part-skinned/);
    // A bound bone cannot be removed while the skin weights it.
    expect(() =>
      applyCharacterOperation(bound, { type: 'removeBone', skeletonId: 'rig', id: 'upper' }),
    ).toThrow(/bone-in-use/);
    const un = characterSkinUnbind(bound, bound.skins[0]!.id, decodeEpm(bind.bytes));
    const free = applyCharacterOperation(bound, un.op);
    expect(free.skins).toEqual([]);
    const plain = decodeEpm(un.bytes);
    expect(plain.weights).toBeUndefined();
    expect(checkCharacterMeshes(free, new Map([[un.ref.id, plain]]))).toEqual([]);
  });
  it('paints a new bone in: its inverse bind keeps the rest shape; painted out, it can go (C5c, TS-1252)', () => {
    const { d, part, mesh } = column();
    const { bones, boneIds } = characterWeightBones(d, part, 'rig');
    const bind = characterSkinBind(d, part, 'rig', boneHeatWeights(mesh, bones, boneIds));
    let doc = applyCharacterOperation(d, bind.op);
    doc = applyCharacterOperation(doc, {
      type: 'addBone',
      skeletonId: 'rig',
      bone: {
        id: 'tip',
        name: 'Tip',
        parentId: 'upper',
        rest: { ...identityTransform(), translation: [0, 0, 400] },
      },
    });
    const weighted = decodeEpm(bind.bytes);
    const top = [...Array(weighted.positions.length / 3).keys()].filter(
      (v) => weighted.positions[3 * v + 2] === 1000,
    );
    const painted = paintWeights(weighted, 'tip', new Map(top.map((v) => [v, 0.5])), 'add');
    const paint = characterSkinWeights(doc, doc.skins[0]!.id, painted);
    const after = applyCharacterOperation(doc, paint.op);
    const meshes = new Map([[paint.ref.id, decodeEpm(paint.bytes)]]);
    expect(checkCharacterMeshes(after, meshes)).toEqual([]);
    expect(after.skins[0]!.inverseBind.map((e) => e.boneId)).toEqual(['lower', 'upper', 'tip']);
    const rest = shape(after, meshes.get(paint.ref.id)!);
    expect(Math.max(...rest.map((x, i) => Math.abs(x - weighted.positions[i]!)))).toBeLessThan(
      1e-3,
    );
    // Painted out again, the tip leaves the skin and can be removed.
    const out = paintWeights(painted, 'tip', new Map(top.map((v) => [v, 1])), 'subtract');
    const clear = characterSkinWeights(after, after.skins[0]!.id, out);
    const cleared = applyCharacterOperation(after, clear.op);
    expect(cleared.skins[0]!.inverseBind.map((e) => e.boneId)).toEqual(['lower', 'upper']);
    expect(() =>
      applyCharacterOperation(cleared, { type: 'removeBone', skeletonId: 'rig', id: 'tip' }),
    ).not.toThrow();
    // A bone of another skeleton is not painted into this skin.
    expect(() =>
      characterSkinWeights(
        after,
        after.skins[0]!.id,
        paintWeights(painted, 'nope', new Map([[0, 1]]), 'add'),
      ),
    ).toThrow('character-skin-bone');
  });
  it('binds a moved part in character space and unbinds it back to its own', () => {
    const { d, part, mesh } = column();
    const moved = structuredClone(d);
    moved.parts[0]!.transform.translation = [300, 0, 0];
    const baked = characterBindMesh(moved, part, mesh);
    expect(baked.positions[0]).toBeCloseTo(mesh.positions[0]! + 300, 4);
    const { bones, boneIds } = characterWeightBones(moved, part, 'rig');
    const bind = characterSkinBind(moved, part, 'rig', boneHeatWeights(baked, bones, boneIds));
    const bound = applyCharacterOperation(moved, bind.op);
    const weighted = decodeEpm(bind.bytes);
    // At rest the bound part is where it was, 300 mm along x.
    const rest = shape(bound, weighted);
    expect(Math.max(...rest.map((x, i) => Math.abs(x - baked.positions[i]!)))).toBeLessThan(1e-3);
    const un = characterSkinUnbind(bound, bound.skins[0]!.id, weighted);
    const plain = decodeEpm(un.bytes);
    expect(
      Math.max(...plain.positions.map((x, i) => Math.abs(x - mesh.positions[i]!))),
    ).toBeLessThan(1e-3);
  });
  it('unbinds an imported skin where it shows at rest, not from its raw positions', () => {
    const { d, part, mesh } = column();
    // As a glTF import may leave it: one joint 100 mm along x, identity inverse bind.
    const doc = structuredClone(d);
    doc.skeletons[0]!.bones[0]!.rest.translation = [100, 0, 0];
    const n = mesh.positions.length / 3;
    const weighted: EpmMesh = {
      ...mesh,
      boneIds: ['lower'],
      weights: {
        offsets: Uint32Array.from({ length: n + 1 }, (_, k) => k),
        bones: new Uint16Array(n),
        values: new Float32Array(n).fill(1),
      },
    };
    const bound = applyCharacterOperation(doc, {
      type: 'bindSkin',
      skin: {
        id: 'imported',
        partId: part,
        skeletonId: 'rig',
        inverseBind: [{ boneId: 'lower', matrix: identityMat4() }],
      },
      asset: characterSkinBind(doc, part, 'rig', weighted).ref,
    });
    const shown = shape(bound, weighted);
    const un = characterSkinUnbind(bound, 'imported', weighted);
    const plain = decodeEpm(un.bytes);
    expect(Math.max(...plain.positions.map((x, i) => Math.abs(x - shown[i]!)))).toBeLessThan(1e-3);
    expect(plain.positions[0]).toBeCloseTo(mesh.positions[0]! + 100, 3);
  });
  it('keeps the faces facing out when it unbinds a skin that reflects at rest', () => {
    const { d, part, mesh } = column();
    const n = mesh.positions.length / 3;
    const weighted: EpmMesh = {
      ...mesh,
      boneIds: ['lower'],
      weights: {
        offsets: Uint32Array.from({ length: n + 1 }, (_, k) => k),
        bones: new Uint16Array(n),
        values: new Float32Array(n).fill(1),
      },
    };
    const mirror = identityMat4();
    mirror[0] = -1;
    const bound = applyCharacterOperation(d, {
      type: 'bindSkin',
      skin: {
        id: 'imported',
        partId: part,
        skeletonId: 'rig',
        inverseBind: [{ boneId: 'lower', matrix: mirror }],
      },
      asset: characterSkinBind(d, part, 'rig', weighted).ref,
    });
    const plain = decodeEpm(characterSkinUnbind(bound, 'imported', weighted).bytes);
    expect(plain.positions[3]).toBeCloseTo(-mesh.positions[3]!, 3);
    expect(outward(mesh, 0)).toBe(1);
    expect(outward(plain, 0)).toBe(1);
  });
  it('turns a face only when most of its corners are reflected, as the view does', () => {
    const { d, part, mesh } = column();
    // Face 0's corners 0, 1 and 4 follow a mirrored bone; corner 5 a bone scaled 100×.
    const n = mesh.positions.length / 3;
    const big = new Set([5]);
    const weighted: EpmMesh = {
      ...mesh,
      boneIds: ['lower', 'upper'],
      weights: {
        offsets: Uint32Array.from({ length: n + 1 }, (_, k) => k),
        bones: Uint16Array.from({ length: n }, (_, v) => (big.has(v) ? 1 : 0)),
        values: new Float32Array(n).fill(1),
      },
    };
    const mirror = identityMat4();
    mirror[0] = -1;
    const grow = identityMat4();
    grow[0] = grow[5] = grow[10] = 100;
    const upperRest = invertMat4(worldMatrices(d, poseAt(d, null, 0)).bones.get('upper')!)!;
    const bound = applyCharacterOperation(d, {
      type: 'bindSkin',
      skin: {
        id: 'imported',
        partId: part,
        skeletonId: 'rig',
        inverseBind: [
          { boneId: 'lower', matrix: mirror },
          { boneId: 'upper', matrix: multiplyMat4(grow, upperRest) },
        ],
      },
      asset: characterSkinBind(d, part, 'rig', weighted).ref,
    });
    const plain = decodeEpm(characterSkinUnbind(bound, 'imported', weighted).bytes);
    // Three of face 0's four corners are reflected (the fourth's huge scale does not outvote
    // them): it turns, its first corner staying first.
    const face0 = [...mesh.faceIndices.slice(0, 4)];
    expect([...plain.faceIndices.slice(0, 4)]).toEqual([face0[0], ...face0.slice(1).reverse()]);
    // Face 20 (rings 5–6) is all mirrored and turns.
    const face20 = [...mesh.faceIndices.slice(80, 84)];
    expect([...plain.faceIndices.slice(80, 84)]).toEqual([face20[0], ...face20.slice(1).reverse()]);
  });
  it('keeps the faces facing out when it bakes a reflected part', () => {
    const { d, part, mesh } = column();
    const flipped = structuredClone(d);
    flipped.parts[0]!.transform.scale = [-1, 1, 1];
    const baked = characterBindMesh(flipped, part, mesh);
    // Face 0's normal (Newell) points away from the column's axis, as it did unreflected.
    // Face 0 is the side at y = −100: its normal points to −y, away from the axis.
    expect(outward(mesh, 0)).toBe(1);
    expect(outward(baked, 0)).toBe(1);
    // And back again on unbind.
    expect(outward(characterBindMesh(flipped, part, baked, true), 0)).toBe(1);
  });
});
