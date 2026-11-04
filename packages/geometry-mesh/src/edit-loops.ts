import type { EpmLimits, EpmMesh } from './epm';
import { checkSelection, MeshBuilder, type EditInput, type Vec3, type VertexBlend } from './edit';
import {
  edgeKey,
  edgeOfKey,
  editFail,
  faceNormal,
  faceVertices,
  halfEdgeTo,
  nextHalfEdge,
  type MeshTopology,
} from './topology';

/** An edge as a vertex pair (any order). */
export type MeshEdge = readonly [number, number];

/** The half-edge from a to b, or -1. */
export function findHalfEdge(input: EditInput, a: number, b: number): number {
  const { mesh, topology: t } = input;
  for (let k = t.outgoingStart[a]; k < t.outgoingStart[a + 1]; k++) {
    const h = t.outgoing[k];
    if (halfEdgeTo(mesh, t, h) === b) return h;
  }
  return -1;
}
/** A half-edge of edge a-b (a→b if it exists, else b→a); refuses a pair that is not an edge. */
function edgeHalf(input: EditInput, [a, b]: MeshEdge): number {
  checkSelection([a, b], input.topology.vertexCount, 'vertex');
  const h = findHalfEdge(input, a, b);
  if (h >= 0) return h;
  const r = findHalfEdge(input, b, a);
  if (r < 0) editFail('selection', `${a}-${b} is not an edge`);
  return r;
}
const valence = (t: MeshTopology, v: number) => t.outgoingStart[v + 1] - t.outgoingStart[v];
const interiorVertex = (t: MeshTopology, v: number) => {
  for (let k = t.outgoingStart[v]; k < t.outgoingStart[v + 1]; k++)
    if (t.twin[t.outgoing[k]] < 0) return false;
  return true;
};

/**
 * The edge loop through an edge: from each end it continues to the edge straight across a
 * vertex with four edges, and stops at any other vertex or a border. Edges are vertex pairs in
 * loop order.
 */
export function edgeLoop(input: EditInput, edge: MeshEdge): [number, number][] {
  const { mesh, topology: t } = input;
  const h0 = edgeHalf(input, edge);
  const walk = (h: number) => {
    // h runs toward the vertex we continue through.
    const out: number[] = [];
    for (let guard = 0; guard < mesh.faceIndices.length; guard++) {
      const v = halfEdgeTo(mesh, t, h);
      if (valence(t, v) !== 4 || !interiorVertex(t, v)) break;
      const across = t.twin[nextHalfEdge(t, h)];
      const n = nextHalfEdge(t, across);
      if (n === h0 || t.twin[n] === h0) break;
      out.push(n);
      h = n;
    }
    return out;
  };
  const forward = walk(h0);
  const closedLoop =
    forward.length > 0 &&
    (() => {
      const last = forward[forward.length - 1];
      const v = halfEdgeTo(mesh, t, last);
      return v === mesh.faceIndices[h0];
    })();
  const back = closedLoop || t.twin[h0] < 0 ? [] : walk(t.twin[h0]).reverse();
  const pair = (h: number): [number, number] => [mesh.faceIndices[h], halfEdgeTo(mesh, t, h)];
  return [
    ...back.map((h) => pair(h).reverse() as [number, number]),
    pair(h0),
    ...forward.map(pair),
  ];
}

/**
 * The quads crossed by an edge ring: from the edge it steps to the opposite edge of each quad,
 * both ways, and stops at a face that is not a quad or at a border. Returns the ring as
 * half-edges `entry[i]` (in quad `faces[i]`) and the ring edges in order; `closed` when it comes
 * back to the start.
 */
export function edgeRing(
  input: EditInput,
  edge: MeshEdge,
): { edges: [number, number][]; faces: number[]; entries: number[]; closed: boolean } {
  const { mesh, topology: t } = input;
  const h0 = edgeHalf(input, edge);
  const isQuad = (h: number) => t.faceSizes[t.halfEdgeFace[h]] === 4;
  const opposite = (h: number) => nextHalfEdge(t, nextHalfEdge(t, h));
  // Walk forward from h0 through its face.
  const entries: number[] = [];
  let closed = false;
  let h = h0;
  for (let guard = 0; guard <= mesh.faceSizes.length; guard++) {
    if (!isQuad(h)) break;
    entries.push(h);
    const o = opposite(h);
    const tw = t.twin[o];
    if (tw < 0) break;
    if (tw === h0) {
      closed = true;
      break;
    }
    h = tw;
  }
  if (!closed && t.twin[h0] >= 0) {
    // Walk backward from the other side of the first edge and prepend.
    const before: number[] = [];
    let g = t.twin[h0];
    for (let guard = 0; guard <= mesh.faceSizes.length; guard++) {
      if (!isQuad(g)) break;
      const o = opposite(g);
      // In the ring's direction this face is entered by twin(o) … but we store the entry
      // half-edge that points the same way as h0's chain: the opposite of g.
      before.push(o);
      const tw = t.twin[o];
      if (tw < 0) break;
      g = tw;
    }
    entries.unshift(...before.reverse());
  }
  const pair = (x: number): [number, number] => [mesh.faceIndices[x], halfEdgeTo(mesh, t, x)];
  const edges = entries.map(pair);
  if (!closed && entries.length) {
    const last = entries[entries.length - 1];
    edges.push(pair(opposite(last)).reverse() as [number, number]);
  }
  if (entries.length === 0) edges.push(pair(h0));
  return { edges, faces: entries.map((x) => t.halfEdgeFace[x]), entries, closed };
}

/**
 * Splits the quads of an edge ring with `cuts` new edge loops (1–32), evenly spaced. Faces at
 * the ends of an open ring (not quads) gain the new vertices on their edge. Creases on the split
 * edges stay on every piece.
 */
export function loopCut(input: EditInput, edge: MeshEdge, cuts = 1, limits?: EpmLimits): EpmMesh {
  const { mesh, topology: t } = input;
  if (!Number.isInteger(cuts) || cuts < 1 || cuts > 32) editFail('selection', 'cuts must be 1–32');
  const ring = edgeRing(input, edge);
  if (ring.faces.length === 0) editFail('selection', 'the edge has no quad to cut');
  if (new Set(ring.faces).size !== ring.faces.length)
    editFail('selection', 'the ring crosses a quad twice');
  const b = new MeshBuilder(input);
  const skip = new Set(ring.faces);
  // Points along each ring edge, ordered from the smaller vertex index to the larger.
  const split = new Map<number, number[]>();
  const along = (a: number, c: number) => {
    const key = edgeKey(a, c);
    let pts = split.get(key);
    if (!pts) {
      const [lo, hi] = a < c ? [a, c] : [c, a];
      const p = b.position(lo),
        q = b.position(hi);
      pts = [];
      for (let k = 1; k <= cuts; k++) {
        const s = k / (cuts + 1);
        pts.push(
          b.addVertex([0, 1, 2].map((i) => p[i] + (q[i] - p[i]) * s) as Vec3, [
            [lo, 1 - s],
            [hi, s],
          ]),
        );
      }
      split.set(key, pts);
    }
    return a < c ? pts : pts.slice().reverse();
  };
  for (const [a, c] of ring.edges) along(a, c);
  const lerpUv = (uv: number[], i: number, j: number, s: number) => [
    uv[2 * i] + (uv[2 * j] - uv[2 * i]) * s,
    uv[2 * i + 1] + (uv[2 * j + 1] - uv[2 * i + 1]) * s,
  ];
  for (let f = 0; f < mesh.faceSizes.length; f++) {
    const vs = faceVertices(mesh, t, f);
    const uv = b.faceUvs(f);
    if (skip.has(f)) {
      // Rotate so the ring enters on corner 0: [p, q, r, s] with p→q and r→s the ring edges.
      const e = ring.entries[ring.faces.indexOf(f)] - t.faceStart[f];
      const rot = [0, 1, 2, 3].map((k) => (k + e) % 4);
      const [p, q, r, s] = rot.map((k) => vs[k]);
      const P = [p, ...along(p, q), q];
      const S = [s, ...along(s, r), r];
      // Each piece must stay convex in the quad's own direction, so no cut leaves the face.
      const n = faceNormal(mesh, t, f);
      for (let k = 0; k <= cuts; k++) {
        const quad = [P[k], P[k + 1], S[k + 1], S[k]].map((v) => b.position(v));
        for (let c = 0; c < 4; c++) {
          const o = quad[c],
            x = quad[(c + 1) % 4],
            y = quad[(c + 3) % 4];
          const u = [x[0] - o[0], x[1] - o[1], x[2] - o[2]],
            w = [y[0] - o[0], y[1] - o[1], y[2] - o[2]];
          const cr = [
            u[1] * w[2] - u[2] * w[1],
            u[2] * w[0] - u[0] * w[2],
            u[0] * w[1] - u[1] * w[0],
          ];
          if (!(cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] > 0))
            editFail('degenerate', `the cut leaves face ${f} (a concave or folded quad)`);
        }
      }
      for (let k = 0; k <= cuts; k++) {
        const t0 = k / (cuts + 1),
          t1 = (k + 1) / (cuts + 1);
        b.faces.push({
          vertices: [P[k], P[k + 1], S[k + 1], S[k]],
          uvs: uv
            ? [
                ...lerpUv(uv, rot[0], rot[1], t0),
                ...lerpUv(uv, rot[0], rot[1], t1),
                ...lerpUv(uv, rot[3], rot[2], t1),
                ...lerpUv(uv, rot[3], rot[2], t0),
              ]
            : null,
          material: mesh.faceMaterials[f],
        });
      }
      continue;
    }
    // Other faces: insert the new vertices on any split edge.
    const out: number[] = [];
    const outUv: number[] = [];
    for (let k = 0; k < vs.length; k++) {
      const j = (k + 1) % vs.length;
      out.push(vs[k]);
      if (uv) outUv.push(uv[2 * k], uv[2 * k + 1]);
      if (!split.has(edgeKey(vs[k], vs[j]))) continue;
      const pts = along(vs[k], vs[j]);
      pts.forEach((v, i) => {
        out.push(v);
        if (uv) outUv.push(...lerpUv(uv, k, j, (i + 1) / (cuts + 1)));
      });
    }
    b.faces.push({ vertices: out, uvs: uv ? outUv : null, material: mesh.faceMaterials[f] });
  }
  for (const [key, pts] of split) {
    const w = b.creases.get(key);
    if (w === undefined) continue;
    b.creases.delete(key);
    const [lo, hi] = edgeOfKey(key);
    const chain = [lo, ...pts, hi];
    for (let k = 0; k + 1 < chain.length; k++) b.creases.set(edgeKey(chain[k], chain[k + 1]), w);
  }
  return b.finish(limits);
}

/**
 * Bevels edges with one segment. Each face corner next to a bevelled edge moves `width` (mm)
 * along its other edge (both edges when both are bevelled), a quad fills each bevelled edge and
 * a polygon closes each corner. Refuses border edges, edges ending at a border vertex, and a
 * width that reaches past the end of an edge.
 */
export function bevelEdges(
  input: EditInput,
  edges: readonly MeshEdge[],
  width: number,
  limits?: EpmLimits,
): EpmMesh {
  const { mesh, topology: t } = input;
  if (!(width > 0 && Number.isFinite(width))) editFail('selection', 'width must be above 0');
  if (edges.length === 0) editFail('selection', 'no edges selected');
  const selected = new Set<number>();
  const ends = new Set<number>();
  for (const e of edges) {
    const h = edgeHalf(input, e);
    if (t.twin[h] < 0) editFail('selection', `${e[0]}-${e[1]} is a border edge`);
    const key = edgeKey(e[0], e[1]);
    if (selected.has(key)) editFail('selection', `edge ${e[0]}-${e[1]} is selected twice`);
    selected.add(key);
    for (const v of e) {
      if (!interiorVertex(t, v)) editFail('selection', `vertex ${v} is on a border`);
      ends.add(v);
    }
  }
  const b = new MeshBuilder(input);
  const isSel = (a: number, c: number) => selected.has(edgeKey(a, c));
  // Pass 1: the unselected edges at a bevelled vertex that get a point `width` along them.
  const along = new Map<string, number>();
  const used = new Map<number, number>(); // edgeKey → length used from both ends
  const want = (u: number, x: number) => {
    const id = `${u}>${x}`;
    if (along.has(id)) return;
    along.set(id, -1);
    used.set(edgeKey(u, x), (used.get(edgeKey(u, x)) ?? 0) + width);
  };
  for (let f = 0; f < mesh.faceSizes.length; f++) {
    const vs = faceVertices(mesh, t, f);
    vs.forEach((u, k) => {
      if (!ends.has(u)) return;
      const a = vs[(k + vs.length - 1) % vs.length],
        c = vs[(k + 1) % vs.length];
      const si = isSel(a, u),
        so = isSel(u, c);
      if (si && !so) want(u, c);
      if (so && !si) want(u, a);
    });
  }
  for (const [key, w] of used) {
    const [x, y] = edgeOfKey(key);
    const p = b.position(x),
      q = b.position(y);
    if (w >= Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]))
      editFail('degenerate', `the width reaches past edge ${x}-${y}`);
  }
  const unit = (u: number, x: number): Vec3 => {
    const p = b.position(u),
      q = b.position(x);
    const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const l = Math.hypot(...d);
    return d.map((z) => z / l) as Vec3;
  };
  const length = (u: number, x: number) => {
    const p = b.position(u),
      q = b.position(x);
    return Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
  };
  const point = (u: number, x: number) => {
    const id = `${u}>${x}`;
    let v = along.get(id)!;
    if (v < 0) {
      const p = b.position(u),
        d = unit(u, x),
        s = width / length(u, x);
      v = b.addVertex(
        [p[0] + d[0] * width, p[1] + d[1] * width, p[2] + d[2] * width],
        [
          [u, 1 - s],
          [x, s],
        ],
      );
      along.set(id, v);
    }
    return v;
  };
  // Pass 2: each face's corners become chains; remember a face's points at each bevelled edge.
  const sideOf = new Map<string, number>(); // `${f}:${u}>${x}` → the point that face keeps at u
  const uvOf = new Map<number, [number, number]>();
  for (let f = 0; f < mesh.faceSizes.length; f++) {
    const vs = faceVertices(mesh, t, f);
    const uv = b.faceUvs(f);
    const n = vs.length;
    const out: number[] = [];
    const outUv: number[] = [];
    const put = (v: number, u: [number, number] | null) => {
      out.push(v);
      if (u) {
        outUv.push(u[0], u[1]);
        if (!uvOf.has(v)) uvOf.set(v, u);
      }
    };
    const cornerUv = (k: number): [number, number] | null =>
      uv ? [uv[2 * k], uv[2 * k + 1]] : null;
    const towardUv = (k: number, j: number, s: number): [number, number] | null =>
      uv
        ? [
            uv[2 * k] + (uv[2 * j] - uv[2 * k]) * s,
            uv[2 * k + 1] + (uv[2 * j + 1] - uv[2 * k + 1]) * s,
          ]
        : null;
    const corner = (k: number) => {
      const u = vs[k];
      if (!ends.has(u)) {
        put(u, cornerUv(k));
        return;
      }
      const ka = (k + n - 1) % n,
        kc = (k + 1) % n;
      const a = vs[ka],
        c = vs[kc];
      const si = isSel(a, u),
        so = isSel(u, c);
      if (si && so) {
        const p = b.position(u),
          da = unit(u, a),
          dc = unit(u, c);
        const sa = width / length(u, a),
          sc = width / length(u, c);
        if (sa + sc >= 1) editFail('degenerate', `the width reaches past the corner at ${u}`);
        const v = b.addVertex(
          [0, 1, 2].map((i) => p[i] + (da[i] + dc[i]) * width) as Vec3,
          [
            [u, 1 - sa - sc],
            [a, sa],
            [c, sc],
          ] as VertexBlend,
        );
        const cu = cornerUv(k);
        const au = towardUv(k, ka, sa),
          ccu = towardUv(k, kc, sc);
        put(v, cu && au && ccu ? [au[0] + ccu[0] - cu[0], au[1] + ccu[1] - cu[1]] : null);
        sideOf.set(`${f}:${u}>${c}`, v);
        sideOf.set(`${f}:${u}>${a}`, v);
      } else if (si) {
        const v = point(u, c);
        put(v, towardUv(k, kc, width / length(u, c)));
        sideOf.set(`${f}:${u}>${a}`, v);
      } else if (so) {
        const v = point(u, a);
        put(v, towardUv(k, ka, width / length(u, a)));
        sideOf.set(`${f}:${u}>${c}`, v);
      } else {
        const inA = along.has(`${u}>${a}`),
          inC = along.has(`${u}>${c}`);
        if (inA) put(point(u, a), towardUv(k, ka, width / length(u, a)));
        if (!(inA && inC)) put(u, cornerUv(k));
        if (inC) put(point(u, c), towardUv(k, kc, width / length(u, c)));
      }
    };
    const begin: number[] = [],
      end: number[] = [];
    for (let k = 0; k < n; k++) {
      begin.push(out.length);
      corner(k);
      end.push(out.length - 1);
    }
    // Offsets from the two ends of an edge must not meet or cross (the face would flip).
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      const p = b.position(out[end[k]]),
        q = b.position(out[begin[j]]);
      const o = b.position(vs[k]),
        r = b.position(vs[j]);
      let dot = 0;
      for (let i = 0; i < 3; i++) dot += (q[i] - p[i]) * (r[i] - o[i]);
      if (!(dot > 1e-9)) editFail('degenerate', `the width folds face ${f} over itself`);
    }
    b.faces.push({ vertices: out, uvs: uv ? outUv : null, material: mesh.faceMaterials[f] });
  }
  // A quad along each bevelled edge.
  for (const key of selected) {
    const [x, y] = edgeOfKey(key);
    const h1 =
      findHalfEdge(input, x, y) >= 0 ? findHalfEdge(input, x, y) : findHalfEdge(input, y, x);
    const u = mesh.faceIndices[h1],
      v = halfEdgeTo(mesh, t, h1);
    const f1 = t.halfEdgeFace[h1],
      f2 = t.halfEdgeFace[t.twin[h1]];
    const p1u = sideOf.get(`${f1}:${u}>${v}`)!,
      p1v = sideOf.get(`${f1}:${v}>${u}`)!,
      p2u = sideOf.get(`${f2}:${u}>${v}`)!,
      p2v = sideOf.get(`${f2}:${v}>${u}`)!;
    const quv = [p1v, p1u, p2u, p2v].map((q) => uvOf.get(q) ?? [0, 0]);
    b.faces.push({
      vertices: [p1v, p1u, p2u, p2v],
      uvs: mesh.uvs ? quv.flat() : null,
      material: mesh.faceMaterials[f1],
    });
    b.creases.delete(key);
  }
  // Creases on edges a point was put on move to the remaining piece.
  for (const [key, w] of [...b.creases]) {
    const [x, y] = edgeOfKey(key);
    const xi = along.get(`${x}>${y}`),
      yi = along.get(`${y}>${x}`);
    if (xi === undefined && yi === undefined) continue;
    b.creases.delete(key);
    b.creases.set(edgeKey(xi ?? x, yi ?? y), w);
  }
  // Close the hole left at each bevelled vertex.
  closeHoles(b, uvOf, !!mesh.uvs);
  return b.finish(limits);
}

/** Fills every border loop the builder's faces have that the input did not have. */
function closeHoles(b: MeshBuilder, uvOf: Map<number, [number, number]>, hasUvs: boolean) {
  const { mesh, topology: t } = b.input;
  const wasBorder = new Set<number>();
  for (let h = 0; h < mesh.faceIndices.length; h++)
    if (t.twin[h] < 0) wasBorder.add(edgeKey(mesh.faceIndices[h], halfEdgeTo(mesh, t, h)));
  const directed = new Map<string, number>(); // "a>b" → next vertex
  for (const f of b.faces)
    f.vertices.forEach((a, k) =>
      directed.set(`${a}>${f.vertices[(k + 1) % f.vertices.length]}`, 0),
    );
  const border = new Map<number, number>(); // a → b for half-edges with no twin
  // Each cap takes the material of a face around it (the face owning its first border edge).
  const borderMaterial = new Map<number, number>();
  for (const f of b.faces)
    f.vertices.forEach((a, k) => {
      const c = f.vertices[(k + 1) % f.vertices.length];
      if (directed.has(`${c}>${a}`)) return;
      if (
        a < mesh.positions.length / 3 &&
        c < mesh.positions.length / 3 &&
        wasBorder.has(edgeKey(a, c))
      )
        return;
      if (border.has(a)) editFail('non-manifold', `vertex ${a} would join two holes`);
      border.set(a, c);
      borderMaterial.set(a, f.material);
    });
  const seen = new Set<number>();
  for (const start of border.keys()) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    let v = start;
    while (!seen.has(v)) {
      seen.add(v);
      loop.push(v);
      const n = border.get(v);
      if (n === undefined) editFail('non-manifold', 'an open hole around a bevelled corner');
      v = n!;
    }
    if (v !== start || loop.length < 3) editFail('non-manifold', 'a hole that cannot be closed');
    const material = borderMaterial.get(start)!;
    loop.reverse();
    b.faces.push({
      vertices: loop,
      uvs: hasUvs ? loop.flatMap((x) => uvOf.get(x) ?? [0, 0]) : null,
      material,
    });
  }
}

/** A point on a face's outline for the knife: a corner vertex or a point on an edge. */
export type KnifePoint = { vertex: number } | { edge: MeshEdge; t: number };

/**
 * Cuts one face in two with a straight edge between two points on its outline. A point on an
 * edge (`t` 0–1 from `edge[0]`, exclusive) adds a vertex there, also in the face on the other
 * side. Refuses two points on the same edge or on neighbouring corners (already an edge).
 */
export function knifeFace(
  input: EditInput,
  face: number,
  from: KnifePoint,
  to: KnifePoint,
  limits?: EpmLimits,
): EpmMesh {
  const { mesh, topology: t } = input;
  checkSelection([face], mesh.faceSizes.length, 'face');
  const vs = faceVertices(mesh, t, face);
  const n = vs.length;
  // Each point as a position along the outline: corner k, or k + t on the edge k→k+1.
  const locate = (p: KnifePoint): { at: number; edge?: number; t?: number } => {
    if ('vertex' in p) {
      const k = vs.indexOf(p.vertex);
      if (k < 0) editFail('selection', `vertex ${p.vertex} is not on face ${face}`);
      return { at: k };
    }
    if (!(p.t > 0 && p.t < 1)) editFail('selection', 'a knife point must be inside its edge');
    const [a, c] = p.edge;
    for (let k = 0; k < n; k++) {
      if (vs[k] === a && vs[(k + 1) % n] === c) return { at: k + p.t, edge: k, t: p.t };
      if (vs[k] === c && vs[(k + 1) % n] === a) return { at: k + 1 - p.t, edge: k, t: 1 - p.t };
    }
    return editFail('selection', `${a}-${c} is not an edge of face ${face}`);
  };
  const A = locate(from),
    B = locate(to);
  if (A.edge !== undefined && A.edge === B.edge) editFail('selection', 'both points on one edge');
  const [lo, hi] = A.at < B.at ? [A, B] : [B, A];
  const gap = (x: number, y: number) => {
    const d = Math.abs(x - y);
    return Math.min(d, n - d);
  };
  if (lo.edge === undefined && hi.edge === undefined && gap(lo.at, hi.at) <= 1)
    editFail('selection', 'the corners are already joined by an edge');
  if (lo.at === hi.at) editFail('selection', 'the points are the same');
  const b = new MeshBuilder(input);
  const uv = b.faceUvs(face);
  const splitAt = new Map<number, { v: number; t: number }>(); // edge key → new vertex
  const pointVertex = (p: typeof A) => {
    if (p.edge === undefined) return vs[p.at];
    const k = p.edge,
      j = (k + 1) % n;
    const x = b.position(vs[k]),
      y = b.position(vs[j]);
    const v = b.addVertex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * p.t!) as Vec3, [
      [vs[k], 1 - p.t!],
      [vs[j], p.t!],
    ]);
    splitAt.set(edgeKey(vs[k], vs[j]), { v, t: vs[k] < vs[j] ? p.t! : 1 - p.t! });
    return v;
  };
  const va = pointVertex(lo),
    vb = pointVertex(hi);
  // The outline as a cyclic list of [vertex, uv] with the new points in place.
  const ring: { v: number; uv: [number, number] | null; at: number }[] = [];
  for (let k = 0; k < n; k++) {
    ring.push({ v: vs[k], uv: uv ? [uv[2 * k], uv[2 * k + 1]] : null, at: k });
    for (const p of [lo, hi])
      if (p.edge === k) {
        const j = (k + 1) % n;
        ring.push({
          v: p === lo ? va : vb,
          uv: uv
            ? [
                uv[2 * k] + (uv[2 * j] - uv[2 * k]) * p.t!,
                uv[2 * k + 1] + (uv[2 * j + 1] - uv[2 * k + 1]) * p.t!,
              ]
            : null,
          at: p.at,
        });
      }
  }
  const ia = ring.findIndex((r) => r.v === va),
    ib = ring.findIndex((r) => r.v === vb);
  const piece = (from: number, to: number) => {
    const out: typeof ring = [];
    for (let k = from; ; k = (k + 1) % ring.length) {
      out.push(ring[k]);
      if (k === to) break;
    }
    return out;
  };
  const parts = [piece(ia, ib), piece(ib, ia)];
  if (parts.some((x) => x.length < 3)) editFail('selection', 'the cut runs along an edge');
  // The cut must stay inside the face: in the face's plane, it crosses no other edge, its
  // midpoint is inside, and both pieces keep the face's winding.
  {
    const nrm = faceNormal(mesh, t, face);
    const drop = [0, 1, 2].reduce((m, k) => (Math.abs(nrm[k]) > Math.abs(nrm[m]) ? k : m), 0);
    // Cyclic order keeps the projection's winding the same as the normal's.
    const i0 = (drop + 1) % 3,
      i1 = (drop + 2) % 3;
    const flat = (v: number): [number, number] => {
      const p = b.position(v);
      return [p[i0], p[i1]];
    };
    const sign = nrm[drop] > 0 ? 1 : -1;
    const area = (poly: [number, number][]) => {
      let a = 0;
      for (let k = 0; k < poly.length; k++) {
        const [x0, y0] = poly[k],
          [x1, y1] = poly[(k + 1) % poly.length];
        a += x0 * y1 - x1 * y0;
      }
      return (a / 2) * sign;
    };
    const outline = ring.map((r) => flat(r.v));
    const A2 = flat(va),
      B2 = flat(vb);
    for (let k = 0; k < ring.length; k++) {
      const j = (k + 1) % ring.length;
      if ([ring[k].v, ring[j].v].some((v) => v === va || v === vb)) continue;
      const p = outline[k],
        q = outline[j];
      if (segmentsTouch(A2, B2, p, q))
        editFail('selection', 'the cut leaves the face (it crosses another edge)');
    }
    const mid: [number, number] = [(A2[0] + B2[0]) / 2, (A2[1] + B2[1]) / 2];
    let inside = false;
    for (let k = 0, j = outline.length - 1; k < outline.length; j = k++) {
      const [xk, yk] = outline[k],
        [xj, yj] = outline[j];
      if (yk > mid[1] !== yj > mid[1] && mid[0] < ((xj - xk) * (mid[1] - yk)) / (yj - yk) + xk)
        inside = !inside;
    }
    if (!inside) editFail('selection', 'the cut leaves the face');
    if (parts.some((x) => !(area(x.map((r) => flat(r.v))) > 0)))
      editFail('selection', 'the cut leaves the face');
  }
  for (const part of parts)
    b.faces.push({
      vertices: part.map((r) => r.v),
      uvs: uv ? part.flatMap((r) => r.uv!) : null,
      material: mesh.faceMaterials[face],
    });
  // Neighbours across a cut edge gain the new vertex.
  for (let f = 0; f < mesh.faceSizes.length; f++) {
    if (f === face) continue;
    const ws = faceVertices(mesh, t, f);
    const fuv = b.faceUvs(f);
    const out: number[] = [];
    const outUv: number[] = [];
    for (let k = 0; k < ws.length; k++) {
      const j = (k + 1) % ws.length;
      out.push(ws[k]);
      if (fuv) outUv.push(fuv[2 * k], fuv[2 * k + 1]);
      const s = splitAt.get(edgeKey(ws[k], ws[j]));
      if (!s) continue;
      const tt = ws[k] < ws[j] ? s.t : 1 - s.t;
      out.push(s.v);
      if (fuv)
        outUv.push(
          fuv[2 * k] + (fuv[2 * j] - fuv[2 * k]) * tt,
          fuv[2 * k + 1] + (fuv[2 * j + 1] - fuv[2 * k + 1]) * tt,
        );
    }
    b.faces.push({ vertices: out, uvs: fuv ? outUv : null, material: mesh.faceMaterials[f] });
  }
  for (const [key, s] of splitAt) {
    const w = b.creases.get(key);
    if (w === undefined) continue;
    b.creases.delete(key);
    const [x, y] = edgeOfKey(key);
    b.creases.set(edgeKey(x, s.v), w);
    b.creases.set(edgeKey(s.v, y), w);
  }
  return b.finish(limits);
}

type P2 = [number, number];
const cross2 = (o: P2, p: P2, q: P2) =>
  (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
/** Whether closed segments ab and pq share a point (collinear ones only when they overlap). */
function segmentsTouch(a: P2, b: P2, p: P2, q: P2): boolean {
  const scale = Math.max(
    1e-12,
    Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(q[0] - p[0], q[1] - p[1]),
  );
  const eps = 1e-9 * scale;
  const sgn = (x: number) => (x > eps ? 1 : x < -eps ? -1 : 0);
  const d1 = sgn(cross2(a, b, p)),
    d2 = sgn(cross2(a, b, q)),
    d3 = sgn(cross2(p, q, a)),
    d4 = sgn(cross2(p, q, b));
  const within = (o: P2, x: P2, y: P2) =>
    Math.min(o[0], y[0]) <= x[0] + 1e-12 &&
    x[0] <= Math.max(o[0], y[0]) + 1e-12 &&
    Math.min(o[1], y[1]) <= x[1] + 1e-12 &&
    x[1] <= Math.max(o[1], y[1]) + 1e-12;
  if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  if (d1 === 0 && within(a, p, b)) return true;
  if (d2 === 0 && within(a, q, b)) return true;
  if (d3 === 0 && within(p, a, q)) return true;
  if (d4 === 0 && within(p, b, q)) return true;
  return false;
}

/**
 * Pairs each vertex with its mirror image across the plane `axis = 0` (within `tolerance` mm).
 * Vertices on the plane pair with themselves. A pair is kept only when each vertex's nearest
 * image is the other, so the table is one-to-one; every other vertex is listed in `unmatched`.
 */
export function mirrorVertices(
  input: EditInput,
  axis: 0 | 1 | 2,
  tolerance = 1e-3,
): { mirror: Int32Array; unmatched: number[] } {
  if (![0, 1, 2].includes(axis)) editFail('selection', 'axis');
  if (!(tolerance > 0 && Number.isFinite(tolerance))) editFail('selection', 'tolerance');
  const p = input.mesh.positions;
  const count = p.length / 3;
  const cell = (x: number) => Math.round(x / tolerance);
  const grid = new Map<string, number[]>();
  for (let v = 0; v < count; v++) {
    const key = `${cell(p[3 * v])},${cell(p[3 * v + 1])},${cell(p[3 * v + 2])}`;
    (grid.get(key) ?? grid.set(key, []).get(key)!).push(v);
  }
  const mirror = new Int32Array(count).fill(-1);
  const unmatched: number[] = [];
  for (let v = 0; v < count; v++) {
    const q = [p[3 * v], p[3 * v + 1], p[3 * v + 2]];
    if (Math.abs(q[axis]) <= tolerance) {
      mirror[v] = v;
      continue;
    }
    q[axis] = -q[axis];
    const c = q.map(cell);
    let best = -1,
      dist = tolerance;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const u of grid.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`) ?? []) {
            const d = Math.hypot(p[3 * u] - q[0], p[3 * u + 1] - q[1], p[3 * u + 2] - q[2]);
            if (d <= dist) {
              dist = d;
              best = u;
            }
          }
    mirror[v] = best;
  }
  // Keep only pairs that choose each other, so the table is one-to-one and its own inverse.
  for (let v = 0; v < count; v++) {
    const u = mirror[v];
    if (u >= 0 && u !== v && mirror[u] !== v) mirror[v] = -2;
  }
  for (let v = 0; v < count; v++)
    if (mirror[v] < 0) {
      mirror[v] = -1;
      unmatched.push(v);
    }
  return { mirror, unmatched };
}

/** The selection with every vertex's mirror image added (on-plane vertices once). */
export function mirroredVertexSelection(mirror: Int32Array, vertices: readonly number[]) {
  const out = new Set(vertices);
  for (const v of vertices) if (mirror[v] >= 0) out.add(mirror[v]);
  return [...out];
}
/** The selection with every face's mirror image added, where the image is a face. */
export function mirroredFaceSelection(
  input: EditInput,
  mirror: Int32Array,
  faces: readonly number[],
) {
  const { mesh, topology: t } = input;
  const byVerts = new Map<string, number>();
  for (let f = 0; f < mesh.faceSizes.length; f++)
    byVerts.set(
      faceVertices(mesh, t, f)
        .sort((a, b) => a - b)
        .join(','),
      f,
    );
  const out = new Set(faces);
  for (const f of faces) {
    const img = faceVertices(mesh, t, f).map((v) => mirror[v]);
    if (img.some((v) => v < 0)) continue;
    const g = byVerts.get(img.sort((a, b) => a - b).join(','));
    if (g !== undefined) out.add(g);
  }
  return [...out];
}

/**
 * Moves vertices by `delta` with symmetry: each vertex's mirror image moves by the reflected
 * delta, and vertices on the plane stay on it.
 */
export function translateSymmetric(
  input: EditInput,
  mirror: Int32Array,
  axis: 0 | 1 | 2,
  vertices: readonly number[],
  delta: Vec3,
  limits?: EpmLimits,
): EpmMesh {
  const chosen = checkSelection(vertices, input.topology.vertexCount, 'vertex');
  if (delta.length !== 3 || !delta.every(Number.isFinite)) editFail('selection', 'delta');
  if (mirror.length !== input.topology.vertexCount) editFail('selection', 'mirror table');
  const b = new MeshBuilder(input);
  b.copyFaces();
  const moves = new Map<number, Vec3>();
  for (const v of chosen) {
    moves.set(v, delta);
    const m = mirror[v];
    if (m >= 0 && m !== v && !chosen.has(m)) {
      const r = delta.slice() as Vec3;
      r[axis] = -r[axis];
      moves.set(m, r);
    }
  }
  for (const [v, d] of moves) {
    const p = b.position(v);
    const q: Vec3 = [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
    if (mirror[v] === v) q[axis] = p[axis];
    b.setPosition(v, q);
  }
  return b.finish(limits);
}
