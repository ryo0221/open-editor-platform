import { CfdError } from './errors';
import { Q, REST, cx, cy, cz } from './lattice';

/** A closed triangulated surface in millimetres (the vehicle's outer shape, VS1). */
export interface TriangleSurface {
  /** x, y, z per point. */
  positions: Float64Array;
  /** Three point indices per triangle. */
  triangles: Uint32Array;
  /** Optional: the CAD face index of each triangle (kept for mapping results onto faces, VS-U9). */
  faces?: Int32Array;
}

/** A regular grid of cubic cells. Cell (i, j, k) has its centre at origin + (i + ½, j + ½, k + ½) h. */
export interface Grid {
  origin: [number, number, number];
  /** Cell size, mm. */
  spacing: number;
  dims: [number, number, number];
}

export interface Voxelization {
  grid: Grid;
  /** 1 where the cell centre lies inside the surface. */
  solid: Uint8Array;
  /** Fluid-to-solid links: key cell × 27 + direction (towards the solid), value q ∈ (0, 1], the
   *  fraction of the link from the fluid centre to the surface. */
  links: Map<number, number>;
  solidCells: number;
  /** Links whose segment found no triangle (a grazing hit); they use q = ½. */
  fallbackLinks: number;
}

export const cfdLimits = {
  /** Cells in one grid (the browser). */
  maxCells: 2_000_000,
  /** Triangles in one surface. */
  maxTriangles: 2_000_000,
};

export function cellIndex(grid: Grid, i: number, j: number, k: number): number {
  return i + grid.dims[0] * (j + grid.dims[1] * k);
}

/** Checks the surface: finite points, indices in range, at least one triangle, every edge shared by two triangles. */
export function checkSurface(surface: TriangleSurface, limits = cfdLimits): void {
  const { positions, triangles } = surface;
  const points = positions.length / 3;
  if (!Number.isInteger(points) || triangles.length === 0 || triangles.length % 3 !== 0)
    throw new CfdError('surface-invalid', 'the surface needs points and whole triangles');
  if (triangles.length / 3 > limits.maxTriangles)
    throw new CfdError(
      'surface-invalid',
      `${triangles.length / 3} triangles exceed ${limits.maxTriangles}`,
    );
  for (const v of positions)
    if (!Number.isFinite(v)) throw new CfdError('surface-invalid', 'a coordinate is not finite');
  if (surface.faces && surface.faces.length !== triangles.length / 3)
    throw new CfdError('surface-invalid', 'one face index per triangle');
  const edges = new Map<number, number>();
  for (let t = 0; t < triangles.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = triangles[t + e]!;
      const b = triangles[t + ((e + 1) % 3)]!;
      if (a >= points || b >= points)
        throw new CfdError('surface-invalid', 'a point index is out of range');
      if (a === b) throw new CfdError('surface-invalid', 'a triangle repeats a point');
      const key = Math.min(a, b) * points + Math.max(a, b);
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  let open = 0;
  for (const n of edges.values()) if (n !== 2) open++;
  if (open > 0)
    throw new CfdError('surface-open', `${open} edges are not shared by exactly two triangles`);
}

/** Joins surfaces into one (points renumbered, face indices kept; a surface without them gets −1). */
export function mergeSurfaces(surfaces: TriangleSurface[]): TriangleSurface {
  if (surfaces.length === 1) return surfaces[0]!;
  let points = 0;
  let tris = 0;
  for (const s of surfaces) {
    points += s.positions.length;
    tris += s.triangles.length;
  }
  const positions = new Float64Array(points);
  const triangles = new Uint32Array(tris);
  const faces = new Int32Array(tris / 3);
  let po = 0;
  let to = 0;
  for (const s of surfaces) {
    positions.set(s.positions, po);
    for (let i = 0; i < s.triangles.length; i++) triangles[to + i] = s.triangles[i]! + po / 3;
    for (let i = 0; i < s.triangles.length / 3; i++) faces[to / 3 + i] = s.faces ? s.faces[i]! : -1;
    po += s.positions.length;
    to += s.triangles.length;
  }
  return { positions, triangles, faces };
}

/**
 * Marks the cells whose centre is inside any of the closed surfaces (ray parity along x per surface,
 * the rays nudged off the grid lines so they miss edges and vertices; overlapping bodies such as
 * wheels in their arches are joined) and finds, for every fluid cell next to a solid one, where each
 * link crosses a surface (q, for interpolated bounce-back).
 */
export function voxelize(
  input: TriangleSurface | TriangleSurface[],
  grid: Grid,
  limits = cfdLimits,
): Voxelization {
  const surfaces = Array.isArray(input) ? input : [input];
  const [nx, ny, nz] = grid.dims;
  const h = grid.spacing;
  if (
    ![nx, ny, nz].every((n) => Number.isInteger(n) && n >= 3) ||
    !(h > 0) ||
    !grid.origin.every(Number.isFinite)
  )
    throw new CfdError('config', 'the grid needs at least 3 cells per axis and a positive spacing');
  const cells = nx * ny * nz;
  if (cells > limits.maxCells)
    throw new CfdError('grid-too-large', `${cells} cells exceed ${limits.maxCells}`);
  if (surfaces.length === 0) throw new CfdError('surface-invalid', 'no surface');
  for (const s of surfaces) checkSurface(s, limits);
  const solid = new Uint8Array(cells);
  for (const s of surfaces) fillInside(s, grid, solid);
  const merged = mergeSurfaces(surfaces);
  if (merged.triangles.length / 3 > limits.maxTriangles)
    throw new CfdError(
      'surface-invalid',
      `${merged.triangles.length / 3} triangles exceed ${limits.maxTriangles}`,
    );
  return linkCrossings(merged, grid, solid);
}

function fillInside(surface: TriangleSurface, grid: Grid, solid: Uint8Array): void {
  const [nx, ny, nz] = grid.dims;
  const h = grid.spacing;
  const { positions: p, triangles: tri } = surface;
  const [ox, oy, oz] = grid.origin;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, p[i + a]!);
      hi[a] = Math.max(hi[a]!, p[i + a]!);
    }
  const o = [ox, oy, oz];
  for (let a = 0; a < 3; a++)
    if (lo[a]! < o[a]! + h || hi[a]! > o[a]! + (grid.dims[a]! - 1) * h)
      throw new CfdError(
        'body-outside',
        'the body must lie inside the grid with one cell to spare',
      );

  // Parity along x. Rays at the cell centres in y and z, nudged by an irrational fraction of h.
  const ey = 1.234567e-6 * h;
  const ez = 2.718281e-6 * h;
  const rows: number[][] = Array.from({ length: ny * nz }, () => []);
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t]! * 3;
    const b = tri[t + 1]! * 3;
    const c = tri[t + 2]! * 3;
    const y0 = Math.min(p[a + 1]!, p[b + 1]!, p[c + 1]!);
    const y1 = Math.max(p[a + 1]!, p[b + 1]!, p[c + 1]!);
    const z0 = Math.min(p[a + 2]!, p[b + 2]!, p[c + 2]!);
    const z1 = Math.max(p[a + 2]!, p[b + 2]!, p[c + 2]!);
    // The rows whose nudged ray can meet the triangle, one more each side: the test below decides.
    const j0 = Math.max(0, Math.ceil((y0 - oy - ey) / h - 0.5) - 1);
    const j1 = Math.min(ny - 1, Math.floor((y1 - oy - ey) / h - 0.5) + 1);
    const k0 = Math.max(0, Math.ceil((z0 - oz - ez) / h - 0.5) - 1);
    const k1 = Math.min(nz - 1, Math.floor((z1 - oz - ez) / h - 0.5) + 1);
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) rows[j + ny * k]!.push(t);
  }
  const xs: number[] = [];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++) {
      const list = rows[j + ny * k]!;
      if (list.length === 0) continue;
      const py = oy + (j + 0.5) * h + ey;
      const pz = oz + (k + 0.5) * h + ez;
      xs.length = 0;
      for (const t of list) {
        const a = tri[t]! * 3;
        const b = tri[t + 1]! * 3;
        const c = tri[t + 2]! * 3;
        // Barycentric coordinates of (py, pz) in the triangle's yz projection.
        const ay = p[a + 1]!,
          az = p[a + 2]!;
        const by = p[b + 1]! - ay,
          bz = p[b + 2]! - az;
        const cyy = p[c + 1]! - ay,
          czz = p[c + 2]! - az;
        const det = by * czz - bz * cyy;
        if (det === 0) continue;
        // Inside by edge functions that two triangles sharing an edge compute alike (from the
        // lower vertex index), and a half-open rule on the edge itself: a ray through a shared edge
        // or vertex crosses the surface once, not twice.
        const sg = det > 0 ? 1 : -1;
        if (
          !inside(p, tri[t]!, tri[t + 1]!, py, pz, sg) ||
          !inside(p, tri[t + 1]!, tri[t + 2]!, py, pz, sg) ||
          !inside(p, tri[t + 2]!, tri[t]!, py, pz, sg)
        )
          continue;
        const qy = py - ay,
          qz = pz - az;
        const u = (qy * czz - qz * cyy) / det;
        const v = (by * qz - bz * qy) / det;
        xs.push(p[a]! + u * (p[b]! - p[a]!) + v * (p[c]! - p[a]!));
      }
      if (xs.length < 2) continue;
      xs.sort((m, n) => m - n);
      for (let s = 0; s + 1 < xs.length; s += 2) {
        const i0 = Math.max(0, Math.ceil((xs[s]! - ox) / h - 0.5));
        const i1 = Math.min(nx - 1, Math.floor((xs[s + 1]! - ox) / h - 0.5));
        const base = nx * (j + ny * k);
        for (let i = i0; i <= i1; i++) solid[base + i] = 1;
      }
    }
}

/**
 * Whether (py, pz) is on the inner side of the directed edge i → j (yz projection) of a triangle
 * turning `sg`: the edge function is computed from the lower index so both triangles of an edge get
 * the same number, and a point on the edge belongs to the one side whose edge direction (turned by
 * `sg`) points up in z, or along −y when level.
 */
function inside(p: Float64Array, i: number, j: number, py: number, pz: number, sg: number) {
  const [m, n] = i < j ? [i, j] : [j, i];
  const my = p[3 * m + 1]!,
    mz = p[3 * m + 2]!;
  const e = (p[3 * n + 1]! - my) * (pz - mz) - (p[3 * n + 2]! - mz) * (py - my);
  const w = sg * (i < j ? e : -e);
  if (w !== 0) return w > 0;
  const dy = sg * (p[3 * j + 1]! - p[3 * i + 1]!);
  const dz = sg * (p[3 * j + 2]! - p[3 * i + 2]!);
  return dz > 0 || (dz === 0 && dy < 0);
}

function linkCrossings(surface: TriangleSurface, grid: Grid, solid: Uint8Array): Voxelization {
  const [nx, ny, nz] = grid.dims;
  const h = grid.spacing;
  const { positions: p, triangles: tri } = surface;
  const o = grid.origin;
  const [ox, oy, oz] = o;
  let solidCells = 0;
  for (let n = 0; n < solid.length; n++) solidCells += solid[n]!;

  // Triangles binned by the cells their box (grown by a cell) touches, for the link crossings.
  const bins = new Map<number, number[]>();
  for (let t = 0; t < tri.length; t += 3) {
    const lo3 = [Infinity, Infinity, Infinity];
    const hi3 = [-Infinity, -Infinity, -Infinity];
    for (let e = 0; e < 3; e++)
      for (let a = 0; a < 3; a++) {
        const v = p[tri[t + e]! * 3 + a]!;
        lo3[a] = Math.min(lo3[a]!, v);
        hi3[a] = Math.max(hi3[a]!, v);
      }
    const r0 = lo3.map((v, a) => Math.max(0, Math.floor((v - o[a]!) / h - 0.5)));
    const r1 = hi3.map((v, a) => Math.min(grid.dims[a]! - 1, Math.ceil((v - o[a]!) / h - 0.5)));
    for (let k = r0[2]!; k <= r1[2]!; k++)
      for (let j = r0[1]!; j <= r1[1]!; j++)
        for (let i = r0[0]!; i <= r1[0]!; i++) {
          const key = cellIndex(grid, i, j, k);
          const bin = bins.get(key);
          if (bin) bin.push(t);
          else bins.set(key, [t]);
        }
  }
  const links = new Map<number, number>();
  let fallbackLinks = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const cell = cellIndex(grid, i, j, k);
        if (solid[cell]) continue;
        for (let d = 0; d < Q; d++) {
          if (d === REST) continue;
          const ni = i + cx[d]!,
            nj = j + cy[d]!,
            nk = k + cz[d]!;
          if (ni < 0 || nj < 0 || nk < 0 || ni >= nx || nj >= ny || nk >= nz) continue;
          const other = cellIndex(grid, ni, nj, nk);
          if (!solid[other]) continue;
          const sx = ox + (i + 0.5) * h,
            sy = oy + (j + 0.5) * h,
            sz = oz + (k + 0.5) * h;
          const dx = cx[d]! * h,
            dy = cy[d]! * h,
            dz = cz[d]! * h;
          let best = Infinity;
          for (const key of [cell, other]) {
            for (const t of bins.get(key) ?? []) {
              const s = segmentTriangle(p, tri, t, sx, sy, sz, dx, dy, dz);
              if (s < best) best = s;
            }
          }
          if (best === Infinity) {
            fallbackLinks++;
            best = 0.5;
          }
          links.set(cell * Q + d, Math.min(1, Math.max(1e-6, best)));
        }
      }
  return { grid, solid, links, solidCells, fallbackLinks };
}

/** The parameter t ∈ [0, 1] where the segment s + t d meets triangle t (Möller–Trumbore), or Infinity. */
function segmentTriangle(
  p: Float64Array,
  tri: Uint32Array,
  t: number,
  sx: number,
  sy: number,
  sz: number,
  dx: number,
  dy: number,
  dz: number,
): number {
  const a = tri[t]! * 3,
    b = tri[t + 1]! * 3,
    c = tri[t + 2]! * 3;
  const e1x = p[b]! - p[a]!,
    e1y = p[b + 1]! - p[a + 1]!,
    e1z = p[b + 2]! - p[a + 2]!;
  const e2x = p[c]! - p[a]!,
    e2y = p[c + 1]! - p[a + 1]!,
    e2z = p[c + 2]! - p[a + 2]!;
  const px = dy * e2z - dz * e2y,
    py = dz * e2x - dx * e2z,
    pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-14) return Infinity;
  const inv = 1 / det;
  const tx = sx - p[a]!,
    ty = sy - p[a + 1]!,
    tz = sz - p[a + 2]!;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return Infinity;
  const qx = ty * e1z - tz * e1y,
    qy = tz * e1x - tx * e1z,
    qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return Infinity;
  const s = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return s >= -1e-9 && s <= 1 + 1e-9 ? s : Infinity;
}

/** The body's area seen along x, in cells × spacing² (mm²): the frontal area for the drag coefficient. */
export function frontalArea(vox: Voxelization): number {
  const [nx, ny, nz] = vox.grid.dims;
  let n = 0;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++) {
      const base = nx * (j + ny * k);
      for (let i = 0; i < nx; i++)
        if (vox.solid[base + i]) {
          n++;
          break;
        }
    }
  return n * vox.grid.spacing * vox.grid.spacing;
}
