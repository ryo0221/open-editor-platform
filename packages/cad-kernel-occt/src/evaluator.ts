import {
  atShare,
  bezierCurve,
  distanceToCurve,
  fitCurve,
  gordonSurface,
  joinedCurve,
  movedCurve,
  reversedCurve,
  type GordonSurface,
  type NetworkCurve,
} from './gordon';
import {
  decodeKernelException,
  KernelJobCancelled,
  vertexNormals,
  type OcModule,
  faceTextureUvs,
} from '@editor-platform/geometry-kernel-occt';
import {
  attachFrame,
  cadContentHash,
  cadContinuity,
  cadFlareProfiles,
  curvatureDeviation,
  dependencyEdges,
  dependencyOrder,
  featureKind,
  loopArea,
  sketchAttachment,
  featureReferenceSources,
  cadLimits,
  cadSpotWeldLimits,
  cadToleranceSetOf,
  sketchPath,
  sketchWithOffset,
  CadSketchError,
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
  resolveSpurGear,
  spurGearProblem,
  spurGearSketch,
  resolvePosition,
  blendFaceName,
  edgeName,
  topoNameKey,
  faceNameKey,
  sharedFaceName,
  cadReferenceCandidates,
  prefixFaceName,
  resolveTopologyRef,
  topologyRefOf,
  elementGeometry,
  upstreamFeatures,
  type CadConnectorFrame,
  type CadSpotWeld,
  type CadSpotWeldPoints,
  type CadReferenceProblem,
  type CadTopologyRef,
  type CadBodyEvaluation,
  type CadAppearance,
  type CadBodyKind,
  type CadFaceName,
  type CadTopologyTable,
  type CadPmiTracking,
  type CadDocument,
  type CadEvaluation,
  type CadFeature,
  type CadProfile,
  type CadSketch,
  type CadTrimTool,
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
  pmiAssetProblem,
  cadBodyPmi,
  cadBodyPmiPlacements,
  cadPmiItemStates,
  cadPmiTrackedIndex,
  readCadPmiAsset,
  profileOutline,
  profileReach,
  rotateVector,
} from '@editor-platform/cad-core';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  AnalysisSurfaceLimit,
  finishSurface,
  improveSurface,
  type RawSurface,
  type RawTriangle,
  type SurfaceSizing,
  type Xyz,
} from './analysis-surface';
import { connectorFrame } from './connector-frames';
import { edgeContinuity, surfaceProjector } from './continuity';
import { edgeGapFlush } from './gap-flush';
import { faceSetDistances } from './face-distance';
import { spotWeldPoints } from './spot-weld';
import { edgeComb, nodeCurvature } from './curvature';
import {
  cadOutputLimits,
  meshBytes,
  type CadAnalysisPreparation,
  type CadAnalysisMeasures,
  type CadAnalysisSurface,
  type CadAnalysisSurfaceRequest,
  type CadAnalysisSurfaceResult,
  type CadBrepExport,
  type CadCombResult,
  type CadFaceDistanceQuery,
  type CadFaceDistanceResult,
  type CadGapFlushEdges,
  type CadGapFlushResult,
  type CadContinuityResult,
  type CadMesh,
  type CadPreparationHistory,
} from './protocol';
import { preparationFaces, type FaceSample } from './preparation';
import { withToleranceNote } from './formats';
import { shapeMetrics } from './metrics';
import { sheetTopology } from './sheet-topology';
import { noPmiWritten, pmiWriteSpec, writePmiStep, type CadStepPmiWritten } from './step-pmi-write';

/** The Embind module and its exception decoding live in `geometry-kernel-occt` (R2c-1). */
export { decodeKernelException, type OcModule };

/** R3i-2: a body whose midsurface is not made (`midsurface-unsupported`); the message says why. */
class MidsurfaceRefusal extends Error {}

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
   * CR3d: also sample the gap and flush from one body's border edge to another's, each by its
   * index in its body's pick table. Display only, like `continuity`.
   */
  gapFlush?: CadGapFlushEdges;
  /** CR4a: also the exact distances from points to faces, per query (bond candidates). */
  faceDistances?: CadFaceDistanceQuery[];
  /**
   * R3c-2a: also the boundary of one body as the analysis mesher's input (`CadAnalysisSurface`),
   * triangulated afresh at `deflectionMm`. Not a display evaluation.
   */
  analysisSurface?: CadAnalysisSurfaceRequest;
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
   * feature's shape by the hash of what it reads. Used and refreshed by display evaluations and
   * (CR5f-5) by analysis surface requests, which build the same exact shapes: a run asks for each
   * body's surface in turn, and builds the document once. With it, `placement` (display only)
   * borrows its kept shapes from this cache.
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
  /** PMI-4a: the shape's imported origins (`PmiOrigins`). */
  origins?: PmiOrigins;
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
const pmiKinds = ['TopAbs_FACE', 'TopAbs_EDGE', 'TopAbs_VERTEX'] as const;
type PmiKind = (typeof pmiKinds)[number];
/** The imported feature and the 1-based index of the sub-shape in its BRep's map. */
type PmiOrigin = { feature: string; index: number; exact: boolean };
/**
 * PMI-4a: the face, edge and vertex maps' imported origins, aligned with each map. An origin is
 * `exact` while every feature since the import kept that sub-shape itself (the same kernel
 * shape, placed rigidly at most); a split, a trimmed boundary, a merge or a rebuilt shape makes
 * its images inexact. A feature that does not carry origins drops them.
 */
type PmiOrigins = Record<PmiKind, (PmiOrigin | null)[]>;
const copyOrigins = (o: PmiOrigins | undefined): PmiOrigins | undefined =>
  o && {
    TopAbs_FACE: [...o.TopAbs_FACE],
    TopAbs_EDGE: [...o.TopAbs_EDGE],
    TopAbs_VERTEX: [...o.TopAbs_VERTEX],
  };
type CachedFeature = {
  shape: Shape;
  /** PMI-4a: the shape's imported origins (`PmiOrigins`). */
  origins?: PmiOrigins;
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
  // CR4e: spot welds change no shape; their points are made after the shapes.
  delete cleared.spotWelds;
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
/**
 * R3c-2a: the bounds of an analysis surface's chordal deflection: at least 1e-5 of the body's
 * bounding-box diagonal and the display minimum (finer only multiplies triangles) and at most 10 mm; the angle in (0, π/2].
 */
export const analysisDeflection = Object.freeze({ relativeMin: 1e-5, maxMm: 10 });
/** The most triangles an analysis surface may have (the mesher's input limit). */
export const analysisSurfaceTriangles = 2_000_000;

/**
 * R3c-2b: preparation settings the kernel can apply: thresholds null or positive and finite,
 * explicit faces distinct indices of the body.
 */
export function preparationOk(p: CadAnalysisPreparation, faces: number): boolean {
  const threshold = (x: number | null) => x === null || (Number.isFinite(x) && x > 0);
  return (
    threshold(p.removeHolesBelow) &&
    threshold(p.removeFilletsBelow) &&
    Array.isArray(p.removeFaces) &&
    p.removeFaces.every((f) => Number.isSafeInteger(f) && f >= 0 && f < faces) &&
    new Set(p.removeFaces).size === p.removeFaces.length
  );
}
const subV = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dotV = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossV = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const scaleV = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const normalizeV = (a: Vec3): Vec3 => scaleV(a, 1 / Math.hypot(...a));
const addV = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const lerpV = (a: Vec3, b: Vec3, t: number): Vec3 => addV(a, scaleV(subV(b, a), t));
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
  /** PMI-4b/4c: what the STEP file carries of the bodies' PMI, when any body has PMI. */
  stepPmi?: CadStepPmiWritten;
  brep?: CadBrepExport;
  continuity?: CadContinuityResult;
  comb?: CadCombResult;
  gapFlush?: CadGapFlushResult;
  faceDistances?: CadFaceDistanceResult[];
  analysisSurface?: CadAnalysisSurfaceResult;
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
    /** PMI-4a: the imported sub-shapes each face, edge and vertex comes from (`PmiOrigins`). */
    origins?: PmiOrigins;
  };
  /**
   * Origins of `result` carried from `from` through a builder's history: each origin of
   * `from` goes to its images, exact only when the image is the sub-shape itself (IsPartner)
   * and alone. A sub-shape that is an image of two origins keeps neither exactly.
   */
  const carryOrigins = (out: Named, from: Named, image: (s: unknown) => unknown[]) => {
    if (!from.origins) return;
    const maps = pmiKinds.map((k) => (k === 'TopAbs_FACE' ? out.faces : shapeMap(out.shape, k)));
    const origins = (out.origins ??= {
      TopAbs_FACE: Array(maps[0]!.Size()).fill(null),
      TopAbs_EDGE: Array(maps[1]!.Size()).fill(null),
      TopAbs_VERTEX: Array(maps[2]!.Size()).fill(null),
    });
    pmiKinds.forEach((kind, k) => {
      const list = from.origins![kind];
      if (!list.some(Boolean)) return;
      const source = kind === 'TopAbs_FACE' ? from.faces : shapeMap(from.shape, kind);
      for (let i = 1; i <= source.Size(); i++) {
        const origin = list[i - 1];
        if (!origin) continue;
        const sub = own(source.FindKey(i)) as { IsPartner(o: unknown): boolean };
        let images: unknown[];
        try {
          images = image(sub).filter(Boolean);
        } catch {
          images = [];
        }
        const exact =
          origin.exact &&
          images.length === 1 &&
          (images[0] as { IsPartner(o: unknown): boolean }).IsPartner(sub);
        for (const made of images) {
          const j = maps[k]!.FindIndex(made);
          if (j < 1) continue;
          const had = origins[kind][j - 1];
          origins[kind][j - 1] = had ? { ...had, exact: false } : { ...origin, exact };
        }
      }
    });
  };
  /** R3i-2: a body's midsurface, its thickness and the history from the body's faces and edges. */
  type Midsurface = { body: Named; history: CadPreparationHistory; thicknessMm: number };
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
    carryOrigins(out, from, image);
    for (let i = 1; i <= from.faces.Size(); i++) {
      const name = from.names[i - 1];
      if (!name) continue;
      for (const face of image(own(from.faces.FindKey(i)))) {
        const j = out.faces.FindIndex(face);
        if (j > 0 && !out.names[j - 1]) out.names[j - 1] = rename(name);
      }
    }
    for (const { edge, name } of from.edges ?? []) {
      // CR4g: a copying transform (a mirror) has no image of a named edge that is not in the
      // input's shape (a trim names the cut edges of the pieces it leaves out too).
      let made: unknown[];
      try {
        made = image(edge);
      } catch {
        made = [];
      }
      for (const e of made) (out.edges ??= []).push({ edge: e, name: rename(name) });
    }
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
    for (const { tool } of tools) carryOrigins(out, tool, image);
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
  function assetBytes(f: Extract<CadFeature, { type: 'imported' }>, id = f.args.brepAssetId) {
    const ref = doc.assets.find((a) => a.id === id);
    const bytes = ref && options.assets?.get(ref.sha256);
    if (!ref || !bytes) throw new CadKernelError('asset-missing', f.id);
    if (bytes.byteLength !== ref.byteLength || `sha256:${bytesToHex(sha256(bytes))}` !== ref.sha256)
      throw new CadKernelError('asset-hash-mismatch', f.id);
    return bytes;
  }
  /**
   * A kept shape's imported assets, checked as a rebuild checks them: the BRep's and the `pmi`
   * asset's bytes must be present and match their refs. The cache keys hold the refs, so a kept
   * shape was built (and its PMI checked against it) with the same bytes.
   */
  function checkImportedAssets(f: Extract<CadFeature, { type: 'imported' }>) {
    assetBytes(f);
    if (f.args.pmiAssetId !== undefined) assetBytes(f, f.args.pmiAssetId);
  }
  /** PMI-2 (CAD82): a `pmi` asset that does not fit its body is refused with `pmi-invalid`. */
  function checkPmi(f: Extract<CadFeature, { type: 'imported' }>, shape: unknown) {
    const bytes = assetBytes(f, f.args.pmiAssetId);
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new CadKernelError('pmi-invalid', f.id);
    }
    const count = (kind: string) => {
      const map = own(new oc.TopTools_IndexedMapOfShape_1());
      oc.TopExp.MapShapes_1(shape, oc.TopAbs_ShapeEnum[kind], map);
      return map.Extent() as number;
    };
    const counts = {
      faces: count('TopAbs_FACE'),
      edges: count('TopAbs_EDGE'),
      vertices: count('TopAbs_VERTEX'),
    };
    if (pmiAssetProblem(json, counts) !== undefined) throw new CadKernelError('pmi-invalid', f.id);
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
    if (mode === 'union') checkUnion(featureId, own(op.Shape()), [target, ...tools], image);
    return carryTools(
      carry(own(op.Shape()), target, image),
      tools.map((tool, k) => ({ tool, prefix: prefixes[k]! })),
      image,
    );
  }
  /**
   * TW4 (docs/cad/bim-tower.md): a union OCCT could not finish is refused as such, not as a
   * fault of the model. Members whose end caps meet at one point (a lattice's nodes) can make it
   * return a shape with no solid (48 tubes: 3 solids of no volume, invalid), or split one
   * operand's solid between two result solids (3 ring tubes: 2 solids that touch). A union
   * keeps each operand solid whole, in one result solid, and is never smaller than its largest
   * operand. Operands that only touch still give `solids-touching` in `checkSolid`.
   */
  function checkUnion(
    featureId: string,
    result: unknown,
    operands: Named[],
    image: (face: unknown) => unknown[],
  ) {
    const incomplete = () => new CadKernelError('boolean-incomplete', featureId);
    const solids = shapeMap(result, 'TopAbs_SOLID');
    if (!solids.Size()) throw incomplete();
    if (volume(result) < (1 - 1e-3) * Math.max(...operands.map((o) => volume(o.shape))))
      throw incomplete();
    // Builds before R1 have neither the history to follow the faces by nor the maps below.
    if (solids.Size() === 1 || !naming) return;
    const owners = own(new oc.TopTools_IndexedDataMapOfShapeListOfShape_1());
    oc.TopExp.MapShapesAndAncestors(
      result,
      oc.TopAbs_ShapeEnum.TopAbs_FACE,
      oc.TopAbs_ShapeEnum.TopAbs_SOLID,
      owners,
    );
    // Each operand solid, by the result solid its faces went into.
    const groups = new Map<number, unknown[]>();
    for (const operand of operands)
      explore(operand.shape, 'TopAbs_SOLID', (solid) => {
        const into = new Set<number>();
        explore(solid, 'TopAbs_FACE', (face) => {
          for (const made of image(face)) {
            const at = owners.FindIndex(made);
            if (at) for (const s of listOf(owners.FindFromIndex(at))) into.add(solids.FindIndex(s));
          }
        });
        if (into.size > 1) throw incomplete();
        for (const i of into) groups.set(i, [...(groups.get(i) ?? []), solid]);
      });
    // Result solids that touch, from operand solids that overlap (3 legs and the 2 rings between
    // them: 2 solids): the union failed to merge them. Ones whose operands only touch are refused
    // later as `solids-touching`.
    const touching = own(new oc.TopTools_IndexedDataMapOfShapeListOfShape_1());
    oc.TopExp.MapShapesAndAncestors(
      result,
      oc.TopAbs_ShapeEnum.TopAbs_VERTEX,
      oc.TopAbs_ShapeEnum.TopAbs_SOLID,
      touching,
    );
    const pairs = new Set<string>();
    for (let v = 1; v <= touching.Size(); v++) {
      const at = [...new Set(listOf(touching.FindFromIndex(v)).map((x) => solids.FindIndex(x)))];
      for (const i of at) for (const j of at) if (i < j) pairs.add(`${i} ${j}`);
    }
    for (const pair of pairs) {
      const [i, j] = pair.split(' ').map(Number);
      for (const a of groups.get(i!) ?? [])
        for (const b of groups.get(j!) ?? []) {
          const common = own(
            new oc.BRepAlgoAPI_Common_3(a, b, own(new oc.Message_ProgressRange_1())),
          );
          if (!common.IsDone() || common.HasErrors()) continue;
          if (volume(own(common.Shape())) > 1e-6 * Math.min(volume(a), volume(b)))
            throw incomplete();
        }
    }
  }
  /** The volume of a shape's solids (mm³), whatever their orientation. */
  function volume(shape: unknown): number {
    const props = own(new oc.GProp_GProps_1());
    oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false);
    return Math.abs(props.Mass());
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
   * A curve's range [a, b] broken at its knots: a B-spline is smooth only between them (shifted
   * by periods on a periodic one), so each piece is one polynomial span. Other curves: [a, b].
   */
  function knotBreaks(
    curve: {
      DynamicType(): unknown;
      IsPeriodic(): boolean;
      Period(): number;
      NbKnots?: () => number;
      Knot?: (i: number) => number;
    },
    a: number,
    b: number,
  ): number[] {
    const breaks = [a, b];
    const type = own(curve.DynamicType() as { get(): { Name(): string } })
      .get()
      .Name();
    if (type === 'Geom_BSplineCurve' && curve.NbKnots && curve.Knot) {
      const period = curve.IsPeriodic() ? curve.Period() : 0;
      for (let i = 1; i <= curve.NbKnots(); i++) {
        const k = curve.Knot(i);
        const shifts = period > 0 ? Math.ceil((b - a) / period) + 1 : 0;
        for (let n = -shifts; n <= shifts; n++) {
          const t = k + n * period;
          if (t > a && t < b) breaks.push(t);
          if (!(period > 0)) break;
        }
      }
    }
    breaks.sort((x, y) => x - y);
    const spans = breaks.filter((t, i) => i === 0 || t - breaks[i - 1]! > 1e-12 * (b - a));
    if (spans[spans.length - 1] !== b) spans[spans.length - 1] = b;
    return spans;
  }
  /** A Gordon surface (gordon.ts) built as one cubic B-spline face. */
  function gordonFace(f: CadFeature, made: GordonSurface) {
    const rows = made.poles.length,
      cols = made.poles[0]!.length;
    const poles = own(new oc.TColgp_Array2OfPnt_2(1, rows, 1, cols));
    made.poles.forEach((row, i) =>
      row.forEach((p, j) => poles.SetValue(i + 1, j + 1, pnt(p[0], p[1], p[2]))),
    );
    const reals = (xs: number[]) => {
      const a = own(new oc.TColStd_Array1OfReal_2(1, xs.length));
      xs.forEach((x, i) => a.SetValue(i + 1, x));
      return a;
    };
    const ints = (xs: number[]) => {
      const a = own(new oc.TColStd_Array1OfInteger_2(1, xs.length));
      xs.forEach((x, i) => a.SetValue(i + 1, x));
      return a;
    };
    const surface = own(
      new oc.Handle_Geom_Surface_2(
        new oc.Geom_BSplineSurface_1(
          poles,
          reals(made.uKnots),
          reals(made.vKnots),
          ints(made.uMults),
          ints(made.vMults),
          made.degree,
          made.degree,
          false,
          false,
        ),
      ),
    );
    const maker = own(
      new oc.BRepBuilderAPI_MakeFace_8(surface, doc.kernelProfile.linearToleranceMm),
    );
    if (!maker.IsDone()) throw new CadKernelError('surface-failed', f.id);
    return { face: own(maker.Face()), surface };
  }
  /** An edge's curve between its vertices, for gordon.ts (CR1d). */
  function networkCurve(f: CadFeature, edge: unknown): NetworkCurve {
    const handle = own(oc.BRep_Tool.Curve_2(edge, 0, 0));
    if (handle.IsNull()) throw new CadKernelError('surface-failed', f.id);
    const curve = handle.get();
    const first = own(new oc.TopoDS_Vertex());
    const last = own(new oc.TopoDS_Vertex());
    oc.TopExp.Vertices_1(edge, first, last, false);
    const t0 = oc.BRep_Tool.Parameter_2(first, edge) as number;
    let t1 = oc.BRep_Tool.Parameter_2(last, edge) as number;
    if (t1 === t0 && curve.IsPeriodic()) t1 = t0 + (curve.Period() as number);
    const P = own(new oc.gp_Pnt_1());
    return {
      t0,
      t1,
      breaks: knotBreaks(curve, t0, t1),
      at: (t) => {
        curve.D0(t, P);
        return [P.X(), P.Y(), P.Z()];
      },
    };
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
   * and seams (`BRepFill_CompatibleWires`); for closed spline sections (five through a wing, a
   * canopy with a flat first section) that matching can throw (`SameNumberByPolarMethod`, or
   * `BRepFill :: profiles are inconsistent`, which does not name the class) although every
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
      const matching =
        message.includes('BRepFill_CompatibleWires') ||
        message.includes('BRepFill :: profiles are inconsistent');
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
  function pathWire(
    f: CadFeature,
    path: CadSketchPath,
    closed: 'allow' | 'refuse' = 'refuse',
    sketch: CadSketch = sketches.get(path.sketchId)!,
  ) {
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
  /**
   * CR1b: whether a fill face meets the face beside one of its G2 sides with the same normal
   * curvature across the side at every continuity sample (within cadContinuity.g2Relative).
   * Both faces are meshed as copies (the projections start from their nodes); a face whose
   * normal faces the other way has its curvature counted with the opposite sign.
   */
  function fillMeetsG2(fill: unknown, edge: unknown, beside: unknown): boolean {
    const copy = (face: unknown) => {
      const c = own(
        own(new oc.BRepBuilderAPI_Transform_2(face, own(new oc.gp_Trsf_1()), true)).Shape(),
      );
      own(new oc.BRepMesh_IncrementalMesh_2(c, 0.5, false, 0.2, false));
      return own(oc.TopoDS.Face_1(c));
    };
    const samples = edgeContinuity(oc, own, edge, [copy(fill), copy(beside)]);
    if (samples === 'continuity-projection-failed') return false;
    return samples.every((s) => {
      const turned = s.g1Deg > 90;
      const [a, b] = s.curvature;
      return curvatureDeviation([a, turned ? -b : b]) <= cadContinuity.g2Relative * (1 + 1e-9);
    });
  }
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
  /**
   * R2a-3 trim, and CR3b's panel (the same cut of a sheet read as its source, never consumed).
   * With a gap the sketch chain is offset `gap / 2` into the kept side first (`sketchWithOffset`),
   * its cut edges still named by the source chain's elements.
   */
  function trim(
    f: Extract<CadFeature, { type: 'trim' | 'panel' }>,
    shapes: Map<string, Named>,
  ): Named {
    const input = shapes.get(f.type === 'panel' ? f.args.source.featureId : f.inputFeatureIds[0])!;
    const tool: CadTrimTool = f.args.tool;
    const gap = f.args.gap ? len(f.args.gap) : 0;
    const [min, max] = boundsOf(input.shape);
    const centre = min.map((x, i) => (x + max[i]!) / 2) as Vec3;
    const size = Math.hypot(...min.map((x, i) => max[i]! - x)) + 10;
    let toolShape: unknown;
    let side: (p: Vec3) => number;
    // A sketch chain's signed distance from its plane, for the 86M2 sides below.
    let across: ((p: Vec3) => number) | undefined;
    const cuts: { face: unknown; name: CadFaceName; chain?: number }[] = [];
    // CR3c: the sketch chains a trim cuts with, and those left out (`ifMissed: 'skip'`).
    let chainCount = 0;
    const skipped = new Set<number>();
    if ('sketchId' in tool) {
      // Each chain's planar face moved back along the sketch's normal and swept through the
      // input: a prism whose sides cut it. A point is inside where a prism holds it. CR3c: the
      // tool's chain and `chains` are cut at once, each one's cut faces tagged with its index.
      const [q, origin] = frames.get(tool.sketchId)!;
      const n = own(own(new oc.gp_Dir_4(0, 0, 1)).Transformed(quaternionTrsf(q)));
      const normal: Vec3 = [n.X(), n.Y(), n.Z()];
      const off = normal.reduce((a, x, i) => a + x * (centre[i]! - origin[i]!), 0);
      across = (p) => normal.reduce((a, x, i) => a + x * (p[i]! - origin[i]!), 0);
      const reach = Math.abs(off) + size;
      const all = [tool.elements, ...(f.type === 'trim' ? (f.args.chains ?? []) : [])];
      const classifiers: unknown[] = [];
      const compound = own(new oc.TopoDS_Compound());
      const builder = own(new oc.BRep_Builder());
      builder.MakeCompound(compound);
      all.forEach((elements, k) => {
        let chain: ReturnType<typeof pathWire>;
        let source = (id: string) => id;
        const at: (string | number)[] = k ? ['chains', k - 1] : ['tool'];
        if (gap) {
          let moved: ReturnType<typeof sketchWithOffset>;
          try {
            moved = sketchWithOffset(
              sketches.get(tool.sketchId)!,
              elements,
              ((f.args.keep === 'outside' ? 1 : -1) * gap) / 2,
            );
          } catch (error) {
            if (error instanceof CadSketchError)
              throw new CadKernelError(error.code, f.id, false, undefined, [['gap'], at]);
            throw error;
          }
          const from = new Map(moved.ids.map((id, i) => [id, moved.offset.pieces[i]!.source]));
          source = (id) => from.get(id) ?? id;
          chain = pathWire(
            f,
            { sketchId: tool.sketchId, elements: moved.ids },
            'allow',
            moved.sketch,
          );
        } else chain = pathWire(f, { sketchId: tool.sketchId, elements }, 'allow');
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
        const solid = own(prism.Shape());
        builder.Add(compound, solid);
        for (const { edge, id } of chain.edges)
          for (const made of listOf(prism.Generated(own(moved.ModifiedShape(edge)))))
            explore(made, 'TopAbs_FACE', (face) =>
              cuts.push({
                face,
                name: cutBoundaryName({ sketchId: tool.sketchId, element: source(id) }),
                chain: k,
              }),
            );
        const classifier = own(new oc.BRepClass3d_SolidClassifier_1());
        classifier.Load(solid);
        classifiers.push(classifier);
      });
      toolShape = compound;
      chainCount = all.length;
      side = (p) => {
        let on = false;
        for (const [k, classifier] of classifiers.entries()) {
          if (skipped.has(k)) continue;
          const c = classifier as { Perform(p: unknown, t: number): void; State(): unknown };
          c.Perform(pnt(...p), doc.kernelProfile.linearToleranceMm);
          const state = c.State();
          if (state === oc.TopAbs_State.TopAbs_IN) return 1;
          if (state !== oc.TopAbs_State.TopAbs_OUT) on = true;
        }
        return on ? 0 : -1;
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
    // CR3c: a sketch chain whose sides meet no face is named, or left out with `skip`.
    const chainPath = (k: number): (string | number)[] => (k ? ['chains', k - 1] : ['tool']);
    if (chainCount) {
      const hit = new Set<number>();
      for (const { face, chain } of cuts)
        if (chain !== undefined && !hit.has(chain) && listOf(splitter.Generated(face)).length)
          hit.add(chain);
      const missed = [...Array(chainCount).keys()].filter((k) => !hit.has(k));
      if (missed.length && (f.type !== 'trim' || f.args.ifMissed !== 'skip'))
        throw new CadKernelError('trim-no-cut', f.id, false, undefined, missed.map(chainPath));
      for (const k of missed) skipped.add(k);
    }
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
    // CR3c (86M3): kept pieces that fall apart are refused naming the chains whose cut edges
    // border more than one of them (a window run off the panel's edge, two windows meeting).
    if (chainCount && kept.length > 1) {
      const topology = sheetTopology(oc, shell, own);
      if (!topology.connected) {
        const faces = own(new oc.TopTools_IndexedMapOfShape_1());
        oc.TopExp.MapShapes_1(shell, oc.TopAbs_ShapeEnum.TopAbs_FACE, faces);
        const ancestors = own(new oc.TopTools_IndexedDataMapOfShapeListOfShape_1());
        oc.TopExp.MapShapesAndAncestors(
          shell,
          oc.TopAbs_ShapeEnum.TopAbs_EDGE,
          oc.TopAbs_ShapeEnum.TopAbs_FACE,
          ancestors,
        );
        const parts = new Map<number, Set<number>>();
        for (const { face, chain } of cuts) {
          if (chain === undefined || skipped.has(chain)) continue;
          for (const made of listOf(splitter.Generated(face)))
            explore(made, 'TopAbs_EDGE', (edge) => {
              const e = ancestors.FindIndex(edge);
              if (e < 1) return;
              for (const g of listOf(ancestors.FindFromIndex(e)))
                (parts.get(chain) ?? parts.set(chain, new Set()).get(chain)!).add(
                  topology.component[faces.FindIndex(g) - 1]!,
                );
            });
        }
        const culprits = [...parts].filter(([, c]) => c.size > 1).map(([k]) => k);
        throw new CadKernelError(
          'trim-disconnected',
          f.id,
          false,
          undefined,
          (culprits.length ? culprits : [...Array(chainCount).keys()]).map(chainPath),
        );
      }
    }
    const prefix = `${f.type}:${f.id}:${f.args.keep}`;
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
    const cutEdges: { edge: unknown; name: CadFaceName }[] = [];
    // CR3c: chains that overlap cut each other's sides inside what is taken away; only the cut
    // edges left on the result are named.
    let inResult: { FindIndex(s: unknown): number } | undefined;
    if (chainCount > 1) {
      const edges = own(new oc.TopTools_IndexedMapOfShape_1());
      oc.TopExp.MapShapes_1(result.shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, edges);
      inResult = edges;
    }
    for (const { face, name } of cuts)
      for (const made of listOf(splitter.Generated(face)))
        explore(made, 'TopAbs_EDGE', (edge) => {
          if (!inResult || inResult.FindIndex(edge) > 0) cutEdges.push({ edge, name });
        });
    // 86M2 (CR3b): a chain carried through both sides of a body (a car's left and right) cuts
    // each side along the same element. Such an element's edges are told apart by the side of the
    // sketch's plane they lie on (`at:front` along its normal, `at:back`); one side keeps the name.
    if (across) {
      const sides = cutEdges.map(({ edge }) => {
        const c = networkCurve(f, own(oc.TopoDS.Edge_1(edge)));
        const d = across!(c.at((c.t0 + c.t1) / 2));
        const eps = doc.kernelProfile.linearToleranceMm;
        return d > eps ? 'front' : d < -eps ? 'back' : undefined;
      });
      const seen = new Map<string, Set<string | undefined>>();
      cutEdges.forEach(({ name }, i) => {
        const k = faceNameKey(name);
        seen.set(k, (seen.get(k) ?? new Set()).add(sides[i]));
      });
      cutEdges.forEach((x, i) => {
        const both = seen.get(faceNameKey(x.name))!;
        if (both.has('front') && both.has('back') && sides[i])
          x.name = [...x.name, `at:${sides[i]}`];
      });
    }
    for (const x of cutEdges) (result.edges ??= []).push(x);
    return result;
  }
  /**
   * CR2a: the input's faces divided by a ribbon, the sketch's chain carried through the input
   * along the sketch's normal (`BRepAlgoAPI_Splitter`), every piece kept in one shell. A piece
   * is `split:<ID>:<side>/<its face's name>`: `left` or `right` of an open chain looking down
   * the normal, `inside` or `outside` of a closed one. A dividing edge lies between two pieces,
   * so it is named by their faces (`… left | … right`), not by the chain's element.
   */
  function split(f: Extract<CadFeature, { type: 'split' }>, shapes: Map<string, Named>): Named {
    const input = shapes.get(f.inputFeatureIds[0])!;
    const { pieces, splitter } = divide(f, input, f.args.tool);
    const builder = own(new oc.BRep_Builder());
    const shell = own(new oc.TopoDS_Shell());
    builder.MakeShell(shell);
    for (const { piece } of pieces) builder.Add(shell, piece);
    const result = named(shell, () => null);
    if (!naming) return result;
    for (const { piece, from, side: s } of pieces) {
      const j = result.faces.FindIndex(piece);
      const name = input.names[from - 1];
      if (j > 0 && name) result.names[j - 1] = prefixFaceName(`split:${f.id}:${s}`, name);
    }
    const image = history(splitter);
    for (const { edge, name } of input.edges ?? [])
      for (const made of image(edge))
        (result.edges ??= []).push({ edge: made, name: prefixFaceName(`split:${f.id}`, name) });
    return result;
  }
  /**
   * A sheet's faces divided along a sketch's chain carried along the sketch's normal (CR2a,
   * CR2c): each piece with the input face it came from and its side of the chain.
   */
  function divide(f: CadFeature, input: Named, tool: CadSketchPath) {
    const [min, max] = boundsOf(input.shape);
    const centre = min.map((x, i) => (x + max[i]!) / 2) as Vec3;
    const size = Math.hypot(...min.map((x, i) => max[i]! - x)) + 10;
    const chain = pathWire(f, tool, 'allow');
    const [q, origin] = frames.get(tool.sketchId)!;
    const axis = (x: number, y: number, z: number): Vec3 => {
      const d = own(own(new oc.gp_Dir_4(x, y, z)).Transformed(quaternionTrsf(q)));
      return [d.X(), d.Y(), d.Z()];
    };
    const [X, Y, normal] = [axis(1, 0, 0), axis(0, 1, 0), axis(0, 0, 1)];
    const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const off = dot(normal, centre.map((x, i) => x - origin[i]!) as Vec3);
    const reach = Math.abs(off) + size;
    const trsf = own(new oc.gp_Trsf_1());
    trsf.SetTranslation_1(own(new oc.gp_Vec_4(...normal.map((x) => x * (off - reach)))));
    const moved = own(new oc.BRepBuilderAPI_Transform_2(chain.wire, trsf, false));
    const ribbon = own(
      new oc.BRepPrimAPI_MakePrism_1(
        own(moved.Shape()),
        own(new oc.gp_Vec_4(...normal.map((x) => x * 2 * reach))),
        false,
        true,
      ),
    );
    // The chain as a polyline in the sketch's plane, in its own direction, within half of
    // `splitSideReachMm` of the curve: 64 spans per edge, each halved while its middle lies off
    // its chord (a fixed count is 0.3 mm off a 1 m arc and would put a piece beside the arc on
    // the wrong side, Codex on #919). A point nearer the polyline than the reach is on neither
    // side, so only the triangles of a piece clear of the curve decide its side.
    const local = (p: Vec3): [number, number] => {
      const d = p.map((x, i) => x - origin[i]!) as Vec3;
      return [dot(d, X), dot(d, Y)];
    };
    const line: [number, number][] = [];
    for (const { edge } of chain.edges) {
      const c = networkCurve(f, own(oc.TopoDS.Edge_1(edge)));
      const at = (t: number) => local(c.at(t));
      const span = (
        t0: number,
        t1: number,
        p0: [number, number],
        p1: [number, number],
        depth: number,
      ) => {
        const tm = (t0 + t1) / 2;
        const pm = at(tm);
        const off = Math.hypot(pm[0] - (p0[0] + p1[0]) / 2, pm[1] - (p0[1] + p1[1]) / 2);
        if (off > splitSideReachMm / 2 && depth < 16) {
          span(t0, tm, p0, pm, depth + 1);
          span(tm, t1, pm, p1, depth + 1);
        } else line.push(p1);
      };
      let p = at(c.t0);
      if (!line.length) line.push(p);
      for (let k = 1; k <= 64; k++) {
        const t0 = c.t0 + ((c.t1 - c.t0) * (k - 1)) / 64;
        const next = at(c.t0 + ((c.t1 - c.t0) * k) / 64);
        span(t0, c.t0 + ((c.t1 - c.t0) * k) / 64, p, next, 0);
        p = next;
      }
    }
    const closed = sketchPath(sketches.get(tool.sketchId)!, tool.elements, 'allow');
    const loop = !('code' in closed) && closed.closed;
    const side = (p: Vec3): number => {
      const [x, y] = local(p);
      // The nearest segment (left of it is +1 for an open chain) and, for a loop, the winding
      // number about the point.
      let best = Infinity;
      let s = 0;
      let wind = 0;
      for (let k = 0; k + 1 < line.length; k++) {
        const [a, b] = [line[k]!, line[k + 1]!];
        const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
        const cross = dx * (y - a[1]) - dy * (x - a[0]);
        if (loop) {
          if (a[1] <= y && b[1] > y && cross > 0) wind++;
          else if (a[1] > y && b[1] <= y && cross < 0) wind--;
        }
        const t = Math.max(
          0,
          Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)),
        );
        const d = Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
        if (d < best) [best, s] = [d, Math.sign(cross)];
      }
      if (best < splitSideReachMm) return 0;
      return loop ? (wind !== 0 ? 1 : -1) : s;
    };
    const splitter = own(new oc.BRepAlgoAPI_Splitter_1());
    const args = own(new oc.TopTools_ListOfShape_1());
    own(args.Append_1(input.shape));
    const tools = own(new oc.TopTools_ListOfShape_1());
    own(tools.Append_1(own(ribbon.Shape())));
    splitter.SetArguments(args);
    splitter.SetTools(tools);
    splitter.Build(own(new oc.Message_ProgressRange_1()));
    if (!splitter.IsDone() || splitter.HasErrors()) throw new CadKernelError('split-failed', f.id);
    const pieces: { piece: unknown; from: number; side: string }[] = [];
    let cut = false;
    const names = loop ? ['inside', 'outside'] : ['left', 'right'];
    for (let i = 1; i <= input.faces.Size(); i++) {
      const face = own(input.faces.FindKey(i));
      if (splitter.IsDeleted(face)) continue;
      const made = listOf(splitter.Modified(face));
      if (made.length > 1) cut = true;
      for (const piece of made.length ? made : [face]) {
        const s = pieceSide(piece, side);
        if (s === 0)
          throw new CadKernelError('split-side-undetermined', f.id, false, undefined, [['tool']]);
        pieces.push({ piece, from: i, side: names[s > 0 ? 0 : 1]! });
      }
    }
    // A chain that divides no face (it misses the sheet, or stops inside a face) is refused.
    if (!cut) throw new CadKernelError('split-missed', f.id, false, undefined, [['tool']]);
    // The chain element each cut edge runs along: chain edge → ribbon face → its section edges.
    const cuts: { edge: unknown; element: string }[] = [];
    for (const { edge, id } of chain.edges)
      for (const face of listOf(ribbon.Generated(own(moved.ModifiedShape(edge)))))
        for (const made of listOf(splitter.Generated(face)))
          explore(made, 'TopAbs_EDGE', (e) => cuts.push({ edge: e, element: id }));
    const elementOf = (edge: unknown) =>
      cuts.find((c) => (c.edge as OcModule).IsSame(edge))?.element;
    return { pieces, splitter, loop, normal, elementOf };
  }
  /**
   * CR2c: a press line. The sheet is divided along the chain (as `split`), the pieces on
   * `side` moved `depth` along their normal (`front`) or against it (`back`), a ruled wall run
   * from each dividing edge to its moved copy, all sewn into one shell, and the wall's two
   * borders rounded by `radius`. The pieces that stay are `press:<ID>:<side>/<name>`, the moved
   * ones `press:<ID>:moved/<name>`, a wall `press:<ID>/wall:<the dividing edge's name>/e:<the chain element>` and a
   * rounding `blend:<the edge's name>`. Any step OCCT cannot make is `press-line-failed`.
   */
  /**
   * CR6d: a round groove. The sketch's chain is projected along the sketch's normal onto the
   * solid (`BRepProj_Projection`, which projects onto every face it crosses, both ways); the
   * projected lines on the faces nearest the sketch's plane are kept (a seat's top, not its
   * underside), a circle of the radius is swept along each (`MakePipeShell`, the circle normal to
   * the line where it starts), and the tubes are cut from the solid at once. Each tube's faces are
   * `groove:<id>:<i>/…`, i in the order of the kept lines.
   */
  function groove(f: Extract<CadFeature, { type: 'groove' }>, shapes: Map<string, Named>): Named {
    const input = shapes.get(f.inputFeatureIds[0])!;
    const failed = (code = 'groove-failed', path: (string | number)[] = ['radius']) =>
      new CadKernelError(code, f.id, false, undefined, [path]);
    const r = len(f.args.radius);
    const chain = pathWire(f, f.args.tool, 'allow');
    const [q, origin] = frames.get(f.args.tool.sketchId)!;
    const n = own(own(new oc.gp_Dir_4(0, 0, 1)).Transformed(quaternionTrsf(q)));
    const normal: Vec3 = [n.X(), n.Y(), n.Z()];
    const axis = (x: number, y: number): Vec3 => {
      const d = own(own(new oc.gp_Dir_4(x, y, 0)).Transformed(quaternionTrsf(q)));
      return [d.X(), d.Y(), d.Z()];
    };
    const xAxis = axis(1, 0);
    const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let projection;
    try {
      projection = own(new oc.BRepProj_Projection_1(chain.wire, input.shape, n));
    } catch {
      throw failed('groove-no-hit', ['tool']);
    }
    if (!projection.IsDone()) throw failed('groove-no-hit', ['tool']);
    // The projected lines' edges, each with the way back to the sketch (`u`) and how far it is.
    const edges: { edge: unknown; u: Vec3; off: number }[] = [];
    for (projection.Init(); projection.More(); projection.Next())
      explore(own(projection.Current()), 'TopAbs_EDGE', (e) => {
        const edge = own(oc.TopoDS.Edge_1(e));
        const c = networkCurve(f, edge);
        const mid = c.at((c.t0 + c.t1) / 2);
        // A line down a wall along the projection (every point of it over the same point of the
        // sketch) is where the chain crosses a step, not a place to groove. A line up a steep face
        // still moves across the sketch and is kept.
        const start = c.at(c.t0);
        const across = (p: Vec3) => {
          const d = p.map((x, i) => x - start[i]!) as Vec3;
          const along = dot(d, normal);
          return Math.hypot(...d.map((x, i) => x - along * normal[i]!));
        };
        const quarter = c.at(c.t0 + (c.t1 - c.t0) / 4);
        if (Math.max(across(quarter), across(mid), across(c.at(c.t1))) < 1e-3) return;
        const height = (p: Vec3) => dot(p, normal) - dot(origin, normal);
        const h = height(mid);
        // The curtain reaches the sketch's plane from every point of the edge (its farthest point
        // sets the length; the half-space past the plane is cut off).
        let far = 0;
        for (let k = 0; k <= 32; k++)
          far = Math.max(far, Math.abs(height(c.at(c.t0 + ((c.t1 - c.t0) * k) / 32))));
        edges.push({
          edge,
          u: normal.map((x) => -(Math.sign(h) || 1) * x) as Vec3,
          off: far,
        });
      });
    if (!edges.length) throw failed('groove-no-hit', ['tool']);
    /**
     * The parts of each edge seen from the sketch: the curtain from 0.01 mm above the edge back to
     * the sketch's plane, met by the input, hides the parameters its pieces span (a hollow part's
     * inner wall under the face, a lower face under an overhang, all or in part).
     */
    const pieces: unknown[] = [];
    for (const { edge, u, off } of edges) {
      const c = networkCurve(f, edge);
      const [lo, hi] = [Math.min(c.t0, c.t1), Math.max(c.t0, c.t1)];
      const hidden: [number, number][] = [];
      if (off > 0.02) {
        const shift = own(new oc.gp_Trsf_1());
        shift.SetTranslation_1(own(new oc.gp_Vec_4(...u.map((x) => x * 0.01))));
        const lifted = own(new oc.BRepBuilderAPI_Transform_2(edge, shift, true));
        const prism = own(
          new oc.BRepPrimAPI_MakePrism_1(
            own(lifted.Shape()),
            own(new oc.gp_Vec_4(...u.map((x) => x * (off - 0.01)))),
            false,
            true,
          ),
        );
        // The edge's side of the sketch's plane: a box from the plane away from the sketch, around
        // the edge's middle on the plane and wider than the edge and its curtain.
        const middle = c.at((lo + hi) / 2);
        const onPlane = middle.map(
          (x, i) => x - (dot(middle, normal) - dot(origin, normal)) * normal[i]!,
        ) as Vec3;
        let reach = off + 10;
        for (let k = 0; k <= 32; k++) {
          const p = c.at(lo + ((hi - lo) * k) / 32);
          reach = Math.max(reach, Math.hypot(...p.map((x, i) => x - middle[i]!)) + off + 10);
        }
        const back = u.map((x) => -x) as Vec3;
        // The box's own y is back × x, whichever way that turns the sketch's y.
        const boxY: Vec3 = [
          back[1]! * xAxis[2]! - back[2]! * xAxis[1]!,
          back[2]! * xAxis[0]! - back[0]! * xAxis[2]!,
          back[0]! * xAxis[1]! - back[1]! * xAxis[0]!,
        ];
        const corner = onPlane.map((x, i) => x - reach * (xAxis[i]! + boxY[i]!)) as Vec3;
        const side = own(
          new oc.BRepPrimAPI_MakeBox_5(
            own(
              new oc.gp_Ax2_2(
                pnt(...corner),
                own(new oc.gp_Dir_4(...back)),
                own(new oc.gp_Dir_4(...xAxis)),
              ),
            ),
            2 * reach,
            2 * reach,
            off + 1,
          ),
        );
        const trimmed = own(
          new oc.BRepAlgoAPI_Common_3(
            own(prism.Shape()),
            own(side.Shape()),
            own(new oc.Message_ProgressRange_1()),
          ),
        );
        if (!trimmed.IsDone() || trimmed.HasErrors()) throw failed();
        const common = own(
          new oc.BRepAlgoAPI_Common_3(
            input.shape,
            own(trimmed.Shape()),
            own(new oc.Message_ProgressRange_1()),
          ),
        );
        if (!common.IsDone() || common.HasErrors()) throw failed();
        // A point of the curtain read back as the edge's parameter under it.
        const grid = Array.from({ length: 129 }, (_, k) => lo + ((hi - lo) * k) / 128);
        const gap = (t: number, p: Vec3) => {
          const d = c.at(t).map((x, i) => p[i]! - x) as Vec3;
          const along = dot(d, u);
          return Math.hypot(...d.map((x, i) => x - along * u[i]!));
        };
        const paramOf = (p: Vec3) => {
          let k = 0;
          grid.forEach((t, i) => {
            if (gap(t, p) < gap(grid[k]!, p)) k = i;
          });
          let [a, b] = [grid[Math.max(0, k - 1)]!, grid[Math.min(128, k + 1)]!];
          for (let i = 0; i < 40; i++) {
            const m1 = a + (b - a) / 3;
            const m2 = b - (b - a) / 3;
            if (gap(m1, p) < gap(m2, p)) b = m2;
            else a = m1;
          }
          return (a + b) / 2;
        };
        explore(own(common.Shape()), 'TopAbs_FACE', (face) => {
          const ts: number[] = [];
          explore(face, 'TopAbs_EDGE', (e) => {
            const fc = networkCurve(f, own(oc.TopoDS.Edge_1(e)));
            for (let k = 0; k <= 8; k++) ts.push(paramOf(fc.at(fc.t0 + ((fc.t1 - fc.t0) * k) / 8)));
          });
          if (ts.length) hidden.push([Math.min(...ts), Math.max(...ts)]);
        });
      }
      // The seen spans: [lo, hi] less the hidden ones.
      hidden.sort((x, y) => x[0] - y[0]);
      let from = lo;
      const seen: [number, number][] = [];
      for (const [a, b] of hidden) {
        if (a > from) seen.push([from, a]);
        from = Math.max(from, b);
      }
      if (from < hi) seen.push([from, hi]);
      const handle = own(oc.BRep_Tool.Curve_2(edge, 0, 0));
      for (const [a, b] of seen) {
        if (a === lo && b === hi) {
          pieces.push(edge);
          continue;
        }
        // A sliver between two hidden spans is no groove: measured along the curve, so a closed or
        // nearly closed span whose ends meet is kept.
        let length = 0;
        for (let k = 1; k <= 16; k++) {
          const p = c.at(a + ((b - a) * k) / 16);
          const q = c.at(a + ((b - a) * (k - 1)) / 16);
          length += Math.hypot(...p.map((x, i) => x - q[i]!));
        }
        if (length < 0.01) continue;
        const piece = own(new oc.BRepBuilderAPI_MakeEdge_25(handle, a, b));
        if (!piece.IsDone()) throw failed();
        pieces.push(own(piece.Edge()));
      }
    }
    if (!pieces.length) throw failed('groove-no-hit', ['tool']);
    // Each tube face named by the sketch element it runs along (`tube:e:<id>`), or by the point
    // where it turns or ends (`tube:v:<id>`): the nearest place on the chain to its centroid.
    const g = sketchPath(sketches.get(f.args.tool.sketchId)!, f.args.tool.elements, 'allow');
    if ('code' in g) throw failed(g.code, ['tool']);
    const polylines = g.elements.flatMap((e) => {
      const pts: [number, number][] =
        e.type === 'line'
          ? [e.a, e.b]
          : e.type === 'arc'
            ? Array.from({ length: 33 }, (_, k) => {
                const t = e.start + (e.sweep * k) / 32;
                return [e.c[0] + e.r * Math.cos(t), e.c[1] + e.r * Math.sin(t)] as [number, number];
              })
            : e.pts;
      return [
        {
          id: e.id,
          ends: e.ends,
          pts: pts.map(([u, v]) => worldPoint(f.args.tool.sketchId, u, v)),
        },
      ];
    });
    const nameOfFace = (face: unknown): string => {
      const c = faceProps(face).centroid;
      // In the sketch's plane.
      const h = dot(c, normal) - dot(origin, normal);
      const q = c.map((x, i) => x - h * normal[i]!) as Vec3;
      let best = { d: Infinity, name: 'tube' };
      for (const l of polylines) {
        const last = l.pts.length - 1;
        for (let k = 0; k < last; k++) {
          const a = l.pts[k]!;
          const b = l.pts[k + 1]!;
          const ab = b.map((x, i) => x - a[i]!) as Vec3;
          const len2 = dot(ab, ab);
          const t = len2 > 0 ? dot(q.map((x, i) => x - a[i]!) as Vec3, ab) / len2 : 0;
          const tc = Math.min(1, Math.max(0, t));
          const d = Math.hypot(...q.map((x, i) => x - (a[i]! + tc * ab[i]!)));
          if (d >= best.d - 1e-9) continue;
          const atStart = k === 0 && t <= 1e-6;
          const atEnd = k === last - 1 && t >= 1 - 1e-6;
          best = {
            d,
            name: atStart
              ? `tube:v:${l.ends[0]}`
              : atEnd
                ? `tube:v:${l.ends[1]}`
                : `tube:e:${l.id}`,
          };
        }
      }
      return best.name;
    };
    // A tube along each seen piece: a circle at its start, normal to it there, swept along it.
    const ends: Vec3[] = [];
    const tubes: Named[] = pieces.map((piece) => {
      const c = networkCurve(f, piece);
      const h = (c.t1 - c.t0) * 1e-4;
      const at = c.at(c.t0);
      const next = c.at(c.t0 + h);
      const d = next.map((x, i) => x - at[i]!) as Vec3;
      const l = Math.hypot(...d);
      if (!(l > 0)) throw failed();
      const along = d.map((x) => x / l) as Vec3;
      ends.push(at, c.at(c.t1));
      // The circle's seam toward the sketch: in the part the cut takes away, so the groove's
      // wall along each element stays one face.
      const h0 = dot(at, normal) - dot(origin, normal);
      const up = normal.map((x) => -(Math.sign(h0) || 1) * x) as Vec3;
      const toward = up.map((x, i) => x - dot(up, along) * along[i]!) as Vec3;
      const vx = Math.hypot(...toward);
      const circle = own(
        new oc.BRepBuilderAPI_MakeEdge_8(
          own(
            new oc.gp_Circ_2(
              own(
                vx > 1e-6
                  ? new oc.gp_Ax2_2(
                      pnt(...at),
                      own(new oc.gp_Dir_4(...along)),
                      own(new oc.gp_Dir_4(...toward)),
                    )
                  : new oc.gp_Ax2_3(pnt(...at), own(new oc.gp_Dir_4(...along))),
              ),
              r,
            ),
          ),
        ),
      );
      if (!circle.IsDone()) throw failed();
      const profile = own(new oc.BRepBuilderAPI_MakeWire_2(own(circle.Edge())));
      const spine = own(new oc.BRepBuilderAPI_MakeWire_2(piece));
      const pipe = own(new oc.BRepOffsetAPI_MakePipeShell(own(spine.Wire())));
      pipe.SetMode_1(false);
      pipe.Add_1(own(profile.Wire()), false, false);
      if (!pipe.IsReady()) throw failed();
      try {
        pipe.Build(own(new oc.Message_ProgressRange_1()));
        if (!pipe.IsDone() || !pipe.MakeSolid()) throw failed();
      } catch {
        throw failed();
      }
      return named(own(pipe.Shape()), (face) => [nameOfFace(face)]);
    });
    for (const tube of tubes) if (!overlaps(input, tube)) throw failed('groove-no-hit', ['tool']);
    // Where two pieces meet (a corner of the chain), a ball of the radius rounds the turn.
    const tol = doc.kernelProfile.linearToleranceMm * 10;
    const joints: Vec3[] = [];
    ends.forEach((p, i) => {
      if (joints.some((q) => Math.hypot(...p.map((x, k) => x - q[k]!)) < tol)) return;
      if (
        ends.some(
          (q, j) => j !== i && j >> 1 !== i >> 1 && Math.hypot(...p.map((x, k) => x - q[k]!)) < tol,
        )
      )
        joints.push(p);
    });
    for (const p of joints) {
      const ball = own(new oc.BRepPrimAPI_MakeSphere_5(pnt(...p), r));
      tubes.push(named(own(ball.Shape()), (face) => [nameOfFace(face)]));
    }
    return combine(
      f.id,
      'cut',
      input,
      tubes,
      tubes.map((_, i) => `groove:${f.id}:${i}`),
    );
  }
  function pressLine(
    f: Extract<CadFeature, { type: 'pressLine' }>,
    shapes: Map<string, Named>,
  ): Named {
    const input = shapes.get(f.inputFeatureIds[0])!;
    const { pieces, elementOf, splitter } = divide(f, input, f.args.tool);
    const failed = () =>
      new CadKernelError('press-line-failed', f.id, false, undefined, [['depth']]);
    const nameOf = (p: (typeof pieces)[number], as: string) => {
      const name = input.names[p.from - 1];
      return name ? prefixFaceName(`press:${f.id}:${as}`, name) : null;
    };
    const moving = pieces.filter((p) => p.side === f.args.side);
    const staying = pieces.filter((p) => p.side !== f.args.side);
    if (!moving.length || !staying.length) throw failed();
    const builder = own(new oc.BRep_Builder());
    const shellOf = (faces: unknown[]) => {
      const shell = own(new oc.TopoDS_Shell());
      builder.MakeShell(shell);
      for (const face of faces) builder.Add(shell, face);
      return shell;
    };
    const moved = shellOf(moving.map((p) => p.piece));
    const stays = shellOf(staying.map((p) => p.piece));
    // The dividing edges: shared by a piece that moves and one that stays.
    const stayEdges = shapeMap(stays, 'TopAbs_EDGE');
    const dividing: unknown[] = [];
    explore(moved, 'TopAbs_EDGE', (e) => {
      if (stayEdges.FindIndex(e) > 0 && !dividing.some((d) => (d as OcModule).IsSame(e)))
        dividing.push(own(oc.TopoDS.Edge_1(e)));
    });
    if (!dividing.length) throw failed();
    const d = len(f.args.depth) * (f.args.toward === 'back' ? -1 : 1);
    const off = own(new oc.BRepOffsetAPI_MakeOffsetShape());
    off.PerformBySimple(moved, d);
    try {
      off.Build(own(new oc.Message_ProgressRange_1()));
    } catch {
      throw failed();
    }
    if (!off.IsDone()) throw failed();
    const offset = own(off.Shape());
    refitEdges(offset, moved, d);
    // Each dividing edge's moved copy: the offset edge whose middle lies nearest its middle
    // moved by the depth.
    const middle = (edge: unknown): Vec3 => {
      const c = networkCurve(f, edge);
      return c.at((c.t0 + c.t1) / 2);
    };
    const offsetEdges: { edge: unknown; mid: Vec3 }[] = [];
    explore(offset, 'TopAbs_EDGE', (e) => {
      const edge = own(oc.TopoDS.Edge_1(e));
      if (!oc.BRep_Tool.Degenerated(edge)) offsetEdges.push({ edge, mid: middle(edge) });
    });
    const copyOf = (edge: unknown) => {
      const m = middle(edge);
      let best: { edge: unknown; mid: Vec3 } | undefined;
      let dist = Infinity;
      for (const o of offsetEdges) {
        const gap = Math.hypot(...o.mid.map((x, i) => x - m[i]!));
        if (gap < dist) [best, dist] = [o, gap];
      }
      return best && Math.abs(dist - Math.abs(d)) <= Math.max(0.05 * Math.abs(d), 0.01)
        ? best.edge
        : undefined;
    };
    const pairs = dividing.map((edge) => {
      const copy = copyOf(edge);
      if (!copy) throw failed();
      return { edge, copy };
    });
    const walls = pairs.map(({ edge, copy }) => {
      const wire = (e: unknown) => own(own(new oc.BRepBuilderAPI_MakeWire_2(e)).Wire());
      let loft;
      try {
        loft = thruSections(f.id, [wire(edge), wire(copy)], false, true);
      } catch {
        throw failed();
      }
      let face: unknown;
      explore(own(loft.Shape()), 'TopAbs_FACE', (x) => (face ??= x));
      if (!face) throw failed();
      return face;
    });
    const tolerance = Math.max(10 * doc.kernelProfile.linearToleranceMm, 1e-3);
    const sewing = own(new oc.BRepBuilderAPI_Sewing(tolerance, true, true, true, false));
    sewing.Add(stays);
    for (const wall of walls) sewing.Add(wall);
    sewing.Add(offset);
    try {
      sewing.Perform(own(new oc.Message_ProgressRange_1()));
    } catch {
      throw failed();
    }
    let sewn = own(sewing.SewedShape());
    const image = (s: unknown) =>
      sewing.IsModifiedSubShape(s) ? own(sewing.ModifiedSubShape(s)) : s;
    let shells = 0;
    let one: unknown;
    explore(sewn, 'TopAbs_SHELL', (sh) => ((one = sh), shells++));
    const faceCount = staying.length + walls.length + moving.length;
    if (shells !== 1 || shapeMap(one, 'TopAbs_FACE').Size() !== faceCount) throw failed();
    sewn = one;
    const before = named(sewn, () => null);
    // The input's named edges (free borders) carried through the split, the move of the moved
    // side and the sew, so a border keeps its own name (Codex on #921).
    if (naming) {
      const movedEdges = shapeMap(moved, 'TopAbs_EDGE');
      for (const { edge, name } of input.edges ?? [])
        for (const piece of history(splitter)(edge)) {
          const at = movedEdges.FindIndex(piece) > 0 ? copyOf(own(oc.TopoDS.Edge_1(piece))) : piece;
          if (at)
            (before.edges ??= []).push({
              edge: image(at),
              name: prefixFaceName(`press:${f.id}`, name),
            });
        }
    }
    // Names before the rounding: staying, moved and wall faces.
    const nameAt = (face: unknown, name: CadFaceName | null) => {
      const j = before.faces.FindIndex(image(face));
      if (naming && j > 0 && name) before.names[j - 1] = name;
    };
    for (const p of staying) nameAt(p.piece, nameOf(p, p.side));
    moving.forEach((p) => {
      for (const face of listOf(off.Generated(p.piece))) nameAt(face, nameOf(p, 'moved'));
    });
    const sideNames = (edge: unknown) => {
      const [a, b] = [staying, moving].map((list) =>
        list.find((p) => shapeMap(p.piece, 'TopAbs_EDGE').FindIndex(edge) > 0),
      );
      const [na, nb] = [a && nameOf(a, a.side), b && nameOf(b, 'moved')];
      return na && nb ? edgeName(na, nb) : null;
    };
    const wallNames = pairs.map(({ edge }) => {
      const between = naming ? sideNames(edge) : null;
      // A closed chain's walls all lie between the same two pieces: the chain element tells
      // them apart (Codex on #921).
      const element = elementOf(edge);
      return between
        ? prefixFaceName(`press:${f.id}`, [
            `wall:${topoNameKey(between)}`,
            ...(element ? [`e:${element}`] : []),
          ])
        : null;
    });
    walls.forEach((w, k) => nameAt(w, wallNames[k]!));
    if (!own(new oc.BRepCheck_Analyzer(sewn, true, false)).IsValid_2()) throw failed();
    // The wall's two borders rounded.
    const rounded = pairs.flatMap(({ edge, copy }) => [image(edge), image(copy)]);
    const op = own(new oc.BRepFilletAPI_MakeFillet(sewn, oc.ChFi3d_FilletShape.ChFi3d_Rational));
    const r = len(f.args.radius);
    for (const e of rounded) op.Add_2(r, own(oc.TopoDS.Edge_1(e)));
    try {
      op.Build(own(new oc.Message_ProgressRange_1()));
    } catch {
      throw failed();
    }
    if (!op.IsDone()) throw failed();
    const shape = own(op.Shape());
    if (
      maxTolerance(shape) > doc.kernelProfile.maxResultLinearToleranceMm ||
      !own(new oc.BRepCheck_Analyzer(shape, true, false)).IsValid_2()
    )
      throw failed();
    const result = carry(shape, before, history(op));
    if (naming && before.edges?.length) {
      const edges = shapeMap(shape, 'TopAbs_EDGE');
      const have = (e: unknown) => edges.FindIndex(e) > 0;
      const mids: { edge: unknown; mid: Vec3 }[] = [];
      for (let i = 1; i <= edges.Size(); i++) {
        const e = own(oc.TopoDS.Edge_1(own(edges.FindKey(i))));
        if (!oc.BRep_Tool.Degenerated(e)) mids.push({ edge: e, mid: middle(e) });
      }
      // An edge the rounding reports as modified may come back as one not in the result, and
      // the one in the result can be the edge itself or a copy found by its middle.
      const fillet = history(op);
      result.edges = [];
      for (const { edge, name } of before.edges) {
        const made = fillet(edge).filter(have);
        if (!made.length && have(edge)) made.push(edge);
        if (!made.length) {
          const m = middle(own(oc.TopoDS.Edge_1(edge)));
          const found = mids.find(
            (x) =>
              Math.hypot(...x.mid.map((v, i) => v - m[i]!)) <=
              10 * doc.kernelProfile.linearToleranceMm,
          );
          if (found) made.push(found.edge);
        }
        for (const e of made) result.edges.push({ edge: e, name });
      }
      // The new free edges where an open line meets a border (the wall's and the rounds' ends)
      // are named by that border: `press:<ID>:end/<border>`, from a named free edge they meet
      // at a vertex, so each end can be referenced (Codex on #921).
      const free = freeEdges(shape);
      const vertices = (e: unknown) => {
        const out: unknown[] = [];
        explore(e, 'TopAbs_VERTEX', (v) => out.push(v));
        return out;
      };
      const meets = (a: unknown, b: unknown) =>
        vertices(a).some((v) => vertices(b).some((w) => (v as OcModule).IsSame(w)));
      const labelled = new Set(result.edges.map((x) => edges.FindIndex(x.edge)));
      const prefix = `press:${f.id}`;
      for (let pass = 0; pass < 3; pass++)
        for (const i of free) {
          if (labelled.has(i)) continue;
          const e = own(edges.FindKey(i));
          const by = result.edges.find(
            (x) =>
              x.name[0]!.startsWith(prefix) &&
              free.has(edges.FindIndex(x.edge)) &&
              meets(e, x.edge),
          );
          if (!by) continue;
          result.edges.push({ edge: e, name: prefixFaceName(`${prefix}:end`, by.name.slice(1)) });
          labelled.add(i);
        }
    }
    if (naming) {
      const ancestors = own(new oc.TopTools_IndexedDataMapOfShapeListOfShape_1());
      oc.TopExp.MapShapesAndAncestors(
        sewn,
        oc.TopAbs_ShapeEnum.TopAbs_EDGE,
        oc.TopAbs_ShapeEnum.TopAbs_FACE,
        ancestors,
      );
      for (const e of rounded) {
        const k = ancestors.FindIndex(e);
        const faces = k > 0 ? listOf(ancestors.FindFromIndex(k)) : [];
        const names = faces.map((x) => before.names[before.faces.FindIndex(x) - 1]);
        if (names.length !== 2 || !names[0] || !names[1]) continue;
        const name = blendFaceName(edgeName(names[0], names[1]));
        for (const face of listOf(op.Generated(e))) {
          const j = result.faces.FindIndex(face);
          if (j > 0 && !result.names[j - 1]) result.names[j - 1] = name;
        }
      }
    }
    return sheetOf(result);
  }
  /**
   * CR2d: a flare. The sheet is divided along the chain (as `split`); the pieces on the arch's
   * side go, and a fill takes their place: G1 or G2 to the staying pieces along the chain,
   * through the arch moved `height` along the gone pieces' mean normal, and through ramps from
   * where the chain meets the sheet's border to the moved arch's ends. The fill is a Gordon
   * surface (a plate, `BRepFill_Filling`, stays some 5e-3 mm off the chain: past the result
   * tolerance) and is sewn to the staying pieces. Staying pieces are `flare:<ID>/<name>`, the
   * fill `flare:<ID>/surface`, its moved arch `flare:<ID>:moved/<the edge it replaces>` and its
   * ramps `flare:<ID>:first/…` and `flare:<ID>:last/…` (by the chain's end they start from).
   */
  function flare(f: Extract<CadFeature, { type: 'flare' }>, shapes: Map<string, Named>): Named {
    const input = shapes.get(f.inputFeatureIds[0])!;
    const failed = (path: (string | number)[] = ['height']) =>
      new CadKernelError('flare-failed', f.id, false, undefined, [path]);
    const [archIndex] = resolveRefs(f, input, [{ path: ['arch'], ref: f.args.arch }]);
    const table = tableOf(input);
    if (table.topology.edges[archIndex!]!.faces.length !== 1)
      throw new CadKernelError('flare-arch-not-free', f.id, false, undefined, [['arch']]);
    const arch = table.edge(archIndex!);
    const { pieces, splitter } = divide(f, input, f.args.tool);
    const image = history(splitter);
    const archPieces = image(arch);
    const edgesOf = (s: unknown) => shapeMap(s, 'TopAbs_EDGE');
    // The side the arch lies on goes.
    const sides = new Set(
      pieces
        .filter((p) => archPieces.some((e) => edgesOf(p.piece).FindIndex(e) > 0))
        .map((p) => p.side),
    );
    if (sides.size !== 1)
      throw new CadKernelError('flare-arch-side', f.id, false, undefined, [['arch']]);
    const [goSide] = [...sides];
    const going = pieces.filter((p) => p.side === goSide);
    const staying = pieces.filter((p) => p.side !== goSide);
    if (!staying.length) throw failed(['tool']);
    const builder = own(new oc.BRep_Builder());
    const shellOf = (faces: unknown[]) => {
      const shell = own(new oc.TopoDS_Shell());
      builder.MakeShell(shell);
      for (const face of faces) builder.Add(shell, face);
      return shell;
    };
    const stays = shellOf(staying.map((p) => p.piece));
    // Outward: the gone pieces' mean normal, weighted by area.
    const n: Vec3 = [0, 0, 0];
    for (const p of going) {
      const area = faceProps(p.piece).area;
      const m = outwardNormal(p.piece, area);
      if (m) for (let i = 0; i < 3; i++) n[i] += m[i]! * area;
    }
    const nl = Math.hypot(...n);
    if (!(nl > 0)) throw failed();
    const v = n.map((x) => (x / nl) * len(f.args.height)) as Vec3;
    // The gone region's border: dividing edges (shared with a staying piece) and free edges.
    const stayEdges = edgesOf(stays);
    const free = freeEdges(input.shape);
    const inputEdges = edgesOf(input.shape);
    const isArch = (e: unknown) => archPieces.some((a) => (a as OcModule).IsSame(e));
    const dividing: { edge: unknown; face: unknown }[] = [];
    const border: { edge: unknown; arch: boolean }[] = [];
    const seen: unknown[] = [];
    for (const p of going)
      explore(p.piece, 'TopAbs_EDGE', (e) => {
        if (seen.some((x) => (x as OcModule).IsSame(e))) return;
        seen.push(e);
        const edge = own(oc.TopoDS.Edge_1(e));
        if (oc.BRep_Tool.Degenerated(edge)) return;
        if (stayEdges.FindIndex(edge) > 0) {
          const face = staying.find((q) => edgesOf(q.piece).FindIndex(edge) > 0)!.piece;
          dividing.push({ edge, face: own(oc.TopoDS.Face_1(face)) });
          return;
        }
        // A free edge of the input, or a piece of one.
        const from = [...free].some((i) =>
          image(own(inputEdges.FindKey(i))).some((x) => (x as OcModule).IsSame(edge)),
        );
        if (from || isArch(edge)) border.push({ edge, arch: isArch(edge) });
      });
    if (!dividing.length || !border.some((b) => b.arch)) throw failed(['tool']);
    const dist = (a: Vec3, b: Vec3) => Math.hypot(...a.map((x, i) => x - b[i]!));
    const close = (a: Vec3, b: Vec3) => dist(a, b) <= 1e-4;
    const move = (p: Vec3) => p.map((x, i) => x + v[i]!) as Vec3;
    // The chain and the arch, each one curve end to end (the arch moved); a border edge that
    // is neither runs from the chain's end to the arch's end, and a ramp takes its place.
    const chain = joinedCurve(dividing.map((d) => networkCurve(f, d.edge)));
    const archEdges = border.filter((b) => b.arch);
    const archCurve = joinedCurve(archEdges.map((b) => networkCurve(f, b.edge)));
    const ramps = border.filter((b) => !b.arch);
    if (!chain || !archCurve || ramps.length !== 2) throw failed(['tool']);
    const [c0, c1] = [chain.at(chain.t0), chain.at(chain.t1)];
    let [a0, a1] = [archCurve.at(archCurve.t0), archCurve.at(archCurve.t1)];
    const rampEnds = ramps.map((b) => {
      const c = networkCurve(f, b.edge);
      return [c.at(c.t0), c.at(c.t1)] as const;
    });
    const joins = (r: readonly [Vec3, Vec3], p: Vec3, q: Vec3) =>
      (close(r[0], p) && close(r[1], q)) || (close(r[1], p) && close(r[0], q));
    // The arch runs the chain's way: its start is the ramp's end from the chain's start.
    let archRun = archCurve;
    if (!rampEnds.some((r) => joins(r, c0, a0))) {
      archRun = reversedCurve(archCurve);
      [a0, a1] = [a1, a0];
    }
    const first = ramps.findIndex((_, i) => joins(rampEnds[i]!, c0, a0));
    const last = ramps.findIndex((_, i) => joins(rampEnds[i]!, c1, a1));
    if (first < 0 || last < 0 || first === last) throw failed(['tool']);
    // CR2d: the fill is a Gordon surface (gordon.ts) through the chain, the moved arch and
    // profiles across from one to the other at equal shares of their lengths. Each profile
    // leaves the sheet in its tangent plane (G1) and, for G2, with the sheet's normal curvature
    // that way, and rises to the moved arch: a cubic rising as 3s² − 2s³ (G1) or as s³ (G2).
    // The first and last profiles are the ramps.
    const meshed = (face: unknown) => {
      const c = own(
        own(new oc.BRepBuilderAPI_Transform_2(face, own(new oc.gp_Trsf_1()), true)).Shape(),
      );
      own(new oc.BRepMesh_IncrementalMesh_2(c, 0.5, false, 0.2, false));
      return own(oc.TopoDS.Face_1(c));
    };
    const projectors = dividing.map((d) => surfaceProjector(oc, own, meshed(d.face)));
    const onSheet = (p: Vec3) => {
      for (const s of projectors) {
        const at = s.project(p);
        if (at) return { at, s };
      }
      return undefined;
    };
    const chainAt = atShare(chain);
    const archAt = atShare(archRun);
    const g2 = f.args.continuity === 'G2';
    const count = cadFlareProfiles;
    const profiles: NetworkCurve[] = [];
    for (let j = 0; j < count; j++) {
      const share = j / (count - 1);
      const a = chainAt(share);
      const z = archAt(share);
      const d = z.map((x, i) => x - a[i]!) as Vec3;
      const sheet = onSheet(a);
      if (!sheet) throw failed();
      const n = sheet.at.normal;
      const along = d.map((x, i) => x - dotV(d, n) * n[i]!) as Vec3;
      const l = Math.hypot(...along);
      if (!(l > 1e-6)) throw failed();
      const T = along.map((x) => (x / l) * Math.hypot(...d)) as Vec3;
      const Z = move(z);
      const plus = (p: Vec3, q: Vec3, k = 1) => p.map((x, i) => x + k * q[i]!) as Vec3;
      // A cubic, which the surface's cubic fit keeps exactly: for G2 its second pole stays at
      // the sheet's curvature (C''(0) = 6 (P2 − 2 P1 + P0) = k |T|² n), so it rises as s³.
      const p1 = plus(a, T, 1 / 3);
      const p2 = g2
        ? plus(plus(p1, T, 1 / 3), n, (sheet.s.curvature(sheet.at, T) * dotV(T, T)) / 6)
        : plus(Z, d, -1 / 3);
      profiles.push(bezierCurve([a, p1, p2, Z]));
    }
    const fit = doc.kernelProfile.maxResultLinearToleranceMm * 0.8;
    const surfaceOf = gordonSurface([chain, movedCurve(archRun, v)], profiles, fit, fit);
    if ('code' in surfaceOf) throw failed();
    const made = gordonFace(f, surfaceOf).face;
    // Which network curve each of the fill's edges lies on (its midpoint nearest).
    const network = [chain, movedCurve(archRun, v), profiles[0]!, profiles[count - 1]!];
    const roles: ('chain' | 'arch' | 'first' | 'last')[] = ['chain', 'arch', 'first', 'last'];
    const madeEdges: { edge: unknown; role: (typeof roles)[number] }[] = [];
    explore(made, 'TopAbs_EDGE', (e) => {
      const edge = own(oc.TopoDS.Edge_1(e));
      if (oc.BRep_Tool.Degenerated(edge)) return;
      const c = networkCurve(f, edge);
      const mid = c.at((c.t0 + c.t1) / 2);
      const d = network.map((n) => distanceToCurve(n, mid));
      madeEdges.push({ edge, role: roles[d.indexOf(Math.min(...d))]! });
    });
    // G1 (and G2) to the staying pieces, as the continuity check measures it.
    const madeMeshed = meshed(made);
    for (const d of dividing) {
      const samples = edgeContinuity(oc, own, d.edge, [madeMeshed, meshed(d.face)]);
      if (samples === 'continuity-projection-failed') throw failed();
      if (samples.some((s) => Math.min(s.g1Deg, 180 - s.g1Deg) > cadContinuity.g1Deg))
        throw new CadKernelError('fill-g1-unreached', f.id, false, undefined, [['continuity']]);
      if (g2 && !fillMeetsG2(made, d.edge, d.face))
        throw new CadKernelError('fill-g2-unreached', f.id, false, undefined, [['continuity']]);
    }
    const tolerance = Math.max(10 * doc.kernelProfile.linearToleranceMm, 1e-3);
    const sewing = own(new oc.BRepBuilderAPI_Sewing(tolerance, true, true, true, false));
    sewing.Add(stays);
    sewing.Add(made);
    try {
      sewing.Perform(own(new oc.Message_ProgressRange_1()));
    } catch {
      throw failed();
    }
    const sewnImage = (s: unknown) =>
      sewing.IsModifiedSubShape(s) ? own(sewing.ModifiedSubShape(s)) : s;
    let shells = 0;
    let shell: unknown;
    explore(own(sewing.SewedShape()), 'TopAbs_SHELL', (sh) => ((shell = sh), shells++));
    if (shells !== 1 || shapeMap(shell, 'TopAbs_FACE').Size() !== staying.length + 1)
      throw failed();
    if (
      maxTolerance(shell) > doc.kernelProfile.maxResultLinearToleranceMm ||
      !own(new oc.BRepCheck_Analyzer(shell, true, false)).IsValid_2()
    )
      throw failed();
    const result = named(shell, () => null);
    if (!naming) return result;
    const at = (face: unknown, name: CadFaceName | null) => {
      const j = result.faces.FindIndex(sewnImage(face));
      if (j > 0 && name) result.names[j - 1] = name;
    };
    for (const p of staying) {
      const name = input.names[p.from - 1];
      at(p.piece, name ? prefixFaceName(`flare:${f.id}`, name) : null);
    }
    at(made, [`flare:${f.id}`, 'surface']);
    // Edge names: the input's named borders on the staying side keep theirs; a new edge of the
    // fill is named by the border edge it replaces (the moved arch by its first named piece).
    const resultEdges = edgesOf(shell);
    const nameOfEdge = new Map<unknown, CadFaceName>();
    for (const { edge, name } of input.edges ?? [])
      for (const piece of image(edge)) nameOfEdge.set(piece, name);
    const nameFor = (e: unknown) => {
      for (const [k, name] of nameOfEdge) if ((k as OcModule).IsSame(e)) return name;
      return undefined;
    };
    for (const p of staying)
      explore(p.piece, 'TopAbs_EDGE', (e) => {
        const name = nameFor(e);
        const img = sewnImage(e);
        if (name && resultEdges.FindIndex(img) > 0)
          (result.edges ??= []).push({ edge: img, name: prefixFaceName(`flare:${f.id}`, name) });
      });
    const replaced = {
      chain: undefined,
      arch: archEdges.map((b) => nameFor(b.edge)).find((x) => x),
      first: nameFor(ramps[first]!.edge),
      last: nameFor(ramps[last]!.edge),
    };
    // The two ramps often replace pieces of one border, and their neighbours have the same
    // names too: each is told by its end of the chain (Codex, #927).
    const tag = { chain: 'moved', arch: 'moved', first: 'first', last: 'last' } as const;
    for (const { edge, role } of madeEdges) {
      const name = replaced[role];
      const img = sewnImage(edge);
      if (name && resultEdges.FindIndex(img) > 0)
        (result.edges ??= []).push({
          edge: img,
          name: prefixFaceName(`flare:${f.id}:${tag[role]}`, name),
        });
    }
    return result;
  }
  /**
   * CR4d: a profile sweep. The section (`profileOutline`) is placed square to the path where it
   * starts: its height along the path sketch's normal (`normal`), along the in-plane normal
   * (`inPlane`, B × T) or along `up` (a straight path only), turned over by `flip`. It is swept
   * with the binormal held: the sketch's normal for a planar path, so the section turns with the
   * path in its plane. Faces are `side:p:<side>` with `path:e:<element>` (as a surface sweep's),
   * the start and end edges `start`/`end` and the long free edges `edge:start:p:<first side>`
   * and `edge:end:p:<last side>`.
   */
  function profileSweep(f: Extract<CadFeature, { type: 'profileSweep' }>): Named {
    const failed = (code = 'profile-sweep-failed', path: (string | number)[] = ['path']) =>
      new CadKernelError(code, f.id, false, undefined, [path]);
    const p = f.args.profile;
    const outline = profileOutline(
      p.kind,
      len(p.height),
      len(p.width),
      len(p.flange),
      len(p.radius),
    );
    if ('code' in outline) throw failed(outline.code, ['profile']);
    const path = pathWire(f, f.args.path);
    if (path.tightest <= profileReach(outline.segments))
      throw failed('profile-sweep-tight', ['profile']);
    const edgeCurve = (e: unknown) => networkCurve(f, own(oc.TopoDS.Edge_1(e)));
    const first = edgeCurve(path.edges[0]!.edge);
    const o = first.at(first.t0);
    const h = (first.t1 - first.t0) * 1e-6;
    const T = normalizeV(subV(first.at(first.t0 + h), o));
    const B = normalizeV(rotateVector(frames.get(f.args.path.sketchId)![0], [0, 0, 1]));
    const s = f.args.flip ? -1 : 1;
    let up: Vec3;
    let binormal: Vec3;
    if (f.args.up === 'normal') [up, binormal] = [scaleV(B, s), B];
    else if (f.args.up === 'inPlane') [up, binormal] = [scaleV(crossV(B, T), s), B];
    else {
      up = scaleV(f.args.up, s);
      if (Math.abs(dotV(up, T)) > 1e-6) throw failed('profile-up', ['up']);
      // Along a vector, the path is straight: every element a line on the first one's line.
      for (const { edge } of path.edges) {
        const c = edgeCurve(edge);
        for (let k = 0; k <= 8; k++) {
          const q = subV(c.at(c.t0 + ((c.t1 - c.t0) * k) / 8), o);
          if (Math.hypot(...subV(q, scaleV(T, dotV(q, T)))) > doc.kernelProfile.linearToleranceMm)
            throw failed('profile-up-curved', ['up']);
        }
      }
      binormal = crossV(up, T);
    }
    const U = crossV(up, T);
    const at = ([u, v]: [number, number]) => addV(o, addV(scaleV(U, u), scaleV(up, v)));
    const tol = doc.kernelProfile.linearToleranceMm;
    const builder = own(new oc.BRep_Builder());
    const vertices: { p: Vec3; v: unknown }[] = [];
    const vertex = (q: Vec3) => {
      const known = vertices.find((x) => Math.hypot(...subV(x.p, q)) <= 1e-9);
      if (known) return known.v;
      const v = own(new oc.TopoDS_Vertex());
      builder.MakeVertex_2(v, pnt(...q), tol);
      vertices.push({ p: q, v });
      return v;
    };
    const wire = own(new oc.BRepBuilderAPI_MakeWire_1());
    const made: { edge: unknown; id: string }[] = [];
    for (const seg of outline.segments) {
      const [a, b] = [at(seg.a), at(seg.b)];
      let edge;
      if (seg.kind === 'line') edge = new oc.BRepBuilderAPI_MakeEdge_2(vertex(a), vertex(b));
      else {
        const c = at(seg.centre);
        const axis = normalizeV(crossV(subV(a, c), subV(b, c)));
        const r = Math.hypot(...subV(a, c));
        const frame = own(new oc.gp_Ax2_3(pnt(...c), own(new oc.gp_Dir_4(...axis))));
        edge = new oc.BRepBuilderAPI_MakeEdge_11(
          own(new oc.gp_Circ_2(frame, r)),
          vertex(a),
          vertex(b),
        );
      }
      own(edge);
      if (!edge.IsDone()) throw failed();
      wire.Add_1(own(edge.Edge()));
      if (!wire.IsDone()) throw failed();
      made.push({ edge: own(wire.Edge()), id: seg.name });
    }
    const profile = {
      wire: own(wire.Wire()),
      edges: made,
      closed: false,
      ends: [[`edge:start:p:${made[0]!.id}`], [`edge:end:p:${made[made.length - 1]!.id}`]] as [
        CadFaceName,
        CadFaceName,
      ],
    };
    const pipe = own(new oc.BRepOffsetAPI_MakePipeShell(path.wire));
    pipe.SetMode_3(own(new oc.gp_Dir_4(...binormal)));
    pipe.Add_1(profile.wire, false, false);
    if (!pipe.IsReady()) throw failed();
    try {
      pipe.Build(own(new oc.Message_ProgressRange_1()));
    } catch {
      throw failed();
    }
    if (!pipe.IsDone()) throw failed();
    const generated = (x: unknown) => pipe.Generated(x);
    const result = sweptNames(
      {
        FirstShape_1: () => pipe.FirstShape(),
        LastShape_1: () => pipe.LastShape(),
        Generated: generated,
        Shape: () => pipe.Shape(),
      },
      made.map(({ edge, id }) => ({ edge, name: [`side:p:${id}`] })),
      false,
    );
    if (naming) pathNames(result, pipe, path.edges);
    return sheetOf(
      boundaryNames(result, generated, profile, own(pipe.FirstShape()), own(pipe.LastShape())),
    );
  }
  /** How near a flange strip's border (and the other shape's) a crossing may lie (CR4c), in mm. */
  const flangeContactMm = 0.01;
  /**
   * CR4c: a flange. Each free edge (a closed one in two halves) gets a ruled strip: from the
   * edge to the edge moved `width` along d = cos(angle)·out + sin(angle)·(±n), where n is the
   * sheet's normal (its front) and out the sheet's tangent away from it, square to the edge
   * (material lies left of an edge run as its face has it, seen from the front). The strip is a
   * Gordon surface (gordon.ts) through the edge, the moved edge and the two straight ends, so
   * its ends are square to the edge. The strips are sewn to the sheet. A strip whose far side
   * turns back on itself, or that crosses the sheet or another strip anywhere but along their
   * borders, is refused as `flange-self-intersects`. The sheet's faces are `flange:<ID>/<name>`,
   * a strip `flange:<ID>:wall/<k>` (k the edge's place in `edges`, `.0`/`.1` for a closed edge's
   * halves), its far edge `flange:<ID>:far/<k>` and its ends `flange:<ID>:start|end/<k>`.
   */
  function flange(f: Extract<CadFeature, { type: 'flange' }>, shapes: Map<string, Named>): Named {
    const input = shapes.get(f.inputFeatureIds[0])!;
    const failed = (path: (string | number)[] = ['width']) =>
      new CadKernelError('flange-failed', f.id, false, undefined, [path]);
    const crossing = (path: (string | number)[]) =>
      new CadKernelError('flange-self-intersects', f.id, false, undefined, [path]);
    const indices = resolveRefs(
      f,
      input,
      f.args.edges.map((ref, i) => ({ path: ['edges', i], ref })),
    );
    const table = tableOf(input);
    const width = len(f.args.width);
    const angle = resolveAngle(f.args.angle, params);
    const [ca, sa] = [Math.cos(angle), Math.sin(angle) * (f.args.toward === 'front' ? 1 : -1)];
    const reversed = (s: unknown) =>
      (s as { Orientation_1(): { value: number } }).Orientation_1().value ===
      oc.TopAbs_Orientation.TopAbs_REVERSED.value;
    const meshed = (face: unknown) => {
      const c = own(
        own(new oc.BRepBuilderAPI_Transform_2(face, own(new oc.gp_Trsf_1()), true)).Shape(),
      );
      own(new oc.BRepMesh_IncrementalMesh_2(c, 0.5, false, 0.2, false));
      return own(oc.TopoDS.Face_1(c));
    };
    type Strip = {
      key: string;
      path: (string | number)[];
      root: NetworkCurve;
      far: NetworkCurve;
      ends: [NetworkCurve, NetworkCurve];
      face?: unknown;
    };
    const strips: Strip[] = [];
    const P = own(new oc.gp_Pnt_1());
    const D = own(new oc.gp_Vec_1());
    indices.forEach((k, i) => {
      const path = ['edges', i];
      const row = table.topology.edges[k]!;
      const edge = table.edge(k);
      const face = row.faces.length === 1 ? table.face(row.faces[0]!) : undefined;
      if (!face || oc.BRep_Tool.Degenerated(edge) || oc.BRep_Tool.IsClosed_2(edge, face))
        throw new CadKernelError('flange-edge-not-free', f.id, false, undefined, [path]);
      // How the face runs the edge: material on its left, seen from the face's front.
      let run = 0;
      explore(face, 'TopAbs_EDGE', (e) => {
        if ((e as OcModule).IsSame(edge)) run = reversed(e) ? -1 : 1;
      });
      if (!run) throw failed(path);
      const handle = own(oc.BRep_Tool.Curve_2(edge, 0, 0));
      if (handle.IsNull()) throw failed(path);
      const curve = handle.get();
      const sheet = surfaceProjector(oc, own, meshed(face));
      const root = networkCurve(f, edge);
      const dir = (t: number): Vec3 => {
        curve.D1(t, P, D);
        const p: Vec3 = [P.X(), P.Y(), P.Z()];
        const n = sheet.project(p)?.normal;
        const l = D.Magnitude();
        if (!n || !(l > 0)) throw failed(path);
        const along = scaleV([D.X(), D.Y(), D.Z()], run / l);
        const out = crossV(along, n);
        const o = Math.hypot(...out);
        if (!(o > 0.5)) throw failed(path);
        return [0, 1, 2].map((j) => width * (ca * (out[j]! / o) + sa * n[j]!)) as Vec3;
      };
      // A closed edge in two halves, so each strip has two ends.
      const closed = root.at(root.t0).every((x, j) => Math.abs(x - root.at(root.t1)[j]!) <= 1e-7);
      const mid = (root.t0 + root.t1) / 2;
      const spans: [number, number][] = closed
        ? [
            [root.t0, mid],
            [mid, root.t1],
          ]
        : [[root.t0, root.t1]];
      spans.forEach(([a, b], h) => {
        const piece: NetworkCurve = {
          t0: a,
          t1: b,
          at: root.at,
          breaks: (root.breaks ?? [root.t0, root.t1])
            .filter((t) => t > a && t < b)
            .concat([a, b])
            .sort((x, y) => x - y),
        };
        const far: NetworkCurve = { ...piece, at: (t) => addV(root.at(t), dir(t)) };
        const line = (t: number) => {
          const p = root.at(t);
          const q = far.at(t);
          return bezierCurve([p, lerpV(p, q, 1 / 3), lerpV(p, q, 2 / 3), q]);
        };
        // The far side turns back where it runs against the edge (a tight inside curve).
        const n = 256;
        for (let j = 0; j < n; j++) {
          const [s, t] = [a + ((b - a) * j) / n, a + ((b - a) * (j + 1)) / n];
          if (dotV(subV(far.at(t), far.at(s)), subV(root.at(t), root.at(s))) <= 0)
            throw crossing(path);
        }
        strips.push({
          key: closed ? `${i}.${h}` : `${i}`,
          path,
          root: piece,
          far,
          ends: [line(a), line(b)],
        });
      });
    });
    const fit = doc.kernelProfile.maxResultLinearToleranceMm * 0.8;
    for (const s of strips) {
      const made = gordonSurface([s.root, s.far], s.ends, fit, fit);
      if ('code' in made) throw failed(s.path);
      s.face = gordonFace(f, made).face;
    }
    // Strips meet the sheet and each other only along their borders.
    const polyline = (c: NetworkCurve) =>
      Array.from({ length: 513 }, (_, j) => c.at(c.t0 + ((c.t1 - c.t0) * j) / 512));
    const near = (lines: Vec3[][], p: Vec3) =>
      lines.some((l) =>
        l.some((q, j) => {
          if (!j) return false;
          const o = l[j - 1]!;
          const d = subV(q, o);
          const dd = dotV(d, d);
          const u = dd > 0 ? Math.min(1, Math.max(0, dotV(subV(p, o), d) / dd)) : 0;
          return Math.hypot(...subV(p, addV(o, scaleV(d, u)))) <= flangeContactMm;
        }),
      );
    const inputEdges = shapeMap(input.shape, 'TopAbs_EDGE');
    const sheetBorder = [...freeEdges(input.shape)].map((j) =>
      polyline(networkCurve(f, own(oc.TopoDS.Edge_1(own(inputEdges.FindKey(j)))))),
    );
    const borders = strips.map((s) => [s.root, s.far, ...s.ends].map(polyline));
    const crosses = (a: unknown, b: unknown, aBorder: Vec3[][], bBorder: Vec3[][]) => {
      const op = own(new oc.BRepAlgoAPI_Section_3(a, b, false));
      op.Build(own(new oc.Message_ProgressRange_1()));
      if (!op.IsDone()) return true;
      let bad = false;
      explore(own(op.Shape()), 'TopAbs_EDGE', (e) => {
        if (bad) return;
        const c = networkCurve(f, own(oc.TopoDS.Edge_1(e)));
        for (const t of [0.25, 0.5, 0.75]) {
          const m = c.at(c.t0 + (c.t1 - c.t0) * t);
          if (!near(aBorder, m) || !near(bBorder, m)) bad = true;
        }
      });
      return bad;
    };
    strips.forEach((s, i) => {
      if (crosses(s.face, input.shape, borders[i]!, sheetBorder)) throw crossing(s.path);
      for (let j = i + 1; j < strips.length; j++)
        if (crosses(s.face, strips[j]!.face, borders[i]!, borders[j]!))
          throw crossing(strips[j]!.path);
    });
    const tolerance = Math.max(10 * doc.kernelProfile.linearToleranceMm, 1e-3);
    const sewing = own(new oc.BRepBuilderAPI_Sewing(tolerance, true, true, true, false));
    sewing.Add(input.shape);
    for (const s of strips) sewing.Add(s.face);
    try {
      sewing.Perform(own(new oc.Message_ProgressRange_1()));
    } catch {
      throw failed();
    }
    const sewnImage = (s: unknown) =>
      sewing.IsModifiedSubShape(s) ? own(sewing.ModifiedSubShape(s)) : s;
    let shells = 0;
    let shell: unknown;
    explore(own(sewing.SewedShape()), 'TopAbs_SHELL', (sh) => ((shell = sh), shells++));
    if (
      shells !== 1 ||
      shapeMap(shell, 'TopAbs_FACE').Size() !== input.faces.Size() + strips.length
    )
      throw failed();
    // Every strip is joined to the sheet along its edge.
    const free = freeEdges(shell);
    const shellEdges = shapeMap(shell, 'TopAbs_EDGE');
    const roleOf = (s: Strip, edge: unknown) => {
      const c = networkCurve(f, edge);
      const m = c.at((c.t0 + c.t1) / 2);
      const d = [s.root, s.far, ...s.ends].map((n) => distanceToCurve(n, m));
      return (['root', 'far', 'start', 'end'] as const)[d.indexOf(Math.min(...d))]!;
    };
    const stripEdges = strips.map((s) => {
      const out: { edge: unknown; role: ReturnType<typeof roleOf> }[] = [];
      explore(s.face, 'TopAbs_EDGE', (e) => {
        const edge = own(oc.TopoDS.Edge_1(e));
        if (oc.BRep_Tool.Degenerated(edge)) return;
        const role = roleOf(s, edge);
        if (role === 'root' && free.has(shellEdges.FindIndex(sewnImage(edge))))
          throw failed(s.path);
        out.push({ edge, role });
      });
      return out;
    });
    if (
      maxTolerance(shell) > doc.kernelProfile.maxResultLinearToleranceMm ||
      !own(new oc.BRepCheck_Analyzer(shell, true, false)).IsValid_2()
    )
      throw failed();
    const result = named(shell, () => null);
    if (!naming) return result;
    for (let j = 1; j <= input.faces.Size(); j++) {
      const name = input.names[j - 1];
      const at = result.faces.FindIndex(sewnImage(own(input.faces.FindKey(j))));
      if (at > 0 && name) result.names[at - 1] = prefixFaceName(`flange:${f.id}`, name);
    }
    strips.forEach((s) => {
      const at = result.faces.FindIndex(sewnImage(s.face));
      if (at > 0) result.names[at - 1] = [`flange:${f.id}:wall`, s.key];
    });
    // Edge names: the sheet's named borders keep theirs; a strip's far edge and ends by it.
    const resultEdges = shapeMap(shell, 'TopAbs_EDGE');
    for (const { edge, name } of input.edges ?? []) {
      const img = sewnImage(edge);
      if (resultEdges.FindIndex(img) > 0)
        (result.edges ??= []).push({ edge: img, name: prefixFaceName(`flange:${f.id}`, name) });
    }
    strips.forEach((s, i) => {
      for (const { edge, role } of stripEdges[i]!) {
        const img = sewnImage(edge);
        if (role !== 'root' && resultEdges.FindIndex(img) > 0)
          (result.edges ??= []).push({ edge: img, name: [`flange:${f.id}:${role}`, s.key] });
      }
    });
    return result;
  }
  /** How near a split's chain a point is on neither side of it (CR2a), in mm. */
  const splitSideReachMm = 0.001;
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
  /**
   * CR2e: OCCT's simple offset approximates each new edge's curve to its vertices' tolerance and
   * keeps whatever it reaches: along a long edge of a car's skin (4 m, a B-spline of many spans)
   * that is some 0.75 mm off the offset face. The offset keeps each edge's curves on the faces
   * and their parameters, so the exact edge at a parameter is its source's point moved `d`
   * along the source face's normal there. Each edge past the result tolerance gets a curve
   * fitted to those points (least squares, cubic, up to 512 poles) and the tolerance it then
   * needs; one the fit cannot bring within half the result tolerance is left as it is.
   */
  function refitEdges(shape: unknown, source: unknown, d: number) {
    const limit = doc.kernelProfile.maxResultLinearToleranceMm;
    const sourceFaces = own(new oc.TopTools_IndexedDataMapOfShapeListOfShape_1());
    oc.TopExp.MapShapesAndAncestors(
      source,
      oc.TopAbs_ShapeEnum.TopAbs_EDGE,
      oc.TopAbs_ShapeEnum.TopAbs_FACE,
      sourceFaces,
    );
    const vertexEdges = own(new oc.TopTools_IndexedDataMapOfShapeListOfShape_1());
    oc.TopExp.MapShapesAndAncestors(
      shape,
      oc.TopAbs_ShapeEnum.TopAbs_VERTEX,
      oc.TopAbs_ShapeEnum.TopAbs_EDGE,
      vertexEdges,
    );
    const builder = own(new oc.BRep_Builder());
    const loose: unknown[] = [];
    explore(shape, 'TopAbs_EDGE', (e) => {
      const edge = own(oc.TopoDS.Edge_1(e));
      if (
        (oc.BRep_Tool.Tolerance_2(edge) as number) > limit &&
        !loose.some((x) => (x as OcModule).IsSame(edge))
      )
        loose.push(edge);
    });
    if (!loose.length) return;
    const meshedFaces = new Map<unknown, ReturnType<typeof surfaceProjector>>();
    const projector = (face: unknown) => {
      for (const [k, p] of meshedFaces) if ((k as OcModule).IsSame(face)) return p;
      const c = own(
        own(new oc.BRepBuilderAPI_Transform_2(face, own(new oc.gp_Trsf_1()), true)).Shape(),
      );
      own(new oc.BRepMesh_IncrementalMesh_2(c, 0.5, false, 0.2, false));
      const p = surfaceProjector(oc, own, own(oc.TopoDS.Face_1(c)));
      meshedFaces.set(face, p);
      return p;
    };
    for (let k = 1; k <= sourceFaces.Extent(); k++) {
      const from = own(oc.TopoDS.Edge_1(own(sourceFaces.FindKey(k))));
      if (oc.BRep_Tool.Degenerated(from)) continue;
      const faces = listOf(sourceFaces.FindFromIndex(k));
      if (!faces.length) continue;
      const src = networkCurve({ id: '' } as CadFeature, from);
      const onSource = projector(faces[0]);
      const srcMid = src.at((src.t0 + src.t1) / 2);
      // Its offset copy: the loose edge over the same parameters whose middle lies the offset
      // away (the offset's history does not list edges).
      for (const edge of loose) {
        const old = networkCurve({ id: '' } as CadFeature, edge);
        if (Math.abs(old.t0 - src.t0) > 1e-9 || Math.abs(old.t1 - src.t1) > 1e-9) continue;
        const o0 = old.at((old.t0 + old.t1) / 2);
        const gap = Math.hypot(...o0.map((x, i) => x - srcMid[i]!));
        if (Math.abs(gap - Math.abs(d)) > 2 * (oc.BRep_Tool.Tolerance_2(edge) as number) + 1e-6)
          continue;
        const moved = (t: number, sign: number): Vec3 | undefined => {
          const p = src.at(t);
          const at = onSource.project(p);
          return at && (p.map((x, i) => x + sign * d * at.normal[i]!) as Vec3);
        };
        const mid = (src.t0 + src.t1) / 2;
        const o = old.at(mid);
        const away = (q?: Vec3) => (q ? Math.hypot(...q.map((x, i) => x - o[i]!)) : Infinity);
        const sign = away(moved(mid, 1)) <= away(moved(mid, -1)) ? 1 : -1;
        let best: { fit: ReturnType<typeof fitCurve>; deviation: number } | undefined;
        for (let n = 16; n <= 512 && !(best && best.deviation <= limit / 10); n *= 2) {
          const m = 8 * n;
          const ts = Array.from({ length: m + 1 }, (_, i) => i / m);
          const points = ts.map((s) => moved(src.t0 + (src.t1 - src.t0) * s, sign));
          if (points.some((p) => !p)) break;
          const fit = fitCurve(ts, points as Vec3[], n);
          let deviation = 0;
          for (let i = 0; i <= 2 * m; i++) {
            const s = i / (2 * m);
            const q = moved(src.t0 + (src.t1 - src.t0) * s, sign)!;
            const p = fit.at(s);
            deviation = Math.max(deviation, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
          }
          if (!best || deviation < best.deviation) best = { fit, deviation };
        }
        if (!best || best.deviation > limit / 2) continue;
        const { knots, poles } = best.fit;
        const distinct = [...new Set(knots)];
        const P1 = own(new oc.TColgp_Array1OfPnt_2(1, poles.length));
        poles.forEach((p, i) => P1.SetValue(i + 1, pnt(...p)));
        const K = own(new oc.TColStd_Array1OfReal_2(1, distinct.length));
        distinct.forEach((x, i) => K.SetValue(i + 1, src.t0 + (src.t1 - src.t0) * x));
        const M = own(new oc.TColStd_Array1OfInteger_2(1, distinct.length));
        distinct.forEach((x, i) => M.SetValue(i + 1, knots.filter((y) => y === x).length));
        const curve = own(
          new oc.Handle_Geom_Curve_2(new oc.Geom_BSplineCurve_1(P1, K, M, 3, false)),
        );
        builder.UpdateEdge_1(edge, curve, best.deviation);
        // The edge and its vertices down to what it and the vertices' other edges need.
        const first = own(new oc.TopoDS_Vertex());
        const last = own(new oc.TopoDS_Vertex());
        oc.TopExp.Vertices_1(edge, first, last, false);
        let need = Math.max(2 * best.deviation, 1e-7);
        for (const v of [first, last]) {
          const j = vertexEdges.FindIndex(v);
          if (j > 0)
            for (const e of listOf(vertexEdges.FindFromIndex(j)))
              if (!(e as OcModule).IsSame(edge))
                need = Math.max(need, oc.BRep_Tool.Tolerance_2(own(oc.TopoDS.Edge_1(e))) as number);
        }
        own(new oc.ShapeFix_ShapeTolerance()).LimitTolerance(
          edge,
          0,
          need,
          oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
        );
      }
    }
  }
  /**
   * CR2b: a copy of a sheet moved along its normal. Each face keeps its source's name under
   * `offset:`; a result OCCT cannot make (a distance past a curvature radius, faces that would
   * cross) is refused with `offset-failed` and the source faces it lists.
   */
  function offsetSurface(
    f: Extract<CadFeature, { type: 'offsetSurface' }>,
    shapes: Map<string, Named>,
  ): Named {
    const source = shapes.get(f.args.source.featureId)!;
    const d = len(f.args.distance) * (f.args.side === 'back' ? -1 : 1);
    const off = own(new oc.BRepOffsetAPI_MakeOffsetShape());
    off.PerformBySimple(source.shape, d);
    const failed = () =>
      new CadKernelError('offset-failed', f.id, false, undefined, [['distance']]);
    try {
      off.Build(own(new oc.Message_ProgressRange_1()));
    } catch {
      throw failed();
    }
    if (!off.IsDone()) throw failed();
    const shape = own(off.Shape());
    refitEdges(shape, source.shape, d);
    let faces = 0;
    explore(shape, 'TopAbs_FACE', () => faces++);
    if (
      faces !== source.faces.Size() ||
      maxTolerance(shape) > doc.kernelProfile.maxResultLinearToleranceMm ||
      !own(new oc.BRepCheck_Analyzer(shape, true, false)).IsValid_2()
    )
      throw failed();
    // Past a curvature radius the copy of a face turns inside out yet stays valid: its mean
    // normal (as the face is oriented) points against its source's.
    const areas = tableOf(source).topology.faces.map((x) => x.area);
    for (let i = 1; i <= source.faces.Size(); i++) {
      const from = own(source.faces.FindKey(i));
      const a = outwardNormal(from, areas[i - 1]!);
      for (const face of listOf(off.Generated(from))) {
        const b = outwardNormal(face, areas[i - 1]!);
        if (a && b && a[0] * b[0] + a[1] * b[1] + a[2] * b[2] <= 0) throw failed();
      }
    }
    const result = named(shape, () => null);
    if (naming)
      for (let i = 1; i <= source.faces.Size(); i++) {
        const name = source.names[i - 1];
        if (!name) continue;
        for (const face of listOf(off.Generated(own(source.faces.FindKey(i))))) {
          const j = result.faces.FindIndex(face);
          if (j > 0 && !result.names[j - 1]) result.names[j - 1] = prefixFaceName('offset', name);
        }
      }
    // The source's named borders: each copy lies |d| from its source edge, midpoint to midpoint
    // (the simple offset keeps the parameter). Without them every border of a one-face sheet
    // has the same faces and cannot be referenced (Codex, #930).
    if (naming && source.edges?.length) {
      const free: { edge: unknown; mid: Vec3 }[] = [];
      const edgeFaces = own(new oc.TopTools_IndexedDataMapOfShapeListOfShape_1());
      oc.TopExp.MapShapesAndAncestors(
        shape,
        oc.TopAbs_ShapeEnum.TopAbs_EDGE,
        oc.TopAbs_ShapeEnum.TopAbs_FACE,
        edgeFaces,
      );
      for (let k = 1; k <= edgeFaces.Extent(); k++) {
        const edge = own(oc.TopoDS.Edge_1(own(edgeFaces.FindKey(k))));
        if (oc.BRep_Tool.Degenerated(edge) || listOf(edgeFaces.FindFromIndex(k)).length !== 1)
          continue;
        const c = networkCurve(f, edge);
        free.push({ edge, mid: c.at((c.t0 + c.t1) / 2) });
      }
      const reach = Math.max(10 * doc.kernelProfile.maxResultLinearToleranceMm, 1e-3);
      for (const { edge, name } of source.edges) {
        const c = networkCurve(f, own(oc.TopoDS.Edge_1(edge)));
        const mid = c.at((c.t0 + c.t1) / 2);
        let best: { edge: unknown; gap: number } | undefined;
        for (const x of free) {
          const gap = Math.abs(Math.hypot(...x.mid.map((v, i) => v - mid[i]!)) - Math.abs(d));
          if (gap < reach && (!best || gap < best.gap)) best = { edge: x.edge, gap };
        }
        if (best)
          (result.edges ??= []).push({ edge: best.edge, name: prefixFaceName('offset', name) });
      }
    }
    return sheetOf(result);
  }
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
    // #820: an imported body above the document's limit is placed only, never machined.
    if (f.type !== 'imported' && f.type !== 'transform')
      for (const id of f.inputFeatureIds)
        if (toleranceLimit(id) > doc.kernelProfile.maxResultLinearToleranceMm)
          throw new CadKernelError('input-tolerance', f.id);
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
      case 'spurGear': {
        // WM1a: the outline with its bore and windows as holes, extruded once (no Boolean).
        const spec = resolveSpurGear(f.args, params);
        const problem = spurGearProblem(spec);
        if (problem) throw new CadKernelError(problem.code, f.id);
        const { sketch, region } = spurGearSketch(spec, `${f.id}:gear`);
        const { face, sides } = regionFace(f, sketch, region);
        const vec = own(new oc.gp_Vec_4(0, 0, len(f.args.faceWidth)));
        const prism = own(new oc.BRepPrimAPI_MakePrism_1(face, vec, false, true));
        return place(
          sweptNames(prism, sides, true),
          f.args.orientation,
          resolvePosition(f.args.origin, params),
        );
      }
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
      case 'curveNetwork': {
        // CR1d: a Gordon surface through u- and v-curves that cross (gordon.ts works it out on
        // the curves' points), built as one cubic B-spline face named `surface`.
        const ways = (['u', 'v'] as const).map((way) =>
          f.args[way].map((c, i) => curveOf(f, c, [way, i], shapes)),
        );
        const network = ways.map((list) => list.map((c) => networkCurve(f, c.edge)));
        const tolerance = f.args.toleranceMm;
        const made = gordonSurface(network[0]!, network[1]!, tolerance, tolerance);
        if ('code' in made) {
          const paths: (string | number)[][] =
            made.code === 'curve-network-gap'
              ? [
                  ['u', made.u],
                  ['v', made.v],
                ]
              : made.code === 'curve-network-fit'
                ? [['toleranceMm']]
                : [[made.curve[0], made.curve[1]]];
          throw new CadKernelError(made.code, f.id, false, undefined, paths);
        }
        const { face, surface } = gordonFace(f, made);
        const result = named(face, () => ['surface']);
        // The four border edges are the first and last curves each way, the face's iso lines
        // v = 0 and 1 (u-curves) and u = 0 and 1 (v-curves). Each edge takes the border whose
        // iso line's midpoint is nearest its own, so a thin network keeps every name. Inner
        // curves lie on the face and are no edges.
        if (naming) {
          const borders = ways.flatMap((list) => [list[0]!, list[list.length - 1]!]);
          const P = own(new oc.gp_Pnt_1());
          const at = (u: number, v: number): Vec3 => {
            surface.get().D0(u, v, P);
            return [P.X(), P.Y(), P.Z()];
          };
          const mids = [at(0.5, 0), at(0.5, 1), at(0, 0.5), at(1, 0.5)];
          const taken = new Set<number>();
          explore(result.shape, 'TopAbs_EDGE', (edge) => {
            const e = own(oc.TopoDS.Edge_1(edge));
            if (oc.BRep_Tool.Degenerated(e)) return;
            const c = networkCurve(f, e);
            const mid = c.at((c.t0 + c.t1) / 2);
            const d = mids.map((p) => Math.hypot(p[0] - mid[0], p[1] - mid[1], p[2] - mid[2]));
            const k = d.indexOf(Math.min(...d));
            if (d[k]! > tolerance || taken.has(k)) return;
            taken.add(k);
            (result.edges ??= []).push({ edge, name: borders[k]!.boundary });
          });
        }
        return sheetOf(result);
      }
      case 'fill': {
        // A plate through the curves (BRepFill_Filling), G1 to the face beside a G1 edge and G2
        // (also the same curvature across it) beside a G2 edge (CR1b).
        const curves = f.args.boundary.map((b, i) =>
          curveOf(f, b.curve, ['boundary', i, 'curve'], shapes),
        );
        closesLoop(f, curves, 'boundary');
        const filling = own(new oc.BRepFill_Filling(3, 15, 2, false, 1e-5, 1e-4, 0.01, 0.1, 8, 9));
        f.args.boundary.forEach((b, i) => {
          const c = curves[i]!;
          if (b.continuity !== 'G0') {
            if (!c.face)
              throw new CadKernelError('fill-no-adjacent-face', f.id, false, undefined, [
                ['boundary', i, 'continuity'],
              ]);
            // The plate reads the order as the constraint's derivative count (0, 1, 2) and refuses
            // GeomAbs_G2 (enum value 3): its curvature constraint is GeomAbs_C1 (value 2).
            const order =
              b.continuity === 'G2' ? oc.GeomAbs_Shape.GeomAbs_C1 : oc.GeomAbs_Shape.GeomAbs_G1;
            filling.Add_2(c.edge, c.face, order, true);
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
              b.continuity !== 'G0' ? [['boundary', i, 'continuity']] : [],
            ),
          );
        const made = own(filling.Face());
        // G2 is checked as the continuity check does it (cadContinuity.g2Relative): the plate's
        // own G2 error is a curvature difference without a reference, so samples along each G2
        // side compare the fill's normal curvature across it with the face beside it.
        const unreached = f.args.boundary.flatMap((b, i) =>
          b.continuity === 'G2' && !fillMeetsG2(made, curves[i]!.edge, curves[i]!.face)
            ? [['boundary', i, 'continuity'] as (string | number)[]]
            : [],
        );
        if (unreached.length)
          throw new CadKernelError('fill-g2-unreached', f.id, false, undefined, unreached);
        const result = named(made, () => ['surface']);
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
      case 'profileSweep':
        return profileSweep(f);
      case 'offsetSurface':
        return offsetSurface(f, shapes);
      case 'trim':
      case 'panel':
        return trim(f, shapes);
      case 'split':
        return split(f, shapes);
      case 'pressLine':
        return pressLine(f, shapes);
      case 'groove':
        return groove(f, shapes);
      case 'flare':
        return flare(f, shapes);
      case 'flange':
        return flange(f, shapes);
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
          // PMI-2: the kept PMI must name sub-shapes of this BRep and datums of its own asset.
          if (f.args.pmiAssetId !== undefined) checkPmi(f, shape);
          // An imported body has no recipe to name its faces by; R1 features cannot reference it.
          const body = named(shape, () => null);
          // PMI-4a: each sub-shape its PMI may target is followed through the later features.
          if (f.args.pmiAssetId !== undefined && naming)
            body.origins = Object.fromEntries(
              pmiKinds.map((kind) => [
                kind,
                Array.from({ length: shapeMap(shape, kind).Size() }, (_, i) => ({
                  feature: f.id,
                  index: i + 1,
                  exact: true,
                })),
              ]),
            ) as PmiOrigins;
          return body;
        } finally {
          if (oc.FS.analyzePath(path).exists) oc.FS.unlink(path);
        }
      }
      case 'boolean': {
        const [target, ...tools] = f.inputFeatureIds.map((i) => shapes.get(i)!);
        // Tool faces are prefixed with the tool's feature ID (Booleanのtoolの名前).
        const build = () =>
          combine(
            f.id,
            f.args.mode,
            target!,
            tools,
            tools.map((_, k) => `tool:${f.inputFeatureIds[k + 1]}`),
          );
        if (f.args.mode !== 'cut') return build();
        // A tool that only touches the target (or misses it) cuts nothing: a degenerate Boolean
        // (F04) that would still consume the tool. Their common part has no solid then, however
        // small a genuine cut is. Union and common report it as several solids or an empty result.
        // The common part is a second Boolean as costly as the cut (SC-6: 13–17 s each on a
        // smooth loft), so a single tool whose cut takes out over 1% of the target is taken as
        // overlapping without it. A smaller result or a failed cut checks the tool as before.
        // Several tools are checked before the cut, as before: a missing one is refused without
        // the all-tools Boolean. A tool that cuts nothing is still refused by its own code.
        const check = () => {
          for (const tool of tools)
            if (!overlaps(target!, tool)) throw new CadKernelError('boolean-no-overlap', f.id);
        };
        if (tools.length !== 1) {
          check();
          return build();
        }
        let result: Named | undefined;
        let failure: unknown;
        try {
          result = build();
        } catch (error) {
          failure = error;
        }
        if (!(result && volume(result.shape) < 0.99 * volume(target!.shape))) check();
        if (!result) throw failure;
        return result;
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
        // CR6d: a linear grid repeats the row; copy `row × n + i` is copy i of that row.
        const rows = l.type === 'linear' && l.rows ? resolveCount(l.rows.count, params) : 1;
        for (let k = 0; k < n * rows; k++) {
          const [i, row] = [k % n, Math.floor(k / n)];
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
            const e = l.rows ? len(l.rows.spacing) * row : 0;
            const across = l.rows?.direction ?? [0, 0, 0];
            trsf.SetTranslation_1(
              own(new oc.gp_Vec_4(...l.direction.map((x, a) => x * d + across[a]! * e))),
            );
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
        // Copy i's faces are `copy:<pattern ID>:<i>/…` (命名), from the layout alone. A grid's
        // copy i of row r ≥ 1 is `copy:<pattern ID>:<i>:row<r>`, so its name keeps to the same
        // place when the count along a row changes (row 0 keeps the single row's names).
        const prefixes = copies.map((_, k) => {
          const [i, row] = [k % n, Math.floor(k / n)];
          return row ? `copy:${f.id}:${i}:row${row}` : `copy:${f.id}:${i}`;
        });
        return combine(f.id, f.args.mode, target!, copies, prefixes);
      }
      case 'mirrorCopy': {
        // CR4b: the source reflected as a new body; the source stays (not an input).
        const input = shapes.get(f.args.source.featureId)!;
        const { origin, normal } = f.args.plane;
        const trsf = own(new oc.gp_Trsf_1());
        trsf.SetMirror_3(
          own(
            new oc.gp_Ax2_3(
              pnt(...(resolvePosition(origin, params) as Vec3)),
              own(new oc.gp_Dir_4(...normal)),
            ),
          ),
        );
        const builder = own(new oc.BRepBuilderAPI_Transform_2(input.shape, trsf, true));
        return carry(
          own(builder.Shape()),
          input,
          (face) => [own(builder.ModifiedShape(face))],
          (name) => prefixFaceName(`mirror:${f.id}`, name),
        );
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
          // CR1e: an edge of a sheet needs a face on both sides; a free border has one.
          const free = edges.filter((_, i) => table.topology.edges[found[i]!]!.faces.length < 2);
          if (free.length)
            throw new CadKernelError(
              'fillet-free-edge',
              f.id,
              false,
              undefined,
              free.map((e) => e.path),
            );
          const r = len(f.args.radius);
          const { radiusEnd, radii } = f.args;
          if (radii && radiusEnd) {
            // 2–8 radii along each edge: (0, radius), the points between, (1, radiusEnd).
            const law = [[0, r], ...radii.map((p) => [p.at, len(p.radius)]), [1, len(radiusEnd)]];
            const array = own(new oc.TColgp_Array1OfPnt2d_2(1, law.length));
            law.forEach(([u, R], i) => array.SetValue(i + 1, own(new oc.gp_Pnt2d_3(u!, R!))));
            for (const e of edges) op.Add_5(array, e.shape);
          } else if (radiusEnd) {
            const r2 = len(radiusEnd);
            for (const e of edges) op.Add_3(r, r2, e.shape);
          } else for (const e of edges) op.Add_2(r, e.shape);
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
    /** An edge's index in the table (its edge → face map), or -1. */
    const edgeIndex = (e: unknown) => ancestors.FindIndex(e) - 1;
    return { topology, edge, face, edgeIndex };
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
    /** Each face's triangulation, for its texture coordinates (#662). */
    const textured: { face: unknown; tri: OcModule; offset: number }[] = [];
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
      textured.push({ face: topoFace, tri, offset });
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
    const uvs = new Float32Array((pos.length / 3) * 2);
    for (const t of textured)
      faceTextureUvs(oc, own, t.face, t.tri, positions, origin, uvs, t.offset);
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
      uvs,
      indices: new Uint32Array(indices),
      faceIds: new Uint32Array(faceIds),
      vertices: new Float64Array([...vertices.values()].flat()),
      faceBase: base.faces,
      edgeBase: base.edges,
      edges: new Float32Array(edgePoints),
      edgeIds: new Uint32Array(edgeIds),
      topology,
      ...(curvatures ? { curvature: curvatures } : {}),
      ...(body.origins ? { pmi: pmiTracking(body) } : {}),
    };
  }
  /**
   * PMI-4a: for each import a body's sub-shapes come from, the imported faces, edges and
   * vertices the body still has exactly once and unchanged, with their index in its topology
   * table. A sub-shape that is gone, changed, or there twice (copies) is left out. With
   * `shapeIndices` (PMI-4b, the STEP writer), the index is the 1-based one in
   * `TopExp::MapShapes` of the body's shape of each kind instead.
   */
  function pmiTracking(body: Named, shapeIndices = false): CadPmiTracking[] {
    const edgeIndex = shapeIndices ? undefined : tableOf(body).edgeIndex;
    const out = new Map<string, CadPmiTracking>();
    const fields = {
      TopAbs_FACE: 'faces',
      TopAbs_EDGE: 'edges',
      TopAbs_VERTEX: 'vertices',
    } as const;
    for (const kind of pmiKinds) {
      const list = body.origins![kind];
      const map = kind === 'TopAbs_EDGE' && !shapeIndices ? shapeMap(body.shape, kind) : undefined;
      /** Each origin's table index, or -1 once it is seen twice or inexactly. */
      const found = new Map<string, Map<number, number>>();
      list.forEach((origin, j) => {
        if (!origin) return;
        const of = found.get(origin.feature) ?? new Map<number, number>();
        found.set(origin.feature, of);
        const index = !origin.exact
          ? -1
          : shapeIndices
            ? j + 1
            : kind === 'TopAbs_EDGE'
              ? edgeIndex!(own(map!.FindKey(j + 1)))
              : j;
        of.set(origin.index, of.has(origin.index) || index < 0 ? -1 : index);
      });
      for (const [feature, of] of found) {
        const t =
          out.get(feature) ??
          out
            .set(feature, { featureId: feature, faces: [], edges: [], vertices: [] })
            .get(feature)!;
        for (const [index, at] of [...of].sort((a, b) => a[0] - b[0]))
          if (at >= 0) t[fields[kind]].push(index, at);
      }
    }
    return [...out.values()];
  }

  /**
   * PMI-4b/4c (docs/cad/pmi.md, 書き出し): the `OCJS.addPmi` lines of each body for its STEP and
   * what is and is not written, or undefined when no body carries PMI. A body's items are
   * written when they are current on it (`cadPmiItemStates` over its own tracking), on the
   * body's own sub-shapes; with several PMI imports in a body, or a build without the writer,
   * none are.
   */
  function stepPmiOf(bodies: { id: string; final: Named }[]):
    | {
        bodies: { id: string; shape: unknown; pmi: string[] }[];
        report: CadStepPmiWritten;
      }
    | undefined {
    const report = noPmiWritten();
    let any = false;
    /** Datum names already written: the writer merges datums by name across the file. */
    const datumNames = new Set<string>();
    const out = bodies.map(({ id, final }) => {
      const body = { id, shape: final.shape, pmi: [] as string[] };
      const state = cadBodyPmi(doc, id);
      if (state.status === 'none') return body;
      /** The kept asset of one import, undefined when it does not read. */
      const assetOf = (featureId: string, assetId: string) => {
        const g = doc.features.find((h) => h.id === featureId);
        return g?.type === 'imported' ? readCadPmiAsset(assetBytes(g, assetId)) : undefined;
      };
      if (state.status === 'stale') {
        // Every import's PMI is left out; an asset two imports share counts once.
        const seen = new Set<string>();
        for (const i of state.imports) {
          if (seen.has(i.assetId)) continue;
          seen.add(i.assetId);
          const asset = assetOf(i.featureId, i.assetId);
          if (!asset) continue;
          any = true;
          report.stale += asset.items.length;
          report.views += asset.views?.length ?? 0;
        }
        return body;
      }
      const f = doc.features.find((g) => g.id === state.featureId);
      if (f?.type !== 'imported') return body;
      const asset = assetOf(f.id, state.assetId);
      if (!asset) return body;
      any = true;
      if (typeof oc.OCJS?.addPmi !== 'function') {
        report.unsupportedBuild += asset.items.length;
        report.views += asset.views?.length ?? 0;
        return body;
      }
      const tracking = final.origins
        ? pmiTracking(final).find((t) => t.featureId === f.id)
        : undefined;
      const states = cadPmiItemStates(asset, tracking);
      const written = final.origins
        ? pmiTracking(final, true).find((t) => t.featureId === f.id)
        : undefined;
      body.pmi = pmiWriteSpec(
        asset,
        states,
        {
          face: oc.TopAbs_ShapeEnum.TopAbs_FACE.value,
          edge: oc.TopAbs_ShapeEnum.TopAbs_EDGE.value,
          vertex: oc.TopAbs_ShapeEnum.TopAbs_VERTEX.value,
        },
        (t) => (written ? cadPmiTrackedIndex(written, t) : undefined),
        cadBodyPmiPlacements(doc, id),
        report,
        datumNames,
      );
      return body;
    });
    return any ? { bodies: out, report } : undefined;
  }

  /**
   * R3c-2a: the boundary of a body as the analysis mesher takes it (docs/cad/r3-analysis.md): one
   * triangulation at `deflectionMm`, in Float64 and world coordinates, each triangle tagged with
   * its face (topology table order), and each edge's chain of points (its polygon on the first
   * face's triangulation). Nodes the faces share along an edge are the same computed points of
   * that edge's discretisation and are joined by identity of their coordinates; every edge's
   * polygon on each of its faces is then checked to land on the same joined nodes, so a chain
   * never depends on nearness. A body that does not join up is refused, never repaired.
   */
  function analysisSurfaceOf(
    body: Named,
    deflectionMm: number,
    angularRad: number,
    sizing: SurfaceSizing & { minEdgeMm?: number },
    preparation: CadAnalysisPreparation | undefined,
    /** R3i-2: the midsurface in place of the body (`midsurfaceOf`); no preparation then. */
    idealised?: Midsurface,
  ): CadAnalysisSurface {
    // The display triangulation is removed first and this one after, as for the coarse mesh, so a
    // later evaluation that keeps the shape never reads the analysis triangulation.
    oc.BRepTools.Clean(body.shape, true);
    let prepared: { body: Named; history: CadPreparationHistory } | undefined;
    try {
      prepared = idealised ?? prepareAnalysisBody(body, deflectionMm, angularRad, preparation);
      const shape = prepared.body.shape;
      if (shape !== body.shape) oc.BRepTools.Clean(shape, true);
      own(new oc.BRepMesh_IncrementalMesh_2(shape, deflectionMm, false, angularRad, false));
      const raw = rawAnalysisSurface(prepared.body);
      // A body face's size applies to every analysis face it became; the smallest wins.
      const faces = new Map<number, number>();
      for (const [face, size] of sizing.faces ?? [])
        for (const image of prepared.history.faces[face]?.images ?? [])
          faces.set(image, Math.min(size, faces.get(image) ?? Infinity));
      try {
        improveSurface(raw, { ...sizing, faces });
      } catch (error) {
        if (error instanceof AnalysisSurfaceLimit)
          throw new CadKernelError('analysis-surface-limit');
        throw error;
      }
      return {
        ...finishSurface(raw),
        history: prepared.history,
        measures: analysisMeasures(prepared.body),
        bodyTopology: tableOf(body).topology,
        ...(idealised ? { shell: { thicknessMm: idealised.thicknessMm } } : {}),
      };
    } finally {
      oc.BRepTools.Clean(body.shape, true);
      if (prepared && prepared.body.shape !== body.shape)
        oc.BRepTools.Clean(prepared.body.shape, true);
    }
  }
  /**
   * R3i-2 (docs/cad/r3-analysis.md, A3): the midsurface of a body of uniform thickness, from the
   * feature that made it, read on the body's own shape (so a placement moves it too). The feature
   * after any placements must be a `thicken`, a `shell` or an `extrude`:
   * - the wall faces are the faces X whose `inner/X` is also a face (`thicken`, `shell`), or the
   *   `start` face whose `end` is the other cap (`extrude`);
   * - the midsurface is the wall faces offset by half the thickness into the solid;
   * - each wall face and its partner (`reversed`: it faces the other way) become the wall face's
   *   offset; every other face (a thicken's
   *   side, a shell's rim at an open face, an extrude's sides) becomes the midsurface edges it
   *   runs along, and an edge becomes the midsurface edges it lies at half the thickness from.
   * Anything else is refused (`midsurface-unsupported`, with the reason): another feature, a wall
   * face without its partner, a side along no midsurface edge, a failed offset, a wall thicker
   * than a tenth of the midsurface's size.
   */
  function midsurfaceOf(body: Named, bodyId: string): Midsurface {
    const refuse = (detail: string) => new MidsurfaceRefusal(detail);
    const own3 = doc.bodies.find((b) => b.id === bodyId);
    let f = own3 && doc.features.find((x) => x.id === own3.resultFeatureId);
    while (f?.type === 'transform') {
      const input = f.inputFeatureIds[0];
      f = doc.features.find((x) => x.id === input);
    }
    if (!f || (f.type !== 'thicken' && f.type !== 'shell' && f.type !== 'extrude'))
      throw refuse(
        `the body is made by ${f ? `a ${f.type}` : 'nothing'}, not a thicken, shell or extrude`,
      );
    const t = len(f.type === 'extrude' ? f.args.distance : f.args.thickness);
    const { topology, edge: edgeOf, face: faceOf } = tableOf(body);
    const key = (n: CadFaceName | null) => (n ? JSON.stringify(n) : '');
    const byName = new Map<string, number>();
    body.names.forEach((n, i) => {
      if (n) byName.set(key(n), byName.has(key(n)) ? -1 : i);
    });
    /** Wall face → its partner on the other side of the wall. */
    const partner = new Map<number, number>();
    if (f.type === 'extrude') {
      const start = byName.get(key(['start'])),
        end = byName.get(key(['end']));
      if (start === undefined || end === undefined || start < 0 || end < 0)
        throw refuse('the extrude has no single start and end face');
      partner.set(start, end);
    } else
      body.names.forEach((n, i) => {
        const j = n ? byName.get(key(['inner', ...n])) : undefined;
        if (j !== undefined && j >= 0 && byName.get(key(n)) === i) partner.set(i, j);
      });
    if (!partner.size) throw refuse(`the ${f.type} has no wall faces with a partner`);
    const partners = new Set(partner.values());

    // The wall faces as one shell, oriented as on the solid, offset half the thickness inwards.
    const builder = own(new oc.BRep_Builder());
    const shell = own(new oc.TopoDS_Shell());
    builder.MakeShell(shell);
    for (const i of partner.keys()) builder.Add(shell, faceOf(i));
    // Faces meeting at an angle (a shell's box) need joined offsets; smooth ones (a thickened
    // skin) offset alike either way. The simple offset is the fallback.
    const freeEdges = (n: Named) =>
      tableOf(n).topology.edges.filter((e) => e.faces.length === 1).length;
    const wall = named(shell, () => null);
    const offsetBy = (join: boolean) => {
      const op = own(new oc.BRepOffsetAPI_MakeOffsetShape());
      if (join)
        op.PerformByJoin(
          shell,
          -t / 2,
          doc.kernelProfile.linearToleranceMm,
          oc.BRepOffset_Mode.BRepOffset_Skin,
          false,
          false,
          oc.GeomAbs_JoinType.GeomAbs_Intersection,
          false,
          own(new oc.Message_ProgressRange_1()),
        );
      else {
        op.PerformBySimple(shell, -t / 2);
        op.Build(own(new oc.Message_ProgressRange_1()));
      }
      if (!op.IsDone()) return undefined;
      const out = named(own(op.Shape()), () => null);
      // The same faces, joined as the wall's are: no gap opened between two of them.
      return out.faces.Size() === wall.faces.Size() && freeEdges(out) === freeEdges(wall)
        ? { op, out }
        : undefined;
    };
    const made = offsetBy(true) ?? offsetBy(false);
    if (!made)
      throw refuse('the kernel could not offset the wall faces into one joined midsurface');
    const off = made.op;
    const mid = made.out;
    const faceImages = new Map<number, number>();
    for (const i of partner.keys()) {
      const made = listOf(off.Generated(faceOf(i)));
      const j = made.length === 1 ? mid.faces.FindIndex(made[0]) : 0;
      if (j < 1) throw refuse(`wall face ${i} has no single offset`);
      faceImages.set(i, j - 1);
      faceImages.set(partner.get(i)!, j - 1);
      mid.names[j - 1] = body.names[i] ?? null;
    }
    const midTable = tableOf(mid);
    const [lo, hi] = boundsOf(mid.shape);
    const size = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    if (!(t <= size / 10))
      throw refuse(
        `the wall is ${t} mm thick, more than a tenth of its ${size.toFixed(3)} mm size`,
      );

    // Edges by where they lie: a body edge is a midsurface edge's image when every sample of
    // each lies at half the thickness (an edge between two walls) from the other's polyline.
    /** An edge's curve on its parameter range [0, 1], or nothing for a degenerated edge. */
    const curveOf = (edge: unknown): ((u: number) => Vec3) | undefined => {
      if (oc.BRep_Tool.Degenerated(edge)) return undefined;
      const handle = own(oc.BRep_Tool.Curve_2(edge, 0, 0));
      if (handle.IsNull()) return undefined;
      const curve = handle.get();
      const first = own(new oc.TopoDS_Vertex());
      const last = own(new oc.TopoDS_Vertex());
      oc.TopExp.Vertices_1(edge, first, last, false);
      const a = oc.BRep_Tool.Parameter_2(first, edge) as number;
      let b = oc.BRep_Tool.Parameter_2(last, edge) as number;
      if (b === a && curve.IsPeriodic()) b = a + (curve.Period() as number);
      const P = own(new oc.gp_Pnt_1());
      return (u) => {
        curve.D0(a + (b - a) * u, P);
        return [P.X(), P.Y(), P.Z()];
      };
    };
    const fine = 33;
    type Sampled = { at: (u: number) => Vec3; line: Vec3[]; length: number };
    const sampled = (edge: unknown): Sampled | undefined => {
      const at = curveOf(edge);
      if (!at) return undefined;
      const line = Array.from({ length: fine }, (_, k) => at(k / (fine - 1)));
      let length = 0;
      for (let k = 1; k < fine; k++)
        length += Math.hypot(
          line[k]![0] - line[k - 1]![0],
          line[k]![1] - line[k - 1]![1],
          line[k]![2] - line[k - 1]![2],
        );
      return { at, line, length };
    };
    const dist = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    /**
     * A point's distance from a curve itself, not its polyline: from the nearest sample, a golden
     * section search over the parameter between its neighbours, to well below the tolerance.
     */
    const toCurve = (p: Vec3, c: Sampled) => {
      let k = 0;
      for (let j = 1; j < fine; j++) if (dist(p, c.line[j]!) < dist(p, c.line[k]!)) k = j;
      // A closed curve's ends are one point: search on both sides of it.
      if ((k === 0 || k === fine - 1) && dist(c.line[0]!, c.line[fine - 1]!) <= tolerance)
        return Math.min(nearOn(p, c, 0), nearOn(p, c, fine - 1));
      return nearOn(p, c, k);
    };
    const nearOn = (p: Vec3, c: Sampled, k: number) => {
      let lo = Math.max(0, k - 1) / (fine - 1);
      let hi = Math.min(fine - 1, k + 1) / (fine - 1);
      const g = (Math.sqrt(5) - 1) / 2;
      let x1 = hi - g * (hi - lo);
      let x2 = lo + g * (hi - lo);
      let f1 = dist(p, c.at(x1));
      let f2 = dist(p, c.at(x2));
      for (let i = 0; i < 60 && hi - lo > 1e-12; i++) {
        if (f1 <= f2) {
          hi = x2;
          x2 = x1;
          f2 = f1;
          x1 = hi - g * (hi - lo);
          f1 = dist(p, c.at(x1));
        } else {
          lo = x1;
          x1 = x2;
          f1 = f2;
          x2 = lo + g * (hi - lo);
          f2 = dist(p, c.at(x2));
        }
      }
      return Math.min(f1, f2, dist(p, c.line[k]!));
    };
    const midLines = midTable.topology.edges.map((_, k) => sampled(midTable.edge(k)));
    const tolerance = Math.max(1e-4 * t, 10 * doc.kernelProfile.maxResultLinearToleranceMm);
    /**
     * Two edges at half the thickness from each other over their overlap: the shorter's probes,
     * measured to the longer curve itself. A rim edge is trimmed at the corners by up to the
     * thickness (the outer one longer, the inner shorter than the midsurface's), so the longer
     * one's end probes may fall past the shorter's ends.
     */
    const atHalf = (line: Sampled, ml: Sampled) => {
      const [short, long] = line.length <= ml.length ? [line, ml] : [ml, line];
      return [short.line[4]!, short.line[16]!, short.line[28]!].every(
        (p) => Math.abs(toCurve(p, long) - t / 2) <= tolerance,
      );
    };
    const midFaces = midTable.topology.edges.map((m) =>
      [...new Set(m.faces)].sort((x, y) => x - y),
    );
    const same = (a: number[], b: number[]) =>
      a.length === b.length && a.every((x, i) => x === b[i]);
    const edgeImages = topology.edges.map((edge, e) => {
      const line = sampled(edgeOf(e));
      if (!line) return [];
      const walls = edge.faces.map((f) => faceImages.get(f));
      const images = [...new Set(walls.filter((x) => x !== undefined))].sort((x, y) => x - y);
      if (!images.length) return []; // between two sides: through the wall, at a corner
      const candidates = midFaces
        .map((faces, k) => ({ faces, k }))
        .filter(({ faces }) => same(faces, images))
        .map(({ k }) => k);
      if (walls.every((x) => x !== undefined)) {
        // Between two walls (a crease, where the offsets meet at more than half the thickness
        // from the edge) or a seam of one: the midsurface edge between their images; where
        // there are several, those at half the thickness.
        if (candidates.length <= 1) return candidates;
        return candidates.filter((k) => midLines[k] && atHalf(line, midLines[k]));
      }
      // Between a side and a wall: the wall's free midsurface edges along it.
      return candidates.filter((k) => midLines[k] && atHalf(line, midLines[k]));
    });
    const history: CadPreparationHistory = {
      faces: topology.faces.map((_, i) => {
        const image = faceImages.get(i);
        // The partner faces the other way: a pressure on it pushes along the midsurface normal.
        if (image !== undefined)
          return {
            deleted: false,
            images: [image],
            ...(partners.has(i) ? { reversed: true } : {}),
          };
        // A side: the midsurface edges its own edges became.
        const edges = [
          ...new Set(topology.edges.flatMap((e, k) => (e.faces.includes(i) ? edgeImages[k]! : []))),
        ].sort((a, b) => a - b);
        if (!edges.length) throw refuse(`face ${i} is neither a wall nor along a midsurface edge`);
        return { deleted: true, images: [], edges };
      }),
      edges: edgeImages.map((images) => ({ deleted: images.length === 0, images })),
      analysisFaces: mid.faces.Size(),
      analysisEdges: midTable.topology.edges.length,
      removed: [],
    };
    return { body: mid, history, thicknessMm: t };
  }
  /**
   * CR5e: a sheet as its own midsurface at `thicknessMm` (0 < t ≤ 100 mm): every face and edge
   * its own analysis face and edge. Refused without a thickness (`midsurface-unsupported`).
   */
  function sheetMidsurface(body: Named, thicknessMm: number | undefined): Midsurface {
    if (!(thicknessMm! > 0 && thicknessMm! <= 100))
      throw new MidsurfaceRefusal(
        `a sheet is analysed as a shell of a given thickness (0–100 mm), not ${thicknessMm ?? 'none'}`,
      );
    // A thin shell, as a thickened solid's midsurface must be (Codex on #977).
    const [lo, hi] = boundsOf(body.shape);
    const size = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    if (!(thicknessMm! <= size / 10))
      throw new MidsurfaceRefusal(
        `the sheet is ${thicknessMm} mm thick, more than a tenth of its ${size.toFixed(3)} mm size`,
      );
    const { topology } = tableOf(body);
    const one = (_: unknown, i: number) => ({ deleted: false, images: [i] });
    return {
      body,
      history: {
        faces: topology.faces.map(one),
        edges: topology.edges.map(one),
        analysisFaces: topology.faces.length,
        analysisEdges: topology.edges.length,
        removed: [],
      },
      thicknessMm: thicknessMm!,
    };
  }
  /**
   * R3c-2b (docs/cad/r3-analysis.md, 形状準備): the body with the faces the settings select
   * removed by `BRepAlgoAPI_Defeaturing`, and the kernel's history of every face and edge. The
   * faces are chosen from their own surfaces (`preparationFaces`), sampled on a triangulation at
   * the analysis deflection. Removing nothing gives the body itself and the identity history. A
   * removal the kernel cannot make, or one that leaves an invalid solid, is refused
   * (`analysis-preparation-failed`), never repaired.
   */
  function prepareAnalysisBody(
    body: Named,
    deflectionMm: number,
    angularRad: number,
    preparation: CadAnalysisPreparation | undefined,
  ): { body: Named; history: CadPreparationHistory } {
    const { topology, edge: edgeOf, face: faceOf } = tableOf(body);
    const identity = (): CadPreparationHistory => ({
      faces: topology.faces.map((_, i) => ({ deleted: false, images: [i] })),
      edges: topology.edges.map((_, i) => ({ deleted: false, images: [i] })),
      analysisFaces: topology.faces.length,
      analysisEdges: topology.edges.length,
      removed: [],
    });
    if (
      !preparation ||
      (preparation.removeHolesBelow === null &&
        preparation.removeFilletsBelow === null &&
        preparation.removeFaces.length === 0)
    )
      return { body, history: identity() };
    own(new oc.BRepMesh_IncrementalMesh_2(body.shape, deflectionMm, false, angularRad, false));
    let remove: number[];
    try {
      const [lo, hi] = boundsOf(body.shape);
      const tolerance = Math.max(
        1e-6 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]),
        1e-9,
      );
      const samples = topology.faces.map((_, i) => faceSample(faceOf(i)));
      remove = preparationFaces(samples, topology.edges, preparation, tolerance);
    } finally {
      oc.BRepTools.Clean(body.shape, true);
    }
    if (remove.length === 0) return { body, history: identity() };
    if (remove.length === topology.faces.length)
      throw new CadKernelError('analysis-preparation-failed', 'every face removed');
    const op = own(new oc.BRepAlgoAPI_Defeaturing());
    op.SetShape(body.shape);
    for (const i of remove) op.AddFaceToRemove(faceOf(i));
    op.SetRunParallel(false);
    op.SetToFillHistory(true);
    op.Build(own(new oc.Message_ProgressRange_1()));
    if (!op.IsDone() || op.HasErrors())
      throw new CadKernelError('analysis-preparation-failed', 'defeaturing');
    // The kernel gives the input back, with a warning only, when it cannot remove the faces.
    if (remove.some((i) => !op.IsDeleted(faceOf(i))))
      throw new CadKernelError('analysis-preparation-failed', 'faces not removed');
    const shape = own(op.Shape());
    const solids = shapeMap(shape, 'TopAbs_SOLID');
    if (solids.Size() !== 1 || !own(new oc.BRepCheck_Analyzer(shape, true, false)).IsValid_2())
      throw new CadKernelError('analysis-preparation-failed', 'result is not one valid solid');
    const out = named(shape, () => null);
    const outEdges = own(new oc.TopTools_IndexedDataMapOfShapeListOfShape_1());
    oc.TopExp.MapShapesAndAncestors(
      shape,
      oc.TopAbs_ShapeEnum.TopAbs_EDGE,
      oc.TopAbs_ShapeEnum.TopAbs_FACE,
      outEdges,
    );
    const track = (element: unknown, index: (s: unknown) => number) => {
      if (op.IsDeleted(element)) return { deleted: true, images: [] };
      const made = listOf(op.Modified(element));
      const images = [
        ...new Set((made.length ? made : [element]).map((s) => index(s) - 1).filter((i) => i >= 0)),
      ].sort((a, b) => a - b);
      return { deleted: images.length === 0, images };
    };
    return {
      body: out,
      history: {
        faces: topology.faces.map((_, i) => track(faceOf(i), (s) => out.faces.FindIndex(s))),
        edges: topology.edges.map((_, i) => track(edgeOf(i), (s) => outEdges.FindIndex(s))),
        analysisFaces: out.faces.Size(),
        analysisEdges: outEdges.Size(),
        removed: remove,
      },
    };
  }
  /**
   * R3e-2: the analysis shape's exact measures (docs/cad/r3-analysis.md, 荷重の適用の検査). Face
   * areas by `BRepGProp` with an error bound (the fixed-order rule is off by percents on a face
   * bounded by a many-span spline). A face's vector area is ½ ∮ r × dr round its edges as the
   * explorer gives them for the face's own orientation (outward on a solid; a seam is walked both
   * ways and cancels), and an edge's length ∫ |r′| dt, both by adaptive Gauss–Legendre on the
   * edge's curve: pieces are halved until the halves agree with the whole within a share of the
   * integral of a bound on the integrand (so cancelling edges stop at roundoff), starting from the curve's knot spans (#799 review); out of budget, the measures are refused.
   */
  function analysisMeasures(body: Named): CadAnalysisMeasures {
    const { topology, edge: edgeOf } = tableOf(body);
    const P = own(new oc.gp_Pnt_1());
    const V = own(new oc.gp_Vec_1());
    const gx = [-0.906179845938664, -0.5384693101056831, 0, 0.5384693101056831, 0.906179845938664];
    const gw = [
      0.2369268850561891, 0.4786286704993665, 0.5688888888888889, 0.4786286704993665,
      0.2369268850561891,
    ];
    /** An edge's curve and its own range, read from its vertices in the curve's direction. */
    const curveOf = (edge: unknown) => {
      if (oc.BRep_Tool.Degenerated(edge)) return undefined;
      const handle = own(oc.BRep_Tool.Curve_2(edge, 0, 0));
      if (handle.IsNull()) return undefined;
      const curve = handle.get();
      const first = own(oc.TopExp.FirstVertex(edge, false)) as { IsSame(o: unknown): boolean };
      const last = own(oc.TopExp.LastVertex(edge, false));
      let [a, b] = [
        oc.BRep_Tool.Parameter_2(first, edge) as number,
        oc.BRep_Tool.Parameter_2(last, edge) as number,
      ];
      // A closed edge (one vertex at both ends) may read its ends either way round: it runs
      // forward from the smaller, over a whole period when both read the same.
      if (first.IsSame(last)) {
        [a, b] = [Math.min(a, b), Math.max(a, b)];
        if (!(b > a) && curve.IsPeriodic()) b = a + (curve.Period() as number);
      }
      const spans = knotBreaks(curve, a, b);
      return { curve, a, b, spans };
    };
    /**
     * ∫ f(r, r′) dt over [a, b], adaptively from two pieces per smooth span. f gives `n`
     * components and then a bound on their size at that point (|r| |r′| for r × r′, |r′| for the
     * length): the tolerance is a share of the bound's integral, so a result that cancels to zero
     * (a line through the origin) stops at roundoff. The work is bounded; a piece that has not
     * converged when it runs out refuses the measures (`analysis-measures-failed`) rather than
     * giving an approximation as exact.
     */
    const integrate = (
      c: { curve: OcModule; a: number; b: number; spans: number[] },
      n: number,
      f: (r: Vec3, d: Vec3) => number[],
    ): number[] => {
      let budget = 4096 + 256 * c.spans.length;
      const rule = (lo: number, hi: number) => {
        budget--;
        const out = new Array<number>(n + 1).fill(0);
        const h = hi - lo;
        for (let g = 0; g < 5; g++) {
          c.curve.D1(lo + h * (0.5 + gx[g]! / 2), P, V);
          const v = f([P.X(), P.Y(), P.Z()], [V.X(), V.Y(), V.Z()]);
          for (let k = 0; k <= n; k++) out[k]! += (gw[g]! * h * v[k]!) / 2;
        }
        return out;
      };
      const starts: [number, number][] = [];
      for (let i = 1; i < c.spans.length; i++) {
        const [lo, hi] = [c.spans[i - 1]!, c.spans[i]!];
        starts.push([lo, (lo + hi) / 2], [(lo + hi) / 2, hi]);
      }
      const first = starts.map(([lo, hi]) => rule(lo, hi));
      const tol =
        1e-12 *
        Math.max(
          first.reduce((t, v) => t + Math.abs(v[n]!), 0),
          1e-300,
        );
      const adapt = (lo: number, hi: number, whole: number[], depth: number): number[] => {
        const mid = (lo + hi) / 2;
        const [l, r] = [rule(lo, mid), rule(mid, hi)];
        const halves = whole.map((_, k) => l[k]! + r[k]!);
        const err = Math.hypot(...halves.slice(0, n).map((x, k) => x - whole[k]!));
        if (err <= (tol * (hi - lo)) / (c.b - c.a) || depth >= 40) return halves;
        if (budget < 2) throw new CadKernelError('analysis-measures-failed', 'integration budget');
        const a = adapt(lo, mid, l, depth + 1);
        const b = adapt(mid, hi, r, depth + 1);
        return a.map((x, k) => x + b[k]!);
      };
      const out = new Array<number>(n).fill(0);
      first.forEach((whole, k) => {
        if (budget < 2) throw new CadKernelError('analysis-measures-failed', 'integration budget');
        const part = adapt(starts[k]![0], starts[k]![1], whole, 0);
        for (let j = 0; j < n; j++) out[j]! += part[j]!;
      });
      return out;
    };
    const faceAreas = new Float64Array(topology.faces.length);
    const faceVectorAreas = new Float64Array(topology.faces.length * 3);
    for (let i = 0; i < topology.faces.length; i++) {
      const face = own(oc.TopoDS.Face_1(own(body.faces.FindKey(i + 1))));
      const props = own(new oc.GProp_GProps_1());
      oc.BRepGProp.SurfaceProperties_2(face, props, 1e-9, false);
      faceAreas[i] = props.Mass() as number;
      const sum: Vec3 = [0, 0, 0];
      explore(face, 'TopAbs_EDGE', (current) => {
        const edge = own(oc.TopoDS.Edge_1(current));
        const c = curveOf(edge);
        if (!c) return;
        const sign =
          (edge as { Orientation_1(): unknown }).Orientation_1() ===
          oc.TopAbs_Orientation.TopAbs_REVERSED
            ? -1
            : 1;
        const part = integrate(c, 3, (r, d) => [
          ...crossV(r, d),
          Math.hypot(...r) * Math.hypot(...d),
        ]);
        for (let d = 0; d < 3; d++) sum[d]! += (sign * part[d]!) / 2;
      });
      faceVectorAreas.set(sum, 3 * i);
    }
    const edgeLengths = Float64Array.from(topology.edges, (_, i) => {
      const c = curveOf(edgeOf(i));
      return c ? integrate(c, 1, (_r, d) => [Math.hypot(...d), Math.hypot(...d)])[0]! : 0;
    });
    return { faceAreas, faceVectorAreas, edgeLengths };
  }
  /** What `preparationFaces` needs of one face, read from its surface and triangulation. */
  function faceSample(face: unknown): FaceSample {
    const handle = own(oc.BRep_Tool.Surface_2(face));
    if (handle.IsNull()) return { kind: 'other', radius: Number.NaN };
    const surface = handle.get();
    const type = own(surface.DynamicType()).get().Name() as string;
    const kind: FaceSample['kind'] =
      type === 'Geom_CylindricalSurface'
        ? 'cylinder'
        : type === 'Geom_ToroidalSurface'
          ? 'torus'
          : type === 'Geom_SphericalSurface'
            ? 'sphere'
            : 'other';
    const loc = own(new oc.TopLoc_Location_1());
    const triHandle = own(oc.BRep_Tool.Triangulation(face, loc, 0));
    if (triHandle.IsNull()) return { kind: 'other', radius: Number.NaN };
    const tri = triHandle.get();
    const trsf = own(loc.Transformation());
    const xyz = (p: { X(): number; Y(): number; Z(): number }): Vec3 => [p.X(), p.Y(), p.Z()];
    // Every face's nodes: what a removed hole encloses is told by where they lie.
    const nodes: Vec3[] = [];
    for (let i = 1; i <= tri.NbNodes(); i++)
      nodes.push(xyz(own(own(tri.Node(i)).Transformed(trsf))));
    if (kind === 'other' || !tri.HasUVNodes()) return { kind: 'other', radius: Number.NaN, nodes };
    const P = own(new oc.gp_Pnt_1());
    const [Su, Sv, Suu, Svv, Suv] = Array.from({ length: 5 }, () => own(new oc.gp_Vec_1()));
    // These surfaces turn about their axis in u: the points at u = 0 and π face across it and the
    // tangents at u = 0 and π/2 span the plane it is normal to (v = 0 for all three).
    const at = (u: number) => {
      surface.D1(u, 0, P, Su, Sv);
      return { p: xyz(P), du: xyz(Su) };
    };
    const [a, b, c] = [at(0), at(Math.PI / 2), at(Math.PI)];
    const cx = crossV(a.du, b.du);
    const dir = scaleV(cx, 1 / Math.hypot(...cx));
    const point: Vec3 = [(a.p[0] + c.p[0]) / 2, (a.p[1] + c.p[1]) / 2, (a.p[2] + c.p[2]) / 2];
    // Curvature and side at the first node: the largest principal curvature, and whether the
    // outward normal points to the axis (the material is outside the surface).
    // The face's middle in its turning direction: the surface point at the middle of its own u
    // range (u turns about the axis on all three; the range never wraps on one face), whatever
    // how its nodes are spread.
    let [uMin, uMax, vMin, vMax] = [Infinity, -Infinity, Infinity, -Infinity];
    for (let i = 1; i <= tri.NbNodes(); i++) {
      const q = own(tri.UVNode(i));
      [uMin, uMax] = [Math.min(uMin, q.X()), Math.max(uMax, q.X())];
      [vMin, vMax] = [Math.min(vMin, q.Y()), Math.max(vMax, q.Y())];
    }
    surface.D0((uMin + uMax) / 2, (vMin + vMax) / 2, P);
    const middle = xyz(P);
    const uv = own(tri.UVNode(1));
    surface.D2(uv.X(), uv.Y(), P, Su, Sv, Suu, Svv, Suv);
    const [du, dv] = [xyz(Su), xyz(Sv)];
    const [E, F, G] = [dotV(du, du), dotV(du, dv), dotV(dv, dv)];
    const nRaw = crossV(du, dv);
    const reversed =
      (face as { Orientation_1(): unknown }).Orientation_1() ===
      oc.TopAbs_Orientation.TopAbs_REVERSED;
    const n = scaleV(nRaw, (reversed ? -1 : 1) / Math.hypot(...nRaw));
    const [L, M, N] = [dotV(xyz(Suu), n), dotV(xyz(Suv), n), dotV(xyz(Svv), n)];
    const det = E * G - F * F;
    const H = (E * N - 2 * F * M + G * L) / (2 * det);
    const K = (L * N - M * M) / det;
    const kmax = Math.abs(H) + Math.sqrt(Math.max(0, H * H - K));
    const p = xyz(P);
    const off = subV(p, point);
    const radial = subV(off, scaleV(dir, dotV(off, dir)));
    return {
      kind,
      radius: 1 / kmax,
      axis: { point, dir },
      nodes,
      middle,
      concave: dotV(n, radial) < 0,
    };
  }
  /** The kernel's triangulation of a body read into `RawSurface` (analysis-surface.ts). */
  function rawAnalysisSurface(body: Named): RawSurface {
    const { topology, edge: edgeShape } = tableOf(body);
    const P = own(new oc.gp_Pnt_1());
    const Du = own(new oc.gp_Vec_1()),
      Dv = own(new oc.gp_Vec_1());
    const at = (): Xyz => [P.X(), P.Y(), P.Z()];
    /**
     * Per face: its triangulation, its nodes (world coordinates, indices from `base` in one
     * numbering of all faces' nodes) and its surface.
     */
    const local: {
      handle: { IsNull(): boolean; get(): OcModule };
      loc: unknown;
      base: number;
      surface: OcModule | undefined;
    }[] = [];
    const coords: number[] = [];
    const faceTriangles: { face: number; l3: [number, number, number]; uv: RawTriangle['uv'] }[] =
      [];
    for (let face = 1; face <= body.faces.Size(); face++) {
      const topoFace = own(oc.TopoDS.Face_1(own(body.faces.FindKey(face))));
      const loc = own(new oc.TopLoc_Location_1());
      const handle = own(oc.BRep_Tool.Triangulation(topoFace, loc, 0));
      if (handle.IsNull()) throw new CadKernelError('analysis-surface-untriangulated');
      const tri = handle.get();
      // The mesher's own limit (fem-mesher `surfaceLimits.triangles`), checked before copying.
      if (faceTriangles.length + tri.NbTriangles() > analysisSurfaceTriangles)
        throw new CadKernelError('analysis-surface-limit');
      const base = coords.length / 3;
      const trsf = own(loc.Transformation());
      for (let i = 1; i <= tri.NbNodes(); i++) {
        const p = own(own(tri.Node(i)).Transformed(trsf));
        coords.push(p.X(), p.Y(), p.Z());
      }
      const reversed = topoFace.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
      const surfaceHandle = tri.HasUVNodes() ? own(oc.BRep_Tool.Surface_2(topoFace)) : undefined;
      const surface = surfaceHandle && !surfaceHandle.IsNull() ? surfaceHandle.get() : undefined;
      local.push({ handle, loc, base, surface });
      const uvOf = (n: number): [number, number] => {
        const uv = own(tri.UVNode(n));
        return [uv.X(), uv.Y()];
      };
      for (let i = 1; i <= tri.NbTriangles(); i++) {
        const t = own(tri.Triangle(i));
        const l3 = (
          reversed ? [t.Value(1), t.Value(3), t.Value(2)] : [t.Value(1), t.Value(2), t.Value(3)]
        ) as [number, number, number];
        faceTriangles.push({
          face: face - 1,
          l3: l3.map((n) => base + n - 1) as [number, number, number],
          uv: surface ? [uvOf(l3[0]), uvOf(l3[1]), uvOf(l3[2])] : null,
        });
      }
    }
    /**
     * Joining the faces' nodes. Nodes are one point when the kernel's discretisation of an edge
     * says so: the i-th node of an edge's polygon on one face is the i-th on every other face
     * (and on both sides of a seam). Nodes at identical coordinates are joined too (a vertex the
     * polygons share). Nothing is joined by nearness; a joined set whose points are apart by more
     * than the kernel's own tolerance is refused (`analysis-surface-nonconforming`).
     */
    const parent = Array.from({ length: coords.length / 3 }, (_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]!]!;
        x = parent[x]!;
      }
      return x;
    };
    const union = (a: number, b: number) => {
      const [ra, rb] = [find(a), find(b)];
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    };
    const exact = new Map<string, number>();
    for (let n = 0; n < coords.length / 3; n++) {
      const key = `${coords[3 * n]},${coords[3 * n + 1]},${coords[3 * n + 2]}`;
      const seen = exact.get(key);
      if (seen === undefined) exact.set(key, n);
      else union(seen, n);
    }
    /** Per edge: its polygon on its first face (global node indices) and its parameters. */
    const polygons: ({ nodes: number[]; params: number[] | null } | undefined)[] = [];
    let tolerance = 0;
    for (let e = 0; e < topology.edges.length; e++) {
      const edge = edgeShape(e);
      if (oc.BRep_Tool.Degenerated(edge)) {
        polygons.push(undefined);
        continue;
      }
      tolerance = Math.max(tolerance, oc.BRep_Tool.Tolerance_2(edge));
      const reversedEdge = own(oc.TopoDS.Edge_1(own((edge as { Reversed(): unknown }).Reversed())));
      let first: { nodes: number[]; params: number[] | null } | undefined;
      for (const f of topology.edges[e]!.faces) {
        const { handle, loc, base } = local[f]!;
        // Both orientations: a seam has a polygon on each side of the same face.
        for (const oriented of [edge, reversedEdge]) {
          const polygon = own(oc.BRep_Tool.PolygonOnTriangulation_1(oriented, handle, loc));
          if (polygon.IsNull()) {
            if (oriented === edge) throw new CadKernelError('analysis-surface-edge', `edge ${e}`);
            continue;
          }
          const p = polygon.get();
          const nodes = Array.from({ length: p.NbNodes() }, (_, i) => base + p.Node(i + 1) - 1);
          if (!first) {
            first = {
              nodes,
              params: p.HasParameters()
                ? Array.from({ length: p.NbNodes() }, (_, i) => p.Parameter(i + 1))
                : null,
            };
            continue;
          }
          if (nodes.length !== first.nodes.length)
            throw new CadKernelError('analysis-surface-nonconforming', `edge ${e}`);
          nodes.forEach((n, i) => union(n, first!.nodes[i]!));
        }
      }
      polygons.push(first);
    }
    // One point per joined set, at its first node; the set must be within the tolerance.
    const points: number[] = [];
    const idOf = new Map<number, number>();
    let size = 0;
    for (let d = 0; d < 3; d++) {
      let lo = Infinity,
        hi = -Infinity;
      for (let n = d; n < coords.length; n += 3) {
        lo = Math.min(lo, coords[n]!);
        hi = Math.max(hi, coords[n]!);
      }
      size = Math.max(size, hi - lo);
    }
    const allowed = Math.max(10 * tolerance, 1e-9 * size);
    for (let n = 0; n < coords.length / 3; n++) {
      const r = find(n);
      let id = idOf.get(r);
      if (id === undefined) {
        id = points.length / 3;
        idOf.set(r, id);
        points.push(coords[3 * r]!, coords[3 * r + 1]!, coords[3 * r + 2]!);
      }
      const apart = Math.hypot(
        coords[3 * n]! - points[3 * id]!,
        coords[3 * n + 1]! - points[3 * id + 1]!,
        coords[3 * n + 2]! - points[3 * id + 2]!,
      );
      if (apart > allowed) throw new CadKernelError('analysis-surface-nonconforming', `node ${n}`);
    }
    const joinedId = (n: number) => idOf.get(find(n))!;
    const triangles: RawTriangle[] = [];
    for (const t of faceTriangles) {
      const v = t.l3.map(joinedId) as [number, number, number];
      // A triangle that closes up on a pole or a seam encloses nothing: it is left out.
      if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
      triangles.push({ v, face: t.face, uv: t.uv });
    }
    const chains: RawSurface['chains'] = [];
    const curves: (OcModule | undefined)[] = [];
    for (let e = 0; e < topology.edges.length; e++) {
      const edge = edgeShape(e);
      const first = polygons[e];
      const curveHandle = first ? own(oc.BRep_Tool.Curve_2(edge, 0, 0)) : undefined;
      curves.push(curveHandle && !curveHandle.IsNull() ? curveHandle.get() : undefined);
      // A degenerated edge (a pole) is a point: its chain is empty.
      chains.push({
        nodes: first ? first.nodes.map(joinedId) : [],
        params: curves[e] && first ? first.params : null,
      });
    }
    return {
      points,
      triangles,
      shapeFaces: body.faces.Size(),
      chains,
      surfaceAt(face, u, v) {
        const s = local[face]!.surface;
        if (!s) return undefined;
        s.D0(u, v, P);
        return at();
      },
      curveAt(edge, t) {
        const c = curves[edge];
        if (!c) return undefined;
        c.D0(t, P);
        return at();
      },
      uvAt(face, p, start) {
        const s = local[face]!.surface;
        if (!s) return undefined;
        // Newton on |S(u, v) − p|² from the nearby start, so the result stays on its seam side.
        let [u, v] = start;
        for (let i = 0; i < 30; i++) {
          s.D1(u, v, P, Du, Dv);
          const r = [P.X() - p[0], P.Y() - p[1], P.Z() - p[2]];
          const su = [Du.X(), Du.Y(), Du.Z()],
            sv = [Dv.X(), Dv.Y(), Dv.Z()];
          const dot = (x: number[], y: number[]) => x[0]! * y[0]! + x[1]! * y[1]! + x[2]! * y[2]!;
          const a = dot(su, su),
            b = dot(su, sv),
            c = dot(sv, sv);
          const det = a * c - b * b;
          if (!(det > 0)) return undefined;
          const gu = dot(su, r),
            gv = dot(sv, r);
          const du = (c * gu - b * gv) / det,
            dv = (a * gv - b * gu) / det;
          u -= du;
          v -= dv;
          if (Math.abs(du) + Math.abs(dv) < 1e-14 * (1 + Math.abs(u) + Math.abs(v))) break;
        }
        s.D0(u, v, P);
        const miss = Math.hypot(P.X() - p[0], P.Y() - p[1], P.Z() - p[2]);
        // Not onto the point: the caller keeps the middle UV.
        return miss <= 1e-9 * (1 + Math.hypot(...p)) ? [u, v] : undefined;
      },
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
    const textured: { face: unknown; tri: OcModule; offset: number }[] = [];
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
      textured.push({ face: topoFace, tri, offset });
      const reversed = topoFace.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
      for (let i = 1; i <= tri.NbTriangles(); i++) {
        const t = own(tri.Triangle(i));
        const [a, b, c] = [t.Value(1), t.Value(2), t.Value(3)].map((n: number) => offset + n - 1);
        indices.push(...(reversed ? [a, c, b] : [a, b, c]));
      }
    });
    const uvs = new Float32Array((positions.length / 3) * 2);
    for (const t of textured)
      faceTextureUvs(oc, own, t.face, t.tri, positions, origin, uvs, t.offset);
    oc.BRepTools.Clean(shape, true);
    const pos = new Float32Array(positions);
    return {
      bodyId,
      origin,
      positions: pos,
      normals: vertexNormals(pos, indices),
      uvs,
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
   * #820: the tolerance a feature's result may have. An imported body keeps the tolerance it
   * was read with (`maxToleranceMm`) and its placement carries it; every other feature has the
   * document's result limit, and `build` refuses an input above that limit.
   */
  const featureById = new Map(doc.features.map((f) => [f.id, f]));
  const limits = new Map<string, number>();
  const toleranceLimit = (id: string): number => {
    let limit = limits.get(id);
    if (limit !== undefined) return limit;
    const f = featureById.get(id);
    limit = doc.kernelProfile.maxResultLinearToleranceMm;
    if (f?.type === 'imported') limit = Math.max(limit, f.args.maxToleranceMm ?? 0);
    else if (f?.type === 'transform') limit = Math.max(limit, toleranceLimit(f.inputFeatureIds[0]));
    limits.set(id, limit);
    return limit;
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
    if (maxTolerance(shape) > toleranceLimit(featureId))
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
  const display =
    options.deflectionMm === undefined &&
    !options.step &&
    !options.brep &&
    !options.analysisSurface;
  const cache = display ? options.placement : undefined;
  // CR5f-5: an analysis surface builds the same exact shapes as a display evaluation (it cleans
  // the triangulations it leaves, `analysisSurfaceOf`), so it reads and refreshes the feature
  // cache too; an export (deflection, STEP, BRep) still builds the full graph.
  const analysis =
    options.deflectionMm === undefined &&
    !options.step &&
    !options.brep &&
    !!options.analysisSurface;
  const features = display || analysis ? options.features : undefined;
  /** The feature cache keys this evaluation used or made, kept past the budget (P1). */
  const latest = new Set<string>();
  let settle = false;
  const identity = cache && placementIdentity(doc, options);
  /** A display evaluation (not an export) shows what it can of a failed document. */
  const partial =
    options.partial !== false &&
    options.deflectionMm === undefined &&
    !options.step &&
    !options.brep &&
    !options.analysisSurface;
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
      for (const f of doc.features) if (f.type === 'imported') checkImportedAssets(f);
      for (const body of active) {
        const kept = cache!.bodies.get(body.id)!;
        const keptNamed = named(kept.shape, () => null);
        keptNamed.names = [...kept.names];
        if (kept.origins) keptNamed.origins = copyOrigins(kept.origins);
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
            if (f.type === 'imported') checkImportedAssets(f);
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
          if (kept.origins) reused.origins = copyOrigins(kept.origins);
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
            ...(shape.origins ? { origins: copyOrigins(shape.origins) } : {}),
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
    // CR4e: each spot weld row's points, from its flanges on the bodies' final shapes.
    let weldPoints = 0;
    const spotWelds = doc.spotWelds?.map((w): CadSpotWeldPoints => {
      const flange = ({ bodyId, face }: CadSpotWeld['flanges'][number]) => {
        const final = finals.get(bodyId);
        if (!final) return 'spot-weld-body-missing';
        if (!naming) return 'spot-weld-unsupported';
        const table = tableOf(final);
        const r = resolveTopologyRef(table.topology, face);
        if (r.status !== 'resolved') return `spot-weld-face-${r.status}`;
        return { face: table.face(r.index), deflection: displayDeflection(boundsOf(final.shape)) };
      };
      const [a, b] = w.flanges.map(flange);
      if (typeof a === 'string') return { id: w.id, status: 'error', code: a };
      if (typeof b === 'string') return { id: w.id, status: 'error', code: b };
      try {
        const row = spotWeldPoints(oc, own, a!, b!, w);
        if (typeof row === 'string') return { id: w.id, status: 'error', code: row };
        weldPoints += row.gaps.length;
        if (weldPoints > cadSpotWeldLimits.points)
          return { id: w.id, status: 'error', code: 'spot-weld-points' };
        return {
          id: w.id,
          status: 'ok',
          points: [...row.points],
          gaps: [...row.gaps],
          tooFar: row.gaps.filter((g) => g > w.maxGapMm).length,
          lengthMm: row.lengthMm,
        };
      } catch (error) {
        // A geometry the kernel cannot read gives no points; it never fails the shapes.
        decodeKernelException(oc, error);
        return { id: w.id, status: 'error', code: 'spot-weld-failed' };
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
    let gapFlush: CadGapFlushResult | undefined;
    if (options.gapFlush) {
      // Each edge a border of one face of its body's final shape (a sheet's edge).
      const border = ({ bodyId, edge }: { bodyId: string; edge: number }) => {
        const final = finals.get(bodyId);
        const table = final && tableOf(final);
        const faces = table?.topology.edges[edge]?.faces;
        if (!faces?.length) return 'gap-flush-edge-missing';
        const shape = table!.edge(edge);
        const face = own(oc.TopoDS.Face_1(own(final!.faces.FindKey(faces[0]! + 1))));
        if (
          faces.length !== 1 ||
          oc.BRep_Tool.Degenerated(shape) ||
          oc.BRep_Tool.IsClosed_2(shape, face)
        )
          return 'gap-flush-not-border';
        return { shape, face };
      };
      const { a, b } = options.gapFlush;
      const [one, two] = [border(a), border(b)];
      gapFlush =
        a.bodyId === b.bodyId
          ? { code: 'gap-flush-same-body' }
          : typeof one === 'string'
            ? { code: one }
            : typeof two === 'string'
              ? { code: two }
              : (() => {
                  const samples = edgeGapFlush(oc, own, one.shape, one.face, two.shape);
                  return typeof samples === 'string' ? { code: samples } : { samples };
                })();
    }
    let faceDistances: CadFaceDistanceResult[] | undefined;
    if (options.faceDistances)
      faceDistances = options.faceDistances.map(({ bodyId, faces, points, via }) => {
        const shapesOf = (id: string, list: number[]) => {
          const final = finals.get(id);
          if (!final) return 'face-distance-body-missing';
          const count = tableOf(final).topology.faces.length;
          if (!list.length || list.some((f) => !Number.isInteger(f) || f < 0 || f >= count))
            return 'face-distance-face-missing';
          return {
            shapes: list.map((f) => own(oc.TopoDS.Face_1(own(final.faces.FindKey(f + 1))))),
            deflection: displayDeflection(boundsOf(final.shape)),
          };
        };
        const shapes = shapesOf(bodyId, faces);
        if (typeof shapes === 'string') return { code: shapes };
        let from = points;
        if (via) {
          const onto = shapesOf(via.bodyId, via.faces);
          if (typeof onto === 'string') return { code: onto };
          const moved = faceSetDistances(oc, own, onto.shapes, points, onto.deflection);
          if (typeof moved === 'string') return { code: moved };
          from = moved.nearest;
        }
        const measured = faceSetDistances(oc, own, shapes.shapes, from, shapes.deflection);
        return typeof measured === 'string'
          ? { code: measured }
          : { distances: measured.distances };
      });
    let step: Uint8Array | undefined;
    let stepPmi: CadStepPmiWritten | undefined;
    if (options.step) {
      // Named by the body being written, like a mesh checkpoint.
      if (active.length) await options.checkpoint?.(active[0].id);
      const pmi = stepPmiOf(active.map((b) => ({ id: b.id, final: finals.get(b.id)! })));
      stepPmi = pmi?.report;
      step =
        pmi && pmi.bodies.some((b) => b.pmi.length)
          ? writePmiStep(oc, pmi.bodies)
          : writeStep(active.map((b) => ({ id: b.id, shape: finals.get(b.id)!.shape })));
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
    let analysisSurface: CadAnalysisSurfaceResult | undefined;
    if (options.analysisSurface) {
      const {
        bodyId,
        angularDeflectionRad,
        maxEdgeMm,
        minEdgeMm,
        faceSizes,
        pointSizes,
        preparation,
        clampDeflection,
        idealisation,
        sheetThicknessMm,
      } = options.analysisSurface;
      let { deflectionMm } = options.analysisSurface;
      const final = finals.get(bodyId);
      /** The smallest size: as small as the smallest deflection, so it cannot be a loop's way out. */
      const smallest = final
        ? displayDeflectionMm(boundsOf(final.shape), analysisDeflection.relativeMin)
        : 0;
      const sizeOk = (h: number) => h >= smallest && Number.isFinite(h);
      // R3e-3: a run asks for its levels' deflections and lets the body's smallest raise them.
      if (final && clampDeflection && Number.isFinite(deflectionMm))
        deflectionMm = Math.max(
          deflectionMm,
          displayDeflectionMm(boundsOf(final.shape), analysisDeflection.relativeMin),
        );
      if (!final) analysisSurface = { code: 'analysis-body-missing' };
      else if (
        (maxEdgeMm !== undefined && !sizeOk(maxEdgeMm)) ||
        (minEdgeMm !== undefined && !sizeOk(minEdgeMm)) ||
        (faceSizes ?? []).some(
          (f) =>
            !Number.isSafeInteger(f.face) ||
            f.face < 0 ||
            f.face >= final.faces.Size() ||
            !sizeOk(f.maxEdgeMm),
        ) ||
        new Set((faceSizes ?? []).map((f) => f.face)).size !== (faceSizes ?? []).length ||
        (pointSizes &&
          (!sizeOk(pointSizes.maxEdgeMm) ||
            !(pointSizes.radiusMm >= 0 && Number.isFinite(pointSizes.radiusMm)) ||
            pointSizes.points.length % 3 !== 0 ||
            !pointSizes.points.every(Number.isFinite)))
      )
        analysisSurface = { code: 'analysis-size' };
      else if (preparation && !preparationOk(preparation, final.faces.Size()))
        analysisSurface = { code: 'analysis-preparation' };
      else if (
        idealisation === 'shell' &&
        preparation &&
        (preparation.removeHolesBelow !== null ||
          preparation.removeFilletsBelow !== null ||
          preparation.removeFaces.length > 0)
      )
        analysisSurface = { code: 'analysis-preparation' };
      else if (
        !(
          deflectionMm >= displayDeflectionMm(boundsOf(final.shape), analysisDeflection.relativeMin)
        ) ||
        !(deflectionMm <= analysisDeflection.maxMm) ||
        (angularDeflectionRad !== undefined &&
          !(angularDeflectionRad > 0 && angularDeflectionRad <= Math.PI / 2))
      )
        analysisSurface = { code: 'analysis-deflection' };
      else {
        await options.checkpoint?.(bodyId);
        try {
          const sheet =
            idealisation === 'shell' &&
            kindOf(doc.bodies.find((b) => b.id === bodyId)!.resultFeatureId) === 'sheet';
          const idealised =
            idealisation !== 'shell'
              ? undefined
              : sheet
                ? sheetMidsurface(final, sheetThicknessMm)
                : midsurfaceOf(final, bodyId);
          analysisSurface = {
            surface: analysisSurfaceOf(
              final,
              deflectionMm,
              angularDeflectionRad ?? 0.5,
              {
                maxEdgeMm: maxEdgeMm ?? Infinity,
                minEdgeMm,
                faces: new Map((faceSizes ?? []).map((f) => [f.face, f.maxEdgeMm])),
                ...(pointSizes?.points.length
                  ? {
                      near: {
                        points: pointSizes.points,
                        radiusMm: pointSizes.radiusMm,
                        sizeMm: pointSizes.maxEdgeMm,
                      },
                    }
                  : {}),
                maxTriangles: analysisSurfaceTriangles,
                // CR5e: a sheet's faces meshed one by one (`seedSurface`).
                ...(sheet ? { seed: true } : {}),
              },
              preparation,
              idealised,
            ),
          };
        } catch (error) {
          analysisSurface =
            error instanceof MidsurfaceRefusal
              ? { code: 'midsurface-unsupported', detail: error.message }
              : { code: kernelError(error, bodyId).code };
        }
      }
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
        const { shape, names, edges, origins } = shapes.get(placed ? f.inputFeatureIds[0]! : f.id)!;
        // A shape the feature cache keeps stays its own; any other is the placement path's now.
        const borrowed = !owned.has(shape as Shape);
        owned.delete(shape as Shape);
        const map = edges?.length ? shapeMap(shape, 'TopAbs_EDGE') : undefined;
        kept.set(body.id, {
          ...(borrowed ? { borrowed } : {}),
          shape: shape as Shape,
          names,
          ...(origins ? { origins: copyOrigins(origins) } : {}),
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
        ...(spotWelds ? { spotWelds } : {}),
      },
      // The coarse meshes follow the standard ones and are not in the digest (display only).
      meshes: [...meshes, ...coarse],
      ...(step ? { step } : {}),
      ...(step && stepPmi ? { stepPmi } : {}),
      ...(brep ? { brep } : {}),
      ...(continuity ? { continuity } : {}),
      ...(gapFlush ? { gapFlush } : {}),
      ...(faceDistances ? { faceDistances } : {}),
      ...(comb ? { comb } : {}),
      ...(analysisSurface ? { analysisSurface } : {}),
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
