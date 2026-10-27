import {
  decodeKernelException,
  KernelJobCancelled,
  vertexNormals,
  type OcModule,
} from '@editor-platform/geometry-kernel-occt';
import {
  attachFrame,
  cadContentHash,
  dependencyEdges,
  dependencyOrder,
  featureKind,
  loopArea,
  sketchAttachment,
  featureReferenceSources,
  cadLimits,
  cadToleranceSetOf,
  sketchPath,
  sketchRegion,
  sketchElementPoints,
  sketchElement,
  pathPlacements,
  pathSamples,
  splineKnots,
  splinePoints,
  splineSelfIntersects,
  identityQuaternion,
  isLiteralPosition,
  parameterValues,
  position,
  resolveAngle,
  resolveCount,
  resolveRatio,
  resolveLength,
  resolvePosition,
  blendFaceName,
  faceNameKey,
  sharedFaceName,
  cadReferenceCandidates,
  prefixFaceName,
  resolveTopologyRef,
  topologyRefOf,
  elementGeometry,
  upstreamFeatures,
  type CadConnectorFrame,
  type CadReferenceProblem,
  type CadTopologyRef,
  type CadBodyEvaluation,
  type CadAppearance,
  type CadBodyKind,
  type CadFaceName,
  type CadTopologyTable,
  type CadDocument,
  type CadEvaluation,
  type CadFeature,
  type CadProfile,
  type CadSketch,
  type CadSketchPath,
  type CadEdgeChain,
  type CadCurveSource,
  curveBoundaryName,
  cutBoundaryName,
  edgeSideName,
  elementName,
  thickenSideName,
  type CadTopoName,
  type CadSketchRegion,
  type CadSketchSection,
  type CadDerivedSection,
  type Length,
  type Quaternion,
  type Vec3,
} from '@editor-platform/cad-core';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { connectorFrame } from './connector-frames';
import { edgeContinuity } from './continuity';
import { edgeComb, nodeCurvature } from './curvature';
import {
  cadOutputLimits,
  meshBytes,
  type CadBrepExport,
  type CadCombResult,
  type CadContinuityResult,
  type CadMesh,
} from './protocol';
import { withToleranceNote } from './formats';
import { shapeMetrics } from './metrics';
import { sheetTopology } from './sheet-topology';

/** The Embind module and its exception decoding live in `geometry-kernel-occt` (R2c-1). */
export { decodeKernelException, type OcModule };

export class CadKernelError extends Error {
  constructor(
    readonly code: string,
    readonly featureId?: string,
    readonly retryable = false,
    /** References that did not resolve (`reference-ambiguous` / `reference-missing`). */
    readonly references?: CadReferenceProblem[],
    /** Paths in the feature's args of the references the kernel could not build. */
    readonly failedPaths?: (string | number)[][],
    /** `sew-gap`: the input edges left apart, by the input's feature and the edge's name. */
    readonly edges?: { featureId: string; name: CadTopoName }[],
  ) {
    super(featureId ? `${code}@${featureId}` : code);
  }
}
/** Thrown when a cooperative cancel point sees the job was cancelled. */
export class CadEvaluationCancelled extends KernelJobCancelled {}

export interface EvaluateOptions {
  /** Absolute linear deflection (mm) for every body, for an export triangulation. */
  deflectionMm?: number;
  /**
   * `false`: stop at the first failure with nothing to show (U4), as an export does; for a
   * substitute build's reference display, which never gives measurements.
   */
  partial?: false;
  /** Linear deflection of the display mesh as a share of each body's bounding-box diagonal. */
  relativeDeflection?: number;
  angularDeflectionRad?: number;
  /**
   * Cooperative cancel point before each feature and each body's mesh, named by that feature or
   * body ID; must yield to a macrotask, not a microtask.
   */
  checkpoint?: (elementId: string) => Promise<void>;
  /** Also write the active bodies' exact shapes as STEP (AP214, mm). */
  step?: true;
  /**
   * Also write the active bodies' exact shapes as one normalized BRep (a compound), the shape a
   * building places as a part (docs/cad/r2c-architecture.md, part; R2c-U2).
   */
  brep?: true;
  /**
   * R2b-4 (LOD): also a coarse display mesh of each body (`lod: 'coarse'`, `meshLod`), after
   * the standard one. Display only: the evaluation, its digest and the standard mesh are the same.
   */
  coarse?: true;
  /**
   * Also sample the continuity of one edge between two faces (R2a-4): the edge at `edge` in
   * body `bodyId`'s pick table (`topology.edges`). Display only; the evaluation is unchanged.
   */
  continuity?: { bodyId: string; edge: number };
  /**
   * Also give each mesh the mean and Gauss curvature at its nodes (R2a-4), from the faces' exact
   * surfaces. Display only: not part of the evaluation or its geometry digest.
   */
  curvature?: true;
  /** Also sample the curvature comb of one edge's curve, like `continuity` (R2a-4). */
  comb?: { bodyId: string; edge: number };
  /**
   * D2 asset bytes by `sha256:<hex>`, from the Host's closure. Imported features read their
   * normalized BRep here; bytes that do not match the ref's hash and size are refused.
   */
  assets?: ReadonlyMap<string, Uint8Array>;
  /**
   * Opt-in timing for the performance harness (experiments/cad-perf): milliseconds spent building
   * each feature, and meshing each body (properties and tessellation), checkpoints excluded.
   */
  timing?: (phase: 'feature' | 'mesh', elementId: string, ms: number) => void;
  /**
   * R2b-2: references on the active bodies' results whose connector frames the evaluation
   * returns, in this order (`connectors`), in this document's coordinates.
   */
  connectors?: readonly CadTopologyRef[];
  /**
   * The Worker's literal-placement cache (CAD25). Used and refreshed only by display
   * evaluations: an export triangulation or STEP always evaluates the full graph.
   */
  placement?: PlacementCache;
  /**
   * The Worker's dependency-closure cache (docs/cad/complex-models.md, P1・P2; CM-3): each
   * feature's shape by the hash of what it reads. Used and refreshed only by display
   * evaluations, like `placement`; with it, `placement` borrows its kept shapes from this cache.
   */
  features?: FeatureCache;
  /**
   * CM-4 (P3): once `ms` have passed since the evaluation (or its last pause) started, it pauses
   * before the next feature it has to build or the next body's mesh: `pause` is awaited with
   * the steps done of all (features and sketches in dependency order, then the meshed bodies).
   * The evaluation goes on where it was, with all it has built, when `pause` resolves; a
   * `CadEvaluationCancelled` from it ends the evaluation like a cancel.
   */
  slice?: { ms: number; now?: () => number; pause(done: number, total: number): Promise<void> };
}

type Shape = { delete(): void; isDeleted?(): boolean };
/**
 * A kept shape with its face names in the kernel's face-map order and a sheet's boundary names
 * by edge-map index (both deterministic per shape).
 */
type KeptBody = {
  shape: Shape;
  names: (CadFaceName | null)[];
  edges: { index: number; name: CadFaceName }[];
  placed: boolean;
  deflectionMm: number;
  /** The shape belongs to a `FeatureCache` (CM-3), which deletes it. */
  borrowed?: true;
};
/**
 * The literal-placement fast path (docs/cad/operations.md, 最終placementだけを変える経路; CAD25).
 * The Worker keeps, from its last full display evaluation, each active body's shape before its
 * own final placement (or its final shape, when that placement is bound to a parameter), keyed
 * by the document with those literal placements cleared. A document that differs from it only
 * in them applies each new absolute pose to the kept shape instead of evaluating the feature
 * graph again; never to an earlier placed result. Kept shapes are never changed.
 */
export class PlacementCache {
  key: string | undefined;
  bodies = new Map<string, KeptBody>();
  /** Some kept shapes are a `FeatureCache`'s: they may leave it at its next evaluation. */
  get borrowed() {
    return [...this.bodies.values()].some((b) => b.borrowed);
  }
  release() {
    // Two bodies may keep the same shape: each handle is deleted once.
    for (const shape of new Set(
      [...this.bodies.values()].filter((b) => !b.borrowed).map((b) => b.shape),
    ))
      if (!shape.isDeleted?.()) shape.delete();
    this.bodies.clear();
    this.key = undefined;
  }
}

/**
 * How the feature cache counts what it keeps (CM-U6): an estimate from each shape's topology,
 * against a budget of 128 MiB of the Wasm heap. Both are provisional until verification fixes
 * them; neither is a performance guarantee.
 */
export const featureCacheBudget = Object.freeze({
  bytes: 128 * 2 ** 20,
  perFace: 4096,
  perEdge: 1024,
  perVertex: 256,
});
type CachedFeature = {
  shape: Shape;
  names: (CadFaceName | null)[];
  edges: { index: number; name: CadFaceName }[];
  /** The shape's tolerances as built (`toleranceState`): a reuse finds it unchanged. */
  state: string;
  bytes: number;
  used: number;
};
/**
 * The dependency-closure cache (docs/cad/complex-models.md, P1; CM-3). A display evaluation
 * keeps each feature it built, keyed by the hash of the feature, the parameters and profiles it
 * reads, the kernel profile, and the keys of the features and sketches it reads; a later one
 * builds only the features whose key changed, which are the edited ones and those downstream.
 * The shapes of the latest evaluation are always kept; older ones go least recently used first
 * once the estimate passes the budget.
 * OCCT's algorithms may raise their inputs' tolerances in place, so the full graph builds each
 * feature from its inputs as the features before it left them. A shape is kept only when its
 * feature found its inputs as they were built and left them so; it is reused only while it and
 * its inputs are still as they were built. Otherwise it is built again, as the full graph would
 * build it. A reuse removes the triangulation an earlier mesh left (display only).
 */
export class FeatureCache {
  readonly entries = new Map<string, CachedFeature>();
  #clock = 0;
  constructor(readonly budgetBytes: number = featureCacheBudget.bytes) {}
  get bytes() {
    let n = 0;
    for (const e of this.entries.values()) n += e.bytes;
    return n;
  }
  get(key: string) {
    const e = this.entries.get(key);
    if (e) e.used = ++this.#clock;
    return e;
  }
  put(key: string, e: Omit<CachedFeature, 'used'>) {
    this.entries.set(key, { ...e, used: ++this.#clock });
  }
  drop(key: string) {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    this.#drop(e.shape);
  }
  /** Keeps the entries `latest` names and, within the budget, the most recently used others. */
  settle(latest: ReadonlySet<string>) {
    let bytes = this.bytes;
    const old = [...this.entries]
      .filter(([k]) => !latest.has(k))
      .sort((a, b) => a[1].used - b[1].used);
    for (const [key, e] of old) {
      if (bytes <= this.budgetBytes) break;
      bytes -= e.bytes;
      this.drop(key);
    }
  }
  release() {
    const shapes = new Set([...this.entries.values()].map((e) => e.shape));
    this.entries.clear();
    for (const shape of shapes) if (!shape.isDeleted?.()) shape.delete();
  }
  /** Two features may keep the same shape: it is deleted with the last entry that keeps it. */
  #drop(shape: Shape) {
    for (const e of this.entries.values()) if (e.shape === shape) return;
    if (!shape.isDeleted?.()) shape.delete();
  }
}
/**
 * The cache identity: the document with each movable placement (an active body's own final
 * transform, literal and with nothing downstream) and its assembly fields cleared, and the
 * display mesh settings.
 * `isolated` is false when two active bodies read a common feature: their shapes then share
 * faces, and so one triangulation that the later body's mesh refines, which a kept shape would
 * carry into the earlier body's next mesh. Such documents always evaluate the full graph.
 */
export function placementIdentity(doc: CadDocument, options: EvaluateOptions = {}) {
  const read = new Set<string>();
  let isolated = true;
  // A sketch's plane is read from the face it is attached to, sharing no face with it.
  for (const body of doc.bodies)
    if (body.state === 'active')
      for (const id of upstreamFeatures(doc.features, [body.resultFeatureId])) {
        if (read.has(id)) isolated = false;
        read.add(id);
      }
  // A placement a sketch is attached to moves that sketch too: it is not movable.
  const used = new Set([
    ...doc.features.flatMap((f) => f.inputFeatureIds as string[]),
    ...doc.sketches.map(sketchAttachment),
    ...doc.features.flatMap(featureReferenceSources),
  ]);
  const cleared = structuredClone(doc);
  // Placed parts, joints and their solved poses never change this document's own shapes.
  cleared.parts = [];
  cleared.components = [];
  cleared.joints = [];
  cleared.solvedPoses = {};
  const features = new Map(cleared.features.map((f) => [f.id, f]));
  const movable = new Set<string>();
  for (const body of cleared.bodies) {
    const f = features.get(body.resultFeatureId);
    if (body.state !== 'active' || f?.type !== 'transform' || used.has(f.id)) continue;
    if (!isLiteralPosition(f.args.translation)) continue;
    movable.add(body.id);
    f.args = { translation: position(0, 0, 0), rotation: identityQuaternion() };
  }
  const mesh = `${options.relativeDeflection ?? meshDeflection.relative} ${options.angularDeflectionRad ?? 0.5}`;
  return { key: `${cadContentHash(cleared)} ${mesh}`, movable, isolated };
}

/**
 * Display mesh deflection: 0.1% of the body's bounding-box diagonal, so the triangle count does
 * not grow with the model's size (a fixed 0.05 mm made a 3.6 m sphere run for minutes, #372).
 * The floor keeps tiny bodies above the kernel's confusion tolerance.
 */
export const meshDeflection = Object.freeze({ relative: 0.001, minMm: 0.001 });
/** R2b-4: the coarse display mesh, 1% of the bounding-box diagonal and 1 rad (LOD). */
export const meshLod = Object.freeze({ coarse: { relative: 0.01, angularRad: 1 } });
export function displayDeflectionMm(
  bounds: readonly [Vec3, Vec3],
  relative: number = meshDeflection.relative,
): number {
  const [min, max] = bounds;
  const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  return Math.max(diagonal * relative, meshDeflection.minMm);
}

/**
 * Full-graph evaluation in stable topological order. Every feature must yield one valid solid
 * within the profile's result tolerance. Every handle created here is deleted before returning,
 * including on error or cancel.
 */
export async function evaluateCad(
  oc: OcModule,
  doc: CadDocument,
  contentHash: string,
  options: EvaluateOptions = {},
): Promise<{
  evaluation: CadEvaluation;
  meshes: CadMesh[];
  step?: Uint8Array;
  brep?: CadBrepExport;
  continuity?: CadContinuityResult;
  comb?: CadCombResult;
}> {
  // Every Embind wrapper is owned, including ones returned by builders (.Shape(), ex.Current()):
  // deleting a builder does not delete them. A Set keeps own() idempotent.
  const owned = new Set<{ delete(): void; isDeleted?(): boolean }>();
  const own = <T>(value: T): T => (owned.add(value as never), value);
  const params = parameterValues(doc);
  const len = (l: Length) => resolveLength(l, params);
  const pnt = (x: number, y: number, z: number) => own(new oc.gp_Pnt_3(x, y, z));
  /**
   * A spline element as an edge in its sketch's plane (z = 0): uniform knots from `splineKnots`,
   * periodic when closed, the poles reversed to run backwards. An open one ends at the given
   * vertices (its end poles). A spline that crosses itself is refused for `featureId`.
   */
  const splineEdge = (
    featureId: string,
    e: Parameters<typeof splineSelfIntersects>[0] & {
      poles: readonly (readonly number[])[];
      degree: number;
    },
    closed: boolean,
    forward: boolean,
    ends?: [unknown, unknown],
  ) => {
    // Validation refuses a crossing spline; the kernel never builds one.
    if (splineSelfIntersects(e)) throw new CadKernelError('sketch-self-intersection', featureId);
    const poles = forward ? e.poles : [...e.poles].reverse();
    const { knots, mults } = splineKnots(poles.length, e.degree, closed);
    const array = own(new oc.TColgp_Array1OfPnt_2(1, poles.length));
    poles.forEach(([u, v], i) => array.SetValue(i + 1, pnt(u!, v!, 0)));
    const k = own(new oc.TColStd_Array1OfReal_2(1, knots.length));
    const m = own(new oc.TColStd_Array1OfInteger_2(1, mults.length));
    knots.forEach((x, i) => k.SetValue(i + 1, x));
    mults.forEach((x, i) => m.SetValue(i + 1, x));
    const curve = own(
      new oc.Handle_Geom_Curve_2(new oc.Geom_BSplineCurve_1(array, k, m, e.degree, closed)),
    );
    return ends
      ? new oc.BRepBuilderAPI_MakeEdge_27(curve, ends[0], ends[1])
      : new oc.BRepBuilderAPI_MakeEdge_24(curve);
  };
  const explore = (shape: unknown, kind: string, visit: (current: unknown) => void) => {
    const ex = own(
      new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum[kind], oc.TopAbs_ShapeEnum.TopAbs_SHAPE),
    );
    for (; ex.More(); ex.Next()) visit(own(ex.Current()));
  };
  /**
   * Builds before R1 (retained for their documents) have no shape maps or history: they evaluate
   * as before, with no names and no edge table.
   */
  const naming = typeof oc.TopTools_IndexedMapOfShape_1 === 'function';
  type ShapeMap = { Size(): number; FindKey(i: number): unknown; FindIndex(s: unknown): number };
  /** The shape's sub-shapes of one kind, each once, in the kernel's map order (1-based). */
  const shapeMap = (shape: unknown, kind: string): ShapeMap => {
    if (naming) {
      const map = own(new oc.TopTools_IndexedMapOfShape_1());
      oc.TopExp.MapShapes_1(shape, oc.TopAbs_ShapeEnum[kind], map);
      return map;
    }
    const list: { IsSame(o: unknown): boolean }[] = [];
    explore(shape, kind, (s) => {
      if (!list.some((k) => k.IsSame(s))) list.push(s as (typeof list)[number]);
    });
    return {
      Size: () => list.length,
      FindKey: (i) => list[i - 1],
      FindIndex: (s) => list.findIndex((k) => k.IsSame(s)) + 1,
    };
  };
  /** A TopTools_ListOfShape as an array, read from a copy (no list iterator is bound). */
  const listOf = (list: unknown): unknown[] => {
    own(list);
    const copy = own(new oc.TopTools_ListOfShape_3(list));
    const out: unknown[] = [];
    while (copy.Size() > 0) {
      out.push(own(copy.First_1()));
      copy.RemoveFirst();
    }
    return out;
  };
  const centroid = (props: { CentreOfMass(): unknown }): Vec3 => {
    const c = own(props.CentreOfMass()) as { X(): number; Y(): number; Z(): number };
    return [c.X(), c.Y(), c.Z()];
  };
  const faceProps = (face: unknown) => {
    const props = own(new oc.GProp_GProps_1());
    oc.BRepGProp.SurfaceProperties_1(face, props, false, false);
    return { centroid: centroid(props), area: props.Mass() as number };
  };
  /**
   * A feature's output with its face names (docs/cad/r1-modeling.md, 命名), aligned with the
   * face map. A face no rule names (an imported body's) is null and cannot be referenced.
   */
  type Named = {
    shape: unknown;
    faces: ShapeMap;
    names: (CadFaceName | null)[];
    /** A sheet's named boundaries: free edges and the name each borders (`boundaryNames`). */
    edges?: { edge: unknown; name: CadFaceName }[];
  };
  const named = (shape: unknown, nameOf: (face: unknown) => CadFaceName | null): Named => {
    const faces = shapeMap(shape, 'TopAbs_FACE');
    const names = [];
    for (let i = 1; i <= faces.Size(); i++)
      names.push(naming ? nameOf(own(faces.FindKey(i))) : null);
    return { shape, faces, names };
  };
  /**
   * Names of `result` carried from `from` through the kernel's history: each named face of
   * `from` names its images in `result`. A face that already has a name keeps it.
   */
  const carry = (
    result: Named | unknown,
    from: Named,
    image: (face: unknown) => unknown[],
    rename: (name: CadFaceName) => CadFaceName = (n) => n,
  ): Named => {
    const out =
      result && typeof result === 'object' && 'names' in result
        ? (result as Named)
        : named(result, () => null);
    if (!naming) return out;
    for (let i = 1; i <= from.faces.Size(); i++) {
      const name = from.names[i - 1];
      if (!name) continue;
      for (const face of image(own(from.faces.FindKey(i)))) {
        const j = out.faces.FindIndex(face);
        if (j > 0 && !out.names[j - 1]) out.names[j - 1] = rename(name);
      }
    }
    for (const { edge, name } of from.edges ?? [])
      for (const made of image(edge)) (out.edges ??= []).push({ edge: made, name: rename(name) });
    return out;
  };
  /**
   * Tool names carried into a Boolean's result after the target's (whose names win): each tool's
   * faces get its prefix, and a face that is an image of several tool faces (coincident faces) is
   * named by all of them (`shared:`), so neither the tools' order nor their IDs pick one.
   */
  const carryTools = (
    out: Named,
    tools: { tool: Named; prefix: string }[],
    image: (face: unknown) => unknown[],
  ): Named => {
    if (!naming) return out;
    const found = new Map<number, Map<string, CadFaceName>>();
    for (const { tool, prefix } of tools)
      for (let i = 1; i <= tool.faces.Size(); i++) {
        const name = tool.names[i - 1];
        if (!name) continue;
        const full = prefix ? prefixFaceName(prefix, name) : name;
        for (const face of image(own(tool.faces.FindKey(i)))) {
          const j = out.faces.FindIndex(face);
          if (j < 1 || out.names[j - 1]) continue;
          const names = found.get(j) ?? new Map<string, CadFaceName>();
          found.set(j, names.set(faceNameKey(full), full));
        }
      }
    for (const [j, names] of found) {
      const list = [...names.values()];
      out.names[j - 1] = list.length === 1 ? list[0]! : sharedFaceName(list);
    }
    return out;
  };
  /** Places a named shape; its faces keep their names (BRepBuilderAPI_Transform's history). */
  const place = (input: Named, q: Quaternion, t: Vec3): Named => {
    const trsf = own(new oc.gp_Trsf_1());
    trsf.SetTransformation_3(own(new oc.gp_Quaternion_2(...q)), own(new oc.gp_Vec_4(...t)));
    const builder = own(new oc.BRepBuilderAPI_Transform_2(input.shape, trsf, false));
    return carry(own(builder.Shape()), input, (face) => [own(builder.ModifiedShape(face))]);
  };
  const maxTolerance = (shape: unknown): number =>
    own(new oc.ShapeAnalysis_ShapeTolerance()).Tolerance(
      shape,
      1,
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    );
  /**
   * The profile's planar face in its local frame, and the side name of each of its edges: the
   * element the edge comes from (docs/cad/r1-modeling.md, 命名), found from the edge's end points.
   */
  function profileFace(profile: CadProfile) {
    const s = profile.shape;
    let wire;
    let points: [number, number][] = [];
    if (s.type === 'circle') {
      const ax = own(new oc.gp_Ax2_3(pnt(0, 0, 0), own(new oc.gp_Dir_4(0, 0, 1))));
      const edge = own(
        own(new oc.BRepBuilderAPI_MakeEdge_8(own(new oc.gp_Circ_2(ax, len(s.radius))))).Edge(),
      );
      wire = own(own(new oc.BRepBuilderAPI_MakeWire_2(edge)).Wire());
    } else {
      points =
        s.type === 'rectangle'
          ? [
              [0, 0],
              [len(s.width), 0],
              [len(s.width), len(s.height)],
              [0, len(s.height)],
            ]
          : s.vertices.map((v) => [len(v.u), len(v.v)]);
      const poly = own(new oc.BRepBuilderAPI_MakePolygon_1());
      for (const [u, v] of points) poly.Add_1(pnt(u, v, 0));
      poly.Close();
      wire = own(poly.Wire());
    }
    const face = own(own(new oc.BRepBuilderAPI_MakeFace_15(wire, true)).Face());
    const rectangle = ['-v', '+u', '+v', '-u'];
    // A polyline side is `v:<vertex ID>`; no recipe name starts with `v:`, so an ID never
    // spells one (and duplication finds the IDs to rename).
    const elementOf = (i: number) =>
      s.type === 'rectangle'
        ? rectangle[i]!
        : s.type === 'polyline'
          ? `v:${s.vertices[i]!.id}`
          : 'circle';
    /**
     * Edge i runs from point i to point i + 1; a kernel edge takes the recipe edge whose two end
     * points it matches most closely, within a tolerance relative to that edge's length (not to
     * the coordinates, which may be far from the origin). A recipe edge matched twice names none.
     */
    const sideOf = (edge: unknown): { side: Side; index?: number } => {
      if (s.type === 'circle') return { side: { edge, name: ['side:circle'] } };
      const ends: [number, number][] = [];
      explore(edge, 'TopAbs_VERTEX', (v) => {
        const p = own(oc.BRep_Tool.Pnt(own(oc.TopoDS.Vertex_1(v))));
        ends.push([p.X(), p.Y()]);
      });
      if (ends.length !== 2) return { side: { edge, name: null } };
      const d = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
      let index: number | undefined;
      let best = Infinity;
      for (let i = 0; i < points.length; i++) {
        const [a, b] = [points[i]!, points[(i + 1) % points.length]!];
        const off = Math.min(
          Math.max(d(ends[0]!, a), d(ends[1]!, b)),
          Math.max(d(ends[0]!, b), d(ends[1]!, a)),
        );
        if (off <= 1e-6 * d(a, b) && off < best) [index, best] = [i, off];
      }
      if (index === undefined) return { side: { edge, name: null } };
      const [a, b] = [points[index]!, points[(index + 1) % points.length]!];
      return { side: { edge, name: [`side:${elementOf(index)}`], segment: [a, b] }, index };
    };
    const matched: { side: Side; index?: number }[] = [];
    explore(face, 'TopAbs_EDGE', (edge) => matched.push(sideOf(edge)));
    const uses = new Map<number, number>();
    for (const m of matched)
      if (m.index !== undefined) uses.set(m.index, (uses.get(m.index) ?? 0) + 1);
    const sides: Side[] = matched.map(({ side, index }) =>
      index !== undefined && uses.get(index)! > 1 ? { edge: side.edge, name: null } : side,
    );
    return { face, sides };
  }
  /** A profile edge, its side name and, for a straight edge, its end points (profile u, v). */
  type Side = {
    edge: unknown;
    name: CadFaceName | null;
    segment?: [[number, number], [number, number]];
  };
  /**
   * A sketch region's planar face in the sketch's frame: the outer loop counter-clockwise, each
   * hole clockwise, and each edge's side named by its element (`side:e:<element ID>`; element IDs
   * are local to the sketch and never a document ID). Points of one ID are one vertex, with the
   * stored coordinates' tolerance, so an arc meets its neighbours however its two radii differ
   * within it.
   */
  function regionFace(f: CadFeature, sketch: CadSketch, region: CadSketchRegion) {
    const g = sketchRegion(sketch, region);
    if ('code' in g) throw new CadKernelError(g.code, f.id);
    const tol = doc.kernelProfile.linearToleranceMm;
    const builder = own(new oc.BRep_Builder());
    const vertices = new Map<string, unknown>();
    const vertex = (id: string) => {
      let v = vertices.get(id);
      if (!v) {
        const [u, w] = sketch.solved[id]!;
        v = own(new oc.TopoDS_Vertex());
        builder.MakeVertex_2(v, pnt(u, w, 0), tol);
        vertices.set(id, v);
      }
      return v;
    };
    const circ = ([u, v]: readonly number[], r: number, ccw: boolean) =>
      own(
        new oc.gp_Circ_2(
          own(new oc.gp_Ax2_3(pnt(u!, v!, 0), own(new oc.gp_Dir_4(0, 0, ccw ? 1 : -1)))),
          r,
        ),
      );
    const made: Side[] = [];
    const wires = g.loops.map((loop, li) => {
      // Walk a loop backwards when it runs the other way.
      const ccw = loopArea(loop) > 0;
      const reverse = li === 0 ? !ccw : ccw;
      const walk = loop.elements.map((e, i) => ({ e, forward: loop.forward[i] !== reverse }));
      if (reverse) walk.reverse();
      const wire = own(new oc.BRepBuilderAPI_MakeWire_1());
      for (const { e, forward } of walk) {
        let edge;
        let segment: Side['segment'];
        if (e.type === 'circle') edge = new oc.BRepBuilderAPI_MakeEdge_8(circ(e.c, e.r, li === 0));
        else if (e.type === 'closedSpline') edge = splineEdge(f.id, e, true, forward);
        else {
          const [a, b] = forward ? e.ends : [e.ends[1], e.ends[0]];
          if (e.type === 'spline')
            edge = splineEdge(f.id, e, false, forward, [vertex(a), vertex(b)]);
          else if (e.type === 'line') {
            edge = new oc.BRepBuilderAPI_MakeEdge_2(vertex(a), vertex(b));
            segment = forward ? [e.a, e.b] : [e.b, e.a];
          } else {
            // The arc's radius is the mean of its two: each end lies within the tolerance.
            const r = (Math.hypot(e.b[0] - e.c[0], e.b[1] - e.c[1]) + e.r) / 2;
            edge = new oc.BRepBuilderAPI_MakeEdge_11(
              circ(e.c, r, e.sweep > 0 === forward),
              vertex(a),
              vertex(b),
            );
          }
        }
        own(edge);
        if (!edge.IsDone()) throw new CadKernelError('region-edge-failed', f.id);
        wire.Add_1(own(edge.Edge()));
        if (!wire.IsDone()) throw new CadKernelError('region-edge-failed', f.id);
        made.push({ edge: own(wire.Edge()), name: [`side:e:${e.id}`], segment });
      }
      return own(wire.Wire());
    });
    const plane = own(new oc.gp_Pln_3(pnt(0, 0, 0), own(new oc.gp_Dir_4(0, 0, 1))));
    const maker = own(new oc.BRepBuilderAPI_MakeFace_16(plane, wires[0], true));
    for (const hole of wires.slice(1)) maker.Add(hole);
    if (!maker.IsDone()) throw new CadKernelError('region-face-failed', f.id);
    const face = own(maker.Face());
    // The face's own edges, each named by the element it was made from.
    const sides: Side[] = [];
    explore(face, 'TopAbs_EDGE', (edge) => {
      const m = made.find((x) => (x.edge as { IsSame(o: unknown): boolean }).IsSame(edge));
      sides.push({ edge, name: m?.name ?? null, segment: m?.segment });
    });
    return { face, sides };
  }
  /** A swept profile: start and end faces, and each side face named by its profile edge. */
  function sweptNames(
    sweep: {
      FirstShape_1(): unknown;
      LastShape_1(): unknown;
      Generated(s: unknown): unknown;
      Shape(): unknown;
    },
    sides: Side[],
    ends: boolean,
  ): Named {
    const result = named(own(sweep.Shape()), () => null);
    if (!naming) return result;
    const set = (face: unknown, name: CadFaceName) => {
      const j = result.faces.FindIndex(face);
      if (j > 0 && !result.names[j - 1]) result.names[j - 1] = name;
    };
    if (ends) {
      set(own(sweep.FirstShape_1()), ['start']);
      set(own(sweep.LastShape_1()), ['end']);
    }
    for (const { edge, name } of sides)
      if (name) for (const face of listOf(sweep.Generated(edge))) set(face, name);
    return result;
  }
  const plane = (p: CadProfile): [Quaternion, Vec3] => [
    p.plane.orientation,
    resolvePosition(p.plane.origin, params),
  ];
  /** An imported feature's BRep bytes, refused when missing or not matching their ref. */
  function assetBytes(f: Extract<CadFeature, { type: 'imported' }>) {
    const ref = doc.assets.find((a) => a.id === f.args.brepAssetId);
    const bytes = ref && options.assets?.get(ref.sha256);
    if (!ref || !bytes) throw new CadKernelError('asset-missing', f.id);
    if (bytes.byteLength !== ref.byteLength || `sha256:${bytesToHex(sha256(bytes))}` !== ref.sha256)
      throw new CadKernelError('asset-hash-mismatch', f.id);
    return bytes;
  }
  /**
   * A full turn's history leaves some side faces out (OCCT 7.6 gives no Generated face for a
   * profile edge across the axis). A straight edge's surface of revolution is known exactly
   * (Pappus): area θ·L·(r₁ + r₂)/2, and the axial centroid of its weight r. An unnamed face takes
   * the name of the one remaining straight edge that matches both, never a nearest one.
   */
  function nameRevolvedSides(
    result: Named,
    sides: Side[],
    [ox, oy]: [number, number],
    [dx, dy]: [number, number],
    angle: number,
  ) {
    const k = Math.hypot(dx, dy);
    const axial = ([u, v]: readonly number[]) => ((u! - ox) * dx + (v! - oy) * dy) / k;
    const radius = ([u, v]: readonly number[]) => Math.abs((u! - ox) * dy - (v! - oy) * dx) / k;
    const used = new Set(result.names.filter(Boolean).map((n) => JSON.stringify(n)));
    const expected = sides.flatMap(({ name, segment }) => {
      if (!name || !segment || used.has(JSON.stringify(name))) return [];
      const [a, b] = segment;
      const [r1, r2, z1, z2] = [radius(a), radius(b), axial(a), axial(b)];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const weight = (length * (r1 + r2)) / 2;
      if (weight <= 0) return [];
      const z = (length * (r1 * (2 * z1 + z2) + r2 * (z1 + 2 * z2))) / 6 / weight;
      return [{ name, area: angle * weight, z }];
    });
    const close = (x: number, y: number, scale: number) => Math.abs(x - y) <= 1e-6 * scale;
    result.names.forEach((n, i) => {
      if (n) return;
      const { centroid: c, area } = faceProps(own(result.faces.FindKey(i + 1)));
      const z = axial(c);
      const hits = expected.filter(
        (e) => close(e.area, area, e.area) && close(e.z, z, 1 + Math.abs(e.z)),
      );
      if (hits.length === 1) result.names[i] = hits[0]!.name;
    });
  }
  /** The primitives' local faces, named by where their centroid lies (exact for these shapes). */
  const by = (rules: [(c: Vec3) => boolean, string][]) => (face: unknown) => {
    const c = faceProps(face).centroid;
    const hit = rules.find(([test]) => test(c));
    return hit ? [hit[1]] : null;
  };
  const at = (value: number, target: number, scale: number) =>
    Math.abs(value - target) <= 1e-9 * Math.max(1, scale);
  /**
   * One Boolean of the target with all tools at once, so their order changes neither result nor
   * names. Target faces keep their names; each tool's faces get its prefix (none for ''), and a
   * face several tools share all of their names (`carryTools`).
   */
  function combine(
    featureId: string,
    mode: 'union' | 'cut' | 'common',
    target: Named,
    tools: Named[],
    prefixes: string[],
  ): Named {
    const progress = () => own(new oc.Message_ProgressRange_1());
    let op;
    if (tools.length === 1) {
      const Op = {
        union: oc.BRepAlgoAPI_Fuse_3,
        cut: oc.BRepAlgoAPI_Cut_3,
        common: oc.BRepAlgoAPI_Common_3,
      }[mode];
      op = own(new Op(target.shape, tools[0]!.shape, progress()));
    } else {
      op = own(
        new {
          union: oc.BRepAlgoAPI_Fuse_1,
          cut: oc.BRepAlgoAPI_Cut_1,
          common: oc.BRepAlgoAPI_Common_1,
        }[mode](),
      );
      const list = (items: Named[]) => {
        const l = own(new oc.TopTools_ListOfShape_1());
        for (const x of items) own(l.Append_1(x.shape));
        return l;
      };
      op.SetArguments(list([target]));
      op.SetTools(list(tools));
      op.Build(progress());
    }
    if (!op.IsDone() || op.HasErrors()) throw new CadKernelError('boolean-failed', featureId);
    const image = history(op);
    return carryTools(
      carry(own(op.Shape()), target, image),
      tools.map((tool, k) => ({ tool, prefix: prefixes[k]! })),
      image,
    );
  }
  /**
   * Whether `tool` takes a solid out of `target`. A tool that only touches the target (or misses
   * it) cuts nothing: their common part has no solid then, however small a genuine cut is (F04).
   */
  function overlaps(target: Named, tool: Named): boolean {
    const common = own(
      new oc.BRepAlgoAPI_Common_3(target.shape, tool.shape, own(new oc.Message_ProgressRange_1())),
    );
    let solids = 0;
    if (common.IsDone() && !common.HasErrors())
      explore(own(common.Shape()), 'TopAbs_SOLID', () => solids++);
    return solids > 0;
  }
  /**
   * Points on a face: the nodes of a mesh of a copy of it, which lie on its surface (its vertices
   * alone miss a circle's cap, which has one, and a curved face on a flat boundary). The copy
   * keeps the input free of a triangulation. Empty when the face does not mesh.
   */
  function facePoints(face: unknown, area: number): Vec3[] {
    const copy = own(
      own(new oc.BRepBuilderAPI_Transform_2(face, own(new oc.gp_Trsf_1()), true)).Shape(),
    );
    own(
      new oc.BRepMesh_IncrementalMesh_2(
        copy,
        Math.max(Math.sqrt(area), 1) * 0.01,
        false,
        0.5,
        false,
      ),
    );
    const points: Vec3[] = [];
    explore(copy, 'TopAbs_FACE', (f) => {
      const loc = own(new oc.TopLoc_Location_1());
      const handle = own(oc.BRep_Tool.Triangulation(own(oc.TopoDS.Face_1(f)), loc, 0));
      if (handle.IsNull()) return;
      const tri = handle.get();
      const trsf = own(loc.Transformation());
      for (let i = 1; i <= tri.NbNodes(); i++) {
        const p = own(own(tri.Node(i)).Transformed(trsf));
        points.push([p.X(), p.Y(), p.Z()]);
      }
    });
    return points;
  }
  /**
   * The plane of a planar face: a point on it and its unit normal, or undefined when its points
   * (`facePoints`) do not span a plane or one lies off it.
   */
  function planeOf(face: unknown, area: number): [Vec3, Vec3] | undefined {
    const points = facePoints(face, area);
    const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cross = (a: Vec3, b: Vec3): Vec3 => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
    const [o] = points;
    if (!o) return undefined;
    // The normal from the widest pair among a bounded sample; every point is checked after.
    const sample = points.filter((_, i) => i % Math.ceil(points.length / 64) === 0);
    let best: Vec3 = [0, 0, 0];
    for (let i = 1; i < sample.length; i++)
      for (let j = i + 1; j < sample.length; j++) {
        const n = cross(sub(sample[i]!, o), sub(sample[j]!, o));
        if (Math.hypot(...n) > Math.hypot(...best)) best = n;
      }
    const size = Math.max(...points.map((p) => Math.hypot(...sub(p, o))));
    const k = Math.hypot(...best);
    if (!(k > 1e-9 * size * size)) return undefined;
    const normal = best.map((x) => x / k) as Vec3;
    const off = (p: Vec3) => Math.abs(sub(p, o).reduce((a, x, i) => a + x * normal[i]!, 0));
    if (points.some((p) => off(p) > 1e-6 * Math.max(1, size))) return undefined;
    return [o, normal];
  }
  const profiles = new Map(doc.profiles.map((p) => [p.id, p]));
  const sketches = new Map(doc.sketches.map((s) => [s.id, s]));
  /** Each evaluated sketch's frame, in dependency order before the features that sweep it. */
  const frames = new Map<string, [Quaternion, Vec3]>();
  /** The face an extrude or revolve sweeps, its sides, and the frame it is placed in. */
  function swept(f: Extract<CadFeature, { type: 'extrude' | 'revolve' }>) {
    if ('profileId' in f.args) {
      const profile = profiles.get(f.args.profileId)!;
      return { ...profileFace(profile), frame: plane(profile) };
    }
    const sketch = sketches.get(f.args.sketchId)!;
    return { ...regionFace(f, sketch, f.args.region), frame: frames.get(sketch.id)! };
  }
  /** A surface feature's chain edges as swept sides: each face takes `side:e:<element ID>`. */
  function chainSides(path: { edges: { edge: unknown; id: string }[] }): Side[] {
    return path.edges.map(({ edge, id }) => ({ edge, name: [`side:e:${id}`] }));
  }
  /**
   * A surface feature's free edges (docs/cad/r2a-freeform.md, 命名): the edges of the chain where
   * the sweep starts (`start`) and ends (`end`), and those the ends of an open chain sweep
   * (`edge:start:e:<first element>`, `edge:end:e:<last element>`). Each names its edge only where
   * the edge is free in the evaluated body (makeTable), so a full turn's seam keeps its name.
   */
  function boundaryNames(
    result: Named,
    generated: (s: unknown) => unknown,
    path: { wire: unknown; closed: boolean; ends: [CadFaceName, CadFaceName] },
    start: unknown,
    end: unknown,
  ): Named {
    if (!naming) return result;
    const edges: { edge: unknown; name: CadFaceName }[] = [];
    const add = (shape: unknown, name: CadFaceName) =>
      explore(shape, 'TopAbs_EDGE', (edge) => edges.push({ edge, name }));
    add(start, ['start']);
    add(end, ['end']);
    if (!path.closed) {
      const first = own(new oc.TopoDS_Vertex());
      const last = own(new oc.TopoDS_Vertex());
      oc.TopExp.Vertices_2(path.wire, first, last);
      for (const made of listOf(generated(first))) add(made, path.ends[0]);
      for (const made of listOf(generated(last))) add(made, path.ends[1]);
    }
    result.edges = [...(result.edges ?? []), ...edges];
    return result;
  }
  /** A sweep's side face is named by the profile element and the path element it runs along. */
  function pathNames(
    result: Named,
    pipe: { Generated(s: unknown): unknown },
    edges: { edge: unknown; id: string }[],
  ) {
    for (const { edge, id } of edges)
      for (const made of listOf(pipe.Generated(edge)))
        explore(made, 'TopAbs_FACE', (face) => {
          const j = result.faces.FindIndex(face);
          const name = j > 0 ? result.names[j - 1] : undefined;
          if (name?.length === 1 && name[0]!.startsWith('side:'))
            result.names[j - 1] = [name[0]!, `path:e:${id}`];
        });
  }
  /** A boundary curve's exact geometry in world space, for a Coons patch (`bsplineOf`). */
  type CurveGeometry =
    | { kind: 'line'; a: Vec3; b: Vec3 }
    | { kind: 'arc'; centre: Vec3; at: (t: number) => Vec3; t0: number; t1: number }
    | { kind: 'spline'; poles: Vec3[]; degree: number; knots: number[]; mults: number[] }
    | { kind: 'other' };
  /**
   * One curve of a boundary surface or fill in world space (R2a-2c): a sketch element's edge, or
   * a referenced edge with the face beside it when it has exactly one. `boundary` names the edge
   * the curve becomes by where it comes from; `geometry` is exact for a line, an arc, a sketch
   * spline, and a referenced line or circle's arc.
   */
  function curveOf(
    f: CadFeature,
    source: CadCurveSource,
    path: (string | number)[],
    shapes: Map<string, Named>,
  ) {
    let edge: unknown;
    let face: unknown;
    let geometry: CurveGeometry = { kind: 'other' };
    if ('edge' in source) {
      const input = shapes.get(source.edge.featureId)!;
      const [index] = resolveRefs(f, input, [{ path: [...path, 'edge'], ref: source.edge }]);
      const table = tableOf(input);
      edge = table.edge(index!);
      const faces = table.topology.edges[index!]!.faces;
      if (faces.length === 1) face = table.face(faces[0]!);
      geometry = edgeGeometry(edge);
    } else {
      const sketch = sketches.get(source.sketchId)!;
      const chain = pathWire(f, { sketchId: source.sketchId, elements: [source.element] });
      edge = own(oc.TopoDS.Edge_1(chain.edges[0]!.edge));
      const e = sketchElement(sketch, source.element)!;
      const w = ([u, v]: readonly number[]) => worldPoint(sketch.id, u!, v!);
      if (e.type === 'line') geometry = { kind: 'line', a: w(e.a), b: w(e.b) };
      else if (e.type === 'arc')
        geometry = {
          kind: 'arc',
          centre: w(e.c),
          at: (t) => w([e.c[0] + e.r * Math.cos(t), e.c[1] + e.r * Math.sin(t)]),
          t0: e.start,
          t1: e.start + e.sweep,
        };
      else if (e.type === 'spline') {
        const { knots, mults } = splineKnots(e.poles.length, e.degree, false);
        geometry = { kind: 'spline', poles: e.poles.map(w), degree: e.degree, knots, mults };
      }
    }
    return {
      edge,
      face,
      path,
      geometry,
      measure: edgeMeasure(edge),
      boundary: naming ? curveBoundaryName(source) : (['surface'] as CadFaceName),
    };
  }
  /** A referenced edge's geometry when it is a line or a circle's arc (its own parameters). */
  function edgeGeometry(edge: unknown): CurveGeometry {
    const curve = own(oc.BRep_Tool.Curve_2(edge, 0, 0));
    if (curve.IsNull()) return { kind: 'other' };
    const g = curve.get();
    const type = own(g.DynamicType()).get().Name() as string;
    const first = own(new oc.TopoDS_Vertex());
    const last = own(new oc.TopoDS_Vertex());
    oc.TopExp.Vertices_1(edge, first, last, false);
    const t0 = oc.BRep_Tool.Parameter_2(first, edge) as number;
    let t1 = oc.BRep_Tool.Parameter_2(last, edge) as number;
    const at = (t: number): Vec3 => {
      const p = own(g.Value(t));
      return [p.X(), p.Y(), p.Z()];
    };
    if (type === 'Geom_Line') return { kind: 'line', a: at(t0), b: at(t1) };
    if (type !== 'Geom_Circle') return { kind: 'other' };
    if (t1 <= t0) t1 += 2 * Math.PI;
    // On a circle the second derivative by angle points from the point to the centre, |r| long.
    const p = own(new oc.gp_Pnt_1());
    const d1 = own(new oc.gp_Vec_1());
    const d2 = own(new oc.gp_Vec_1());
    g.D2(t0, p, d1, d2);
    const centre: Vec3 = [p.X() + d2.X(), p.Y() + d2.Y(), p.Z() + d2.Z()];
    return { kind: 'arc', centre, at, t0, t1 };
  }
  type Measure = { ends: [Vec3, Vec3]; length: number };
  /** An edge's two end points and length, to tell which curve a made edge is. */
  function edgeMeasure(edge: unknown): Measure {
    const ends: Vec3[] = [];
    explore(edge, 'TopAbs_VERTEX', (v) => {
      const p = own(oc.BRep_Tool.Pnt(own(oc.TopoDS.Vertex_1(v))));
      ends.push([p.X(), p.Y(), p.Z()]);
    });
    const props = own(new oc.GProp_GProps_1());
    oc.BRepGProp.LinearProperties(edge, props, false, false);
    return { ends: [ends[0]!, ends[ends.length - 1]!], length: props.Mass() };
  }
  const near = (a: Vec3, b: Vec3, tol: number) =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tol;
  function sameMeasure(a: Measure, b: Measure): boolean {
    const tol = Math.max(doc.kernelProfile.linearToleranceMm, 1e-9 * a.length) * 10;
    const [p, q] = a.ends;
    return (
      Math.abs(a.length - b.length) <= tol + 1e-7 * a.length &&
      ((near(p, b.ends[0], tol) && near(q, b.ends[1], tol)) ||
        (near(p, b.ends[1], tol) && near(q, b.ends[0], tol)))
    );
  }
  /**
   * Refuses curves that do not close a loop in their order: each shares an end with the next
   * (the last with the first) within the linear tolerance, by the first curve that does not.
   */
  function closesLoop(f: CadFeature, curves: { measure: Measure }[], key: string) {
    const tol = doc.kernelProfile.linearToleranceMm;
    const touches = (a: Measure, b: Measure) =>
      a.ends.some((p) => b.ends.some((q) => near(p, q, tol)));
    curves.forEach((c, i) => {
      if (!touches(c.measure, curves[(i + 1) % curves.length]!.measure))
        throw new CadKernelError('boundary-open', f.id, false, undefined, [
          [key, (i + 1) % curves.length],
        ]);
    });
  }
  /**
   * A curve as a B-spline of degree 3 or more (a Coons patch needs four poles a side), exactly:
   * a line, a sketch spline, or a circle's arc within 1e-9 of its radius (see below). A referenced
   * edge of another curve is refused by its place in the feature (a fill takes any edge).
   */
  function bsplineOf(f: CadFeature, c: { geometry: CurveGeometry; path: (string | number)[] }) {
    const g = c.geometry;
    let poles: Vec3[];
    let knots: number[];
    let mults: number[];
    let degree: number;
    if (g.kind === 'line') [poles, knots, mults, degree] = [[g.a, g.b], [0, 1], [2, 2], 1];
    else if (g.kind === 'arc') {
      // A Coons patch of rational curves does not keep them as its sides, so an arc becomes
      // cubic pieces of 1/32 turn or less (a radius off by 1e-9 of itself at most).
      const n = Math.max(1, Math.ceil(Math.abs(g.t1 - g.t0) / (Math.PI / 16) - 1e-9));
      const step = (g.t1 - g.t0) / n;
      const o = g.centre;
      const [x, y] = [g.at(0), g.at(Math.PI / 2)].map((p) => p.map((v, j) => v - o[j]!));
      const point = (t: number) => o.map((v, j) => v + Math.cos(t) * x![j]! + Math.sin(t) * y![j]!);
      const tangent = (t: number) => o.map((_, j) => -Math.sin(t) * x![j]! + Math.cos(t) * y![j]!);
      const k = (4 / 3) * Math.tan(step / 4);
      poles = [point(g.t0) as Vec3];
      for (let i = 0; i < n; i++) {
        const [t, u] = [g.t0 + i * step, g.t0 + (i + 1) * step];
        const [p, q, dp, dq] = [point(t), point(u), tangent(t), tangent(u)];
        poles.push(
          p.map((v, j) => v + k * dp[j]!) as Vec3,
          q.map((v, j) => v - k * dq[j]!) as Vec3,
          q as Vec3,
        );
      }
      knots = Array.from({ length: n + 1 }, (_, i) => i);
      mults = knots.map((_, i) => (i === 0 || i === n ? 4 : 3));
      degree = 3;
    } else if (g.kind === 'spline') ({ poles, knots, mults, degree } = g);
    else throw new CadKernelError('boundary-curve-unsupported', f.id, false, undefined, [c.path]);
    const P = own(new oc.TColgp_Array1OfPnt_2(1, poles.length));
    poles.forEach((p, i) => P.SetValue(i + 1, pnt(...p)));
    const K = own(new oc.TColStd_Array1OfReal_2(1, knots.length));
    knots.forEach((k, i) => K.SetValue(i + 1, k));
    const M = own(new oc.TColStd_Array1OfInteger_2(1, mults.length));
    mults.forEach((m, i) => M.SetValue(i + 1, m));
    const curve = new oc.Geom_BSplineCurve_1(P, K, M, degree, false);
    const handle = own(new oc.Handle_Geom_BSplineCurve_2(curve));
    if (degree < 3) handle.get().IncreaseDegree(3);
    return handle;
  }
  /** The rotation of quaternion `q` (x, y, z, w) as a transformation. */
  function quaternionTrsf(q: Quaternion) {
    const trsf = own(new oc.gp_Trsf_1());
    trsf.SetRotation_2(own(new oc.gp_Quaternion_2(...q)));
    return trsf;
  }
  /**
   * A sheet result as one shell: a single face (a one-element chain) is wrapped in a shell so a
   * sheet body is always a shell (docs/cad/r2a-freeform.md, Surface body). Face names carry over.
   */
  function sheetOf(result: Named): Named {
    let shells = 0;
    explore(result.shape, 'TopAbs_SHELL', () => shells++);
    if (shells) return result;
    const builder = own(new oc.BRep_Builder());
    const shell = own(new oc.TopoDS_Shell());
    builder.MakeShell(shell);
    explore(result.shape, 'TopAbs_FACE', (face) => builder.Add(shell, face));
    const out = named(shell, () => null);
    if (naming)
      for (let i = 1; i <= out.faces.Size(); i++) {
        const j = result.faces.FindIndex(own(out.faces.FindKey(i)));
        out.names[i - 1] = j > 0 ? result.names[j - 1]! : null;
      }
    out.edges = result.edges;
    return out;
  }
  /**
   * A loft or sweep that is not one valid solid (a self-intersecting or twisted one) fails by its
   * own code rather than by the general solid check.
   */
  function solidOrFail(result: Named, code: string, featureId: string): Named {
    let solids = 0;
    explore(result.shape, 'TopAbs_SOLID', () => solids++);
    if (solids !== 1 || !own(new oc.BRepCheck_Analyzer(result.shape, true, false)).IsValid_2())
      throw new CadKernelError(code, featureId);
    // Sections in one plane give a valid solid with nothing inside.
    const props = own(new oc.GProp_GProps_1());
    oc.BRepGProp.VolumeProperties_1(result.shape, props, false, false, false);
    if (props.Mass() <= cadLimits.minDimensionMm ** 3) throw new CadKernelError(code, featureId);
    return result;
  }
  /**
   * `BRepOffsetAPI_ThruSections` through the wires, built. OCCT first matches the wires' edges
   * and seams (`BRepFill_CompatibleWires`); for closed spline sections (five through a wing) that
   * matching can throw (`SameNumberByPolarMethod`, `profiles are inconsistent`) although every
   * section has the same number of edges and needs none. Then it is built once more without the matching (ST-89):
   * the sections join seam to seam as drawn, and the result is still checked as any loft is.
   */
  function thruSections(featureId: string, wires: unknown[], solid: boolean, ruled: boolean) {
    const build = (match: boolean) => {
      const loft = own(
        new oc.BRepOffsetAPI_ThruSections(solid, ruled, doc.kernelProfile.linearToleranceMm),
      );
      if (!match) loft.CheckCompatibility(false);
      for (const wire of wires) loft.AddWire(wire);
      loft.Build(own(new oc.Message_ProgressRange_1()));
      if (!loft.IsDone()) throw new CadKernelError('loft-failed', featureId);
      return loft;
    };
    try {
      return build(true);
    } catch (error) {
      if (error instanceof CadKernelError) throw error;
      // Decoded once here: decoding releases the exception, so it is not thrown on as it came.
      const { type, message } = decodeKernelException(oc, error);
      const edges = wires.map((w) => {
        let n = 0;
        explore(w, 'TopAbs_EDGE', () => n++);
        return n;
      });
      const matching = message.includes('BRepFill_CompatibleWires');
      if (!matching || edges.some((n) => n !== edges[0]))
        throw new CadKernelError(
          `kernel-exception:${type}${message ? `:${message}` : ''}`,
          featureId,
        );
      return build(false);
    }
  }
  /** Sketch point (u, v) of `sketchId` in world space. */
  function worldPoint(sketchId: string, u: number, v: number): Vec3 {
    const p = own(pnt(u, v, 0).Transformed(frameTrsf(sketchId)));
    return [p.X(), p.Y(), p.Z()];
  }
  /** How far a section's boundary reaches from `from` (world), sampled along its elements. */
  function reachFrom(section: CadSketchSection, from: Vec3): number {
    const sketch = sketches.get(section.sketchId)!;
    const g = sketchRegion(sketch, section.region);
    if ('code' in g) return Infinity;
    let reach = 0;
    for (const e of g.loops.flatMap((l) => l.elements)) {
      for (const [u, v] of sketchElementPoints(e)) {
        const w = worldPoint(sketch.id, u, v);
        reach = Math.max(reach, Math.hypot(w[0] - from[0], w[1] - from[1], w[2] - from[2]));
      }
    }
    return reach;
  }
  /** How far a surface sweep's profile chain reaches from `from` (as `reachFrom`). */
  function chainReach(chain: CadSketchPath, from: Vec3): number {
    const sketch = sketches.get(chain.sketchId)!;
    const g = sketchPath(sketch, chain.elements, 'allow');
    if ('code' in g) return Infinity;
    let reach = 0;
    for (const [u, v] of pathSamples(g)) {
      const w = worldPoint(sketch.id, u, v);
      reach = Math.max(reach, Math.hypot(w[0] - from[0], w[1] - from[1], w[2] - from[2]));
    }
    return reach;
  }
  /** The transformation from a sketch's frame to world space. */
  function frameTrsf(sketchId: string) {
    const [q, t] = frames.get(sketchId)!;
    const trsf = own(new oc.gp_Trsf_1());
    trsf.SetTransformation_3(own(new oc.gp_Quaternion_2(...q)), own(new oc.gp_Vec_4(...t)));
    return trsf;
  }
  /**
   * A loft section or sweep profile (R1e): the region's outer wire placed in world space, and its
   * edges named by their elements (the region has no holes; validation refuses them).
   */
  function sectionWire(f: CadFeature, section: CadSketchSection, derived?: CadDerivedSection) {
    const sketch = sketches.get(section.sketchId)!;
    const { face, sides } = regionFace(f, sketch, section.region);
    const trsf = frameTrsf(sketch.id);
    // K6: a derived section is the source region scaled and turned about the sketch's origin, then
    // moved in the sketch's frame, before the frame places it in world space.
    if (derived) {
      const move = own(new oc.gp_Trsf_1());
      move.SetTranslation_1(own(new oc.gp_Vec_4(...derived.offset.map(len))));
      const turn = own(new oc.gp_Trsf_1());
      turn.SetRotation_1(
        own(new oc.gp_Ax1_2(pnt(0, 0, 0), own(new oc.gp_Dir_4(0, 0, 1)))),
        resolveAngle(derived.angle, params),
      );
      const scale = own(new oc.gp_Trsf_1());
      scale.SetScale(pnt(0, 0, 0), resolveRatio(derived.scale, params));
      trsf.Multiply(move);
      trsf.Multiply(turn);
      trsf.Multiply(scale);
    }
    const builder = own(new oc.BRepBuilderAPI_Transform_2(face, trsf, false));
    const moved = own(oc.TopoDS.Face_1(own(builder.Shape())));
    return {
      wire: own(oc.BRepTools.OuterWire(moved)),
      sides: sides.map((x) => ({ ...x, edge: own(builder.ModifiedShape(x.edge)) })),
    };
  }
  /**
   * A sweep's path in world space: its lines and arcs end to end in order, joined at their shared
   * points, and each edge with the element it was made from.
   */
  function pathWire(f: CadFeature, path: CadSketchPath, closed: 'allow' | 'refuse' = 'refuse') {
    const sketch = sketches.get(path.sketchId)!;
    const g = sketchPath(sketch, path.elements, closed);
    if ('code' in g) throw new CadKernelError(g.code, f.id);
    const tol = doc.kernelProfile.linearToleranceMm;
    const builder = own(new oc.BRep_Builder());
    const vertices = new Map<string, unknown>();
    const vertex = (id: string) => {
      let v = vertices.get(id);
      if (!v) {
        const [u, w] = sketch.solved[id]!;
        v = own(new oc.TopoDS_Vertex());
        builder.MakeVertex_2(v, pnt(u, w, 0), tol);
        vertices.set(id, v);
      }
      return v;
    };
    const wire = own(new oc.BRepBuilderAPI_MakeWire_1());
    const made: { edge: unknown; id: string }[] = [];
    g.elements.forEach((e, i) => {
      const forward = g.forward[i]!;
      const [a, b] = forward ? e.ends : [e.ends[1], e.ends[0]];
      let edge;
      if (e.type === 'line') edge = new oc.BRepBuilderAPI_MakeEdge_2(vertex(a), vertex(b));
      else if (e.type === 'spline')
        edge = splineEdge(f.id, e, false, forward, [vertex(a), vertex(b)]);
      else {
        const r = (Math.hypot(e.b[0] - e.c[0], e.b[1] - e.c[1]) + e.r) / 2;
        const axis = own(
          new oc.gp_Ax2_3(
            pnt(e.c[0], e.c[1], 0),
            own(new oc.gp_Dir_4(0, 0, e.sweep > 0 === forward ? 1 : -1)),
          ),
        );
        edge = new oc.BRepBuilderAPI_MakeEdge_11(
          own(new oc.gp_Circ_2(axis, r)),
          vertex(a),
          vertex(b),
        );
      }
      own(edge);
      if (!edge.IsDone()) throw new CadKernelError('sweep-failed', f.id);
      wire.Add_1(own(edge.Edge()));
      if (!wire.IsDone()) throw new CadKernelError('sweep-failed', f.id);
      made.push({ edge: own(wire.Edge()), id: e.id });
    });
    const moved = own(
      new oc.BRepBuilderAPI_Transform_2(own(wire.Wire()), frameTrsf(sketch.id), false),
    );
    const [su, sv] = sketch.solved[g.forward[0] ? g.elements[0]!.ends[0] : g.elements[0]!.ends[1]]!;
    return {
      wire: own(oc.TopoDS.Wire_1(own(moved.Shape()))),
      edges: made.map((m) => ({ edge: own(moved.ModifiedShape(m.edge)), id: m.id })),
      /**
       * The tightest turn of the path (its smallest arc radius, a spline's smallest radius of
       * curvature from 64 samples per knot span), Infinity when straight.
       */
      tightest: Math.min(
        ...g.elements.map((e) =>
          e.type === 'arc'
            ? e.r
            : e.type === 'spline'
              ? tightestTurn(splinePoints(e.poles, e.degree, false, 64))
              : Infinity,
        ),
      ),
      start: worldPoint(sketch.id, su!, sv!),
      closed: g.closed,
      /** The boundaries an open chain's two ends sweep (docs/cad/r2a-freeform.md, 命名). */
      ends: [[`edge:start:e:${made[0]!.id}`], [`edge:end:e:${made[made.length - 1]!.id}`]] as [
        CadFaceName,
        CadFaceName,
      ],
    };
  }
  /**
   * A loft section in world space: a sketch chain (`pathWire`), or a chain of referenced edges
   * end to end in order (R2a-2c), each side named `from:<feature ID>/side:<the edge's name>` and
   * its ends `edge:start`/`edge:end` before its first and last edge's side name.
   */
  function sectionChain(
    f: CadFeature,
    section: CadSketchPath | CadEdgeChain,
    path: (string | number)[],
    shapes: Map<string, Named>,
  ) {
    if (!('edges' in section)) {
      const chain = pathWire(f, section, 'allow');
      return { wire: chain.wire, closed: chain.closed, ends: chain.ends, sides: chainSides(chain) };
    }
    const wire = own(new oc.BRepBuilderAPI_MakeWire_1());
    const sides: Side[] = [];
    section.edges.forEach((ref, j) => {
      const at = [...path, 'edges', j];
      const input = shapes.get(ref.featureId)!;
      const [index] = resolveRefs(f, input, [{ path: at, ref }]);
      wire.Add_1(tableOf(input).edge(index!));
      if (!wire.IsDone())
        throw new CadKernelError('loft-section-gap', f.id, false, undefined, [at]);
      sides.push({ edge: own(wire.Edge()), name: naming ? edgeSideName(ref) : null });
    });
    const made = own(wire.Wire());
    const first = edgeSideName(section.edges[0]!);
    const last = edgeSideName(section.edges[section.edges.length - 1]!);
    return {
      wire: made,
      closed: !!oc.BRep_Tool.IsClosed_1(made),
      ends: [
        ['edge:start', ...first],
        ['edge:end', ...last],
      ] as [CadFaceName, CadFaceName],
      sides,
    };
  }
  /**
   * A sketch's frame: its datum plane, or the plane of the face it is attached to, found by its
   * reference (`attachFrame`). A face that is not planar is refused by the sketch's ID.
   */
  function sketchFrame(sketch: CadSketch, shapes: Map<string, Named>): [Quaternion, Vec3] {
    const p = sketch.plane;
    if (!('face' in p)) return [p.orientation, resolvePosition(p.origin, params)];
    const input = shapes.get(p.face.featureId)!;
    const [index] = resolveRefs(sketch, input, [{ path: ['plane', 'face'], ref: p.face }]);
    const table = tableOf(input);
    const face = table.face(index!);
    const area = table.topology.faces[index!]!.area;
    const fitted = planeOf(face, area);
    const normal = fitted && outwardNormal(face, area);
    if (!fitted || !normal)
      throw new CadKernelError('sketch-face-not-planar', sketch.id, false, undefined, [
        ['plane', 'face'],
      ]);
    // The fitted normal's sign is arbitrary: the face's orientation picks the outward one.
    const n = fitted[1];
    const sign = n[0] * normal[0] + n[1] * normal[1] + n[2] * normal[2] < 0 ? -1 : 1;
    const { origin, orientation } = attachFrame(
      fitted[0],
      n.map((x) => sign * x) as Vec3,
      len(p.offset),
    );
    return [orientation, origin];
  }
  /**
   * The area-weighted normal of a face's triangles, wound outward as its orientation says (as the
   * display mesh is), or undefined when the face does not mesh.
   */
  function outwardNormal(face: unknown, area: number): Vec3 | undefined {
    const copy = own(
      own(new oc.BRepBuilderAPI_Transform_2(face, own(new oc.gp_Trsf_1()), true)).Shape(),
    );
    own(
      new oc.BRepMesh_IncrementalMesh_2(
        copy,
        Math.max(Math.sqrt(area), 1) * 0.01,
        false,
        0.5,
        false,
      ),
    );
    const sum: Vec3 = [0, 0, 0];
    explore(copy, 'TopAbs_FACE', (f) => {
      const topo = own(oc.TopoDS.Face_1(f));
      const loc = own(new oc.TopLoc_Location_1());
      const handle = own(oc.BRep_Tool.Triangulation(topo, loc, 0));
      if (handle.IsNull()) return;
      const tri = handle.get();
      const trsf = own(loc.Transformation());
      const node = (i: number): Vec3 => {
        const p = own(own(tri.Node(i)).Transformed(trsf));
        return [p.X(), p.Y(), p.Z()];
      };
      const k = topo.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED ? -1 : 1;
      for (let i = 1; i <= tri.NbTriangles(); i++) {
        const t = own(tri.Triangle(i));
        const [a, b, c] = [t.Value(1), t.Value(2), t.Value(3)].map(node) as Vec3[];
        const u = [b![0] - a![0], b![1] - a![1], b![2] - a![2]];
        const v = [c![0] - a![0], c![1] - a![1], c![2] - a![2]];
        sum[0] += k * (u[1]! * v[2]! - u[2]! * v[1]!);
        sum[1] += k * (u[2]! * v[0]! - u[0]! * v[2]!);
        sum[2] += k * (u[0]! * v[1]! - u[1]! * v[0]!);
      }
    });
    return Math.hypot(...sum) > 0 ? sum : undefined;
  }
  /**
   * The triangles of a mesh of a copy of a face (the copy keeps the input free of a
   * triangulation): each one's centroid, its normal as the face is oriented (unit), and area.
   */
  function faceTriangles(face: unknown, area: number) {
    const copy = own(
      own(new oc.BRepBuilderAPI_Transform_2(face, own(new oc.gp_Trsf_1()), true)).Shape(),
    );
    own(
      new oc.BRepMesh_IncrementalMesh_2(
        copy,
        Math.max(Math.sqrt(area), 1) * 0.01,
        false,
        0.5,
        false,
      ),
    );
    const out: { at: Vec3; normal: Vec3; area: number }[] = [];
    explore(copy, 'TopAbs_FACE', (f) => {
      const topo = own(oc.TopoDS.Face_1(f));
      const loc = own(new oc.TopLoc_Location_1());
      const handle = own(oc.BRep_Tool.Triangulation(topo, loc, 0));
      if (handle.IsNull()) return;
      const tri = handle.get();
      const trsf = own(loc.Transformation());
      const node = (i: number): Vec3 => {
        const p = own(own(tri.Node(i)).Transformed(trsf));
        return [p.X(), p.Y(), p.Z()];
      };
      const k = topo.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED ? -1 : 1;
      for (let i = 1; i <= tri.NbTriangles(); i++) {
        const t = own(tri.Triangle(i));
        const [a, b, c] = [t.Value(1), t.Value(2), t.Value(3)].map(node) as [Vec3, Vec3, Vec3];
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const n: Vec3 = [
          k * (u[1]! * v[2]! - u[2]! * v[1]!),
          k * (u[2]! * v[0]! - u[0]! * v[2]!),
          k * (u[0]! * v[1]! - u[1]! * v[0]!),
        ];
        const twice = Math.hypot(...n);
        if (!(twice > 0)) continue;
        out.push({
          at: [0, 1, 2].map((j) => (a[j]! + b[j]! + c[j]!) / 3) as Vec3,
          normal: n.map((x) => x / twice) as Vec3,
          area: twice / 2,
        });
      }
    });
    return out;
  }
  /** A sheet's free edges (on one face, not a seam), as an edge map of the shape. */
  function freeEdges(shape: unknown): Set<number> {
    const ancestors = own(new oc.TopTools_IndexedDataMapOfShapeListOfShape_1());
    oc.TopExp.MapShapesAndAncestors(
      shape,
      oc.TopAbs_ShapeEnum.TopAbs_EDGE,
      oc.TopAbs_ShapeEnum.TopAbs_FACE,
      ancestors,
    );
    const edges = shapeMap(shape, 'TopAbs_EDGE');
    const out = new Set<number>();
    for (let e = 1; e <= ancestors.Size(); e++) {
      const edge = own(oc.TopoDS.Edge_1(own(ancestors.FindKey(e))));
      if (oc.BRep_Tool.Degenerated(edge)) continue;
      if (listOf(ancestors.FindFromIndex(e)).length === 1) out.add(edges.FindIndex(edge));
    }
    return out;
  }
  /**
   * Which side of a trim's tool a piece lies on (R2a-3): +1 inside or in front, -1 outside or
   * behind, by the area of its mesh's triangles. A piece with more than a tenth of its area on
   * the other side (the tool does not cut through it), or none on either, is undetermined (0).
   */
  function pieceSide(piece: unknown, side: (p: Vec3) => number): number {
    let plus = 0;
    let minus = 0;
    for (const t of faceTriangles(piece, faceProps(piece).area)) {
      const s = side(t.at);
      if (s > 0) plus += t.area;
      else if (s < 0) minus += t.area;
    }
    const total = plus + minus;
    if (!(total > 0)) return 0;
    if (plus >= 0.9 * total) return 1;
    if (minus >= 0.9 * total) return -1;
    return 0;
  }
  /**
   * A trim (R2a-3): the input split by the tool (`BRepAlgoAPI_Splitter`), the pieces on the
   * kept side gathered in one shell. Pieces are `trim:<ID>:<side>/<their face's name>`; the cut
   * edges are named by where the cut runs (`cutBoundaryName`).
   */
  function trim(f: Extract<CadFeature, { type: 'trim' }>, shapes: Map<string, Named>): Named {
    const input = shapes.get(f.inputFeatureIds[0])!;
    const tool = f.args.tool;
    const [min, max] = boundsOf(input.shape);
    const centre = min.map((x, i) => (x + max[i]!) / 2) as Vec3;
    const size = Math.hypot(...min.map((x, i) => max[i]! - x)) + 10;
    let toolShape: unknown;
    let side: (p: Vec3) => number;
    const cuts: { face: unknown; name: CadFaceName }[] = [];
    if ('sketchId' in tool) {
      // The chain's planar face moved back along the sketch's normal and swept through the
      // input: a prism whose sides cut it. A point is inside where the prism holds it.
      const chain = pathWire(f, tool, 'allow');
      const [q, origin] = frames.get(tool.sketchId)!;
      const n = own(own(new oc.gp_Dir_4(0, 0, 1)).Transformed(quaternionTrsf(q)));
      const normal: Vec3 = [n.X(), n.Y(), n.Z()];
      const off = normal.reduce((a, x, i) => a + x * (centre[i]! - origin[i]!), 0);
      const reach = Math.abs(off) + size;
      const face = own(new oc.BRepBuilderAPI_MakeFace_15(chain.wire, true));
      if (!face.IsDone()) throw new CadKernelError('trim-failed', f.id);
      const trsf = own(new oc.gp_Trsf_1());
      trsf.SetTranslation_1(own(new oc.gp_Vec_4(...normal.map((x) => x * (off - reach)))));
      const moved = own(new oc.BRepBuilderAPI_Transform_2(own(face.Face()), trsf, false));
      const prism = own(
        new oc.BRepPrimAPI_MakePrism_1(
          own(moved.Shape()),
          own(new oc.gp_Vec_4(...normal.map((x) => x * 2 * reach))),
          false,
          true,
        ),
      );
      toolShape = own(prism.Shape());
      for (const { edge, id } of chain.edges)
        for (const made of listOf(prism.Generated(own(moved.ModifiedShape(edge)))))
          explore(made, 'TopAbs_FACE', (face) =>
            cuts.push({ face, name: cutBoundaryName({ sketchId: tool.sketchId, element: id }) }),
          );
      const classifier = own(new oc.BRepClass3d_SolidClassifier_1());
      classifier.Load(toolShape);
      side = (p) => {
        classifier.Perform(pnt(...p), doc.kernelProfile.linearToleranceMm);
        const state = classifier.State();
        return state === oc.TopAbs_State.TopAbs_IN
          ? 1
          : state === oc.TopAbs_State.TopAbs_OUT
            ? -1
            : 0;
      };
    } else if ('plane' in tool) {
      const o = resolvePosition(tool.plane.origin, params);
      const n = tool.plane.normal;
      const reach = Math.hypot(...o.map((x, i) => x - centre[i]!)) + size;
      const plane = own(
        new oc.BRepBuilderAPI_MakeFace_9(
          own(new oc.gp_Pln_3(pnt(...o), own(new oc.gp_Dir_4(...n)))),
          -reach,
          reach,
          -reach,
          reach,
        ),
      );
      toolShape = own(plane.Face());
      cuts.push({ face: toolShape, name: cutBoundaryName({ plane: true }) });
      const eps = doc.kernelProfile.linearToleranceMm;
      side = (p) => {
        const d = p.reduce((a, x, i) => a + (x - o[i]!) * n[i]!, 0);
        return d > eps ? 1 : d < -eps ? -1 : 0;
      };
    } else {
      // Another sheet: a point is in front where the nearest of its triangles faces it.
      const other = shapes.get(tool.featureId)!;
      toolShape = other.shape;
      const triangles: { at: Vec3; normal: Vec3 }[] = [];
      for (let i = 1; i <= other.faces.Size(); i++) {
        const face = own(other.faces.FindKey(i));
        const name = other.names[i - 1];
        if (name)
          cuts.push({ face, name: cutBoundaryName({ featureId: tool.featureId, face: name }) });
        triangles.push(...faceTriangles(face, faceProps(face).area));
      }
      const eps = doc.kernelProfile.linearToleranceMm;
      side = (p) => {
        let best: { at: Vec3; normal: Vec3 } | undefined;
        let d2 = Infinity;
        for (const t of triangles) {
          const d = (p[0] - t.at[0]) ** 2 + (p[1] - t.at[1]) ** 2 + (p[2] - t.at[2]) ** 2;
          if (d < d2) [best, d2] = [t, d];
        }
        if (!best) return 0;
        const d = p.reduce((a, x, i) => a + (x - best!.at[i]!) * best!.normal[i]!, 0);
        return d > eps ? 1 : d < -eps ? -1 : 0;
      };
    }
    const splitter = own(new oc.BRepAlgoAPI_Splitter_1());
    const args = own(new oc.TopTools_ListOfShape_1());
    own(args.Append_1(input.shape));
    const tools = own(new oc.TopTools_ListOfShape_1());
    own(tools.Append_1(toolShape));
    splitter.SetArguments(args);
    splitter.SetTools(tools);
    splitter.Build(own(new oc.Message_ProgressRange_1()));
    if (!splitter.IsDone() || splitter.HasErrors()) throw new CadKernelError('trim-failed', f.id);
    // Each piece with the input face it came from; a face the tool misses is one piece.
    const pieces: { piece: unknown; from: number }[] = [];
    let cut = false;
    for (let i = 1; i <= input.faces.Size(); i++) {
      const face = own(input.faces.FindKey(i));
      if (splitter.IsDeleted(face)) continue;
      const made = listOf(splitter.Modified(face));
      if (made.length) cut = true;
      for (const piece of made.length ? made : [face]) pieces.push({ piece, from: i });
    }
    // A tool that cuts nothing leaves the sheet as it was: refused, not kept or emptied.
    if (!cut) throw new CadKernelError('trim-no-cut', f.id, false, undefined, [['tool']]);
    const want = f.args.keep === 'inside' || f.args.keep === 'front' ? 1 : -1;
    const kept: typeof pieces = [];
    for (const p of pieces) {
      const s = pieceSide(p.piece, side);
      if (s === 0)
        throw new CadKernelError('trim-side-undetermined', f.id, false, undefined, [['tool']]);
      if (s === want) kept.push(p);
    }
    if (!kept.length) throw new CadKernelError('trim-empty', f.id, false, undefined, [['keep']]);
    const builder = own(new oc.BRep_Builder());
    const shell = own(new oc.TopoDS_Shell());
    builder.MakeShell(shell);
    for (const { piece } of kept) builder.Add(shell, piece);
    const prefix = `trim:${f.id}:${f.args.keep}`;
    const result = named(shell, () => null);
    if (!naming) return result;
    for (const { piece, from } of kept) {
      const j = result.faces.FindIndex(piece);
      const name = input.names[from - 1];
      if (j > 0 && name) result.names[j - 1] = prefixFaceName(prefix, name);
    }
    const image = history(splitter);
    for (const { edge, name } of input.edges ?? [])
      for (const made of image(edge))
        (result.edges ??= []).push({ edge: made, name: prefixFaceName(prefix, name) });
    for (const { face, name } of cuts)
      for (const made of listOf(splitter.Generated(face)))
        explore(made, 'TopAbs_EDGE', (edge) => (result.edges ??= []).push({ edge, name }));
    return result;
  }
  /** The joining distance a failed sew is tried again with, to tell a gap from sheets apart. */
  const sewGapReachMm = 1;
  /**
   * A sew (R2a-3): the inputs joined where their edges lie within the tolerance
   * (`BRepBuilderAPI_Sewing`), each input's faces and edges `sew:<its feature ID>/…`, and with
   * `solid` the closed shell made a solid. Edges a 1 mm sew would join but the tolerance does not
   * are refused as `sew-gap`, by the input edges.
   */
  function sew(f: Extract<CadFeature, { type: 'sew' }>, shapes: Map<string, Named>): Named {
    const inputs = f.inputFeatureIds.map((id) => shapes.get(id)!);
    const sewing = (tolerance: number) => {
      const op = own(new oc.BRepBuilderAPI_Sewing(tolerance, true, true, true, false));
      for (const input of inputs) op.Add(input.shape);
      op.Perform(own(new oc.Message_ProgressRange_1()));
      const image = (s: unknown) =>
        op.IsModifiedSubShape(s) ? [own(op.ModifiedSubShape(s))] : [s];
      return { op, shape: own(op.SewedShape()), image };
    };
    const shells = (shape: unknown) => {
      let n = 0;
      explore(shape, 'TopAbs_SHELL', () => n++);
      // A face sewn to nothing is left outside any shell.
      let loose = 0;
      const all = shapeMap(shape, 'TopAbs_FACE').Size();
      explore(shape, 'TopAbs_SHELL', (sh) => (loose += shapeMap(sh, 'TopAbs_FACE').Size()));
      return n + (all - loose);
    };
    // A gap of exactly the tolerance joins: the distance is taken with the model's linear
    // tolerance of slack, as the sketch coordinates that place an edge carry it.
    const sewn = sewing(f.args.toleranceMm + doc.kernelProfile.linearToleranceMm);
    const open = freeEdges(sewn.shape);
    const apart = shells(sewn.shape) !== 1 || (f.args.solid && open.size > 0);
    if (apart) {
      // The input edges free after the sew that a wider sew joins: the gap. With none, the
      // sheets are apart (or, for a solid, do not close).
      const wide = sewing(sewGapReachMm);
      const wideOpen = freeEdges(wide.shape);
      const narrowEdges = shapeMap(sewn.shape, 'TopAbs_EDGE');
      const wideEdges = shapeMap(wide.shape, 'TopAbs_EDGE');
      const gaps: { featureId: string; name: CadTopoName }[] = [];
      inputs.forEach((input, k) => {
        const table = tableOf(input);
        table.topology.edges.forEach((e, i) => {
          if (e.faces.length !== 1) return;
          const edge = table.edge(i);
          const free = (img: unknown[], map: ShapeMap, set: Set<number>) =>
            img.some((x) => set.has(map.FindIndex(x)));
          if (!free(sewn.image(edge), narrowEdges, open)) return;
          if (free(wide.image(edge), wideEdges, wideOpen)) return;
          const name = naming ? elementName(table.topology, 'edge', i) : null;
          if (name) gaps.push({ featureId: f.inputFeatureIds[k]!, name });
        });
      });
      const joined =
        shells(wide.shape) === 1 && (!f.args.solid || wideOpen.size < open.size || !wideOpen.size);
      if (gaps.length && joined)
        throw new CadKernelError('sew-gap', f.id, false, undefined, undefined, gaps);
      throw new CadKernelError(
        shells(sewn.shape) !== 1 ? 'sew-disconnected' : 'sew-not-closed',
        f.id,
      );
    }
    let shape = sewn.shape;
    if (
      (shape as { ShapeType(): { value: number } }).ShapeType().value !==
      oc.TopAbs_ShapeEnum.TopAbs_SHELL.value
    ) {
      let one: unknown;
      explore(shape, 'TopAbs_SHELL', (sh) => (one = sh));
      shape = one;
    }
    const result = named(shape, () => null);
    inputs.forEach((input, k) =>
      carry(result, input, sewn.image, (name) =>
        prefixFaceName(`sew:${f.inputFeatureIds[k]}`, name),
      ),
    );
    if (!f.args.solid) return result;
    const solid = own(new oc.BRepBuilderAPI_MakeSolid_3(own(oc.TopoDS.Shell_1(shape))));
    if (!solid.IsDone()) throw new CadKernelError('sew-not-closed', f.id);
    let made = own(solid.Solid());
    const props = own(new oc.GProp_GProps_1());
    oc.BRepGProp.VolumeProperties_1(made, props, false, false, false);
    // A shell sewn inside out gives a negative volume: the solid is turned.
    if (props.Mass() < 0) made = own((made as { Reversed(): unknown }).Reversed());
    const out = named(made, () => null);
    for (let i = 1; i <= out.faces.Size(); i++) {
      const j = result.faces.FindIndex(own(out.faces.FindKey(i)));
      out.names[i - 1] = j > 0 ? result.names[j - 1]! : null;
    }
    return out;
  }
  /**
   * A thicken (R2a-3): a solid of the sheet (`MakeThickSolidBySimple`), towards its normal, away
   * from it, or half each way from the sheet first moved back half the thickness. The face on
   * the normal's side keeps each face's name, the other is `inner/<name>`, and the side along a
   * free edge is `side:<the edge's name>`.
   */
  function thicken(f: Extract<CadFeature, { type: 'thicken' }>, shapes: Map<string, Named>): Named {
    const input = shapes.get(f.inputFeatureIds[0])!;
    const t = len(f.args.thickness);
    let base = input.shape;
    let image = (s: unknown): unknown => s;
    if (f.args.side === 'both') {
      const off = own(new oc.BRepOffsetAPI_MakeOffsetShape());
      off.PerformBySimple(input.shape, -t / 2);
      off.Build(own(new oc.Message_ProgressRange_1()));
      if (!off.IsDone()) throw new CadKernelError('thicken-failed', f.id);
      base = own(off.Shape());
      image = (s) => listOf(off.Generated(s))[0];
    }
    const op = own(new oc.BRepOffsetAPI_MakeThickSolid());
    const offset = f.args.side === 'back' ? -t : t;
    op.MakeThickSolidBySimple(base, offset);
    op.Build(own(new oc.Message_ProgressRange_1()));
    if (!op.IsDone()) throw new CadKernelError('thicken-failed', f.id);
    let shape = own(op.Shape());
    let solids = 0;
    explore(shape, 'TopAbs_SOLID', () => solids++);
    // The simple offset does not join faces that meet at an angle: their walls leave gaps,
    // seen as a tolerance far past the result's, or the solid crosses itself.
    if (
      solids !== 1 ||
      maxTolerance(shape) > doc.kernelProfile.maxResultLinearToleranceMm ||
      !own(new oc.BRepCheck_Analyzer(shape, true, false)).IsValid_2()
    )
      throw new CadKernelError('thicken-failed', f.id);
    const props = own(new oc.GProp_GProps_1());
    oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false);
    if (props.Mass() < 0) shape = own((shape as { Reversed(): unknown }).Reversed());
    const result = named(shape, () => null);
    if (!naming) return result;
    const set = (face: unknown, name: CadFaceName) => {
      const j = result.faces.FindIndex(face);
      if (j > 0 && !result.names[j - 1]) result.names[j - 1] = name;
    };
    for (let i = 1; i <= input.faces.Size(); i++) {
      const name = input.names[i - 1];
      if (!name) continue;
      const at = image(own(input.faces.FindKey(i)));
      if (!at) continue;
      // The sheet's face stays where it is; the offset one is generated from it.
      const moved = listOf(op.Generated(at));
      const [front, back] = offset > 0 ? [moved, [at]] : [[at], moved];
      for (const face of front) set(face, name);
      for (const face of back) set(face, prefixFaceName('inner', name));
    }
    // The side along a free edge is the face of the solid on that edge other than the sheet's.
    const ancestors = own(new oc.TopTools_IndexedDataMapOfShapeListOfShape_1());
    oc.TopExp.MapShapesAndAncestors(
      shape,
      oc.TopAbs_ShapeEnum.TopAbs_EDGE,
      oc.TopAbs_ShapeEnum.TopAbs_FACE,
      ancestors,
    );
    const table = tableOf(input);
    table.topology.edges.forEach((e, i) => {
      if (e.faces.length !== 1) return;
      const name = elementName(table.topology, 'edge', i);
      const at = name && image(table.edge(i));
      const k = at ? ancestors.FindIndex(at) : 0;
      if (!name || k < 1) return;
      for (const face of listOf(ancestors.FindFromIndex(k))) set(face, thickenSideName(name));
    });
    return result;
  }
  function build(f: CadFeature, shapes: Map<string, Named>): Named {
    switch (f.type) {
      case 'box': {
        const size = f.args.size.map(len) as Vec3;
        const box = own(own(new oc.BRepPrimAPI_MakeBox_2(...size)).Shape());
        const rules: [(c: Vec3) => boolean, string][] = [];
        ['x', 'y', 'z'].forEach((axis, k) => {
          rules.push([(c) => at(c[k]!, size[k]!, size[k]!), `+${axis}`]);
          rules.push([(c) => at(c[k]!, 0, size[k]!), `-${axis}`]);
        });
        return place(
          named(box, by(rules)),
          f.args.orientation,
          resolvePosition(f.args.origin, params),
        );
      }
      case 'cylinder': {
        const h = len(f.args.height);
        const shape = own(own(new oc.BRepPrimAPI_MakeCylinder_1(len(f.args.radius), h)).Shape());
        return place(
          named(
            shape,
            by([
              [(c) => at(c[2], h, h), 'top'],
              [(c) => at(c[2], 0, h), 'bottom'],
              [() => true, 'side'],
            ]),
          ),
          f.args.orientation,
          resolvePosition(f.args.origin, params),
        );
      }
      case 'sphere':
        return place(
          named(own(own(new oc.BRepPrimAPI_MakeSphere_1(len(f.args.radius))).Shape()), () => [
            'surface',
          ]),
          f.args.orientation,
          resolvePosition(f.args.origin, params),
        );
      case 'extrude': {
        const { face, sides, frame } = swept(f);
        const vec = own(new oc.gp_Vec_4(0, 0, f.args.direction * len(f.args.distance)));
        const prism = own(new oc.BRepPrimAPI_MakePrism_1(face, vec, false, true));
        return place(sweptNames(prism, sides, true), ...frame);
      }
      case 'revolve': {
        const { face, sides, frame } = swept(f);
        const [ox, oy] = f.args.axisOrigin.map(len);
        const [dx, dy] = f.args.axisDirection;
        const axis = own(new oc.gp_Ax1_2(pnt(ox, oy, 0), own(new oc.gp_Dir_4(dx, dy, 0))));
        const angle = resolveAngle(f.args.angle, params);
        const revol = own(new oc.BRepPrimAPI_MakeRevol_1(face, axis, angle, false));
        // A full turn has no start or end face.
        const ends = Math.abs(angle) < 2 * Math.PI - 1e-12;
        const result = sweptNames(revol, sides, ends);
        if (naming) nameRevolvedSides(result, sides, [ox, oy], [dx, dy], Math.abs(angle));
        return place(result, ...frame);
      }
      case 'loft': {
        const sections = f.args.sections.map((x, _, all) =>
          'derivedFrom' in x
            ? sectionWire(f, all[x.derivedFrom] as CadSketchSection, x)
            : sectionWire(f, x),
        );
        const loft = thruSections(
          f.id,
          sections.map((x) => x.wire),
          true,
          f.args.ruled,
        );
        // Side faces take the first section's element names (命名).
        const result = sweptNames(
          {
            FirstShape_1: () => loft.FirstShape(),
            LastShape_1: () => loft.LastShape(),
            Generated: (x: unknown) => loft.Generated(x),
            Shape: () => loft.Shape(),
          },
          sections[0]!.sides,
          true,
        );
        return solidOrFail(result, 'loft-failed', f.id);
      }
      case 'sweep': {
        const profile = sectionWire(f, f.args.profile);
        const path = pathWire(f, f.args.path);
        // A path that turns tighter than the profile reaches from it folds the solid into itself
        // (docs/cad/r1-modeling.md, Loft・sweep), which OCCT does not always report.
        if (path.tightest <= reachFrom(f.args.profile, path.start))
          throw new CadKernelError('sweep-failed', f.id);
        const pipe = own(new oc.BRepOffsetAPI_MakePipeShell(path.wire));
        if (f.args.orientation === 'frenet') pipe.SetMode_1(true);
        else pipe.SetMode_2(own(new oc.gp_Ax2_3(pnt(0, 0, 0), own(new oc.gp_Dir_4(0, 0, 1)))));
        pipe.Add_1(profile.wire, false, false);
        if (!pipe.IsReady()) throw new CadKernelError('sweep-failed', f.id);
        pipe.Build(own(new oc.Message_ProgressRange_1()));
        if (!pipe.IsDone() || !pipe.MakeSolid()) throw new CadKernelError('sweep-failed', f.id);
        const result = sweptNames(
          {
            FirstShape_1: () => pipe.FirstShape(),
            LastShape_1: () => pipe.LastShape(),
            Generated: (x: unknown) => pipe.Generated(x),
            Shape: () => pipe.Shape(),
          },
          profile.sides,
          true,
        );
        if (naming) pathNames(result, pipe, path.edges);
        return solidOrFail(result, 'sweep-failed', f.id);
      }
      case 'extrudeSurface': {
        // A sheet (docs/cad/r2a-freeform.md): each face is named by the chain element it comes
        // from; the chain's ends make edges, not faces.
        const path = pathWire(f, f.args.path, 'allow');
        const [q] = frames.get(f.args.path.sketchId)!;
        const d = f.args.direction * len(f.args.distance);
        const normal = own(own(new oc.gp_Vec_4(0, 0, d)).Transformed(quaternionTrsf(q)));
        const prism = own(new oc.BRepPrimAPI_MakePrism_1(path.wire, normal, false, true));
        if (!prism.IsDone()) throw new CadKernelError('surface-failed', f.id);
        return sheetOf(
          boundaryNames(
            sweptNames(prism, chainSides(path), false),
            (x) => prism.Generated(x),
            path,
            own(prism.FirstShape_1()),
            own(prism.LastShape_1()),
          ),
        );
      }
      case 'revolveSurface': {
        const path = pathWire(f, f.args.path, 'allow');
        const [ox, oy] = f.args.axisOrigin.map(len);
        const [dx, dy] = f.args.axisDirection;
        const trsf = frameTrsf(f.args.path.sketchId);
        const axis = own(
          new oc.gp_Ax1_2(
            own(pnt(ox, oy, 0).Transformed(trsf)),
            own(own(new oc.gp_Dir_4(dx, dy, 0)).Transformed(trsf)),
          ),
        );
        const angle = resolveAngle(f.args.angle, params);
        const revol = own(new oc.BRepPrimAPI_MakeRevol_1(path.wire, axis, angle, false));
        if (!revol.IsDone()) throw new CadKernelError('surface-failed', f.id);
        return sheetOf(
          boundaryNames(
            sweptNames(revol, chainSides(path), false),
            (x) => revol.Generated(x),
            path,
            own(revol.FirstShape_1()),
            own(revol.LastShape_1()),
          ),
        );
      }
      case 'surfaceLoft': {
        // Sections are chains placed in world space; faces take the first one's element names.
        const sections = f.args.sections.map((x, i) => sectionChain(f, x, ['sections', i], shapes));
        const mixed = sections.findIndex((x) => x.closed !== sections[0]!.closed);
        if (mixed > 0)
          throw new CadKernelError('loft-section-closure', f.id, false, undefined, [
            ['sections', mixed],
          ]);
        const loft = thruSections(
          f.id,
          sections.map((x) => x.wire),
          false,
          f.args.ruled,
        );
        const generated = (x: unknown) => loft.Generated(x);
        const result = sweptNames(
          {
            FirstShape_1: () => loft.FirstShape(),
            LastShape_1: () => loft.LastShape(),
            Generated: generated,
            Shape: () => loft.Shape(),
          },
          sections[0]!.sides,
          false,
        );
        // A sheet loft has no end faces: its end chains are its first and last wires.
        return sheetOf(
          boundaryNames(
            result,
            generated,
            sections[0]!,
            sections[0]!.wire,
            sections[sections.length - 1]!.wire,
          ),
        );
      }
      case 'boundarySurface': {
        // A Coons patch of the curves (cubic or higher), one face named `surface`.
        const curves = f.args.curves.map((c, i) => curveOf(f, c, ['curves', i], shapes));
        closesLoop(f, curves, 'curves');
        const splines = curves.map((c) => bsplineOf(f, c));
        const style = oc.GeomFill_FillingStyle.GeomFill_CoonsStyle;
        const filling = own(
          splines.length === 4
            ? new oc.GeomFill_BSplineCurves_2(...splines, style)
            : new oc.GeomFill_BSplineCurves_3(...splines, style),
        );
        const surface = own(new oc.Handle_Geom_Surface_2(own(filling.Surface()).get()));
        const maker = own(
          new oc.BRepBuilderAPI_MakeFace_8(surface, doc.kernelProfile.linearToleranceMm),
        );
        if (!maker.IsDone()) throw new CadKernelError('surface-failed', f.id);
        const result = named(own(maker.Face()), () => ['surface']);
        // Each boundary edge is the curve it was made from: same ends and length.
        if (naming)
          explore(result.shape, 'TopAbs_EDGE', (edge) => {
            if (oc.BRep_Tool.Degenerated(own(oc.TopoDS.Edge_1(edge)))) return;
            const m = edgeMeasure(edge);
            const hits = curves.filter((c) => sameMeasure(c.measure, m));
            if (hits.length === 1) (result.edges ??= []).push({ edge, name: hits[0]!.boundary });
          });
        return sheetOf(result);
      }
      case 'fill': {
        // A plate through the curves (BRepFill_Filling), G1 to the face beside a G1 edge.
        const curves = f.args.boundary.map((b, i) =>
          curveOf(f, b.curve, ['boundary', i, 'curve'], shapes),
        );
        closesLoop(f, curves, 'boundary');
        const filling = own(new oc.BRepFill_Filling(3, 15, 2, false, 1e-5, 1e-4, 0.01, 0.1, 8, 9));
        f.args.boundary.forEach((b, i) => {
          const c = curves[i]!;
          if (b.continuity === 'G1') {
            if (!c.face)
              throw new CadKernelError('fill-no-adjacent-face', f.id, false, undefined, [
                ['boundary', i, 'continuity'],
              ]);
            filling.Add_2(c.edge, c.face, oc.GeomAbs_Shape.GeomAbs_G1, true);
          } else filling.Add_1(c.edge, oc.GeomAbs_Shape.GeomAbs_C0, true);
        });
        filling.Build();
        if (!filling.IsDone()) throw new CadKernelError('fill-failed', f.id);
        // A plate cannot always turn as far as a G1 side asks (a wall at right angles): refuse
        // when a normal stays more than 0.1° off rather than keep a crease. The build reports
        // only the largest error, so the refusal names every G1 side.
        if (filling.G1Error_1() > Math.PI / 1800)
          throw new CadKernelError(
            'fill-g1-unreached',
            f.id,
            false,
            undefined,
            f.args.boundary.flatMap((b, i) =>
              b.continuity === 'G1' ? [['boundary', i, 'continuity']] : [],
            ),
          );
        const result = named(own(filling.Face()), () => ['surface']);
        if (naming)
          for (const c of curves)
            for (const made of listOf(filling.Generated(c.edge)))
              explore(made, 'TopAbs_EDGE', (edge) =>
                (result.edges ??= []).push({ edge, name: c.boundary }),
              );
        return sheetOf(result);
      }
      case 'surfaceSweep': {
        const profile = pathWire(f, f.args.profile, 'allow');
        const path = pathWire(f, f.args.path);
        if (path.tightest <= chainReach(f.args.profile, path.start))
          throw new CadKernelError('sweep-failed', f.id);
        const pipe = own(new oc.BRepOffsetAPI_MakePipeShell(path.wire));
        if (f.args.orientation === 'frenet') pipe.SetMode_1(true);
        else pipe.SetMode_2(own(new oc.gp_Ax2_3(pnt(0, 0, 0), own(new oc.gp_Dir_4(0, 0, 1)))));
        pipe.Add_1(profile.wire, false, false);
        if (!pipe.IsReady()) throw new CadKernelError('sweep-failed', f.id);
        pipe.Build(own(new oc.Message_ProgressRange_1()));
        if (!pipe.IsDone()) throw new CadKernelError('sweep-failed', f.id);
        const generated = (x: unknown) => pipe.Generated(x);
        const result = sweptNames(
          {
            FirstShape_1: () => pipe.FirstShape(),
            LastShape_1: () => pipe.LastShape(),
            Generated: generated,
            Shape: () => pipe.Shape(),
          },
          chainSides(profile),
          false,
        );
        if (naming) pathNames(result, pipe, path.edges);
        return sheetOf(
          boundaryNames(result, generated, profile, own(pipe.FirstShape()), own(pipe.LastShape())),
        );
      }
      case 'trim':
        return trim(f, shapes);
      case 'sew':
        return sew(f, shapes);
      case 'thicken':
        return thicken(f, shapes);
      case 'transform':
        return place(
          shapes.get(f.inputFeatureIds[0])!,
          f.args.rotation,
          resolvePosition(f.args.translation, params),
        );
      case 'imported': {
        const bytes = assetBytes(f);
        if (typeof oc.BRepTools?.Read_2 !== 'function')
          throw new CadKernelError('step-import-unsupported-build', f.id);
        // One job runs at a time in a Worker, so a fixed path is safe.
        const path = '/f.brep';
        try {
          oc.FS.writeFile(path, bytes);
          const shape = own(new oc.TopoDS_Shape());
          const ok = oc.BRepTools.Read_2(
            shape,
            path,
            own(new oc.BRep_Builder()),
            own(new oc.Message_ProgressRange_1()),
          );
          if (!ok) throw new CadKernelError('asset-unreadable', f.id);
          // An imported body has no recipe to name its faces by; R1 features cannot reference it.
          return named(shape, () => null);
        } finally {
          if (oc.FS.analyzePath(path).exists) oc.FS.unlink(path);
        }
      }
      case 'boolean': {
        const [target, ...tools] = f.inputFeatureIds.map((i) => shapes.get(i)!);
        // A tool that only touches the target (or misses it) cuts nothing: a degenerate Boolean
        // (F04) that would still consume the tool. Their common part has no solid then, however
        // small a genuine cut is. Union and common report it as several solids or an empty result.
        if (f.args.mode === 'cut')
          for (const tool of tools)
            if (!overlaps(target!, tool)) throw new CadKernelError('boolean-no-overlap', f.id);
        // Tool faces are prefixed with the tool's feature ID (Booleanのtoolの名前).
        return combine(
          f.id,
          f.args.mode,
          target!,
          tools,
          tools.map((_, k) => `tool:${f.inputFeatureIds[k + 1]}`),
        );
      }
      case 'pattern': {
        const [target, tool] = f.inputFeatureIds.map((i) => shapes.get(i)!);
        const l = f.args.layout;
        const n = resolveCount(l.count, params);
        const copies: Named[] = [];
        // K5a: the copies' places and directions along the path, in its sketch's plane.
        let along: { at: [number, number]; angle: number }[] | undefined;
        if (l.type === 'curve') {
          const g = sketchPath(sketches.get(l.path.sketchId)!, l.path.elements);
          if ('code' in g) throw new CadKernelError(g.code, f.id);
          along = pathPlacements(g, n);
          if (!along) throw new CadKernelError('pattern-path', f.id);
        }
        for (let i = 0; i < n; i++) {
          const trsf = own(new oc.gp_Trsf_1());
          if (l.type === 'curve') {
            // Into the sketch's frame, from the start to copy i's place (turned with the path when
            // aligned), and back to world space.
            const [p0, p] = [along![0]!, along![i]!];
            const frame = frameTrsf(l.path.sketchId);
            const step = own(new oc.gp_Trsf_1());
            step.SetTranslation_1(own(new oc.gp_Vec_4(p.at[0], p.at[1], 0)));
            const turn = own(new oc.gp_Trsf_1());
            turn.SetRotation_1(
              own(new oc.gp_Ax1_2(pnt(0, 0, 0), own(new oc.gp_Dir_4(0, 0, 1)))),
              l.align ? p.angle - p0.angle : 0,
            );
            const back = own(new oc.gp_Trsf_1());
            back.SetTranslation_1(own(new oc.gp_Vec_4(-p0.at[0], -p0.at[1], 0)));
            trsf.Multiply(frame);
            trsf.Multiply(step);
            trsf.Multiply(turn);
            trsf.Multiply(back);
            trsf.Multiply(own(frame.Inverted()));
          } else if (l.type === 'linear') {
            const d = len(l.spacing) * i;
            trsf.SetTranslation_1(own(new oc.gp_Vec_4(...l.direction.map((x) => x * d))));
          } else {
            const axis = own(
              new oc.gp_Ax1_2(
                pnt(...resolvePosition(l.axisOrigin, params)),
                own(new oc.gp_Dir_4(...l.axisDirection)),
              ),
            );
            trsf.SetRotation_1(axis, resolveAngle(l.angle, params) * i);
          }
          const builder = own(new oc.BRepBuilderAPI_Transform_2(tool!.shape, trsf, false));
          copies.push(
            carry(own(builder.Shape()), tool!, (face) => [own(builder.ModifiedShape(face))]),
          );
        }
        // A copy that cuts nothing is refused like a Boolean's tool (F04), for each copy.
        if (f.args.mode === 'cut')
          for (const copy of copies)
            if (!overlaps(target!, copy)) throw new CadKernelError('pattern-no-overlap', f.id);
        // Copy i's faces are `copy:<pattern ID>:<i>/…` (命名), from the layout alone.
        const prefixes = copies.map((_, i) => `copy:${f.id}:${i}`);
        return combine(f.id, f.args.mode, target!, copies, prefixes);
      }
      case 'mirror': {
        const input = shapes.get(f.inputFeatureIds[0])!;
        let origin: Vec3;
        let normal: Vec3;
        const plane = f.args.plane;
        if ('face' in plane) {
          const [index] = resolveRefs(f, input, [{ path: ['plane', 'face'], ref: plane.face }]);
          const table = tableOf(input);
          const fitted = planeOf(table.face(index!), table.topology.faces[index!]!.area);
          if (!fitted)
            throw new CadKernelError('mirror-face-not-planar', f.id, false, undefined, [
              ['plane', 'face'],
            ]);
          [origin, normal] = fitted;
        } else [origin, normal] = [resolvePosition(plane.origin, params), plane.normal];
        const trsf = own(new oc.gp_Trsf_1());
        trsf.SetMirror_3(own(new oc.gp_Ax2_3(pnt(...origin), own(new oc.gp_Dir_4(...normal)))));
        const builder = own(new oc.BRepBuilderAPI_Transform_2(input.shape, trsf, true));
        // The reflection's faces are `mirror:<mirror ID>/…` (命名).
        const copy = carry(
          own(builder.Shape()),
          input,
          (face) => [own(builder.ModifiedShape(face))],
          (name) => prefixFaceName(`mirror:${f.id}`, name),
        );
        return f.args.union ? combine(f.id, 'union', input, [copy], ['']) : copy;
      }
      case 'fillet':
      case 'chamfer': {
        const input = shapes.get(f.inputFeatureIds[0])!;
        const a = f.args;
        const uses: Use[] = a.edges.map((ref, i) => ({ path: ['edges', i], ref }));
        const face = 'face' in a ? a.face : undefined;
        if (face) uses.push({ path: ['face'], ref: face });
        const found = resolveRefs(f, input, uses);
        const table = tableOf(input);
        const edges = a.edges.map((ref, i) => ({
          shape: table.edge(found[i]!),
          ref,
          path: ['edges', i] as (string | number)[],
        }));
        let op;
        if (f.type === 'fillet') {
          op = own(
            new oc.BRepFilletAPI_MakeFillet(input.shape, oc.ChFi3d_FilletShape.ChFi3d_Rational),
          );
          const r = len(f.args.radius);
          for (const e of edges) op.Add_2(r, e.shape);
        } else {
          op = own(new oc.BRepFilletAPI_MakeChamfer(input.shape));
          const d = len(f.args.distance);
          if (face) {
            const fi = found[found.length - 1]!;
            const notAdjacent = edges.filter(
              (_, i) => !table.topology.edges[found[i]!]!.faces.includes(fi),
            );
            if (notAdjacent.length)
              throw new CadKernelError(
                'chamfer-face-not-adjacent',
                f.id,
                false,
                undefined,
                notAdjacent.map((e) => e.path),
              );
            const d2 = len((a as { distance2: Length }).distance2);
            for (const e of edges) op.Add_3(d, d2, e.shape, table.face(fi));
          } else for (const e of edges) op.Add_2(d, e.shape);
        }
        return blend(f, input, op, edges);
      }
      case 'shell': {
        const input = shapes.get(f.inputFeatureIds[0])!;
        // K1: OCCT offsets one solid; a body of several is refused rather than half-shelled.
        let inputSolids = 0;
        explore(input.shape, 'TopAbs_SOLID', () => inputSolids++);
        if (inputSolids > 1) throw new CadKernelError('shell-multiple-solids', f.id);
        const open = f.args.openFaces;
        const found = resolveRefs(
          f,
          input,
          open.map((ref, i) => ({ path: ['openFaces', i], ref })),
        );
        const table = tableOf(input);
        const faces = own(new oc.TopTools_ListOfShape_1());
        for (const i of found) own(faces.Append_1(table.face(i)));
        const t = len(f.args.thickness);
        const thick = (join: unknown) => {
          const op = own(new oc.BRepOffsetAPI_MakeThickSolid());
          op.MakeThickSolidByJoin(
            input.shape,
            faces,
            f.args.side === 'inside' ? -t : t,
            doc.kernelProfile.linearToleranceMm,
            oc.BRepOffset_Mode.BRepOffset_Skin,
            false,
            false,
            join,
            false,
            own(new oc.Message_ProgressRange_1()),
          );
          return op;
        };
        // Sharp joins (intersection): the inner wall of a box is a box, as the offset says. OCCT
        // cannot intersect the offsets of faces that meet tangentially (a filleted body); there
        // the joins are arcs, which for an inner wall round only its concave corners.
        let op = thick(oc.GeomAbs_JoinType.GeomAbs_Intersection);
        if (!op.IsDone()) op = thick(oc.GeomAbs_JoinType.GeomAbs_Arc);
        if (!op.IsDone()) throw new CadKernelError('shell-failed', f.id);
        // OCCT's offset gives the edges it builds a fixed 1e-3 mm tolerance whatever their
        // geometry. Limit it to the result tolerance; the checks every result passes (geometry
        // checks on) then decide whether the shape really is that precise.
        if (typeof oc.ShapeFix_ShapeTolerance === 'function')
          own(new oc.ShapeFix_ShapeTolerance()).LimitTolerance(
            own(op.Shape()),
            0,
            doc.kernelProfile.maxResultLinearToleranceMm,
            oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
          );
        // The offset wall of each face is generated from it: `inner/<its name>` (命名).
        const result = carry(own(op.Shape()), input, history(op));
        if (naming)
          for (let i = 1; i <= input.faces.Size(); i++) {
            const name = input.names[i - 1];
            if (!name) continue;
            for (const face of listOf(op.Generated(own(input.faces.FindKey(i))))) {
              const j = result.faces.FindIndex(face);
              if (j > 0 && !result.names[j - 1])
                result.names[j - 1] = prefixFaceName('inner', name);
            }
          }
        if (open.length) return result;
        // With no face open OCCT gives the offset solid alone, not the wall between it and the
        // body: cut the inner of the two out of the outer, leaving an enclosed cavity. An outward
        // offset comes back inside out (negative volume), so it is turned first.
        const props = own(new oc.GProp_GProps_1());
        oc.BRepGProp.VolumeProperties_1(result.shape, props, false, false, false);
        const offset: Named =
          props.Mass() < 0
            ? { ...result, shape: own((result.shape as { Reversed(): unknown }).Reversed()) }
            : result;
        const [outer, inner] = f.args.side === 'inside' ? [input, offset] : [offset, input];
        const cut = own(
          new oc.BRepAlgoAPI_Cut_3(outer.shape, inner.shape, own(new oc.Message_ProgressRange_1())),
        );
        if (!cut.IsDone() || cut.HasErrors()) throw new CadKernelError('shell-failed', f.id);
        const image = history(cut);
        return carryTools(
          carry(own(cut.Shape()), outer, image),
          [{ tool: inner, prefix: '' }],
          image,
        );
      }
      case 'draft': {
        const input = shapes.get(f.inputFeatureIds[0])!;
        const uses: Use[] = f.args.faces.map((ref, i) => ({ path: ['faces', i], ref }));
        uses.push({ path: ['neutral'], ref: f.args.neutral });
        const found = resolveRefs(f, input, uses);
        const table = tableOf(input);
        const direction = f.args.direction;
        // The neutral plane passes through the neutral face, normal to the pull direction: every
        // point of that face must lie in it.
        const neutral = table.face(found[found.length - 1]!);
        const { centroid: c, area } = table.topology.faces[found[found.length - 1]!]!;
        const points = facePoints(neutral, area);
        const flat =
          points.length > 0 &&
          points.every((p) => {
            const off = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
            const d = off[0]! * direction[0] + off[1]! * direction[1] + off[2]! * direction[2];
            return Math.abs(d) <= 1e-6 * Math.max(1, Math.hypot(...off));
          });
        if (!flat)
          throw new CadKernelError('draft-neutral-plane', f.id, false, undefined, [['neutral']]);
        const dir = own(new oc.gp_Dir_4(...direction));
        const plane = own(new oc.gp_Pln_3(pnt(...c), dir));
        const angle = resolveAngle(f.args.angle, params);
        const op = own(new oc.BRepOffsetAPI_DraftAngle_2(input.shape));
        f.args.faces.forEach((_, i) => {
          op.Add(table.face(found[i]!), dir, angle, plane, true);
          if (!op.AddDone())
            throw new CadKernelError('draft-failed', f.id, false, undefined, [['faces', i]]);
        });
        op.Build(own(new oc.Message_ProgressRange_1()));
        if (!op.IsDone()) throw new CadKernelError('draft-failed', f.id);
        return carry(own(op.Shape()), input, (face) => [own(op.ModifiedShape(face))]);
      }
    }
  }
  /**
   * A named shape's topology table (faces in face-map order, edges in the order of the edge →
   * face map) and the kernel shapes of its edges and faces, for resolving references on it.
   */
  const tables = new WeakMap<Named, ReturnType<typeof makeTable>>();
  const tableOf = (body: Named) => {
    let t = tables.get(body);
    if (!t) tables.set(body, (t = makeTable(body)));
    return t;
  };
  function makeTable(body: Named) {
    const topology: CadTopologyTable = { faces: [], edges: [], vertices: [] };
    for (let face = 1; face <= body.faces.Size(); face++)
      topology.faces.push({
        name: body.names[face - 1] ?? null,
        ...faceProps(own(oc.TopoDS.Face_1(own(body.faces.FindKey(face))))),
      });
    const ancestors = naming
      ? own(new oc.TopTools_IndexedDataMapOfShapeListOfShape_1())
      : { Size: () => 0, FindKey: () => undefined };
    if (naming)
      oc.TopExp.MapShapesAndAncestors(
        body.shape,
        oc.TopAbs_ShapeEnum.TopAbs_EDGE,
        oc.TopAbs_ShapeEnum.TopAbs_FACE,
        ancestors,
      );
    const vertexMap = naming ? shapeMap(body.shape, 'TopAbs_VERTEX') : undefined;
    for (let v = 1; v <= (vertexMap?.Size() ?? 0); v++) {
      const p = own(oc.BRep_Tool.Pnt(own(oc.TopoDS.Vertex_1(own(vertexMap!.FindKey(v))))));
      topology.vertices.push({ centroid: [p.X(), p.Y(), p.Z()] });
    }
    const boundary = new Map<number, CadFaceName>();
    for (const { edge, name } of body.edges ?? []) {
      const i = ancestors.FindIndex(edge);
      if (i > 0 && !boundary.has(i)) boundary.set(i, name);
    }
    const edge = (i: number) => own(oc.TopoDS.Edge_1(own(ancestors.FindKey(i + 1))));
    for (let e = 1; e <= ancestors.Size(); e++) {
      const shape = edge(e - 1);
      const faces = [
        ...new Set(listOf(ancestors.FindFromIndex(e)).map((f) => body.faces.FindIndex(f) - 1)),
      ].filter((f) => f >= 0);
      const vertices = new Set<number>();
      explore(shape, 'TopAbs_VERTEX', (v) => vertices.add(vertexMap!.FindIndex(v) - 1));
      const props = own(new oc.GProp_GProps_1());
      oc.BRepGProp.LinearProperties(shape, props, false, false);
      // A boundary names a free edge only: not a seam, where a face meets itself, nor a pole.
      const name = boundary.get(e);
      const free =
        name &&
        faces.length === 1 &&
        !oc.BRep_Tool.IsClosed_2(
          shape,
          own(oc.TopoDS.Face_1(own(body.faces.FindKey(faces[0]! + 1)))),
        ) &&
        !oc.BRep_Tool.Degenerated(shape);
      topology.edges.push({
        faces,
        vertices: [...vertices],
        centroid: centroid(props),
        length: props.Mass(),
        ...(free ? { boundary: name } : {}),
      });
    }
    const face = (i: number) => own(oc.TopoDS.Face_1(own(body.faces.FindKey(i + 1))));
    return { topology, edge, face };
  }
  /** One reference of a feature, with its place in the feature's args. */
  type Use = { path: (string | number)[]; ref: CadTopologyRef };
  /**
   * Resolves every reference of `f` (a feature, or a sketch's attachment) on its input (docs/cad/r1-modeling.md, 解決). Any that is
   * ambiguous or missing fails the feature, listing each broken one with the candidates a person
   * could pick; nothing is matched by geometry.
   */
  function resolveRefs(f: { id: string }, input: Named, uses: Use[]): number[] {
    if (!naming) throw new CadKernelError('feature-unsupported-build', f.id);
    const { topology } = tableOf(input);
    const problems: CadReferenceProblem[] = [];
    const out: number[] = [];
    for (const { path, ref } of uses) {
      const r = resolveTopologyRef(topology, ref);
      if (r.status === 'resolved') {
        out.push(r.index);
        continue;
      }
      out.push(-1);
      const candidates = (r.status === 'ambiguous' ? r.candidates : [])
        .slice(0, cadReferenceCandidates)
        .map((i) => {
          const hint = elementGeometry(topology, ref.kind, i);
          try {
            return { hint, ref: topologyRefOf(topology, ref.kind, i, ref.featureId) };
          } catch {
            return { hint };
          }
        });
      problems.push({ featureId: f.id, path, status: r.status, candidates });
    }
    if (problems.length)
      throw new CadKernelError(`reference-${problems[0]!.status}`, f.id, false, problems);
    return out;
  }
  /** Each face of `result` that is an image of a face of `input`, through a builder's history. */
  const history =
    (op: { IsDeleted(s: unknown): boolean; Modified(s: unknown): unknown }) => (face: unknown) => {
      if (op.IsDeleted(face)) return [];
      const modified = listOf(op.Modified(face));
      return modified.length ? modified : [face];
    };
  /** A fillet or chamfer: names its blend faces by the edges they replace (命名). */
  function blend(
    f: Extract<CadFeature, { type: 'fillet' | 'chamfer' }>,
    input: Named,
    op: OcModule,
    edges: { shape: unknown; ref: CadTopologyRef; path: (string | number)[] }[],
  ): Named {
    op.Build(own(new oc.Message_ProgressRange_1()));
    if (!op.IsDone()) {
      // The contours the kernel could not build, as the references that make them.
      const failed = new Set<number>();
      const faulty = typeof op.NbFaultyContours === 'function' ? op.NbFaultyContours() : 0;
      for (let i = 1; i <= faulty; i++) {
        const contour = op.FaultyContour(i);
        for (let j = 1; j <= op.NbEdges(contour); j++) {
          const e = own(op.Edge(contour, j));
          edges.forEach(
            (x, k) => (x.shape as { IsSame(o: unknown): boolean }).IsSame(e) && failed.add(k),
          );
        }
      }
      throw new CadKernelError(
        `${f.type}-failed`,
        f.id,
        false,
        undefined,
        (failed.size ? [...failed] : edges.map((_, k) => k)).map((k) => edges[k]!.path),
      );
    }
    const result = carry(own(op.Shape()), input, history(op));
    for (const { shape, ref } of edges) {
      const name = blendFaceName(ref.name);
      for (const face of listOf(op.Generated(shape))) {
        const j = result.faces.FindIndex(face);
        if (j > 0 && !result.names[j - 1]) result.names[j - 1] = name;
      }
    }
    return result;
  }
  function mesh(
    bodyId: string,
    body: Named,
    base: { faces: number; edges: number },
    origin: [number, number, number],
    deflectionMm: number,
  ): CadMesh {
    const shape = body.shape;
    const curvature: { face: unknown; tri: OcModule; offset: number }[] = [];
    own(
      new oc.BRepMesh_IncrementalMesh_2(
        shape,
        deflectionMm,
        false,
        options.angularDeflectionRad ?? 0.5,
        false,
      ),
    );
    const positions: number[] = [];
    const indices: number[] = [];
    const faceIds: number[] = [];
    const { topology, edge: edgeShape } = tableOf(body);
    /** Each face's triangulation and where its nodes start in `positions`, for edge polylines. */
    const triangulations: {
      handle: { IsNull(): boolean; get(): OcModule };
      loc: unknown;
      offset: number;
    }[] = [];
    // Faces in face-map order, so pick ids and the topology table index the same faces.
    for (let face = 1; face <= body.faces.Size(); face++) {
      const topoFace = own(oc.TopoDS.Face_1(own(body.faces.FindKey(face))));
      const loc = own(new oc.TopLoc_Location_1());
      const handle = own(oc.BRep_Tool.Triangulation(topoFace, loc, 0));
      const offset = positions.length / 3;
      triangulations.push({ handle, loc, offset });
      if (handle.IsNull()) continue;
      const tri = handle.get();
      const trsf = own(loc.Transformation());
      for (let i = 1; i <= tri.NbNodes(); i++) {
        const p = own(own(tri.Node(i)).Transformed(trsf));
        positions.push(p.X() - origin[0], p.Y() - origin[1], p.Z() - origin[2]);
      }
      if (options.curvature) curvature.push({ face: topoFace, tri, offset });
      const reversed = topoFace.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
      for (let i = 1; i <= tri.NbTriangles(); i++) {
        const t = own(tri.Triangle(i));
        const [a, b, c] = [t.Value(1), t.Value(2), t.Value(3)].map((n: number) => offset + n - 1);
        indices.push(...(reversed ? [a, c, b] : [a, b, c]));
        faceIds.push(base.faces + face);
      }
    }
    // Each edge's polyline on the triangulation of its first face.
    const edgePoints: number[] = [];
    const edgeIds: number[] = [];
    for (let e = 1; e <= topology.edges.length; e++) {
      const edge = edgeShape(e - 1);
      const { faces } = topology.edges[e - 1]!;
      const on = faces.length ? triangulations[faces[0]!] : undefined;
      if (!on || on.handle.IsNull()) continue;
      const polygon = own(oc.BRep_Tool.PolygonOnTriangulation_1(edge, on.handle, on.loc));
      if (polygon.IsNull()) continue;
      const nodes = polygon.get();
      for (let i = 1; i < nodes.NbNodes(); i++) {
        for (const n of [nodes.Node(i), nodes.Node(i + 1)]) {
          const k = (on.offset + n - 1) * 3;
          edgePoints.push(positions[k]!, positions[k + 1]!, positions[k + 2]!);
        }
        edgeIds.push(base.edges + e);
      }
    }
    const pos = new Float32Array(positions);
    const normals = vertexNormals(pos, indices);
    let curvatures: CadMesh['curvature'];
    if (options.curvature) {
      curvatures = {
        mean: new Float32Array(pos.length / 3),
        gauss: new Float32Array(pos.length / 3),
      };
      for (const c of curvature)
        nodeCurvature(oc, own, c.face, c.tri, curvatures.mean, curvatures.gauss, c.offset);
    }
    // Shared vertices are visited once per edge: keep each point once.
    const vertices = new Map<string, [number, number, number]>();
    explore(shape, 'TopAbs_VERTEX', (current) => {
      const p = own(oc.BRep_Tool.Pnt(own(oc.TopoDS.Vertex_1(current))));
      const xyz: [number, number, number] = [p.X(), p.Y(), p.Z()];
      vertices.set(xyz.join(','), xyz);
    });
    return {
      bodyId,
      origin,
      positions: pos,
      normals,
      indices: new Uint32Array(indices),
      faceIds: new Uint32Array(faceIds),
      vertices: new Float64Array([...vertices.values()].flat()),
      faceBase: base.faces,
      edgeBase: base.edges,
      edges: new Float32Array(edgePoints),
      edgeIds: new Uint32Array(edgeIds),
      topology,
      ...(curvatures ? { curvature: curvatures } : {}),
    };
  }

  /**
   * R2b-4: a coarse display mesh of a body, triangles only (no pick table or edges: a pick reads
   * the standard mesh). The standard triangulation is removed first and this one after, so the
   * shape keeps none and a later mesh of it is made afresh.
   */
  /**
   * Triangles only, no pick table: a coarse display mesh (LOD), or with `beforeFailure` (the
   * body's failed feature) the shape it had before that feature (U4), at the display deflection.
   */
  function coarseMesh(
    bodyId: string,
    shape: unknown,
    origin: [number, number, number],
    bounds: [Vec3, Vec3],
    beforeFailure?: string,
  ): CadMesh {
    oc.BRepTools.Clean(shape, true);
    const { relative, angularRad } = meshLod.coarse;
    own(
      new oc.BRepMesh_IncrementalMesh_2(
        shape,
        beforeFailure ? displayDeflection(bounds) : displayDeflectionMm(bounds, relative),
        false,
        beforeFailure ? (options.angularDeflectionRad ?? 0.5) : angularRad,
        false,
      ),
    );
    const positions: number[] = [];
    const indices: number[] = [];
    explore(shape, 'TopAbs_FACE', (current) => {
      const topoFace = own(oc.TopoDS.Face_1(current));
      const loc = own(new oc.TopLoc_Location_1());
      const handle = own(oc.BRep_Tool.Triangulation(topoFace, loc, 0));
      if (handle.IsNull()) return;
      const tri = handle.get();
      const trsf = own(loc.Transformation());
      const offset = positions.length / 3;
      for (let i = 1; i <= tri.NbNodes(); i++) {
        const p = own(own(tri.Node(i)).Transformed(trsf));
        positions.push(p.X() - origin[0], p.Y() - origin[1], p.Z() - origin[2]);
      }
      const reversed = topoFace.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
      for (let i = 1; i <= tri.NbTriangles(); i++) {
        const t = own(tri.Triangle(i));
        const [a, b, c] = [t.Value(1), t.Value(2), t.Value(3)].map((n: number) => offset + n - 1);
        indices.push(...(reversed ? [a, c, b] : [a, b, c]));
      }
    });
    oc.BRepTools.Clean(shape, true);
    const pos = new Float32Array(positions);
    return {
      bodyId,
      origin,
      positions: pos,
      normals: vertexNormals(pos, indices),
      indices: new Uint32Array(indices),
      faceIds: new Uint32Array(0),
      vertices: new Float64Array(0),
      faceBase: 0,
      edgeBase: 0,
      edges: new Float32Array(0),
      edgeIds: new Uint32Array(0),
      topology: { faces: [], edges: [], vertices: [] },
      ...(beforeFailure ? { beforeFailure } : { lod: 'coarse' as const }),
    };
  }

  /**
   * AP214 in millimetres, one root solid per active body, through the Emscripten FS. Names,
   * colours and feature history are not written (the export report says so).
   */
  const writeStep = (bodies: { id: string; shape: unknown }[]): Uint8Array => {
    // Builds before the STEP bindings (a retained earlier build) cannot write it; retrying will
    // not help, migrating to the current build will.
    if (typeof oc.STEPControl_Writer_1 !== 'function')
      throw new CadKernelError('step-unsupported-build');
    // The writer's defaults are the AP214 schema and millimetres; the build exposes no
    // Interface_Static setters, so the test checks both in the written header.
    const writer = own(new oc.STEPControl_Writer_1());
    for (const { id, shape } of bodies) {
      const status = writer.Transfer(
        shape,
        oc.STEPControl_StepModelType.STEPControl_AsIs,
        true,
        own(new oc.Message_ProgressRange_1()),
      );
      if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone)
        throw new CadKernelError('step-write-failed', id);
    }
    // One job runs at a time in a Worker, so a fixed path is safe. Keep it short: OCCT's writer
    // keeps a few bytes per Write that grow with the file name (docs/verification/cad-step).
    const path = '/e.step';
    try {
      if (writer.Write(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone)
        throw new CadKernelError('step-write-failed');
      return oc.FS.readFile(path) as Uint8Array;
    } finally {
      if (oc.FS.analyzePath(path).exists) oc.FS.unlink(path);
    }
  };
  /** The bodies as one compound in `BRepTools` text, as a STEP import normalizes a body. */
  const writeBrep = (
    bodies: { id: string; shape: unknown; kind: CadBodyKind; appearance: CadAppearance }[],
  ): CadBrepExport => {
    if (!bodies.length) throw new CadKernelError('brep-empty');
    if (typeof oc.BRepTools?.Write_3 !== 'function')
      throw new CadKernelError('brep-unsupported-build');
    const builder = own(new oc.BRep_Builder());
    const compound = own(new oc.TopoDS_Compound());
    builder.MakeCompound(compound);
    for (const { shape } of bodies) builder.Add(compound, shape);
    const path = '/e.brep';
    try {
      if (!oc.BRepTools.Write_3(compound, path, own(new oc.Message_ProgressRange_1())))
        throw new CadKernelError('brep-write-failed');
      const bytes = oc.FS.readFile(path) as Uint8Array;
      if (bytes.byteLength > cadLimits.brepBytes) throw new CadKernelError('brep-too-large');
      const faces = bodies.map(({ shape }) => {
        let n = 0;
        explore(shape, 'TopAbs_FACE', () => n++);
        return n;
      });
      return {
        bytes,
        bounds: boundsOf(compound),
        kinds: bodies.map((b) => b.kind),
        appearances: bodies.map((b) => ({ ...b.appearance })),
        faces,
      };
    } finally {
      if (oc.FS.analyzePath(path).exists) oc.FS.unlink(path);
    }
  };
  const kinds = new Map<string, CadBodyKind>();
  const kindOf = (id: string) => {
    let k = kinds.get(id);
    if (!k) kinds.set(id, (k = featureKind(doc, id) ?? 'solid'));
    return k;
  };
  /**
   * The checks every feature result passes, within the result tolerance: one or more valid
   * solids that do not touch (K1, up to `cadLimits.solidsPerBody`), or for a sheet feature one
   * valid shell of connected faces and no solid (docs/cad/r2a-freeform.md).
   */
  const checkSolid = (shape: unknown, featureId: string) => {
    let solids = 0;
    explore(shape, 'TopAbs_SOLID', () => solids++);
    if (kindOf(featureId) === 'sheet') {
      if (solids) throw new CadKernelError('result-kind', featureId);
      let shells = 0;
      explore(shape, 'TopAbs_SHELL', () => shells++);
      if (!shells) throw new CadKernelError('empty-result', featureId);
      if (shells > 1 || !sheetTopology(oc, shape, own).connected)
        throw new CadKernelError('sheet-disconnected', featureId);
      if (!own(new oc.BRepCheck_Analyzer(shape, true, false)).IsValid_2())
        throw new CadKernelError('invalid-sheet', featureId);
    } else {
      // K1: one or more disjoint solids, as a Boolean leaves them (overlaps are fused).
      if (!solids) throw new CadKernelError('empty-result', featureId);
      if (solids > cadLimits.solidsPerBody) throw new CadKernelError('multiple-solids', featureId);
      // Solids that only touch (a shared vertex or edge) are no clean union of them: refused.
      if (solids > 1 && solidsTouch(shape)) throw new CadKernelError('solids-touching', featureId);
      if (!own(new oc.BRepCheck_Analyzer(shape, true, false)).IsValid_2())
        throw new CadKernelError('invalid-solid', featureId);
    }
    if (maxTolerance(shape) > doc.kernelProfile.maxResultLinearToleranceMm)
      throw new CadKernelError('result-tolerance', featureId);
  };
  /** Whether two of the shape's solids share a vertex (and so maybe an edge or a face). */
  const solidsTouch = (shape: unknown) => {
    const ancestors = own(new oc.TopTools_IndexedDataMapOfShapeListOfShape_1());
    oc.TopExp.MapShapesAndAncestors(
      shape,
      oc.TopAbs_ShapeEnum.TopAbs_VERTEX,
      oc.TopAbs_ShapeEnum.TopAbs_SOLID,
      ancestors,
    );
    for (let v = 1; v <= ancestors.Size(); v++) {
      const [first, ...others] = listOf(ancestors.FindFromIndex(v)) as {
        IsSame(o: unknown): boolean;
      }[];
      if (others.some((o) => !o.IsSame(first))) return true;
    }
    return false;
  };
  /** Each kind of sub-shape's least, mean and largest tolerance: what OCCT changes in place. */
  const toleranceState = (shape: unknown) => {
    const t = own(new oc.ShapeAnalysis_ShapeTolerance());
    return ['TopAbs_VERTEX', 'TopAbs_EDGE', 'TopAbs_FACE']
      .flatMap((kind) =>
        [-1, 0, 1].map((mode) => t.Tolerance(shape, mode, oc.TopAbs_ShapeEnum[kind])),
      )
      .join(' ');
  };
  const boundsOf = (shape: unknown): [Vec3, Vec3] => {
    const box = own(new oc.Bnd_Box_1());
    oc.BRepBndLib.AddOptimal(shape, box, false, false);
    const [min, max] = [own(box.CornerMin()), own(box.CornerMax())];
    return [
      [min.X(), min.Y(), min.Z()],
      [max.X(), max.Y(), max.Z()],
    ];
  };
  const displayDeflection = (bounds: readonly [Vec3, Vec3]) =>
    options.deflectionMm ?? displayDeflectionMm(bounds, options.relativeDeflection);
  /** A failure while building feature or sketch `id`, as the kernel error it reports. */
  const kernelError = (error: unknown, id: string) => {
    if (error instanceof CadKernelError) return error;
    if (error instanceof Error && error.message === 'topology-name-too-long')
      return new CadKernelError(error.message, id);
    const { type, message } = decodeKernelException(oc, error);
    return new CadKernelError(`kernel-exception:${type}${message ? `:${message}` : ''}`, id);
  };
  const display = options.deflectionMm === undefined && !options.step && !options.brep;
  const cache = display ? options.placement : undefined;
  const features = display ? options.features : undefined;
  /** The feature cache keys this evaluation used or made, kept past the budget (P1). */
  const latest = new Set<string>();
  let settle = false;
  const identity = cache && placementIdentity(doc, options);
  /** A display evaluation (not an export) shows what it can of a failed document. */
  const partial =
    options.partial !== false &&
    options.deflectionMm === undefined &&
    !options.step &&
    !options.brep;
  let failure: CadKernelError | undefined;
  const failed = new Set<string>();
  const errorEvaluation = (
    e: CadKernelError,
    bodies?: Record<string, CadBodyEvaluation>,
  ): CadEvaluation & { status: 'error' } => ({
    status: 'error',
    contentHash,
    code: e.code,
    ...(e.featureId ? { featureId: e.featureId } : {}),
    retryable: e.retryable,
    ...(e.references ? { references: e.references } : {}),
    ...(e.failedPaths ? { failedPaths: e.failedPaths } : {}),
    ...(e.edges ? { edges: e.edges } : {}),
    ...(bodies && Object.keys(bodies).length ? { partial: bodies } : {}),
  });
  try {
    const byId = new Map(doc.features.map((f) => [f.id, f]));
    const active = doc.bodies.filter((b) => b.state === 'active');
    /** Each active body's final shape, from the kept shapes or from the full graph. */
    const finals = new Map<string, Named>();
    let fast =
      !!cache &&
      identity!.isolated &&
      cache.key === identity!.key &&
      active.every((b) => cache.bodies.get(b.id)?.placed === identity!.movable.has(b.id));
    if (fast) {
      // The kept shapes skip reading the assets, not checking them: missing or altered bytes are
      // refused as the full graph refuses them.
      for (const f of doc.features) if (f.type === 'imported') assetBytes(f);
      for (const body of active) {
        const kept = cache!.bodies.get(body.id)!;
        const keptNamed = named(kept.shape, () => null);
        keptNamed.names = [...kept.names];
        if (kept.edges.length) {
          const map = shapeMap(kept.shape, 'TopAbs_EDGE');
          keptNamed.edges = kept.edges.map(({ index, name }) => ({
            edge: own(map.FindKey(index)),
            name,
          }));
        }
        if (!kept.placed) {
          finals.set(body.id, keptNamed);
          continue;
        }
        const f = byId.get(body.resultFeatureId) as Extract<CadFeature, { type: 'transform' }>;
        await options.checkpoint?.(f.id);
        const shape = place(
          keptNamed,
          f.args.rotation,
          resolvePosition(f.args.translation, params),
        );
        checkSolid(shape.shape, f.id);
        // A pose that changes the display deflection (its bounding box) re-meshes from the full
        // graph: the kept faces still carry the earlier triangulation.
        if (displayDeflection(boundsOf(shape.shape)) !== kept.deflectionMm) {
          fast = false;
          break;
        }
        finals.set(body.id, shape);
      }
    }
    const shapes = new Map<string, Named>();
    const slice = options.slice;
    const now = slice?.now ?? (() => performance.now());
    let sliceStart = slice && now();
    /** Steps of a split evaluation (CM-4): the graph's nodes, then the meshed bodies. */
    let steps = 0;
    const paused = async (done: number) => {
      if (!slice || now() - sliceStart! < slice.ms) return;
      await slice.pause(done, steps);
      sliceStart = now();
    };
    if (!fast) {
      finals.clear();
      // The shapes the placement path borrowed may leave the feature cache from here on.
      if (features && cache?.borrowed) cache.release();
      settle = !!features;
      // Features and sketches in one order: a sketch after the feature it is attached to and
      // before the features that sweep it (docs/cad/r1-modeling.md, 依存関係と評価順).
      const graph = dependencyOrder(doc);
      if ('cycle' in graph) throw new CadKernelError('cad-dependency-cycle');
      steps = graph.order.length + active.length;
      // A display evaluation goes on past a failed feature (docs/cad/complex-models.md, U4): the
      // nodes that read it fail with it, the others are built as usual.
      const reads = partial || features ? dependencyEdges(doc) : undefined;
      const keys = new Map<string, string>();
      /**
       * A node's cache key (P1): the node, the parameters and profiles it reads (a profile with
       * the parameters it reads), the kernel profile and build, and the keys of what it reads.
       * Names are left out: no shape reads them. An imported feature also reads its assets' hashes.
       */
      const keyOf = (id: string) => {
        const node = byId.get(id) ?? sketches.get(id);
        // No prototype: a valid ID such as `toString` is a key like any other.
        const used = {
          parameters: Object.create(null) as Record<string, unknown>,
          profiles: Object.create(null) as Record<string, unknown>,
          assets: Object.create(null) as Record<string, unknown>,
        };
        const visit = (x: unknown) => {
          if (Array.isArray(x)) return x.forEach(visit);
          if (!x || typeof x !== 'object') return;
          for (const [k, v] of Object.entries(x)) {
            if (k === 'parameterId' && typeof v === 'string')
              used.parameters[v] = params.get(v) ?? null;
            else if (
              k === 'profileId' &&
              typeof v === 'string' &&
              !Object.hasOwn(used.profiles, v)
            ) {
              used.profiles[v] = { ...profiles.get(v), name: undefined };
              visit(profiles.get(v));
            } else if (k.endsWith('AssetId') && typeof v === 'string')
              // An imported shape is its bytes: the same ID may name other bytes later.
              used.assets[v] = doc.assets.find((a) => a.id === v) ?? null;
            else visit(v);
          }
        };
        visit(node);
        const text = JSON.stringify([
          doc.kernelProfile,
          { ...node, name: undefined },
          used,
          reads!.get(id)!.map((r) => keys.get(r)),
        ]);
        const key = bytesToHex(sha256(new TextEncoder().encode(text)));
        keys.set(id, key);
        return key;
      };
      /** Each built or reused feature's tolerances as built (P1). */
      const states = new Map<string, string>();
      /** The features `id` reads whose shapes are no longer as they were built. */
      const changed = (id: string) =>
        reads!
          .get(id)!
          .filter((r) => states.has(r) && toleranceState(shapes.get(r)!.shape) !== states.get(r));
      for (const [position, id] of graph.order.entries()) {
        if (failure && reads!.get(id)!.some((r) => failed.has(r))) {
          failed.add(id);
          continue;
        }
        const sketch = sketches.get(id);
        if (sketch) {
          if (features) keyOf(id);
          try {
            frames.set(id, sketchFrame(sketch, shapes));
          } catch (error) {
            if (!partial) throw kernelError(error, id);
            failure ??= kernelError(error, id);
            failed.add(id);
          }
          continue;
        }
        await options.checkpoint?.(id);
        const started = options.timing && performance.now();
        const f = byId.get(id)!;
        const key = features && keyOf(id);
        let kept = key ? features!.get(key) : undefined;
        if (kept && (changed(id).length || toleranceState(kept.shape) !== kept.state)) {
          features!.drop(key!);
          kept = undefined;
        }
        if (kept) {
          try {
            // A kept shape skips reading the asset, not checking it, as the placement path.
            if (f.type === 'imported') assetBytes(f);
          } catch (error) {
            if (!partial) throw kernelError(error, f.id);
            failure ??= kernelError(error, f.id);
            failed.add(id);
            continue;
          }
          latest.add(key!);
          oc.BRepTools.Clean(kept.shape, true);
          states.set(id, kept.state);
          const reused = named(kept.shape, () => null);
          reused.names = [...kept.names];
          if (kept.edges.length) {
            const map = shapeMap(kept.shape, 'TopAbs_EDGE');
            reused.edges = kept.edges.map(({ index, name }) => ({
              edge: own(map.FindKey(index)),
              name,
            }));
          }
          shapes.set(id, reused);
          continue;
        }
        // A long evaluation pauses before a feature to build (CM-4).
        await paused(position);
        // Inputs a feature before this one changed in place: this one is built, never kept.
        const keepable = !!key && !changed(id).length;
        let shape;
        try {
          shape = build(f, shapes);
          checkSolid(shape.shape, f.id);
        } catch (error) {
          if (!partial) throw kernelError(error, f.id);
          failure ??= kernelError(error, f.id);
          failed.add(id);
          continue;
        }
        shapes.set(id, shape);
        if (options.timing) options.timing('feature', id, performance.now() - started!);
        if (key) states.set(id, toleranceState(shape.shape));
        if (keepable && !changed(id).length) {
          latest.add(key!);
          // The cache owns the shape from here: this job's other handles are deleted.
          const stored = shape.shape as Shape;
          owned.delete(stored);
          const edgeMap = shapeMap(shape.shape, 'TopAbs_EDGE');
          const vertices = shapeMap(shape.shape, 'TopAbs_VERTEX').Size();
          const { perFace, perEdge, perVertex } = featureCacheBudget;
          features!.put(key!, {
            shape: stored,
            state: states.get(id)!,
            names: [...shape.names],
            edges: (shape.edges ?? []).flatMap(({ edge, name }) => {
              const index = edgeMap.FindIndex(edge);
              return index > 0 ? [{ index, name }] : [];
            }),
            bytes: shape.faces.Size() * perFace + edgeMap.Size() * perEdge + vertices * perVertex,
          });
        }
      }
      for (const body of active)
        if (shapes.has(body.resultFeatureId))
          finals.set(body.id, shapes.get(body.resultFeatureId)!);
    }
    // After a failure only the bodies outside it are measured and meshed.
    const shown = failure ? active.filter((b) => finals.has(b.id)) : active;
    const bodies: Record<string, CadBodyEvaluation> = {};
    const meshes: CadMesh[] = [];
    // Coarse meshes (R2b-4) are made last: cleaning a shape's triangulation for them would
    // change the continuity samples and anything else read from the standard one.
    const coarseOf: (() => CadMesh)[] = [];
    const deflections = new Map<string, number>();
    const base = { faces: 0, edges: 0 };
    /** Solids of the active bodies so far (K1, `cadLimits.solids`). */
    let allSolids = 0;
    for (const [index, body] of shown.entries()) {
      if (steps) await paused(steps - active.length + index);
      await options.checkpoint?.(body.id);
      const started = options.timing && performance.now();
      const final = finals.get(body.id)!;
      const shape = final.shape;
      const metrics = shapeMetrics(oc, shape, own, body.kind !== 'sheet');
      const bounds = boundsOf(shape);
      const [min, max] = bounds;
      if (body.kind === 'sheet') {
        const { freeEdges, freeEdgeLengthMm } = sheetTopology(oc, shape, own);
        bodies[body.id] = {
          kind: 'sheet',
          areaMm2: metrics.areaMm2,
          bounds,
          freeEdges,
          freeEdgeLengthMm,
        };
      } else {
        let solids = 0;
        explore(shape, 'TopAbs_SOLID', () => solids++);
        allSolids += solids;
        if (allSolids > cadLimits.solids)
          throw new CadKernelError('limit-solids', body.resultFeatureId);
        bodies[body.id] = {
          kind: 'solid',
          volumeMm3: metrics.volumeMm3!,
          areaMm2: metrics.areaMm2,
          bounds,
          // Only past one: a single solid's evaluation is as before K1.
          ...(solids > 1 ? { solids } : {}),
        };
      }
      deflections.set(body.id, displayDeflection(bounds));
      // Float32 positions are relative to the box centre so small features far from the
      // model origin keep distinct vertices.
      const m = mesh(
        body.id,
        final,
        { ...base },
        [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
        deflections.get(body.id)!,
      );
      base.faces += m.topology.faces.length;
      base.edges += m.topology.edges.length;
      meshes.push(m);
      if (options.coarse) coarseOf.push(() => coarseMesh(body.id, shape, m.origin, bounds));
      if (options.timing) options.timing('mesh', body.id, performance.now() - started!);
      const triangles = meshes.reduce((n, x) => n + x.indices.length / 3, 0);
      if (
        base.faces > cadOutputLimits.faces ||
        triangles > cadOutputLimits.triangles ||
        meshBytes(meshes) > cadOutputLimits.bufferBytes
      )
        throw new CadKernelError('output-limit', body.id);
    }
    if (failure) {
      // Each failed body as it was before the failure: the last shape built along its first
      // inputs from its result. Display only: no pick table, no measurement, never exported.
      for (const body of active) {
        if (finals.has(body.id)) continue;
        // The body's own failed feature is the last one walked before a built shape.
        let id: string | undefined = body.resultFeatureId;
        let at = id;
        while (id && !shapes.has(id)) [at, id] = [id, byId.get(id)?.inputFeatureIds[0]];
        if (!id) continue;
        await options.checkpoint?.(body.id);
        const shape = shapes.get(id)!.shape;
        const bounds = boundsOf(shape);
        const [min, max] = bounds;
        const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
        meshes.push(coarseMesh(body.id, shape, centre, bounds, at));
      }
      if (
        meshes.reduce((n, x) => n + x.indices.length / 3, 0) > cadOutputLimits.triangles ||
        meshBytes(meshes) > cadOutputLimits.bufferBytes
      )
        throw failure;
      return { evaluation: errorEvaluation(failure, bodies), meshes };
    }
    // Connector frames, from each body's final (placed) shape by its result feature.
    const connectors = options.connectors?.map((ref): CadConnectorFrame => {
      const body = active.find((b) => b.resultFeatureId === ref.featureId);
      if (!body) return { status: 'missing', candidates: [] };
      if (!naming) return { status: 'unsupported' };
      try {
        return connectorFrame(oc, own, tableOf(finals.get(body.id)!), ref);
      } catch (error) {
        // A geometry the kernel cannot read is no connector; it never fails the shape itself.
        decodeKernelException(oc, error);
        return { status: 'unsupported' };
      }
    });
    let continuity: CadContinuityResult | undefined;
    if (options.continuity) {
      const { bodyId, edge } = options.continuity;
      const final = finals.get(bodyId);
      const table = final && tableOf(final);
      const faces = table?.topology.edges[edge]?.faces;
      const face = (i: number) => own(oc.TopoDS.Face_1(own(final!.faces.FindKey(i + 1))));
      // One face on both sides is a seam inside that face, a pole is a point: neither is an
      // edge between two faces.
      continuity = !faces?.length
        ? { code: 'continuity-edge-missing' }
        : faces.length === 1
          ? {
              code: oc.BRep_Tool.Degenerated(table!.edge(edge))
                ? 'continuity-degenerate'
                : oc.BRep_Tool.IsClosed_2(table!.edge(edge), face(faces[0]!))
                  ? 'continuity-seam'
                  : 'continuity-free-edge',
            }
          : faces.length > 2
            ? { code: 'continuity-nonmanifold' }
            : (() => {
                const samples = edgeContinuity(oc, own, table!.edge(edge), [
                  face(faces[0]!),
                  face(faces[1]!),
                ]);
                return typeof samples === 'string' ? { code: samples } : { samples };
              })();
    }
    let comb: CadCombResult | undefined;
    if (options.comb) {
      const { bodyId, edge } = options.comb;
      const final = finals.get(bodyId);
      const table = final && tableOf(final);
      const shape = table && edge >= 0 && edge < table.topology.edges.length && table.edge(edge);
      const samples = shape && !oc.BRep_Tool.Degenerated(shape) && edgeComb(oc, own, shape);
      comb = !shape
        ? { code: 'curvature-edge-missing' }
        : samples
          ? { samples }
          : {
              code: oc.BRep_Tool.Degenerated(shape) ? 'curvature-degenerate' : 'curvature-no-curve',
            };
    }
    let step: Uint8Array | undefined;
    if (options.step) {
      // Named by the body being written, like a mesh checkpoint.
      if (active.length) await options.checkpoint?.(active[0].id);
      step = writeStep(active.map((b) => ({ id: b.id, shape: finals.get(b.id)!.shape })));
      // K2: the tolerance set and the largest tolerance written, as a note in the header.
      const set = cadToleranceSetOf(doc.kernelProfile);
      if (set)
        step = withToleranceNote(
          step,
          set,
          Math.max(0, ...active.map((b) => maxTolerance(finals.get(b.id)!.shape))),
        );
    }
    let brep: CadBrepExport | undefined;
    if (options.brep) {
      if (active.length) await options.checkpoint?.(active[0].id);
      brep = writeBrep(
        active.map((b) => ({
          id: b.id,
          shape: finals.get(b.id)!.shape,
          kind: kindOf(b.resultFeatureId),
          appearance: b.appearance,
        })),
      );
    }
    // Optional: left out whole when they and the standard meshes together pass the output limits.
    let coarse: CadMesh[] = [];
    for (const make of coarseOf) {
      coarse.push(make());
      const all = [...meshes, ...coarse];
      if (
        all.reduce((n, x) => n + x.indices.length / 3, 0) > cadOutputLimits.triangles ||
        meshBytes(all) > cadOutputLimits.bufferBytes
      ) {
        coarse = [];
        break;
      }
    }
    // A full display evaluation becomes the kept shapes; they outlive this job's handles.
    if (cache && !fast && !identity!.isolated) cache.release();
    else if (cache && !fast) {
      const kept = new Map<string, KeptBody>();
      for (const body of active) {
        const placed = identity!.movable.has(body.id);
        const f = byId.get(body.resultFeatureId)!;
        const { shape, names, edges } = shapes.get(placed ? f.inputFeatureIds[0]! : f.id)!;
        // A shape the feature cache keeps stays its own; any other is the placement path's now.
        const borrowed = !owned.has(shape as Shape);
        owned.delete(shape as Shape);
        const map = edges?.length ? shapeMap(shape, 'TopAbs_EDGE') : undefined;
        kept.set(body.id, {
          ...(borrowed ? { borrowed } : {}),
          shape: shape as Shape,
          names,
          edges: (edges ?? []).flatMap(({ edge, name }) => {
            const index = map!.FindIndex(edge);
            return index > 0 ? [{ index, name }] : [];
          }),
          placed,
          deflectionMm: deflections.get(body.id)!,
        });
      }
      cache.release();
      cache.bodies = kept;
      cache.key = identity!.key;
    }
    // The geometry only: the measurements and the display meshes, not the document's hash, so
    // an edit of placed parts or joints alone keeps the digest (CM-3b).
    const digest = sha256.create();
    digest.update(new TextEncoder().encode(`${JSON.stringify(bodies)}\n`));
    for (const m of meshes) {
      const buffers = [m.origin, m.positions, m.indices, m.faceIds, m.vertices, m.edges, m.edgeIds];
      for (const b of [
        new Float64Array(buffers[0] as number[]),
        ...buffers.slice(1),
      ] as ArrayBufferView[])
        digest.update(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
      digest.update(new TextEncoder().encode(`${JSON.stringify(m.topology)}\n`));
    }
    return {
      evaluation: {
        status: 'ok',
        contentHash,
        buildHash: doc.kernelProfile.buildHash,
        geometryDigest: `sha256:${bytesToHex(digest.digest())}`,
        bodies,
        ...(connectors ? { connectors } : {}),
      },
      // The coarse meshes follow the standard ones and are not in the digest (display only).
      meshes: [...meshes, ...coarse],
      ...(step ? { step } : {}),
      ...(brep ? { brep } : {}),
      ...(continuity ? { continuity } : {}),
      ...(comb ? { comb } : {}),
    };
  } catch (error) {
    if (error instanceof CadEvaluationCancelled) throw error;
    const e =
      error instanceof CadKernelError
        ? error
        : new CadKernelError('kernel-failure', undefined, true);
    return { evaluation: errorEvaluation(e), meshes: [] };
  } finally {
    for (const value of [...owned].reverse())
      if (value && typeof value.delete === 'function' && !value.isDeleted?.()) value.delete();
    // Also after a failure or a cancel: the shapes built so far stay, within the budget.
    if (settle) features!.settle(latest);
  }
}

/** The smallest radius of the circles through three neighbouring points of a polyline. */
function tightestTurn(pts: readonly (readonly [number, number])[]): number {
  let r = Infinity;
  for (let i = 1; i + 1 < pts.length; i++) {
    const [a, b, c] = [pts[i - 1]!, pts[i]!, pts[i + 1]!];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (cross === 0) continue;
    const d = (p: readonly number[], q: readonly number[]) =>
      Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!);
    r = Math.min(r, (d(a, b) * d(b, c) * d(c, a)) / (2 * Math.abs(cross)));
  }
  return r;
}
