import {
  groundOnDay,
  signedArea2,
  siteTerrain,
  triangulatePolygon,
  type ConstructionSite,
  type Plan,
  type TemporaryKind,
  type TemporaryWork,
  type Terrain,
} from '@editor-platform/construction-core';
import type { ViewMesh, ViewSolid } from '@editor-platform/geometry-view';

type Bounds = [[number, number, number], [number, number, number]];

/**
 * IDs the site's solids carry in the view. The leading space keeps them apart from the
 * building's element IDs, which are never padded (`bimId`).
 */
export const sitePickPrefix = ' site:';
export const siteGroundId = `${sitePickPrefix}ground`;
/** The ground is a backdrop: a pick through it reaches what stands on it, transparent or not. */
export const siteBackdrop = (id: string) => id === siteGroundId || id === siteBoundaryId;
export const siteBoundaryId = `${sitePickPrefix}boundary`;
export const siteTemporaryId = (id: string) => `${sitePickPrefix}temporary:${id}`;

/** How each kind of temporary work looks in the view. */
export const temporaryLooks: Record<TemporaryKind, { color: string; opacity: number }> = {
  scaffold: { color: '#f59e0b', opacity: 0.35 },
  hoarding: { color: '#e2e8f0', opacity: 0.95 },
  gate: { color: '#2563eb', opacity: 0.9 },
  yard: { color: '#94a3b8', opacity: 1 },
  office: { color: '#f8fafc', opacity: 1 },
};
const groundColor = '#a3895f';
const movedColor = '#7c5a36';
const boundaryColor = '#dc2626';
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function meshOf(positions: number[], indices: number[], normals?: number[]): ViewMesh {
  const n = normals ?? flatNormals(positions, indices);
  return {
    origin: [0, 0, 0],
    positions: new Float32Array(positions),
    normals: new Float32Array(n),
    indices: new Uint32Array(indices),
  };
}

/** Per-vertex normals summed from the triangles that use each vertex. */
function flatNormals(positions: number[], indices: number[]): number[] {
  const n = new Array<number>(positions.length).fill(0);
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t]! * 3, indices[t + 1]! * 3, indices[t + 2]! * 3];
    const u = [0, 1, 2].map((i) => positions[b + i]! - positions[a + i]!);
    const v = [0, 1, 2].map((i) => positions[c + i]! - positions[a + i]!);
    const cx = u[1]! * v[2]! - u[2]! * v[1]!;
    const cy = u[2]! * v[0]! - u[0]! * v[2]!;
    const cz = u[0]! * v[1]! - u[1]! * v[0]!;
    for (const k of [a, b, c]) {
      n[k] += cx;
      n[k + 1] += cy;
      n[k + 2] += cz;
    }
  }
  for (let k = 0; k < n.length; k += 3) {
    const l = Math.hypot(n[k]!, n[k + 1]!, n[k + 2]!) || 1;
    n[k] /= l;
    n[k + 1] /= l;
    n[k + 2] /= l;
  }
  return n;
}

function boundsOf(positions: ArrayLike<number>): Bounds | undefined {
  if (!positions.length) return undefined;
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < positions.length; k += 3)
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i]!, positions[k + i]!);
      hi[i] = Math.max(hi[i]!, positions[k + i]!);
    }
  return [lo, hi];
}

const solid = (
  id: string,
  meshes: { mesh: ViewMesh; color: string; opacity: number; sheet?: boolean }[],
  selected: boolean,
): ViewSolid | undefined => {
  const parts = meshes.filter((m) => m.mesh.indices.length);
  const bounds = parts
    .map((m) => boundsOf(m.mesh.positions))
    .reduce<Bounds | undefined>((acc, b) => (acc && b ? union(acc, b) : (acc ?? b)), undefined);
  if (!bounds) return undefined;
  return {
    meshes: parts.map((m) => ({
      mesh: m.mesh,
      color: m.color,
      opacity: m.opacity,
      sheet: m.sheet ?? false,
    })),
    bounds,
    instances: [{ path: [id], matrix: identity, selected }],
  };
};

export function union(a: Bounds, b: Bounds): Bounds {
  return [
    [Math.min(a[0][0], b[0][0]), Math.min(a[0][1], b[0][1]), Math.min(a[0][2], b[0][2])],
    [Math.max(a[1][0], b[1][0]), Math.max(a[1][1], b[1][1]), Math.max(a[1][2], b[1][2])],
  ];
}

/** The plan area the ground is drawn over: the boundary's box with a margin, or the survey's. */
function groundArea(site: ConstructionSite, terrain: Terrain): [Plan, Plan] | undefined {
  const pts = site.boundary.length >= 3 ? site.boundary : undefined;
  let lo: Plan;
  let hi: Plan;
  if (pts) {
    lo = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))];
    hi = [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  } else if (terrain.bounds) [lo, hi] = terrain.bounds;
  else return undefined;
  const m = Math.max(hi[0] - lo[0], hi[1] - lo[1]) * 0.1;
  return [
    [lo[0] - m, lo[1] - m],
    [hi[0] + m, hi[1] + m],
  ];
}

/**
 * The ground on a day as two meshes over one grid (at most `cells` a side): where the earthworks
 * have moved it so far (darker) and where it is as surveyed.
 */
export function siteGroundMeshes(
  site: ConstructionSite,
  progress: ReadonlyMap<string, number>,
  terrain = siteTerrain(site),
  cells = 160,
): { kept: ViewMesh; moved: ViewMesh } | undefined {
  const area = groundArea(site, terrain);
  if (!area) return undefined;
  const [lo, hi] = area;
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1]);
  const nx = Math.max(1, Math.round((cells * (hi[0] - lo[0])) / span));
  const ny = Math.max(1, Math.round((cells * (hi[1] - lo[1])) / span));
  const positions: number[] = [];
  const movedAt: boolean[] = [];
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) {
      const p: Plan = [lo[0] + ((hi[0] - lo[0]) * i) / nx, lo[1] + ((hi[1] - lo[1]) * j) / ny];
      const z0 = terrain.heightAt(p);
      const z = groundOnDay(site, terrain, progress, p);
      positions.push(p[0], p[1], z);
      movedAt.push(Math.abs(z - z0) > 1);
    }
  const at = (i: number, j: number) => j * (nx + 1) + i;
  const kept: number[] = [];
  const moved: number[] = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const q = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      const into = q.some((k) => movedAt[k]) ? moved : kept;
      into.push(q[0]!, q[1]!, q[2]!, q[0]!, q[2]!, q[3]!);
    }
  const normals = flatNormals(positions, [...kept, ...moved]);
  return { kept: meshOf(positions, kept, normals), moved: meshOf(positions, moved, normals) };
}

/** A temporary work as a prism over its outline, standing on the ground (or its own base). */
export function temporaryMesh(t: TemporaryWork, ground: (p: Plan) => number): ViewMesh {
  const base = t.baseZ ?? Math.min(...t.outline.map(ground));
  const top = base + t.height;
  const n = t.outline.length;
  const tris = triangulatePolygon(t.outline);
  const positions: number[] = [];
  const indices: number[] = [];
  // Top and bottom (triangles are counter-clockwise in plan).
  for (const [z, up] of [
    [top, true],
    [base, false],
  ] as const) {
    const first = positions.length / 3;
    for (const [x, y] of t.outline) positions.push(x, y, z);
    for (let k = 0; k < tris.length; k += 3) {
      const [a, b, c] = [tris[k]!, tris[k + 1]!, tris[k + 2]!];
      if (up) indices.push(first + a, first + b, first + c);
      else indices.push(first + a, first + c, first + b);
    }
  }
  // Sides: each edge its own quad, so it keeps a flat normal.
  // Outward faces: walk the outline counter-clockwise.
  const ccw = signedArea2(t.outline) > 0;
  for (let k = 0; k < n; k++) {
    const [p, q] = ccw
      ? [t.outline[k]!, t.outline[(k + 1) % n]!]
      : [t.outline[(k + 1) % n]!, t.outline[k]!];
    const first = positions.length / 3;
    positions.push(p[0], p[1], base, q[0], q[1], base, q[0], q[1], top, p[0], p[1], top);
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
  return meshOf(positions, indices);
}

/** The boundary as a low red ribbon following the ground (0.3 m high). */
function boundaryMesh(boundary: readonly Plan[], ground: (p: Plan) => number): ViewMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  boundary.forEach((a, k) => {
    const b = boundary[(k + 1) % boundary.length]!;
    const steps = Math.min(
      200,
      Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2000)),
    );
    for (let s = 0; s < steps; s++) {
      const p: Plan = [a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps];
      const q: Plan = [
        a[0] + ((b[0] - a[0]) * (s + 1)) / steps,
        a[1] + ((b[1] - a[1]) * (s + 1)) / steps,
      ];
      const first = positions.length / 3;
      const zp = ground(p);
      const zq = ground(q);
      positions.push(p[0], p[1], zp, q[0], q[1], zq, q[0], q[1], zq + 300, p[0], p[1], zp + 300);
      indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
    }
  });
  return meshOf(positions, indices);
}

export interface SiteViewOptions {
  progress: ReadonlyMap<string, number>;
  /** Temporary works standing that day. */
  standing: readonly string[];
  selected?: string;
  terrain?: Terrain;
}

/** The site's solids on a day: the ground, the boundary and the temporary works standing. */
export function siteViewSolids(
  site: ConstructionSite,
  { progress, standing, selected, terrain = siteTerrain(site) }: SiteViewOptions,
): { solids: ViewSolid[]; bounds: Bounds | undefined } {
  const solids: ViewSolid[] = [];
  const ground = (p: Plan) => groundOnDay(site, terrain, progress, p);
  const g = siteGroundMeshes(site, progress, terrain);
  if (g) {
    const s = solid(
      siteGroundId,
      [
        { mesh: g.kept, color: groundColor, opacity: 1 },
        { mesh: g.moved, color: movedColor, opacity: 1 },
      ],
      false,
    );
    if (s) solids.push(s);
  }
  if (site.boundary.length >= 3) {
    const s = solid(
      siteBoundaryId,
      [
        {
          mesh: boundaryMesh(site.boundary, ground),
          color: boundaryColor,
          opacity: 1,
          sheet: true,
        },
      ],
      false,
    );
    if (s) solids.push(s);
  }
  for (const t of site.temporaries) {
    if (!standing.includes(t.id)) continue;
    const look = temporaryLooks[t.kind];
    const s = solid(
      siteTemporaryId(t.id),
      [{ mesh: temporaryMesh(t, ground), ...look }],
      selected === t.id,
    );
    if (s) solids.push(s);
  }
  const bounds = solids
    .map((s) => s.bounds)
    .reduce<Bounds | undefined>((acc, b) => (acc ? union(acc, b) : b), undefined);
  return { solids, bounds };
}
