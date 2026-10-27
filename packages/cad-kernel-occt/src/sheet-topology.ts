import type { OcModule } from './evaluator';

/**
 * Topology facts of a sheet (docs/cad/r2a-freeform.md), shared by evaluation and STEP import:
 * whether every face reaches every other through shared edges, and the free (boundary) edges,
 * those on one face only. A seam (where a closed face meets itself, as a cylinder's) and a pole
 * (a degenerate edge where a revolved arc meets the axis) are not free. Every handle made here
 * goes through `own`, which the caller deletes.
 */
export function sheetTopology(
  oc: OcModule,
  shape: unknown,
  own: <T>(value: T) => T,
): { connected: boolean; freeEdges: number; freeEdgeLengthMm: number } {
  const faces = own(new oc.TopTools_IndexedMapOfShape_1());
  oc.TopExp.MapShapes_1(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, faces);
  const map = own(new oc.TopTools_IndexedDataMapOfShapeListOfShape_1());
  oc.TopExp.MapShapesAndAncestors(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_EDGE,
    oc.TopAbs_ShapeEnum.TopAbs_FACE,
    map,
  );
  const listOf = (list: unknown): unknown[] => {
    const copy = own(new oc.TopTools_ListOfShape_3(own(list)));
    const out: unknown[] = [];
    while (copy.Size() > 0) {
      out.push(own(copy.First_1()));
      copy.RemoveFirst();
    }
    return out;
  };
  const n = faces.Size() as number;
  const parent = Array.from({ length: n }, (_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i]!)));
  let freeEdges = 0;
  let freeEdgeLengthMm = 0;
  for (let e = 1; e <= map.Size(); e++) {
    const adjacent = listOf(map.FindFromIndex(e));
    const linked = adjacent.map((f) => faces.FindIndex(f) - 1);
    for (const f of linked.slice(1)) parent[root(f)] = root(linked[0]!);
    const edge = own(oc.TopoDS.Edge_1(own(map.FindKey(e))));
    const first = own(oc.TopoDS.Face_1(adjacent[0]));
    if (adjacent.some((f) => !(f as { IsSame(o: unknown): boolean }).IsSame(first))) continue;
    if (oc.BRep_Tool.IsClosed_2(edge, first) || oc.BRep_Tool.Degenerated(edge)) continue;
    freeEdges++;
    const props = own(new oc.GProp_GProps_1());
    oc.BRepGProp.LinearProperties(edge, props, false, false);
    freeEdgeLengthMm += props.Mass();
  }
  const connected = n > 0 && parent.every((_, i) => root(i) === root(0));
  return { connected, freeEdges, freeEdgeLengthMm };
}
