/**
 * VS4c (docs/cad/vehicle-simulation.md, VS4): what a wind-tunnel run shows besides its
 * coefficients: the pressure coefficient on the bodies (and on the Host the skin friction and the
 * heat transfer coefficient), streamlines from a rake ahead of the bodies, and the flow speed on a
 * section plane. The browser flow is on the tunnel's grid (the bodies turned by the yaw and
 * mirrored, VS4b); everything shown here is in the vehicle frame. Display only: nothing is stored.
 */
import type { CadMesh } from '@editor-platform/cad-kernel-occt';
import {
  sampleVelocity,
  streamline,
  type Grid,
  type Voxelization,
} from '@editor-platform/geometry-cfd';
import { resultColor } from './results';

/** The browser flow of a wind-tunnel run: its mean velocity on the tunnel's grid. */
export interface AeroFlowField {
  grid: Grid;
  /** x, y, z per cell, as a share of the inflow speed (tunnel frame). */
  velocity: Float32Array;
  /** 1 where the cell is in a body. */
  solid: Uint8Array;
  /** The tunnel's turn (the study's yaw, degrees). */
  yawDeg: number;
}

/** R3e-4c's fields for a wind-tunnel run (VS4c): the bodies' surface and its values per point. */
export interface AeroRunFields {
  kind: 'aero';
  /** The analysed bodies' surface (vehicle frame, mm, x y z per point) and its triangles. */
  points: Float64Array;
  triangles: Uint32Array;
  /** Pressure coefficient per point. */
  cp: Float64Array;
  /** Host only: skin friction coefficient and heat transfer coefficient (W/(m²·K)) per point. */
  cf?: Float64Array;
  htc?: Float64Array;
  /** Browser only: the flow, for streamlines and sections. */
  flow?: AeroFlowField;
}

/** From the vehicle frame to the tunnel's (VS4b's `toTunnel`): turned by the yaw, x mirrored. */
export function vehicleToTunnel(yawDeg: number, p: readonly number[]): [number, number, number] {
  const a = (yawDeg * Math.PI) / 180;
  const [c, s] = [Math.cos(a), Math.sin(a)];
  return [-(p[0]! * c - p[1]! * s), p[0]! * s + p[1]! * c, p[2]!];
}

/** From the tunnel's frame back to the vehicle's. */
export function tunnelToVehicle(yawDeg: number, p: readonly number[]): [number, number, number] {
  const a = (yawDeg * Math.PI) / 180;
  const [c, s] = [Math.cos(a), Math.sin(a)];
  const u = -p[0]!;
  return [u * c + p[1]! * s, -u * s + p[1]! * c, p[2]!];
}

/** Per-triangle values as per-point ones, each point the area-weighted mean of its triangles. */
export function triangleToPoint(
  points: Float64Array,
  triangles: Uint32Array,
  values: ArrayLike<number>,
): Float64Array {
  const sum = new Float64Array(points.length / 3);
  const weight = new Float64Array(points.length / 3);
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [triangles[t]!, triangles[t + 1]!, triangles[t + 2]!];
    const e = (i: number, j: number, k: number) => points[3 * j + k]! - points[3 * i + k]!;
    const [ux, uy, uz] = [e(a, b, 0), e(a, b, 1), e(a, b, 2)];
    const [vx, vy, vz] = [e(a, c, 0), e(a, c, 1), e(a, c, 2)];
    const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    const v = values[t / 3]!;
    if (!Number.isFinite(v)) continue;
    for (const p of [a, b, c]) {
      sum[p] += v * area;
      weight[p] += area;
    }
  }
  for (let p = 0; p < sum.length; p++) sum[p] = weight[p]! > 0 ? sum[p]! / weight[p]! : 0;
  return sum;
}

/**
 * Values sampled at `samples` (x y z each, mm) carried to `points`: each point takes its nearest
 * sample's (a hash of cells about the samples' spacing, searched ring by ring).
 */
export function nearestSamples(
  points: Float64Array,
  samples: ArrayLike<number>,
  values: readonly ArrayLike<number>[],
): Float64Array[] {
  const n = samples.length / 3;
  const out = values.map(() => new Float64Array(points.length / 3));
  if (n === 0) return out;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < samples.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, samples[i + k]!);
      hi[k] = Math.max(hi[k]!, samples[i + k]!);
    }
  const extent = Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!, 1e-6);
  const cell = Math.max(extent / Math.cbrt(n) / 2, 1e-6);
  const key = (i: number, j: number, k: number) => `${i},${j},${k}`;
  const grid = new Map<string, number[]>();
  const at = (v: number, k: number) => Math.floor((v - lo[k]!) / cell);
  for (let s = 0; s < n; s++) {
    const kk = key(at(samples[3 * s]!, 0), at(samples[3 * s + 1]!, 1), at(samples[3 * s + 2]!, 2));
    const list = grid.get(kk);
    if (list) list.push(s);
    else grid.set(kk, [s]);
  }
  const span = Math.ceil(extent / cell) + 2;
  for (let p = 0; p < points.length / 3; p++) {
    const [x, y, z] = [points[3 * p]!, points[3 * p + 1]!, points[3 * p + 2]!];
    const [ci, cj, ck] = [at(x, 0), at(y, 1), at(z, 2)];
    let best = -1;
    let dist = Infinity;
    // Ring r holds every cell at Chebyshev distance r; past the best distance found, stop.
    for (let r = 0; r <= span && (best < 0 || (r - 1) * cell <= dist); r++)
      for (let i = ci - r; i <= ci + r; i++)
        for (let j = cj - r; j <= cj + r; j++)
          for (let k = ck - r; k <= ck + r; k++) {
            if (Math.max(Math.abs(i - ci), Math.abs(j - cj), Math.abs(k - ck)) !== r) continue;
            for (const s of grid.get(key(i, j, k)) ?? []) {
              const d = Math.hypot(
                samples[3 * s]! - x,
                samples[3 * s + 1]! - y,
                samples[3 * s + 2]! - z,
              );
              if (d < dist) [best, dist] = [s, d];
            }
          }
    values.forEach((v, i) => (out[i]![p] = v[best]!));
  }
  return out;
}

/** A display mesh of `positions` (world mm) and `indices`, its vertex colours from `values`. */
function shownMesh(
  bodyId: string,
  positions: number[],
  indices: number[],
  values: number[],
  range: [number, number],
  /** Per vertex; by default from the triangles. */
  given?: number[],
): { mesh: CadMesh; colors: Float32Array } {
  const n = positions.length / 3;
  const origin: [number, number, number] = [0, 0, 0];
  if (n > 0)
    for (let k = 0; k < 3; k++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let v = 0; v < n; v++) {
        lo = Math.min(lo, positions[3 * v + k]!);
        hi = Math.max(hi, positions[3 * v + k]!);
      }
      origin[k] = (lo + hi) / 2;
    }
  const pos = new Float32Array(positions.length);
  for (let v = 0; v < n; v++)
    for (let k = 0; k < 3; k++) pos[3 * v + k] = positions[3 * v + k]! - origin[k]!;
  const normals = new Float32Array(pos.length);
  if (given) normals.set(given);
  else
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
      const e1 = [0, 1, 2].map((k) => pos[3 * b + k]! - pos[3 * a + k]!);
      const e2 = [0, 1, 2].map((k) => pos[3 * c + k]! - pos[3 * a + k]!);
      const nn = [
        e1[1]! * e2[2]! - e1[2]! * e2[1]!,
        e1[2]! * e2[0]! - e1[0]! * e2[2]!,
        e1[0]! * e2[1]! - e1[1]! * e2[0]!,
      ];
      for (const v of [a, b, c]) for (let k = 0; k < 3; k++) normals[3 * v + k] += nn[k]!;
    }
  for (let v = 0; v < n; v++) {
    const l = Math.hypot(normals[3 * v]!, normals[3 * v + 1]!, normals[3 * v + 2]!) || 1;
    for (let k = 0; k < 3; k++) normals[3 * v + k] /= l;
  }
  const span = range[1] - range[0];
  const colors = new Float32Array(n * 3);
  values.forEach((x, i) => colors.set(resultColor(span > 0 ? (x - range[0]) / span : 0), i * 3));
  return {
    colors,
    mesh: {
      bodyId,
      origin,
      positions: pos,
      normals,
      indices: new Uint32Array(indices),
      faceIds: new Uint32Array(indices.length / 3),
      vertices: new Float64Array(0),
      faceBase: 0,
      edgeBase: 0,
      edges: new Float32Array(0),
      edgeIds: new Uint32Array(0),
      topology: { faces: [], edges: [], vertices: [] },
    },
  };
}

/** The speed (share of the inflow) at a vehicle-frame point, or null outside the tunnel. */
function speedAt(flow: AeroFlowField, p: readonly number[], out = new Float64Array(3)) {
  const [x, y, z] = vehicleToTunnel(flow.yawDeg, p);
  const v = sampleVelocity(flow.velocity, flow.grid, x, y, z, out);
  return v ? Math.hypot(v[0]!, v[1]!, v[2]!) : null;
}

const solidAt = (flow: AeroFlowField, p: readonly number[]) => {
  const [x, y, z] = vehicleToTunnel(flow.yawDeg, p);
  const { origin, spacing: h, dims } = flow.grid;
  const i = Math.floor((x - origin[0]) / h);
  const j = Math.floor((y - origin[1]) / h);
  const k = Math.floor((z - origin[2]) / h);
  if (i < 0 || j < 0 || k < 0 || i >= dims[0] || j >= dims[1] || k >= dims[2]) return true;
  return flow.solid[i + dims[0] * (j + dims[1] * k)] === 1;
};

const tubeSides = 16;

/** The colour range of the flow views: the speed from 0 to 1.5 × the inflow. */
export const aeroSpeedRange: [number, number] = [0, 1.5];

/**
 * The flow speed on the plane `axis = offset` (vehicle frame, mm) over the bodies' surroundings
 * (`lo`–`hi` grown by half the bodies' length), as a grid of squares of the tunnel's cell; a
 * square with a corner in a body or outside the tunnel is left out.
 */
export function aeroSection(
  flow: AeroFlowField,
  axis: 0 | 1 | 2,
  offset: number,
  lo: readonly number[],
  hi: readonly number[],
): { mesh: CadMesh; colors: Float32Array; values: number[] } {
  const [s, r] = [(axis + 1) % 3, (axis + 2) % 3];
  const L = Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
  const from = [lo[0]! - 0.5 * L, lo[1]! - 0.5 * L, Math.max(0, lo[2]! - 0.5 * L)];
  const to = [hi[0]! + 0.5 * L, hi[1]! + 0.5 * L, hi[2]! + 0.5 * L];
  const h = flow.grid.spacing;
  const ns = Math.max(1, Math.min(400, Math.ceil((to[s]! - from[s]!) / h)));
  const nr = Math.max(1, Math.min(400, Math.ceil((to[r]! - from[r]!) / h)));
  const positions: number[] = [];
  const values: number[] = [];
  const index = new Map<number, number>();
  const tmp = new Float64Array(3);
  const corner = (a: number, b: number) => {
    const key = a * (nr + 1) + b;
    const known = index.get(key);
    if (known !== undefined) return known;
    const p = [0, 0, 0];
    p[axis] = offset;
    p[s] = from[s]! + ((to[s]! - from[s]!) * a) / ns;
    p[r] = from[r]! + ((to[r]! - from[r]!) * b) / nr;
    if (solidAt(flow, p)) {
      index.set(key, -1);
      return -1;
    }
    const v = speedAt(flow, p, tmp);
    if (v === null) {
      index.set(key, -1);
      return -1;
    }
    const i = values.length;
    positions.push(p[0]!, p[1]!, p[2]!);
    values.push(v);
    index.set(key, i);
    return i;
  };
  const indices: number[] = [];
  for (let a = 0; a < ns; a++)
    for (let b = 0; b < nr; b++) {
      const q = [corner(a, b), corner(a + 1, b), corner(a + 1, b + 1), corner(a, b + 1)];
      if (q.some((i) => i < 0)) continue;
      // (s, r, axis) is right-handed: this winding faces +axis.
      indices.push(q[0]!, q[1]!, q[2]!, q[0]!, q[2]!, q[3]!);
    }
  // The plane is looked at from either side: the back is its own vertices facing −axis.
  const n = values.length;
  const normals: number[] = [];
  for (let v = 0; v < n; v++) normals.push(...[0, 1, 2].map((k) => (k === axis ? 1 : 0)));
  for (let v = 0; v < n; v++) {
    positions.push(positions[3 * v]!, positions[3 * v + 1]!, positions[3 * v + 2]!);
    values.push(values[v]!);
    normals.push(...[0, 1, 2].map((k) => (k === axis ? -1 : 0)));
  }
  const front = indices.length;
  for (let t = 0; t < front; t += 3)
    indices.push(indices[t]! + n, indices[t + 2]! + n, indices[t + 1]! + n);
  return {
    ...shownMesh('aero-section', positions, indices, values, aeroSpeedRange, normals),
    values: values.slice(0, n),
  };
}

/**
 * Streamlines from a rake of `across` × `up` seeds a fifth of the bodies' length ahead of them,
 * over their width and height (and a little beyond), as thin tubes coloured by speed, up to four
 * lengths of the bodies long.
 */
export function aeroStreamlines(
  flow: AeroFlowField,
  across = 12,
  up = 6,
): { mesh: CadMesh; colors: Float32Array; lines: number } {
  const { grid, solid } = flow;
  const h = grid.spacing;
  // The bodies' bounds in the tunnel, from its solid cells.
  const [nx, ny, nz] = grid.dims;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++)
        if (solid[i + nx * (j + ny * k)] && k > 0) {
          const c = [i, j, k];
          for (let a = 0; a < 3; a++) {
            lo[a] = Math.min(lo[a]!, grid.origin[a]! + c[a]! * h);
            hi[a] = Math.max(hi[a]!, grid.origin[a]! + (c[a]! + 1) * h);
          }
        }
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const values: number[] = [];
  if (!(lo[0]! <= hi[0]!))
    return { ...shownMesh('aero-streamlines', [], [], [], aeroSpeedRange), lines: 0 };
  const L = hi[0]! - lo[0]!;
  const W = hi[1]! - lo[1]!;
  const H = hi[2]!;
  const x0 = Math.max(grid.origin[0] + h, lo[0]! - 0.2 * L);
  const radius = Math.max(0.35 * h, 0.004 * L);
  const vox = { grid, solid } as unknown as Voxelization;
  const v = new Float64Array(3);
  let lines = 0;
  for (let a = 0; a < across; a++)
    for (let b = 0; b < up; b++) {
      const seed: [number, number, number] = [
        x0,
        lo[1]! - 0.1 * W + (1.2 * W * (a + 0.5)) / across,
        h + ((1.2 * H - h) * (b + 0.5)) / up,
      ];
      const line = streamline(vox, flow.velocity, seed, {
        stepMm: h,
        maxSteps: Math.ceil((4 * L) / h),
      });
      const n = line.length / 3;
      if (n < 2) continue;
      lines++;
      // A round tube: `tubeSides` corners about each point, across its direction (sides under 25°
      // apart, so the viewport draws no edge along it).
      const base = positions.length / 3;
      for (let p = 0; p < n; p++) {
        const q = Math.min(n - 1, p + 1);
        const o = Math.max(0, q - 1);
        let d = [0, 1, 2].map((k) => line[3 * q + k]! - line[3 * o + k]!);
        const dl = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
        d = d.map((x) => x / dl);
        // A side vector across d, then the other side.
        const ref = Math.abs(d[2]!) < 0.9 ? [0, 0, 1] : [0, 1, 0];
        let e = [
          d[1]! * ref[2]! - d[2]! * ref[1]!,
          d[2]! * ref[0]! - d[0]! * ref[2]!,
          d[0]! * ref[1]! - d[1]! * ref[0]!,
        ];
        const el = Math.hypot(e[0]!, e[1]!, e[2]!) || 1;
        e = e.map((x) => x / el);
        const f = [
          d[1]! * e[2]! - d[2]! * e[1]!,
          d[2]! * e[0]! - d[0]! * e[2]!,
          d[0]! * e[1]! - d[1]! * e[0]!,
        ];
        const at = [line[3 * p]!, line[3 * p + 1]!, line[3 * p + 2]!];
        const s = sampleVelocity(flow.velocity, grid, at[0]!, at[1]!, at[2]!, v);
        const speed = s ? Math.hypot(s[0]!, s[1]!, s[2]!) : 0;
        for (let c = 0; c < tubeSides; c++) {
          const [ce, cf] = [
            Math.cos((2 * Math.PI * c) / tubeSides),
            Math.sin((2 * Math.PI * c) / tubeSides),
          ];
          const out = [0, 1, 2].map((k) => ce * e[k]! + cf * f[k]!);
          const w = [0, 1, 2].map((k) => at[k]! + radius * out[k]!);
          positions.push(...tunnelToVehicle(flow.yawDeg, w));
          // A direction: turned as a point about the origin.
          normals.push(...tunnelToVehicle(flow.yawDeg, out));
          values.push(speed);
        }
      }
      for (let p = 0; p + 1 < n; p++)
        for (let c = 0; c < tubeSides; c++) {
          const a0 = base + tubeSides * p + c;
          const a1 = base + tubeSides * p + ((c + 1) % tubeSides);
          const b0 = a0 + tubeSides;
          const b1 = a1 + tubeSides;
          // (e, f, d) is right-handed, so a0 → a1 → b1 faces outward in the tunnel; the mirror
          // back to the vehicle frame reverses that.
          indices.push(a0, b1, a1, a0, b0, b1);
        }
    }
  return {
    ...shownMesh('aero-streamlines', positions, indices, values, aeroSpeedRange, normals),
    lines,
  };
}
