import { triangulateFace } from './display';
import type { EpmMesh } from './epm';
import { editFail } from './topology';

/** A bone as a segment from its head to its tail, in the mesh's space (mm). */
export interface WeightBone {
  head: [number, number, number];
  tail: [number, number, number];
}

export const boneHeatLimits = Object.freeze({
  vertices: 200_000,
  bones: 512,
  /** Bones kept per vertex, the largest weights, normalized to sum 1. */
  influences: 4,
  iterations: 5_000,
});

/**
 * Automatic weights by bone heat (Baran & Popović 2007, without the visibility test): each bone
 * is a heat source for the vertices it is nearest to, and the weights are the heat at
 * equilibrium, (L + A H) w = A H p, with L the cotangent Laplacian, A the lumped vertex areas,
 * H = 1 / d² from a vertex to its nearest bone and p = 1 where that bone is the nearest. The
 * result keeps up to four bones per vertex (largest weights), normalized to sum 1; a vertex no
 * face uses goes to its nearest bone. `boneIds` name the bones in order.
 */
/** The phases of `boneHeatWeights` a measurement can time (C5e). */
export type BoneHeatPhase = 'nearest' | 'laplacian' | 'solve' | 'normalize';

export function boneHeatWeights(
  mesh: EpmMesh,
  bones: readonly WeightBone[],
  boneIds: readonly string[],
  onProgress?: (done: number, total: number) => void,
  /**
   * Measurement only (C5e): told how long each phase took, in ms. Without it nothing is timed
   * and the result is the same.
   */
  timing?: (phase: BoneHeatPhase, ms: number) => void,
): EpmMesh {
  const n = mesh.positions.length / 3;
  let lap = timing ? performance.now() : 0;
  const phase = (name: BoneHeatPhase) => {
    if (!timing) return;
    const now = performance.now();
    timing(name, now - lap);
    lap = now;
  };
  if (!bones.length) editFail('selection', 'there are no bones to weight');
  if (bones.length !== boneIds.length) editFail('selection', 'one ID per bone');
  if (bones.length > boneHeatLimits.bones)
    editFail('limit', `${bones.length} bones; the limit is ${boneHeatLimits.bones}`);
  if (n > boneHeatLimits.vertices)
    editFail('limit', `${n} vertices; the limit is ${boneHeatLimits.vertices}`);
  for (const b of bones)
    if (![...b.head, ...b.tail].every(Number.isFinite))
      editFail('degenerate', 'a bone is not finite');
  const p = mesh.positions;

  // Nearest bones per vertex (ties within 1e-4 share the source) and their distance.
  const nearest: number[][] = [];
  const dist = new Float64Array(n);
  // The floor follows the mesh's size, not where it is: moving mesh and bones together changes
  // nothing.
  let extent = 0;
  for (let k = 0; k < 3; k++) {
    let lo = Infinity,
      hi = -Infinity;
    for (let i = k; i < p.length; i += 3) {
      lo = Math.min(lo, p[i]!);
      hi = Math.max(hi, p[i]!);
    }
    if (hi >= lo) extent = Math.max(extent, hi - lo);
  }
  const floor = Math.max(extent, 1e-3) * 1e-6;
  for (let v = 0; v < n; v++) {
    const d = bones.map((b) => segmentDistance(p, v, b));
    const best = Math.min(...d);
    dist[v] = Math.max(best, floor);
    nearest.push(d.flatMap((x, k) => (x <= best * (1 + 1e-4) + floor ? [k] : [])));
  }

  phase('nearest');
  // The cotangent Laplacian (symmetric, as rows of neighbours) and the lumped areas.
  const rows = Array.from({ length: n }, () => new Map<number, number>());
  const area = new Float64Array(n);
  const used = new Uint8Array(n);
  let start = 0;
  for (let f = 0; f < mesh.faceSizes.length; f++) {
    const size = mesh.faceSizes[f]!;
    const tris = triangulateFace(mesh, start, size);
    for (let t = 0; t < tris.length; t += 3) {
      const ids = [0, 1, 2].map((k) => mesh.faceIndices[start + tris[t + k]!]!);
      const [a, b, c] = ids as [number, number, number];
      const doubled = crossLength(p, a, b, c);
      if (!(doubled > 1e-12)) continue;
      for (const v of ids) {
        area[v] = area[v]! + doubled / 6;
        used[v] = 1;
      }
      // Each edge gets half the cotangent of the angle opposite it.
      for (let k = 0; k < 3; k++) {
        const o = ids[k]!,
          i = ids[(k + 1) % 3]!,
          j = ids[(k + 2) % 3]!;
        const w = (0.5 * dotAt(p, o, i, j)) / doubled;
        rows[i]!.set(j, (rows[i]!.get(j) ?? 0) + w);
        rows[j]!.set(i, (rows[j]!.get(i) ?? 0) + w);
      }
    }
    start += size;
  }
  // CSR of M = L + A H: off-diagonal −w, diagonal Σw + A H.
  const ptr = new Int32Array(n + 1);
  for (let v = 0; v < n; v++) ptr[v + 1] = ptr[v]! + rows[v]!.size;
  const col = new Int32Array(ptr[n]!);
  const val = new Float64Array(ptr[n]!);
  const diag = new Float64Array(n);
  const heat = new Float64Array(n);
  for (let v = 0; v < n; v++) {
    let k = ptr[v]!;
    let sum = 0;
    for (const [j, w] of rows[v]!) {
      col[k] = j;
      val[k++] = -w;
      sum += w;
    }
    heat[v] = used[v] ? area[v]! / dist[v]! ** 2 : 1;
    diag[v] = sum + heat[v]!;
  }
  rows.length = 0;
  const multiply = (x: Float64Array, out: Float64Array) => {
    for (let v = 0; v < n; v++) {
      let s = diag[v]! * x[v]!;
      for (let k = ptr[v]!; k < ptr[v + 1]!; k++) s += val[k]! * x[col[k]!]!;
      out[v] = s;
    }
  };

  phase('laplacian');
  // One solve per bone that is nearest to some vertex; the others weigh nothing.
  const sources = new Set<number>();
  for (const list of nearest) for (const k of list) sources.add(k);
  const weights = new Map<number, Float64Array>();
  let done = 0;
  for (const bone of sources) {
    const b = new Float64Array(n);
    for (let v = 0; v < n; v++)
      if (nearest[v]!.includes(bone)) b[v] = heat[v]! / nearest[v]!.length;
    weights.set(bone, conjugateGradient(multiply, diag, b));
    onProgress?.(++done, sources.size);
  }

  phase('solve');
  // Keep the largest four per vertex, normalized; a vertex left with none goes to its nearest.
  const offsets = new Uint32Array(n + 1);
  const outBones: number[] = [];
  const outValues: number[] = [];
  for (let v = 0; v < n; v++) {
    let list: [number, number][] = [];
    if (used[v])
      for (const [bone, w] of weights) if (w[v]! > 1e-4) list.push([bone, Math.min(w[v]!, 1)]);
    list.sort((x, y) => y[1] - x[1] || x[0] - y[0]);
    list = list.slice(0, boneHeatLimits.influences);
    let total = list.reduce((s, x) => s + x[1], 0);
    if (!(total > 0)) {
      // Tied nearest bones share the vertex; still at most four of them.
      list = nearest[v]!.slice(0, boneHeatLimits.influences).map((k) => [k, 1]);
      total = list.length;
    }
    list.sort((x, y) => x[0] - y[0]);
    for (const [bone, w] of list) {
      outBones.push(bone);
      outValues.push(w / total);
    }
    offsets[v + 1] = outBones.length;
  }
  const out: EpmMesh = {
    ...mesh,
    boneIds: [...boneIds],
    weights: {
      offsets,
      bones: Uint16Array.from(outBones),
      values: Float32Array.from(outValues),
    },
  };
  phase('normalize');
  return out;
}

function conjugateGradient(
  multiply: (x: Float64Array, out: Float64Array) => void,
  diag: Float64Array,
  b: Float64Array,
): Float64Array {
  const n = b.length;
  // Start from the source itself (1 where the bone is nearest): close to the answer.
  const x = new Float64Array(n);
  for (let v = 0; v < n; v++) x[v] = b[v]! > 0 ? 1 : 0;
  const r = new Float64Array(n);
  multiply(x, r);
  for (let v = 0; v < n; v++) r[v] = b[v]! - r[v]!;
  const z = new Float64Array(n);
  for (let v = 0; v < n; v++) z[v] = r[v]! / diag[v]!;
  const d = z.slice();
  const Ad = new Float64Array(n);
  let rz = dot(r, z);
  // Converged when no vertex's weight would move by more than 1e-7 under a Jacobi step
  // (|r_v| / diag_v): a relative residual would let the strongly heated vertices (on a bone,
  // where 1/d² is huge) hide the error at the weakly heated ones.
  const settled = () => {
    for (let v = 0; v < n; v++) if (Math.abs(z[v]!) > 1e-7) return false;
    return true;
  };
  for (let it = 0; it < boneHeatLimits.iterations && !settled(); it++) {
    multiply(d, Ad);
    const alpha = rz / dot(d, Ad);
    if (!Number.isFinite(alpha)) break;
    for (let v = 0; v < n; v++) {
      x[v] = x[v]! + alpha * d[v]!;
      r[v] = r[v]! - alpha * Ad[v]!;
    }
    for (let v = 0; v < n; v++) z[v] = r[v]! / diag[v]!;
    const next = dot(r, z);
    const beta = next / rz;
    rz = next;
    for (let v = 0; v < n; v++) d[v] = z[v]! + beta * d[v]!;
  }
  return x;
}
const dot = (a: Float64Array, b: Float64Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};
/** Twice the area of triangle a, b, c. */
function crossLength(p: Float32Array, a: number, b: number, c: number) {
  const ux = p[3 * b]! - p[3 * a]!,
    uy = p[3 * b + 1]! - p[3 * a + 1]!,
    uz = p[3 * b + 2]! - p[3 * a + 2]!;
  const vx = p[3 * c]! - p[3 * a]!,
    vy = p[3 * c + 1]! - p[3 * a + 1]!,
    vz = p[3 * c + 2]! - p[3 * a + 2]!;
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}
/** (i − o) · (j − o). */
function dotAt(p: Float32Array, o: number, i: number, j: number) {
  let s = 0;
  for (let k = 0; k < 3; k++)
    s += (p[3 * i + k]! - p[3 * o + k]!) * (p[3 * j + k]! - p[3 * o + k]!);
  return s;
}
function segmentDistance(p: Float32Array, v: number, b: WeightBone) {
  const x = [p[3 * v]!, p[3 * v + 1]!, p[3 * v + 2]!];
  const d = [0, 1, 2].map((k) => b.tail[k]! - b.head[k]!);
  const len = d[0]! ** 2 + d[1]! ** 2 + d[2]! ** 2;
  let t = len > 0 ? [0, 1, 2].reduce((s, k) => s + (x[k]! - b.head[k]!) * d[k]!, 0) / len : 0;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(...[0, 1, 2].map((k) => x[k]! - (b.head[k]! + t * d[k]!)));
}

export type WeightBrushMode = 'add' | 'subtract' | 'smooth';

/**
 * One weight paint stroke (C5c) on bone `boneId`: `touched` maps vertices to how much the brush
 * reached them (0–1, falloff × strength). Add moves the weight toward 1 and subtract toward 0;
 * the other bones of the vertex are scaled so the weights still sum to 1 (a vertex's only bone
 * stays at 1: nothing else can take the weight). Smooth moves all of a vertex's weights toward
 * the mean of its neighbours' (so the sum stays 1). The largest four are kept. A bone no vertex
 * weights any more leaves `boneIds`.
 */
export function paintWeights(
  mesh: EpmMesh,
  boneId: string,
  touched: ReadonlyMap<number, number>,
  mode: WeightBrushMode,
): EpmMesh {
  const w = mesh.weights;
  if (!w) editFail('selection', 'the mesh has no weights: bind it first');
  const n = mesh.positions.length / 3;
  const lists: Map<string, number>[] = [];
  for (let v = 0; v < n; v++) {
    const m = new Map<string, number>();
    for (let k = w!.offsets[v]!; k < w!.offsets[v + 1]!; k++)
      m.set(mesh.boneIds[w!.bones[k]!]!, w!.values[k]!);
    lists.push(m);
  }
  let neighbours: Set<number>[] | undefined;
  if (mode === 'smooth') {
    neighbours = Array.from({ length: n }, () => new Set<number>());
    let start = 0;
    for (const size of mesh.faceSizes) {
      for (let k = 0; k < size; k++) {
        const a = mesh.faceIndices[start + k]!,
          b = mesh.faceIndices[start + ((k + 1) % size)]!;
        neighbours[a]!.add(b);
        neighbours[b]!.add(a);
      }
      start += size;
    }
  }
  const next = new Map<number, number>();
  const smoothed = new Map<number, Map<string, number>>();
  for (const [v, amount] of touched) {
    if (!(v >= 0 && v < n && Number.isInteger(v))) editFail('selection', `vertex ${v}`);
    const a = Math.min(1, Math.max(0, amount));
    if (!(a > 0)) continue;
    const old = lists[v]!.get(boneId) ?? 0;
    let t = old;
    if (mode === 'add') t = old + a * (1 - old);
    else if (mode === 'subtract') t = old * (1 - a);
    else {
      // Every bone of the vertex moves toward its neighbours' mean, read before this stroke.
      // Only weighted neighbours count: with none, the vertex keeps what it has.
      const around = [...neighbours![v]!].filter((u) => lists[u]!.size > 0);
      if (!around.length) continue;
      const mean = new Map<string, number>();
      for (const u of around)
        for (const [b, x] of lists[u]!) mean.set(b, (mean.get(b) ?? 0) + x / around.length);
      const out = new Map<string, number>();
      for (const b of new Set([...mean.keys(), ...lists[v]!.keys()])) {
        const own = lists[v]!.get(b) ?? 0;
        out.set(b, own + a * ((mean.get(b) ?? 0) - own));
      }
      smoothed.set(v, out);
      continue;
    }
    next.set(v, t);
  }
  const keep = (m: Map<string, number>) => {
    let list = [...m].filter(([, x]) => x > 1e-4);
    list.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
    list = list.slice(0, boneHeatLimits.influences);
    const total = list.reduce((s, [, x]) => s + x, 0);
    return new Map(list.map(([b, x]) => [b, x / total]));
  };
  for (const [v, m] of smoothed) lists[v] = keep(m);
  for (const [v, t] of next) {
    const m = lists[v]!;
    const old = m.get(boneId) ?? 0;
    // What the other bones actually hold (a saved vector may sum to just under 1).
    let rest = 0;
    for (const [b, x] of m) if (b !== boneId) rest += x;
    // The vertex's only bone stays at 1: nothing else can take the weight. Taking away what the
    // vertex does not have (an unweighted vertex, or another bone's) changes nothing.
    if ((rest <= 1e-9 && t < old) || (mode === 'subtract' && !(old > 0))) continue;
    const scale = rest > 1e-9 ? (1 - t) / rest : 0;
    for (const [b, x] of m) if (b !== boneId) m.set(b, x * scale);
    m.set(boneId, rest > 1e-9 ? t : 1);
    lists[v] = keep(m);
  }
  // Bones in their first order, then the painted one; only those some vertex weights.
  const order = [...mesh.boneIds];
  if (!order.includes(boneId)) order.push(boneId);
  const used = new Set<string>();
  for (const m of lists) for (const b of m.keys()) used.add(b);
  const boneIds = order.filter((b) => used.has(b));
  const index = new Map(boneIds.map((b, k) => [b, k]));
  const offsets = new Uint32Array(n + 1);
  const bones: number[] = [];
  const values: number[] = [];
  lists.forEach((m, v) => {
    for (const [b, x] of [...m].sort((p, q) => index.get(p[0])! - index.get(q[0])!)) {
      bones.push(index.get(b)!);
      values.push(x);
    }
    offsets[v + 1] = bones.length;
  });
  return {
    ...mesh,
    boneIds,
    weights: { offsets, bones: Uint16Array.from(bones), values: Float32Array.from(values) },
  };
}

/** The weight of `boneId` at each vertex (0 where it has none). */
export function boneWeightsOf(mesh: EpmMesh, boneId: string): Float32Array {
  const n = mesh.positions.length / 3;
  const out = new Float32Array(n);
  const w = mesh.weights;
  const b = mesh.boneIds.indexOf(boneId);
  if (!w || b < 0) return out;
  for (let v = 0; v < n; v++)
    for (let k = w.offsets[v]!; k < w.offsets[v + 1]!; k++)
      if (w.bones[k] === b) out[v] = w.values[k]!;
  return out;
}
