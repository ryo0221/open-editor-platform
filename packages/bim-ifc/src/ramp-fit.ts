/**
 * FU2 (docs/cad/bim-followups.md): the shape of another program's ramp, read back from the
 * corners of its faceted body. A faceted body's corners lie on the surfaces it stands for,
 * whatever its chords, so every corner must lie within `tolerance` of the fitted shape
 * (FU-U3).
 */

import { bimLimits, bimStairProfile } from '@editor-platform/bim-core';

type Vec3 = [number, number, number];

/** A spiral ramp as the `ramp` element holds it, in world mm and rad. */
export interface BimFittedSpiral {
  center: [number, number];
  innerRadius: number;
  outerRadius: number;
  /** The angle where the ramp's top is lowest, and the turn from there (+ counter-clockwise). */
  startAngle: number;
  sweep: number;
  /** Heights of the top at the start and at the end (zEnd > zStart). */
  zStart: number;
  zEnd: number;
  /** Measured vertically. */
  thickness: number;
}

/** Solves the small linear system `a·x = b` (Gaussian elimination, partial pivoting). */
function solve(a: number[][], b: number[]): number[] | undefined {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    if (!(Math.abs(m[p]![c]!) > 1e-12)) return undefined;
    [m[c], m[p]] = [m[p]!, m[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / m[c]![c]!;
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/** Least squares: the x minimising |A·x − b| through the normal equations. */
function leastSquares(rows: number[][], b: number[]): number[] | undefined {
  const n = rows[0]!.length;
  const ata = Array.from({ length: n }, () => Array<number>(n).fill(0));
  const atb = Array<number>(n).fill(0);
  rows.forEach((r, i) => {
    for (let j = 0; j < n; j++) {
      atb[j]! += r[j]! * b[i]!;
      for (let k = 0; k < n; k++) ata[j]![k]! += r[j]! * r[k]!;
    }
  });
  return solve(ata, atb);
}

/** Smallest and largest, without spreading a long list into arguments. */
function range(xs: readonly number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of xs) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return [lo, hi];
}

const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

/** A faceted body: corners, the edges of its faces, and each face's loop of corners. */
export interface BimFacets {
  points: Vec3[];
  edges: [number, number][];
  loops: number[][];
}

/** Edges used by exactly one of the faces: the outline of a region of a faceted surface. */
function outlineEdges(loops: readonly (readonly number[])[]): [number, number][] {
  const count = new Map<string, [number, number, number]>();
  for (const loop of loops)
    loop.forEach((a, k) => {
      const b = loop[(k + 1) % loop.length]!;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const c = count.get(key);
      if (c) c[2]++;
      else count.set(key, [a, b, 1]);
    });
  return [...count.values()].filter((c) => c[2] === 1).map(([a, b]) => [a, b]);
}

/** A face's normal by Newell's method (not unit; its length is twice the face's area). */
function newell(points: readonly Vec3[], loop: readonly number[]): Vec3 {
  const n: Vec3 = [0, 0, 0];
  loop.forEach((a, k) => {
    const p = points[a]!;
    const q = points[loop[(k + 1) % loop.length]!]!;
    n[0] += (p[1] - q[1]) * (p[2] + q[2]);
    n[1] += (p[2] - q[2]) * (p[0] + q[0]);
    n[2] += (p[0] - q[0]) * (p[1] + q[1]);
  });
  return n;
}

/**
 * The axis from the upright faces: their plan chords lie on the two circles, so the
 * perpendicular bisectors of the sides all pass through the centre, and those of the radial
 * ends miss it by at least the inner radius. The centre is the point the most bisectors pass
 * within the tolerance of (tried at the crossings of pairs of them, so a few ends never pull
 * it), refined by least squares over those. Returns it with the chords' corners, or undefined
 * without three sides.
 */
function axisFromSides(
  points: readonly Vec3[],
  loops: readonly (readonly number[])[],
  tolerance: number,
): { center: [number, number]; chords: [number, number][] } | undefined {
  const lines: { m: [number, number]; u: [number, number]; ends: [number, number] }[] = [];
  for (const loop of loops) {
    const n = newell(points, loop);
    const len = Math.hypot(...n);
    // Steeper than 60°: the top and underside of a ramp are far flatter.
    if (!(len > 0) || Math.abs(n[2]) >= len / 2) continue;
    // The face's two plan corners farthest apart.
    let best = 0;
    let ends: [number, number] = [loop[0]!, loop[0]!];
    for (const a of loop)
      for (const b of loop) {
        const d = Math.hypot(points[a]![0] - points[b]![0], points[a]![1] - points[b]![1]);
        if (d > best) [best, ends] = [d, [a, b]];
      }
    if (!(best > tolerance)) continue;
    const [p, q] = [points[ends[0]]!, points[ends[1]]!];
    // Upright: every corner within the tolerance of the vertical plane through those two, so
    // corners exported a little off still count, as the final corner checks allow.
    const ux = (q[0] - p[0]) / best;
    const uy = (q[1] - p[1]) / best;
    if (
      loop.some(
        (a) => Math.abs((points[a]![0] - p[0]) * uy - (points[a]![1] - p[1]) * ux) > tolerance,
      )
    )
      continue;
    lines.push({
      m: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2],
      u: [(q[0] - p[0]) / best, (q[1] - p[1]) / best],
      ends,
    });
  }
  if (lines.length < 3) return undefined;
  const miss = (x: readonly number[], { m, u }: (typeof lines)[number]) =>
    Math.abs((x[0]! - m[0]) * u[0] + (x[1]! - m[1]) * u[1]);
  const near = (x: readonly number[]) => lines.filter((l) => miss(x, l) <= tolerance);
  /** The point nearest the lines, by least squares. */
  const nearest = (kept: readonly (typeof lines)[number][]) => {
    const a = [
      [0, 0],
      [0, 0],
    ];
    const b = [0, 0];
    for (const { m, u } of kept) {
      const um = u[0] * m[0] + u[1] * m[1];
      a[0]![0]! += u[0] * u[0];
      a[0]![1]! += u[0] * u[1];
      a[1]![0]! += u[1] * u[0];
      a[1]![1]! += u[1] * u[1];
      b[0]! += u[0] * um;
      b[1]! += u[1] * um;
    }
    return solve(a, b);
  };
  // Candidates: the crossings of pairs among at most 64 lines spread over the faces.
  const step = Math.max(1, lines.length / 64);
  const sample: (typeof lines)[number][] = [];
  for (let k = 0; Math.floor(k) < lines.length; k += step) sample.push(lines[Math.floor(k)]!);
  let best: { x: number[]; count: number } | undefined;
  for (let i = 0; i < sample.length; i++)
    for (let j = i + 1; j < sample.length; j++) {
      const x = nearest([sample[i]!, sample[j]!]);
      if (!x) continue;
      const count = near(x).length;
      if (!best || count > best.count) best = { x, count };
    }
  if (!best || best.count < 3) return undefined;
  let kept = near(best.x);
  for (let it = 0; it < 4; it++) {
    const x = nearest(kept);
    if (!x) return undefined;
    const again = near(x);
    if (again.length < 3) return undefined;
    if (again.length === kept.length && again.every((l, k) => l === kept[k])) {
      return { center: [x[0]!, x[1]!], chords: kept.map((l) => l.ends) };
    }
    kept = again;
  }
  return undefined;
}

/**
 * The spiral ramp whose top and underside are helicoids about one vertical axis (radial lines
 * level, rising in proportion to the angle) between two circles, with upright sides on the
 * circles and radial ends, or undefined when the faces are not one. The angle is followed along
 * the edges past a full turn. Corners may lie anywhere on the sides; the outlines of the top and
 * the underside must run along the circles over the whole turn.
 */
export function bimFitSpiralRamp(m: BimFacets, tolerance = 1): BimFittedSpiral | undefined {
  const n = m.points.length;
  if (n < 8 || !m.loops.length) return undefined;
  // Near the origin, so that the squares in the circle fits keep their precision.
  let ox = 0;
  let oy = 0;
  for (const p of m.points) {
    ox += p[0] / n;
    oy += p[1] / n;
  }
  const points = m.points.map((p): Vec3 => [p[0] - ox, p[1] - oy, p[2]]);
  const edges = m.edges;
  // The axis: the upright sides stand on chords of the two circles, whose perpendicular
  // bisectors all pass through the centre (the radial ends do not, and are left out once the
  // centre is near). Without upright faces, one circle through all the plan corners.
  const sides = axisFromSides(points, m.loops, tolerance);
  let c: [number, number];
  let r0 = 0;
  let r1 = 0;
  /** Two circles about one centre through the inner and the outer corners, by least squares. */
  const twoCircles = (inner: readonly number[], outer: readonly number[]) => {
    const rows: number[][] = [];
    const rhs: number[] = [];
    for (const [list, k] of [
      [inner, 0],
      [outer, 1],
    ] as const)
      for (const i of list) {
        const p = points[i]!;
        rows.push([p[0], p[1], k ? 0 : 1, k ? 1 : 0]);
        rhs.push(-(p[0] * p[0] + p[1] * p[1]));
      }
    const f = leastSquares(rows, rhs);
    if (!f) return undefined;
    const next: [number, number] = [-f[0]! / 2, -f[1]! / 2];
    const q = next[0] * next[0] + next[1] * next[1];
    return { c: next, r0: Math.sqrt(q - f[2]!), r1: Math.sqrt(q - f[3]!) };
  };
  if (sides) {
    // The sides' chord corners only (a corner inside the top or the underside near a circle
    // is not on it), split into the two circles at the widest gap between their radii.
    const o = sides.center;
    const radiusOf = (i: number) => Math.hypot(points[i]![0] - o[0], points[i]![1] - o[1]);
    const chords = sides.chords
      .map(([a, b]) => ({ a, b, r: (radiusOf(a) + radiusOf(b)) / 2 }))
      .sort((x, y) => x.r - y.r);
    let gap = 0;
    let at = 0;
    for (let k = 1; k < chords.length; k++)
      if (chords[k]!.r - chords[k - 1]!.r > gap) [gap, at] = [chords[k]!.r - chords[k - 1]!.r, k];
    if (!(gap > tolerance)) return undefined;
    const corners = (list: typeof chords) => list.flatMap(({ a, b }) => [a, b]);
    const f = twoCircles(corners(chords.slice(0, at)), corners(chords.slice(at)));
    if (!f) return undefined;
    ({ c, r0, r1 } = f);
  } else {
    // Without upright faces: one circle through all the plan corners, then the corners near
    // each circle (the inner and outer quarters of the spread at first).
    const kasa = leastSquares(
      points.map((p) => [p[0], p[1], 1]),
      points.map((p) => -(p[0] * p[0] + p[1] * p[1])),
    );
    if (!kasa) return undefined;
    c = [-kasa[0]! / 2, -kasa[1]! / 2];
    for (let it = 0; it < 20; it++) {
      const o = c;
      const rs = points.map((p) => Math.hypot(p[0] - o[0], p[1] - o[1]));
      const [lo, hi] = range(rs);
      const band = it === 0 ? (hi - lo) / 4 : Math.max(tolerance / 10, (hi - lo) * 0.02);
      const inner: number[] = [];
      const outer: number[] = [];
      rs.forEach((r, i) => {
        if (r <= lo + band) inner.push(i);
        else if (r >= hi - band) outer.push(i);
      });
      const f = twoCircles(inner, outer);
      if (!f) return undefined;
      const moved = Math.hypot(f.c[0] - c[0], f.c[1] - c[1]);
      ({ c, r0, r1 } = f);
      if (it > 0 && moved < 1e-9) break;
    }
  }
  if (!(r0 > tolerance && r1 > r0 + tolerance)) return undefined;
  // The angle of each corner, followed along the edges from the first corner.
  const raw = points.map((p) => Math.atan2(p[1] - c[1], p[0] - c[0]));
  const next = Array.from({ length: n }, () => [] as number[]);
  for (const [a, b] of edges) {
    if (a === b) continue;
    next[a]!.push(b);
    next[b]!.push(a);
  }
  const theta = Array<number>(n).fill(NaN);
  theta[0] = raw[0]!;
  const queue = [0];
  for (let head = 0; head < queue.length; head++) {
    const a = queue[head]!;
    for (const b of next[a]!) {
      if (!Number.isNaN(theta[b]!)) continue;
      theta[b] = theta[a]! + wrap(raw[b]! - raw[a]!);
      queue.push(b);
    }
  }
  if (theta.some((t) => Number.isNaN(t))) return undefined;
  // An edge may not cross a half turn: the corners are followed consistently.
  for (const [a, b] of edges) if (Math.abs(theta[a]! - theta[b]!) >= Math.PI) return undefined;
  // Heights: two lines z = a + p·θ (top and underside) with one slope, fitted to the corners
  // on them; corners on the sides between are left out once the lines are known.
  let side = points.map(() => false);
  let top = points.map(() => true);
  let p = 0;
  let aTop = 0;
  let aBottom = 0;
  for (let it = 0; it < 8; it++) {
    if (it === 0) {
      // A start that does not depend on how densely each surface is faceted: the slope is the
      // median rise per angle along the edges (edges on either helicoid rise by exactly that),
      // and the corners split into top and underside halfway between their extreme levels.
      const slopes: number[] = [];
      for (const [a, b] of edges) {
        const dt = theta[b]! - theta[a]!;
        if (Math.abs(dt) > 1e-9) slopes.push((points[b]![2] - points[a]![2]) / dt);
      }
      if (!slopes.length) return undefined;
      slopes.sort((x, y) => x - y);
      const p0 = slopes[slopes.length >> 1]!;
      const levels = points.map((q, i) => q[2] - p0 * theta[i]!);
      const [lo, hi] = range(levels);
      top = levels.map((z) => z > (lo + hi) / 2);
    } else {
      const next = points.map((q, i) => q[2] - p * theta[i]!);
      const nextTop = next.map((z) => Math.abs(z - aTop) <= Math.abs(z - aBottom));
      const nextSide = next.map(
        (z) => Math.min(Math.abs(z - aTop), Math.abs(z - aBottom)) > tolerance,
      );
      if (
        it > 1 &&
        nextTop.every((t, i) => t === top[i]) &&
        nextSide.every((t, i) => t === side[i])
      )
        break;
      [top, side] = [nextTop, nextSide];
    }
    const rows: number[][] = [];
    const zs: number[] = [];
    theta.forEach((t, i) => {
      if (side[i]) return;
      rows.push([top[i] ? 1 : 0, top[i] ? 0 : 1, t]);
      zs.push(points[i]![2]);
    });
    if (rows.length < 4) return undefined;
    const fit = leastSquares(rows, zs);
    if (!fit) return undefined;
    [aTop, aBottom, p] = [fit[0]!, fit[1]!, fit[2]!];
  }
  const thickness = aTop - aBottom;
  if (!(thickness > tolerance)) return undefined;
  const [t0, t1] = range(theta);
  if (!(Math.abs(p) * (t1 - t0) > tolerance)) return undefined;
  const radius = points.map((q) => Math.hypot(q[0] - c[0], q[1] - c[1]));
  const onInner = (i: number) => Math.abs(radius[i]! - r0) <= tolerance;
  const onOuter = (i: number) => Math.abs(radius[i]! - r1) <= tolerance;
  const atEnd = (i: number) =>
    Math.min(Math.abs(theta[i]! - t0), Math.abs(theta[i]! - t1)) * radius[i]! <= tolerance;
  const level = (i: number) => points[i]![2] - p * theta[i]!;
  const onTop = (i: number) => Math.abs(level(i) - aTop) <= tolerance;
  const onBottom = (i: number) => Math.abs(level(i) - aBottom) <= tolerance;
  // Every corner between the circles and the helicoids, and on a helicoid or a side.
  for (let i = 0; i < n; i++) {
    if (radius[i]! < r0 - tolerance || radius[i]! > r1 + tolerance) return undefined;
    if (level(i) < aBottom - tolerance || level(i) > aTop + tolerance) return undefined;
    if (!onTop(i) && !onBottom(i) && !onInner(i) && !onOuter(i) && !atEnd(i)) return undefined;
  }
  // The top's and the underside's outlines: along the circles over the whole turn, or across
  // the ends. A ramp narrower somewhere is not this ramp.
  for (const on of [onTop, onBottom]) {
    const faces = m.loops.filter((l) => l.every(on));
    if (!faces.length) return undefined;
    const turned = [0, 0];
    for (const [a, b] of outlineEdges(faces)) {
      const span = Math.abs(theta[a]! - theta[b]!);
      if (onInner(a) && onInner(b)) turned[0] += span;
      else if (onOuter(a) && onOuter(b)) turned[1] += span;
      else if (!(atEnd(a) && atEnd(b) && span * r1 <= 2 * tolerance)) return undefined;
    }
    const sweep = t1 - t0;
    if (Math.abs(turned[0]! - sweep) * r0 > tolerance) return undefined;
    if (Math.abs(turned[1]! - sweep) * r1 > tolerance) return undefined;
  }
  // Rising from the start: counter-clockwise when the top climbs with the angle.
  const [start, end] = p > 0 ? [t0, t1] : [t1, t0];
  return {
    center: [c[0] + ox, c[1] + oy],
    innerRadius: r0,
    outerRadius: r1,
    startAngle: wrap(start),
    sweep: end - start,
    zStart: aTop + p * start,
    zEnd: aTop + p * end,
    thickness,
  };
}

/**
 * FU2b: a plate whose top and underside are two parallel planes (not upright) a vertical
 * `thickness` apart, with upright sides: the top is `z = c + grade·(x, y)`. The plan loops are
 * the top's outline, the outer one first.
 */
export interface BimFittedPlate {
  outer: [number, number][];
  holes: [number, number][][];
  grade: [number, number];
  c: number;
  thickness: number;
  /** The body's corners on the top and on the underside, to check what is made of the fit. */
  corners: { top: Vec3[]; under: Vec3[] };
}

const area2 = (loop: readonly [number, number][]) =>
  loop.reduce((s, p, k) => {
    const q = loop[(k + 1) % loop.length]!;
    return s + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2;

/**
 * The plate the faceted body is, or undefined when a corner lies more than `tolerance` off it
 * (FU-U3): every face upright or on the top or the underside, every corner on one of them, and
 * the underside's outline under the top's.
 */
export function bimFitSlopedPlate(m: BimFacets, tolerance = 1): BimFittedPlate | undefined {
  const { points, loops } = m;
  if (points.length < 6 || !loops.length) return undefined;
  // Upright faces: every corner within the tolerance of one vertical plane, square to the
  // face's normal in plan, and the face steeper than 60° (a strip of the top narrower than the
  // tolerance is not a side, Codex). The others share one normal: the grade.
  const upright = loops.map((loop) => {
    const n = newell(points, loop);
    const h = Math.hypot(n[0], n[1]);
    if (!(h > 0) || Math.abs(n[2]) >= Math.hypot(h, n[2]) / 2) return false;
    const u = [n[0] / h, n[1] / h] as const;
    const p0 = points[loop[0]!]!;
    return loop.every(
      (i) => Math.abs(u[0] * (points[i]![0] - p0[0]) + u[1] * (points[i]![1] - p0[1])) <= tolerance,
    );
  });
  const flat: number[] = [];
  let sum: Vec3 = [0, 0, 0];
  for (let f = 0; f < loops.length; f++) {
    if (upright[f]) continue;
    const n = newell(points, loops[f]!);
    if (!(Math.hypot(...n) > 0)) continue;
    flat.push(f);
    // Up for the top, down for the underside: both counted up, by area.
    const s = n[2] > 0 ? 1 : -1;
    sum = [sum[0] + s * n[0], sum[1] + s * n[1], sum[2] + s * n[2]];
  }
  if (!flat.length || !(sum[2] > 0)) return undefined;
  const grade: [number, number] = [-sum[0] / sum[2], -sum[1] / sum[2]];
  const level = (i: number) => points[i]![2] - grade[0] * points[i]![0] - grade[1] * points[i]![1];
  const used = new Set(flat.flatMap((f) => loops[f]!));
  let hi = -Infinity;
  let lo = Infinity;
  for (const i of used) {
    hi = Math.max(hi, level(i));
    lo = Math.min(lo, level(i));
  }
  // Each plane through the middle of its corners' spread, not at the outermost one, so noise
  // either side of it stays within the tolerance (Codex).
  const half = (hi + lo) / 2;
  const spread = (top: boolean) => {
    const ls = [...used].map(level).filter((l) => l > half === top);
    return (Math.max(...ls) + Math.min(...ls)) / 2;
  };
  [hi, lo] = [spread(true), spread(false)];
  const thickness = hi - lo;
  if (!(thickness > tolerance)) return undefined;
  // Every corner on the top or the underside, or on upright faces only between them; a face
  // not upright lies on one of them.
  const onTop = (i: number) => Math.abs(level(i) - hi) <= tolerance;
  const onBottom = (i: number) => Math.abs(level(i) - lo) <= tolerance;
  const sideOnly = new Set<number>();
  for (let i = 0; i < points.length; i++)
    if (!onTop(i) && !onBottom(i)) {
      if (used.has(i) || level(i) < lo - tolerance || level(i) > hi + tolerance) return undefined;
      sideOnly.add(i);
    }
  const top: number[] = [];
  const under: number[][] = [];
  for (const f of flat) {
    const loop = loops[f]!;
    if (loop.every(onTop)) top.push(f);
    else if (loop.every(onBottom)) under.push(loop);
    else return undefined;
  }
  // The top's outline: edges of its faces not shared by two of them, chained into loops.
  const key = (a: number, b: number) => `${a},${b}`;
  const count = new Map<string, number>();
  for (const f of top) {
    const loop = loops[f]!;
    loop.forEach((a, k) => {
      const b = loop[(k + 1) % loop.length]!;
      const k1 = key(Math.min(a, b), Math.max(a, b));
      count.set(k1, (count.get(k1) ?? 0) + 1);
    });
  }
  const next = new Map<number, number>();
  for (const f of top) {
    const loop = loops[f]!;
    loop.forEach((a, k) => {
      const b = loop[(k + 1) % loop.length]!;
      if (count.get(key(Math.min(a, b), Math.max(a, b))) !== 1) return;
      if (next.has(a)) next.set(a, -1);
      else next.set(a, b);
    });
  }
  if ([...next.values()].includes(-1)) return undefined;
  const outlines: [number, number][][] = [];
  const left = new Set(next.keys());
  for (const start of next.keys()) {
    if (!left.has(start)) continue;
    const ring: [number, number][] = [];
    let a = start;
    for (let guard = 0; left.has(a); guard++) {
      if (guard > points.length) return undefined;
      left.delete(a);
      ring.push([points[a]![0], points[a]![1]]);
      a = next.get(a) ?? -1;
    }
    if (a !== start || ring.length < 3) return undefined;
    // Corners on a straight run of the outline are not corners of the plan.
    const kept = ring.filter((p, k) => {
      const o = ring[(k + ring.length - 1) % ring.length]!;
      const q = ring[(k + 1) % ring.length]!;
      const ex = q[0] - o[0];
      const ey = q[1] - o[1];
      const len = Math.hypot(ex, ey);
      return (
        !(len > 0) || Math.abs(ex * (p[1] - o[1]) - ey * (p[0] - o[0])) / len > tolerance / 1000
      );
    });
    if (kept.length < 3) return undefined;
    outlines.push(kept);
  }
  if (!outlines.length) return undefined;
  outlines.sort((a, b) => Math.abs(area2(b)) - Math.abs(area2(a)));
  // Upright sides: the corners of the underside's outline, and those on the sides between,
  // lie under the top's outline (corners inside the underside may lie anywhere on it).
  if (!under.length) return undefined;
  for (const i of new Set([...outlineEdges(under).flat(), ...sideOnly])) {
    const p = points[i]!;
    let best = Infinity;
    for (let k = 0; k < outlines.length; k++) {
      const ring = outlines[k]!;
      ring.forEach((o, j) => {
        const q = ring[(j + 1) % ring.length]!;
        const ex = q[0] - o[0];
        const ey = q[1] - o[1];
        const l2 = ex * ex + ey * ey;
        const t =
          l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - o[0]) * ex + (p[1] - o[1]) * ey) / l2)) : 0;
        best = Math.min(best, Math.hypot(p[0] - o[0] - t * ex, p[1] - o[1] - t * ey));
      });
    }
    if (best > tolerance) return undefined;
  }
  const [outer, ...holes] = outlines;
  const corners = { top: [] as Vec3[], under: [] as Vec3[] };
  for (const i of used) (onTop(i) ? corners.top : corners.under).push(points[i]!);
  return { outer: outer!, holes, grade, c: hi, thickness, corners };
}

/** LS7: a straight stair as the `stair` element holds it, in world mm and rad. */
export interface BimFittedStair {
  /** The foot's nosing, in the middle of the flight's width. */
  start: [number, number];
  directionRad: number;
  width: number;
  risers: number;
  riser: number;
  tread: number;
  /** The height of the foot, and the waist (the slab under the steps, square to its slope). */
  zBase: number;
  waist: number;
}

/** Whether `p` lies inside the closed polygon `loop` (even–odd). */
function insidePolygon(p: readonly [number, number], loop: readonly (readonly number[])[]) {
  let inside = false;
  loop.forEach((a, k) => {
    const b = loop[(k + 1) % loop.length]!;
    if (a[1]! > p[1] !== b[1]! > p[1]) {
      const x = a[0]! + ((p[1] - a[1]!) * (b[0]! - a[0]!)) / (b[1]! - a[1]!);
      if (x > p[0]) inside = !inside;
    }
  });
  return inside;
}

/** The distance from `p` to the closed polygon `loop`'s outline. */
function outlineDistance(p: readonly [number, number], loop: readonly (readonly number[])[]) {
  let best = Infinity;
  loop.forEach((a, k) => {
    const b = loop[(k + 1) % loop.length]!;
    const d = [b[0]! - a[0]!, b[1]! - a[1]!];
    const l2 = d[0]! * d[0]! + d[1]! * d[1]!;
    const t =
      l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]!) * d[0]! + (p[1] - a[1]!) * d[1]!) / l2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - a[0]! - t * d[0]!, p[1] - a[1]! - t * d[1]!));
  });
  return best;
}

/**
 * LS7: another program's straight flight read from the corners of its faceted body, as the
 * LS6 `stair` makes it: its side profile (the steps, the last riser up to the floor above left
 * to that floor, and the sloped waist under them) extruded across its width. The waist's
 * underside gives the direction (up the flight), the extent across it the width, the levels of the treads' tops
 * the risers, the run the tread, and the underside the waist. Every corner must lie within
 * `tolerance` of the sides' profile and every profile corner be found on both sides (FU-U3);
 * else undefined (a landing, a turn, a winder).
 */
export function bimFitStraightStair(m: BimFacets, tolerance = 1): BimFittedStair | undefined {
  const { points, loops } = m;
  if (points.length < 8 || !loops.length) return undefined;
  // The waist's underside slopes down towards the foot: its outward normal leans up the
  // flight, which gives the direction whatever the faces' chords (triangles or polygons).
  const waist: Vec3 = [0, 0, 0];
  const tops: number[] = [];
  /** The underside's corners (once per face they bound). */
  const under: number[] = [];
  for (const loop of loops) {
    const n = newell(points, loop);
    const len = Math.hypot(...n);
    if (!(len > 0)) continue;
    const up = n[2] / len;
    // Sloped from 2.5° (gentler than any stair the limits allow) to 84° (risers and sides,
    // within the tolerance of upright, are left out).
    if (up < -0.1 && up > -0.999) {
      for (let k = 0; k < 3; k++) waist[k] += n[k]!;
      under.push(...loop);
    }
    // A tread's top: facing up, its corners within the tolerance of their mean height (not
    // of each other: ±0.6 mm either side is within 1 mm, Codex).
    if (up > 0.999) {
      const zs = loop.map((i) => points[i]![2]);
      const z = zs.reduce((a, b) => a + b) / zs.length;
      if (zs.every((c) => Math.abs(c - z) <= tolerance)) tops.push(z);
    }
  }
  const h = Math.hypot(waist[0], waist[1]);
  if (!(h > 0)) return undefined;
  const d: [number, number] = [waist[0] / h, waist[1] / h];
  const nrm: [number, number] = [-d[1], d[0]];
  const uvz = points.map(
    (p): Vec3 => [p[0] * d[0] + p[1] * d[1], p[0] * nrm[0] + p[1] * nrm[1], p[2]],
  );
  // Without spreading the corners into arguments (a fine tessellation passes the limit, Codex).
  const [u0, u1] = range(uvz.map((p) => p[0]));
  const [v0, v1] = range(uvz.map((p) => p[1]));
  const [z0] = range(uvz.map((p) => p[2]));
  // The treads' levels, one each: faces' heights a step from the last in the tolerance are the
  // same tread (a tilted tread's strips spread past it, Codex), its level their mean. The
  // corners are checked against the fitted profile below.
  const groups: number[][] = [];
  let last = -Infinity;
  for (const z of tops.sort((a, b) => a - b)) {
    if (z - last > tolerance) groups.push([]);
    groups[groups.length - 1]!.push(z);
    last = z;
  }
  const levels = groups.map((g) => g.reduce((a, b) => a + b) / g.length);
  const treads = levels.length;
  if (!treads) return undefined;
  const risers = treads + 1;
  const { riserMm, treadMm, risers: count } = bimLimits.stair;
  // At a limit within rounding (a turned flight's run picks up 1e-13, Codex): on it.
  const eps = 1e-6;
  const within = (v: number, [lo, hi]: readonly number[]) =>
    v >= lo! - eps && v <= hi! + eps ? Math.min(hi!, Math.max(lo!, v)) : NaN;
  // From the treads' mean heights, not the highest corner (a tilted top tread, Codex).
  const riser = within((levels[treads - 1]! - z0) / treads, riserMm);
  const tread = within((u1 - u0) / treads, treadMm);
  if (
    risers > count[1] ||
    !Number.isFinite(riser) ||
    !Number.isFinite(tread) ||
    levels.some((z, k) => Math.abs(z - z0 - (k + 1) * riser) > tolerance)
  )
    return undefined;
  // The waist from the underside: where it leaves the floor, else how low it is at the top
  // (the same line, so a foot within the tolerance of the first riser is read there, Codex).
  const slope = riser / tread;
  const local = uvz.map((p): [number, number] => [p[0] - u0, p[2] - z0]);
  const floor = local.filter((p) => Math.abs(p[1]) <= tolerance && p[0] > tolerance);
  const foot = floor.length ? range(floor.map((p) => p[0]))[1] : 0;
  const [end] = range(
    local.filter((p) => Math.abs(p[0] - (u1 - u0)) <= tolerance).map((p) => p[1]),
  );
  const sides = [v0, v1];
  /** The profile of an underside `drop` below the nosings, if every corner and face is on it. */
  const fits = (drop: number) => {
    const shape = bimStairProfile(risers, riser, tread, drop / Math.hypot(1, slope));
    if (typeof shape === 'string') return undefined;
    // Each corner on the solid's surface: on a face along the profile's outline (anywhere across
    // the width), or on a side within the profile (a triangulation's inner vertex, Codex).
    for (let i = 0; i < uvz.length; i++) {
      const p = uvz[i]!;
      if (outlineDistance(local[i]!, shape.profile) <= tolerance) continue;
      if (!sides.some((v) => Math.abs(p[1] - v) <= tolerance)) return undefined;
      if (!insidePolygon(local[i]!, shape.profile)) return undefined;
    }
    // Each face on the surface too, its corners' mean on the outline or a side: a hole through
    // the flight has its corners within the sides' profile, but not its faces (Codex).
    for (const loop of loops) {
      const n = loop.length;
      const c = [0, 1, 2].map((k) => loop.reduce((a, i) => a + uvz[i]![k]!, 0) / n);
      const onSide = sides.some((v) => Math.abs(c[1]! - v) <= tolerance);
      if (!onSide && outlineDistance([c[0]! - u0, c[2]! - z0], shape.profile) > tolerance)
        return undefined;
    }
    for (const v of sides)
      for (const q of shape.profile)
        if (
          !uvz.some(
            (p, i) =>
              Math.abs(p[1] - v) <= tolerance &&
              Math.hypot(local[i]![0] - q[0], local[i]![1] - q[1]) <= tolerance,
          )
        )
          return undefined;
    return shape;
  };
  // The underside from where it leaves the floor, else from how low it is at the top: either
  // measure can take a corner within the tolerance of the other (Codex), so each is tried.
  // First from the underside's own corners, how far below the nosings' line they are on
  // average (a corner within the tolerance of the floor or the top end is no help, Codex).
  const below = under.length
    ? under.reduce((a, i) => a + riser + local[i]![0] * slope - local[i]![1], 0) / under.length
    : NaN;
  let shape: ReturnType<typeof fits>;
  for (const drop of [below, foot > tolerance ? foot * slope + riser : NaN, risers * riser - end])
    if (Number.isFinite(drop) && (shape = fits(drop))) break;
  if (!shape) return undefined;
  const vc = (v0 + v1) / 2;
  return {
    start: [u0 * d[0] + vc * nrm[0], u0 * d[1] + vc * nrm[1]],
    directionRad: Math.atan2(d[1], d[0]),
    width: v1 - v0,
    risers,
    riser,
    tread,
    zBase: z0,
    waist: shape.waist,
  };
}
