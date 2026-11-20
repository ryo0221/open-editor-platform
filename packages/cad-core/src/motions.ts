/**
 * #18 motions: an assembly's form-to-form animations, kept in the document. A motion starts in
 * one saved form (MR2) and moves to the next form of each step over the step's duration with its
 * easing; every moving joint value is interpolated between the two forms (in radians and mm, as
 * the forms store them, so a joint turns through its range and never wraps). A mount (MR7)
 * switches to the next form's joint when the step ends. Camera keys (position, target, up, field
 * of view) at times along the motion give the camera path; between keys the position and target
 * follow a Catmull-Rom curve through the keys, the field of view changes linearly.
 *
 * Only the shape is validated with the document. A motion whose forms are gone or stale is shown
 * stale and cannot be played or exported until its steps are changed.
 */
import { composePoses, componentCopies, stepPose, type CadSolvedPose } from './assembly';
import { configurationStale, type CadConfiguration } from './configurations';
import { parameterValues } from './graph';
import {
  invertPose,
  jointValues,
  ownJointValueKeys,
  posesForJointValues,
  type CadJointSolution,
  type CadResolvedJointValues,
} from './joints';
import type { CadCamera, CadDocument, Vec3 } from './model';
import { mountChoice } from './mounts';

export type CadMotionEasing = 'linear' | 'easeInOut';
export const cadMotionEasings: readonly CadMotionEasing[] = Object.freeze(['linear', 'easeInOut']);
export interface CadMotionStep {
  /** The form reached at the end of the step. */
  formId: string;
  durationMs: number;
  easing: CadMotionEasing;
}
export interface CadMotionCameraKey {
  /** Time from the start of the motion. */
  atMs: number;
  camera: CadCamera;
  /** Vertical field of view (perspective). */
  fovRad: number;
}
export interface CadMotion {
  id: string;
  name: string;
  /** The form the motion starts in. */
  startFormId: string;
  steps: CadMotionStep[];
  /** In time order, at distinct times within the motion; absent: the camera is left as it is. */
  camera?: CadMotionCameraKey[];
}
export const cadMotionLimits = Object.freeze({
  motions: 32,
  steps: 64,
  cameraKeys: 64,
  minStepMs: 1,
  maxStepMs: 600_000,
  /** A whole motion (one hour). */
  maxDurationMs: 3_600_000,
  /** Any camera coordinate within ±this (mm). */
  coordinate: 1e9,
});

export type CadMotionsOperation = {
  type: 'setMotions';
  /** The whole list; empty removes it. */
  motions: CadMotion[];
};
export function applyMotionsOperation(next: CadDocument, op: CadMotionsOperation) {
  if (JSON.stringify(next.motions ?? []) === JSON.stringify(op.motions))
    throw new Error('motions-unchanged');
  if (op.motions.length) next.motions = structuredClone(op.motions);
  else delete next.motions;
  return next;
}

export const motionDurationMs = (m: Pick<CadMotion, 'steps'>) =>
  m.steps.reduce((t, s) => t + s.durationMs, 0);

/** `u` (0–1) through an easing. */
export function ease(easing: CadMotionEasing, u: number) {
  const x = Math.min(1, Math.max(0, u));
  return easing === 'linear' ? x : (1 - Math.cos(Math.PI * x)) / 2;
}

/**
 * Where a motion is at `tMs` (clamped to the motion): the form it comes from, the form it goes
 * to and how far (eased, 0–1). At a step's end the next step starts; at the very end `u` is 1.
 */
export function motionSegmentAt(m: Pick<CadMotion, 'startFormId' | 'steps'>, tMs: number) {
  const total = motionDurationMs(m);
  const t = Math.min(total, Math.max(0, tMs));
  let from = m.startFormId;
  let start = 0;
  for (let i = 0; i < m.steps.length; i++) {
    const s = m.steps[i]!;
    const last = i === m.steps.length - 1;
    if (t < start + s.durationMs || last)
      return { step: i, from, to: s.formId, u: ease(s.easing, (t - start) / s.durationMs) };
    from = s.formId;
    start += s.durationMs;
  }
  return { step: -1, from, to: from, u: 1 };
}

/** The forms a motion names that are gone or no longer fit the joints. */
export function motionStaleForms(doc: CadDocument, m: Pick<CadMotion, 'startFormId' | 'steps'>) {
  const forms = new Map((doc.configurations ?? []).map((f) => [f.id, f]));
  const ids = [...new Set([m.startFormId, ...m.steps.map((s) => s.formId)])];
  return ids.filter((id) => {
    const f = forms.get(id);
    return !f || configurationStale(doc, f);
  });
}

const formValues = (doc: CadDocument, form: CadConfiguration) => {
  const params = parameterValues(doc);
  const out = new Map<string, CadResolvedJointValues>();
  for (const j of doc.joints) {
    const v = form.values[j.id];
    if (v) out.set(j.id, jointValues({ type: j.type, values: v }, params));
  }
  return out;
};

/**
 * Every moving joint's own values at `tMs` (radians, mm) and each mount's joint in effect, or
 * undefined when a form the motion passes is gone or stale.
 */
export function motionStateAt(doc: CadDocument, m: CadMotion, tMs: number) {
  if (motionStaleForms(doc, m).length) return undefined;
  const forms = new Map((doc.configurations ?? []).map((f) => [f.id, f]));
  const seg = motionSegmentAt(m, tMs);
  const a = forms.get(seg.from)!;
  const b = forms.get(seg.to)!;
  const [va, vb] = [formValues(doc, a), formValues(doc, b)];
  const values = new Map<string, CadResolvedJointValues>();
  for (const j of doc.joints) {
    const x = va.get(j.id);
    const y = vb.get(j.id);
    if (!x || !y) continue;
    const v: CadResolvedJointValues = {};
    for (const k of ownJointValueKeys(j)) v[k] = lerp(x[k] ?? 0, y[k] ?? 0, seg.u);
    values.set(j.id, v);
  }
  const mounts = seg.u >= 1 ? b.mounts : a.mounts;
  return { values, ...(mounts ? { mounts } : {}), segment: seg };
}

/**
 * Each placed component's (and pattern copy's) motion from where the assembly shows it (its
 * solved poses) to where the joint values put it, by first path step; steps that do not move
 * are left out.
 */
export function motionDeltas(
  doc: CadDocument,
  joints: Record<string, CadJointSolution>,
  values: ReadonlyMap<string, CadResolvedJointValues>,
  mounts?: Record<string, string>,
): Map<string, CadSolvedPose> {
  const params = parameterValues(doc);
  const shown = doc.solvedPoses;
  const poses = posesForJointValues(
    doc,
    { poses: shown, joints },
    values,
    params,
    mountChoice(mounts ?? Object.fromEntries((doc.mounts ?? []).map((x) => [x.id, x.active]))),
  );
  const copies = componentCopies(doc, params);
  const steps = doc.components.flatMap((c) => [
    c.id,
    ...(copies.get(c.id) ?? []).map((x) => x.step),
  ]);
  const out = new Map<string, CadSolvedPose>();
  for (const step of steps) {
    const now = stepPose(doc, poses, step, params);
    const was = stepPose(doc, shown, step, params);
    if (!now || !was) continue;
    const d = composePoses(now, invertPose(was));
    const moved =
      Math.hypot(...d.translationMm) > 1e-9 ||
      Math.abs(d.rotation[0]) + Math.abs(d.rotation[1]) + Math.abs(d.rotation[2]) > 1e-12;
    if (moved) out.set(step, d);
  }
  return out;
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const lerp3 = (a: Vec3, b: Vec3, u: number): Vec3 => [
  lerp(a[0], b[0], u),
  lerp(a[1], b[1], u),
  lerp(a[2], b[2], u),
];
/** Uniform Catmull-Rom between p1 and p2 (p0, p3 their neighbours). */
const catmull = (p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, u: number): Vec3 => {
  const u2 = u * u;
  const u3 = u2 * u;
  return [0, 1, 2].map(
    (i) =>
      0.5 *
      (2 * p1[i]! +
        (-p0[i]! + p2[i]!) * u +
        (2 * p0[i]! - 5 * p1[i]! + 4 * p2[i]! - p3[i]!) * u2 +
        (-p0[i]! + 3 * p1[i]! - 3 * p2[i]! + p3[i]!) * u3),
  ) as Vec3;
};
const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * The camera at `tMs` along a motion's keys: the first key's before it, the last key's after
 * it, and between keys a Catmull-Rom curve through them (position and target; a straight line between two), the up and the
 * field of view in between linearly. Undefined when the motion has no camera keys.
 */
export function motionCameraAt(
  keys: readonly CadMotionCameraKey[] | undefined,
  tMs: number,
): { camera: CadCamera; fovRad: number } | undefined {
  if (!keys?.length) return undefined;
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  const copy = (k: CadMotionCameraKey) => ({ camera: structuredClone(k.camera), fovRad: k.fovRad });
  if (tMs <= first.atMs) return copy(first);
  if (tMs >= last.atMs) return copy(last);
  let i = 0;
  while (keys[i + 1]!.atMs <= tMs) i++;
  const [k1, k2] = [keys[i]!, keys[i + 1]!];
  const [k0, k3] = [keys[i - 1], keys[i + 2]];
  const u = (tMs - k1.atMs) / (k2.atMs - k1.atMs);
  // A missing neighbour is the next key mirrored, so two keys give a straight line.
  const mirror = (a: Vec3, b: Vec3): Vec3 => [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
  const along = (f: (k: CadMotionCameraKey) => Vec3) =>
    catmull(k0 ? f(k0) : mirror(f(k1), f(k2)), f(k1), f(k2), k3 ? f(k3) : mirror(f(k2), f(k1)), u);
  return {
    camera: {
      position: along((k) => k.camera.position),
      target: along((k) => k.camera.target),
      up: unit(lerp3(unit(k1.camera.up), unit(k2.camera.up), u)),
    },
    fovRad: lerp(k1.fovRad, k2.fovRad, u),
  };
}

/** A camera key added (or replaced at the same time) in time order. */
export function withCameraKey(
  keys: readonly CadMotionCameraKey[] | undefined,
  key: CadMotionCameraKey,
) {
  const rest = (keys ?? []).filter((k) => k.atMs !== key.atMs);
  return [...rest, structuredClone(key)].sort((a, b) => a.atMs - b.atMs);
}

type Rec = Record<string, unknown>;
const record = (v: unknown): v is Rec =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const vec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) &&
  v.length === 3 &&
  v.every((x) => finite(x) && Math.abs(x) <= cadMotionLimits.coordinate);
export interface MotionsCheck {
  error(code: string, path: string): boolean;
  keys(v: Rec, required: string[], path: string, optional?: string[]): boolean;
  id(v: unknown, path: string): boolean;
  name(v: unknown, path: string): boolean;
}
/**
 * The shape of `motions`: 1–32 motions with distinct IDs, each with 1–64 steps of a known easing
 * and a duration within the limits (the whole motion at most an hour), and 1–64 camera keys at
 * increasing times within the motion, each with finite points, a view direction that is not
 * along the up and a field of view between 0 and π. Whether the forms exist is not checked here.
 */
export function validateMotions(c: MotionsCheck, list: unknown, isId: (v: unknown) => boolean) {
  const path = '$.motions';
  const L = cadMotionLimits;
  if (!Array.isArray(list) || !list.length || list.length > L.motions)
    return void c.error('motions', path);
  const ids = new Set<string>();
  list.forEach((m, i) => {
    const at = `${path}[${i}]`;
    if (!record(m)) return c.error('motion', at);
    c.keys(m, ['id', 'name', 'startFormId', 'steps'], at, ['camera']);
    if (c.id(m.id, `${at}.id`)) {
      if (ids.has(m.id as string)) c.error('duplicate-id', `${at}.id`);
      ids.add(m.id as string);
    }
    if (c.name(m.name, `${at}.name`) && (m.name as string).trim() === '')
      c.error('motion-name', `${at}.name`);
    if (!isId(m.startFormId)) c.error('motion-form', `${at}.startFormId`);
    let total = 0;
    if (!Array.isArray(m.steps) || !m.steps.length || m.steps.length > L.steps)
      c.error('motion-steps', `${at}.steps`);
    else
      m.steps.forEach((s, j) => {
        const sp = `${at}.steps[${j}]`;
        if (!record(s)) return c.error('motion-step', sp);
        c.keys(s, ['formId', 'durationMs', 'easing'], sp);
        if (!isId(s.formId)) c.error('motion-form', `${sp}.formId`);
        if (!finite(s.durationMs) || s.durationMs < L.minStepMs || s.durationMs > L.maxStepMs)
          c.error('motion-duration', `${sp}.durationMs`);
        else total += s.durationMs;
        if (!cadMotionEasings.includes(s.easing as CadMotionEasing))
          c.error('motion-easing', `${sp}.easing`);
      });
    if (total > L.maxDurationMs) c.error('motion-duration', `${at}.steps`);
    if (!Object.hasOwn(m, 'camera')) return;
    const keys = m.camera;
    if (!Array.isArray(keys) || !keys.length || keys.length > L.cameraKeys)
      return void c.error('motion-camera', `${at}.camera`);
    let before = -Infinity;
    keys.forEach((k, j) => {
      const kp = `${at}.camera[${j}]`;
      if (!record(k)) return c.error('motion-camera-key', kp);
      c.keys(k, ['atMs', 'camera', 'fovRad'], kp);
      if (!finite(k.atMs) || k.atMs < 0 || k.atMs <= before || k.atMs > total)
        c.error('motion-camera-time', `${kp}.atMs`);
      if (finite(k.atMs)) before = k.atMs;
      if (!finite(k.fovRad) || k.fovRad <= 0 || k.fovRad >= Math.PI)
        c.error('projection-fov', `${kp}.fovRad`);
      const cam = k.camera;
      if (!record(cam)) return c.error('camera', `${kp}.camera`);
      c.keys(cam, ['position', 'target', 'up'], `${kp}.camera`);
      if (!vec3(cam.position) || !vec3(cam.target) || !vec3(cam.up))
        return c.error('camera', `${kp}.camera`);
      const p = cam.position;
      const dir = (cam.target as Vec3).map((t, n) => t - p[n]!) as Vec3;
      const up = cam.up as Vec3;
      const cross = [
        dir[1] * up[2] - dir[2] * up[1],
        dir[2] * up[0] - dir[0] * up[2],
        dir[0] * up[1] - dir[1] * up[0],
      ];
      if (
        Math.hypot(...dir) < 1e-6 ||
        Math.hypot(...cross) <= 1e-12 * Math.hypot(...dir) * Math.hypot(...up)
      )
        c.error('camera-degenerate', `${kp}.camera`);
    });
  });
}
