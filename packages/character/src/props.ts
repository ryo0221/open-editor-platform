import {
  composeMat4,
  multiplyMat4,
  type CharacterDocument,
  type CharacterJointValueKey,
  type CharacterPose,
  type Mat4,
} from '@editor-platform/character-core';

/** A triangle mesh of a prop, in its version's coordinates (mm, Z-up), drawn as it is. */
export interface CharacterPropMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  color: string;
  opacity: number;
}
/** One drawn copy of a mesh: where it lies in the prop's own space (column-major 4×4). */
export interface CharacterPropInstance {
  mesh: CharacterPropMesh;
  matrix: Mat4;
}
/** One value a joint can be keyed by, with its bounds and the value its version saved. */
export interface CharacterPropJointValue {
  key: CharacterJointValueKey;
  /** Radians for `angle`, millimetres otherwise, as the joint keys store them. */
  saved: number;
  min?: number;
  max?: number;
}
export interface CharacterPropJoint {
  id: string;
  name: string;
  values: CharacterPropJointValue[];
}
export type CharacterJointValues = ReadonlyMap<
  string,
  Partial<Record<CharacterJointValueKey, number>>
>;
/**
 * What the Host made of a prop's version (C2b): the character package never reads a CAD
 * document. `draw` places the version's meshes for joint values (keyed ones; a joint left out
 * keeps its saved value) without a kernel, so playback can call it every frame.
 */
export type CharacterPropView =
  | { status: 'pending' }
  | { status: 'failed'; message: string }
  | {
      status: 'ready';
      joints: CharacterPropJoint[];
      draw(values: CharacterJointValues): CharacterPropInstance[];
    };
/** A saved version the Host offers to place as a prop. */
export interface CharacterPropChoice {
  artifactId: string;
  versionId: string;
  contentHash: string;
  /** The Artifact's name and the version, as the picker lists it. */
  label: string;
}

/** A prop's meshes at one pose, in character space. */
export interface PropFrame {
  propId: string;
  visible: boolean;
  instances: CharacterPropInstance[];
}

/** Every ready prop at a pose: its version's meshes for the keyed joints, then its placement. */
export function propFrames(
  doc: CharacterDocument,
  views: ReadonlyMap<string, CharacterPropView>,
  pose: CharacterPose,
): PropFrame[] {
  const out: PropFrame[] = [];
  for (const prop of doc.props) {
    const view = views.get(prop.id);
    if (view?.status !== 'ready') continue;
    const place = composeMat4({ ...prop.placement, scale: [1, 1, 1] });
    out.push({
      propId: prop.id,
      visible: prop.visible,
      instances: view
        .draw(pose.joints.get(prop.id) ?? new Map())
        .map((i) => ({ mesh: i.mesh, matrix: multiplyMat4(place, i.matrix) })),
    });
  }
  return out;
}

/** Joints a prop's tracks key that its version does not have (shown, never drawn). */
export function missingJoints(
  doc: CharacterDocument,
  propId: string,
  view: CharacterPropView | undefined,
): string[] {
  if (view?.status !== 'ready') return [];
  const has = new Set(view.joints.map((j) => j.id));
  const out = new Set<string>();
  for (const a of doc.actions)
    for (const t of a.tracks)
      if (t.target.kind === 'prop-joint' && t.target.id === propId && !has.has(t.target.joint))
        out.add(t.target.joint);
  return [...out];
}
