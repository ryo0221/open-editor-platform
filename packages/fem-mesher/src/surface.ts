import { femLimits } from '@editor-platform/geometry-fem';

/**
 * The analysis shape as the mesher takes it (docs/cad/r3-analysis.md, R3b): a closed triangulation
 * of its boundary, each triangle tagged with its shape face, and for each shape edge the chain of
 * surface points along it. The kernel's per-face triangulation gives exactly this; the mesher keeps
 * every surface point and triangle, so tags and chains carry over by index, never by nearness.
 */
export interface SurfaceMeshInput {
  /** x, y, z per point (mm). */
  points: Float64Array;
  /** Three point indices per triangle, wound so the normal points out of the solid. */
  triangles: Uint32Array;
  /** The shape face of each triangle. */
  faces: Uint32Array;
  shapeFaces: number;
  shapeEdges: number;
  /** Surface points along each shape edge, in order: `offsets` has `shapeEdges + 1` entries. */
  edges: { offsets: Uint32Array; nodes: Uint32Array };
  /**
   * Curved mid-edge points for tet10 (R3d-2a): `pairs` lists surface edges (two point indices
   * each), `points` the point on the shape for each. Surface edges not listed stay straight.
   */
  midpoints?: { pairs: Uint32Array; points: Float64Array };
}

export type MesherProblem =
  | 'limit'
  | 'not-finite'
  | 'index'
  | 'surface-degenerate'
  | 'surface-open'
  | 'surface-orientation'
  | 'surface-inside-out'
  | 'face-tag'
  | 'edge-chain'
  | 'settings'
  | 'netgen-failed'
  | 'no-elements'
  | 'surface-changed'
  | 'mesh-quality'
  | 'mesh-boundary'
  | 'midpoint';
/** Every refusal of the mesher: nothing is repaired or guessed. */
export class MesherError extends Error {
  constructor(
    readonly problem: MesherProblem,
    readonly detail: string,
  ) {
    super(`mesher: ${problem}: ${detail}`);
    this.name = 'MesherError';
  }
}
const fail = (problem: MesherProblem, detail: string): never => {
  throw new MesherError(problem, detail);
};

/** Input limits; the volume mesh is held to `femLimits` and, in the browser, to the solve limits. */
export const surfaceLimits = Object.freeze({
  points: femLimits.nodes,
  triangles: 2_000_000,
  shapeFaces: femLimits.shapeFaces,
  shapeEdges: femLimits.shapeEdges,
  coordinateMm: femLimits.coordinateMm,
});

const edgeKey = (a: number, b: number) => (a < b ? a * 2 ** 26 + b : b * 2 ** 26 + a);

/**
 * Checks that the input is a closed, consistently outward-wound 2-manifold: every triangle edge is
 * used by exactly two triangles in opposite directions, the enclosed volume is positive, tags are
 * in range and each edge chain runs along triangle edges. Throws `MesherError`.
 */
export function checkSurface(input: SurfaceMeshInput): void {
  const { points, triangles, faces } = input;
  const np = points.length / 3;
  const nt = triangles.length / 3;
  if (!Number.isInteger(np) || !Number.isInteger(nt)) fail('index', 'array lengths');
  if (np > surfaceLimits.points) fail('limit', 'points');
  if (nt > surfaceLimits.triangles) fail('limit', 'triangles');
  if (nt < 4) fail('surface-open', 'fewer than four triangles');
  if (faces.length !== nt) fail('index', 'faces length');
  for (const [k, max] of [
    ['shapeFaces', surfaceLimits.shapeFaces],
    ['shapeEdges', surfaceLimits.shapeEdges],
  ] as const)
    if (!Number.isSafeInteger(input[k]) || input[k] < 0 || input[k] > max) fail('limit', k);
  for (let i = 0; i < points.length; i++) {
    if (!Number.isFinite(points[i]!)) fail('not-finite', `points[${i}]`);
    if (Math.abs(points[i]!) > surfaceLimits.coordinateMm) fail('limit', `points[${i}]`);
  }
  // Directed edges: each must occur once, and its reverse once.
  const directed = new Map<number, number>();
  let volume6 = 0;
  const ox = points[0] ?? 0,
    oy = points[1] ?? 0,
    oz = points[2] ?? 0;
  for (let t = 0; t < nt; t++) {
    const a = triangles[3 * t]!,
      b = triangles[3 * t + 1]!,
      c = triangles[3 * t + 2]!;
    if (a >= np || b >= np || c >= np) fail('index', `triangles[${t}]`);
    if (a === b || b === c || a === c) fail('surface-degenerate', `triangle ${t}`);
    const p = (i: number) => [points[3 * i]!, points[3 * i + 1]!, points[3 * i + 2]!] as const;
    const [ax, ay, az] = p(a),
      [bx, by, bz] = p(b),
      [cx, cy, cz] = p(c);
    const ux = bx - ax,
      uy = by - ay,
      uz = bz - az,
      vx = cx - ax,
      vy = cy - ay,
      vz = cz - az;
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    if (nx === 0 && ny === 0 && nz === 0) fail('surface-degenerate', `triangle ${t} has no area`);
    // Relative to the first point, so a small part far from the origin does not cancel out.
    const qx = ax - ox,
      qy = ay - oy,
      qz = az - oz,
      rx = bx - ox,
      ry = by - oy,
      rz = bz - oz,
      sx = cx - ox,
      sy = cy - oy,
      sz = cz - oz;
    volume6 += qx * (ry * sz - rz * sy) - qy * (rx * sz - rz * sx) + qz * (rx * sy - ry * sx);
    if (faces[t]! >= input.shapeFaces) fail('face-tag', `triangle ${t}`);
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const key = u * np + v;
      if (directed.has(key)) fail('surface-orientation', `edge ${u}–${v} twice in one direction`);
      directed.set(key, t);
    }
  }
  for (const key of directed.keys()) {
    const u = Math.floor(key / np),
      v = key % np;
    if (!directed.has(v * np + u)) fail('surface-open', `edge ${u}–${v} has one triangle`);
  }
  if (!(volume6 > 0)) fail('surface-inside-out', 'the enclosed volume is not positive');
  const { offsets, nodes } = input.edges;
  if (offsets.length !== input.shapeEdges + 1 || offsets[0] !== 0)
    fail('edge-chain', 'offsets length');
  if (offsets[input.shapeEdges] !== nodes.length) fail('edge-chain', 'nodes length');
  const undirected = new Set<number>();
  for (const key of directed.keys()) undirected.add(edgeKey(Math.floor(key / np), key % np));
  for (let k = 0; k < input.shapeEdges; k++) {
    const s = offsets[k]!,
      e = offsets[k + 1]!;
    // An empty chain is an edge that is a point (a pole); any other has two points or more.
    if (e === s + 1 || e < s) fail('edge-chain', `edge ${k} has one point`);
    for (let i = s; i < e; i++) {
      if (nodes[i]! >= np) fail('edge-chain', `edge ${k} point index`);
      if (i > s && !undirected.has(edgeKey(nodes[i - 1]!, nodes[i]!)))
        fail('edge-chain', `edge ${k} leaves the triangle edges`);
    }
  }
  if (input.midpoints) checkMidpoints(input, undirected);
}

/**
 * Each curved mid point names a surface edge once, is finite and lies within half the edge's
 * length of its middle: further, it is not a point of that edge's arc.
 */
function checkMidpoints(input: SurfaceMeshInput, undirected: Set<number>): void {
  const { pairs, points: mids } = input.midpoints!;
  const { points } = input;
  const np = points.length / 3;
  if (pairs.length % 2 || mids.length !== (pairs.length / 2) * 3) fail('midpoint', 'array lengths');
  const seen = new Set<number>();
  for (let i = 0; i < pairs.length / 2; i++) {
    const a = pairs[2 * i]!,
      b = pairs[2 * i + 1]!;
    if (a >= np || b >= np) fail('midpoint', `pair ${i} point index`);
    const k = edgeKey(a, b);
    if (!undirected.has(k)) fail('midpoint', `pair ${i} is not a surface edge`);
    if (seen.has(k)) fail('midpoint', `pair ${i} repeats an edge`);
    seen.add(k);
    let chord = 0,
      off = 0;
    for (let d = 0; d < 3; d++) {
      const m = mids[3 * i + d]!;
      if (!Number.isFinite(m)) fail('not-finite', `midpoints.points[${3 * i + d}]`);
      chord += (points[3 * a + d]! - points[3 * b + d]!) ** 2;
      off += (m - (points[3 * a + d]! + points[3 * b + d]!) / 2) ** 2;
    }
    if (off > chord / 4)
      fail('midpoint', `pair ${i} is further than half its edge from the middle`);
  }
}
