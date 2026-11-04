import {
  bevelEdges,
  deleteFaces,
  edgeKey,
  edgeLoop,
  edgeOfKey,
  edgeRing,
  editInput,
  extrudeFaces,
  faceVertices,
  halfEdgeTo,
  insetFaces,
  knifeFace,
  loopCut,
  meshEdges,
  MeshEditError,
  mergeVertexGroups,
  mergeVertices,
  mirroredFaceSelection,
  mirroredVertexSelection,
  mirrorVertices,
  setEdgeCreases,
  translateSymmetric,
  translateVertices,
  triangulateFace,
  unwrapMesh,
  uvDistortion,
  uvSeams,
  type EditInput,
  type EpmMesh,
  type KnifePoint,
} from '@editor-platform/geometry-mesh';

/** Which elements a click picks in mesh edit mode (C3e). */
export type MeshSelectMode = 'vertex' | 'edge' | 'face';
/** The picked elements: vertex indices, `edgeKey`s, or face indices of the shown cage. */
export interface MeshSelection {
  mode: MeshSelectMode;
  items: number[];
}
export const emptySelection = (mode: MeshSelectMode): MeshSelection => ({ mode, items: [] });

/** The vertices a selection moves. */
export function selectedVertices(input: EditInput, sel: MeshSelection): number[] {
  if (sel.mode === 'vertex') return sel.items.slice();
  const out = new Set<number>();
  if (sel.mode === 'edge') for (const k of sel.items) for (const v of edgeOfKey(k)) out.add(v);
  else
    for (const f of sel.items)
      for (const v of faceVertices(input.mesh, input.topology, f)) out.add(v);
  return [...out];
}
/** Every element of the mode. */
export function selectAll(input: EditInput, mode: MeshSelectMode): MeshSelection {
  const { mesh, topology: t } = input;
  if (mode === 'vertex') {
    const used = new Set(mesh.faceIndices);
    return { mode, items: [...used].sort((a, b) => a - b) };
  }
  if (mode === 'edge') return { mode, items: meshEdges(mesh, t) };
  return { mode, items: [...Array(mesh.faceSizes.length).keys()] };
}
/** Keeps a selection that still fits the cage (after an edit or Undo the indices may not). */
export function liveSelection(mesh: EpmMesh, sel: MeshSelection, input?: EditInput): MeshSelection {
  const vertices = mesh.positions.length / 3;
  if (sel.mode === 'vertex') return { ...sel, items: sel.items.filter((v) => v < vertices) };
  if (sel.mode === 'face')
    return { ...sel, items: sel.items.filter((f) => f < mesh.faceSizes.length) };
  if (!input) return { ...sel, items: [] };
  const edges = new Set(meshEdges(mesh, input.topology));
  return { ...sel, items: sel.items.filter((k) => edges.has(k)) };
}

/** A projected point: canvas pixels, and depth (smaller is nearer). */
export type Projected = [number, number, number];

/**
 * The element under a click, with every element counted (X-ray): the nearest vertex or edge
 * within `radius` pixels, or the nearest face whose outline contains the point.
 */
export function pickElement(
  input: EditInput,
  mode: MeshSelectMode,
  screen: readonly Projected[],
  x: number,
  y: number,
  radius = 10,
): number | undefined {
  const { mesh, topology: t } = input;
  if (mode === 'vertex') {
    let best: number | undefined,
      dist = radius;
    const used = new Set(mesh.faceIndices);
    for (const v of used) {
      const p = screen[v]!;
      if (!(p[2] > -1 && p[2] < 1)) continue;
      const d = Math.hypot(p[0] - x, p[1] - y);
      if (
        d < dist - 1e-6 ||
        (Math.abs(d - dist) <= 1e-6 && best !== undefined && p[2] < screen[best]![2])
      ) {
        dist = d;
        best = v;
      }
    }
    return best;
  }
  if (mode === 'edge') {
    let best: number | undefined,
      dist = radius,
      bestDepth = Infinity;
    for (const k of meshEdges(mesh, t)) {
      const [a, b] = edgeOfKey(k).map((v) => screen[v]!);
      if (!(a[2] > -1 && a[2] < 1 && b[2] > -1 && b[2] < 1)) continue;
      const [d, t] = segmentDistance(a, b, x, y);
      // The edge's depth at its point nearest the click, not its endpoints' mean.
      const z = a[2] + t * (b[2] - a[2]);
      // Edges drawn over one another: the nearer one wins.
      if (d < dist - 1e-6 || (Math.abs(d - dist) <= 1e-6 && z < bestDepth)) {
        dist = d;
        best = k;
        bestDepth = z;
      }
    }
    return best;
  }
  let best: number | undefined,
    depth = Infinity;
  for (let f = 0; f < mesh.faceSizes.length; f++) {
    const vs = faceVertices(mesh, t, f);
    const pts = vs.map((v) => screen[v]!);
    if (pts.some((p) => !(p[2] > -1 && p[2] < 1))) continue;
    if (!inside(pts, x, y)) continue;
    const z = depthAt(pts, triangulateFace(mesh, t.faceStart[f]!, pts.length), x, y);
    if (z < depth) {
      depth = z;
      best = f;
    }
  }
  return best;
}
/**
 * The face's depth under the point: interpolated in the triangle that holds it, of the same
 * triangulation the view draws (`triangulateFace`, local corner indices), so a bent face is
 * picked by the surface that is on screen.
 */
function depthAt(pts: Projected[], tris: readonly number[], x: number, y: number) {
  for (let i = 0; i + 2 < tris.length; i += 3) {
    const a = pts[tris[i]!]!,
      b = pts[tris[i + 1]!]!,
      c = pts[tris[i + 2]!]!;
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(d) < 1e-12) continue;
    const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
    const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
    const w = 1 - u - v;
    if (u >= -1e-9 && v >= -1e-9 && w >= -1e-9) return u * a[2] + v * b[2] + w * c[2];
  }
  return pts.reduce((s, p) => s + p[2], 0) / pts.length;
}
function segmentDistance(a: Projected, b: Projected, x: number, y: number) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const l = dx * dx + dy * dy;
  const s = l > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l)) : 0;
  return [Math.hypot(a[0] + s * dx - x, a[1] + s * dy - y), s] as const;
}
function inside(pts: Projected[], x: number, y: number) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!,
      [xj, yj] = pts[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Adds, removes (when already chosen) or replaces with one element. */
export function toggle(sel: MeshSelection, item: number, additive: boolean): MeshSelection {
  if (!additive) return { ...sel, items: [item] };
  return sel.items.includes(item)
    ? { ...sel, items: sel.items.filter((x) => x !== item) }
    : { ...sel, items: [...sel.items, item] };
}

/** Line pairs for the cage's edges, the selected edges, the selected faces' triangles. */
export function overlayGeometry(input: EditInput, sel: MeshSelection) {
  const { mesh, topology: t } = input;
  const p = mesh.positions;
  const edges = meshEdges(mesh, t);
  const lines = new Float32Array(edges.length * 6);
  edges.forEach((k, i) => {
    const [a, b] = edgeOfKey(k);
    lines.set(p.subarray(3 * a, 3 * a + 3), 6 * i);
    lines.set(p.subarray(3 * b, 3 * b + 3), 6 * i + 3);
  });
  const chosenVertices = new Set(sel.mode === 'vertex' ? sel.items : []);
  const chosenEdges = new Set(sel.mode === 'edge' ? sel.items : []);
  if (sel.mode === 'vertex')
    for (const k of edges) {
      const [a, b] = edgeOfKey(k);
      if (chosenVertices.has(a) && chosenVertices.has(b)) chosenEdges.add(k);
    }
  if (sel.mode === 'face')
    for (const f of sel.items) {
      const vs = faceVertices(mesh, t, f);
      vs.forEach((v, i) => chosenEdges.add(edgeKey(v, vs[(i + 1) % vs.length]!)));
    }
  const seams = uvSeams(input);
  const seamLines = new Float32Array(seams.length * 6);
  seams.forEach((k, i) => {
    const [a, b] = edgeOfKey(k);
    seamLines.set(p.subarray(3 * a, 3 * a + 3), 6 * i);
    seamLines.set(p.subarray(3 * b, 3 * b + 3), 6 * i + 3);
  });
  const selectedLines = new Float32Array(chosenEdges.size * 6);
  [...chosenEdges].forEach((k, i) => {
    const [a, b] = edgeOfKey(k);
    selectedLines.set(p.subarray(3 * a, 3 * a + 3), 6 * i);
    selectedLines.set(p.subarray(3 * b, 3 * b + 3), 6 * i + 3);
  });
  const used = [...new Set(mesh.faceIndices)];
  const points = new Float32Array(used.length * 3);
  const pointSelected = new Float32Array(used.length);
  used.forEach((v, i) => {
    points.set(p.subarray(3 * v, 3 * v + 3), 3 * i);
    pointSelected[i] = chosenVertices.has(v) ? 1 : 0;
  });
  const tris: number[] = [];
  if (sel.mode === 'face')
    for (const f of sel.items) {
      const s = t.faceStart[f]!;
      for (const k of triangulateFace(mesh, s, t.faceSizes[f]!)) {
        const v = mesh.faceIndices[s + k]!;
        tris.push(p[3 * v]!, p[3 * v + 1]!, p[3 * v + 2]!);
      }
    }
  return {
    lines,
    seamLines,
    selectedLines,
    points,
    pointSelected,
    selectedTriangles: new Float32Array(tris),
  };
}

/** A mesh operation the Inspector offers, with its values. */
export type MeshOperation =
  | { kind: 'move'; delta: [number, number, number] }
  | { kind: 'extrude'; distance: number }
  | { kind: 'inset'; amount: number }
  | { kind: 'delete' }
  | { kind: 'merge' }
  | { kind: 'loopCut'; cuts: number }
  | { kind: 'bevel'; width: number }
  | { kind: 'crease'; value: number }
  /** C4: UVs again from the seams the UVs have (`uvSeams`). */
  | { kind: 'unwrap' }
  /** C4: the selected edges become seams (or stop being seams), and the UVs are made again. */
  | { kind: 'markSeam' }
  | { kind: 'clearSeam' };

/** Which operations a selection allows, with why not (shown as the button's reason). */
export function operationReason(sel: MeshSelection, op: MeshOperation['kind']): string | undefined {
  if (op === 'unwrap') return undefined;
  if (!sel.items.length) return 'Select something first.';
  if (['markSeam', 'clearSeam'].includes(op) && sel.mode !== 'edge') return 'Select edges.';
  if (['extrude', 'inset', 'delete'].includes(op) && sel.mode !== 'face') return 'Select faces.';
  if (['loopCut', 'bevel', 'crease'].includes(op) && sel.mode !== 'edge') return 'Select edges.';
  if (op === 'loopCut' && sel.items.length !== 1) return 'Select one edge.';
  if (op === 'merge' && sel.mode !== 'vertex') return 'Select vertices.';
  if (op === 'merge' && sel.items.length < 2) return 'Select two vertices or more.';
  return undefined;
}

/**
 * Runs one operation on the cage. With `symmetry`, the selection is mirrored across x = 0
 * first, and a move reflects onto the other side. Refusals are `MeshEditError`s. The returned
 * selection is what to keep selected: the moved elements, the new caps of an extrusion or the
 * inner faces of an inset (so the next extrusion continues from them), else nothing.
 */
export function runMeshOperation(
  input: EditInput,
  sel: MeshSelection,
  op: MeshOperation,
  symmetry: boolean,
): { mesh: EpmMesh; selection: MeshSelection } {
  const why = operationReason(sel, op.kind);
  if (why) throw new MeshEditError('selection', why);
  const mirror = symmetry ? mirrorVertices(input, 0).mirror : undefined;
  const faces =
    sel.mode === 'face'
      ? mirror
        ? mirroredFaceSelection(input, mirror, sel.items)
        : sel.items.slice()
      : [];
  const mesh = applyOperation(input, sel, op, mirror, faces);
  const faceCount = input.mesh.faceSizes.length;
  // A move keeps every index unless the cage had unused vertices (dropped, so indices shift).
  if (op.kind === 'move')
    return {
      mesh,
      selection:
        mesh.positions.length === input.mesh.positions.length ? sel : emptySelection(sel.mode),
    };
  // Unwrapping changes only UVs: every index still means the same element.
  if (op.kind === 'unwrap' || op.kind === 'markSeam' || op.kind === 'clearSeam')
    return { mesh, selection: sel };
  if (op.kind === 'extrude' || op.kind === 'inset') {
    // Both edits keep the other faces in order and append the new ones (see geometry-mesh).
    const base = faceCount - faces.length;
    const items: number[] = [];
    if (op.kind === 'extrude') for (let i = 0; i < faces.length; i++) items.push(base + i);
    else {
      let at = base;
      for (const f of faces) {
        at += input.topology.faceSizes[f]!;
        items.push(at);
        at++;
      }
    }
    return { mesh, selection: { mode: 'face', items } };
  }
  return { mesh, selection: emptySelection(sel.mode) };
}

function applyOperation(
  input: EditInput,
  sel: MeshSelection,
  op: MeshOperation,
  mirror: Int32Array | undefined,
  faces: number[],
): EpmMesh {
  const edges = () =>
    sel.items
      .map((k) => edgeOfKey(k) as [number, number])
      .flatMap((e) => {
        if (!mirror) return [e];
        const m = [mirror[e[0]]!, mirror[e[1]]!] as [number, number];
        return m[0] >= 0 && m[1] >= 0 && edgeKey(...m) !== edgeKey(...e) ? [e, m] : [e];
      });
  switch (op.kind) {
    case 'move': {
      const vs = selectedVertices(input, sel);
      return mirror
        ? translateSymmetric(input, mirror, 0, vs, op.delta)
        : translateVertices(input, vs, op.delta);
    }
    case 'extrude':
      return extrudeFaces(input, faces, op.distance);
    case 'inset':
      return insetFaces(input, faces, op.amount);
    case 'delete':
      return deleteFaces(input, faces);
    case 'merge': {
      if (!mirror) return mergeVertices(input, sel.items);
      // A selection that is its own mirror image merges once, onto the plane. Otherwise each
      // side merges on its own; a selection that is partly its own image has no such split.
      const side = new Set(sel.items);
      const other = mirroredVertexSelection(mirror, sel.items).filter((v) => !side.has(v));
      if (!other.length) return mergeVertices(input, sel.items);
      if (sel.items.some((v) => mirror[v]! >= 0 && side.has(mirror[v]!)))
        throw new MeshEditError(
          'selection',
          'Merge with mirroring needs the selection on one side of the plane.',
        );
      // Both sides merge in one edit, so stitching two halves is checked as a whole.
      return other.length < 2
        ? mergeVertices(input, sel.items)
        : mergeVertexGroups(input, [sel.items, other]);
    }
    case 'loopCut': {
      const e = edgeOfKey(sel.items[0]!);
      const cut = loopCut(input, e, op.cuts);
      // The mirrored edge's ring is cut too, unless it is the same ring. The cut keeps every
      // edge outside the ring and the order of the vertices, but drops vertices no face uses:
      // the mirrored edge's vertices are renumbered by their rank among the used ones.
      const m = mirror ? ([mirror[e[0]]!, mirror[e[1]]!] as [number, number]) : undefined;
      if (!m || m[0] < 0 || m[1] < 0) return cut;
      const ring = new Set(edgeRing(input, e).edges.map(([a, b]) => edgeKey(a, b)));
      if (ring.has(edgeKey(...m))) return cut;
      const used = new Uint8Array(input.mesh.positions.length / 3);
      for (const v of input.mesh.faceIndices) used[v] = 1;
      const rank = (v: number) => {
        let r = 0;
        for (let i = 0; i < v; i++) r += used[i]!;
        return r;
      };
      return loopCut(editInput(cut), [rank(m[0]), rank(m[1])], op.cuts);
    }
    case 'bevel':
      return bevelEdges(input, dedupe(edges()), op.width);
    case 'crease':
      return setEdgeCreases(input, dedupe(edges()), op.value);
    case 'unwrap':
      return unwrapMesh(input, uvSeams(input));
    case 'markSeam':
    case 'clearSeam': {
      const chosen = new Set(edges().map((e) => edgeKey(...e)));
      const seams = new Set(uvSeams(input));
      for (const k of chosen)
        if (op.kind === 'markSeam') seams.add(k);
        else seams.delete(k);
      return unwrapMesh(input, seams);
    }
  }
}
const dedupe = (edges: [number, number][]) => {
  const seen = new Set<number>();
  return edges.filter((e) => {
    const k = edgeKey(...e);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** The edge loop through the first selected edge, as a selection. */
export function selectLoop(input: EditInput, sel: MeshSelection): MeshSelection {
  if (sel.mode !== 'edge' || !sel.items.length) return sel;
  const loop = edgeLoop(input, edgeOfKey(sel.items[0]!));
  return { mode: 'edge', items: dedupeKeys(loop.map(([a, b]) => edgeKey(a, b))) };
}
const dedupeKeys = (k: number[]) => [...new Set(k)];

/** The edit input for a cage, or why it cannot be edited (past the limits, not manifold). */
export function cageInput(mesh: EpmMesh): { input?: EditInput; problem?: string } {
  try {
    return { input: editInput(mesh) };
  } catch (e) {
    if (e instanceof MeshEditError) return { problem: e.message };
    throw e;
  }
}

/** The mean of the vertices a selection moves (the move gizmo's centre), in cage space. */
export function selectionCenter(
  input: EditInput,
  sel: MeshSelection,
): [number, number, number] | undefined {
  const vs = selectedVertices(input, sel);
  if (!vs.length) return undefined;
  const p = input.mesh.positions;
  const c: [number, number, number] = [0, 0, 0];
  for (const v of vs) for (let d = 0; d < 3; d++) c[d] += p[3 * v + d]!;
  return [c[0] / vs.length, c[1] / vs.length, c[2] / vs.length];
}

/**
 * The cage's positions while a move is dragged (C3g): what the move would make, without making
 * a mesh. With symmetry a vertex's mirror image moves by the reflected delta and vertices on
 * x = 0 stay on it, as `translateSymmetric` does.
 */
export function previewMove(
  input: EditInput,
  sel: MeshSelection,
  delta: readonly [number, number, number],
  mirror: Int32Array | undefined,
): Float32Array {
  const out = input.mesh.positions.slice();
  const chosen = new Set(selectedVertices(input, sel));
  const add = (v: number, d: readonly number[]) => {
    for (let k = 0; k < 3; k++) out[3 * v + k] = input.mesh.positions[3 * v + k]! + d[k]!;
    if (mirror && mirror[v] === v) out[3 * v] = input.mesh.positions[3 * v]!;
  };
  for (const v of chosen) {
    add(v, delta);
    const m = mirror?.[v] ?? -1;
    if (m >= 0 && m !== v && !chosen.has(m)) add(m, [-delta[0], delta[1], delta[2]]);
  }
  return out;
}

/**
 * C6b: a move of a morph's shape, as the cage's positions. Unlike `runMeshOperation`, it keeps
 * every vertex (unused ones too), so the positions match the cage one for one and become the
 * morph's deltas. Refusals are `MeshEditError`s.
 */
export function shapeMove(
  input: EditInput,
  sel: MeshSelection,
  delta: readonly [number, number, number],
  symmetry: boolean,
): Float32Array {
  const why = operationReason(sel, 'move');
  if (why) throw new MeshEditError('selection', why);
  if (delta.length !== 3 || !delta.every(Number.isFinite))
    throw new MeshEditError('selection', 'delta');
  return previewMove(input, sel, delta, symmetry ? cageMirror(input) : undefined);
}

/** The mirror table a symmetric edit uses (x = 0), for previews. */
export const cageMirror = (input: EditInput) => mirrorVertices(input, 0).mirror;

/** A knife point picked in the view (C3h): where it is on the outline, and on screen. */
export interface KnifePick {
  point: KnifePoint;
  /** Canvas pixels and depth of the point. */
  at: Projected;
}

/**
 * The knife point under a click: a cage vertex within `radius` pixels (preferred), else the
 * nearest point on an edge within `radius`. A point on an edge within 5% of a corner is that
 * corner, so a cut never makes a sliver edge by a near miss.
 *
 * The fraction along the edge is the mesh's, not the screen's: under a perspective view the
 * two differ when the edge's ends are at different depths. `project` (a cage-space point to
 * the view) finds it: the screen position moves monotonically along the edge, so a bisection
 * on the edge finds the point that projects under the click. Without it (an orthographic
 * view) the screen fraction is used.
 */
export function pickKnifePoint(
  input: EditInput,
  screen: readonly Projected[],
  x: number,
  y: number,
  radius = 10,
  project?: (point: readonly [number, number, number]) => Projected,
): KnifePick | undefined {
  const v = pickElement(input, 'vertex', screen, x, y, radius);
  if (v !== undefined) return { point: { vertex: v }, at: screen[v]! };
  const k = pickElement(input, 'edge', screen, x, y, radius);
  if (k === undefined) return undefined;
  const [a, b] = edgeOfKey(k) as [number, number];
  const pa = screen[a]!,
    pb = screen[b]!;
  const [, s] = segmentDistance(pa, pb, x, y);
  let t = s;
  if (project) {
    const p = input.mesh.positions;
    const point = (u: number) =>
      [0, 1, 2].map((d) => p[3 * a + d]! + u * (p[3 * b + d]! - p[3 * a + d]!)) as [
        number,
        number,
        number,
      ];
    // The screen fraction of a point on the edge, along the projected segment.
    const dx = pb[0] - pa[0],
      dy = pb[1] - pa[1];
    const l = dx * dx + dy * dy;
    const along = (u: number) => {
      const q = project(point(u));
      return l > 0 ? ((q[0] - pa[0]) * dx + (q[1] - pa[1]) * dy) / l : u;
    };
    let lo = 0,
      hi = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (along(mid) < s) lo = mid;
      else hi = mid;
    }
    t = (lo + hi) / 2;
  }
  if (t < 0.05) return { point: { vertex: a }, at: pa };
  if (t > 0.95) return { point: { vertex: b }, at: pb };
  const at: Projected = [
    pa[0] + s * (pb[0] - pa[0]),
    pa[1] + s * (pb[1] - pa[1]),
    pa[2] + s * (pb[2] - pa[2]),
  ];
  return { point: { edge: [a, b], t }, at };
}

const pointVertices = (p: KnifePoint) => ('vertex' in p ? [p.vertex] : [...p.edge]);
/** The faces whose outline holds a knife point. */
function facesOf(input: EditInput, p: KnifePoint): Set<number> {
  const { mesh, topology: t } = input;
  const out = new Set<number>();
  const want = pointVertices(p);
  for (let f = 0; f < mesh.faceSizes.length; f++) {
    const vs = faceVertices(mesh, t, f);
    if ('vertex' in p) {
      if (vs.includes(p.vertex)) out.add(f);
      continue;
    }
    const n = vs.length;
    for (let i = 0; i < n; i++) {
      const a = vs[i]!,
        b = vs[(i + 1) % n]!;
      if ((a === want[0] && b === want[1]) || (a === want[1] && b === want[0])) out.add(f);
    }
  }
  return out;
}

/**
 * Cuts the face that has both knife points on its outline (C3h). When two faces do (two
 * corners shared by both), the one nearer the camera (its corners' mean depth) is cut. Refuses
 * points with no face in common, and what `knifeFace` refuses (one edge, neighbouring corners).
 */
export function runKnife(
  input: EditInput,
  from: KnifePick,
  to: KnifePick,
  screen: readonly Projected[],
): EpmMesh {
  const a = facesOf(input, from.point);
  const shared = [...facesOf(input, to.point)].filter((f) => a.has(f));
  if (!shared.length) throw new MeshEditError('selection', 'The knife points are not on one face.');
  const { mesh, topology: t } = input;
  const depth = (f: number) => {
    const vs = faceVertices(mesh, t, f);
    return vs.reduce((s, v) => s + screen[v]![2], 0) / vs.length;
  };
  shared.sort((x, y) => depth(x) - depth(y));
  return knifeFace(input, shared[0]!, from.point, to.point);
}

/**
 * The cage's UV layout for the UV view (C4): each face's outline in UV space, how many islands
 * the seams make, and the largest angle distortion. Undefined without UVs.
 */
export function uvLayout(
  input: EditInput,
): { outlines: Float32Array[]; islands: number; conformal: number } | undefined {
  const { mesh, topology: t } = input;
  const uv = mesh.uvs;
  if (!uv) return undefined;
  const outlines: Float32Array[] = [];
  for (let f = 0; f < mesh.faceSizes.length; f++) {
    const s = t.faceStart[f]!,
      n = t.faceSizes[f]!;
    outlines.push(uv.slice(2 * s, 2 * (s + n)));
  }
  // Islands: faces joined across edges that are not seams.
  const seams = new Set(uvSeams(input));
  const parent = [...Array(mesh.faceSizes.length).keys()];
  // Iterative with path halving: a long strip makes a parent chain deeper than the stack.
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  for (let h = 0; h < mesh.faceIndices.length; h++) {
    const tw = t.twin[h]!;
    if (tw < h) continue;
    if (seams.has(edgeKey(mesh.faceIndices[h]!, halfEdgeTo(mesh, t, h)))) continue;
    parent[find(t.halfEdgeFace[h]!)] = find(t.halfEdgeFace[tw]!);
  }
  const islands = new Set(parent.map((_, i) => find(i))).size;
  return { outlines, islands, conformal: uvDistortion(mesh).conformal };
}
