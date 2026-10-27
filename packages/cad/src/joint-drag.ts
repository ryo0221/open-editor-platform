/**
 * R2b-2c dragging a joint's value in the viewport (docs/cad/r2b-assembly.md, Surface・joint値):
 * the pointer moves the child only along the joint's freedoms, from the solved connector frames
 * and never a kernel. A revolute joint turns about its parent connector's z, a slider moves along
 * it; a cylindrical joint turns (Shift: moves along z), a planar one moves in its plane (Shift:
 * turns). Values stop at the joint's limits; release rounds them and is one edit.
 */
import {
  cadJointLimits,
  cadJointValueKeys,
  jointValues,
  mm,
  parameterValues,
  rotateVector,
  type CadDocument,
  type CadJoint,
  type CadJointSolution,
  type CadJointValueKey,
  type CadJointValues,
  type Vec3,
} from '@editor-platform/cad-core';
import { jointValueBound } from './joint-values';

/** A pointer's ray in assembly coordinates (mm), as the viewport casts it. */
export interface CadDragRay {
  origin: Vec3;
  direction: Vec3;
}
type Values = Partial<Record<CadJointValueKey, number>>;
/** sin(10°): below this angle between a ray and the drag's plane (or above it to the axis) no drag starts. */
const minElevation = Math.sin((10 * Math.PI) / 180);

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + k * b[0], a[1] + k * b[1], a[2] + k * b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: Vec3): Vec3 => {
  const k = Math.hypot(...a) || 1;
  return [a[0] / k, a[1] / k, a[2] / k];
};

/** The keys one drag changes: the joint type's freedoms, the alternate one with Shift. */
export function dragKeys(type: CadJoint['type'], alternate: boolean): CadJointValueKey[] {
  switch (type) {
    case 'revolute':
      return ['angle'];
    case 'slider':
      return ['distance'];
    case 'cylindrical':
      return alternate ? ['distance'] : ['angle'];
    case 'planar':
      return alternate ? ['angle'] : ['u', 'v'];
    case 'fastened':
      return [];
  }
}

export interface CadJointDrag {
  joint: CadJoint;
  keys: CadJointValueKey[];
  /** The resolved values when the drag started. */
  start: Values;
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
  /** The plane the pointer moves on (through the grabbed point, normal z), or the axis for a distance. */
  grab: Vec3;
  /** An angle drag: the last direction from the axis, and the turn so far (unwrapped). */
  last?: Vec3;
  turned: number;
  /** A distance drag: the axis parameter where it started. */
  at?: number;
}
export type CadJointDragStart =
  | { status: 'ok'; drag: CadJointDrag }
  /** Not solved here (its preview reads the solved frames), or the type has no freedom. */
  | { status: 'unsolved' | 'fixed' }
  /** A value is a parameter or an expression: it is changed there. */
  | { status: 'bound' }
  /** The view looks along the drag's plane (or along the axis): no well-defined motion. */
  | { status: 'edge-on' };

/** The point where `ray` meets the plane through `p` with normal `n`, or undefined. */
function onPlane(ray: CadDragRay, p: Vec3, n: Vec3): Vec3 | undefined {
  const d = dot(ray.direction, n);
  if (Math.abs(d) < 1e-12) return undefined;
  const t = dot(sub(p, ray.origin), n) / d;
  return t < 0 ? undefined : add(ray.origin, ray.direction, t);
}
/** The parameter along the axis `o + t·z` nearest to `ray`. */
function onAxis(ray: CadDragRay, o: Vec3, z: Vec3): number | undefined {
  const d = unit(ray.direction);
  const w = sub(o, ray.origin);
  const b = dot(z, d);
  const den = 1 - b * b;
  if (den < 1e-12) return undefined;
  return (b * dot(w, d) - dot(w, z)) / den;
}

/**
 * Starts a drag of `joint` from where the pointer grabbed its child (`grab`, on the child's
 * surface). `alternate` is Shift held at the start.
 */
export function startJointDrag(
  doc: Pick<CadDocument, 'parameters'>,
  joint: CadJoint,
  solution: CadJointSolution | undefined,
  ray: CadDragRay,
  grab: Vec3,
  alternate: boolean,
): CadJointDragStart {
  if (solution?.status !== 'solved') return { status: 'unsolved' };
  const keys = dragKeys(joint.type, alternate);
  if (!keys.length) return { status: 'fixed' };
  if (keys.some((k) => jointValueBound(joint, k))) return { status: 'bound' };
  const { translationMm: origin, rotation } = solution.parent;
  const [x, y, z] = [
    rotateVector(rotation, [1, 0, 0]),
    rotateVector(rotation, [0, 1, 0]),
    rotateVector(rotation, [0, 0, 1]),
  ];
  const dir = unit(ray.direction);
  const start = jointValues(joint, parameterValues(doc));
  // A planar joint turns about its child's connector, moved by (u, v) in the parent's plane.
  const centre =
    joint.type === 'planar' && keys[0] === 'angle'
      ? add(add(origin, x, start.u ?? 0), y, start.v ?? 0)
      : origin;
  const drag: CadJointDrag = { joint, keys, start, origin: centre, x, y, z, grab, turned: 0 };
  if (keys[0] === 'distance') {
    // Along the axis: a ray nearly parallel to it gives no well-defined point on it.
    if (Math.abs(dot(dir, z)) > Math.cos(Math.asin(minElevation))) return { status: 'edge-on' };
    const at = onAxis(ray, origin, z);
    if (at === undefined) return { status: 'edge-on' };
    drag.at = at;
    return { status: 'ok', drag };
  }
  if (Math.abs(dot(dir, z)) < minElevation) return { status: 'edge-on' };
  if (keys[0] === 'angle') {
    const from = sub(grab, add(centre, z, dot(sub(grab, centre), z)));
    // A grab on the axis itself has no direction to turn from.
    if (Math.hypot(...from) < 1e-6) return { status: 'edge-on' };
    drag.last = unit(from);
  }
  return { status: 'ok', drag };
}

/** Each value clamped to the joint's limits (and an angle to one turn either way). */
export function clampJointValues(joint: CadJoint, values: Values): Values {
  const out: Values = {};
  for (const [k, v] of Object.entries(values) as [CadJointValueKey, number][]) {
    let n = v;
    if (k === 'angle') n = Math.min(cadJointLimits.angleRad, Math.max(-cadJointLimits.angleRad, n));
    const l = joint.limits.find((x) => x.of === k);
    if (l) n = Math.min(l.max, Math.max(l.min, n));
    out[k] = n;
  }
  return out;
}

/**
 * The values for the pointer's current ray, clamped, or undefined to keep the last ones (a ray
 * toward the horizon of the drag's plane).
 */
export function moveJointDrag(drag: CadJointDrag, ray: CadDragRay): Values | undefined {
  const { joint, start, origin, x, y, z, grab } = drag;
  const dir = unit(ray.direction);
  const values: Values = { ...start };
  if (drag.keys[0] === 'distance') {
    const at = onAxis(ray, origin, z);
    if (at === undefined || Math.abs(dot(dir, z)) > Math.cos(Math.asin(minElevation)))
      return undefined;
    values.distance = (start.distance ?? 0) + at - drag.at!;
    return clampJointValues(joint, values);
  }
  if (Math.abs(dot(dir, z)) < minElevation) return undefined;
  const p = onPlane(ray, grab, z);
  if (!p) return undefined;
  if (drag.keys[0] === 'angle') {
    const from = sub(p, add(origin, z, dot(sub(p, origin), z)));
    if (Math.hypot(...from) < 1e-6) return undefined;
    const now = unit(from);
    // Unwrapped: each move adds the turn since the last one, so a drag may pass half a turn.
    drag.turned += Math.atan2(dot(cross(drag.last!, now), z), dot(drag.last!, now));
    drag.last = now;
    values.angle = (start.angle ?? 0) + drag.turned;
    return clampJointValues(joint, values);
  }
  const moved = sub(p, grab);
  values.u = (start.u ?? 0) + dot(moved, x);
  values.v = (start.v ?? 0) + dot(moved, y);
  return clampJointValues(joint, values);
}

/**
 * The stored values a release writes: the dragged ones rounded (0.01 mm, 0.01°) and clamped
 * again; the others keep their stored form. Undefined when the drag did not move them.
 */
export function releasedJointValues(
  drag: CadJointDrag,
  values: Values,
): CadJointValues | undefined {
  const { joint } = drag;
  if (drag.keys.every((k) => Math.abs((values[k] ?? 0) - (drag.start[k] ?? 0)) < 1e-9))
    return undefined;
  const rounded: Values = {};
  for (const k of drag.keys) {
    const v = values[k] ?? 0;
    rounded[k] =
      k === 'angle'
        ? (Math.round(((v * 180) / Math.PI) * 100) / 100 / 180) * Math.PI
        : Math.round(v * 100) / 100;
  }
  const clamped = clampJointValues(joint, rounded);
  const out: CadJointValues = {};
  for (const k of cadJointValueKeys[joint.type]) {
    const v = clamped[k];
    if (v === undefined) {
      if (joint.values[k]) (out as Record<string, unknown>)[k] = joint.values[k];
      continue;
    }
    if (k === 'angle') out.angle = { literalRad: v };
    else out[k] = mm(v);
  }
  return out;
}
