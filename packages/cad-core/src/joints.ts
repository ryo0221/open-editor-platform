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
import {
  parameterValues,
  resolveAngle,
  resolveLength,
  resolvePosition,
  type ParameterValues,
} from './graph';
import type { Angle, CadDocument, Length, Position3, Quaternion } from './model';
import { activeJoints, inactiveJointIds, type CadMountChoice } from './mounts';
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
export type CadJointType =
  | 'fastened'
  | 'revolute'
  | 'slider'
  | 'cylindrical'
  | 'planar'
  /** MR1: three turns, about the connector's z, then the turned y, then the turned x. */
  | 'spherical'
  /** MR1: two turns, about the connector's z, then the turned x. */
  | 'universal';
export type CadJointValueKey = 'angle' | 'angle2' | 'angle3' | 'distance' | 'u' | 'v';
export interface CadJointValues {
  angle?: Angle;
  angle2?: Angle;
  angle3?: Angle;
  distance?: Length;
  u?: Length;
  v?: Length;
}
/** The values that are angles (radians); the others are lengths (millimetres). */
export const cadJointAngleKeys: ReadonlySet<CadJointValueKey> = new Set([
  'angle',
  'angle2',
  'angle3',
]);
export const isJointAngleKey = (key: CadJointValueKey) => cadJointAngleKeys.has(key);
/** The values a joint stores itself: its type's, less those that follow another joint (MR1). */
export function ownJointValueKeys(joint: Pick<CadJoint, 'type' | 'couplings'>): CadJointValueKey[] {
  const coupled = new Set((joint.couplings ?? []).map((c) => c.of));
  return cadJointValueKeys[joint.type].filter((k) => !coupled.has(k));
}
/**
 * MR1 (docs/cad/mecha-design.md): one value of a joint that follows another joint's value,
 * `value = ratio × from + offset` (left and right wings, a piston that follows a knee). The
 * followed value is not stored in the joint's `values`; both values are of the same kind
 * (angle to angle, length to length), and `offset` is in that kind's unit (rad or mm).
 */
export interface CadJointCoupling {
  of: CadJointValueKey;
  from: { joint: string; of: CadJointValueKey };
  ratio: number;
  offset: number;
}
/** Bounds of one value: radians for an angle, millimetres otherwise. */
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
  /** Exactly the values its type reads (`cadJointValueKeys`), less the coupled ones. */
  values: CadJointValues;
  limits: CadJointLimit[];
  /** MR1: values that follow another joint's value; absent when there are none. */
  couplings?: CadJointCoupling[];
  /**
   * WM2 (docs/cad/watch-design.md): a revolute joint that turns any number of times (a watch
   * wheel). Its angle, and a value that follows it, keep the turns they reach (never wrapped
   * to one turn) within `cadJointLimits.continuousRad`; it has no `limits`. Absent otherwise.
   */
  continuous?: true;
}

/** The values each joint type reads, in the order its transform applies them. */
export const cadJointValueKeys: Readonly<Record<CadJointType, readonly CadJointValueKey[]>> =
  Object.freeze({
    fastened: [],
    revolute: ['angle'],
    slider: ['distance'],
    cylindrical: ['distance', 'angle'],
    planar: ['u', 'v', 'angle'],
    spherical: ['angle', 'angle2', 'angle3'],
    universal: ['angle', 'angle2'],
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
  /** WM2: the angle of a continuous joint, and a value following it, stays within this (rad). */
  continuousRad: 1_000_000,
  /** MR1: a coupling's ratio stays within this either way. */
  couplingRatio: 1_000,
  /** A joint length and its limits stay within this either way (mm). */
  lengthMm: 1_000_000,
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
const turnY = (angle: number): Quaternion => [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
const turnX = (angle: number): Quaternion => [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)];
/** `a ∘ b`: turn by `b` in `a`'s turned axes (intrinsic order). */
const mulQ = (a: Quaternion, b: Quaternion): Quaternion => {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
};
/**
 * The safety bound a joint's value keeps either way: one turn for an angle (WM2: `continuousRad`
 * for a continuous joint's), `lengthMm` for a length.
 */
export const jointSafetyBound = (joint: Pick<CadJoint, 'continuous'>, key: CadJointValueKey) =>
  isJointAngleKey(key)
    ? joint.continuous
      ? cadJointLimits.continuousRad
      : cadJointLimits.angleRad
    : cadJointLimits.lengthMm;
/** Each value a joint type reads, resolved (rad for angle, mm otherwise). */
export function jointValues(joint: Pick<CadJoint, 'type' | 'values'>, params: ParameterValues) {
  const out: Partial<Record<CadJointValueKey, number>> = {};
  for (const key of cadJointValueKeys[joint.type]) {
    const v = joint.values[key];
    if (!v) continue;
    out[key] = isJointAngleKey(key)
      ? resolveAngle(v as Angle, params)
      : resolveLength(v as Length, params);
  }
  return out;
}
export type CadResolvedJointValues = Partial<Record<CadJointValueKey, number>>;
/**
 * Every joint's resolved values with its couplings applied (MR1): its own values, then
 * `overrides` (keyed values, a drag), then each coupled value from the value it follows.
 * A coupled value is never taken from `overrides`: it always follows. Validation keeps the
 * couplings acyclic; a value that follows a missing joint or value is left out.
 */
export function coupledJointValues(
  doc: Pick<CadDocument, 'joints'>,
  params: ParameterValues,
  overrides?: ReadonlyMap<string, CadResolvedJointValues>,
): Map<string, CadResolvedJointValues> {
  const byId = new Map(doc.joints.map((j) => [j.id, j]));
  const out = new Map<string, CadResolvedJointValues>();
  const visiting = new Set<string>();
  const resolve = (id: string): CadResolvedJointValues | undefined => {
    const done = out.get(id);
    if (done) return done;
    const joint = byId.get(id);
    if (!joint || visiting.has(id)) return undefined;
    visiting.add(id);
    const coupled = new Set((joint.couplings ?? []).map((c) => c.of));
    const values: CadResolvedJointValues = { ...jointValues(joint, params) };
    for (const [k, v] of Object.entries(overrides?.get(id) ?? {}))
      if (!coupled.has(k as CadJointValueKey)) values[k as CadJointValueKey] = v;
    for (const c of joint.couplings ?? []) {
      const from = resolve(c.from.joint)?.[c.from.of];
      if (from !== undefined) values[c.of] = c.ratio * from + c.offset;
    }
    visiting.delete(id);
    out.set(id, values);
    return values;
  };
  for (const j of doc.joints) resolve(j.id);
  return out;
}
/**
 * Each resolved value outside its joint's limits or the safety bounds every joint value keeps
 * (`jointSafetyBound`: one turn either way for an angle unless the joint is continuous, `lengthMm`
 * for a length), a coupled value too, by joint and
 * value. A key that drives a follower past them is refused like a key past its own limits.
 */
export function jointLimitViolations(
  doc: Pick<CadDocument, 'joints'>,
  values: ReadonlyMap<string, CadResolvedJointValues>,
): { joint: string; of: CadJointValueKey; value: number }[] {
  const out: { joint: string; of: CadJointValueKey; value: number }[] = [];
  for (const j of doc.joints)
    for (const of of cadJointValueKeys[j.type]) {
      const value = values.get(j.id)?.[of];
      if (value === undefined) continue;
      const l = j.limits.find((x) => x.of === of);
      const bound = jointSafetyBound(j, of);
      if (!(Math.abs(value) <= bound) || (l && !(value >= l.min && value <= l.max)))
        out.push({ joint: j.id, of, value });
    }
  return out;
}
/** The joint's own motion between the two connector frames, from resolved values. */
export function jointMotion(
  type: CadJointType,
  v: Partial<Record<CadJointValueKey, number>>,
): CadSolvedPose {
  // WM2: a continuous joint's many turns; the pose reads the angle within one turn.
  const turns = v.angle ?? 0;
  const angle = Math.abs(turns) > 2 * Math.PI ? turns % (2 * Math.PI) : turns;
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
    case 'spherical':
      return {
        translationMm: [0, 0, 0],
        rotation: mulQ(mulQ(turnZ(angle), turnY(v.angle2 ?? 0)), turnX(v.angle3 ?? 0)),
      };
    case 'universal':
      return { translationMm: [0, 0, 0], rotation: mulQ(turnZ(angle), turnX(v.angle2 ?? 0)) };
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
  const resolved = coupledJointValues(doc, params);
  // MR7: a mount candidate not in effect is solved for its connector frames (to switch to it
  // later) but places nothing.
  const off = inactiveJointIds(doc);
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
        if (!off.has(joint.id)) poses[child] = stored;
        continue;
      }
      const pose = composePoses(
        composePoses(world, jointMotion(joint.type, resolved.get(joint.id) ?? {})),
        invertPose(own),
      );
      joints[joint.id] = { status: 'solved', parent: world, child: own };
      if (off.has(joint.id)) continue;
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
/**
 * Every direct component's pose for other joint values, from one solve and without a kernel
 * (character props, C2b: a joint keyed on a timeline replays each frame). Each solved joint keeps
 * its connector frames and moves its child by the new values; its parent connector follows the
 * component it lies on, so a chain (shoulder, then elbow) moves together. A joint that did not
 * solve leaves its child where the solve put it; values not given are the document's own.
 */
export function posesForJointValues(
  doc: CadDocument,
  solved: { poses: Record<string, CadSolvedPose>; joints: Record<string, CadJointSolution> },
  values: ReadonlyMap<string, Partial<Record<CadJointValueKey, number>>>,
  params: ParameterValues = parameterValues(doc),
  /** MR7: the candidate in effect for each mount (the document's own where not given). */
  mounts?: CadMountChoice,
): Record<string, CadSolvedPose> {
  const poses: Record<string, CadSolvedPose> = { ...solved.poses };
  // A keyed driver moves its followers too (MR1 couplings).
  const resolved = coupledJointValues(doc, params, values);
  const moved = new Set<string>();
  const active = activeJoints(doc, mounts);
  const children = new Set(active.map((j) => j.child.componentId));
  let pending = [...active];
  while (pending.length) {
    const later: CadJoint[] = [];
    for (const joint of pending) {
      const [first] = joint.parent.componentPath;
      const on = first === undefined ? undefined : stepComponent(doc, first, params);
      // A parent that a joint moves is placed first (validation keeps the joints a tree).
      if (on && children.has(on.component.id) && !moved.has(on.component.id)) {
        later.push(joint);
        continue;
      }
      const child = joint.child.componentId;
      moved.add(child);
      const solution = solved.joints[joint.id];
      if (solution?.status !== 'solved') continue;
      const before =
        first === undefined ? identityPose() : stepPose(doc, solved.poses, first, params);
      const after = first === undefined ? identityPose() : stepPose(doc, poses, first, params);
      if (!before || !after) continue;
      // The parent connector relative to the component it lies on, then where that is now.
      const parent = composePoses(after, composePoses(invertPose(before), solution.parent));
      const own = resolved.get(joint.id) ?? {};
      poses[child] = composePoses(
        composePoses(parent, jointMotion(joint.type, own)),
        invertPose(solution.child),
      );
    }
    if (later.length === pending.length) break;
    pending = later;
  }
  return poses;
}
/** Components a joint moves directly (its children), by component ID. */
export const jointChildren = (doc: Pick<CadDocument, 'joints' | 'mounts'>) =>
  new Map(activeJoints(doc).map((j) => [j.child.componentId, j]));
