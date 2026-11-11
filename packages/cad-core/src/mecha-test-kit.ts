import { checkCadInterference, type CadInterferenceMesh } from './interference';
import { parameterValues } from './graph';
import { solveJoints } from './joints';
import type { CadDocument } from './model';
import { applyCadOperation } from './operations';

/** `p` turned by the unit quaternion `q`. */
function turn([x, y, z]: number[], [qx, qy, qz, qw]: readonly number[]) {
  const [tx, ty, tz] = [
    2 * (qy! * z! - qz! * y!),
    2 * (qz! * x! - qx! * z!),
    2 * (qx! * y! - qy! * x!),
  ];
  return [
    x! + qw! * tx + (qy! * tz - qz! * ty),
    y! + qw! * ty + (qz! * tx - qx! * tz),
    z! + qw! * tz + (qx! * ty - qy! * tx),
  ];
}
const len = (v: { literalMm: number } | object) => ('literalMm' in v ? (v.literalMm as number) : 0);
/**
 * A part's bodies as a kernel meshes them: a box two triangles per face, a prism of a convex
 * outline its two caps fanned and two triangles per side, each face its own vertices.
 */
export function meshes(doc: CadDocument): CadInterferenceMesh[] {
  return doc.bodies.map((b) => {
    const f = doc.features.find((x) => x.id === `${b.id}-box` || x.id === `${b.id}-extrude`)!;
    const positions: number[] = [];
    const indices: number[] = [];
    const face = (corners: number[][]) => {
      const base = positions.length / 3;
      corners.forEach((p) => positions.push(...p));
      for (let i = 1; i + 1 < corners.length; i++) indices.push(base, base + i, base + i + 1);
    };
    if (f.type === 'box') {
      const o = f.args.origin.map(len);
      const s = f.args.size.map(len);
      for (let axis = 0; axis < 3; axis++)
        for (const side of [0, 1]) {
          const u = (axis + 1) % 3;
          const v = (axis + 2) % 3;
          face(
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ].map(([i, j]) => {
              const p = [0, 0, 0];
              p[axis] = o[axis]! + side * s[axis]!;
              p[u] = o[u]! + i! * s[u]!;
              p[v] = o[v]! + j! * s[v]!;
              return p;
            }),
          );
        }
    } else if (f.type === 'extrude' && 'profileId' in f.args) {
      const { profileId, distance } = f.args;
      const profile = doc.profiles.find((p) => p.id === profileId)!;
      if (profile.shape.type !== 'polyline') throw new Error('polyline only');
      const o = profile.plane.origin.map(len);
      const at = (u: number, v: number, w: number) =>
        turn([u, v, w], profile.plane.orientation).map((c, i) => c + o[i]!);
      const outline = profile.shape.vertices.map((p) => [len(p.u), len(p.v)] as const);
      const d = len(distance);
      face(outline.map(([u, v]) => at(u, v, 0)).reverse());
      face(outline.map(([u, v]) => at(u, v, d)));
      outline.forEach(([u, v], i) => {
        const [u2, v2] = outline[(i + 1) % outline.length]!;
        face([at(u, v, 0), at(u2, v2, 0), at(u2, v2, d), at(u, v, d)]);
      });
    } else throw new Error(`no mesh for ${f.type}`);
    return { bodyId: b.id, origin: [0, 0, 0], positions, indices };
  });
}
export function check(
  f: { closure: Map<string, CadDocument>; assembly: CadDocument },
  doc = f.assembly,
  form?: number,
) {
  const lookup = (h: string) => f.closure.get(h);
  const { joints } = solveJoints(
    doc,
    parameterValues(doc),
    lookup,
    () => undefined,
    () => true,
  );
  const r = checkCadInterference({
    doc,
    lookup,
    meshesOf: (h) => meshes(f.closure.get(h)!),
    joints,
    ...(form === undefined ? {} : { form: doc.configurations![form]! }),
  });
  if (r.status !== 'ok') return [r.code];
  return [...r.findings.map((x) => `${x.a.join('/')}–${x.b.join('/')}:${x.kind}`), ...r.stale];
}
/** A joint's values set (degrees, or mm for lengths) and the poses solved again, as an edit does. */
export function set(
  f: { closure: Map<string, CadDocument> },
  doc: CadDocument,
  joint: string,
  values: Record<string, number>,
) {
  const next = applyCadOperation(doc, {
    type: 'setJointValues',
    jointId: joint,
    values: Object.fromEntries(
      Object.entries(values).map(([k, v]) => [
        k,
        k === 'distance' || k === 'u' || k === 'v'
          ? { literalMm: v }
          : { literalRad: (v * Math.PI) / 180 },
      ]),
    ),
  });
  next.solvedPoses = solveJoints(
    next,
    parameterValues(next),
    (h) => f.closure.get(h),
    () => undefined,
    () => true,
  ).poses;
  return next;
}
