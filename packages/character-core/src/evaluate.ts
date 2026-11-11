import { easingProgress } from '@editor-platform/animation-core';
import type { EpmMesh } from '@editor-platform/geometry-mesh';
import { composeMat4, identityMat4, multiplyMat4, slerpQuat, type Mat4 } from './math';
import { ikChainBones, solveIk } from './ik';
import type {
  CharacterAction,
  CharacterDocument,
  CharacterJointValueKey,
  CharacterKey,
  CharacterSkin,
  Quat,
  Transform3,
  Vec3,
} from './model';

/** Local transforms and morph weights at one tick; camera, selection and playhead are not here. */
export interface CharacterPose {
  parts: Map<string, Transform3>;
  bones: Map<string, Transform3>;
  morphs: Map<string, number>;
  /**
   * Keyed joint values of props, by prop ID then joint ID (C2b). A joint without a track is
   * absent: it keeps the value its version saved.
   */
  joints: Map<string, Map<string, Partial<Record<CharacterJointValueKey, number>>>>;
  /** MR4: each prop's placement: its own, or its keyed one. */
  props: Map<string, { translation: Vec3; rotation: Quat }>;
  /**
   * MR7: the keyed joint in effect of props' mounts, by prop ID then mount ID. A mount absent,
   * or before its first key, keeps the version's own choice.
   */
  mounts: Map<string, Map<string, string>>;
}

/** The rest pose, then every track of `action` sampled at `tick` (clamped to the action). */
export function poseAt(
  doc: CharacterDocument,
  action: CharacterAction | null,
  tick: number,
): CharacterPose {
  const pose: CharacterPose = {
    parts: new Map(doc.parts.map((p) => [p.id, clone(p.transform)])),
    bones: new Map(
      doc.skeletons.flatMap((s) => s.bones.map((b) => [b.id, clone(b.rest)] as const)),
    ),
    morphs: new Map(doc.morphs.map((m) => [m.id, m.weight])),
    joints: new Map(),
    mounts: new Map(),
    props: new Map(
      doc.props.map((p) => [
        p.id,
        { translation: [...p.placement.translation], rotation: [...p.placement.rotation] },
      ]),
    ),
  };
  if (!action) return pose;
  const t = Math.min(Math.max(tick, 0), action.duration);
  for (const track of action.tracks) {
    const { target } = track;
    if (target.kind === 'morph') {
      pose.morphs.set(target.id, sampleNumber(track.keys, t));
      continue;
    }
    if (target.kind === 'prop-joint') {
      let joints = pose.joints.get(target.id);
      if (!joints) pose.joints.set(target.id, (joints = new Map()));
      const values = joints.get(target.joint) ?? {};
      values[target.property] = sampleNumber(track.keys, t);
      joints.set(target.joint, values);
      continue;
    }
    if (target.kind === 'prop-mount') {
      const joint = sampleHeld(track.keys, t);
      if (joint === undefined) continue;
      let mounts = pose.mounts.get(target.id);
      if (!mounts) pose.mounts.set(target.id, (mounts = new Map()));
      mounts.set(target.mount, joint);
      continue;
    }
    if (target.kind === 'prop') {
      const placement = pose.props.get(target.id);
      if (!placement) continue;
      if (target.property === 'rotation') placement.rotation = sampleQuat(track.keys, t);
      else placement.translation = sampleVec3(track.keys, t);
      continue;
    }
    const map = target.kind === 'part' ? pose.parts : pose.bones;
    const local = map.get(target.id);
    if (!local) continue;
    if (target.property === 'rotation') local.rotation = sampleQuat(track.keys, t);
    else local[target.property] = sampleVec3(track.keys, t);
  }
  return pose;
}
const clone = (t: Transform3): Transform3 => ({
  translation: [...t.translation],
  rotation: [...t.rotation],
  scale: [...t.scale],
});

/** The segment `tick` falls in and its eased progress. Keys are validated: sorted, nonempty. */
function segment(
  keys: readonly CharacterKey[],
  tick: number,
): [CharacterKey, CharacterKey, number] {
  if (tick <= keys[0].tick) return [keys[0], keys[0], 0];
  for (let i = 1; i < keys.length; i++) {
    const right = keys[i],
      left = keys[i - 1];
    if (tick === right.tick) return [right, right, 0];
    if (tick < right.tick)
      return [
        left,
        right,
        easingProgress(left.easing, (tick - left.tick) / (right.tick - left.tick)),
      ];
  }
  const last = keys[keys.length - 1];
  return [last, last, 0];
}
/** MR7: the value of the last key at or before `tick` (a mount's joint), none before the first. */
export function sampleHeld(keys: readonly CharacterKey[], tick: number): string | undefined {
  let held: string | undefined;
  for (const k of keys) {
    if (k.tick > tick) break;
    held = k.value as string;
  }
  return held;
}
export function sampleNumber(keys: readonly CharacterKey[], tick: number): number {
  const [a, b, t] = segment(keys, tick);
  return (a.value as number) + ((b.value as number) - (a.value as number)) * t;
}
export function sampleVec3(keys: readonly CharacterKey[], tick: number): Vec3 {
  const [a, b, t] = segment(keys, tick);
  const va = a.value as Vec3,
    vb = b.value as Vec3;
  return [va[0] + (vb[0] - va[0]) * t, va[1] + (vb[1] - va[1]) * t, va[2] + (vb[2] - va[2]) * t];
}
export function sampleQuat(keys: readonly CharacterKey[], tick: number): Quat {
  const [a, b, t] = segment(keys, tick);
  return t === 0 ? [...(a.value as Quat)] : slerpQuat(a.value as Quat, b.value as Quat, t);
}

/**
 * World matrices (character space) of every part and bone under a pose, with the document's IK
 * chains solved after the keys (C5d) unless `ik` is false.
 */
export function worldMatrices(
  doc: CharacterDocument,
  pose: CharacterPose,
  options: { ik?: boolean } = {},
) {
  if (options.ik === false || !doc.skeletons.some((s) => s.ik?.some((c) => c.enabled)))
    return forwardMatrices(doc, pose);
  return forwardMatrices(doc, { ...pose, bones: solvedBones(doc, pose) });
}

/** The rest pose's world matrices, never solved: what binding and rig edits are measured from. */
export function restMatrices(doc: CharacterDocument) {
  return worldMatrices(doc, poseAt(doc, null, 0), { ik: false });
}

/** The pose's local IK solution: its bones' local transforms with the chains solved (C5d). */
export function solvedBones(doc: CharacterDocument, pose: CharacterPose): Map<string, Transform3> {
  const bones = new Map([...pose.bones].map(([id, t]) => [id, clone(t)]));
  solveIk(doc.skeletons, bones, (b) => forwardMatrices(doc, { ...pose, bones: b }).bones);
  return bones;
}

/**
 * C5d: the local rotations that turn one chain's bones so its tip reaches `target` (character
 * space mm) in this pose, after the document's enabled chains are solved; the chain need not be
 * enabled. What a drag of the tip keys. Undefined when the chain or its bones are not there.
 */
export function ikPoseRotations(
  doc: CharacterDocument,
  pose: CharacterPose,
  skeletonId: string,
  chainId: string,
  target: Vec3,
): Map<string, Quat> | undefined {
  const skeleton = doc.skeletons.find((s) => s.id === skeletonId);
  const chain = skeleton?.ik?.find((c) => c.id === chainId);
  const found = skeleton && chain && ikChainBones(skeleton, chain);
  if (!found) return undefined;
  const bones = solvedBones(doc, pose);
  const one = { ...skeleton, ik: [{ ...chain, target, enabled: true }] };
  solveIk([one], bones, (b) => forwardMatrices(doc, { ...pose, bones: b }).bones);
  return new Map(found.bones.map((b) => [b.id, bones.get(b.id)!.rotation]));
}

function forwardMatrices(doc: CharacterDocument, pose: CharacterPose) {
  const parts = new Map<string, Mat4>();
  const partOf = new Map(doc.parts.map((p) => [p.id, p]));
  const partWorld = (id: string): Mat4 => {
    const done = parts.get(id);
    if (done) return done;
    const p = partOf.get(id)!;
    const local = composeMat4(pose.parts.get(id) ?? p.transform);
    const m = p.parentId ? multiplyMat4(partWorld(p.parentId), local) : local;
    parts.set(id, m);
    return m;
  };
  doc.parts.forEach((p) => partWorld(p.id));
  const bones = new Map<string, Mat4>();
  for (const s of doc.skeletons) {
    const base = s.parentPartId ? parts.get(s.parentPartId)! : identityMat4();
    const of = new Map(s.bones.map((b) => [b.id, b]));
    const boneWorld = (id: string): Mat4 => {
      const done = bones.get(id);
      if (done) return done;
      const b = of.get(id)!;
      const local = composeMat4(pose.bones.get(id) ?? b.rest);
      const m = multiplyMat4(b.parentId ? boneWorld(b.parentId) : base, local);
      bones.set(id, m);
      return m;
    };
    s.bones.forEach((b) => boneWorld(b.id));
  }
  return { parts, bones };
}

/**
 * The joint matrices of a skin in the order of its mesh's `boneIds` (glTF's joint order):
 * world(bone) · inverseBind, so a vertex in character space at bind follows its bones.
 */
export function skinMatrices(
  skin: CharacterSkin,
  mesh: EpmMesh,
  bones: ReadonlyMap<string, Mat4>,
): Mat4[] {
  const inverse = new Map(skin.inverseBind.map((e) => [e.boneId, e.matrix]));
  return mesh.boneIds.map((id) => multiplyMat4(bones.get(id)!, inverse.get(id)!));
}

/** Linear blend skinning of every vertex with all its weights (character space, mm). */
export function skinnedPositions(mesh: EpmMesh, joints: readonly Mat4[]): Float32Array {
  const out = new Float32Array(mesh.positions.length);
  const w = mesh.weights;
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    const x = mesh.positions[3 * i],
      y = mesh.positions[3 * i + 1],
      z = mesh.positions[3 * i + 2];
    if (!w || w.offsets[i] === w.offsets[i + 1]) {
      out.set([x, y, z], 3 * i);
      continue;
    }
    let ox = 0,
      oy = 0,
      oz = 0;
    for (let k = w.offsets[i]; k < w.offsets[i + 1]; k++) {
      const m = joints[w.bones[k]],
        s = w.values[k];
      ox += s * (m[0] * x + m[4] * y + m[8] * z + m[12]);
      oy += s * (m[1] * x + m[5] * y + m[9] * z + m[13]);
      oz += s * (m[2] * x + m[6] * y + m[10] * z + m[14]);
    }
    out.set([ox, oy, oz], 3 * i);
  }
  return out;
}
