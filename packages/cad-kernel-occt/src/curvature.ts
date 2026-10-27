import { cadCurvature, type CadCombSample, type Vec3 } from '@editor-platform/cad-core';
import type { OcModule } from './evaluator';

type V = Vec3;
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V) => Math.hypot(a[0], a[1], a[2]);
const xyz = (p: { X(): number; Y(): number; Z(): number }): V => [p.X(), p.Y(), p.Z()];

/**
 * The mean and Gauss curvature (1/mm, 1/mm²) at each node of a face's triangulation, from the
 * face's exact surface at the node's parameters (`Geom_Surface::D2`): the mean curvature is
 * positive where the face bends away from its outward normal (a convex face), the Gauss
 * curvature positive where it bends the same way in every direction. A node without
 * parameters, or where the surface has no tangent plane (a pole), is NaN.
 */
export function nodeCurvature(
  oc: OcModule,
  own: <T>(value: T) => T,
  face: unknown,
  tri: OcModule,
  mean: Float32Array,
  gauss: Float32Array,
  offset: number,
) {
  const count = tri.NbNodes() as number;
  if (!tri.HasUVNodes()) {
    mean.fill(Number.NaN, offset, offset + count);
    gauss.fill(Number.NaN, offset, offset + count);
    return;
  }
  const surface = own(oc.BRep_Tool.Surface_2(face)).get();
  const reversed =
    (face as { Orientation_1(): { value: number } }).Orientation_1().value ===
    oc.TopAbs_Orientation.TopAbs_REVERSED.value;
  const P = own(new oc.gp_Pnt_1());
  const [Su, Sv, Suu, Svv, Suv] = Array.from({ length: 5 }, () => own(new oc.gp_Vec_1()));
  for (let i = 1; i <= count; i++) {
    const uv = own(tri.UVNode(i));
    surface.D2(uv.X(), uv.Y(), P, Su, Sv, Suu, Svv, Suv);
    const [a, b] = [xyz(Su), xyz(Sv)];
    const [e, f, g] = [dot(a, a), dot(a, b), dot(b, b)];
    const det = e * g - f * f;
    const n = cross(a, b);
    const l = norm(n);
    if (!(det > 1e-24) || !(l > 0)) {
      mean[offset + i - 1] = gauss[offset + i - 1] = Number.NaN;
      continue;
    }
    const k = (reversed ? -1 : 1) / l;
    const unit: V = [n[0] * k, n[1] * k, n[2] * k];
    const [L, M, N] = [dot(xyz(Suu), unit), dot(xyz(Suv), unit), dot(xyz(Svv), unit)];
    // With the outward normal a convex face has L, N < 0: the sign makes it positive (and
    // + 0 makes a flat face's −0 zero).
    mean[offset + i - 1] = -(e * N - 2 * f * M + g * L) / (2 * det) + 0;
    gauss[offset + i - 1] = (L * N - M * M) / det + 0;
  }
}

/**
 * The curvature comb of an edge's own curve (R2a-4): `cadCurvature.combSamples` equal steps of
 * its parameter between its vertices, both ends included (a closed edge runs one period). Each
 * sample is the point, the curvature (1/mm) and the unit principal normal toward the centre of
 * curvature, `[0, 0, 0]` where the curve is straight. Undefined when the edge has no 3D curve.
 */
export function edgeComb(
  oc: OcModule,
  own: <T>(value: T) => T,
  edge: unknown,
): CadCombSample[] | undefined {
  const handle = own(oc.BRep_Tool.Curve_2(edge, 0, 0));
  if (handle.IsNull()) return undefined;
  const curve = handle.get();
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
  const samples: CadCombSample[] = [];
  for (let i = 0; i < cadCurvature.combSamples; i++) {
    const t = t0 + ((t1 - t0) * i) / (cadCurvature.combSamples - 1);
    curve.D2(t, P, D1, D2);
    const [d1, d2] = [xyz(D1), xyz(D2)];
    const speed = norm(d1);
    const bend = cross(d1, d2);
    const curvature = speed > 0 ? norm(bend) / speed ** 3 : 0;
    // The principal normal: d2's part across the tangent, (d1 × d2) × d1.
    const toward = cross(bend, d1);
    const l = norm(toward);
    const straight = !(curvature > 1e-12) || !(l > 0);
    samples.push({
      at: xyz(P),
      curvature: straight ? 0 : curvature,
      normal: straight ? [0, 0, 0] : [toward[0] / l, toward[1] / l, toward[2] / l],
    });
  }
  return samples;
}
