import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { checkEpmMesh, type EpmMesh } from './epm';
import { editFail, meshTopology } from './topology';

/**
 * C7a multires: a cage subdivided `level` times (Catmull-Clark, the C3 rules with creases) with a
 * displacement per point on top. The first level makes one quad per face corner of the cage; at
 * level L each of those is a grid of G × G points, G = 2^(L−1) + 1, and the displacements live
 * there, corner after corner. A displacement is in its grid point's tangent frame (along the
 * grid's i axis, across it, along the surface normal), so moving or skinning the cage carries the
 * detail along. Points on a grid's edge are shared with the next grid; each grid keeps its own
 * copy, the first grid to reach a vertex decides it, and writes go to every copy.
 */
export const multiresLimits = Object.freeze({
  levels: 7,
  /** Vertices at the top level, per part. */
  vertices: 2_100_000,
  /** Grid points one chunk asset holds at most (65², one corner grid of level 7). */
  chunkPoints: 4225,
  /** The largest displacement component (mm). */
  displacement: 100_000,
});

export const multiresGridSize = (level: number) => (1 << (level - 1)) + 1;
/** Corner grids per chunk asset: as many whole grids as fit `chunkPoints`. */
export const multiresChunkCorners = (level: number) =>
  Math.max(1, Math.floor(multiresLimits.chunkPoints / multiresGridSize(level) ** 2));
export const multiresChunkCount = (corners: number, level: number) =>
  Math.ceil(corners / multiresChunkCorners(level));

const checkLevel = (level: number) => {
  if (!Number.isInteger(level) || level < 1 || level > multiresLimits.levels)
    editFail('selection', `multires levels must be 1–${multiresLimits.levels}`);
};

/** `sha256:<hex>` of the cage's faces (sizes and vertex indices): what the grids hang from. */
export function multiresTopology(cage: EpmMesh): string {
  const h = sha256.create();
  h.update(new Uint8Array(new Uint32Array([cage.faceSizes.length]).buffer));
  h.update(
    new Uint8Array(cage.faceSizes.buffer, cage.faceSizes.byteOffset, cage.faceSizes.byteLength),
  );
  h.update(
    new Uint8Array(
      cage.faceIndices.buffer,
      cage.faceIndices.byteOffset,
      cage.faceIndices.byteLength,
    ),
  );
  return `sha256:${bytesToHex(h.digest())}`;
}

/**
 * Throws `MeshEditError` unless a multires of `level` on `cage` is within the limits (`selection`
 * for the level, `limit` for the vertices): cheap, so callers check before allocating.
 */
export function checkMultiresLevel(cage: EpmMesh, level: number): void {
  checkLevel(level);
  const count = multiresVertexCount(cage, level);
  if (count > multiresLimits.vertices)
    editFail(
      'limit',
      `${count} vertices at level ${level}; the limit is ${multiresLimits.vertices}`,
    );
}

/** The vertex count at `level`, counted from the cage's vertices, edges and faces. */
export function multiresVertexCount(cage: EpmMesh, level: number): number {
  checkLevel(level);
  const t = meshTopology(cage);
  let edges = 0;
  for (let h = 0; h < t.twin.length; h++) if (t.twin[h] < 0 || h < t.twin[h]) edges++;
  let used = 0;
  for (let v = 0; v < t.vertexCount; v++) if (t.outgoingStart[v + 1] > t.outgoingStart[v]) used++;
  const corners = cage.faceIndices.length;
  let V = used + edges + cage.faceSizes.length;
  let E = 2 * edges + corners;
  let F = corners;
  for (let l = 1; l < level; l++) {
    V += E + F;
    E = 2 * E + 4 * F;
    F = 4 * F;
  }
  return V;
}

/** A polygon mesh in the form one subdivision step reads: vertex positions and faces. */
interface Polys {
  positions: Float64Array;
  faceStart: Uint32Array;
  faceSizes: Uint32Array;
  indices: Uint32Array;
  /** Creased edges as vertex pairs and weights (0–1). */
  creases: { a: number; b: number; c: number }[];
}

/**
 * One Catmull-Clark step on typed arrays: the same rules as `subdivideMesh` (C3c), so a multires
 * base at level n is the same surface as n levels of subdivision. New vertices: the input's
 * vertex points keep their indices, face points follow, then edge points. Face f's corner k
 * becomes face `faceStart[f] + k`: [vertex point, edge point to the next corner, face point,
 * edge point from the previous corner].
 */
function subdivideStep(m: Polys): Polys {
  const { positions: P, faceStart, faceSizes, indices } = m;
  const V = P.length / 3;
  const F = faceSizes.length;
  const H = indices.length;
  const faceOf = new Uint32Array(H);
  for (let f = 0; f < F; f++) for (let k = 0; k < faceSizes[f]; k++) faceOf[faceStart[f] + k] = f;
  const next = (h: number) => {
    const f = faceOf[h];
    return h + 1 === faceStart[f] + faceSizes[f] ? faceStart[f] : h + 1;
  };
  const prev = (h: number) => {
    const f = faceOf[h];
    return h === faceStart[f] ? faceStart[f] + faceSizes[f] - 1 : h - 1;
  };
  // Twins through a directed-edge table (linear, whatever the valence; keys stay below 2^53).
  const directed = new Map<number, number>();
  for (let h = 0; h < H; h++) {
    const key = indices[h] * V + indices[next(h)];
    if (directed.has(key)) editFail('non-manifold', `edge ${indices[h]}-${indices[next(h)]}`);
    directed.set(key, h);
  }
  const twin = new Int32Array(H).fill(-1);
  for (let h = 0; h < H; h++) {
    const o = directed.get(indices[next(h)] * V + indices[h]);
    if (o !== undefined) twin[h] = o;
  }
  const halfEdge = (a: number, b: number) => directed.get(a * V + b) ?? -1;
  // Outgoing half-edges per vertex, for the vertex points.
  const outStart = new Uint32Array(V + 1);
  for (let h = 0; h < H; h++) outStart[indices[h] + 1]++;
  for (let v = 0; v < V; v++) outStart[v + 1] += outStart[v];
  const out = new Uint32Array(H);
  const fill = outStart.slice(0, V);
  for (let h = 0; h < H; h++) out[fill[indices[h]]++] = h;
  // Edges, numbered by their first half-edge.
  const edgeOf = new Uint32Array(H);
  let E = 0;
  for (let h = 0; h < H; h++) {
    if (twin[h] >= 0 && twin[h] < h) edgeOf[h] = edgeOf[twin[h]];
    else edgeOf[h] = E++;
  }
  const crease = new Float64Array(E);
  for (const { a, b, c } of m.creases) {
    const h = halfEdge(a, b) >= 0 ? halfEdge(a, b) : halfEdge(b, a);
    if (h >= 0) crease[edgeOf[h]] = c;
  }
  const edgeCrease = (h: number) => (twin[h] < 0 ? 1 : crease[edgeOf[h]]);
  const total = V + F + E;
  const Q = new Float64Array(3 * total);
  // Face points.
  for (let f = 0; f < F; f++) {
    const n = faceSizes[f];
    let x = 0,
      y = 0,
      z = 0;
    for (let k = 0; k < n; k++) {
      const v = 3 * indices[faceStart[f] + k];
      x += P[v];
      y += P[v + 1];
      z += P[v + 2];
    }
    const o = 3 * (V + f);
    Q[o] = x / n;
    Q[o + 1] = y / n;
    Q[o + 2] = z / n;
  }
  // Edge points.
  const firstHalf = new Int32Array(E).fill(-1);
  for (let h = 0; h < H; h++) if (firstHalf[edgeOf[h]] < 0) firstHalf[edgeOf[h]] = h;
  for (let e = 0; e < E; e++) {
    const h = firstHalf[e];
    const a = 3 * indices[h],
      b = 3 * indices[next(h)];
    const c = edgeCrease(h);
    const o = 3 * (V + F + e);
    for (let k = 0; k < 3; k++) {
      const mid = (P[a + k] + P[b + k]) / 2;
      if (c >= 1) Q[o + k] = mid;
      else {
        const f1 = 3 * (V + faceOf[h]),
          f2 = 3 * (V + faceOf[twin[h]]);
        const smooth = (P[a + k] + P[b + k] + Q[f1 + k] + Q[f2 + k]) / 4;
        Q[o + k] = c * mid + (1 - c) * smooth;
      }
    }
  }
  // Vertex points.
  const others: { x: number; c: number }[] = [];
  const faces: number[] = [];
  for (let v = 0; v < V; v++) {
    const s = outStart[v],
      e = outStart[v + 1];
    const o = 3 * v;
    if (e === s) {
      Q[o] = P[o];
      Q[o + 1] = P[o + 1];
      Q[o + 2] = P[o + 2];
      continue;
    }
    others.length = 0;
    faces.length = 0;
    let border = false;
    for (let k = s; k < e; k++) {
      const h = out[k];
      others.push({ x: indices[next(h)], c: edgeCrease(h) });
      faces.push(faceOf[h]);
      const p = prev(h);
      if (twin[p] < 0) {
        border = true;
        others.push({ x: indices[p], c: 1 });
      }
      if (twin[h] < 0) border = true;
    }
    const n = others.length;
    const smooth = (k: number) => {
      let q = 0;
      for (const f of faces) q += Q[3 * (V + f) + k];
      let r = 0;
      for (const x of others) r += P[o + k] + P[3 * x.x + k];
      return q / faces.length / n + r / n / n + ((n - 3) / n) * P[o + k];
    };
    const sharp = others.filter((x) => x.c > 0);
    for (let k = 0; k < 3; k++) {
      let value: number;
      if (border && faces.length === 1) value = P[o + k];
      else if (sharp.length >= 3) {
        const w = border ? 1 : sharp.reduce((a, x) => a + x.c, 0) / sharp.length;
        value = w * P[o + k] + (w < 1 ? (1 - w) * smooth(k) : 0);
      } else if (sharp.length === 2) {
        const w = border ? 1 : (sharp[0].c + sharp[1].c) / 2;
        const rule = (6 * P[o + k] + P[3 * sharp[0].x + k] + P[3 * sharp[1].x + k]) / 8;
        value = w * rule + (w < 1 ? (1 - w) * smooth(k) : 0);
      } else value = smooth(k);
      Q[o + k] = value;
    }
  }
  // Child faces, one quad per corner, in corner order.
  const quads = new Uint32Array(4 * H);
  for (let h = 0; h < H; h++) {
    const f = faceOf[h];
    quads[4 * h] = indices[h];
    quads[4 * h + 1] = V + F + edgeOf[h];
    quads[4 * h + 2] = V + f;
    quads[4 * h + 3] = V + F + edgeOf[prev(h)];
  }
  const creases: Polys['creases'] = [];
  for (let e = 0; e < E; e++) {
    const h = firstHalf[e];
    if (twin[h] < 0 || crease[e] <= 0) continue;
    creases.push({ a: indices[h], b: V + F + e, c: crease[e] });
    creases.push({ a: V + F + e, b: indices[next(h)], c: crease[e] });
  }
  const childStart = new Uint32Array(H);
  for (let i = 0; i < H; i++) childStart[i] = 4 * i;
  return {
    positions: Q,
    faceStart: childStart,
    faceSizes: new Uint32Array(H).fill(4),
    indices: quads,
    creases,
  };
}

/** A multires base: the cage subdivided `level` times, and where each grid point sits. */
export interface MultiresBase {
  level: number;
  /** G: points along one side of a corner grid. */
  grid: number;
  /** Corner grids (the cage's face corners). */
  corners: number;
  /** The subdivided surface, without displacement (mm). */
  positions: Float32Array;
  /** Its quads, corner grid after corner grid. */
  quads: Uint32Array;
  /** The vertex of each grid point: `corner · G² + j · G + i`. */
  gridVertex: Uint32Array;
  /** The grid point that decides each vertex (the first to reach it). */
  vertexOwner: Uint32Array;
}

/**
 * The base surface of a multires at `level`. Throws `MeshEditError` (`selection` for a level out
 * of range, `limit` past `multiresLimits.vertices`, `non-manifold` for a cage the subdivision
 * cannot walk) before doing the work.
 */
export function multiresBase(cage: EpmMesh, level: number): MultiresBase {
  checkEpmMesh(cage);
  checkMultiresLevel(cage, level);
  const faceStart = new Uint32Array(cage.faceSizes.length);
  for (let f = 0, c = 0; f < faceStart.length; f++) {
    faceStart[f] = c;
    c += cage.faceSizes[f];
  }
  const creases: Polys['creases'] = [];
  if (cage.creases)
    for (let i = 0; i < cage.creases.values.length; i++)
      creases.push({
        a: cage.creases.edges[2 * i],
        b: cage.creases.edges[2 * i + 1],
        c: cage.creases.values[i],
      });
  let m: Polys = {
    positions: Float64Array.from(cage.positions),
    faceStart,
    faceSizes: cage.faceSizes,
    indices: cage.faceIndices,
    creases,
  };
  const corners = cage.faceIndices.length;
  const N = 1 << (level - 1);
  // Grid coordinates of each face's 4 corners, carried down the levels (x, y per corner).
  let coords = new Int32Array(8 * corners);
  for (let c = 0; c < corners; c++) coords.set([0, 0, N, 0, N, N, 0, N], 8 * c);
  for (let l = 0; l < level; l++) {
    m = subdivideStep(m);
    if (l === 0) continue;
    const parent = coords;
    coords = new Int32Array(4 * parent.length);
    const faces = parent.length / 8;
    for (let f = 0; f < faces; f++) {
      const p = (k: number) => [parent[8 * f + 2 * (k & 3)], parent[8 * f + 2 * (k & 3) + 1]];
      const cx = (parent[8 * f] + parent[8 * f + 4]) / 2,
        cy = (parent[8 * f + 1] + parent[8 * f + 5]) / 2;
      for (let k = 0; k < 4; k++) {
        const a = p(k),
          b = p(k + 1),
          z = p(k + 3);
        coords.set(
          [
            a[0],
            a[1],
            (a[0] + b[0]) / 2,
            (a[1] + b[1]) / 2,
            cx,
            cy,
            (a[0] + z[0]) / 2,
            (a[1] + z[1]) / 2,
          ],
          8 * (4 * f + k),
        );
      }
    }
  }
  // Drop the cage's unused vertices (a vertex no face names) and number the rest densely.
  const used = new Int32Array(m.positions.length / 3).fill(-1);
  let n = 0;
  for (let i = 0; i < m.indices.length; i++) if (used[m.indices[i]] < 0) used[m.indices[i]] = n++;
  const positions = new Float32Array(3 * n);
  for (let v = 0; v < used.length; v++)
    if (used[v] >= 0)
      for (let k = 0; k < 3; k++) positions[3 * used[v] + k] = m.positions[3 * v + k];
  const quads = new Uint32Array(m.indices.length);
  for (let i = 0; i < quads.length; i++) quads[i] = used[m.indices[i]];
  const G = N + 1;
  const gridVertex = new Uint32Array(corners * G * G);
  const perCorner = quads.length / 4 / corners;
  for (let f = 0; f < quads.length / 4; f++) {
    const c = Math.floor(f / perCorner);
    for (let k = 0; k < 4; k++)
      gridVertex[c * G * G + coords[8 * f + 2 * k + 1] * G + coords[8 * f + 2 * k]] =
        quads[4 * f + k];
  }
  const vertexOwner = new Uint32Array(n).fill(0xffffffff);
  for (let g = 0; g < gridVertex.length; g++)
    if (vertexOwner[gridVertex[g]] === 0xffffffff) vertexOwner[gridVertex[g]] = g;
  return { level, grid: G, corners, positions, quads, gridVertex, vertexOwner };
}

/** Each grid point's tangent frame on a base surface (the base's positions). */
/**
 * C7c display level: for each vertex of the multires at a lower level, the vertex of the top
 * level at the same grid point (corner c, i, j → c, i · s, j · s with s = 2^(top − lower)). Drawing
 * the lower level's quads with the top level's positions shows the sculpted shape coarser; it is a
 * view only (sculpting stays on the top level).
 */
export function multiresDisplayVertices(top: MultiresBase, lower: MultiresBase): Uint32Array {
  if (lower.corners !== top.corners || lower.level > top.level)
    editFail('selection', 'display level');
  const s = 1 << (top.level - lower.level);
  const G = lower.grid,
    T = top.grid;
  const out = new Uint32Array(lower.vertexOwner.length);
  for (let v = 0; v < out.length; v++) {
    const g = lower.vertexOwner[v];
    const c = Math.floor(g / (G * G)),
      j = Math.floor((g % (G * G)) / G),
      i = g % G;
    out[v] = top.gridVertex[c * T * T + j * s * T + i * s];
  }
  return out;
}

export interface MultiresFrames {
  /** Per vertex, the unit normal (area-weighted over its quads). */
  normals: Float32Array;
  /** Per grid point, the unit tangent along the grid's i axis, at right angles to the normal. */
  tangents: Float32Array;
}

export function multiresFrames(base: MultiresBase, positions = base.positions): MultiresFrames {
  const { quads, gridVertex, grid: G } = base;
  const P = positions;
  const vertices = P.length / 3;
  const normals = new Float32Array(3 * vertices);
  for (let f = 0; f < quads.length; f += 4) {
    const a = 3 * quads[f],
      b = 3 * quads[f + 1],
      c = 3 * quads[f + 2],
      d = 3 * quads[f + 3];
    // The cross product of the diagonals: twice the quad's area along its normal.
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
      normals[v] += nx;
      normals[v + 1] += ny;
      normals[v + 2] += nz;
    }
  }
  for (let v = 0; v < vertices; v++) {
    const o = 3 * v;
    const l = Math.hypot(normals[o], normals[o + 1], normals[o + 2]);
    if (l > 0) {
      normals[o] /= l;
      normals[o + 1] /= l;
      normals[o + 2] /= l;
    } else normals[o + 2] = 1;
  }
  const tangents = new Float32Array(3 * gridVertex.length);
  for (let g = 0; g < gridVertex.length; g++) {
    const i = g % G;
    const row = g - i;
    const a = 3 * gridVertex[row + Math.max(0, i - 1)],
      b = 3 * gridVertex[row + Math.min(G - 1, i + 1)];
    const n = 3 * gridVertex[g];
    let tx = P[b] - P[a],
      ty = P[b + 1] - P[a + 1],
      tz = P[b + 2] - P[a + 2];
    const dot = tx * normals[n] + ty * normals[n + 1] + tz * normals[n + 2];
    tx -= dot * normals[n];
    ty -= dot * normals[n + 1];
    tz -= dot * normals[n + 2];
    let l = Math.hypot(tx, ty, tz);
    if (!(l > 1e-12)) {
      // A degenerate run: any direction at right angles to the normal.
      const [x, y, z] = [normals[n], normals[n + 1], normals[n + 2]];
      [tx, ty, tz] = Math.abs(x) < 0.9 ? [0, -z, y] : [z, 0, -x];
      l = Math.hypot(tx, ty, tz);
    }
    tangents[3 * g] = tx / l;
    tangents[3 * g + 1] = ty / l;
    tangents[3 * g + 2] = tz / l;
  }
  return { normals, tangents };
}

/**
 * The displaced surface: each vertex moved by its owner grid point's displacement, from that
 * point's frame (tangent, normal × tangent, normal) to mesh space.
 */
export function multiresPositions(
  base: MultiresBase,
  frames: MultiresFrames,
  displacements: Float32Array,
  positions = base.positions,
): Float32Array {
  const out = new Float32Array(positions.length);
  const { normals: N, tangents: T } = frames;
  for (let v = 0; v < positions.length / 3; v++) {
    const g = base.vertexOwner[v];
    const o = 3 * v,
      t = 3 * g;
    const d0 = displacements[t],
      d1 = displacements[t + 1],
      d2 = displacements[t + 2];
    const bx = N[o + 1] * T[t + 2] - N[o + 2] * T[t + 1],
      by = N[o + 2] * T[t] - N[o] * T[t + 2],
      bz = N[o] * T[t + 1] - N[o + 1] * T[t];
    out[o] = positions[o] + d0 * T[t] + d1 * bx + d2 * N[o];
    out[o + 1] = positions[o + 1] + d0 * T[t + 1] + d1 * by + d2 * N[o + 1];
    out[o + 2] = positions[o + 2] + d0 * T[t + 2] + d1 * bz + d2 * N[o + 2];
  }
  return out;
}

/**
 * The displacements that move the base to `target` (mm, per vertex), written to every grid point
 * of each vertex in that point's own frame. `vertices` limits the work to those vertices; the
 * rest of `into` is kept. `corners`, when given, collects the corner grids written (so a stroke's
 * edit can rewrite only their chunks).
 */
export function multiresDisplacementsFrom(
  base: MultiresBase,
  frames: MultiresFrames,
  target: Float32Array,
  into: Float32Array = new Float32Array(3 * base.gridVertex.length),
  vertices?: ReadonlySet<number>,
  corners?: Set<number>,
): Float32Array {
  const { normals: N, tangents: T } = frames;
  const P = base.positions;
  const G2 = base.grid * base.grid;
  for (let g = 0; g < base.gridVertex.length; g++) {
    const v = base.gridVertex[g];
    if (vertices && !vertices.has(v)) continue;
    corners?.add(Math.floor(g / G2));
    const o = 3 * v,
      t = 3 * g;
    const dx = target[o] - P[o],
      dy = target[o + 1] - P[o + 1],
      dz = target[o + 2] - P[o + 2];
    const bx = N[o + 1] * T[t + 2] - N[o + 2] * T[t + 1],
      by = N[o + 2] * T[t] - N[o] * T[t + 2],
      bz = N[o] * T[t + 1] - N[o + 1] * T[t];
    into[t] = dx * T[t] + dy * T[t + 1] + dz * T[t + 2];
    into[t + 1] = dx * bx + dy * by + dz * bz;
    into[t + 2] = dx * N[o] + dy * N[o + 1] + dz * N[o + 2];
  }
  return into;
}

/**
 * Displacements one level up: each corner grid doubled, the new points the average of the old
 * ones around them (in the grid's own frame).
 */
export function multiresRaise(displacements: Float32Array, corners: number, level: number) {
  checkLevel(level + 1);
  const G = multiresGridSize(level),
    H = 2 * G - 1;
  if (displacements.length !== 3 * corners * G * G) editFail('selection', 'displacement count');
  const out = new Float32Array(3 * corners * H * H);
  for (let c = 0; c < corners; c++) {
    const src = (i: number, j: number, k: number) => displacements[3 * (c * G * G + j * G + i) + k];
    for (let j = 0; j < H; j++)
      for (let i = 0; i < H; i++)
        for (let k = 0; k < 3; k++) {
          const i0 = i >> 1,
            j0 = j >> 1,
            i1 = i0 + (i & 1),
            j1 = j0 + (j & 1);
          out[3 * (c * H * H + j * H + i) + k] =
            (src(i0, j0, k) + src(i1, j0, k) + src(i0, j1, k) + src(i1, j1, k)) / 4;
        }
  }
  return out;
}

/** The error of a malformed or oversized multires chunk; nothing is repaired. */
export class MultiresAssetError extends Error {
  constructor(
    readonly problem: 'header' | 'length' | 'level' | 'corners' | 'not-finite' | 'limit',
    readonly detail: string,
  ) {
    super(`multires-asset-refused: ${problem}: ${detail}`);
    this.name = 'MultiresAssetError';
  }
}
const MAGIC = [0x45, 0x50, 0x4d, 0x52]; // "EPMR"
const HEADER = 20;
export const multiresMediaType = 'model/x-editor-platform-multires';

/** One chunk: displacements of `cornerCount` corner grids from `firstCorner`. */
export interface MultiresChunk {
  level: number;
  firstCorner: number;
  displacements: Float32Array;
}

/** EPMR 1: "EPMR", version, level, first corner, corner count (u32 LE), then f32 LE x, y, z. */
export function encodeMultiresChunk(chunk: MultiresChunk): Uint8Array {
  checkLevel(chunk.level);
  const G = multiresGridSize(chunk.level);
  const count = chunk.displacements.length / (3 * G * G);
  if (!Number.isInteger(count) || count < 1 || count > multiresChunkCorners(chunk.level))
    throw new MultiresAssetError('corners', `${count} corner grids`);
  for (const x of chunk.displacements)
    if (!Number.isFinite(x) || Math.abs(x) > multiresLimits.displacement)
      throw new MultiresAssetError('not-finite', 'a displacement out of range');
  const bytes = new Uint8Array(HEADER + 4 * chunk.displacements.length);
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC, 0);
  view.setUint32(4, 1, true);
  view.setUint32(8, chunk.level, true);
  view.setUint32(12, chunk.firstCorner, true);
  view.setUint32(16, count, true);
  for (let i = 0; i < chunk.displacements.length; i++)
    view.setFloat32(HEADER + 4 * i, chunk.displacements[i], true);
  return bytes;
}

export function decodeMultiresChunk(bytes: Uint8Array): MultiresChunk {
  if (bytes.length < HEADER || MAGIC.some((b, i) => bytes[i] !== b))
    throw new MultiresAssetError('header', 'not an EPMR chunk');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== 1) throw new MultiresAssetError('header', 'version');
  const level = view.getUint32(8, true);
  if (level < 1 || level > multiresLimits.levels)
    throw new MultiresAssetError('level', `level ${level}`);
  const firstCorner = view.getUint32(12, true);
  const count = view.getUint32(16, true);
  if (count < 1 || count > multiresChunkCorners(level))
    throw new MultiresAssetError('corners', `${count} corner grids`);
  const G = multiresGridSize(level);
  const values = 3 * count * G * G;
  if (bytes.length !== HEADER + 4 * values)
    throw new MultiresAssetError('length', `${bytes.length} bytes`);
  const displacements = new Float32Array(values);
  for (let i = 0; i < values; i++) {
    const x = view.getFloat32(HEADER + 4 * i, true);
    if (!Number.isFinite(x) || Math.abs(x) > multiresLimits.displacement)
      throw new MultiresAssetError('not-finite', 'a displacement out of range');
    displacements[i] = x;
  }
  return { level, firstCorner, displacements };
}

/** All displacements, split into chunks in corner order. */
export function multiresChunks(displacements: Float32Array, corners: number, level: number) {
  const G = multiresGridSize(level);
  if (displacements.length !== 3 * corners * G * G)
    throw new MultiresAssetError('corners', 'displacement count');
  const per = multiresChunkCorners(level);
  const out: MultiresChunk[] = [];
  for (let c = 0; c < corners; c += per) {
    const n = Math.min(per, corners - c);
    out.push({
      level,
      firstCorner: c,
      displacements: displacements.slice(3 * c * G * G, 3 * (c + n) * G * G),
    });
  }
  return out;
}

/** The chunks put back together; they must be the chunks `multiresChunks` makes, in order. */
export function multiresJoin(chunks: readonly MultiresChunk[], corners: number, level: number) {
  const G = multiresGridSize(level);
  const per = multiresChunkCorners(level);
  if (chunks.length !== multiresChunkCount(corners, level))
    throw new MultiresAssetError('corners', `${chunks.length} chunks for ${corners} corners`);
  const out = new Float32Array(3 * corners * G * G);
  chunks.forEach((chunk, i) => {
    const n = Math.min(per, corners - i * per);
    if (chunk.level !== level) throw new MultiresAssetError('level', `chunk ${i}`);
    if (chunk.firstCorner !== i * per || chunk.displacements.length !== 3 * n * G * G)
      throw new MultiresAssetError('corners', `chunk ${i}`);
    out.set(chunk.displacements, 3 * i * per * G * G);
  });
  return out;
}
