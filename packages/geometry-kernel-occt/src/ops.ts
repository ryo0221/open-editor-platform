import {
  geometryChildren,
  geometryOrder,
  geometryCross,
  geometryLimits,
  geometryUnit,
  validateGeometry,
  type GeometryFrame,
  type GeometryGraph,
  type GeometryIssue,
  type GeometryLoop,
  type GeometryRequest,
  type GeometryVec2,
  type GeometryVec3,
} from '@editor-platform/geometry-core';
import { vertexNormals } from './mesh';
import { decodeKernelException, type OcModule } from './module';

/** Triangles of one shape in model space, faces in the kernel's explorer order. */
export interface GeometryMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Per triangle, the 0-based index of its face. */
  faceIndices: Uint32Array;
}
export interface GeometryMeasure {
  volumeMm3: number;
  areaMm2: number;
  bounds: [GeometryVec3, GeometryVec3];
}
/** Two-dimensional segments in the view plane, as x0, y0, x1, y1 per segment. */
export interface GeometryProjection {
  visible: Float64Array;
  hidden: Float64Array;
}
export type GeometryResult =
  | {
      status: 'ok';
      node: string;
      mesh?: GeometryMesh;
      measure?: GeometryMeasure;
      /** The section's edges, each a polyline in model space (x, y, z per point). */
      section?: Float64Array[];
      projection?: GeometryProjection;
    }
  /** `node` is the node that failed, which may be an input of the requested one. */
  | { status: 'error'; node: string; code: string };

export type GeometryEvaluation =
  | { status: 'ok'; results: GeometryResult[] }
  | { status: 'invalid'; issues: GeometryIssue[] };

export interface GeometryEvaluateOptions {
  /** Normalized BRep assets by key (the `brep` op). */
  assets?: Map<string, Uint8Array>;
  /** Called between nodes; throwing (e.g. a cancel) stops the evaluation. */
  checkpoint?: (node: string) => void | Promise<void>;
}

class GeometryOpError extends Error {
  constructor(
    readonly code: string,
    readonly node: string,
  ) {
    super(`${code}@${node}`);
  }
}

/** Points per full turn of a circle in a section polyline. */
const sectionSegmentsPerTurn = 128;

/**
 * Runs a geometry graph (geometry-core's ops) and answers each request from the node it names.
 * The graph is validated first. Each node is built once per call; a failed node fails every
 * request that reads it, naming that node. Every handle is deleted before returning.
 */
export async function evaluateGeometry(
  oc: OcModule,
  graph: GeometryGraph,
  requests: GeometryRequest[],
  options: GeometryEvaluateOptions = {},
): Promise<GeometryEvaluation> {
  const issues = validateGeometry(graph, requests);
  if (issues.length) return { status: 'invalid', issues };
  const owned: { delete(): void }[] = [];
  const own = <T>(value: T): T => (owned.push(value as never), value);
  const pnt = (p: readonly number[]) => own(new oc.gp_Pnt_3(p[0], p[1], p[2]));
  const dir = (d: readonly number[]) => own(new oc.gp_Dir_4(d[0], d[1], d[2]));
  const vec = (v: readonly number[]) => own(new oc.gp_Vec_4(v[0], v[1], v[2]));
  const explore = (shape: unknown, kind: string, visit: (current: unknown) => void) => {
    const ex = own(
      new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum[kind], oc.TopAbs_ShapeEnum.TopAbs_SHAPE),
    );
    for (; ex.More(); ex.Next()) visit(own(ex.Current()));
  };
  /** Faces of no solid: a sheet body. */
  const sheetFaces = (shape: unknown, visit: (face: unknown) => void) => {
    const ex = own(
      new oc.TopExp_Explorer_2(
        shape,
        oc.TopAbs_ShapeEnum.TopAbs_FACE,
        oc.TopAbs_ShapeEnum.TopAbs_SOLID,
      ),
    );
    for (; ex.More(); ex.Next()) visit(own(ex.Current()));
  };
  const count = (shape: unknown, kind: string) => {
    let n = 0;
    explore(shape, kind, () => n++);
    return n;
  };
  const checked = (shape: unknown, node: string) => {
    if (!own(new oc.BRepCheck_Analyzer(shape, true, false)).IsValid_2())
      throw new GeometryOpError('invalid-shape', node);
    if (!count(shape, 'TopAbs_SOLID')) throw new GeometryOpError('empty-result', node);
    return shape;
  };

  /** A loop of a prism as a wire in its frame's plane, `ccw` seen from the frame's normal. */
  const wire = (
    loop: GeometryLoop,
    toModel: (p: GeometryVec2) => GeometryVec3,
    frame: GeometryFrame,
    ccw: boolean,
    node: string,
  ) => {
    const z = geometryUnit(frame.z);
    const area = loopArea(loop);
    const pts = area > 0 === ccw ? loop : reverseLoop(loop);
    const builder = own(new oc.BRepBuilderAPI_MakeWire_1());
    const builder0 = own(new oc.BRep_Builder());
    const vertices = pts.map((v) => {
      const vertex = own(new oc.TopoDS_Vertex());
      builder0.MakeVertex_2(vertex, pnt(toModel([v[0], v[1]])), geometryLimits.toleranceMm);
      return vertex;
    });
    pts.forEach((v, i) => {
      const j = (i + 1) % pts.length;
      const [a, b] = [vertices[i], vertices[j]];
      const bulge = v[2] ?? 0;
      let edge;
      if (!bulge) edge = own(new oc.BRepBuilderAPI_MakeEdge_2(a, b));
      else {
        const arc = arcOf([v[0], v[1]], [pts[j]![0], pts[j]![1]], bulge);
        const axis = own(
          new oc.gp_Ax2_3(pnt(toModel(arc.center)), dir(bulge > 0 ? z : [-z[0], -z[1], -z[2]])),
        );
        edge = own(
          new oc.BRepBuilderAPI_MakeEdge_11(own(new oc.gp_Circ_2(axis, arc.radius)), a, b),
        );
      }
      if (!edge.IsDone()) throw new GeometryOpError('loop-edge-failed', node);
      builder.Add_1(own(edge.Edge()));
      if (!builder.IsDone()) throw new GeometryOpError('loop-edge-failed', node);
    });
    return own(builder.Wire());
  };

  const shapes = new Map<string, unknown>();
  const failed = new Map<string, GeometryOpError>();
  // Children first, in a loop rather than by recursion, so a chain as long as the node limit
  // builds. The first failure stops the build; a node read from a failed one fails the same way.
  const build = async (root: string): Promise<unknown> => {
    for (const id of geometryOrder(graph, root)) {
      if (shapes.has(id)) continue;
      const prior =
        failed.get(id) ??
        geometryChildren(graph.nodes[id]!)
          .map((c) => failed.get(c))
          .find(Boolean);
      if (prior) throw prior;
      await options.checkpoint?.(id);
      try {
        shapes.set(id, make(id));
      } catch (error) {
        const e =
          error instanceof GeometryOpError ? error : new GeometryOpError(kernelCode(error), id);
        failed.set(id, e);
        throw e;
      }
    }
    return shapes.get(root);
  };
  const kernelCode = (error: unknown) => {
    const { type, message } = decodeKernelException(oc, error);
    return `kernel-exception:${type}${message ? `:${message}` : ''}`;
  };
  const progress = () => own(new oc.Message_ProgressRange_1());
  const make = (id: string): unknown => {
    const op = graph.nodes[id]!;
    switch (op.op) {
      case 'prism': {
        const f = op.frame;
        const z = geometryUnit(f.z);
        const x = geometryUnit(f.x);
        const y = geometryCross(z, x);
        const toModel = ([u, v]: GeometryVec2): GeometryVec3 => [
          f.origin[0] + u * x[0] + v * y[0],
          f.origin[1] + u * x[1] + v * y[1],
          f.origin[2] + u * x[2] + v * y[2],
        ];
        const plane = own(new oc.gp_Pln_3(pnt(f.origin), dir(z)));
        const face = own(
          new oc.BRepBuilderAPI_MakeFace_16(plane, wire(op.outer, toModel, f, true, id), true),
        );
        for (const hole of op.holes ?? []) face.Add(wire(hole, toModel, f, false, id));
        if (!face.IsDone()) throw new GeometryOpError('profile-face-failed', id);
        const prism = own(
          new oc.BRepPrimAPI_MakePrism_1(own(face.Face()), vec(op.vector), false, true),
        );
        if (!prism.IsDone()) throw new GeometryOpError('prism-failed', id);
        return checked(own(prism.Shape()), id);
      }
      case 'boolean': {
        const target = shapes.get(op.target);
        const Op = {
          union: oc.BRepAlgoAPI_Fuse_1,
          cut: oc.BRepAlgoAPI_Cut_1,
          common: oc.BRepAlgoAPI_Common_1,
        }[op.kind];
        const b = own(new Op());
        const list = (items: unknown[]) => {
          const l = own(new oc.TopTools_ListOfShape_1());
          for (const s of items) own(l.Append_1(s));
          return l;
        };
        b.SetArguments(list([target]));
        b.SetTools(list(op.tools.map((t) => shapes.get(t))));
        b.Build(progress());
        if (!b.IsDone() || b.HasErrors()) throw new GeometryOpError('boolean-failed', id);
        return checked(own(b.Shape()), id);
      }
      case 'halfSpace': {
        const n = geometryUnit(op.normal);
        // A face larger than any shape the limits allow stands for the whole plane.
        const reach = 4 * geometryLimits.coordinateMm;
        const face = own(
          new oc.BRepBuilderAPI_MakeFace_9(
            own(new oc.gp_Pln_3(pnt(op.origin), dir(n))),
            -reach,
            reach,
            -reach,
            reach,
          ),
        ).Face();
        // The reference point sits on the side the half-space keeps.
        const s = op.keep === 'above' ? 1 : -1;
        const ref = pnt([
          op.origin[0] + s * n[0],
          op.origin[1] + s * n[1],
          op.origin[2] + s * n[2],
        ]);
        const half = own(new oc.BRepPrimAPI_MakeHalfSpace_1(own(face), ref));
        const halfSolid = own(half.Solid());
        const keep = (input: unknown) => {
          const common = own(new oc.BRepAlgoAPI_Common_3(input, halfSolid, progress()));
          if (!common.IsDone() || common.HasErrors())
            throw new GeometryOpError('half-space-failed', id);
          return own(common.Shape());
        };
        const valid = (shape: unknown) =>
          own(new oc.BRepCheck_Analyzer(shape, true, false)).IsValid_2() as boolean;
        const input = shapes.get(op.input);
        // A sheet body (faces of no solid) keeps its faces on that side, beside a solid or not:
        // empty only when no face is left.
        let sheet = 0;
        sheetFaces(input, () => sheet++);
        const solids: unknown[] = [];
        explore(input, 'TopAbs_SOLID', (s) => solids.push(s));
        if (solids.length > 1) {
          // Solids that overlap (a part's bodies) are not one valid shape when cut together:
          // each is cut alone and checked, and what is kept of each is one compound.
          const builder = own(new oc.BRep_Builder());
          const compound = own(new oc.TopoDS_Compound());
          builder.MakeCompound(compound);
          let left = 0;
          for (const solid of solids) {
            const piece = keep(solid);
            if (!count(piece, 'TopAbs_SOLID')) continue;
            if (!valid(piece)) throw new GeometryOpError('invalid-shape', id);
            builder.Add(compound, piece);
            left++;
          }
          if (sheet) {
            const faces = own(new oc.TopoDS_Compound());
            builder.MakeCompound(faces);
            sheetFaces(input, (f) => builder.Add(faces, f));
            const piece = keep(faces);
            if (!valid(piece)) throw new GeometryOpError('invalid-shape', id);
            if (count(piece, 'TopAbs_FACE')) {
              builder.Add(compound, piece);
              left++;
            }
          }
          if (!left) throw new GeometryOpError('empty-result', id);
          return compound;
        }
        const kept = keep(input);
        if (sheet) {
          if (!valid(kept)) throw new GeometryOpError('invalid-shape', id);
          if (!count(kept, 'TopAbs_FACE')) throw new GeometryOpError('empty-result', id);
          return kept;
        }
        return checked(kept, id);
      }
      case 'transform': {
        const trsf = own(new oc.gp_Trsf_1());
        trsf.SetTransformation_3(
          own(new oc.gp_Quaternion_2(...quaternion(op.rotation))),
          vec(op.translation),
        );
        const builder = own(new oc.BRepBuilderAPI_Transform_2(shapes.get(op.input), trsf, true));
        return own(builder.Shape());
      }
      case 'bodies': {
        const found: unknown[] = [];
        if (op.kind === 'solid')
          explore(shapes.get(op.input), 'TopAbs_SOLID', (b) => found.push(b));
        else sheetFaces(shapes.get(op.input), (f) => found.push(f));
        if (!found.length) throw new GeometryOpError('empty-result', id);
        // Solids stay apart (fusing a part's bodies took most of a drawing's time): a section
        // outlines overlapping solids once.
        const builder = own(new oc.BRep_Builder());
        const compound = own(new oc.TopoDS_Compound());
        builder.MakeCompound(compound);
        for (const b of found) builder.Add(compound, b);
        return compound;
      }
      case 'compound': {
        const builder = own(new oc.BRep_Builder());
        const compound = own(new oc.TopoDS_Compound());
        builder.MakeCompound(compound);
        for (const input of op.inputs) builder.Add(compound, shapes.get(input));
        return compound;
      }
      case 'brep': {
        const bytes = options.assets?.get(op.asset);
        if (!bytes) throw new GeometryOpError('asset-missing', id);
        const path = '/g.brep';
        try {
          oc.FS.writeFile(path, bytes);
          const shape = own(new oc.TopoDS_Shape());
          if (!oc.BRepTools.Read_2(shape, path, own(new oc.BRep_Builder()), progress()))
            throw new GeometryOpError('asset-unreadable', id);
          return shape;
        } finally {
          if (oc.FS.analyzePath(path).exists) oc.FS.unlink(path);
        }
      }
    }
  };

  const triangulate = (shape: unknown, deflection: number, angular: number) =>
    own(new oc.BRepMesh_IncrementalMesh_2(shape, deflection, false, angular, false));
  const mesh = (shape: unknown, deflection: number, angular: number): GeometryMesh => {
    triangulate(shape, deflection, angular);
    const positions: number[] = [];
    const indices: number[] = [];
    const faceIndices: number[] = [];
    let index = 0;
    explore(shape, 'TopAbs_FACE', (current) => {
      const face = own(oc.TopoDS.Face_1(current));
      const loc = own(new oc.TopLoc_Location_1());
      const handle = own(oc.BRep_Tool.Triangulation(face, loc, 0));
      const offset = positions.length / 3;
      if (!handle.IsNull()) {
        const tri = handle.get();
        const trsf = own(loc.Transformation());
        for (let i = 1; i <= tri.NbNodes(); i++) {
          const p = own(own(tri.Node(i)).Transformed(trsf));
          positions.push(p.X(), p.Y(), p.Z());
        }
        const reversed = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
        for (let i = 1; i <= tri.NbTriangles(); i++) {
          const t = own(tri.Triangle(i));
          const [a, b, c] = [t.Value(1), t.Value(2), t.Value(3)].map((n: number) => offset + n - 1);
          indices.push(...(reversed ? [a, c, b] : [a, b, c]));
          faceIndices.push(index);
        }
      }
      index++;
    });
    const pos = new Float32Array(positions);
    return {
      positions: pos,
      normals: vertexNormals(pos, indices),
      indices: new Uint32Array(indices),
      faceIndices: new Uint32Array(faceIndices),
    };
  };
  const measure = (shape: unknown): GeometryMeasure => {
    const volume = own(new oc.GProp_GProps_1());
    oc.BRepGProp.VolumeProperties_1(shape, volume, false, false, false);
    const surface = own(new oc.GProp_GProps_1());
    oc.BRepGProp.SurfaceProperties_1(shape, surface, false, false);
    const box = own(new oc.Bnd_Box_1());
    oc.BRepBndLib.AddOptimal(shape, box, false, false);
    const [min, max] = [own(box.CornerMin()), own(box.CornerMax())];
    return {
      volumeMm3: volume.Mass(),
      areaMm2: surface.Mass(),
      bounds: [
        [min.X(), min.Y(), min.Z()],
        [max.X(), max.Y(), max.Z()],
      ],
    };
  };
  /** An edge as a polyline: its two ends when straight, else points along its curve. */
  const polyline = (shape: unknown): Float64Array => {
    const edge = own(oc.TopoDS.Edge_1(shape));
    const first = own(new oc.TopoDS_Vertex());
    const last = own(new oc.TopoDS_Vertex());
    oc.TopExp.Vertices_1(edge, first, last, false);
    const handle = own(oc.BRep_Tool.Curve_2(edge, 0, 0));
    // An edge without a 3D curve (the hidden-line algorithm's segments) is straight between its ends.
    if (handle.IsNull()) {
      const ends = [first, last].map((v) => own(oc.BRep_Tool.Pnt(v)));
      return new Float64Array(ends.flatMap((p) => [p.X(), p.Y(), p.Z()]));
    }
    const t0 = oc.BRep_Tool.Parameter_2(first, edge) as number;
    const t1 = oc.BRep_Tool.Parameter_2(last, edge) as number;
    const curve = handle.get();
    const type = own(curve.DynamicType()).get().Name() as string;
    const n =
      type === 'Geom_Line'
        ? 1
        : Math.max(2, Math.ceil((Math.abs(t1 - t0) / (2 * Math.PI)) * sectionSegmentsPerTurn));
    const out = new Float64Array((n + 1) * 3);
    for (let i = 0; i <= n; i++) {
      const p = own(curve.Value(t0 + ((t1 - t0) * i) / n));
      out.set([p.X(), p.Y(), p.Z()], i * 3);
    }
    return out;
  };
  const section = (shape: unknown, origin: GeometryVec3, normal: GeometryVec3): Float64Array[] => {
    const plane = own(new oc.gp_Pln_3(pnt(origin), dir(geometryUnit(normal))));
    const lines: Float64Array[] = [];
    const edges = (input: unknown) => {
      const cut = own(new oc.BRepAlgoAPI_Section_5(input, plane, false));
      cut.Approximation(false);
      cut.Build(progress());
      if (!cut.IsDone() || cut.HasErrors()) throw new GeometryOpError('section-failed', '');
      explore(own(cut.Shape()), 'TopAbs_EDGE', (edge) => lines.push(polyline(edge)));
    };
    const solids: unknown[] = [];
    explore(shape, 'TopAbs_SOLID', (s) => solids.push(s));
    if (solids.length <= 1) {
      edges(shape);
      return lines;
    }
    // Solids that overlap are one material: each solid's cut face is made alone, the faces are
    // fused in the plane, and only the edges of one face are the outline. Fusing the faces is
    // far cheaper than fusing the solids.
    const reach = 4 * geometryLimits.coordinateMm;
    const face = own(
      own(new oc.BRepBuilderAPI_MakeFace_9(plane, -reach, reach, -reach, reach)).Face(),
    );
    const faces: unknown[] = [];
    for (const solid of solids) {
      const common = own(new oc.BRepAlgoAPI_Common_3(solid, face, progress()));
      if (!common.IsDone() || common.HasErrors()) throw new GeometryOpError('section-failed', '');
      explore(own(common.Shape()), 'TopAbs_FACE', (f) => faces.push(f));
    }
    const list = (items: unknown[]) => {
      const l = own(new oc.TopTools_ListOfShape_1());
      for (const s of items) own(l.Append_1(s));
      return l;
    };
    if (faces.length) {
      // One cut face (the plane meets one solid) is its own outline.
      let cut = faces[0];
      if (faces.length > 1) {
        const fuse = own(new oc.BRepAlgoAPI_Fuse_1());
        fuse.SetArguments(list([faces[0]]));
        fuse.SetTools(list(faces.slice(1)));
        fuse.Build(progress());
        if (!fuse.IsDone() || fuse.HasErrors()) throw new GeometryOpError('section-failed', '');
        cut = own(fuse.Shape());
      }
      const ancestors = own(new oc.TopTools_IndexedDataMapOfShapeListOfShape_1());
      oc.TopExp.MapShapesAndAncestors(
        cut,
        oc.TopAbs_ShapeEnum.TopAbs_EDGE,
        oc.TopAbs_ShapeEnum.TopAbs_FACE,
        ancestors,
      );
      for (let i = 1; i <= (ancestors.Extent() as number); i++)
        if (own(ancestors.FindFromIndex(i)).Extent() === 1)
          lines.push(polyline(own(ancestors.FindKey(i))));
    }
    // The sheet's faces are cut as they are: a line each.
    const sheet: unknown[] = [];
    sheetFaces(shape, (f) => sheet.push(f));
    if (sheet.length) {
      const builder = own(new oc.BRep_Builder());
      const compound = own(new oc.TopoDS_Compound());
      builder.MakeCompound(compound);
      for (const f of sheet) builder.Add(compound, f);
      edges(compound);
    }
    return lines;
  };
  const projection = (
    shape: unknown,
    p: NonNullable<GeometryRequest['projection']>,
  ): GeometryProjection => {
    triangulate(shape, p.deflectionMm, p.angularDeflectionRad);
    const d = geometryUnit(p.direction);
    // The view's frame: z towards the viewer, y along `up` made normal to z.
    const z: GeometryVec3 = [-d[0], -d[1], -d[2]];
    const x = geometryUnit(geometryCross(geometryUnit(p.up), z));
    const ax = own(new oc.gp_Ax2_2(pnt([0, 0, 0]), dir(z), dir(x)));
    const algo = new oc.HLRBRep_PolyAlgo_1();
    const handle = own(new oc.Handle_HLRBRep_PolyAlgo_2(algo));
    algo.Projector_2(own(new oc.HLRAlgo_Projector_2(ax)));
    algo.Load(shape);
    algo.Update();
    const toShape = own(new oc.HLRBRep_PolyHLRToShape());
    toShape.Update(handle);
    const segments = (compounds: unknown[]) => {
      const out: number[] = [];
      for (const c of compounds) {
        if (!c || own(c as { IsNull(): boolean }).IsNull()) continue;
        explore(c, 'TopAbs_EDGE', (edge) => {
          const line = polyline(edge);
          for (let i = 0; i + 3 < line.length; i += 3)
            out.push(line[i]!, line[i + 1]!, line[i + 3]!, line[i + 4]!);
        });
      }
      return new Float64Array(out);
    };
    return {
      visible: segments([toShape.VCompound_1(), toShape.OutLineVCompound_1()]),
      hidden: segments([toShape.HCompound_1(), toShape.OutLineHCompound_1()]),
    };
  };

  try {
    const results: GeometryResult[] = [];
    for (const r of requests) {
      let shape: unknown;
      try {
        shape = await build(r.node);
      } catch (error) {
        if (!(error instanceof GeometryOpError)) throw error;
        results.push({ status: 'error', node: error.node, code: error.code });
        continue;
      }
      try {
        results.push({
          status: 'ok',
          node: r.node,
          ...(r.measure ? { measure: measure(shape) } : {}),
          ...(r.section ? { section: section(shape, r.section.origin, r.section.normal) } : {}),
          ...(r.projection ? { projection: projection(shape, r.projection) } : {}),
          // Last: the projection's and this mesh's triangulations differ, and this one stays.
          ...(r.mesh
            ? { mesh: mesh(shape, r.mesh.deflectionMm, r.mesh.angularDeflectionRad) }
            : {}),
        });
      } catch (error) {
        const code = error instanceof GeometryOpError ? error.code : kernelCode(error);
        results.push({ status: 'error', node: r.node, code });
      }
    }
    return { status: 'ok', results };
  } finally {
    for (const o of owned.reverse()) o.delete();
  }
}

function loopArea(loop: GeometryLoop): number {
  let a = 0;
  loop.forEach((v, i) => {
    const w = loop[(i + 1) % loop.length]!;
    a += v[0] * w[1] - w[0] * v[1];
    // An arc adds its circular segment: positive for a counter-clockwise bulge.
    const b = v[2] ?? 0;
    if (b) {
      const { radius, sweep } = arcOf([v[0], v[1]], [w[0], w[1]], b);
      a += radius * radius * (sweep - Math.sin(sweep));
    }
  });
  return a / 2;
}
/** The same loop walked the other way: each arc's bulge moves to its new start and flips. */
function reverseLoop(loop: GeometryLoop): GeometryLoop {
  const n = loop.length;
  return loop.map((_, k) => {
    const v = loop[(n - k) % n]!;
    const before = loop[(2 * n - k - 1) % n]!;
    return before[2] ? [v[0], v[1], -before[2]] : [v[0], v[1]];
  });
}
/** The circle of an arc from p to q with `bulge` (tan of a quarter of its signed sweep). */
function arcOf(p: GeometryVec2, q: GeometryVec2, bulge: number) {
  const sweep = 4 * Math.atan(bulge);
  const [cx, cy] = [q[0] - p[0], q[1] - p[1]];
  const c = Math.hypot(cx, cy);
  const radius = c / (2 * Math.abs(Math.sin(sweep / 2)));
  // The centre lies left of the chord for a sweep under a half turn counter-clockwise.
  const h = c / 2 / Math.tan(sweep / 2);
  const center: GeometryVec2 = [(p[0] + q[0]) / 2 - (cy / c) * h, (p[1] + q[1]) / 2 + (cx / c) * h];
  return { center, radius, sweep };
}
/** The unit quaternion (x, y, z, w) of a row-major rotation matrix. */
function quaternion(r: number[]): [number, number, number, number] {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = r as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
}
