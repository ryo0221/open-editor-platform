/**
 * R2b-2 connector frames (docs/cad/r2b-assembly.md, Connectorとjoint): the frame a joint reads
 * from a face, edge or vertex of an evaluated body, from its exact geometry. A planar face gives
 * its centroid and outward normal; a cylindrical or conical face its axis (through the centroid's
 * foot on it); a circular edge its centre and the normal of its plane; a vertex its point with
 * the part's axes. x follows the sketch attachment rule. Anything else is `unsupported`.
 */
import {
  attachFrame,
  cadReferenceCandidates,
  elementGeometry,
  resolveTopologyRef,
  topologyRefOf,
  type CadConnectorFrame,
  type CadTopologyRef,
  type CadTopologyTable,
  type Vec3,
} from '@editor-platform/cad-core';
import type { OcModule } from './evaluator';

export interface FrameTable {
  topology: CadTopologyTable;
  face(i: number): unknown;
  edge(i: number): unknown;
}

const xyz = (p: { X(): number; Y(): number; Z(): number }): Vec3 => [p.X(), p.Y(), p.Z()];

/** One connector reference on a body's table (the body's result feature already matched). */
export function connectorFrame(
  oc: OcModule,
  own: <T>(value: T) => T,
  table: FrameTable,
  ref: CadTopologyRef,
): CadConnectorFrame {
  const { topology } = table;
  const r = resolveTopologyRef(topology, ref);
  if (r.status !== 'resolved')
    return {
      status: r.status,
      candidates: (r.status === 'ambiguous' ? r.candidates : [])
        .slice(0, cadReferenceCandidates)
        .map((i) => {
          const hint = elementGeometry(topology, ref.kind, i);
          try {
            return { hint, ref: topologyRefOf(topology, ref.kind, i, ref.featureId) };
          } catch {
            return { hint };
          }
        }),
    };
  const framed = (origin: Vec3, z: Vec3): CadConnectorFrame => ({
    status: 'resolved',
    frame: { translationMm: origin, rotation: attachFrame(origin, z, 0).orientation },
  });
  // A vertex is its exact point, with the part's own axes: a point has no direction of its own.
  if (ref.kind === 'vertex')
    return {
      status: 'resolved',
      frame: { translationMm: [...topology.vertices[r.index]!.centroid], rotation: [0, 0, 0, 1] },
    };
  // The element's own surface or curve (location applied), read by its type: this build binds
  // the generic Geom_Surface and Geom_Curve, not the adaptors (their base classes are unbound).
  const typeName = (geometry: { DynamicType(): { get(): { Name(): string } } }) => {
    const type = own(geometry.DynamicType());
    return type.get().Name();
  };
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const unit = (a: Vec3): Vec3 => {
    const k = Math.hypot(...a);
    return [a[0] / k, a[1] / k, a[2] / k];
  };
  if (ref.kind === 'face') {
    const face = table.face(r.index) as { Orientation_1(): unknown };
    const handle = own(oc.BRep_Tool.Surface_2(face));
    const surface = handle.get();
    const type = typeName(surface);
    const centroid = topology.faces[r.index]!.centroid;
    /** The point and first derivatives at (u, v). */
    const d1 = (u: number, v: number) => {
      const p = own(new oc.gp_Pnt_1());
      const du = own(new oc.gp_Vec_1());
      const dv = own(new oc.gp_Vec_1());
      surface.D1(u, v, p, du, dv);
      return { p: xyz(p), du: xyz(du), dv: xyz(dv) };
    };
    if (type === 'Geom_Plane') {
      // P(u, v) = O + u·X + v·Y: X × Y is the plane's axis; a reversed face points the other way.
      const { du, dv } = d1(0, 0);
      const n = unit(cross(du, dv));
      const reversed = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
      return framed(centroid, reversed ? [-n[0], -n[1], -n[2]] : n);
    }
    if (type === 'Geom_CylindricalSurface' || type === 'Geom_ConicalSurface') {
      // Along u the surface circles its axis: the tangents at u = 0 and π/2 span the circle's
      // plane (in the axis's own sense), and the points at u = 0 and π face across the axis.
      const a = d1(0, 0);
      const b = d1(Math.PI / 2, 0);
      const c = d1(Math.PI, 0);
      const d = unit(cross(a.du, b.du));
      const at: Vec3 = [(a.p[0] + c.p[0]) / 2, (a.p[1] + c.p[1]) / 2, (a.p[2] + c.p[2]) / 2];
      const off = sub(centroid, at);
      const k = off[0] * d[0] + off[1] * d[1] + off[2] * d[2];
      return framed([at[0] + k * d[0], at[1] + k * d[1], at[2] + k * d[2]], d);
    }
    return { status: 'unsupported' };
  }
  const handle = own(oc.BRep_Tool.Curve_2(table.edge(r.index), 0, 0));
  if (handle.IsNull()) return { status: 'unsupported' };
  const curve = handle.get();
  if (typeName(curve) !== 'Geom_Circle') return { status: 'unsupported' };
  const d1 = (u: number) => {
    const p = own(new oc.gp_Pnt_1());
    const v = own(new oc.gp_Vec_1());
    curve.D1(u, p, v);
    return { p: xyz(p), v: xyz(v) };
  };
  // P(u) = C + R·(cos u·X + sin u·Y): the centre is midway across, the normal X × Y.
  const a = d1(0);
  const b = d1(Math.PI / 2);
  const c = d1(Math.PI);
  return framed(
    [(a.p[0] + c.p[0]) / 2, (a.p[1] + c.p[1]) / 2, (a.p[2] + c.p[2]) / 2],
    unit(cross(a.v, b.v)),
  );
}
