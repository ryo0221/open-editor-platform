import type { Grid, TriangleSurface, Voxelization } from './voxelize';

/** Velocity at a point (mm) by trilinear interpolation between cell centres (lattice units). */
export function sampleVelocity(
  velocity: Float32Array,
  grid: Grid,
  x: number,
  y: number,
  z: number,
  out = new Float64Array(3),
): Float64Array | null {
  const [nx, ny, nz] = grid.dims;
  const h = grid.spacing;
  const gx = (x - grid.origin[0]) / h - 0.5;
  const gy = (y - grid.origin[1]) / h - 0.5;
  const gz = (z - grid.origin[2]) / h - 0.5;
  if (!(gx >= 0 && gy >= 0 && gz >= 0 && gx <= nx - 1 && gy <= ny - 1 && gz <= nz - 1)) return null;
  const i = Math.min(nx - 2, Math.floor(gx)),
    j = Math.min(ny - 2, Math.floor(gy)),
    k = Math.min(nz - 2, Math.floor(gz));
  const fx = gx - i,
    fy = gy - j,
    fz = gz - k;
  out.fill(0);
  for (let c = 0; c < 8; c++) {
    const di = c & 1,
      dj = (c >> 1) & 1,
      dk = (c >> 2) & 1;
    const w = (di ? fx : 1 - fx) * (dj ? fy : 1 - fy) * (dk ? fz : 1 - fz);
    const cell = i + di + nx * (j + dj + ny * (k + dk));
    out[0] += w * velocity[3 * cell]!;
    out[1] += w * velocity[3 * cell + 1]!;
    out[2] += w * velocity[3 * cell + 2]!;
  }
  return out;
}

/**
 * A streamline from `seed` (mm) by midpoint steps of `stepMm` along the velocity, until it leaves
 * the grid, reaches a solid cell, stalls or takes `maxSteps`. Points as x, y, z (mm).
 */
export function streamline(
  vox: Voxelization,
  velocity: Float32Array,
  seed: [number, number, number],
  options: { stepMm: number; maxSteps: number },
): Float64Array {
  const { grid, solid } = vox;
  const h = grid.spacing;
  const pts: number[] = [...seed];
  let [x, y, z] = seed;
  const v = new Float64Array(3);
  const isSolid = (px: number, py: number, pz: number) => {
    const i = Math.floor((px - grid.origin[0]) / h),
      j = Math.floor((py - grid.origin[1]) / h),
      k = Math.floor((pz - grid.origin[2]) / h);
    return solid[i + grid.dims[0] * (j + grid.dims[1] * k)] === 1;
  };
  for (let s = 0; s < options.maxSteps; s++) {
    if (!sampleVelocity(velocity, grid, x, y, z, v)) break;
    const sp = Math.hypot(v[0]!, v[1]!, v[2]!);
    if (sp < 1e-9) break;
    const mx = x + (0.5 * options.stepMm * v[0]!) / sp,
      my = y + (0.5 * options.stepMm * v[1]!) / sp,
      mz = z + (0.5 * options.stepMm * v[2]!) / sp;
    if (!sampleVelocity(velocity, grid, mx, my, mz, v)) break;
    const sm = Math.hypot(v[0]!, v[1]!, v[2]!);
    if (sm < 1e-9) break;
    const dx = (options.stepMm * v[0]!) / sm,
      dy = (options.stepMm * v[1]!) / sm,
      dz = (options.stepMm * v[2]!) / sm;
    // The whole step, not only its end, stays out of the body (a step longer than a thin part).
    const parts = Math.max(1, Math.ceil((2 * options.stepMm) / h));
    let hit = false;
    for (let q = 1; q <= parts && !hit; q++)
      hit = isSolid(x + (dx * q) / parts, y + (dy * q) / parts, z + (dz * q) / parts);
    // The end must be inside the grid, where the velocity is known.
    if (hit || !sampleVelocity(velocity, grid, x + dx, y + dy, z + dz, v)) break;
    x += dx;
    y += dy;
    z += dz;
    pts.push(x, y, z);
  }
  return Float64Array.from(pts);
}

/**
 * The pressure coefficient Cp = (p − p∞) / (½ ρ U²) on every triangle, read in the first fluid cell
 * nearest its centroid along its normal (either side, whichever is fluid first), with p = ρ/3 and
 * p∞ = ρ∞/3 (`Flow.referenceDensity()`, default 1). With
 * face indices on the surface, also the area-weighted mean per CAD face.
 */
export function surfacePressure(
  surface: TriangleSurface,
  vox: Voxelization,
  rho: Float32Array,
  speed: number,
  rhoRef = 1,
): { triangles: Float32Array; faces: Map<number, number> } {
  const { positions: p, triangles: tri } = surface;
  const { grid, solid } = vox;
  const h = grid.spacing;
  const out = new Float32Array(tri.length / 3);
  const sums = new Map<number, [number, number]>();
  const cellAt = (x: number, y: number, z: number) => {
    const i = Math.floor((x - grid.origin[0]) / h),
      j = Math.floor((y - grid.origin[1]) / h),
      k = Math.floor((z - grid.origin[2]) / h);
    if (i < 0 || j < 0 || k < 0 || i >= grid.dims[0] || j >= grid.dims[1] || k >= grid.dims[2])
      return -1;
    return i + grid.dims[0] * (j + grid.dims[1] * k);
  };
  const q = 0.5 * speed * speed;
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t]! * 3,
      b = tri[t + 1]! * 3,
      c = tri[t + 2]! * 3;
    const ux = p[b]! - p[a]!,
      uy = p[b + 1]! - p[a + 1]!,
      uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!,
      vy = p[c + 1]! - p[a + 1]!,
      vz = p[c + 2]! - p[a + 2]!;
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const area2 = Math.hypot(nx, ny, nz);
    if (area2 === 0) continue;
    nx /= area2;
    ny /= area2;
    nz /= area2;
    const gx = (p[a]! + p[b]! + p[c]!) / 3,
      gy = (p[a + 1]! + p[b + 1]! + p[c + 1]!) / 3,
      gz = (p[a + 2]! + p[b + 2]! + p[c + 2]!) / 3;
    // The nearest fluid cell along the normal, out to 1.5 cells either side (outward first at the
    // same distance), so a narrow gap to another body is not jumped over.
    let value = 0;
    search: for (let step = 1; step <= 6; step++)
      for (const sgn of [1, -1]) {
        const d = (sgn * step * h) / 4;
        const cell = cellAt(gx + d * nx, gy + d * ny, gz + d * nz);
        if (cell >= 0 && !solid[cell]) {
          value = (rho[cell]! - rhoRef) / 3 / q;
          break search;
        }
      }
    out[t / 3] = value;
    const face = surface.faces?.[t / 3];
    if (face !== undefined) {
      const s = sums.get(face) ?? [0, 0];
      s[0] += value * area2;
      s[1] += area2;
      sums.set(face, s);
    }
  }
  const faces = new Map<number, number>();
  for (const [face, [s, a]] of sums) faces.set(face, s / a);
  return { triangles: out, faces };
}
