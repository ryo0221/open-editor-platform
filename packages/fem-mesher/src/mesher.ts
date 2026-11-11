import {
  checkFemMesh,
  cornerVolume6,
  curvedJacobianMin,
  jacobianRatio,
  localFaces,
  tet10Edges,
  type FemElementType,
  type FemMesh,
} from '@editor-platform/geometry-fem';
import { checkSurface, MesherError, type SurfaceMeshInput } from './surface';

/** Element size (mm), the smallest it may go, and growth between neighbours (≥ 1). */
export interface MesherSettings {
  type: FemElementType;
  size: number;
  minSize: number;
  grading: number;
  /** Netgen's volume optimisation passes (default 3). */
  optimizeSteps?: number;
}

/** What Netgen returned: every point (the input's first, in order), tetrahedra, surface triangles. */
export interface NetgenOutput {
  points: Float64Array;
  tets: Int32Array;
  triangles: Int32Array;
  triangleFaces: Int32Array;
}

/** The exports of fem-mesher.wasm (scripts/fem-mesher/fem_mesher.cpp). */
export interface FemMesherModule {
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  _fm_mesh(
    np: number,
    points: number,
    nt: number,
    triangles: number,
    faces: number,
    shapeFaces: number,
    maxh: number,
    minh: number,
    grading: number,
    optsteps: number,
  ): number;
  _fm_points(): number;
  _fm_point_data(): number;
  _fm_tets(): number;
  _fm_tet_data(): number;
  _fm_tris(): number;
  _fm_tri_data(): number;
  _fm_tri_face(): number;
  _fm_error(): number;
  HEAPF64: Float64Array;
  HEAP32: Int32Array;
  UTF8ToString(ptr: number): string;
}

const fail = (problem: MesherError['problem'], detail: string): never => {
  throw new MesherError(problem, detail);
};

/**
 * Netgen's grading (0, 1]: how fast the local size may change, about the growth ratio minus one.
 * The document stores the growth ratio between neighbours (≥ 1), so 1.5 becomes 0.5.
 */
export const netgenGrading = (grading: number) => Math.min(1, Math.max(0.05, grading - 1));

export function checkMesherSettings(s: MesherSettings): void {
  if (s.type !== 'tet4' && s.type !== 'tet10') fail('settings', 'type');
  if (!(s.size > 0) || !Number.isFinite(s.size)) fail('settings', 'size');
  if (!(s.minSize > 0) || !(s.minSize <= s.size)) fail('settings', 'minSize');
  if (!(s.grading >= 1) || !Number.isFinite(s.grading)) fail('settings', 'grading');
  const o = s.optimizeSteps ?? 3;
  if (!Number.isSafeInteger(o) || o < 0 || o > 10) fail('settings', 'optimizeSteps');
}

/** Runs Netgen on a checked surface; the copies out of the Wasm heap are the caller's. */
export function runNetgen(
  m: FemMesherModule,
  input: SurfaceMeshInput,
  s: MesherSettings,
): NetgenOutput {
  const np = input.points.length / 3,
    nt = input.faces.length;
  const pp = m._malloc(input.points.length * 8),
    tp = m._malloc(input.triangles.length * 4),
    fp = m._malloc(nt * 4);
  try {
    m.HEAPF64.set(input.points, pp / 8);
    m.HEAP32.set(input.triangles, tp / 4);
    m.HEAP32.set(input.faces, fp / 4);
    const rc = m._fm_mesh(
      np,
      pp,
      nt,
      tp,
      fp,
      input.shapeFaces,
      s.size,
      s.minSize,
      netgenGrading(s.grading),
      s.optimizeSteps ?? 3,
    );
    if (rc === 1) fail('netgen-failed', m.UTF8ToString(m._fm_error()) || 'no message');
    if (rc === 2) fail('no-elements', 'Netgen made no tetrahedron');
    // Views are re-read after the call: the heap may have grown.
    const f64 = (ptr: number, n: number) => m.HEAPF64.slice(ptr / 8, ptr / 8 + n);
    const i32 = (ptr: number, n: number) => m.HEAP32.slice(ptr / 4, ptr / 4 + n);
    return {
      points: f64(m._fm_point_data(), m._fm_points() * 3),
      tets: i32(m._fm_tet_data(), m._fm_tets() * 4),
      triangles: i32(m._fm_tri_data(), m._fm_tris() * 3),
      triangleFaces: i32(m._fm_tri_face(), m._fm_tris()),
    };
  } finally {
    m._free(pp);
    m._free(tp);
    m._free(fp);
  }
}

const faceKey = (a: number, b: number, c: number) => {
  const s = [a, b, c].sort((x, y) => x - y);
  return `${s[0]},${s[1]},${s[2]}`;
};

/** A mesh and how its tet10 mid nodes on the surface were placed (R3d-2a). */
export interface MeshReport {
  mesh: FemMesh;
  /** Surface mid nodes placed on the shape. */
  curved: number;
  /** Curved mid points left on the straight edge because an element would fold or be near one. */
  straightened: number;
  /** The smallest `jacobianRatio` of the mesh (1 when no element is curved). */
  minJacobian: number;
}

/**
 * Turns Netgen's output into a FEM 1 mesh: corners wound to positive volume, mid-edge nodes for
 * tet10, the boundary from the kept surface triangles with their shape faces, and each shape
 * edge's chain with its mid nodes. Refuses output whose surface differs from the input
 * (`surface-changed`).
 */
export function assembleFemMesh(
  input: SurfaceMeshInput,
  out: NetgenOutput,
  type: FemElementType,
): FemMesh {
  return assembleReport(input, out, type).mesh;
}

/**
 * As `assembleFemMesh`, reporting the curved mid nodes. A tet10 mid node on a listed surface edge
 * sits on the shape's point; when that folds an element (det J ≤ 0 at a node or Gauss point),
 * that element's curved mid nodes go back to the straight edge, until no element folds.
 */
export function assembleReport(
  input: SurfaceMeshInput,
  out: NetgenOutput,
  type: FemElementType,
): MeshReport {
  const np = input.points.length / 3;
  for (let i = 0; i < input.points.length; i++)
    if (out.points[i] !== input.points[i]) fail('surface-changed', `point ${Math.floor(i / 3)}`);
  if (out.triangleFaces.length !== input.faces.length) fail('surface-changed', 'triangle count');
  // The kept surface must be the input's: the same triangles with the same shape faces.
  const tags = new Map<string, number>();
  for (let t = 0; t < input.faces.length; t++)
    tags.set(
      faceKey(input.triangles[3 * t]!, input.triangles[3 * t + 1]!, input.triangles[3 * t + 2]!),
      input.faces[t]!,
    );
  const seen = new Set<string>();
  for (let t = 0; t < out.triangleFaces.length; t++) {
    const [a, b, c] = [0, 1, 2].map((j) => out.triangles[3 * t + j]!);
    if (a! >= np || b! >= np || c! >= np) fail('surface-changed', `triangle ${t} uses a new point`);
    const k = faceKey(a!, b!, c!);
    if (tags.get(k) !== out.triangleFaces[t] || seen.has(k))
      fail('surface-changed', `triangle ${t} is not an input triangle with its face`);
    seen.add(k);
  }
  const nodes0 = new Float64Array(out.points);
  const n0 = nodes0.length / 3;
  const m = out.tets.length / 4;
  const corners = new Uint32Array(out.tets.length);
  for (let i = 0; i < out.tets.length; i++) {
    const v = out.tets[i]!;
    if (!(v >= 0 && v < n0)) fail('netgen-failed', `tet node ${v}`);
    corners[i] = v;
  }
  for (let e = 0; e < m; e++) {
    const v6 = cornerVolume6(nodes0, corners, 4, e);
    if (v6 < 0)
      [corners[4 * e + 1], corners[4 * e + 2]] = [corners[4 * e + 2]!, corners[4 * e + 1]!];
    else if (!(v6 > 0)) fail('mesh-quality', `element ${e} has no volume`);
  }
  // Boundary: element faces used once, each matched to one kept surface triangle.
  const owner = new Map<string, { e: number; lf: number; count: number }>();
  for (let e = 0; e < m; e++)
    localFaces.forEach(([a, b, c], lf) => {
      const k = faceKey(corners[4 * e + a]!, corners[4 * e + b]!, corners[4 * e + c]!);
      const o = owner.get(k);
      if (o) o.count++;
      else owner.set(k, { e, lf, count: 1 });
    });
  const bElements: number[] = [],
    bLocal: number[] = [],
    bTags: number[] = [];
  for (const [k, o] of owner) {
    if (o.count > 2) fail('mesh-boundary', `face ${k} shared by ${o.count} elements`);
    if (o.count === 2) continue;
    const tag = tags.get(k);
    if (tag === undefined) fail('mesh-boundary', `outer face ${k} is not on the surface`);
    bElements.push(o.e);
    bLocal.push(o.lf);
    bTags.push(tag!);
  }
  if (bTags.length !== input.faces.length) fail('mesh-boundary', 'a surface triangle is inside');
  let nodes = nodes0;
  let elements: Uint32Array = corners;
  const mid = new Map<number, number>();
  const key = (a: number, b: number) => (a < b ? a * n0 + b : b * n0 + a);
  if (type === 'tet10') {
    const extra: number[] = [];
    elements = new Uint32Array(m * 10);
    for (let e = 0; e < m; e++) {
      for (let j = 0; j < 4; j++) elements[10 * e + j] = corners[4 * e + j]!;
      tet10Edges.forEach(([a, b], j) => {
        const u = corners[4 * e + a]!,
          v = corners[4 * e + b]!;
        let id = mid.get(key(u, v));
        if (id === undefined) {
          id = n0 + extra.length / 3;
          mid.set(key(u, v), id);
          for (let d = 0; d < 3; d++) extra.push((nodes0[3 * u + d]! + nodes0[3 * v + d]!) / 2);
        }
        elements[10 * e + 4 + j] = id;
      });
    }
    nodes = new Float64Array(n0 * 3 + extra.length);
    nodes.set(nodes0);
    nodes.set(extra, n0 * 3);
  }
  let curved = 0,
    straightened = 0,
    minJacobian = 1;
  if (type === 'tet10' && input.midpoints) {
    ({ curved, straightened, minJacobian } = curveMidNodes(input, nodes, elements, m, mid, key));
  }
  // Edge chains keep the input's point indices; tet10 adds the mid node between neighbours.
  const offsets = new Uint32Array(input.shapeEdges + 1);
  const chain: number[] = [];
  for (let k = 0; k < input.shapeEdges; k++) {
    const s = input.edges.offsets[k]!,
      e = input.edges.offsets[k + 1]!;
    for (let i = s; i < e; i++) {
      const p = input.edges.nodes[i]!;
      if (i > s && type === 'tet10') {
        const q = mid.get(key(input.edges.nodes[i - 1]!, p));
        if (q === undefined) fail('mesh-boundary', `edge ${k} is not an element edge`);
        chain.push(q!);
      }
      chain.push(p);
    }
    offsets[k + 1] = chain.length;
  }
  const mesh: FemMesh = {
    type,
    nodes,
    elements,
    shapeFaces: input.shapeFaces,
    shapeEdges: input.shapeEdges,
    boundary: {
      elements: new Uint32Array(bElements),
      localFaces: new Uint8Array(bLocal),
      tags: new Uint32Array(bTags),
    },
    edges: { offsets, nodes: new Uint32Array(chain) },
  };
  checkFemMesh(mesh);
  return { mesh, curved, straightened, minJacobian };
}

/**
 * Moves listed surface mid nodes onto the shape, then straightens every element whose
 * `jacobianRatio` is below `curvedJacobianMin` (a fold or near one).
 */
function curveMidNodes(
  input: SurfaceMeshInput,
  nodes: Float64Array,
  elements: Uint32Array,
  m: number,
  mid: Map<number, number>,
  key: (a: number, b: number) => number,
) {
  const { pairs, points } = input.midpoints!;
  /** Mid node → its straight position, for each node moved. */
  const moved = new Map<number, [number, number, number]>();
  for (let i = 0; i < pairs.length / 2; i++) {
    const id = mid.get(key(pairs[2 * i]!, pairs[2 * i + 1]!));
    // A listed edge that no element has is not on the mesh's surface: checked by the caller.
    if (id === undefined) fail('midpoint', `pair ${i} is not an element edge`);
    moved.set(id!, [nodes[3 * id!]!, nodes[3 * id! + 1]!, nodes[3 * id! + 2]!]);
    for (let d = 0; d < 3; d++) nodes[3 * id! + d] = points[3 * i + d]!;
  }
  const curved = moved.size;
  const view: FemMesh = {
    type: 'tet10',
    nodes,
    elements,
    shapeFaces: 0,
    shapeEdges: 0,
    boundary: {
      elements: new Uint32Array(),
      localFaces: new Uint8Array(),
      tags: new Uint32Array(),
    },
    edges: { offsets: new Uint32Array(1), nodes: new Uint32Array() },
  };
  const touched: number[] = [];
  for (let e = 0; e < m; e++)
    for (let j = 4; j < 10; j++)
      if (moved.has(elements[10 * e + j]!)) {
        touched.push(e);
        break;
      }
  let straightened = 0;
  for (let changed = true; changed; ) {
    changed = false;
    for (const e of touched) {
      if (jacobianRatio(view, e) >= curvedJacobianMin) continue;
      for (let j = 4; j < 10; j++) {
        const id = elements[10 * e + j]!;
        const straight = moved.get(id);
        if (!straight) continue;
        for (let d = 0; d < 3; d++) nodes[3 * id + d] = straight[d]!;
        moved.delete(id);
        straightened++;
        changed = true;
      }
    }
  }
  let minJacobian = 1;
  for (const e of touched) minJacobian = Math.min(minJacobian, jacobianRatio(view, e));
  return { curved: curved - straightened, straightened, minJacobian };
}

/** Checks the surface and the settings, meshes with Netgen and returns a checked FEM 1 mesh. */
export function meshSurface(
  m: FemMesherModule,
  input: SurfaceMeshInput,
  settings: MesherSettings,
): FemMesh {
  checkMesherSettings(settings);
  checkSurface(input);
  return assembleFemMesh(input, runNetgen(m, input, settings), settings.type);
}

/** As `meshSurface`, with how the curved mid nodes were placed. */
export function meshSurfaceReport(
  m: FemMesherModule,
  input: SurfaceMeshInput,
  settings: MesherSettings,
): MeshReport {
  checkMesherSettings(settings);
  checkSurface(input);
  return assembleReport(input, runNetgen(m, input, settings), settings.type);
}
