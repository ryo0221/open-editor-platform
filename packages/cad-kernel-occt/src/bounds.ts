import type { OcModule } from './evaluator';

type Vec3 = [number, number, number];
type Corners = [number, number, number, number, number, number];

/**
 * How far a face's loose box (`BRepBndLib.Add`, from its poles or samples and its tolerance) may
 * fall inside the face's optimal box: a face whose loose box stops this much short of the best
 * optimal extent so far cannot set that extent. #1265: on J-CA-27 the optimal box overshoots the
 * loose one by 6.4 × 10⁻⁶ mm on a planar face; the margin keeps a wide allowance above that.
 */
const looseMarginMm = (diagonal: number) => 0.01 + 1e-6 * diagonal;

/**
 * A shape's optimal axis-aligned box without its tolerance: the same box as
 * `BRepBndLib.AddOptimal(shape, box, false, false)`, which is the union of each face's optimal
 * box. #1265: that is computed face by face, and on a solid of 2,066 faces it took 68 s. Here
 * every face first gets its cheap loose box, and only the faces whose loose box can still reach
 * one of the six extents get their optimal box (54 of the 2,066, 1.4 s). A shape with an edge
 * outside its faces or a vertex outside its edges takes the whole computation. Every handle
 * made here goes through `own`, which the caller deletes.
 */
export function optimalBounds(oc: OcModule, shape: unknown, own: <T>(value: T) => T): [Vec3, Vec3] {
  const E = oc.TopAbs_ShapeEnum;
  const corners = (box: { CornerMin(): unknown; CornerMax(): unknown }): Corners => {
    type P = { X(): number; Y(): number; Z(): number };
    const [a, b] = [own(box.CornerMin()) as P, own(box.CornerMax()) as P];
    return [a.X(), a.Y(), a.Z(), b.X(), b.Y(), b.Z()];
  };
  const result = (c: Corners): [Vec3, Vec3] => [
    [c[0], c[1], c[2]],
    [c[3], c[4], c[5]],
  ];
  const whole = () => {
    const box = own(new oc.Bnd_Box_1());
    oc.BRepBndLib.AddOptimal(shape, box, false, false);
    return result(corners(box));
  };
  const any = (what: unknown, avoid: unknown) =>
    own(new oc.TopExp_Explorer_2(shape, what, avoid)).More() as boolean;
  if (any(E.TopAbs_EDGE, E.TopAbs_FACE) || any(E.TopAbs_VERTEX, E.TopAbs_EDGE)) return whole();
  const faces: unknown[] = [];
  for (
    const ex = own(new oc.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE));
    ex.More();
    ex.Next()
  )
    faces.push(own(ex.Current()));
  const loose: (Corners | undefined)[] = faces.map((face) => {
    const box = own(new oc.Bnd_Box_1());
    oc.BRepBndLib.Add(face, box, false);
    return box.IsVoid() ? undefined : corners(box);
  });
  // A face without a loose box (no surface, or one OCCT cannot bound) leaves the shortcut.
  if (!faces.length || loose.some((l) => !l)) return whole();
  const all = loose as Corners[];
  const span = Math.hypot(
    Math.max(...all.map((l) => l[3])) - Math.min(...all.map((l) => l[0])),
    Math.max(...all.map((l) => l[4])) - Math.min(...all.map((l) => l[1])),
    Math.max(...all.map((l) => l[5])) - Math.min(...all.map((l) => l[2])),
  );
  const margin = looseMarginMm(Number.isFinite(span) ? span : 0);
  const optimal = new Map<number, Corners | null>();
  const optimalOf = (i: number) => {
    if (!optimal.has(i)) {
      const box = own(new oc.Bnd_Box_1());
      oc.BRepBndLib.AddOptimal(faces[i], box, false, false);
      optimal.set(i, box.IsVoid() ? null : corners(box));
    }
    return optimal.get(i)!;
  };
  const out = [] as unknown as Corners;
  for (let k = 0; k < 6; k++) {
    // The first three are minima (smaller wins), the last three maxima (larger wins).
    const max = k >= 3;
    const order = all
      .map((_, i) => i)
      .sort((a, b) => (max ? all[b]![k]! - all[a]![k]! : all[a]![k]! - all[b]![k]!));
    let best = max ? -Infinity : Infinity;
    for (const i of order) {
      const reach = all[i]![k]!;
      if (max ? reach + margin <= best : reach - margin >= best) break;
      const o = optimalOf(i);
      if (o) best = max ? Math.max(best, o[k]!) : Math.min(best, o[k]!);
    }
    if (!Number.isFinite(best)) return whole();
    out[k] = best;
  }
  return result(out);
}
