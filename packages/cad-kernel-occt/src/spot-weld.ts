import { cadSpotWeldLimits, type CadSpotWeld, type Vec3 } from '@editor-platform/cad-core';
import type { OcModule } from './evaluator';
import { faceSetDistances } from './face-distance';

/** Samples along each middle line of a face's parameter range, to measure it. */
const lineSamples = 256;

/**
 * CR4e (docs/cad/car-design.md, W3): the points of a spot weld row on flange `a`, and each
 * one's distance to flange `b`. The row runs along `a`'s centre line: the line midway across its
 * parameter range (from its display triangulation's parameter nodes) in the direction it is
 * longer in. The points are `pitchMm` apart along it, centred, none nearer an end than
 * `endDistanceMm`; each is moved onto `a`'s exact trimmed face (its nearest point), so a point
 * lies on the first flange and its gap is its distance to the second.
 */
export function spotWeldPoints(
  oc: OcModule,
  own: <T>(value: T) => T,
  a: { face: unknown; deflection: number },
  b: { face: unknown; deflection: number },
  weld: Pick<CadSpotWeld, 'pitchMm' | 'endDistanceMm'>,
):
  | { points: Float64Array; gaps: Float64Array; lengthMm: number }
  | 'spot-weld-no-mesh'
  | 'spot-weld-short'
  | 'spot-weld-points'
  | 'face-distance-no-mesh' {
  const loc = own(new oc.TopLoc_Location_1());
  const handle = own(oc.BRep_Tool.Triangulation(a.face, loc, 0));
  if (handle.IsNull() || !handle.get().HasUVNodes()) return 'spot-weld-no-mesh';
  const tri = handle.get();
  let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (let n = 1; n <= tri.NbNodes(); n++) {
    const uv = own(tri.UVNode(n));
    [u0, u1] = [Math.min(u0, uv.X()), Math.max(u1, uv.X())];
    [v0, v1] = [Math.min(v0, uv.Y()), Math.max(v1, uv.Y())];
  }
  const surface = own(oc.BRep_Tool.Surface_2(a.face)).get();
  const P = own(new oc.gp_Pnt_1());
  const at = (u: number, v: number): Vec3 => {
    surface.D0(u, v, P);
    return [P.X(), P.Y(), P.Z()];
  };
  /** The line's points and lengths along it, from `uv(0)` to `uv(1)`. */
  const line = (uv: (t: number) => [number, number]) => {
    const pts: Vec3[] = [];
    const s = [0];
    for (let k = 0; k <= lineSamples; k++) {
      pts.push(at(...uv(k / lineSamples)));
      if (k) s.push(s[k - 1]! + Math.hypot(...pts[k]!.map((x, i) => x - pts[k - 1]![i]!)));
    }
    return { uv, s };
  };
  const [um, vm] = [(u0 + u1) / 2, (v0 + v1) / 2];
  const alongU = line((t) => [u0 + t * (u1 - u0), vm]);
  const alongV = line((t) => [um, v0 + t * (v1 - v0)]);
  const run = alongU.s[lineSamples]! >= alongV.s[lineSamples]! ? alongU : alongV;
  const L = run.s[lineSamples]!;
  const span = L - 2 * weld.endDistanceMm;
  if (!(span >= 0)) return 'spot-weld-short';
  const count = Math.floor(span / weld.pitchMm + 1e-9) + 1;
  if (count > cadSpotWeldLimits.pointsPerWeld) return 'spot-weld-points';
  const first = (L - (count - 1) * weld.pitchMm) / 2;
  const seeds = new Float64Array(3 * count);
  let k = 0;
  for (let i = 0; i < count; i++) {
    const s = first + i * weld.pitchMm;
    while (k + 1 < lineSamples && run.s[k + 1]! < s) k++;
    const f = (s - run.s[k]!) / (run.s[k + 1]! - run.s[k]! || 1);
    seeds.set(at(...run.uv((k + Math.min(Math.max(f, 0), 1)) / lineSamples)), 3 * i);
  }
  const onA = faceSetDistances(oc, own, [a.face], seeds, a.deflection);
  if (typeof onA === 'string') return onA;
  const toB = faceSetDistances(oc, own, [b.face], onA.nearest, b.deflection);
  if (typeof toB === 'string') return toB;
  return { points: onA.nearest, gaps: toB.distances, lengthMm: L };
}
