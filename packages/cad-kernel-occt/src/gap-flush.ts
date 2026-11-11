import { cadGapFlush, type CadGapFlushSample, type Vec3 } from '@editor-platform/cad-core';
import { surfaceProjector } from './continuity';
import type { OcModule } from './evaluator';

type V = Vec3;
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a: V) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V): V => scale(a, 1 / norm(a));
/** Points along an edge's curve, for its length and the nearest-point seeds. */
const dense = 512;

/** An edge's own curve (located) over its vertices' parameters; a closed one runs a period. */
export function edgeCurve(oc: OcModule, own: <T>(value: T) => T, edge: unknown) {
  const xyz = (p: { X(): number; Y(): number; Z(): number }): V => [p.X(), p.Y(), p.Z()];
  const curve = own(oc.BRep_Tool.Curve_2(edge, 0, 0)).get();
  const first = own(new oc.TopoDS_Vertex());
  const last = own(new oc.TopoDS_Vertex());
  oc.TopExp.Vertices_1(edge, first, last, false);
  let [t0, t1] = [first, last].map((v) => oc.BRep_Tool.Parameter_2(v, edge) as number) as [
    number,
    number,
  ];
  if (t1 < t0) [t0, t1] = [t1, t0];
  if (t1 === t0 && curve.IsPeriodic()) t1 = t0 + curve.Period();
  const P = own(new oc.gp_Pnt_1());
  const D1 = own(new oc.gp_Vec_1());
  const D2 = own(new oc.gp_Vec_1());
  const at = (t: number) => {
    curve.D2(t, P, D1, D2);
    return { p: xyz(P), d1: xyz(D1), d2: xyz(D2) };
  };
  const ts = Array.from({ length: dense + 1 }, (_, i) => t0 + ((t1 - t0) * i) / dense);
  const pts = ts.map((t) => at(t).p);
  // A closed edge (a circle's border): its parameter's seam is no end (Codex on #952).
  const closed = norm(sub(pts[0]!, pts[dense]!)) <= 1e-7;
  return { t0, t1, at, ts, pts, closed };
}

/**
 * CR3d: samples the gap and flush from border edge `a` (of face `faceA`) to border edge `b`, at
 * `cadGapFlush.samples` equal distances along `a`, both ends included. At each point the nearest
 * point on `b` is found (from the nearest of 513 points along it, then Newton steps on its
 * parameter, round the seam of a closed `b`); the offset between them is split along the face's normal (the flush) and, in the
 * face's tangent plane, across `a` (the gap). A point whose nearest point is an end of `b` with
 * the offset running along `b` lies beyond it and is left out. A code when `a` cannot be
 * projected onto its face or no point faces `b`.
 */
export function edgeGapFlush(
  oc: OcModule,
  own: <T>(value: T) => T,
  a: unknown,
  faceA: unknown,
  b: unknown,
): CadGapFlushSample[] | 'gap-flush-projection-failed' | 'gap-flush-apart' {
  const ca = edgeCurve(oc, own, a);
  const cb = edgeCurve(oc, own, b);
  const face = surfaceProjector(oc, own, faceA, a);
  // Equal distances along `a`: the parameter at each length, between the dense points.
  const lengths = [0];
  for (let i = 1; i < ca.pts.length; i++)
    lengths.push(lengths[i - 1]! + norm(sub(ca.pts[i]!, ca.pts[i - 1]!)));
  const total = lengths.at(-1)!;
  const n = cadGapFlush.samples;
  const samples: CadGapFlushSample[] = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = (total * i) / (n - 1);
    while (j < dense - 1 && lengths[j + 1]! < s) j++;
    const span = lengths[j + 1]! - lengths[j]!;
    const t = ca.ts[j]! + (span > 0 ? (s - lengths[j]!) / span : 0) * (ca.ts[j + 1]! - ca.ts[j]!);
    const { p, d1 } = ca.at(t);
    const onFace = face.project(p);
    if (!onFace) return 'gap-flush-projection-failed';
    // The nearest point on `b`.
    let k = 0;
    for (let m = 1; m < cb.pts.length; m++)
      if (norm(sub(cb.pts[m]!, p)) < norm(sub(cb.pts[k]!, p))) k = m;
    let u = cb.ts[k]!;
    for (let step = 0; step < 30; step++) {
      const { p: q, d1: e1, d2: e2 } = cb.at(u);
      const r = sub(q, p);
      const f = dot(r, e1);
      const df = dot(e1, e1) + dot(r, e2);
      if (!(df > 0)) break;
      const newton = u - f / df;
      const span = cb.t1 - cb.t0;
      const next = cb.closed
        ? cb.t0 + ((((newton - cb.t0) % span) + span) % span)
        : Math.min(cb.t1, Math.max(cb.t0, newton));
      if (Math.abs(next - u) < 1e-12) break;
      u = next;
    }
    const { p: q, d1: e1 } = cb.at(u);
    const d = sub(q, p);
    if (
      !cb.closed &&
      (u === cb.t0 || u === cb.t1) &&
      Math.abs(dot(d, unit(e1))) > cadGapFlush.beyondMm
    )
      continue;
    const nA = onFace.normal;
    const flush = dot(d, nA);
    const tangent = unit(sub(d1, scale(nA, dot(d1, nA))));
    const inPlane = sub(d, scale(nA, flush));
    const across = sub(inPlane, scale(tangent, dot(inPlane, tangent)));
    samples.push({ at: p, to: q, gapMm: norm(across), flushMm: flush });
  }
  return samples.length ? samples : 'gap-flush-apart';
}
