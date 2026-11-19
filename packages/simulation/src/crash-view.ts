import type { CadMesh } from '@editor-platform/cad-kernel-occt';
import type { CrashRunFields } from './run-crash';

/**
 * VS7c-2 (docs/cad/vehicle-simulation.md, VS7): what a crash result shows beside the bodies: the
 * barrier as placed (the wall square to the travel, the pole, the ground under the wheels), the
 * accelerometer's waveform thinned for a chart, and a new crash study's measuring points from the
 * analysed bodies' bounds.
 */

/** The undeformed bounds of points (x, y, z each, mm). */
export function pointBounds(nodes: ArrayLike<number>): { lo: number[]; hi: number[] } {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < nodes.length; i += 3)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, nodes[i + a]!);
      hi[a] = Math.max(hi[a]!, nodes[i + a]!);
    }
  return { lo, hi };
}

/** The barrier's colour, and the ground's (fainter). */
export const crashBarrierColor = '#6b7480';
export const crashGroundColor = '#c9ced6';

export interface CrashBarrierView {
  mesh: CadMesh;
  color: string;
  kind: 'wall' | 'pole' | 'ground';
}

/**
 * The barrier and the ground of a crash run as display meshes: a wall (and the ground) as a
 * two-sided square half again as wide as the bodies, centred on them; a pole as a closed
 * cylinder of its radius from the ground to half again the bodies' height.
 */
export function crashBarrierViews(
  fields: Pick<CrashRunFields, 'nodes' | 'walls' | 'poles'>,
): CrashBarrierView[] {
  const { lo, hi } = pointBounds(fields.nodes);
  if (!(hi[0]! >= lo[0]!)) return [];
  const centre = [0, 1, 2].map((a) => (lo[a]! + hi[a]!) / 2);
  const size = Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) || 1;
  const out: CrashBarrierView[] = [];
  fields.walls.forEach((w, k) => {
    const n = unit(w.normal);
    const ground = Math.abs(n[2]!) > 0.99;
    // On the plane, nearest the bodies' centre.
    const d = dot(sub(centre, w.point), n);
    const c = sub(centre, scale(n, d));
    const [u, v] = tangents(n);
    const h = (ground ? 0.9 : 0.75) * size;
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([a, b]) => add(c, add(scale(u, a! * h), scale(v, b! * h))));
    const positions = corners.flat();
    out.push({
      kind: ground ? 'ground' : 'wall',
      color: ground ? crashGroundColor : crashBarrierColor,
      mesh: meshOf(`crash-${ground ? 'ground' : 'wall'}-${k}`, positions, [0, 1, 2, 0, 2, 3], true),
    });
  });
  const groundZ = fields.walls.find((w) => Math.abs(unit(w.normal)[2]!) > 0.99)?.point[2];
  fields.poles.forEach((p, k) => {
    const a = unit(p.axis);
    const [u, v] = tangents(a);
    // From the ground (or the bodies' bottom) to half again their height above it.
    const base = add(p.point, scale(a, dot(sub(centre, p.point), a)));
    const bottom = groundZ ?? lo[2]!;
    const top = hi[2]! + 0.5 * (hi[2]! - lo[2]!);
    const along = (z: number) => (Math.abs(a[2]!) > 1e-9 ? (z - base[2]!) / a[2]! : 0);
    const t0 = Math.min(along(bottom), along(top));
    const t1 = Math.max(along(bottom), along(top)) || size;
    const sides = 32;
    const positions: number[] = [];
    const indices: number[] = [];
    for (let s = 0; s < sides; s++) {
      const q = (2 * Math.PI * s) / sides;
      const r = add(scale(u, p.radius * Math.cos(q)), scale(v, p.radius * Math.sin(q)));
      positions.push(...add(base, add(r, scale(a, t0))), ...add(base, add(r, scale(a, t1))));
    }
    for (let s = 0; s < sides; s++) {
      const [b0, t0i, b1, t1i] = [
        2 * s,
        2 * s + 1,
        (2 * s + 2) % (2 * sides),
        (2 * s + 3) % (2 * sides),
      ];
      indices.push(b0, b1, t1i, b0, t1i, t0i);
    }
    // The caps, fanned from their centres.
    const bc = positions.length / 3;
    positions.push(...add(base, scale(a, t0)), ...add(base, scale(a, t1)));
    for (let s = 0; s < sides; s++) {
      const n = (s + 1) % sides;
      indices.push(bc, 2 * n, 2 * s, bc + 1, 2 * s + 1, 2 * n + 1);
    }
    out.push({
      kind: 'pole',
      color: crashBarrierColor,
      mesh: meshOf(`crash-pole-${k}`, positions, indices, false),
    });
  });
  return out;
}

/** A waveform thinned for a chart: times (ms) and the series at them. */
export interface CrashWaveform {
  time: number[];
  cfc60: number[];
  cfc180: number[];
  velocity: number[];
}

/**
 * The accelerometer's waveform in at most `points` buckets: each bucket's middle time, the
 * deceleration of largest size in it (so the peaks stay) and the velocity at its middle.
 */
export function crashWaveform(
  m: { time: Float64Array; cfc60: Float64Array; cfc180: Float64Array; velocity: Float64Array },
  points = 600,
): CrashWaveform {
  const n = m.time.length;
  const per = Math.max(1, Math.ceil(n / Math.max(1, points)));
  const out: CrashWaveform = { time: [], cfc60: [], cfc180: [], velocity: [] };
  const extreme = (a: Float64Array, from: number, to: number) => {
    let best = a[from]!;
    for (let k = from + 1; k < to; k++) if (Math.abs(a[k]!) > Math.abs(best)) best = a[k]!;
    return best;
  };
  for (let from = 0; from < n; from += per) {
    const to = Math.min(n, from + per);
    const mid = (from + to - 1) >> 1;
    out.time.push(m.time[mid]! * 1000);
    out.cfc60.push(extreme(m.cfc60, from, to));
    out.cfc180.push(extreme(m.cfc180, from, to));
    out.velocity.push(m.velocity[mid]!);
  }
  return out;
}

/**
 * VS8b: a head impact's resultant acceleration (CFC 1000 and unfiltered, g) at `points` or fewer
 * times (ms), each the largest of its stretch (the peak stays).
 */
export function headWaveform(
  m: { time: Float64Array; cfc1000: Float64Array; raw: Float64Array },
  points = 600,
): { time: number[]; cfc1000: number[]; raw: number[] } {
  const n = m.time.length;
  const per = Math.max(1, Math.ceil(n / Math.max(1, points)));
  const out = { time: [] as number[], cfc1000: [] as number[], raw: [] as number[] };
  const top = (a: Float64Array, from: number, to: number) => {
    let best = a[from]!;
    for (let k = from + 1; k < to; k++) if (a[k]! > best) best = a[k]!;
    return best;
  };
  for (let from = 0; from < n; from += per) {
    const to = Math.min(n, from + per);
    out.time.push(m.time[(from + to - 1) >> 1]! * 1000);
    out.cfc1000.push(top(m.cfc1000, from, to));
    out.raw.push(top(m.raw, from, to));
  }
  return out;
}

/**
 * A new crash study's measuring points from the analysed bodies' bounds (vehicle frame, mm): the
 * accelerometer on the left sill under the B-pillar (two fifths of the length from the tail, a
 * tenth in from the side and up from the bottom; the run takes the node nearest it), and a pole
 * struck on the right (the driver's side of a right-hand-drive car) at mid-length, half-way up.
 * VS8b: a headform aimed at the top, three quarters of the way to the nose on the centre line
 * (the hood of a car), the rest held beyond a third of the bodies' diagonal from it.
 */
export function crashStudyPoints(
  lo: readonly number[],
  hi: readonly number[],
): {
  accelerometer: [number, number, number];
  pole: { side: 'left' | 'right'; xMm: number; zMm: number };
  head: { targetMm: [number, number, number]; holdBeyondMm: number | null };
} {
  const at = (a: number, s: number) => Math.round(lo[a]! + s * (hi[a]! - lo[a]!));
  const diagonal = Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
  return {
    accelerometer: [at(0, 0.4), at(1, 0.9), at(2, 0.1)],
    pole: { side: 'right', xMm: at(0, 0.5), zMm: at(2, 0.5) },
    head: {
      targetMm: [at(0, 0.75), at(1, 0.5), at(2, 1)],
      holdBeyondMm: diagonal > 0 ? Math.max(10, Math.round(diagonal / 30) * 10) : null,
    },
  };
}

const dot = (a: readonly number[], b: readonly number[]) =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const add = (a: readonly number[], b: readonly number[]) => [0, 1, 2].map((k) => a[k]! + b[k]!);
const sub = (a: readonly number[], b: readonly number[]) => [0, 1, 2].map((k) => a[k]! - b[k]!);
const scale = (a: readonly number[], s: number) => a.map((x) => x * s);
const cross = (a: readonly number[], b: readonly number[]) => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
const unit = (a: readonly number[]) => scale(a, 1 / (Math.hypot(a[0]!, a[1]!, a[2]!) || 1));
/** Two unit vectors across `n`, right-handed with it (u × v = n). */
function tangents(n: readonly number[]): [number[], number[]] {
  const other = Math.abs(n[2]!) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = unit(cross(other, n));
  return [u, cross(n, u)];
}

/** A display mesh of triangles (no topology to pick), its own back faces when `twoSided`. */
function meshOf(
  bodyId: string,
  positions: number[],
  indices: number[],
  twoSided: boolean,
): CadMesh {
  const n = positions.length / 3;
  const all = [...positions];
  const tris = [...indices];
  if (twoSided) {
    all.push(...positions);
    for (let t = 0; t < indices.length; t += 3)
      tris.push(indices[t]! + n, indices[t + 2]! + n, indices[t + 1]! + n);
  }
  const m = all.length / 3;
  const origin: [number, number, number] = [0, 0, 0];
  const b = pointBounds(all);
  for (let k = 0; k < 3; k++) origin[k] = (b.lo[k]! + b.hi[k]!) / 2;
  const pos = new Float32Array(all.length);
  for (let v = 0; v < m; v++)
    for (let k = 0; k < 3; k++) pos[3 * v + k] = all[3 * v + k]! - origin[k]!;
  const normals = new Float32Array(pos.length);
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b1, c] = [tris[t]!, tris[t + 1]!, tris[t + 2]!];
    const e1 = [0, 1, 2].map((k) => pos[3 * b1 + k]! - pos[3 * a + k]!);
    const e2 = [0, 1, 2].map((k) => pos[3 * c + k]! - pos[3 * a + k]!);
    const nn = cross(e1, e2);
    for (const v of [a, b1, c]) for (let k = 0; k < 3; k++) normals[3 * v + k] += nn[k]!;
  }
  for (let v = 0; v < m; v++) {
    const l = Math.hypot(normals[3 * v]!, normals[3 * v + 1]!, normals[3 * v + 2]!) || 1;
    for (let k = 0; k < 3; k++) normals[3 * v + k] /= l;
  }
  return {
    bodyId,
    origin,
    positions: pos,
    normals,
    indices: new Uint32Array(tris),
    faceIds: new Uint32Array(tris.length / 3),
    vertices: new Float64Array(0),
    faceBase: 0,
    edgeBase: 0,
    edges: new Float32Array(0),
    edgeIds: new Uint32Array(0),
    topology: { faces: [], edges: [], vertices: [] },
  };
}
