/**
 * R2b-2 joint edits (docs/cad/r2b-assembly.md, Connectorとjoint). A joint's child pose is solved
 * from part evaluations, so these edits leave it as stored; the coordinator evaluates the
 * candidate, solves the joint tree and writes the poses into the same edit (`withSolvedPoses`).
 */
import { parseCopyStep, poseOf, type CadSolvedPose } from './assembly';
import { lengthParameters } from './graph';
import type { CadJoint, CadJointValues } from './joints';
import { position, type CadDocument } from './model';

export type CadJointOperation =
  /** A new joint: its child loses its placement, and keeps its pose until the joint is solved. */
  | { type: 'insertJoint'; joint: CadJoint }
  /** A joint replaced (same ID); a child it no longer moves is fixed where it stands. */
  | { type: 'updateJoint'; joint: CadJoint }
  /** New values for a joint's freedoms (Inspector, or the end of a drag). */
  | { type: 'setJointValues'; jointId: string; values: CadJointValues }
  /**
   * The explicit "solve poses again" after stored poses were found not to match their joints
   * (R2b-U5): it changes nothing itself, the coordinator writes the solved poses.
   */
  | { type: 'solveAssemblyPoses' };

const fail = (code: string): never => {
  throw new Error(code);
};

/** A component a joint no longer places is fixed at its current stored pose. */
export function fixAtStoredPose(doc: CadDocument, componentId: string) {
  const c = doc.components.find((x) => x.id === componentId);
  const pose = poseOf(doc.solvedPoses, componentId);
  if (!c || c.placement || !pose) return;
  const [x, y, z] = pose.translationMm;
  c.placement = { translation: position(x, y, z), rotation: [...pose.rotation] };
}

export function applyJointOperation(next: CadDocument, op: CadJointOperation) {
  switch (op.type) {
    case 'insertJoint': {
      const child = next.components.find((c) => c.id === op.joint.child.componentId);
      if (!child) return fail('target-missing');
      child.placement = null;
      next.joints.push(op.joint);
      return next;
    }
    case 'updateJoint': {
      const i = next.joints.findIndex((j) => j.id === op.joint.id);
      if (i < 0) return fail('target-missing');
      const before = next.joints[i]!.child.componentId;
      next.joints[i] = op.joint;
      if (before !== op.joint.child.componentId) {
        fixAtStoredPose(next, before);
        const child = next.components.find((c) => c.id === op.joint.child.componentId);
        if (!child) return fail('target-missing');
        child.placement = null;
      }
      return next;
    }
    case 'setJointValues': {
      const joint = next.joints.find((j) => j.id === op.jointId) ?? fail('target-missing');
      joint.values = op.values;
      return next;
    }
    case 'solveAssemblyPoses':
      return next;
  }
}

/**
 * The solved poses of a candidate's joint children, written after its edit applied. Exactly
 * the children: a fixed component's pose always follows its placement.
 */
export function writeSolvedPoses(doc: CadDocument, poses: Record<string, CadSolvedPose>) {
  const children = new Set(doc.joints.map((j) => j.child.componentId));
  const keys = Object.keys(poses);
  if (keys.length !== children.size || !keys.every((k) => children.has(k)))
    fail('solved-poses-children');
  for (const id of keys) {
    const p = poses[id]!;
    doc.solvedPoses[id] = { translationMm: [...p.translationMm], rotation: [...p.rotation] };
  }
}

/**
 * Joints that go with a deletion (依存一括削除): named directly, reading a removed parameter, a
 * removed component on either side, or a removed feature of this document's bodies.
 */
export function jointsReading(
  doc: CadDocument,
  roots: ReadonlySet<string>,
  removed: {
    parameters: ReadonlySet<string>;
    features: ReadonlySet<string>;
    components: ReadonlySet<string>;
    patterns: ReadonlySet<string>;
  },
) {
  return doc.joints
    .filter((j) => {
      if (roots.has(j.id)) return true;
      const [first] = j.parent.componentPath;
      if (removed.components.has(j.child.componentId)) return true;
      if (first !== undefined && removed.components.has(first)) return true;
      const copy = first === undefined ? undefined : parseCopyStep(first);
      if (copy && removed.patterns.has(copy.patternId)) return true;
      if (
        first === undefined &&
        !('origin' in j.parent.ref) &&
        removed.features.has(j.parent.ref.featureId)
      )
        return true;
      const lengths = [
        ...Object.values(j.values),
        ...j.parent.offset.translation,
        ...j.child.connector.offset.translation,
      ];
      return lengths.some((l) => l && lengthParameters(l).some((p) => removed.parameters.has(p)));
    })
    .map((j) => j.id);
}
