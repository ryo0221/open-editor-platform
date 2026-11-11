/**
 * WM2 (docs/cad/watch-design.md, かみ合い): a pair of spur gears in mesh, each turned by a revolute
 * joint. The mesh owns the driven joint's angle coupling (MR1): `ratio` from the teeth and the
 * senses of the joints, `offset` so a tooth of one faces a gap of the other. Everything that
 * moves with couplings (poses, drags, forms, character keys, interference) therefore follows a
 * mesh with no code of its own. The checks read the gears from their parts' versions and the
 * joints' solved frames; a mesh that does not check is listed and never corrected silently.
 */
import { composePoses, rotateVector, type CadPartLookup, type CadSolvedPose } from './assembly';
import { resolveSpurGear, spurGearFlankEnd, spurGearRadii, type SpurGearSpec } from './gear';
import { parameterValues, resolveLength, resolvePosition } from './graph';
import {
  coupledJointValues,
  type CadJoint,
  type CadJointCoupling,
  type CadJointSolution,
} from './joints';
import type { CadDocument } from './model';
import { activeJoints, inactiveJointIds } from './mounts';

/** One gear of a mesh: the revolute joint that turns it and its `spurGear` feature. */
export interface CadGearMeshSide {
  joint: string;
  /** A `spurGear` feature of the part version the joint's child component places. */
  feature: string;
}
export interface CadGearMesh {
  id: string;
  name: string;
  /** Its joint's angle is the one the driven joint follows. */
  driver: CadGearMeshSide;
  /** Its joint's angle is the mesh's coupling (never stored in the joint's values). */
  driven: CadGearMeshSide;
}

export const cadGearMeshLimits = Object.freeze({ meshes: 256 });
/** Not performance claims: how closely two gears must sit to be in mesh. */
export const cadGearMeshTolerance = Object.freeze({
  /** Centre distance against the gears' standard centre distance (mm). */
  distanceMm: 0.005,
  /** Axes parallel to each other and to their joints' axes (rad, 0.01°). */
  angleRad: (0.01 * Math.PI) / 180,
  /** A gear's centre off its joint's axis (mm). */
  axisMm: 0.005,
  /** A stored ratio against the teeth's (relative). */
  ratio: 1e-9,
  /** A stored offset against the one where they stand, as a share of the driven joint's pitch. */
  phase: 1e-4,
});

export type CadGearMeshProblemCode =
  /** A joint is not solved here (a part cannot be read, or a connector is broken). */
  | 'gear-mesh-unsolved'
  /** The joint is a mount candidate not in effect: it turns nothing. */
  | 'gear-mesh-inactive'
  /** One joint's frame rides on the other's part: the centre line turns with it. */
  | 'gear-mesh-frame'
  /** The feature is not a `spurGear` of the joint's child part version, or it is invalid. */
  | 'gear-mesh-gear'
  /** The gear reaches its body only through a reflection, which is not read here. */
  | 'gear-mesh-placement'
  /** A cycloidal gear's tooth was made for another number of teeth than its partner's. */
  | 'gear-mesh-mating'
  /** A gear's axis is not its joint's axis: it would wobble as the joint turns. */
  | 'gear-mesh-off-axis'
  | 'gear-mesh-axes'
  | 'gear-mesh-module'
  | 'gear-mesh-profile'
  | 'gear-mesh-pressure-angle'
  /** The centre distance is not the gears' standard one (with their profile shifts). */
  | 'gear-mesh-distance'
  /** The faces do not overlap along the axis. */
  | 'gear-mesh-face'
  /** A tip reaches the other gear's root circle at this centre distance. */
  | 'gear-mesh-clearance'
  /** Cycloidal teeth thicker together than one pitch: they cannot pass. */
  | 'gear-mesh-backlash'
  /** The stored coupling's phase puts a tooth against a tooth (a gear turned in its version). */
  | 'gear-mesh-phase'
  /** The stored coupling's ratio is not the teeth's (a version with other teeth). */
  | 'gear-mesh-ratio';
export interface CadGearMeshProblem {
  code: CadGearMeshProblemCode;
  /** The side it is about, when one. */
  side?: 'driver' | 'driven';
  /** For `gear-mesh-distance`: the distance found and the one expected (mm). */
  distanceMm?: number;
  expectedMm?: number;
}

/** One gear where it stands: its spec and its frame in the assembly. */
interface PlacedGear {
  spec: SpurGearSpec;
  /** Gear centre on its back face, and its axis (unit), in the assembly. */
  centre: [number, number, number];
  axis: [number, number, number];
  /** Tooth 0's direction from the centre (unit, normal to the axis). */
  tooth: [number, number, number];
  faceWidth: number;
  /** The joint's axis (unit) in the assembly. */
  jointAxis: [number, number, number];
  jointOrigin: [number, number, number];
}
type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const scale = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a: V) => Math.hypot(...a);
const unit = (a: V): V => scale(a, 1 / norm(a));
/** The part of `v` normal to the unit `n`. */
const across = (v: V, n: V): V => sub(v, scale(n, dot(v, n)));
/** The angle from `a` to `b` about the unit `n` (both normal to it), in (−π, π]. */
const angleAbout = (a: V, b: V, n: V) => Math.atan2(dot(cross(a, b), n), dot(a, b));
/** `x` wrapped into (−p/2, p/2]. */
const wrap = (x: number, p: number) => x - p * Math.ceil(x / p - 0.5);

function placeGear(
  doc: CadDocument,
  side: CadGearMeshSide,
  poses: Readonly<Record<string, CadSolvedPose>>,
  solution: CadJointSolution | undefined,
  lookup: CadPartLookup,
): PlacedGear | CadGearMeshProblemCode {
  const joint = doc.joints.find((j) => j.id === side.joint);
  if (!joint || joint.type !== 'revolute') return 'gear-mesh-gear';
  if (inactiveJointIds(doc).has(joint.id)) return 'gear-mesh-inactive';
  if (solution?.status !== 'solved') return 'gear-mesh-unsolved';
  const component = doc.components.find((c) => c.id === joint.child.componentId);
  const part = component && doc.parts.find((p) => p.id === component.partId);
  const content = part && lookup(part.source.contentHash);
  const pose = poses[joint.child.componentId];
  if (!content || !pose) return 'gear-mesh-unsolved';
  const feature = content.features.find((f) => f.id === side.feature);
  if (feature?.type !== 'spurGear') return 'gear-mesh-gear';
  const params = parameterValues(content);
  let spec: SpurGearSpec;
  try {
    spec = resolveSpurGear(feature.args, params);
  } catch {
    return 'gear-mesh-gear';
  }
  let own: CadSolvedPose = {
    translationMm: resolvePosition(feature.args.origin, params),
    rotation: [...feature.args.orientation],
  };
  // The path from the gear to an active body's result: each transform on it (the body's
  // placement, one after a Boolean) moves the gear; other features keep their input in place.
  const results = new Set(
    content.bodies.filter((b) => b.state === 'active').map((b) => b.resultFeatureId),
  );
  const consumers = (id: string) =>
    content.features.filter((f) => (f.inputFeatureIds as string[]).includes(id));
  // A reflection that replaces its input moves the gear by more than a placement: not read.
  const reflects = (f: (typeof content.features)[number]) => f.type === 'mirror' && !f.args.union;
  // A cutting tool leaves a gear-shaped hole, not a gear: its material does not survive.
  const cuts = (f: (typeof content.features)[number], id: string) =>
    (f.type === 'boolean' || f.type === 'pattern') &&
    f.args.mode === 'cut' &&
    (f.inputFeatureIds as string[]).indexOf(id) > 0;
  const path = (id: string, seen: Set<string>, mirrors: boolean): string[] | undefined => {
    if (results.has(id)) return [];
    for (const f of consumers(id)) {
      if (seen.has(f.id) || cuts(f, id) || (!mirrors && reflects(f))) continue;
      seen.add(f.id);
      const rest = path(f.id, seen, mirrors);
      if (rest) return [f.id, ...rest];
    }
    return undefined;
  };
  const kept = path(feature.id, new Set(), false);
  if (!kept) return path(feature.id, new Set(), true) ? 'gear-mesh-placement' : 'gear-mesh-gear';
  for (const id of kept) {
    const t = content.features.find((f) => f.id === id);
    if (t?.type !== 'transform') continue;
    own = composePoses(
      {
        translationMm: resolvePosition(t.args.translation, params),
        rotation: [...t.args.rotation],
      },
      own,
    );
  }
  const at = composePoses(pose, own);
  const width = resolveLength(feature.args.faceWidth, params);
  const jointAxis = rotateVector(solution.parent.rotation, [0, 0, 1]) as V;
  return {
    spec,
    centre: [...at.translationMm] as V,
    axis: rotateVector(at.rotation, [0, 0, 1]) as V,
    tooth: rotateVector(at.rotation, [1, 0, 0]) as V,
    faceWidth: width,
    jointAxis,
    jointOrigin: [...solution.parent.translationMm] as V,
  };
}

/** The standard centre distance of an external pair (profile shifts added, mm). */
export function gearCentreDistance(a: SpurGearSpec, b: SpurGearSpec) {
  const shift =
    a.profile !== 'cycloidal' && b.profile !== 'cycloidal'
      ? (a.profileShift + b.profileShift) * a.module
      : 0;
  return (a.module * (a.teeth + b.teeth)) / 2 + shift;
}

/** What the pair needs in the solved assembly: problems, or the coupling that meshes it. */
export type CadGearMeshCheck =
  | {
      status: 'ok';
      coupling: Omit<CadJointCoupling, 'of'> & { of: 'angle' };
      /** The driven gear's pitch (rad). */
      pitch: number;
    }
  | { status: 'problem'; problems: CadGearMeshProblem[] };

/**
 * Checks a pair of gears where the solve put them, and the coupling that meshes them: the
 * driven joint's angle = `ratio` × the driver's + `offset`. `ratio` is −z(driver)/z(driven)
 * with each joint's sense against the gears' common axis; `offset` turns the driven gear by
 * less than half its pitch from where it stands, so a tooth of one faces a gap of the other.
 */
export function checkGearMesh(
  doc: CadDocument,
  mesh: Pick<CadGearMesh, 'driver' | 'driven'>,
  solve: {
    poses: Readonly<Record<string, CadSolvedPose>>;
    joints: Readonly<Record<string, CadJointSolution>>;
  },
  lookup: CadPartLookup,
): CadGearMeshCheck {
  const problems: CadGearMeshProblem[] = [];
  const sides = (['driver', 'driven'] as const).map((side) => {
    const s = mesh[side];
    const g = placeGear(doc, s, solve.poses, solve.joints[s.joint], lookup);
    if (typeof g === 'string') problems.push({ code: g, side });
    return g;
  });
  const [a, b] = sides;
  if (typeof a === 'string' || typeof b === 'string') return { status: 'problem', problems };
  // The fixed-frame ratio holds only while neither joint's frame is carried by the other joint.
  // Only the joints in effect place parts (as the pose solver reads them): a mount's other
  // candidates carry nothing.
  const placing = activeJoints(doc);
  const carried = (by: string, joint: string) => {
    const moved = new Set<string>();
    const start = doc.joints.find((j) => j.id === by)!.child.componentId;
    moved.add(start);
    for (let grew = true; grew; ) {
      grew = false;
      for (const j of placing) {
        const root = j.parent.componentPath[0];
        if (root !== undefined && moved.has(root) && !moved.has(j.child.componentId)) {
          moved.add(j.child.componentId);
          grew = true;
        }
      }
    }
    const root = doc.joints.find((j) => j.id === joint)!.parent.componentPath[0];
    return root !== undefined && moved.has(root);
  };
  if (
    carried(mesh.driver.joint, mesh.driven.joint) ||
    carried(mesh.driven.joint, mesh.driver.joint)
  )
    return { status: 'problem', problems: [{ code: 'gear-mesh-frame' }] };
  const tol = cadGearMeshTolerance;
  const sinTol = Math.sin(tol.angleRad);
  for (const [side, g] of [
    ['driver', a],
    ['driven', b],
  ] as const) {
    const offAxis = norm(across(sub(g.centre, g.jointOrigin), g.jointAxis));
    if (norm(cross(g.axis, g.jointAxis)) > sinTol || offAxis > tol.axisMm)
      problems.push({ code: 'gear-mesh-off-axis', side });
  }
  if (norm(cross(a.axis, b.axis)) > sinTol) problems.push({ code: 'gear-mesh-axes' });
  if (Math.abs(a.spec.module - b.spec.module) > 1e-9 * a.spec.module)
    problems.push({ code: 'gear-mesh-module' });
  if ((a.spec.profile ?? 'involute') !== (b.spec.profile ?? 'involute'))
    problems.push({ code: 'gear-mesh-profile' });
  else if (
    a.spec.profile === 'cycloidal' &&
    b.spec.profile === 'cycloidal' &&
    (a.spec.matingTeeth !== b.spec.teeth || b.spec.matingTeeth !== a.spec.teeth)
  )
    problems.push({ code: 'gear-mesh-mating' });
  else if (
    a.spec.profile !== 'cycloidal' &&
    b.spec.profile !== 'cycloidal' &&
    Math.abs(a.spec.pressureAngle - b.spec.pressureAngle) > 1e-9
  )
    problems.push({ code: 'gear-mesh-pressure-angle' });
  const n = a.axis;
  const between = across(sub(b.centre, a.centre), n);
  const distance = norm(between);
  const expected = gearCentreDistance(a.spec, b.spec);
  if (Math.abs(distance - expected) > tol.distanceMm)
    problems.push({
      code: 'gear-mesh-distance',
      distanceMm: Math.round(distance * 1e6) / 1e6,
      expectedMm: Math.round(expected * 1e6) / 1e6,
    });
  // Along the axis: each face spans from its back face by its width along its own axis.
  const span = (g: PlacedGear) => {
    const s = dot(g.centre, n);
    const e = s + g.faceWidth * Math.sign(dot(g.axis, n));
    return [Math.min(s, e), Math.max(s, e)] as const;
  };
  const [a0, a1] = span(a);
  const [b0, b1] = span(b);
  if (!(Math.min(a1, b1) - Math.max(a0, b0) > 1e-9)) problems.push({ code: 'gear-mesh-face' });
  // Each tip clears the other's root circle where they stand.
  const tip = (g: PlacedGear) => spurGearFlankEnd(g.spec).radius;
  const root = (g: PlacedGear) => spurGearRadii(g.spec).root;
  if (distance - tip(a) - root(b) < 0 || distance - tip(b) - root(a) < 0)
    problems.push({ code: 'gear-mesh-clearance' });
  // Cycloidal teeth (thickness a share of the pitch) must leave a gap for each other.
  if (
    a.spec.profile === 'cycloidal' &&
    b.spec.profile === 'cycloidal' &&
    a.spec.toothThickness + b.spec.toothThickness > 1
  )
    problems.push({ code: 'gear-mesh-backlash' });
  if (problems.length) return { status: 'problem', problems };
  // About the driver's axis `n`: turning the driver by δ turns the driven by −δ·za/zb.
  const za = a.spec.teeth;
  const zb = b.spec.teeth;
  const senseA = Math.sign(dot(a.jointAxis, n));
  const senseB = Math.sign(dot(b.jointAxis, n));
  const ratio = (-za / zb) * senseA * senseB;
  // Tooth 0 of each, measured about `n` from the line of centres.
  const u = unit(between);
  const tooth = (g: PlacedGear) => {
    // A gear facing the other way measures its teeth the other way round.
    const t = across(g.tooth, n);
    return angleAbout(u, unit(t), n);
  };
  const pitchB = (2 * Math.PI) / zb;
  // When a tooth of the driver lies on the line of centres, a gap of the driven faces it.
  const want = Math.PI + pitchB / 2 - (za / zb) * tooth(a);
  const turn = wrap(want - tooth(b), pitchB);
  const values = coupledJointValues(doc, parameterValues(doc));
  const driver = values.get(mesh.driver.joint)?.angle ?? 0;
  const driven = values.get(mesh.driven.joint)?.angle ?? 0;
  const offset = driven + turn * senseB - ratio * driver;
  return {
    status: 'ok',
    coupling: { of: 'angle', from: { joint: mesh.driver.joint, of: 'angle' }, ratio, offset },
    pitch: pitchB,
  };
}

/**
 * Each mesh's problems where the solve put the gears, by mesh ID (none listed when it checks):
 * the gears as for registering it, and its stored coupling's ratio against the teeth.
 */
export function gearMeshProblems(
  doc: CadDocument,
  solve: Parameters<typeof checkGearMesh>[2],
  lookup: CadPartLookup,
): Map<string, CadGearMeshProblem[]> {
  const out = new Map<string, CadGearMeshProblem[]>();
  for (const mesh of doc.gearMeshes ?? []) {
    const check = checkGearMesh(doc, mesh, solve, lookup);
    if (check.status === 'problem') {
      out.set(mesh.id, check.problems);
      continue;
    }
    const stored = meshCoupling(doc, mesh);
    const r = check.coupling.ratio;
    if (!stored || Math.abs(stored.ratio - r) > cadGearMeshTolerance.ratio * Math.abs(r))
      out.set(mesh.id, [{ code: 'gear-mesh-ratio' }]);
    // Where they stand, the driven gear should need no turn: its offset is the stored one.
    else if (
      Math.abs(check.coupling.offset - stored.offset) >
      cadGearMeshTolerance.phase * check.pitch
    )
      out.set(mesh.id, [{ code: 'gear-mesh-phase' }]);
  }
  return out;
}

/** The driven joint's angle coupling a mesh owns, if it is there. */
export function meshCoupling(
  doc: Pick<CadDocument, 'joints'>,
  mesh: Pick<CadGearMesh, 'driver' | 'driven'>,
): CadJointCoupling | undefined {
  const joint = doc.joints.find((j) => j.id === mesh.driven.joint);
  return joint?.couplings?.find(
    (c) => c.of === 'angle' && c.from.joint === mesh.driver.joint && c.from.of === 'angle',
  );
}
/** Whether a joint's coupling of `of` belongs to a mesh (shown and removed with it). */
export const meshOwnsCoupling = (
  doc: Pick<CadDocument, 'gearMeshes'>,
  joint: Pick<CadJoint, 'id'>,
  of: string,
) => of === 'angle' && (doc.gearMeshes ?? []).some((m) => m.driven.joint === joint.id);

export type CadGearMeshOperation =
  /** A mesh with the coupling `checkGearMesh` gave: the driven angle leaves its values. */
  | {
      type: 'insertGearMesh';
      mesh: CadGearMesh;
      coupling: { ratio: number; offset: number };
    }
  /** The mesh and its coupling removed; the driven joint keeps `angle` (its current value, rad). */
  | { type: 'removeGearMesh'; meshId: string; angle: number }
  /** The coupling `checkGearMesh` gives again (after a version with other teeth). */
  | { type: 'updateGearMesh'; meshId: string; coupling: { ratio: number; offset: number } };

const fail = (code: string): never => {
  throw new Error(code);
};

export function applyGearMeshOperation(next: CadDocument, op: CadGearMeshOperation) {
  switch (op.type) {
    case 'insertGearMesh': {
      const { mesh } = op;
      const joint = next.joints.find((j) => j.id === mesh.driven.joint) ?? fail('target-missing');
      if (joint.couplings?.some((c) => c.of === 'angle')) fail('gear-mesh-coupled');
      const values = { ...joint.values };
      delete values.angle;
      joint.values = values;
      joint.couplings = [
        ...(joint.couplings ?? []),
        { of: 'angle', from: { joint: mesh.driver.joint, of: 'angle' }, ...op.coupling },
      ];
      next.gearMeshes = [...(next.gearMeshes ?? []), mesh];
      return next;
    }
    case 'removeGearMesh': {
      const mesh = next.gearMeshes?.find((m) => m.id === op.meshId) ?? fail('target-missing');
      const joint = next.joints.find((j) => j.id === mesh.driven.joint);
      if (joint) {
        const rest = (joint.couplings ?? []).filter((c) => c.of !== 'angle');
        if (rest.length) joint.couplings = rest;
        else delete joint.couplings;
        joint.values = { ...joint.values, angle: { literalRad: op.angle } };
      }
      const kept = next.gearMeshes!.filter((m) => m.id !== op.meshId);
      if (kept.length) next.gearMeshes = kept;
      else delete next.gearMeshes;
      return next;
    }
    case 'updateGearMesh': {
      const mesh = next.gearMeshes?.find((m) => m.id === op.meshId) ?? fail('target-missing');
      const c = meshCoupling(next, mesh) ?? fail('gear-mesh-coupling');
      c.ratio = op.coupling.ratio;
      c.offset = op.coupling.offset;
      return next;
    }
  }
}

/** Meshes whose joints are gone are dropped (a deleted joint takes its meshes). */
export function pruneGearMeshes(doc: CadDocument) {
  if (!doc.gearMeshes) return;
  const ids = new Set(doc.joints.map((j) => j.id));
  const kept = doc.gearMeshes.filter((m) => ids.has(m.driver.joint) && ids.has(m.driven.joint));
  if (kept.length) doc.gearMeshes = kept;
  else delete doc.gearMeshes;
}

type Rec = Record<string, unknown>;
const record = (v: unknown): v is Rec =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
export interface GearMeshCheck {
  error(code: string, path: string): boolean;
  keys(v: Rec, required: string[], path: string): boolean;
  id(v: unknown, path: string): v is string;
  name(v: unknown, path: string): boolean;
}
/**
 * The shape of `gearMeshes` (1–256 when present): two different revolute joints, each joint
 * driven by one mesh at most, and the driven joint's angle following the driver's angle (the
 * mesh's coupling). The gears themselves are checked where the joints solve (`gearMeshProblems`).
 */
export function validateGearMeshes(
  c: GearMeshCheck,
  list: unknown,
  joints: readonly unknown[],
  /** An ID's shape, without claiming it: both sides may name one feature of a shared part. */
  isId: (v: unknown) => boolean,
) {
  const path = '$.gearMeshes';
  if (!Array.isArray(list) || list.length === 0) return c.error('gear-meshes', path);
  if (list.length > cadGearMeshLimits.meshes) c.error('limit-gear-meshes', path);
  const byId = new Map<string, Rec>();
  for (const j of joints) if (record(j) && typeof j.id === 'string') byId.set(j.id, j);
  const driven = new Set<string>();
  list.forEach((m, i) => {
    const at = `${path}[${i}]`;
    if (!record(m) || !c.keys(m, ['id', 'name', 'driver', 'driven'], at))
      return c.error('gear-mesh', at);
    c.id(m.id, `${at}.id`);
    c.name(m.name, `${at}.name`);
    const side = (k: 'driver' | 'driven') => {
      const s = m[k];
      const sp = `${at}.${k}`;
      if (!record(s) || !c.keys(s, ['joint', 'feature'], sp)) return void c.error('gear-mesh', sp);
      if (!isId(s.feature)) c.error('gear-mesh', `${sp}.feature`);
      const j = typeof s.joint === 'string' ? byId.get(s.joint) : undefined;
      if (!j || j.type !== 'revolute') return void c.error('gear-mesh-joint', `${sp}.joint`);
      return { id: s.joint as string, joint: j };
    };
    const a = side('driver');
    const b = side('driven');
    if (!a || !b) return;
    if (a.id === b.id) return c.error('gear-mesh-joint', `${at}.driven.joint`);
    if (driven.has(b.id)) return c.error('gear-mesh-driven-twice', `${at}.driven.joint`);
    driven.add(b.id);
    const couplings = Array.isArray(b.joint.couplings) ? b.joint.couplings : [];
    const owned = couplings.some(
      (x) =>
        record(x) &&
        x.of === 'angle' &&
        record(x.from) &&
        x.from.joint === a.id &&
        x.from.of === 'angle',
    );
    if (!owned) c.error('gear-mesh-coupling', `${at}.driven.joint`);
  });
}

/**
 * WM2: each joint angle that follows `from`'s angle (through meshes and other angle couplings,
 * MR1), with how many turns it makes for one turn of `from` (signed), in the joints' order.
 */
export function gearTrainRatios(
  doc: Pick<CadDocument, 'joints'>,
  from: string,
): { joint: string; of: GearTrainAngle; ratio: number }[] {
  // Nodes are (joint, angular value) pairs, so a chain may pass through a universal or
  // spherical joint's second or third angle.
  const angular = (k: string): k is GearTrainAngle =>
    k === 'angle' || k === 'angle2' || k === 'angle3';
  const node = (joint: string, of: GearTrainAngle) => `${joint}\u0000${of}`;
  const followers = new Map<string, { joint: string; of: GearTrainAngle; ratio: number }[]>();
  for (const j of doc.joints)
    for (const c of j.couplings ?? [])
      if (angular(c.of) && angular(c.from.of)) {
        const key = node(c.from.joint, c.from.of);
        followers.set(key, [
          ...(followers.get(key) ?? []),
          { joint: j.id, of: c.of, ratio: c.ratio },
        ]);
      }
  const start = node(from, 'angle');
  const ratio = new Map<string, { joint: string; of: GearTrainAngle; ratio: number }>([
    [start, { joint: from, of: 'angle', ratio: 1 }],
  ]);
  const queue = [start];
  while (queue.length) {
    const at = ratio.get(queue.shift()!)!;
    for (const f of followers.get(node(at.joint, at.of)) ?? []) {
      const key = node(f.joint, f.of);
      if (!ratio.has(key)) {
        ratio.set(key, { joint: f.joint, of: f.of, ratio: at.ratio * f.ratio });
        queue.push(key);
      }
    }
  }
  return doc.joints.flatMap((j) =>
    (['angle', 'angle2', 'angle3'] as const).flatMap((of) => {
      const r = ratio.get(node(j.id, of));
      return r && !(j.id === from && of === 'angle') ? [r] : [];
    }),
  );
}
export type GearTrainAngle = 'angle' | 'angle2' | 'angle3';
