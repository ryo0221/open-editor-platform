/**
 * R2b-2c making a joint in the viewport (docs/cad/r2b-assembly.md, Surface・jointの作成): a
 * picked face, edge or vertex as a connector reference, the new joint, and what a drag of a
 * joint's value moves. Pure: the picks come from the viewport, frames from the evaluation.
 */
import {
  activeJoints,
  cadJointValueKeys,
  componentCopies,
  composePoses,
  connectorTarget,
  formatTopoName,
  identityPose,
  identityQuaternion,
  invertPose,
  mm,
  parameterValues,
  parseCopyStep,
  patternMove,
  position,
  posesForJointValues,
  previewJointPose,
  stepComponent,
  stepPose,
  topologyRefOf,
  type CadConnector,
  type CadDocument,
  type CadJoint,
  type CadJointSolution,
  type CadJointType,
  type CadJointValueKey,
  type CadJointValues,
  type CadPartLookup,
  type CadSolvedPose,
  type Vec3,
} from '@editor-platform/cad-core';
import type { CadConnectorPick } from './viewport';

/** One side of a joint being made: its connector, and for the child the component it moves. */
export interface CadConnectorChoice {
  connector: CadConnector;
  /** The child's direct component (the first step of the picked path). */
  componentId?: string;
  /** What was picked, as shown: the component and the element's name. */
  label: string;
  /** Where it was picked (assembly coordinates), marked until the preview shows the frame. */
  point?: Vec3;
}

const plain = (componentPath: string[], ref: CadConnector['ref']): CadConnector => ({
  componentPath,
  ref,
  flip: false,
  offset: { translation: position(0, 0, 0), rotation: identityQuaternion() },
});
const kindLabel = { face: 'Face', edge: 'Edge', vertex: 'Vertex' } as const;

/**
 * The connector a pick makes for one side, or the code it is refused with. A parent may be on
 * this document's bodies or any placed part; a child is inside a direct component, which it moves.
 */
/** A direct path step's name: a component's, or a pattern copy's (`Bolt ring 3`, the seed is 1). */
export function stepName(
  content: Pick<CadDocument, 'components' | 'componentPatterns' | 'parameters'>,
  step: string,
): string | undefined {
  const at = stepComponent(content, step);
  return at?.pattern ? `${at.pattern.name} ${at.index + 1}` : at?.component.name;
}
export function connectorFromPick(
  content: CadDocument,
  lookup: CadPartLookup,
  pick: CadConnectorPick,
  side: 'parent' | 'child',
): CadConnectorChoice | string {
  const path = pick.path;
  if (!path?.length && side === 'child') return 'joint-child-own';
  // A copy follows its seed and its pattern: a joint can hang from it, never move it.
  if (path?.length && side === 'child' && parseCopyStep(path[0]!)) return 'joint-child-copy';
  let doc = content;
  if (path?.length) {
    const target = connectorTarget(content, path[0], path.slice(1), lookup);
    if (target.status !== 'found') return 'joint-part-unavailable';
    const version = lookup(target.at);
    if (!version) return 'joint-part-unavailable';
    doc = version;
  }
  const body = doc.bodies.find((b) => b.id === pick.mesh.bodyId && b.state === 'active');
  if (!body) return 'joint-connector-body';
  let ref;
  try {
    ref = topologyRefOf(pick.mesh.topology, pick.kind, pick.index, body.resultFeatureId);
  } catch (e) {
    // An unnamed element (an imported shape) or one its neighbours cannot tell apart.
    return e instanceof Error ? e.message : String(e);
  }
  const owner = path?.length ? (stepName(content, path[0]!) ?? path[0]!) : 'This document';
  const label = `${owner}${path && path.length > 1 ? ` › ${path.slice(1).join(' › ')}` : ''} · ${kindLabel[pick.kind]} ${formatTopoName(ref.name)}`;
  return side === 'parent'
    ? { connector: plain(path ?? [], ref), label, point: pick.point }
    : { connector: plain(path!.slice(1), ref), componentId: path![0], label, point: pick.point };
}
/** A part's (or for a parent with none, this document's) origin as a connector. */
export function originChoice(
  content: CadDocument,
  componentId: string | undefined,
  side: 'parent' | 'child',
): CadConnectorChoice | string {
  const name = componentId && stepName(content, componentId);
  if (componentId && !name) return 'target-missing';
  if (!componentId && side === 'child') return 'joint-child-own';
  if (componentId && side === 'child' && parseCopyStep(componentId)) return 'joint-child-copy';
  const label = `${name || 'This document'} · Origin`;
  return side === 'parent'
    ? { connector: plain(componentId ? [componentId] : [], { origin: true }), label }
    : { connector: plain([], { origin: true }), componentId: componentId!, label };
}

/** The values a new joint of each type starts from: zero, as literals. */
function startValues(type: CadJointType): CadJointValues {
  const zero: Record<CadJointValueKey, CadJointValues[CadJointValueKey]> = {
    angle: { literalRad: 0 },
    angle2: { literalRad: 0 },
    angle3: { literalRad: 0 },
    distance: mm(0),
    u: mm(0),
    v: mm(0),
  };
  return Object.fromEntries(cadJointValueKeys[type].map((k) => [k, zero[k]])) as CadJointValues;
}
/** The joint the choices make: the child's connector flipped onto the parent's when asked. */
export function newJoint(
  content: CadDocument,
  id: string,
  parent: CadConnectorChoice,
  child: CadConnectorChoice,
  type: CadJointType,
  flip: boolean,
): CadJoint {
  const names = new Set(content.joints.map((j) => j.name));
  let n = content.joints.length + 1;
  while (names.has(`Joint ${n}`)) n++;
  return {
    id,
    name: `Joint ${n}`,
    type,
    parent: structuredClone(parent.connector),
    child: {
      componentId: child.componentId!,
      connector: { ...structuredClone(child.connector), flip },
    },
    values: startValues(type),
    limits: [],
  };
}

/**
 * CR3e-2: the parent connector's offset that keeps the child where it stands (`stood`) at the
 * joint's zero, from a solve with no parent offset: `parent⁻¹ ∘ stood ∘ child`, so the parent's
 * frame lies on the child connector where it is now (a door on its own hinge edge, across the
 * gap from the opening's edge).
 */
export function keptOffset(
  solved: Pick<Extract<CadJointSolution, { status: 'solved' }>, 'parent' | 'child'>,
  stood: CadSolvedPose,
): CadConnector['offset'] {
  const o = composePoses(invertPose(solved.parent), composePoses(stood, solved.child));
  const t = o.translationMm.map((x) => Math.round(x * 1e9) / 1e9 + 0) as Vec3;
  return { translation: position(...t), rotation: o.rotation };
}

/**
 * The direct components a drag of a joint's value can start on: its child and the joint children
 * below it that move as it does. A copy, and what hangs from one, turns about the copy's own
 * place, so the grab would not follow the joint's frame.
 */
export function jointMoves(content: CadDocument, joint: CadJoint) {
  const still = (f: CadSolvedPose) =>
    [...f.translationMm, ...f.rotation.slice(0, 3)].every((v) => v === 0);
  return new Set(
    [...jointMoveFrames(content, joint)].flatMap(([k, f]) =>
      !parseCopyStep(k) && still(f) ? [k] : [],
    ),
  );
}
/**
 * Everything a joint's drag moves, by first path step: its child, what hangs from it, and their
 * pattern copies (R2b-3). Each has the frame its motion is seen in: a copy's is its pattern's
 * move after its seed's, since a copy turns about its own place (`C·D·C⁻¹` for a motion `D`).
 */
export function jointMoveFrames(content: CadDocument, joint: CadJoint) {
  const frames = new Map<string, CadSolvedPose>();
  // MR7: a candidate not in effect does not place its child: its drag moves nothing.
  if (!activeJoints(content).some((j) => j.id === joint.id)) return frames;
  const params = parameterValues(content);
  const copies = componentCopies(content, params);
  const add = (id: string, frame: CadSolvedPose) => {
    frames.set(id, frame);
    for (const x of copies.get(id) ?? [])
      frames.set(x.step, composePoses(patternMove(x.pattern.layout, x.index, params), frame));
  };
  add(joint.child.componentId, identityPose());
  // MR7: a mount's candidates not in effect place nothing, so a drag moves nothing through them.
  const placing = activeJoints(content);
  for (let grew = true; grew; ) {
    grew = false;
    for (const j of placing) {
      const on = j.parent.componentPath[0];
      const frame = on === undefined ? undefined : frames.get(on);
      if (frame && !frames.has(j.child.componentId)) {
        add(j.child.componentId, frame);
        grew = true;
      }
    }
  }
  return frames;
}
/**
 * The joints a joint's values drive through couplings (MR1), followers of followers too, that are
 * in effect: a drag shows them moving with it, those that hang from its own child too.
 */
export function jointFollowers(content: CadDocument, joint: CadJoint): CadJoint[] {
  const active = activeJoints(content);
  if (!active.some((j) => j.id === joint.id)) return [];
  const driven = new Set([joint.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const j of content.joints)
      if (!driven.has(j.id) && (j.couplings ?? []).some((c) => driven.has(c.from.joint))) {
        driven.add(j.id);
        grew = true;
      }
  }
  return active.filter((j) => j.id !== joint.id && driven.has(j.id));
}
/**
 * The steps a drag of a joint moves through its followers (`jointFollowers`): each follower's
 * child, what hangs from it and their pattern copies. A step its own drag also moves is shown by
 * its solved motion instead of the drag's rigid one, so a follower below the child turns too.
 */
export function jointFollowerSteps(content: CadDocument, joint: CadJoint): Set<string> {
  return new Set(
    jointFollowers(content, joint).flatMap((f) => [...jointMoveFrames(content, f).keys()]),
  );
}
/**
 * Each follower step's motion, in assembly coordinates, for the dragged joint at `values`: from
 * where it is shown to where the coupled values place it. Each step is solved in full, so a
 * follower that hangs from another follower adds its own motion to its parent's.
 */
export function followerMotions(
  content: CadDocument,
  joint: CadJoint,
  solved: { poses: Record<string, CadSolvedPose>; joints: Record<string, CadJointSolution> },
  steps: ReadonlySet<string>,
  values: Partial<Record<CadJointValueKey, number>>,
): Map<string, CadSolvedPose> {
  const out = new Map<string, CadSolvedPose>();
  if (!steps.size) return out;
  const params = parameterValues(content);
  const poses = posesForJointValues(content, solved, new Map([[joint.id, values]]), params);
  for (const step of steps) {
    const now = stepPose(content, poses, step, params);
    const shown = stepPose(content, solved.poses, step, params);
    if (now && shown) out.set(step, composePoses(now, invertPose(shown)));
  }
  return out;
}
/** The child's motion for other values, from the pose it is shown at: `new ∘ shown⁻¹`. */
export function dragMotion(
  joint: Pick<CadJoint, 'type'>,
  solution: Extract<CadJointSolution, { status: 'solved' }>,
  shown: CadSolvedPose,
  values: Partial<Record<CadJointValueKey, number>>,
): CadSolvedPose {
  return composePoses(previewJointPose(joint, solution, values), invertPose(shown));
}
