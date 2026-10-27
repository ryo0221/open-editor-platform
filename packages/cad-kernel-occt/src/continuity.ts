import { cadContinuity, type CadContinuitySample, type Vec3 } from '@editor-platform/cad-core';
import type { OcModule } from './evaluator';

type V = Vec3;
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: V) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V): V => {
  const l = norm(a);
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** A point on the edge farther than this from a face after the projection: not on that face. */
const projectionMm = 0.01;

/**
 * Samples the edge between two faces of one shape (the shape is meshed: the triangulation seeds
 * each projection) at `cadContinuity.samples` equal steps of its parameter, both ends included.
 * Each sample projects the edge's point onto both faces' exact surfaces by Newton steps from the
 * nearest triangulation node of the edge, then compares the surface points (G0), the oriented
 * normals (G1) and the normal curvatures across the edge (G2) from the surfaces' second
 * derivatives. Returns a code when a sample cannot be projected onto a face.
 */
export function edgeContinuity(
  oc: OcModule,
  own: <T>(value: T) => T,
  edge: unknown,
  faces: [unknown, unknown],
): CadContinuitySample[] | 'continuity-projection-failed' {
  const xyz = (p: { X(): number; Y(): number; Z(): number }): V => [p.X(), p.Y(), p.Z()];
  // The edge's own curve (located) over its vertices' parameters; a closed one runs a period.
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
  const sides = faces.map((face) => {
    const surface = own(oc.BRep_Tool.Surface_2(face)).get();
    const reversed =
      (face as { Orientation_1(): { value: number } }).Orientation_1().value ===
      oc.TopAbs_Orientation.TopAbs_REVERSED.value;
    // The edge's nodes on this face's triangulation, with their surface parameters.
    const loc = own(new oc.TopLoc_Location_1());
    const handle = own(oc.BRep_Tool.Triangulation(face, loc, 0));
    const seeds: { p: V; uv: [number, number] }[] = [];
    if (!handle.IsNull() && handle.get().HasUVNodes()) {
      const tri = handle.get();
      const trsf = own(loc.Transformation());
      const polygon = own(oc.BRep_Tool.PolygonOnTriangulation_1(edge, handle, loc));
      const nodes = polygon.IsNull()
        ? Array.from({ length: tri.NbNodes() }, (_, i) => i + 1)
        : Array.from({ length: polygon.get().NbNodes() }, (_, i) => polygon.get().Node(i + 1));
      for (const n of nodes) {
        const uv = own(tri.UVNode(n));
        seeds.push({ p: xyz(own(own(tri.Node(n)).Transformed(trsf))), uv: [uv.X(), uv.Y()] });
      }
    }
    return { surface, reversed, seeds };
  });
  const P = own(new oc.gp_Pnt_1());
  const vecs = Array.from({ length: 5 }, () => own(new oc.gp_Vec_1()));
  const [Su, Sv, Suu, Svv, Suv] = vecs;
  type Side = (typeof sides)[number];
  /** The surface point nearest `c` and its derivatives, or undefined when it stays away. */
  const project = (side: Side, c: V) => {
    if (!side.seeds.length) return undefined;
    let seed = side.seeds[0]!;
    for (const s of side.seeds) if (norm(sub(s.p, c)) < norm(sub(seed.p, c))) seed = s;
    let [u, v] = seed.uv;
    for (let i = 0; i < 50; i++) {
      side.surface.D1(u, v, P, Su, Sv);
      const r = sub(xyz(P), c);
      const [a, b] = [xyz(Su), xyz(Sv)];
      const [e, f, g] = [dot(a, a), dot(a, b), dot(b, b)];
      const det = e * g - f * f;
      if (!(det > 0)) return undefined;
      const [ra, rb] = [dot(a, r), dot(b, r)];
      const du = -(g * ra - f * rb) / det;
      const dv = -(e * rb - f * ra) / det;
      u += du;
      v += dv;
      if (Math.hypot(du * Math.sqrt(e), dv * Math.sqrt(g)) < 1e-12) break;
    }
    side.surface.D2(u, v, P, Su, Sv, Suu, Svv, Suv);
    const point = xyz(P);
    if (!(norm(sub(point, c)) <= projectionMm)) return undefined;
    const [a, b] = [xyz(Su), xyz(Sv)];
    const n = unit(cross(a, b));
    const normal: V = side.reversed ? [-n[0], -n[1], -n[2]] : n;
    return { point, normal, a, b, aa: xyz(Suu), bb: xyz(Svv), ab: xyz(Suv) };
  };
  /** The normal curvature of a projected side in tangent direction `d` (1/mm, along its normal). */
  const curvature = (s: NonNullable<ReturnType<typeof project>>, d: V) => {
    const [e, f, g] = [dot(s.a, s.a), dot(s.a, s.b), dot(s.b, s.b)];
    const [da, db] = [dot(d, s.a), dot(d, s.b)];
    const det = e * g - f * f;
    const x = (g * da - f * db) / det;
    const y = (e * db - f * da) / det;
    const second =
      dot(s.aa, s.normal) * x * x + 2 * dot(s.ab, s.normal) * x * y + dot(s.bb, s.normal) * y * y;
    return second / (e * x * x + 2 * f * x * y + g * y * y);
  };
  const point = own(new oc.gp_Pnt_1());
  const tangent = own(new oc.gp_Vec_1());
  const samples: CadContinuitySample[] = [];
  for (let i = 0; i < cadContinuity.samples; i++) {
    const t = t0 + ((t1 - t0) * i) / (cadContinuity.samples - 1);
    curve.D1(t, point, tangent);
    const c = xyz(point);
    const [one, two] = [project(sides[0]!, c), project(sides[1]!, c)];
    if (!one || !two) return 'continuity-projection-failed';
    // Across the edge, in each face's own tangent plane (the faces' planes differ at a crease);
    // the curvature is the same both ways across.
    const across = (n: V) => unit(cross(xyz(tangent), n));
    const angle = Math.atan2(norm(cross(one.normal, two.normal)), dot(one.normal, two.normal));
    samples.push({
      at: c,
      g0Mm: norm(sub(one.point, two.point)),
      g1Deg: (angle * 180) / Math.PI,
      curvature: [curvature(one, across(one.normal)), curvature(two, across(two.normal))],
    });
  }
  return samples;
}
