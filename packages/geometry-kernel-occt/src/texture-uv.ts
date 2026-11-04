import { geometryPlanarTextureUv, type GeometryVec3 as Vec3 } from '@editor-platform/geometry-core';
import type { OcModule } from './module';

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const xyz = (p: { X(): number; Y(): number; Z(): number }): Vec3 => [p.X(), p.Y(), p.Z()];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
/** Planes are measured from the corner of this cell (mm) that holds the body's origin. */
const textureCellMm = 100_000;

/**
 * Real-size texture coordinates (mm) of each node of a face's triangulation (#662), written to
 * `uvs` from node `offset` (two per node). A plane is projected on the model's axes
 * (`geometryPlanarTextureUv`), so neighbouring faces and bodies within 100 m line up. Any other face uses its
 * own surface parameters, scaled to mm by the surface's speed in each direction at the middle of
 * the face: exact on a cylinder and an extrusion, close on a loft that does not stretch much. Its
 * up is the parameter direction nearer the model's z, and seen from outside the image is never
 * mirrored. `positions` are the nodes relative to `origin` (model-space mm), three per node.
 */
export function faceTextureUvs(
  oc: OcModule,
  own: <T>(value: T) => T,
  face: unknown,
  tri: OcModule,
  positions: ArrayLike<number>,
  origin: Vec3,
  uvs: Float32Array,
  offset: number,
) {
  const count = tri.NbNodes() as number;
  const point = (i: number): Vec3 => [
    positions[(offset + i) * 3]! + origin[0],
    positions[(offset + i) * 3 + 1]! + origin[1],
    positions[(offset + i) * 3 + 2]! + origin[2],
  ];
  const reversed =
    (face as { Orientation_1(): { value: number } }).Orientation_1().value ===
    oc.TopAbs_Orientation.TopAbs_REVERSED.value;
  const surface = own(oc.BRep_Tool.Surface_2(face)).get();
  // The face's middle in its parameters, and the surface's derivatives there.
  let u0 = 0;
  let v0 = 0;
  const params: [number, number][] = [];
  if (tri.HasUVNodes()) {
    for (let i = 1; i <= count; i++) {
      const uv = own(tri.UVNode(i));
      params.push([uv.X(), uv.Y()]);
    }
    let [uMin, uMax, vMin, vMax] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const [u, v] of params) {
      uMin = Math.min(uMin, u);
      uMax = Math.max(uMax, u);
      vMin = Math.min(vMin, v);
      vMax = Math.max(vMax, v);
    }
    u0 = (uMin + uMax) / 2;
    v0 = (vMin + vMax) / 2;
  }
  const P = own(new oc.gp_Pnt_1());
  const Su = own(new oc.gp_Vec_1());
  const Sv = own(new oc.gp_Vec_1());
  surface.D1(u0, v0, P, Su, Sv);
  const [a, b] = [xyz(Su), xyz(Sv)];
  const [la, lb] = [norm(a), norm(b)];
  const n = cross(a, b);
  const ln = norm(n);
  const outward: Vec3 = ln > 0 ? scale(n, (reversed ? -1 : 1) / ln) : [0, 0, 1];
  // Planar when every node lies on the tangent plane at the middle (the kernel's plane, or a
  // face too flat for its curve to show).
  const mid = xyz(P);
  let size = 0;
  let off = 0;
  for (let i = 0; i < count; i++) {
    const p = point(i);
    const d: Vec3 = [p[0] - mid[0], p[1] - mid[1], p[2] - mid[2]];
    size = Math.max(size, norm(d));
    off = Math.max(off, Math.abs(dot(d, outward)));
  }
  const planar = off <= 1e-6 * size + 1e-7;
  if (planar || !params.length || !(la > 0) || !(lb > 0) || !(ln > 0)) {
    // A plane, or a face without parameters to follow: the plane through its middle. Measured
    // in double from the corner of the 100 m cell the body's origin is in, so a small face far
    // from the model's origin keeps its size in Float32; bodies in one cell line up.
    const cell = origin.map((c) => Math.round(c / textureCellMm) * textureCellMm) as Vec3;
    const [cu, cv] = geometryPlanarTextureUv(cell, outward);
    for (let i = 0; i < count; i++) {
      const [u, v] = geometryPlanarTextureUv(point(i), outward);
      uvs[(offset + i) * 2] = u - cu;
      uvs[(offset + i) * 2 + 1] = v - cv;
    }
    return;
  }
  // Up is the parameter direction nearer z (or y on a near-horizontal face), pointing up.
  const ua = scale(a, 1 / la);
  const ub = scale(b, 1 / lb);
  const upAxis: Vec3 = Math.abs(outward[2]) >= 0.9 ? [0, 1, 0] : [0, 0, 1];
  const vIsB = Math.abs(dot(ub, upAxis)) >= Math.abs(dot(ua, upAxis));
  const up = vIsB ? ub : ua;
  const right = vIsB ? ua : ub;
  const vSign = dot(up, upAxis) < 0 ? -1 : 1;
  // Seen from outside, right × up is the outward normal: else u runs the other way.
  const uSign = dot(cross(right, scale(up, vSign)), outward) < 0 ? -1 : 1;
  for (let i = 0; i < count; i++) {
    const [u, v] = params[i]!;
    // From the face's middle: a parameter far from zero keeps its precision in Float32.
    const du = (u - u0) * la;
    const dv = (v - v0) * lb;
    const [r, t] = vIsB ? [du, dv] : [dv, du];
    uvs[(offset + i) * 2] = uSign * r;
    uvs[(offset + i) * 2 + 1] = vSign * t;
  }
}
