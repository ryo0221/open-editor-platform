import {
  cfcFilter,
  intrusion,
  occupantLoadCriterion,
  resample,
  standardGravity,
  type OlcResult,
} from './crash-metrics';
import type { ExplicitModel, ExplicitResult } from './explicit';

/**
 * VS7b (docs/cad/vehicle-simulation.md, VS7): crash test set-ups on an explicit model of a
 * vehicle and the measures read back from its run. The vehicle frame is the analysis one: x from
 * the tail forward (the nose at the largest x), y to the left, z up; mm, t, s.
 *
 * - `wall`: a full-width fixed rigid wall square to x just ahead of the nose; the vehicle moves
 *   forward at `speed`.
 * - `pole`: a fixed vertical rigid pole (`diameter`, 254 mm by default) on one side (`side`); the
 *   vehicle moves at `angleDeg` (75° by default) to its long axis, towards that side, along the
 *   line through the pole's axis and the point `at` (x, z) on that side (a seat's head point).
 *
 * The barrier starts `gap` (1 mm by default) clear of the nearest contact surface (a node's
 * midsurface offset by half its thickest shell). With gravity, the ground is a fixed wall `gap`
 * below the lowest contact surface.
 */
export type CrashBarrier =
  | { kind: 'wall' }
  | {
      kind: 'pole';
      /** mm, 254 by default. */
      diameter?: number;
      /** The travel's angle to the vehicle's long axis (degrees), 75 by default. */
      angleDeg?: number;
      side: 'left' | 'right';
      /** The impact line's point on the struck side: its x and z (mm). */
      at: [number, number];
    };

export interface CrashSetupOptions {
  barrier: CrashBarrier;
  /** mm/s */
  speed: number;
  gravity?: boolean;
  /** mm, 1 by default. */
  gap?: number;
  /** Coulomb friction on the barrier and the ground (0 by default). */
  friction?: number;
}

export interface CrashSetup {
  model: ExplicitModel;
  /** The unit direction of travel. */
  direction: [number, number, number];
  /** The barrier among the model's walls or poles (the ground is another wall). */
  barrier: { kind: 'wall' | 'pole'; index: number };
}

/** Crash speeds of the plan (km/h), and km/h in mm/s. */
export const crashSpeeds = { wall: 56, pole: 32 } as const;
export const kmhToMmPerS = 1_000_000 / 3_600;

function refuse(detail: string): never {
  throw new RangeError(`crashSetup: ${detail}`);
}

/** The model with the barrier, the initial velocity on every node and body, and gravity. */
export function crashSetup(model: ExplicitModel, options: CrashSetupOptions): CrashSetup {
  const { barrier, speed } = options;
  const gap = options.gap ?? 1;
  const friction = options.friction ?? 0;
  if (!(speed > 0) || !Number.isFinite(speed)) refuse('the speed must be positive');
  if (!(gap > 0) || !Number.isFinite(gap)) refuse('the gap must be positive');
  if (!(friction >= 0) || !Number.isFinite(friction)) refuse('the friction must be 0 or more');
  if (model.fixed?.some((b) => b !== 0)) refuse('a vehicle in a crash test has no held nodes');
  if (model.rigidBodies?.some((b) => b.held))
    refuse('a vehicle in a crash test has no held bodies');
  const n = model.nodes.length / 3;
  if (!n) refuse('the model has no nodes');
  const x = model.nodes;
  // Each node's contact half thickness (the thickest of its shells', as the contact takes it;
  // 0 off the shells): the barriers stand clear of the contact surfaces, not the midsurface.
  const half = new Float64Array(n);
  for (let e = 0; e < model.thickness.length; e++)
    for (let c = 0; c < 4; c++) {
      const i = model.shells[4 * e + c]!;
      half[i] = Math.max(half[i]!, model.thickness[e]! / 2);
    }
  let lowest = Infinity;
  for (let i = 0; i < n; i++) lowest = Math.min(lowest, x[3 * i + 2]! - half[i]!);

  let direction: [number, number, number];
  let struck: CrashSetup['barrier'];
  const walls = [...(model.walls ?? [])];
  const poles = [...(model.poles ?? [])];
  if (barrier.kind === 'wall') {
    direction = [1, 0, 0];
    let nose = -Infinity;
    for (let i = 0; i < n; i++) nose = Math.max(nose, x[3 * i]! + half[i]!);
    walls.push({ point: [nose + gap, 0, 0], normal: [-1, 0, 0], friction });
    struck = { kind: 'wall', index: walls.length - 1 };
  } else {
    const radius = (barrier.diameter ?? 254) / 2;
    const angle = barrier.angleDeg ?? 75;
    if (!(radius > 0) || !Number.isFinite(radius)) refuse('the pole diameter must be positive');
    if (!(angle > 0 && angle <= 90)) refuse('the pole angle must be over 0° and at most 90°');
    const a = (angle * Math.PI) / 180;
    const sign = barrier.side === 'left' ? 1 : -1;
    direction = [Math.cos(a), sign * Math.sin(a), 0];
    // The struck side's outermost y at the impact point's x, from the nodes near it.
    const [ax] = barrier.at;
    let side = -Infinity;
    for (let i = 0; i < n; i++)
      if (Math.abs(x[3 * i]! - ax) <= radius) side = Math.max(side, sign * x[3 * i + 1]!);
    if (side === -Infinity) refuse(`no node within the pole's radius of x = ${ax}`);
    const p0: [number, number] = [ax, sign * side];
    // The pole's axis on the line p0 + s·d, coming in from far ahead (large s): a node at w
    // from p0 (in plan) is within ρ = radius + gap + its half thickness for s in s± = w·d ± √((w·d)² − |w|² + ρ²), so
    // the first touch is at the largest s+ of all nodes (none: the line misses the vehicle).
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const wx = x[3 * i]! - p0[0];
      const wy = x[3 * i + 1]! - p0[1];
      const wd = wx * direction[0] + wy * direction[1];
      const rho = radius + gap + half[i]!;
      const disc = wd * wd - (wx * wx + wy * wy) + rho * rho;
      if (disc >= 0) hi = Math.max(hi, wd + Math.sqrt(disc));
    }
    if (hi === -Infinity) refuse('the pole line misses the vehicle');
    poles.push({
      point: [p0[0] + hi * direction[0], p0[1] + hi * direction[1], 0],
      axis: [0, 0, 1],
      radius,
      friction,
    });
    struck = { kind: 'pole', index: poles.length - 1 };
  }
  if (options.gravity) walls.push({ point: [0, 0, lowest - gap], normal: [0, 0, 1], friction });

  const v = direction.map((d) => d * speed) as [number, number, number];
  const velocity = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) velocity.set(v, 3 * i);
  return {
    direction,
    barrier: struck,
    model: {
      ...model,
      velocity,
      rotation: new Float64Array(3 * n),
      rigidBodies: model.rigidBodies?.map((b) => ({ ...b, velocity: v, rotation: [0, 0, 0] })),
      walls,
      poles,
      // The option alone sets gravity: one the model came with is replaced, or taken away.
      gravity: options.gravity
        ? ([0, 0, -standardGravity * 1000] as [number, number, number])
        : undefined,
    },
  };
}

export interface CrashMeasureOptions {
  /** The history node whose motion is the vehicle's (an accelerometer on the floor or the sill). */
  accelerometer: number;
  /** The unit direction of travel and the barrier (from `crashSetup`). */
  direction: [number, number, number];
  barrier: CrashSetup['barrier'];
  /** Named point pairs: p's displacement relative to q, along `axis` (or its length). */
  intrusions?: { name: string; p: number; q: number; axis?: [number, number, number] }[];
  /** Even sample step for the filters (s), 1e-5 by default (100 kHz). */
  sampleStep?: number;
}

export interface CrashMeasures {
  /** Even sample times (s) and the accelerometer's deceleration along the travel (g). */
  time: Float64Array;
  raw: Float64Array;
  cfc60: Float64Array;
  cfc180: Float64Array;
  /** Its velocity along the travel (m/s), from the CFC 180 deceleration. */
  velocity: Float64Array;
  peakG: { cfc60: number; cfc180: number };
  olc: OlcResult | null;
  /** How far the accelerometer moved along the travel after the barrier was first hit (mm). */
  crush: { max: number; end: number };
  /** Per intrusion: its value at each frame and the largest magnitude (mm). */
  intrusions: { name: string; frames: Float64Array; max: number }[];
  /** Per shell part: the internal energy at the end (N·mm = mJ), and its share of all parts. */
  parts: { part: number; energy: number; share: number }[];
  /** The barrier's impulse along the travel (N·s): the momentum it took (t·m/s = kN·s → ×1000). */
  barrierImpulse: number;
  /** The barrier's force along the travel (kN) at the history times (s). */
  barrierForce: { time: Float64Array; force: Float64Array };
}

/**
 * The measures of a crash run: the accelerometer's history (`historyNodes` must hold it) along
 * the travel, resampled evenly, its deceleration (positive slowing down) unfiltered and through
 * CFC 60 and 180, the velocity from the CFC 180 deceleration and its OLC; the crush, how far the
 * accelerometer moved along the travel after the barrier was first hit (largest and at the end);
 * intrusions on the frames; each part's internal energy at the last frame; the barrier's force
 * and impulse.
 */
export function crashMeasures(result: ExplicitResult, options: CrashMeasureOptions): CrashMeasures {
  const h = result.history.find((r) => r.node === options.accelerometer);
  if (!h) throw new RangeError(`crashMeasures: node ${options.accelerometer} has no history`);
  const [dx, dy, dz] = options.direction;
  const m = h.time.length;
  if (m < 3) throw new RangeError('crashMeasures: the history needs three samples or more');
  const along = (a: Float64Array, k: number) =>
    a[3 * k]! * dx + a[3 * k + 1]! * dy + a[3 * k + 2]! * dz;
  const vt = Float64Array.from({ length: m }, (_, k) => along(h.velocity, k) / 1000);
  const ut = Float64Array.from({ length: m }, (_, k) => along(h.displacement, k));
  const step = options.sampleStep ?? 1e-5;
  const even = resample(h.time, vt, step);
  const count = even.t.length;
  if (count < 3) throw new RangeError('crashMeasures: the run is shorter than three sample steps');
  // Deceleration (g) at the samples by central differences (one-sided at the ends).
  const raw = new Float64Array(count);
  for (let k = 0; k < count; k++) {
    const a = Math.max(0, k - 1);
    const b = Math.min(count - 1, k + 1);
    raw[k] = -(even.y[b]! - even.y[a]!) / ((b - a) * step) / standardGravity;
  }
  const cfc60 = cfcFilter(raw, step, 60);
  const cfc180 = cfcFilter(raw, step, 180);
  // The velocity from the CFC 180 deceleration (trapezoids from the first sample's velocity).
  const velocity = new Float64Array(count);
  velocity[0] = even.y[0]!;
  for (let k = 1; k < count; k++)
    velocity[k] = velocity[k - 1]! - ((cfc180[k - 1]! + cfc180[k]!) / 2) * standardGravity * step;
  const peak = (a: Float64Array) => a.reduce((p, q) => Math.max(p, q), -Infinity);
  // Crush: how far the vehicle has gone along the travel (mm), as a crush against a fixed
  // barrier is the distance the rest of the vehicle travels after the first contact.
  const hit = result.barriers.find(
    (b) => b.kind === options.barrier.kind && b.index === options.barrier.index,
  );
  if (!hit) throw new RangeError('crashMeasures: the run has no history of the barrier');
  const contactTime = firstContact(hit);
  let max = 0;
  let base = 0;
  if (contactTime !== null) {
    // From the displacement at the contact time (between samples when the history is sparse).
    const k0 = upper(h.time, contactTime);
    const ka = Math.max(0, k0 - 1);
    const span = h.time[k0]! - h.time[ka]!;
    const w = span > 0 ? (contactTime - h.time[ka]!) / span : 1;
    base = ut[ka]! + w * (ut[k0]! - ut[ka]!);
    for (let k = k0; k < m; k++) max = Math.max(max, ut[k]! - base);
  }
  const end = contactTime === null ? 0 : ut[m - 1]! - base;

  const frames = result.frames.map((f) => f.displacement);
  const intrusions = (options.intrusions ?? []).map((q) => {
    const values = intrusion(frames, q.p, q.q, q.axis);
    return {
      name: q.name,
      frames: values,
      max: values.reduce((p, v) => Math.max(p, Math.abs(v)), 0),
    };
  });
  const last = result.energies.at(-1);
  const energies = last?.parts ?? [];
  const total = energies.reduce((p, e) => p + Math.max(0, e), 0);
  const parts = energies.map((energy, part) => ({
    part,
    energy,
    share: total > 0 ? Math.max(0, energy) / total : 0,
  }));
  const force = Float64Array.from(
    { length: hit.time.length },
    (_, k) =>
      (hit.force[3 * k]! * dx + hit.force[3 * k + 1]! * dy + hit.force[3 * k + 2]! * dz) / 1000,
  );
  let barrierImpulse = 0;
  for (let k = 1; k < force.length; k++)
    barrierImpulse += ((force[k - 1]! + force[k]!) / 2) * 1000 * (hit.time[k]! - hit.time[k - 1]!);
  return {
    time: even.t,
    raw,
    cfc60,
    cfc180,
    velocity,
    peakG: { cfc60: peak(cfc60), cfc180: peak(cfc180) },
    olc: occupantLoadCriterion(even.t, velocity),
    crush: { max, end },
    intrusions,
    parts,
    barrierImpulse,
    barrierForce: { time: hit.time, force },
  };
}

/** The first history time the barrier pushes (null if it never does). */
function firstContact(b: ExplicitResult['barriers'][number]): number | null {
  for (let k = 0; k < b.time.length; k++)
    if (Math.hypot(b.force[3 * k]!, b.force[3 * k + 1]!, b.force[3 * k + 2]!) > 0)
      return b.time[k]!;
  return null;
}

/** The first index whose time is at or past t. */
function upper(t: Float64Array, at: number): number {
  let k = 0;
  while (k < t.length - 1 && t[k]! < at) k++;
  return k;
}
