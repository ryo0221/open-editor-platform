import { cornerNormals, triangulateFace } from './display';
import type { EpmMesh } from './epm';

/**
 * C7d normal-map bake: from the low-poly cage (the mesh the GLB carries, with its UVs) to the
 * sculpted multires surface. Each texel of the cage's UV layout casts a ray along the cage's
 * normal, both ways, and keeps the hit nearest the cage; the sculpted surface's normal there is
 * written in the cage's tangent space (the tangents the GLB export writes as `TANGENT`).
 */

export type BakeProblem = 'uv' | 'uv-range' | 'uv-overlap' | 'size' | 'high' | 'cancelled';
export class BakeError extends Error {
  constructor(
    readonly problem: BakeProblem,
    readonly detail: string,
    /** For `uv-overlap` and `uv-range`: the cage faces whose UVs overlap another face's, or leave the 0–1 tile. */
    readonly faces: number[] = [],
  ) {
    super(`bake-${problem}: ${detail}`);
    this.name = 'BakeError';
  }
}

export const bakeSizes: readonly number[] = Object.freeze([512, 1024, 2048, 4096]);

/**
 * A tangent per corner (x, y, z, w): the direction of increasing u on the face, made at right
 * angles to the corner's normal, summed over the triangles of every corner that shares the
 * vertex, normal and UV (the same corners the GLB export joins into one vertex). w is +1 or −1:
 * the bitangent is w · (n × t). Without UVs, undefined.
 */
export function cornerTangents(
  mesh: EpmMesh,
  normals: Float32Array = cornerNormals(mesh),
): Float32Array | undefined {
  const uv = mesh.uvs;
  if (!uv) return undefined;
  const corners = mesh.faceIndices.length;
  const P = mesh.positions;
  // The export's key: one output vertex per distinct (vertex, normal, UV).
  const group = new Uint32Array(corners);
  const keyOf = new Map<string, number>();
  for (let c = 0; c < corners; c++) {
    const key = [
      mesh.faceIndices[c],
      normals[3 * c],
      normals[3 * c + 1],
      normals[3 * c + 2],
      uv[2 * c],
      uv[2 * c + 1],
    ].join(',');
    let g = keyOf.get(key);
    if (g === undefined) {
      g = keyOf.size;
      keyOf.set(key, g);
    }
    group[c] = g;
  }
  const t = new Float64Array(3 * keyOf.size),
    b = new Float64Array(3 * keyOf.size);
  for (let f = 0, start = 0; f < mesh.faceSizes.length; start += mesh.faceSizes[f], f++) {
    const n = mesh.faceSizes[f];
    const tri = triangulateFace(mesh, start, n);
    for (let k = 0; k < tri.length; k += 3) {
      const c0 = start + tri[k],
        c1 = start + tri[k + 1],
        c2 = start + tri[k + 2];
      const v0 = 3 * mesh.faceIndices[c0],
        v1 = 3 * mesh.faceIndices[c1],
        v2 = 3 * mesh.faceIndices[c2];
      const e1 = [P[v1] - P[v0], P[v1 + 1] - P[v0 + 1], P[v1 + 2] - P[v0 + 2]];
      const e2 = [P[v2] - P[v0], P[v2 + 1] - P[v0 + 1], P[v2 + 2] - P[v0 + 2]];
      const du1 = uv[2 * c1] - uv[2 * c0],
        dv1 = uv[2 * c1 + 1] - uv[2 * c0 + 1];
      const du2 = uv[2 * c2] - uv[2 * c0],
        dv2 = uv[2 * c2 + 1] - uv[2 * c0 + 1];
      const det = du1 * dv2 - du2 * dv1;
      if (Math.abs(det) < 1e-20) continue;
      const r = 1 / det;
      // Weighted by the triangle's UV area through r's magnitude: summed as is.
      const sx = (e1[0] * dv2 - e2[0] * dv1) * r,
        sy = (e1[1] * dv2 - e2[1] * dv1) * r,
        sz = (e1[2] * dv2 - e2[2] * dv1) * r;
      const tx = (e2[0] * du1 - e1[0] * du2) * r,
        ty = (e2[1] * du1 - e1[1] * du2) * r,
        tz = (e2[2] * du1 - e1[2] * du2) * r;
      const area = Math.abs(det);
      for (const c of [c0, c1, c2]) {
        const g = 3 * group[c];
        t[g] += sx * area;
        t[g + 1] += sy * area;
        t[g + 2] += sz * area;
        b[g] += tx * area;
        b[g + 1] += ty * area;
        b[g + 2] += tz * area;
      }
    }
  }
  const out = new Float32Array(4 * corners);
  for (let c = 0; c < corners; c++) {
    const g = 3 * group[c];
    let nx = normals[3 * c],
      ny = normals[3 * c + 1],
      nz = normals[3 * c + 2];
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    // Gram–Schmidt against the normal; a degenerate tangent falls back to any perpendicular.
    let x = t[g],
      y = t[g + 1],
      z = t[g + 2];
    const d = x * nx + y * ny + z * nz;
    x -= d * nx;
    y -= d * ny;
    z -= d * nz;
    let l = Math.hypot(x, y, z);
    if (l < 1e-12) {
      [x, y, z] = Math.abs(nx) < 0.9 ? [0, -nz, ny] : [nz, 0, -nx];
      const dd = x * nx + y * ny + z * nz;
      x -= dd * nx;
      y -= dd * ny;
      z -= dd * nz;
      l = Math.hypot(x, y, z) || 1;
    }
    x /= l;
    y /= l;
    z /= l;
    // Handedness: does n × t point along the summed bitangent?
    const cx = ny * z - nz * y,
      cy = nz * x - nx * z,
      cz = nx * y - ny * x;
    const w = cx * b[g] + cy * b[g + 1] + cz * b[g + 2] < 0 ? -1 : 1;
    out.set([x, y, z, w], 4 * c);
  }
  return out;
}

/** The sculpted surface to bake from: positions (mm) and quads, as the multires gives them. */
export interface BakeHigh {
  positions: Float32Array;
  quads: Uint32Array;
}

export interface BakeInput {
  cage: EpmMesh;
  high: BakeHigh;
  /** Pixels on a side: one of `bakeSizes`. */
  size: number;
  /** How far from the cage a ray looks, each way, and how far the nearest surface point may be
   * when the ray misses (mm). Default: a quarter of the cage's diagonal (Catmull–Clark pulls a
   * coarse cage's corners in far). */
  distance?: number;
  /** Rows of texels done, for a progress bar; return true to stop (`cancelled`). */
  progress?(rows: number, size: number): boolean | void;
  /**
   * Measurement only (C7e): each phase's time (ms) as it ends: `setup` (normals, tangents, BVH),
   * `raster`, `rays`, `dilate`. Unset, nothing is timed and the result is the same.
   */
  timing?(phase: 'setup' | 'raster' | 'rays' | 'dilate', ms: number): void;
}

export interface BakeResult {
  size: number;
  /** RGB, rows from the top of the image (v = 1) down. */
  rgb: Uint8Array;
  /**
   * Texels inside the UV layout; those of them that found no sculpted surface within reach (they
   * keep the cage's normal); and those whose ray missed it, so the nearest point stood in.
   */
  covered: number;
  missed: number;
  nearest: number;
}

/**
 * Bakes the normal map. Refuses (`BakeError`) a cage without UVs (`uv`), UVs outside the one
 * 0–1 tile the map covers (`uv-range`, naming the faces: a tiled layout would bake nothing or
 * share texels), UVs where faces overlap (`uv-overlap`, naming the faces), a size not in `bakeSizes` (`size`), and an empty or malformed
 * high surface (`high`).
 */
export function bakeNormalMap(input: BakeInput): BakeResult {
  const { cage, high, size } = input;
  if (!bakeSizes.includes(size)) throw new BakeError('size', `size must be one of ${bakeSizes}`);
  if (!cage.uvs) throw new BakeError('uv', 'the cage has no UVs: unwrap it first');
  const outside: number[] = [];
  for (let f = 0, c = 0; f < cage.faceSizes.length; c += cage.faceSizes[f], f++)
    for (let k = c; k < c + cage.faceSizes[f]; k++) {
      const u = cage.uvs[2 * k],
        v = cage.uvs[2 * k + 1];
      if (u < -1e-6 || u > 1 + 1e-6 || v < -1e-6 || v > 1 + 1e-6) {
        outside.push(f);
        break;
      }
    }
  if (outside.length)
    throw new BakeError(
      'uv-range',
      `${outside.length} faces have UVs outside the 0–1 tile`,
      outside,
    );
  if (!high.quads.length || high.quads.length % 4 || high.positions.length % 3)
    throw new BakeError('high', 'the sculpted surface is empty');
  const V = high.positions.length / 3;
  for (let i = 0; i < high.quads.length; i++)
    if (high.quads[i] >= V) throw new BakeError('high', `quad index ${i} out of range`);
  let t0 = input.timing ? performance.now() : 0;
  const lap = (phase: 'setup' | 'raster' | 'rays' | 'dilate') => {
    if (!input.timing) return;
    const now = performance.now();
    input.timing(phase, now - t0);
    t0 = now;
  };
  const normals = cornerNormals(cage);
  const tangents = cornerTangents(cage, normals)!;
  const bvh = new TriangleBvh(high.positions, high.quads);
  const highNormals = vertexNormals(high.positions, high.quads);
  const P = cage.positions,
    U = cage.uvs;
  const distance =
    input.distance ??
    0.25 *
      (() => {
        const lo = [Infinity, Infinity, Infinity],
          hi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < P.length; i += 3)
          for (let k = 0; k < 3; k++) {
            lo[k] = Math.min(lo[k], P[i + k]);
            hi[k] = Math.max(hi[k], P[i + k]);
          }
        return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
      })();
  if (!(distance > 0)) throw new BakeError('high', 'distance must be above 0');
  lap('setup');
  // Raster: per texel the face and corner triangle that cover it, and its barycentrics.
  const texels = size * size;
  const owner = new Int32Array(texels).fill(-1);
  /** Per texel the triangle (of all faces, in order) that covers it, so a face folding over
   * itself in UV space is caught too. */
  const ownerTri = new Int32Array(texels).fill(-1);
  let triangle = -1;
  const tri = new Uint32Array(3 * texels);
  const bary = new Float32Array(2 * texels);
  const overlaps = new Set<number>();
  for (let f = 0, start = 0; f < cage.faceSizes.length; start += cage.faceSizes[f], f++) {
    const n = cage.faceSizes[f];
    const t = triangulateFace(cage, start, n);
    for (let k = 0; k < t.length; k += 3) {
      triangle++;
      const c = [start + t[k], start + t[k + 1], start + t[k + 2]];
      // Texel space: x right, y down from v = 1.
      const x = c.map((i) => U[2 * i] * size),
        y = c.map((i) => (1 - U[2 * i + 1]) * size);
      const det = (x[1] - x[0]) * (y[2] - y[0]) - (x[2] - x[0]) * (y[1] - y[0]);
      if (Math.abs(det) < 1e-12) continue;
      const x0 = Math.max(0, Math.floor(Math.min(...x))),
        x1 = Math.min(size - 1, Math.ceil(Math.max(...x))),
        y0 = Math.max(0, Math.floor(Math.min(...y))),
        y1 = Math.min(size - 1, Math.ceil(Math.max(...y)));
      for (let py = y0; py <= y1; py++)
        for (let px = x0; px <= x1; px++) {
          const sx = px + 0.5,
            sy = py + 0.5;
          const b1 = ((sx - x[0]) * (y[2] - y[0]) - (x[2] - x[0]) * (sy - y[0])) / det;
          const b2 = ((x[1] - x[0]) * (sy - y[0]) - (sx - x[0]) * (y[1] - y[0])) / det;
          const b0 = 1 - b1 - b2;
          if (b0 < -1e-6 || b1 < -1e-6 || b2 < -1e-6) continue;
          const o = py * size + px;
          if (ownerTri[o] >= 0 && ownerTri[o] !== triangle) {
            // Both strictly inside (not a texel on a shared edge): the UVs overlap.
            const inner = Math.min(b0, b1, b2) > 1e-3;
            const pb1 = bary[2 * o],
              pb2 = bary[2 * o + 1];
            if (inner && Math.min(1 - pb1 - pb2, pb1, pb2) > 1e-3) {
              overlaps.add(owner[o]);
              overlaps.add(f);
            }
            continue;
          }
          owner[o] = f;
          ownerTri[o] = triangle;
          tri.set(c, 3 * o);
          bary[2 * o] = b1;
          bary[2 * o + 1] = b2;
        }
    }
  }
  if (overlaps.size)
    throw new BakeError(
      'uv-overlap',
      `${overlaps.size} faces have UVs over another face`,
      [...overlaps].sort((a, b) => a - b),
    );
  lap('raster');
  const rgb = new Uint8Array(3 * texels);
  const filled = new Uint8Array(texels);
  let covered = 0,
    missed = 0,
    nearest = 0;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const o = py * size + px;
      if (owner[o] < 0) continue;
      covered++;
      const c0 = tri[3 * o],
        c1 = tri[3 * o + 1],
        c2 = tri[3 * o + 2];
      const b1 = bary[2 * o],
        b2 = bary[2 * o + 1],
        b0 = 1 - b1 - b2;
      const at = (a: Float32Array, n: number, k: number) =>
        a[n * c0 + k] * b0 + a[n * c1 + k] * b1 + a[n * c2 + k] * b2;
      const v0 = 3 * cage.faceIndices[c0],
        v1 = 3 * cage.faceIndices[c1],
        v2 = 3 * cage.faceIndices[c2];
      const p = [0, 1, 2].map((k) => P[v0 + k] * b0 + P[v1 + k] * b1 + P[v2 + k] * b2);
      let n = [at(normals, 3, 0), at(normals, 3, 1), at(normals, 3, 2)];
      const nl = Math.hypot(n[0], n[1], n[2]) || 1;
      n = n.map((x) => x / nl);
      let t = [at(tangents, 4, 0), at(tangents, 4, 1), at(tangents, 4, 2)];
      const d = t[0] * n[0] + t[1] * n[1] + t[2] * n[2];
      t = [t[0] - d * n[0], t[1] - d * n[1], t[2] - d * n[2]];
      const tl = Math.hypot(t[0], t[1], t[2]) || 1;
      t = t.map((x) => x / tl);
      const w = tangents[4 * c0 + 3] < 0 ? -1 : 1;
      const bt = [
        w * (n[1] * t[2] - n[2] * t[1]),
        w * (n[2] * t[0] - n[0] * t[2]),
        w * (n[0] * t[1] - n[1] * t[0]),
      ];
      // From the far side of the cage back through it: the hit nearest the cage.
      const hit = bvh.nearest(
        [p[0] + n[0] * distance, p[1] + n[1] * distance, p[2] + n[2] * distance],
        [-n[0], -n[1], -n[2]],
        distance,
      );
      // No hit along the ray (#773): a cage normal leaning along a long side (the end of a thin
      // box, whose surface Catmull–Clark pulls in) runs past the rounded end. The surface's
      // nearest point within reach stands in.
      const found = hit ?? bvh.closest(p, distance);
      let h = n;
      if (found) {
        if (!hit) nearest++;
        const q = found.triangle;
        const hn = [0, 1, 2].map(
          (k) =>
            highNormals[3 * q[0] + k] * (1 - found.u - found.v) +
            highNormals[3 * q[1] + k] * found.u +
            highNormals[3 * q[2] + k] * found.v,
        );
        const hl = Math.hypot(hn[0], hn[1], hn[2]);
        if (hl > 0) h = hn.map((x) => x / hl);
      } else missed++;
      const tx = h[0] * t[0] + h[1] * t[1] + h[2] * t[2],
        ty = h[0] * bt[0] + h[1] * bt[1] + h[2] * bt[2],
        tz = h[0] * n[0] + h[1] * n[1] + h[2] * n[2];
      rgb[3 * o] = encode(tx);
      rgb[3 * o + 1] = encode(ty);
      rgb[3 * o + 2] = encode(tz);
      filled[o] = 1;
    }
    if (input.progress?.(py + 1, size)) throw new BakeError('cancelled', 'the bake was stopped');
  }
  lap('rays');
  dilate(rgb, filled, size, Math.max(2, size / 128));
  for (let o = 0; o < texels; o++)
    if (!filled[o]) {
      rgb[3 * o] = 128;
      rgb[3 * o + 1] = 128;
      rgb[3 * o + 2] = 255;
    }
  lap('dilate');
  return { size, rgb, covered, missed, nearest };
}

const encode = (x: number) => Math.max(0, Math.min(255, Math.round((x * 0.5 + 0.5) * 255)));

/** Grows the baked texels out past the UV borders, `passes` texels, so filtering does not bleed. */
function dilate(rgb: Uint8Array, filled: Uint8Array, size: number, passes: number) {
  for (let pass = 0; pass < passes; pass++) {
    const add: number[] = [];
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const o = y * size + x;
        if (filled[o]) continue;
        let r = 0,
          g = 0,
          b = 0,
          n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx,
              yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
            const q = yy * size + xx;
            if (filled[q] !== 1) continue;
            r += rgb[3 * q];
            g += rgb[3 * q + 1];
            b += rgb[3 * q + 2];
            n++;
          }
        if (!n) continue;
        rgb[3 * o] = Math.round(r / n);
        rgb[3 * o + 1] = Math.round(g / n);
        rgb[3 * o + 2] = Math.round(b / n);
        add.push(o);
      }
    if (!add.length) break;
    for (const o of add) filled[o] = 1;
  }
}

/** Area-weighted vertex normals of a quad surface. */
function vertexNormals(P: Float32Array, Q: Uint32Array): Float32Array {
  const out = new Float32Array(P.length);
  for (let q = 0; q < Q.length; q += 4) {
    const a = 3 * Q[q],
      b = 3 * Q[q + 1],
      c = 3 * Q[q + 2],
      d = 3 * Q[q + 3];
    const ux = P[c] - P[a],
      uy = P[c + 1] - P[a + 1],
      uz = P[c + 2] - P[a + 2];
    const vx = P[d] - P[b],
      vy = P[d + 1] - P[b + 1],
      vz = P[d + 2] - P[b + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    for (const v of [a, b, c, d]) {
      out[v] += nx;
      out[v + 1] += ny;
      out[v + 2] += nz;
    }
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i], out[i + 1], out[i + 2]);
    if (l > 0) {
      out[i] /= l;
      out[i + 1] /= l;
      out[i + 2] /= l;
    }
  }
  return out;
}

/**
 * A bounding-volume hierarchy over a quad surface's triangles (two per quad), for rays. Built
 * by splitting at the median centroid along the longest axis; leaves hold up to 4 triangles.
 */
export class TriangleBvh {
  private readonly tris: Uint32Array;
  private readonly order: Uint32Array;
  /** Per node: min xyz, max xyz. */
  private readonly boxes: Float32Array;
  /** Per node: left child (or −1 for a leaf), right child, first, count. */
  private readonly nodes: Int32Array;
  private nodeCount = 0;

  constructor(
    private readonly positions: Float32Array,
    quads: Uint32Array,
  ) {
    const T = (quads.length / 4) * 2;
    this.tris = new Uint32Array(3 * T);
    for (let q = 0, t = 0; q < quads.length; q += 4, t += 6) {
      this.tris.set(
        [quads[q], quads[q + 1], quads[q + 2], quads[q], quads[q + 2], quads[q + 3]],
        t,
      );
    }
    this.order = new Uint32Array(T);
    for (let i = 0; i < T; i++) this.order[i] = i;
    const maxNodes = 2 * T + 1;
    this.boxes = new Float32Array(6 * maxNodes);
    this.nodes = new Int32Array(4 * maxNodes);
    const centroid = new Float32Array(3 * T);
    for (let t = 0; t < T; t++)
      for (let k = 0; k < 3; k++)
        centroid[3 * t + k] =
          (positions[3 * this.tris[3 * t] + k] +
            positions[3 * this.tris[3 * t + 1] + k] +
            positions[3 * this.tris[3 * t + 2] + k]) /
          3;
    // Iterative build.
    const stack: [number, number, number][] = [[this.alloc(), 0, T]];
    while (stack.length) {
      const [node, first, count] = stack.pop()!;
      const lo = [Infinity, Infinity, Infinity],
        hi = [-Infinity, -Infinity, -Infinity];
      const clo = [Infinity, Infinity, Infinity],
        chi = [-Infinity, -Infinity, -Infinity];
      for (let i = first; i < first + count; i++) {
        const t = this.order[i];
        for (let j = 0; j < 3; j++) {
          const v = 3 * this.tris[3 * t + j];
          for (let k = 0; k < 3; k++) {
            lo[k] = Math.min(lo[k], positions[v + k]);
            hi[k] = Math.max(hi[k], positions[v + k]);
          }
        }
        for (let k = 0; k < 3; k++) {
          clo[k] = Math.min(clo[k], centroid[3 * t + k]);
          chi[k] = Math.max(chi[k], centroid[3 * t + k]);
        }
      }
      this.boxes.set([...lo, ...hi], 6 * node);
      const axis =
        chi[0] - clo[0] >= chi[1] - clo[1] && chi[0] - clo[0] >= chi[2] - clo[2]
          ? 0
          : chi[1] - clo[1] >= chi[2] - clo[2]
            ? 1
            : 2;
      if (count <= 4 || chi[axis] - clo[axis] <= 0) {
        this.nodes.set([-1, -1, first, count], 4 * node);
        continue;
      }
      const slice = this.order.subarray(first, first + count);
      slice.sort((a, b) => centroid[3 * a + axis] - centroid[3 * b + axis]);
      const half = count >> 1;
      const left = this.alloc(),
        right = this.alloc();
      this.nodes.set([left, right, first, count], 4 * node);
      stack.push([left, first, half], [right, first + half, count - half]);
    }
  }

  private alloc() {
    return this.nodeCount++;
  }

  /**
   * The hit along the ray (origin, unit dir) for t in [0, 2 · reach] nearest t = reach, with its
   * triangle's vertices and barycentrics (u at the second vertex, v at the third).
   */
  nearest(
    origin: number[],
    dir: number[],
    reach: number,
  ): { t: number; triangle: [number, number, number]; u: number; v: number } | undefined {
    const P = this.positions;
    const inv = dir.map((d) => (Math.abs(d) > 1e-15 ? 1 / d : 1e15 * (d < 0 ? -1 : 1)));
    let best: { t: number; triangle: [number, number, number]; u: number; v: number } | undefined;
    let bestGap = Infinity;
    const stack = [0];
    while (stack.length) {
      const node = stack.pop()!;
      const b = 6 * node;
      let t0 = 0,
        t1 = 2 * reach;
      for (let k = 0; k < 3; k++) {
        let a = (this.boxes[b + k] - origin[k]) * inv[k],
          c = (this.boxes[b + 3 + k] - origin[k]) * inv[k];
        if (a > c) [a, c] = [c, a];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, c);
      }
      if (t0 > t1) continue;
      // The nearest this box can come to t = reach.
      const gap = reach < t0 ? t0 - reach : reach > t1 ? reach - t1 : 0;
      if (gap >= bestGap) continue;
      const n = 4 * node;
      if (this.nodes[n] >= 0) {
        stack.push(this.nodes[n], this.nodes[n + 1]);
        continue;
      }
      for (let i = this.nodes[n + 2]; i < this.nodes[n + 2] + this.nodes[n + 3]; i++) {
        const tr = this.order[i];
        const a = 3 * this.tris[3 * tr],
          bb = 3 * this.tris[3 * tr + 1],
          c = 3 * this.tris[3 * tr + 2];
        // Möller–Trumbore, both faces.
        const e1x = P[bb] - P[a],
          e1y = P[bb + 1] - P[a + 1],
          e1z = P[bb + 2] - P[a + 2];
        const e2x = P[c] - P[a],
          e2y = P[c + 1] - P[a + 1],
          e2z = P[c + 2] - P[a + 2];
        const px = dir[1] * e2z - dir[2] * e2y,
          py = dir[2] * e2x - dir[0] * e2z,
          pz = dir[0] * e2y - dir[1] * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-18) continue;
        const id = 1 / det;
        const sx = origin[0] - P[a],
          sy = origin[1] - P[a + 1],
          sz = origin[2] - P[a + 2];
        const u = (sx * px + sy * py + sz * pz) * id;
        if (u < -1e-7 || u > 1 + 1e-7) continue;
        const qx = sy * e1z - sz * e1y,
          qy = sz * e1x - sx * e1z,
          qz = sx * e1y - sy * e1x;
        const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * id;
        if (v < -1e-7 || u + v > 1 + 1e-7) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * id;
        if (t < 0 || t > 2 * reach) continue;
        const g = Math.abs(t - reach);
        if (g < bestGap) {
          bestGap = g;
          best = {
            t,
            triangle: [a / 3, bb / 3, c / 3],
            u,
            v,
          };
        }
      }
    }
    return best;
  }

  /**
   * The point of the surface nearest `point` within `radius`, with its triangle's vertices and
   * barycentrics (u at the second vertex, v at the third), or undefined if none is that near.
   */
  closest(
    point: number[],
    radius: number,
  ): { distance: number; triangle: [number, number, number]; u: number; v: number } | undefined {
    const P = this.positions;
    let best:
      | { distance: number; triangle: [number, number, number]; u: number; v: number }
      | undefined;
    let bestSq = radius * radius;
    const stack = [0];
    while (stack.length) {
      const node = stack.pop()!;
      const b = 6 * node;
      let sq = 0;
      for (let k = 0; k < 3; k++) {
        const x = point[k];
        const d =
          x < this.boxes[b + k]
            ? this.boxes[b + k] - x
            : x > this.boxes[b + 3 + k]
              ? x - this.boxes[b + 3 + k]
              : 0;
        sq += d * d;
      }
      if (sq > bestSq) continue;
      const n = 4 * node;
      if (this.nodes[n] >= 0) {
        stack.push(this.nodes[n], this.nodes[n + 1]);
        continue;
      }
      for (let i = this.nodes[n + 2]; i < this.nodes[n + 2] + this.nodes[n + 3]; i++) {
        const tr = this.order[i];
        const a = this.tris[3 * tr],
          bb = this.tris[3 * tr + 1],
          c = this.tris[3 * tr + 2];
        const [u, v] = closestOnTriangle(P, a, bb, c, point);
        let d2 = 0;
        for (let k = 0; k < 3; k++) {
          const q = P[3 * a + k] * (1 - u - v) + P[3 * bb + k] * u + P[3 * c + k] * v - point[k];
          d2 += q * q;
        }
        if (d2 <= bestSq) {
          bestSq = d2;
          best = { distance: Math.sqrt(d2), triangle: [a, bb, c], u, v };
        }
      }
    }
    return best;
  }
}

/** Barycentrics (u at b, v at c) of the point of triangle abc nearest p (Ericson, 5.1.5). */
function closestOnTriangle(
  P: Float32Array,
  ia: number,
  ib: number,
  ic: number,
  p: number[],
): [number, number] {
  const a = 3 * ia,
    b = 3 * ib,
    c = 3 * ic;
  const abx = P[b] - P[a],
    aby = P[b + 1] - P[a + 1],
    abz = P[b + 2] - P[a + 2];
  const acx = P[c] - P[a],
    acy = P[c + 1] - P[a + 1],
    acz = P[c + 2] - P[a + 2];
  const apx = p[0] - P[a],
    apy = p[1] - P[a + 1],
    apz = p[2] - P[a + 2];
  const d1 = abx * apx + aby * apy + abz * apz,
    d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return [0, 0];
  const bpx = p[0] - P[b],
    bpy = p[1] - P[b + 1],
    bpz = p[2] - P[b + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz,
    d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return [1, 0];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return [d1 / (d1 - d3), 0];
  const cpx = p[0] - P[c],
    cpy = p[1] - P[c + 1],
    cpz = p[2] - P[c + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz,
    d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return [0, 1];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return [0, d2 / (d2 - d6)];
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [1 - w, w];
  }
  const denom = 1 / (va + vb + vc);
  return [vb * denom, vc * denom];
}

/** An RGB image as a PNG (8-bit, filter Up per row, zlib through `CompressionStream`). */
export async function encodeRgbPng(rgb: Uint8Array, width: number, height: number) {
  if (rgb.length !== 3 * width * height) throw new BakeError('size', 'pixels and size differ');
  const stride = 3 * width;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = y ? 2 : 0;
    for (let i = 0; i < stride; i++) {
      const here = rgb[y * stride + i];
      raw[o + 1 + i] = y ? (here - rgb[(y - 1) * stride + i]) & 255 : here;
    }
  }
  const zlib = new Uint8Array(
    await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate')),
    ).arrayBuffer(),
  );
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

let crcTable: Uint32Array | undefined;
function crc32(bytes: Uint8Array) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
