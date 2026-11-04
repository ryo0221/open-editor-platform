import {
  composeMat4,
  decomposeMat4,
  invertMat4,
  multiplyMat4,
  identityMat4,
  type Mat4,
} from './math';
import {
  CharacterValidationError,
  type CharacterBone,
  type CharacterDocument,
  type CharacterIkChain,
  type CharacterSkeleton,
  type Transform3,
} from './model';
import { ikChainBones } from './ik';

/** C5a: skeleton and bone authoring. Weights and binding come with automatic weights (C5b). */
export type CharacterRigOperation =
  /** Adds a skeleton with its bones (at least one). */
  | { type: 'addSkeleton'; skeleton: CharacterSkeleton }
  /** Removes a skeleton and the tracks that key its bones. Refused while a skin uses it. */
  | { type: 'removeSkeleton'; id: string }
  | { type: 'addBone'; skeletonId: string; bone: CharacterBone }
  /**
   * Removes a bone and the tracks that key it; its children hang from its parent and keep where
   * they rest. Refused while a skin weights the bone, and for a skeleton's last bone.
   */
  | { type: 'removeBone'; skeletonId: string; id: string }
  | { type: 'setBoneRest'; skeletonId: string; id: string; rest: Transform3 }
  /** Hangs a bone from another (or from the skeleton's root) and keeps where it rests. */
  | { type: 'setBoneParent'; skeletonId: string; id: string; parentId: string | null }
  /** C5d: IK chains. Adding or replacing one keeps its ID; removing one retires it. */
  | { type: 'addIkChain'; skeletonId: string; chain: CharacterIkChain }
  | { type: 'setIkChain'; skeletonId: string; chain: CharacterIkChain }
  | { type: 'removeIkChain'; skeletonId: string; id: string }
  /** C5d: how far IK may turn a bone (null: freely). */
  | {
      type: 'setBoneLimits';
      skeletonId: string;
      id: string;
      limits: CharacterBone['limits'] | null;
    };
export type CharacterRigOperationType = CharacterRigOperation['type'];
export const characterRigOperationTypes: readonly CharacterRigOperationType[] = Object.freeze([
  'addSkeleton',
  'removeSkeleton',
  'addBone',
  'removeBone',
  'setBoneRest',
  'setBoneParent',
  'addIkChain',
  'setIkChain',
  'removeIkChain',
  'setBoneLimits',
]);

const fail = (code: string, message = code): never => {
  throw new CharacterValidationError([{ code, path: '$', message }]);
};

/** A bone's rest matrix in its skeleton's space (the product of the rest poses down to it). */
export function boneRestMatrix(skeleton: CharacterSkeleton, id: string): Mat4 {
  const of = new Map(skeleton.bones.map((b) => [b.id, b]));
  let m = identityMat4();
  const seen = new Set<string>();
  for (let b = of.get(id); b; b = b.parentId ? of.get(b.parentId) : undefined) {
    if (seen.has(b.id)) fail('cycle', 'the bones form a cycle');
    seen.add(b.id);
    m = multiplyMat4(composeMat4(b.rest), m);
  }
  return m;
}

/** `rest` for a bone hung from `parent` so that it stays at `world` (skeleton space). */
function restUnder(skeleton: CharacterSkeleton, parentId: string | null, world: Mat4) {
  const parent = parentId ? invertMat4(boneRestMatrix(skeleton, parentId)) : identityMat4();
  if (!parent) return fail('degenerate', 'the parent bone has no inverse');
  const rest = decomposeMat4(multiplyMat4(parent, world));
  // Under a non-uniformly scaled, rotated parent the bone would shear: no rest pose keeps it.
  const back = rest && composeMat4(rest);
  if (!rest || !back || back.some((x, i) => Math.abs(x - multiplyMat4(parent, world)[i]!) > 1e-6))
    return fail('shear', 'the bone cannot keep its place under that parent');
  return rest;
}

/** Applies a rig operation to `next` (a copy); the caller validates the result. */
export function applyRigOperation(
  next: CharacterDocument,
  op: CharacterRigOperation,
  missing: () => never,
) {
  if (op.type === 'addSkeleton') {
    if (!op.skeleton.bones?.length) fail('empty-skeleton', 'a skeleton needs a bone');
    next.skeletons.push(structuredClone(op.skeleton));
    return;
  }
  const skeleton = next.skeletons.find(
    (s) => s.id === (op.type === 'removeSkeleton' ? op.id : op.skeletonId),
  );
  if (!skeleton) return missing();
  const dropTracks = (bones: Set<string>) => {
    for (const a of next.actions)
      a.tracks = a.tracks.filter((t) => !(t.target.kind === 'bone' && bones.has(t.target.id)));
  };
  if (op.type === 'removeSkeleton') {
    if (next.skins.some((k) => k.skeletonId === skeleton.id))
      fail('skeleton-in-use', 'a part is bound to this skeleton');
    next.skeletons = next.skeletons.filter((s) => s !== skeleton);
    dropTracks(new Set(skeleton.bones.map((b) => b.id)));
    return;
  }
  if (op.type === 'addBone') {
    skeleton.bones.push(structuredClone(op.bone));
    return;
  }
  if (op.type === 'addIkChain') {
    skeleton.ik = [...(skeleton.ik ?? []), structuredClone(op.chain)];
    return;
  }
  if (op.type === 'setIkChain' || op.type === 'removeIkChain') {
    const id = op.type === 'setIkChain' ? op.chain.id : op.id;
    const at = (skeleton.ik ?? []).findIndex((c) => c.id === id);
    if (at < 0) return missing();
    if (op.type === 'setIkChain') skeleton.ik![at] = structuredClone(op.chain);
    else skeleton.ik!.splice(at, 1);
    if (!skeleton.ik!.length) delete skeleton.ik;
    return;
  }
  const bone = skeleton.bones.find((b) => b.id === op.id);
  if (!bone) return missing();
  if (op.type === 'setBoneLimits') {
    if (op.limits) bone.limits = structuredClone(op.limits);
    else delete bone.limits;
    return;
  }
  // A bound mesh stays where it is at rest: where a bone's rest moves, its inverse bind moves
  // with it (inverse(new rest) · old rest · inverse bind), as when a rig is edited before posing.
  const before = new Map(skeleton.bones.map((b) => [b.id, boneRestMatrix(skeleton, b.id)]));
  editBone(next, skeleton, bone, op);
  for (const skin of next.skins) {
    if (skin.skeletonId !== skeleton.id) continue;
    for (const e of skin.inverseBind) {
      const was = before.get(e.boneId);
      if (!was || !skeleton.bones.some((b) => b.id === e.boneId)) continue;
      const now = boneRestMatrix(skeleton, e.boneId);
      if (now.every((x, i) => x === was[i])) continue;
      const inv = invertMat4(now);
      if (!inv) fail('degenerate', 'a bone has no inverse');
      e.matrix = multiplyMat4(multiplyMat4(inv!, was), e.matrix);
    }
  }
}

function editBone(
  next: CharacterDocument,
  skeleton: CharacterSkeleton,
  bone: CharacterBone,
  op: Extract<CharacterRigOperation, { type: 'setBoneRest' | 'setBoneParent' | 'removeBone' }>,
) {
  const dropTracks = (bones: Set<string>) => {
    for (const a of next.actions)
      a.tracks = a.tracks.filter((t) => !(t.target.kind === 'bone' && bones.has(t.target.id)));
  };
  if (op.type === 'setBoneRest') {
    bone.rest = structuredClone(op.rest);
    return;
  }
  if (op.type === 'setBoneParent') {
    if (op.parentId === bone.parentId) return;
    if (op.parentId !== null) {
      if (!skeleton.bones.some((b) => b.id === op.parentId))
        fail('parent', 'the parent is not a bone of this skeleton');
      // A bone cannot hang from itself or from a bone below it.
      for (let p: string | null = op.parentId; p; ) {
        if (p === bone.id) fail('cycle', 'the bone would hang from itself');
        p = skeleton.bones.find((b) => b.id === p)?.parentId ?? null;
      }
    }
    bone.rest = restUnder(skeleton, op.parentId, boneRestMatrix(skeleton, bone.id));
    bone.parentId = op.parentId;
    return;
  }
  // removeBone
  if (skeleton.bones.length === 1) fail('last-bone', 'remove the skeleton instead');
  if (next.skins.some((k) => k.inverseBind.some((e) => e.boneId === bone.id)))
    fail('bone-in-use', 'a skin weights this bone');
  if (
    (skeleton.ik ?? []).some(
      (c) =>
        ikChainBones(skeleton, c)?.tip.id === bone.id ||
        ikChainBones(skeleton, c)?.bones.includes(bone),
    )
  )
    fail('ik-in-use', 'an IK chain uses this bone');
  for (const child of skeleton.bones.filter((b) => b.parentId === bone.id)) {
    child.rest = restUnder(skeleton, bone.parentId, boneRestMatrix(skeleton, child.id));
    child.parentId = bone.parentId;
  }
  skeleton.bones = skeleton.bones.filter((b) => b !== bone);
  dropTracks(new Set([bone.id]));
}
