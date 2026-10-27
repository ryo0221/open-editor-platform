/**
 * R2b-2 connectors and joints (docs/cad/r2b-assembly.md, Connectorとjoint): a joint lays a
 * child component's connector onto its parent's and moves it only along the joint type's
 * freedoms. Joints form a tree (R2b-U4); poses are computed from given values, with no solver.
 * Connector frames come from part evaluations; everything here is pure and never calls a kernel.
 */
import {
  composePoses,
  identityPose,
  partArtifactId,
  poseOf,
  posesDiffer,
  rotateVector,
  solvePlacement,
  stepComponent,
  stepPose,
  type CadPartLookup,
  type CadSolvedPose,
} from './assembly';
import { resolveAngle, resolveLength, resolvePosition, type ParameterValues } from './graph';
import type { Angle, CadDocument, Length, Position3, Quaternion } from './model';
import type { CadReferenceProblem, CadTopologyRef } from './topology';

/** The part's origin (its document's axes), or a face, edge or vertex of an active body's result. */
export type CadConnectorRef = CadTopologyRef | { origin: true };
export interface CadConnector {
  /**
   * Component IDs. A parent's starts in this document (`[]` is its own bodies); a child's starts
   * inside the component it moves (`[]` is that part itself). Later steps name components of
   * the sub-assembly versions in between. A step may be a pattern copy (`copy:<pattern ID>:<i>`,
   * R2b-3), except a child's own component.
   */
  componentPath: string[];
  ref: CadConnectorRef;
  /** Reverses z (a half turn about x). */
  flip: boolean;
  /** Moves the connector in its own frame, after `flip`. */
  offset: { translation: Position3; rotation: Quaternion };
}
export type CadJointType = 'fastened' | 'revolute' | 'slider' | 'cylindrical' | 'planar';
export type CadJointValueKey = 'angle' | 'distance' | 'u' | 'v';
export interface CadJointValues {
  angle?: Angle;
  distance?: Length;
  u?: Length;
  v?: Length;
}
/** Bounds of one value: radians for `angle`, millimetres otherwise. */
export interface CadJointLimit {
  of: CadJointValueKey;
  min: number;
  max: number;
}
export interface CadJoint {
  id: string;
  name: string;
  type: CadJointType;
  parent: CadConnector;
  /** The direct component it moves (a sub-assembly moves as one rigid body). */
  child: { componentId: string; connector: CadConnector };
  /** Exactly the values its type reads (`cadJointValueKeys`). */
  values: CadJointValues;
  limits: CadJointLimit[];
}

/** The values each joint type reads, in the order its transform applies them. */
export const cadJointValueKeys: Readonly<Record<CadJointType, readonly CadJointValueKey[]>> =
  Object.freeze({
    fastened: [],
    revolute: ['angle'],
    slider: ['distance'],
    cylindrical: ['distance', 'angle'],
    planar: ['u', 'v', 'angle'],
  });
export const cadJointTypes = Object.keys(cadJointValueKeys) as CadJointType[];
/** Safety limits (docs/cad/r2b-assembly.md, 上限). Not performance claims. */
export const cadJointLimits = Object.freeze({
  joints: 1_024,
  /** Joints from a fixed component or this document's bodies down to the deepest child. */
  depth: 128,
  /** Components on one connector path (the nesting limit). */
  path: 8,
  /** A joint angle and its limits stay within one turn either way. */
  angleRad: 2 * Math.PI,
});

/**
 * A connector's frame as its part evaluates it, in that part's coordinates: resolved by name
 * (never the nearest element), or why it is not. Kernels answer one per requested reference.
 */
export type CadConnectorFrame =
  | { status: 'resolved'; frame: CadSolvedPose }
  | {
      status: 'ambiguous' | 'missing';
      /** Nearest the reference's hint first, as for feature references. */
      candidates: CadReferenceProblem['candidates'];
    }
  /** Not a plane, cylinder, cone, circle or vertex, or a reference this kernel cannot read. */
  | { status: 'unsupported' };

/** A reference's identity for caching and matching frames (its hint orders candidates). */
export const connectorRefKey = (ref: CadTopologyRef) =>
  JSON.stringify([ref.kind, ref.featureId, ref.name, ref.select ?? null, ref.hint]);

/** `p⁻¹`, so `p ∘ p⁻¹` is the identity. */
export function invertPose(p: CadSolvedPose): CadSolvedPose {
  const [x, y, z, w] = p.rotation;
  const rotation: Quaternion = [-x, -y, -z, w];
  const t = rotateVector(rotation, p.translationMm);
  return { translationMm: [-t[0], -t[1], -t[2]], rotation };
}
const turnZ = (angle: number): Quaternion => [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
/** Each value a joint type reads, resolved (rad for angle, mm otherwise). */
export function jointValues(joint: Pick<CadJoint, 'type' | 'values'>, params: ParameterValues) {
  const out: Partial<Record<CadJointValueKey, number>> = {};
  for (const key of cadJointValueKeys[joint.type]) {
    const v = joint.values[key];
    if (!v) continue;
    out[key] =
      key === 'angle' ? resolveAngle(v as Angle, params) : resolveLength(v as Length, params);
  }
  return out;
}
/** The joint's own motion between the two connector frames, from resolved values. */
export function jointMotion(
  type: CadJointType,
  v: Partial<Record<CadJointValueKey, number>>,
): CadSolvedPose {
  const angle = v.angle ?? 0;
  switch (type) {
    case 'fastened':
      return identityPose();
    case 'revolute':
      return { translationMm: [0, 0, 0], rotation: turnZ(angle) };
    case 'slider':
      return { translationMm: [0, 0, v.distance ?? 0], rotation: [0, 0, 0, 1] };
    case 'cylindrical':
      return { translationMm: [0, 0, v.distance ?? 0], rotation: turnZ(angle) };
    case 'planar':
      return { translationMm: [v.u ?? 0, v.v ?? 0, 0], rotation: turnZ(angle) };
  }
}
/** A connector's frame after `flip` and `offset`, in the coordinates `frame` is in. */
export function connectorFrame(
  frame: CadSolvedPose,
  connector: Pick<CadConnector, 'flip' | 'offset'>,
  params: ParameterValues,
): CadSolvedPose {
  const flipped = connector.flip
    ? composePoses(frame, { translationMm: [0, 0, 0], rotation: [1, 0, 0, 0] })
    : frame;
  return composePoses(flipped, {
    translationMm: resolvePosition(connector.offset.translation, params),
    rotation: [...connector.offset.rotation],
  });
}

/** Where a connector's reference resolves: this document's bodies, or a version by content hash. */
export type CadConnectorTarget =
  | {
      status: 'found';
      /** `'own'` for this document's bodies, otherwise the version's content hash. */
      at: string;
      /** The final part's origin in the coordinates of the path's first component's part. */
      chain: CadSolvedPose;
      /**
       * Every part the path reads, the final one last (empty for `'own'`). The same content may
       * be placed from several Artifacts, so each step names the one this path goes through
       * (none for a part imported into its document).
       */
      through: { contentHash: string; artifactId: string | undefined }[];
    }
  /** A component on the path is not in the version that should hold it. */
  | { status: 'missing' }
  /** A sub-assembly version on the path is not readable here. */
  | { status: 'unavailable' };
/**
 * Follows `path` from `componentId` of `owner` (or this document's bodies when it is undefined)
 * through the versions it places, as they were saved.
 */
export function connectorTarget(
  owner: CadDocument,
  componentId: string | undefined,
  path: readonly string[],
  lookup: CadPartLookup,
): CadConnectorTarget {
  if (componentId === undefined)
    return { status: 'found', at: 'own', chain: identityPose(), through: [] };
  let doc = owner;
  let id = componentId;
  let chain = identityPose();
  const through: { contentHash: string; artifactId: string | undefined }[] = [];
  for (let i = 0; ; i++) {
    const c = stepComponent(doc, id)?.component;
    const part = c && doc.parts.find((p) => p.id === c.partId);
    if (!part) return { status: 'missing' };
    const hash = part.source.contentHash;
    through.push({ contentHash: hash, artifactId: partArtifactId(part.source) });
    if (i === path.length) return { status: 'found', at: hash, chain, through };
    const inner = lookup(hash);
    if (!inner) return { status: 'unavailable' };
    doc = inner;
    id = path[i]!;
    const pose = stepPose(doc, doc.solvedPoses, id);
    if (!pose) return { status: 'missing' };
    chain = composePoses(chain, pose);
  }
}
/** The two connectors of a joint: the parent's from this document, the child's inside its component. */
export function jointTargets(doc: CadDocument, joint: CadJoint, lookup: CadPartLookup) {
  const [first, ...rest] = joint.parent.componentPath;
  return {
    parent: connectorTarget(doc, first, rest, lookup),
    child: connectorTarget(
      doc,
      joint.child.componentId,
      joint.child.connector.componentPath,
      lookup,
    ),
  };
}

export type CadJointProblemCode =
  | 'connector-ambiguous'
  | 'connector-missing'
  | 'connector-unsupported-geometry';
/** How each joint solved, for display, drag previews and refusing broken edits. */
export type CadJointSolution =
  | {
      status: 'solved';
      /** The parent connector's frame in the assembly. */
      parent: CadSolvedPose;
      /** The child connector's frame in its component's part coordinates. */
      child: CadSolvedPose;
    }
  /**
   * A part on either side cannot be evaluated or read here: the child keeps its stored pose.
   * `parent` is the parent connector's frame in the assembly when that side still resolves.
   */
  | { status: 'unavailable'; parent?: CadSolvedPose }
  /** A side's connector does not resolve: each broken side, the parent's first. */
  | { status: 'broken'; problems: CadJointProblem[] };
export interface CadJointProblem {
  side: 'parent' | 'child';
  code: CadJointProblemCode;
  /** In the side's part's own coordinates, as its references store them. */
  candidates?: CadReferenceProblem['candidates'];
  /**
   * Where that part lies in this document (its occurrence's pose), so its candidates can be
   * shown in place. Display only: a chosen reference keeps the part's own hint.
   */
  placed?: CadSolvedPose;
}
/** A candidate's hint moved by `pose`, for showing it where its occurrence lies. */
export function placeHint(
  hint: CadReferenceProblem['candidates'][number]['hint'],
  pose: CadSolvedPose,
): CadReferenceProblem['candidates'][number]['hint'] {
  const at = rotateVector(pose.rotation, hint.centroid);
  return {
    ...hint,
    centroid: [
      at[0] + pose.translationMm[0],
      at[1] + pose.translationMm[1],
      at[2] + pose.translationMm[2],
    ],
    ...(hint.normal ? { normal: rotateVector(pose.rotation, hint.normal) } : {}),
  };
}
/** Where a side's stored reference is in the joint (`cad.rebindReferences` paths, R2b-2b). */
export const jointRefPath = (side: 'parent' | 'child') =>
  side === 'parent' ? ['parent', 'ref'] : ['child', 'connector', 'ref'];
/** A joint's stored face and edge references, by their paths in the joint. */
export function jointReferences(joint: CadJoint) {
  const sides = [
    ['parent', joint.parent.ref],
    ['child', joint.child.connector.ref],
  ] as const;
  return sides.flatMap(([side, ref]) =>
    'origin' in ref ? [] : [{ path: jointRefPath(side), ref }],
  );
}
export interface CadJointSolve {
  /** Every direct component's pose: placements, then joint children in tree order. */
  poses: Record<string, CadSolvedPose>;
  joints: Record<string, CadJointSolution>;
  /** Joints whose child's stored pose differs from the solved one (R2b-U5). */
  mismatch: string[];
}
/**
 * Solves the joint tree. `frame` answers a reference on this document's bodies (`'own'`) or a
 * version (its content hash), or undefined when that part was not evaluated; `available` says
 * whether each part on a connector's path was evaluated here and may be read through that
 * Artifact (an origin connector reads no frame, but its part must still be readable). A child
 * whose joint does not solve keeps its stored pose, so the parts past it stay where they were
 * saved.
 */
export function solveJoints(
  doc: CadDocument,
  params: ParameterValues,
  lookup: CadPartLookup,
  frame: (at: string, ref: CadTopologyRef) => CadConnectorFrame | undefined,
  available: (part: { contentHash: string; artifactId: string | undefined }) => boolean,
): CadJointSolve {
  const poses: Record<string, CadSolvedPose> = {};
  for (const c of doc.components)
    if (c.placement) poses[c.id] = solvePlacement(c.placement, params);
  const joints: Record<string, CadJointSolution> = {};
  const mismatch: string[] = [];
  /** The connector's frame (after flip and offset) relative to its path's first component. */
  const local = (
    target: CadConnectorTarget,
    connector: CadConnector,
    side: 'parent' | 'child',
  ): CadSolvedPose | CadJointProblem | 'unavailable' => {
    if (target.status === 'unavailable') return 'unavailable';
    if (target.status === 'missing') return { side, code: 'connector-missing' };
    if (!target.through.every(available)) return 'unavailable';
    let base = identityPose();
    if (!('origin' in connector.ref)) {
      const f = frame(target.at, connector.ref);
      if (!f) return 'unavailable';
      if (f.status === 'unsupported') return { side, code: 'connector-unsupported-geometry' };
      if (f.status !== 'resolved')
        return {
          side,
          code: f.status === 'ambiguous' ? 'connector-ambiguous' : 'connector-missing',
          candidates: f.candidates,
        };
      base = f.frame;
    }
    return composePoses(target.chain, connectorFrame(base, connector, params));
  };
  const isPose = (x: CadSolvedPose | CadJointProblem | 'unavailable'): x is CadSolvedPose =>
    typeof x === 'object' && 'rotation' in x;
  // Validation keeps the joints a tree, so each round solves at least one child until done.
  let pending = [...doc.joints];
  while (pending.length) {
    const later: CadJoint[] = [];
    for (const joint of pending) {
      const [first] = joint.parent.componentPath;
      // A copy's pose follows its seed's: it waits for the seed like a component.
      const on = first === undefined ? undefined : stepPose(doc, poses, first, params);
      if (first !== undefined && !on && stepComponent(doc, first, params)) {
        later.push(joint);
        continue;
      }
      const child = joint.child.componentId;
      const targets = jointTargets(doc, joint, lookup);
      const parent = local(targets.parent, joint.parent, 'parent');
      const own = local(targets.child, joint.child.connector, 'child');
      const stored = poseOf(doc.solvedPoses, child) ?? identityPose();
      const world = !isPose(parent) || !on ? parent : composePoses(on, parent);
      if (!isPose(world) || !isPose(own)) {
        // Where each side's part lies, for showing its candidates in place.
        const placed = (p: CadJointProblem) => {
          const target = p.side === 'parent' ? targets.parent : targets.child;
          if (!p.candidates || target.status !== 'found') return p;
          const base = p.side === 'parent' ? on : stored;
          return { ...p, placed: base ? composePoses(base, target.chain) : target.chain };
        };
        // A broken side is named before an unreadable one: it is what the person must fix.
        const problems = [world, own]
          .filter((x): x is CadJointProblem => typeof x === 'object' && !isPose(x))
          .map(placed);
        joints[joint.id] = problems.length
          ? { status: 'broken', problems }
          : { status: 'unavailable', ...(isPose(world) ? { parent: world } : {}) };
        poses[child] = stored;
        continue;
      }
      const pose = composePoses(
        composePoses(world, jointMotion(joint.type, jointValues(joint, params))),
        invertPose(own),
      );
      joints[joint.id] = { status: 'solved', parent: world, child: own };
      poses[child] = pose;
      if (posesDiffer(pose, stored)) mismatch.push(joint.id);
    }
    if (later.length === pending.length) break;
    pending = later;
  }
  return { poses, joints, mismatch };
}
/** The child pose a drag preview shows for other values of one solved joint. */
export function previewJointPose(
  joint: Pick<CadJoint, 'type'>,
  solution: Extract<CadJointSolution, { status: 'solved' }>,
  values: Partial<Record<CadJointValueKey, number>>,
): CadSolvedPose {
  return composePoses(
    composePoses(solution.parent, jointMotion(joint.type, values)),
    invertPose(solution.child),
  );
}
/** Components a joint moves directly (its children), by component ID. */
export const jointChildren = (doc: Pick<CadDocument, 'joints'>) =>
  new Map(doc.joints.map((j) => [j.child.componentId, j]));
