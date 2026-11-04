import { checkEpmMesh, epmLimits, type EpmLimits, type EpmMesh } from './epm';
import { MeshBuilder, type EditInput, type Vec3, type VertexBlend } from './edit';
import { edgeKey, edgeOfKey, editFail, faceVertices, halfEdgeTo, meshTopology } from './topology';

/**
 * Limits of Catmull-Clark subdivision (C3c). Each level makes one quad per face corner, so the
 * face count is checked before any work: `corners · 4^(levels − 1)`.
 */
export const subdivisionLimits = Object.freeze({ levels: 4, faces: 1_000_000 });

/** The face count `levels` of subdivision would make, without subdividing. */
export function subdividedFaceCount(mesh: EpmMesh, levels: number): number {
  return levels === 0 ? mesh.faceSizes.length : mesh.faceIndices.length * 4 ** (levels - 1);
}

/**
 * Catmull-Clark subdivision with creases. A crease (0–1) blends each rule toward the sharp one:
 * an edge point toward the edge midpoint, a vertex on two creased edges toward the crease rule
 * `(a + 6v + b) / 8`, a vertex on three or more toward staying put. Borders are sharp (crease 1),
 * and a border corner of a single face stays put. Child edges keep their parent's crease, so a
 * crease of 1 stays sharp at every level. UVs are subdivided linearly per face; skin weights and
 * morph deltas follow the same stencils as positions. The result is all quads.
 */
export function subdivideMesh(
  mesh: EpmMesh,
  levels: number,
  limits: EpmLimits = { ...epmLimits },
): EpmMesh {
  if (!Number.isInteger(levels) || levels < 0 || levels > subdivisionLimits.levels)
    editFail('selection', `levels must be 0–${subdivisionLimits.levels}`);
  if (subdividedFaceCount(mesh, levels) > subdivisionLimits.faces)
    editFail('limit', `${subdividedFaceCount(mesh, levels)} faces at level ${levels}`);
  checkEpmMesh(mesh, limits);
  let out = mesh;
  for (let l = 0; l < levels; l++)
    out = subdivideOnce({ mesh: out, topology: meshTopology(out) }, limits);
  return out;
}

function subdivideOnce(input: EditInput, limits: EpmLimits): EpmMesh {
  const { mesh, topology: t } = input;
  const b = new MeshBuilder(input);
  const P = (v: number): Vec3 => b.position(v);
  const crease = (x: number, y: number, h: number) =>
    t.twin[h] < 0 ? 1 : (b.creases.get(edgeKey(x, y)) ?? 0);
  const at = (blend: Map<number, number>): [Vec3, VertexBlend] => {
    const p: Vec3 = [0, 0, 0];
    const list: VertexBlend = [];
    for (const [v, w] of blend) {
      const q = P(v);
      for (let k = 0; k < 3; k++) p[k] += w * q[k];
      list.push([v, w]);
    }
    return [p, list];
  };
  const add = (m: Map<number, number>, v: number, w: number) => m.set(v, (m.get(v) ?? 0) + w);
  const addAll = (m: Map<number, number>, from: Map<number, number>, w: number) => {
    for (const [v, x] of from) add(m, v, x * w);
  };
  // Face points.
  const faceBlend: Map<number, number>[] = [];
  const facePoint: number[] = [];
  for (let f = 0; f < mesh.faceSizes.length; f++) {
    const vs = faceVertices(mesh, t, f);
    const m = new Map<number, number>();
    for (const v of vs) add(m, v, 1 / vs.length);
    faceBlend.push(m);
    facePoint.push(b.addVertex(...at(m)));
  }
  // Edge points, one per edge (keyed by edgeKey), with each edge's crease.
  const edgePoint = new Map<number, number>();
  const edgeCrease = new Map<number, number>();
  for (let h = 0; h < mesh.faceIndices.length; h++) {
    const x = mesh.faceIndices[h],
      y = halfEdgeTo(mesh, t, h);
    const key = edgeKey(x, y);
    if (edgePoint.has(key)) continue;
    const c = crease(x, y, h);
    edgeCrease.set(key, c);
    const m = new Map<number, number>();
    add(m, x, 0.5);
    add(m, y, 0.5);
    if (c < 1) {
      const smooth = new Map<number, number>();
      add(smooth, x, 0.25);
      add(smooth, y, 0.25);
      addAll(smooth, faceBlend[t.halfEdgeFace[h]], 0.25);
      addAll(smooth, faceBlend[t.halfEdgeFace[t.twin[h]]], 0.25);
      for (const [v, w] of m) m.set(v, w * c);
      addAll(m, smooth, 1 - c);
    }
    edgePoint.set(key, b.addVertex(...at(m)));
  }
  // Vertex points.
  const vertexPoint = new Int32Array(t.vertexCount).fill(-1);
  for (let v = 0; v < t.vertexCount; v++) {
    const s = t.outgoingStart[v],
      e = t.outgoingStart[v + 1];
    if (e === s) continue;
    // Every edge at v: the outgoing half-edges, plus the incoming border half-edge if any.
    const others: { x: number; c: number }[] = [];
    const faces: number[] = [];
    let border = false;
    for (let k = s; k < e; k++) {
      const h = t.outgoing[k];
      const x = halfEdgeTo(mesh, t, h);
      others.push({ x, c: edgeCrease.get(edgeKey(v, x))! });
      faces.push(t.halfEdgeFace[h]);
      // The edge coming into v in this face, when it is a border, has no outgoing twin.
      const f = t.halfEdgeFace[h];
      const prev = h === t.faceStart[f] ? t.faceStart[f] + t.faceSizes[f] - 1 : h - 1;
      if (t.twin[prev] < 0) {
        border = true;
        const y = mesh.faceIndices[prev];
        others.push({ x: y, c: 1 });
      }
      if (t.twin[h] < 0) border = true;
    }
    const sharp = others.filter((o) => o.c > 0);
    const m = new Map<number, number>();
    if (border && faces.length === 1) {
      add(m, v, 1);
    } else if (sharp.length >= 3) {
      const w = border ? 1 : sharp.reduce((a, o) => a + o.c, 0) / sharp.length;
      add(m, v, w);
      if (w < 1) addAll(m, smoothVertex(v, others, faces, faceBlend), 1 - w);
    } else if (sharp.length === 2) {
      const w = border ? 1 : (sharp[0].c + sharp[1].c) / 2;
      add(m, v, (6 / 8) * w);
      add(m, sharp[0].x, w / 8);
      add(m, sharp[1].x, w / 8);
      if (w < 1) addAll(m, smoothVertex(v, others, faces, faceBlend), 1 - w);
    } else {
      addAll(m, smoothVertex(v, others, faces, faceBlend), 1);
    }
    vertexPoint[v] = b.addVertex(...at(m));
  }
  // New faces: one quad per corner, wound as the face.
  for (let f = 0; f < mesh.faceSizes.length; f++) {
    const vs = faceVertices(mesh, t, f);
    const n = vs.length;
    const uv = b.faceUvs(f);
    let fu: [number, number] | null = null;
    if (uv) {
      fu = [0, 0];
      for (let k = 0; k < n; k++) {
        fu[0] += uv[2 * k] / n;
        fu[1] += uv[2 * k + 1] / n;
      }
    }
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n,
        i = (k + n - 1) % n;
      const mid = (a: number, c: number) =>
        uv ? [(uv[2 * a] + uv[2 * c]) / 2, (uv[2 * a + 1] + uv[2 * c + 1]) / 2] : [];
      b.faces.push({
        vertices: [
          vertexPoint[vs[k]],
          edgePoint.get(edgeKey(vs[k], vs[j]))!,
          facePoint[f],
          edgePoint.get(edgeKey(vs[i], vs[k]))!,
        ],
        uvs: uv ? [uv[2 * k], uv[2 * k + 1], ...mid(k, j), fu![0], fu![1], ...mid(i, k)] : null,
        material: mesh.faceMaterials[f],
      });
    }
  }
  // Child edges keep the parent's crease (borders stay borders on their own).
  const parentCreases = [...b.creases];
  b.creases.clear();
  for (const [key, w] of parentCreases) {
    const ep = edgePoint.get(key);
    if (ep === undefined) continue;
    const [x, y] = edgeOfKey(key);
    b.creases.set(edgeKey(vertexPoint[x], ep), w);
    b.creases.set(edgeKey(ep, vertexPoint[y]), w);
  }
  return b.finish(limits, limits.vertices);
}

/** The smooth Catmull-Clark rule (Q + 2R + (n − 3)v) / n for an interior vertex. */
function smoothVertex(
  v: number,
  others: { x: number }[],
  faces: number[],
  faceBlend: Map<number, number>[],
): Map<number, number> {
  const n = others.length;
  const m = new Map<number, number>();
  const add = (u: number, w: number) => m.set(u, (m.get(u) ?? 0) + w);
  for (const f of faces) for (const [u, w] of faceBlend[f]) add(u, w / faces.length / n);
  for (const o of others) {
    add(v, 1 / n / n);
    add(o.x, 1 / n / n);
  }
  add(v, (n - 3) / n);
  return m;
}
