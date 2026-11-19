/**
 * VS9 (docs/cad/vehicle-simulation.md, V3): a seal along an opening, measured in the closed pose.
 * The seal line is a loop of chains (the CAD edges of the opening's flange, as the kernel's
 * analysis surface gives them), sampled every `stepMm`, each point moved `insetMm` into its base
 * face. From each point the seal stands along the base face's outward normal; the distance to the
 * closure's face on that line gives its compression ((D − d) / D for a bulb of free height D) or
 * the gap past it. Points are rated against the section's range, the line's bend radius against
 * the section's smallest, and the loop's breaks (chain ends that do not meet) are listed.
 *
 * Leak rule (the plan's VS9・VS10 要点): a point leaks where the seal touches with less than the
 * smallest compression (`under`), where it does not touch and the gap is wider than
 * `gapThresholdMm` (`gap`), where no closure face is in range (`miss`), and along a break.
 */
import { CfdError } from './errors';
import { add, cross, norm, scale, sub, TriangleGrid, unit, type Vec3 } from './triangle-grid';
import type { TriangleSurface } from './voxelize';

export interface SealSection {
  /** The bulb's free height (mm), its size across the gap before it is pressed. */
  diameterMm: number;
  /** The compression range, as shares of the free height: 0 < min < max < 1 (e.g. 0.3–0.5). */
  compressionMin: number;
  compressionMax: number;
  /** The smallest radius the seal bends round (mm); a tighter corner is listed. */
  minBendRadiusMm: number;
}

export interface SealMeasureInput {
  /** The seal line's chains, each a polyline (x, y, z per point, mm), in any order and direction. */
  chains: readonly Float64Array[];
  /** The faces the seal sits on, wound so their normal points out of the body (to the closure). */
  base: TriangleSurface;
  /** The closure's faces the seal presses on, in the pose measured. */
  mating: TriangleSurface;
  /** How far into the base face the seal runs from its line (mm, ≥ 0). */
  insetMm: number;
  section: SealSection;
  /** The spacing of the measured points along the line (mm). */
  stepMm: number;
  /** The widest gap that still holds water out (mm, the plan's 0.5 mm). */
  gapThresholdMm: number;
  /** Chain ends nearer than this meet (mm, default 0.5); farther apart, the line breaks there. */
  joinToleranceMm?: number;
}

/**
 * `ok` in range, `over` pressed past the range (no leak, a hard closure), `under` touching below
 * the range, `near` a gap within the threshold (no leak), `gap` a wider gap, `miss` no closure in
 * range, `break` on a break of the line.
 */
export type SealStatus = 'ok' | 'over' | 'under' | 'near' | 'gap' | 'miss' | 'break';
export const sealLeakStatuses: readonly SealStatus[] = Object.freeze([
  'under',
  'gap',
  'miss',
  'break',
]);

export interface SealPoint {
  /** Arc length along the seal (mm) from its first point. */
  s: number;
  /** Its place in `points`. */
  index: number;
  position: Vec3;
  /** The base face's outward normal there: the way the seal stands. */
  normal: Vec3;
  /** Distance from the base face to the closure along the normal (mm), null with no closure. */
  distanceMm: number | null;
  /** (D − d) / D where the seal touches, else 0; null with no closure. */
  compression: number | null;
  /** d − D where it does not touch (mm), else 0; null with no closure. */
  gapMm: number | null;
  /** The line's bend radius there (mm), null on a straight run. */
  radiusMm: number | null;
  status: SealStatus;
  /** The radius is under the section's smallest. */
  bend: boolean;
  leak: boolean;
}

/** A run of neighbouring points out of range with one status. */
export interface SealRun {
  status: Exclude<SealStatus, 'ok'>;
  /** Arc length of its first and last points (mm). */
  from: number;
  to: number;
  lengthMm: number;
  /** The compression range over its points that touch, null when none does. */
  compression: [number, number] | null;
  /** The widest gap over its points (mm), null when none has one. */
  gapMm: number | null;
}

export interface SealMeasurement {
  /** The seal's length (mm) as it runs (moved into the base face), breaks included. */
  lengthMm: number;
  points: SealPoint[];
  runs: SealRun[];
  /** Where the line breaks: the two chain ends and the gap between them (mm). */
  breaks: { from: Vec3; to: Vec3; lengthMm: number }[];
  /** Runs bent tighter than the section allows, with their smallest radius (mm). */
  bends: { from: number; to: number; radiusMm: number }[];
  /** The compression range where the seal touches, null when it touches nowhere. */
  compression: [number, number] | null;
  /** Length of the line that leaks (mm). */
  leakLengthMm: number;
}

/** The most points one seal is measured at. */
export const sealLimits = Object.freeze({ points: 100_000, chains: 4_096 });

interface Joined {
  points: Vec3[];
  /** Per segment (i → i + 1, the last closing the loop): it bridges a break. */
  broken: boolean[];
  breaks: SealMeasurement['breaks'];
}

/** The chains end to end, nearest end next, into one loop. */
function joinChains(chains: readonly Float64Array[], tol: number): Joined {
  const lists = chains.map((c) => {
    const out: Vec3[] = [];
    for (let i = 0; i + 2 < c.length; i += 3) {
      const p: Vec3 = [c[i]!, c[i + 1]!, c[i + 2]!];
      if (!out.length || norm(sub(p, out.at(-1)!)) > 1e-9) out.push(p);
    }
    return out;
  });
  const left = lists.filter((l) => l.length >= 2);
  if (!left.length)
    throw new CfdError('config', 'the seal line has no chain of two points or more');
  const points: Vec3[] = [...left.shift()!];
  const broken: boolean[] = points.slice(1).map(() => false);
  const breaks: Joined['breaks'] = [];
  while (left.length) {
    const end = points.at(-1)!;
    let best = 0;
    let flip = false;
    let d = Infinity;
    left.forEach((l, i) => {
      const ds = norm(sub(l[0]!, end));
      const de = norm(sub(l.at(-1)!, end));
      if (ds < d) [d, best, flip] = [ds, i, false];
      if (de < d) [d, best, flip] = [de, i, true];
    });
    const next = left.splice(best, 1)[0]!;
    if (flip) next.reverse();
    if (d > tol) {
      breaks.push({ from: end, to: next[0]!, lengthMm: d });
      broken.push(true);
      points.push(...next);
    } else {
      points.push(...next.slice(1));
    }
    broken.push(...next.slice(1).map(() => false));
  }
  // The closing segment, last point back to the first.
  const close = norm(sub(points[0]!, points.at(-1)!));
  if (close <= tol) {
    points.pop();
    broken.pop();
    broken.push(false);
  } else {
    breaks.push({ from: points.at(-1)!, to: points[0]!, lengthMm: close });
    broken.push(true);
  }
  return { points, broken, breaks };
}

/** The loop sampled every `step` (mm): each sample's point, tangent and whether it is on a break. */
function sample(j: Joined, step: number) {
  const n = j.points.length;
  const seg = j.points.map((p, i) => norm(sub(j.points[(i + 1) % n]!, p)));
  const total = seg.reduce((a, b) => a + b, 0);
  const count = Math.max(3, Math.round(total / step));
  if (count > sealLimits.points)
    throw new CfdError(
      'config',
      `the seal line needs ${count} points (at most ${sealLimits.points})`,
    );
  const h = total / count;
  const out: { s: number; p: Vec3; t: Vec3; broken: boolean }[] = [];
  let i = 0;
  let at = 0;
  for (let k = 0; k < count; k++) {
    const s = k * h;
    while (i < n - 1 && at + seg[i]! < s) at += seg[i++]!;
    const a = j.points[i]!;
    const b = j.points[(i + 1) % n]!;
    const f = seg[i]! > 0 ? (s - at) / seg[i]! : 0;
    out.push({ s, p: add(a, scale(sub(b, a), f)), t: unit(sub(b, a)), broken: j.broken[i]! });
  }
  // A break shorter than the spacing may fall between samples: the sample nearest its middle
  // stands for it, so a known break always leaks (Codex on #1258).
  let start = 0;
  for (let k = 0; k < n; k++) {
    if (j.broken[k]) out[Math.round((start + seg[k]! / 2) / h) % count]!.broken = true;
    start += seg[k]!;
  }
  return { samples: out, total, h };
}

/** The circumradius of three points (mm), Infinity when they are in line. */
function circumradius(a: Vec3, b: Vec3, c: Vec3): number {
  const ab = norm(sub(b, a));
  const bc = norm(sub(c, b));
  const ca = norm(sub(a, c));
  const area2 = norm(cross(sub(b, a), sub(c, a)));
  return area2 > 1e-12 * (ab * bc + 1e-30) ? (ab * bc * ca) / (2 * area2) : Infinity;
}

const rangeOk = (s: SealSection) =>
  Number.isFinite(s.diameterMm) &&
  s.diameterMm > 0 &&
  s.compressionMin > 0 &&
  s.compressionMin < s.compressionMax &&
  s.compressionMax < 1 &&
  Number.isFinite(s.minBendRadiusMm) &&
  s.minBendRadiusMm >= 0;

export function measureSeal(input: SealMeasureInput): SealMeasurement {
  const { section: sec, stepMm, insetMm, gapThresholdMm } = input;
  if (!rangeOk(sec)) throw new CfdError('config', 'the seal section is out of range');
  if (!(stepMm > 0) || !Number.isFinite(stepMm)) throw new CfdError('config', 'stepMm must be > 0');
  if (!(insetMm >= 0) || !Number.isFinite(insetMm))
    throw new CfdError('config', 'insetMm must be ≥ 0');
  if (!(gapThresholdMm >= 0) || !Number.isFinite(gapThresholdMm))
    throw new CfdError('config', 'gapThresholdMm must be ≥ 0');
  if (!input.chains.length || input.chains.length > sealLimits.chains)
    throw new CfdError('config', `the seal line takes 1–${sealLimits.chains} chains`);
  if (!input.base.triangles.length)
    throw new CfdError('surface-invalid', 'the seal has no base face');
  const tol = input.joinToleranceMm ?? 0.5;
  const joined = joinChains(input.chains, tol);
  const { samples, h } = sample(joined, stepMm);
  const base = new TriangleGrid(input.base);
  const mating = input.mating.triangles.length ? new TriangleGrid(input.mating) : null;
  const D = sec.diameterMm;
  const reach = Math.max(4 * D, 20);
  const near = Math.max(2 * insetMm, 5 * stepMm, 5);
  // Each sample moved into its base face, with that face's normal.
  const placed = samples.map(({ p, t }) => {
    const at = base.nearest(p, near) ?? base.nearest(p, 10 * near);
    if (!at) return { p, n: [0, 0, 0] as Vec3 };
    let n = base.normal(at.triangle);
    if (insetMm === 0) return { p: at.point, n };
    const b = unit(cross(n, t));
    let pick: { p: Vec3; d: number; tri: number } | null = null;
    for (const side of [1, -1]) {
      const q = add(p, scale(b, side * insetMm));
      const m = base.nearest(q, near + insetMm);
      if (m && (!pick || m.distance < pick.d))
        pick = { p: m.point, d: m.distance, tri: m.triangle };
    }
    if (!pick) return { p: at.point, n };
    n = base.normal(pick.tri);
    return { p: pick.p, n };
  });
  const count = placed.length;
  // The neighbours a bend is measured over: about 5 mm each way, never past half the loop (a
  // loop of a few points, Codex on #1258).
  const span = Math.max(1, Math.min(Math.ceil(5 / h), Math.floor((count - 1) / 2)));
  const at = (k: number) => placed[((k % count) + count) % count]!.p;
  // Lengths along the seal as it runs (moved into the face): each point stands for half of the
  // segment on each side, and its arc length is measured along that line.
  const seg = placed.map((q, k) => norm(sub(placed[(k + 1) % count]!.p, q.p)));
  const weight = seg.map((s, k) => (s + seg[(k - 1 + count) % count]!) / 2);
  const arc: number[] = [];
  seg.reduce((at, s, k) => ((arc[k] = at), at + s), 0);
  const total = seg.reduce((a, b) => a + b, 0);
  const lengthOf = (ps: readonly SealPoint[]) => ps.reduce((n, p) => n + weight[p.index]!, 0);
  const points: SealPoint[] = placed.map(({ p, n }, k) => {
    const broken = samples[k]!.broken;
    const r = circumradius(at(k - span), p, at(k + span));
    const radiusMm = Number.isFinite(r) && r < 1e6 ? r : null;
    const bend = radiusMm !== null && radiusMm < sec.minBendRadiusMm;
    let distanceMm: number | null = null;
    if (mating && norm(n) > 0) {
      // From D behind the base face, so a closure pressed into the base (d < 0) is still met.
      const hit = mating.raycast(sub(p, scale(n, D)), n, 0, D + reach);
      if (hit) distanceMm = hit.t - D;
    }
    let status: SealStatus;
    let compression: number | null = null;
    let gapMm: number | null = null;
    if (distanceMm === null) status = 'miss';
    else if (distanceMm < D) {
      compression = (D - distanceMm) / D;
      gapMm = 0;
      status =
        compression > sec.compressionMax
          ? 'over'
          : compression < sec.compressionMin
            ? 'under'
            : 'ok';
    } else {
      compression = 0;
      gapMm = distanceMm - D;
      status = gapMm > gapThresholdMm ? 'gap' : 'near';
    }
    if (broken) status = 'break';
    return {
      s: arc[k]!,
      index: k,
      position: p,
      normal: n,
      distanceMm,
      compression,
      gapMm,
      radiusMm,
      status,
      bend,
      leak: sealLeakStatuses.includes(status),
    };
  });
  // Runs of one status, started after an `ok` point so a run across the loop's start is whole.
  const first = Math.max(
    0,
    points.findIndex((p) => p.status === 'ok'),
  );
  const order = points.map((_, k) => points[(first + k) % count]!);
  const runs: SealRun[] = [];
  const bends: SealMeasurement['bends'] = [];
  let run: SealPoint[] = [];
  let bent: SealPoint[] = [];
  const flush = () => {
    if (!run.length) return;
    const st = run[0]!.status as SealRun['status'];
    const touched = run.filter((p) => p.compression !== null && p.compression > 0);
    const gaps = run.filter((p) => p.gapMm !== null && p.gapMm > 0);
    runs.push({
      status: st,
      from: run[0]!.s,
      to: run.at(-1)!.s,
      lengthMm: lengthOf(run),
      compression: touched.length
        ? [
            Math.min(...touched.map((p) => p.compression!)),
            Math.max(...touched.map((p) => p.compression!)),
          ]
        : null,
      gapMm: gaps.length ? Math.max(...gaps.map((p) => p.gapMm!)) : null,
    });
    run = [];
  };
  const flushBend = () => {
    if (!bent.length) return;
    bends.push({
      from: bent[0]!.s,
      to: bent.at(-1)!.s,
      radiusMm: Math.min(...bent.map((p) => p.radiusMm!)),
    });
    bent = [];
  };
  for (const p of order) {
    if (run.length && p.status !== run[0]!.status) flush();
    if (p.status !== 'ok') run.push(p);
    if (p.bend) bent.push(p);
    else flushBend();
  }
  flush();
  flushBend();
  const touched = points.filter((p) => p.compression !== null && p.compression > 0);
  return {
    lengthMm: total,
    points,
    runs,
    breaks: joined.breaks,
    bends,
    compression: touched.length
      ? [
          Math.min(...touched.map((p) => p.compression!)),
          Math.max(...touched.map((p) => p.compression!)),
        ]
      : null,
    leakLengthMm: lengthOf(points.filter((p) => p.leak)),
  };
}

/**
 * The seal's ribbon: per point the base point and the top of the seal (where it meets the closure,
 * or its free height); a leaking point reaches the closure however far it is.
 */
export function sealRibbon(
  m: SealMeasurement,
  section: SealSection,
): { base: Vec3; top: Vec3; normal: Vec3; leak: boolean }[] {
  return m.points.map((p) => {
    // A leaking point open to a closure further off than the seal stands spans the whole gap,
    // so water through the gap above the seal crosses it (Codex on #1277).
    const height =
      p.distanceMm !== null
        ? Math.max(0, p.leak ? p.distanceMm : Math.min(p.distanceMm, section.diameterMm))
        : section.diameterMm;
    return {
      base: p.position,
      top: add(p.position, scale(p.normal, height)),
      normal: p.normal,
      leak: p.leak,
    };
  });
}
