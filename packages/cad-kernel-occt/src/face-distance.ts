import type { Vec3 } from '@editor-platform/cad-core';
import type { OcModule } from './evaluator';
import { edgeCurve } from './gap-flush';

type V = Vec3;
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: V) => Math.hypot(a[0], a[1], a[2]);
const cross = (a: V, b: V): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const isReversed = (oc: OcModule, shape: unknown) =>
  (shape as { Orientation_1(): unknown }).Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;

/** A parameter point counts as on a face within this share of a triangle (its barycentrics). */
const insideSlack = 1e-6;
/** The border band, in multiples of the triangulation's deflection, decided on the exact border. */
const borderBand = 4;

/**
 * CR4a (docs/cad/car-design.md, 86A1): the distance from points to a set of a body's faces, on
 * their exact trimmed surfaces, and the nearest point on them. Each face's display triangulation
 * seeds the search: from the node nearest the point, Newton steps find the nearest point of the
 * face's surface. Whether it lies inside the face's trim: away from the border, inside a triangle
 * of the triangulation's parameter mesh (a periodic surface tried a period either way); within
 * a few deflections of the border, where that mesh is short of a curved border (Codex on #960),
 * on the inner side of the nearest border edge (its tangent turned by the face's normal). Inside,
 * that is the distance; otherwise the nearest point lies on the border, and the distance is to
 * its nearest edge curve (also refined by Newton steps). The display triangulation itself is off
 * the surface by its deflection (up to 0.1% of the body's size), which the bond candidates
 * measured until now.
 */
export function faceSetDistances(
  oc: OcModule,
  own: <T>(value: T) => T,
  faces: unknown[],
  points: Float64Array,
  /** How far the body's display triangulation may lie off its surface (mm). */
  deflection: number,
): { distances: Float64Array; nearest: Float64Array } | 'face-distance-no-mesh' {
  const xyz = (p: { X(): number; Y(): number; Z(): number }): V => [p.X(), p.Y(), p.Z()];
  const P = own(new oc.gp_Pnt_1());
  const Su = own(new oc.gp_Vec_1());
  const Sv = own(new oc.gp_Vec_1());
  const prepared = [];
  for (const face of faces) {
    const loc = own(new oc.TopLoc_Location_1());
    const handle = own(oc.BRep_Tool.Triangulation(face, loc, 0));
    if (handle.IsNull() || !handle.get().HasUVNodes()) return 'face-distance-no-mesh';
    const tri = handle.get();
    const trsf = own(loc.Transformation());
    // A plane's triangulation reports no deflection: its border's chords still sag.
    const band = borderBand * Math.max(tri.Deflection_1(), deflection) + 1e-6;
    const nodes: V[] = [];
    const uvs: [number, number][] = [];
    for (let n = 1; n <= tri.NbNodes(); n++) {
      nodes.push(xyz(own(own(tri.Node(n)).Transformed(trsf))));
      const uv = own(tri.UVNode(n));
      uvs.push([uv.X(), uv.Y()]);
    }
    const triangles: [number, number, number][] = [];
    for (let i = 1; i <= tri.NbTriangles(); i++) {
      const t = own(tri.Triangle(i));
      triangles.push([t.Value(1) - 1, t.Value(2) - 1, t.Value(3) - 1]);
    }
    const surface = own(oc.BRep_Tool.Surface_2(face)).get();
    const edges: ReturnType<typeof edgeCurve>[] = [];
    /** Whether each edge runs against its curve on this face. */
    const against: boolean[] = [];
    const ex = own(
      new oc.TopExp_Explorer_2(
        face,
        oc.TopAbs_ShapeEnum.TopAbs_EDGE,
        oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
      ),
    );
    for (; ex.More(); ex.Next()) {
      const edge = own(oc.TopoDS.Edge_1(own(ex.Current())));
      // A periodic surface's seam (twice, both ways) is inside the face, not its border (Codex
      // on #960).
      if (oc.BRep_Tool.Degenerated(edge) || oc.BRep_Tool.IsClosed_2(edge, face)) continue;
      edges.push(edgeCurve(oc, own, edge));
      against.push(isReversed(oc, edge));
    }
    prepared.push({
      nodes,
      uvs,
      triangles,
      band,
      against,
      flipped: isReversed(oc, face),
      surface,
      edges,
      periods: [
        surface.IsUPeriodic() ? surface.UPeriod() : 0,
        surface.IsVPeriodic() ? surface.VPeriod() : 0,
      ] as const,
    });
  }
  type Face = (typeof prepared)[number];
  const inMesh = (f: Face, u: number, v: number) =>
    f.triangles.some(([a, b, c]) => {
      const [p, q, r] = [f.uvs[a]!, f.uvs[b]!, f.uvs[c]!];
      const det = (q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1]);
      if (det === 0) return false;
      const l1 = ((u - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (v - p[1])) / det;
      const l2 = ((q[0] - p[0]) * (v - p[1]) - (u - p[0]) * (q[1] - p[1])) / det;
      return l1 >= -insideSlack && l2 >= -insideSlack && l1 + l2 <= 1 + insideSlack;
    });
  /** The surface's nearest point from a seed, or undefined when the steps break down. */
  const onSurface = (f: Face, c: V, seed: number) => {
    let [u, v] = f.uvs[seed]!;
    for (let i = 0; i < 50; i++) {
      f.surface.D1(u, v, P, Su, Sv);
      const r = sub(xyz(P), c);
      const [a, b] = [xyz(Su), xyz(Sv)];
      const [e, g, h] = [dot(a, a), dot(a, b), dot(b, b)];
      const det = e * h - g * g;
      if (!(det > 0)) return undefined;
      const [ra, rb] = [dot(a, r), dot(b, r)];
      const du = -(h * ra - g * rb) / det;
      const dv = -(e * rb - g * ra) / det;
      u += du;
      v += dv;
      if (Math.hypot(du * Math.sqrt(e), dv * Math.sqrt(h)) < 1e-12) break;
    }
    f.surface.D0(u, v, P);
    const p = xyz(P);
    return { u, v, p, d: norm(sub(p, c)) };
  };
  const toEdge = (curve: ReturnType<typeof edgeCurve>, c: V) => {
    let k = 0;
    for (let m = 1; m < curve.pts.length; m++)
      if (norm(sub(curve.pts[m]!, c)) < norm(sub(curve.pts[k]!, c))) k = m;
    let t = curve.ts[k]!;
    for (let step = 0; step < 30; step++) {
      const { p: q, d1, d2 } = curve.at(t);
      const r = sub(q, c);
      const df = dot(d1, d1) + dot(r, d2);
      if (!(df > 0)) break;
      const span = curve.t1 - curve.t0;
      const newton = t - dot(r, d1) / df;
      const next = curve.closed
        ? curve.t0 + ((((newton - curve.t0) % span) + span) % span)
        : Math.min(curve.t1, Math.max(curve.t0, newton));
      if (Math.abs(next - t) < 1e-12) break;
      t = next;
    }
    const { p, d1 } = curve.at(t);
    const end = !curve.closed && (t <= curve.t0 || t >= curve.t1);
    return { p, d: norm(sub(p, c)), tangent: d1, end };
  };
  const out = new Float64Array(points.length / 3);
  const nearest = new Float64Array(points.length);
  for (let i = 0; i < out.length; i++) {
    const c: V = [points[3 * i]!, points[3 * i + 1]!, points[3 * i + 2]!];
    let best = { p: c, d: Infinity };
    for (const f of prepared) {
      let seed = 0;
      let seedD = Infinity;
      f.nodes.forEach((n, k) => {
        const d = norm(sub(n, c));
        if (d < seedD) [seed, seedD] = [k, d];
      });
      const hit = onSurface(f, c, seed);
      // The border edge nearest the surface point, and the nearest to c (if c's is outside).
      const near = (q: V) => {
        let at: (ReturnType<typeof toEdge> & { k: number }) | undefined;
        f.edges.forEach((e, k) => {
          const r = toEdge(e, q);
          if (!at || r.d < at.d) at = { ...r, k };
        });
        return at;
      };
      let within = false;
      if (hit) {
        const border = near(hit.p);
        if (border && border.d <= f.band && !border.end) {
          f.surface.D1(hit.u, hit.v, P, Su, Sv);
          const [a, b] = [xyz(Su), xyz(Sv)];
          const n = cross(a, b);
          const t = border.tangent;
          // The material lies to the left of an edge run along the face's normal.
          const inward = cross(n, t);
          const sign = (f.flipped ? -1 : 1) * (f.against[border.k] ? -1 : 1);
          within = sign * dot(inward, sub(hit.p, border.p)) >= 0;
        } else {
          const shifts = (period: number) => (period ? [0, period, -period] : [0]);
          within = shifts(f.periods[0]).some((du) =>
            shifts(f.periods[1]).some((dv) => inMesh(f, hit.u + du, hit.v + dv)),
          );
        }
      }
      // A face without edges (a whole sphere) has no border to fall back on.
      let at: { p: V; d: number } | undefined = within ? hit : undefined;
      if (!at && f.edges.length) at = near(c);
      at ??= hit ?? { p: f.nodes[seed]!, d: seedD };
      if (at.d < best.d) best = at;
    }
    out[i] = best.d;
    nearest.set(best.p, 3 * i);
  }
  return { distances: out, nearest };
}
