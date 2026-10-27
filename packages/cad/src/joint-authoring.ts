/**
 * R2b-2c making a joint in the viewport (docs/cad/r2b-assembly.md, Surface・jointの作成): a
 * picked face, edge or vertex as a connector reference, the new joint, and what a drag of a
 * joint's value moves. Pure: the picks come from the viewport, frames from the evaluation.
 */
import {
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
  previewJointPose,
  stepComponent,
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
  const params = parameterValues(content);
  const copies = componentCopies(content, params);
  const frames = new Map<string, CadSolvedPose>();
  const add = (id: string, frame: CadSolvedPose) => {
    frames.set(id, frame);
    for (const x of copies.get(id) ?? [])
      frames.set(x.step, composePoses(patternMove(x.pattern.layout, x.index, params), frame));
  };
  add(joint.child.componentId, identityPose());
  for (let grew = true; grew; ) {
    grew = false;
    for (const j of content.joints) {
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
/** The child's motion for other values, from the pose it is shown at: `new ∘ shown⁻¹`. */
export function dragMotion(
  joint: Pick<CadJoint, 'type'>,
  solution: Extract<CadJointSolution, { status: 'solved' }>,
  shown: CadSolvedPose,
  values: Partial<Record<CadJointValueKey, number>>,
): CadSolvedPose {
  return composePoses(previewJointPose(joint, solution, values), invertPose(shown));
}
