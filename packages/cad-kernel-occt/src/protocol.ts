import type { KernelBuild } from '@editor-platform/geometry-kernel-occt';
import type {
  CadAppearance,
  CadBodyKind,
  CadCombSample,
  CadContinuitySample,
  CadGapFlushSample,
  CadDocument,
  CadEvaluation,
  CadPmiTracking,
  CadStepPlan,
  CadTopologyRef,
  CadTopologyTable,
  Vec3,
} from '@editor-platform/cad-core';
import type { CadStepAssemblyImportResult } from './step-assembly-import';
import type { CadStepImportOptions, CadStepImportResult } from './step-import';
import type { CadStepPmiWritten } from './step-pmi-write';

/**
 * Host-verified kernel build (`geometry-kernel-occt`): its `buildHash` equals
 * `kernelProfile.buildHash` of documents it may evaluate.
 */
export type CadKernelBuild = KernelBuild;
/**
 * Per body, triangles in model space. `faceIds[t]` is the evaluation-scoped pick id of triangle t.
 * `positions` are relative to `origin` (model-space mm, full precision): add it back to place them.
 */
export interface CadMesh {
  bodyId: string;
  origin: [number, number, number];
  positions: Float32Array;
  normals: Float32Array;
  /**
   * #662: real-size texture coordinates (mm), two per node of `positions`: a plane projected on
   * the model's axes, any other face along its own parameters scaled to mm. Absent on meshes
   * made before textures (they draw without image maps).
   */
  uvs?: Float32Array;
  indices: Uint32Array;
  faceIds: Uint32Array;
  /**
   * The body's B-rep vertices, each once, as model-space x, y, z in mm read from the kernel
   * (not from the triangulation): exact points a distance measurement can snap to.
   */
  vertices: Float64Array;
  /**
   * The pick table (docs/cad/r1-modeling.md, Pickと表示). This body's face pick ids are
   * `faceBase + 1 + i` for `topology.faces[i]`, and its edge pick ids `edgeBase + 1 + i` for
   * `topology.edges[i]`. Ids are evaluation-scoped; only names are ever stored.
   */
  faceBase: number;
  edgeBase: number;
  /** Edge polylines as line segments (pairs of points, relative to `origin`). */
  edges: Float32Array;
  /** The edge pick id of each segment of `edges`. */
  edgeIds: Uint32Array;
  topology: CadTopologyTable;
  /**
   * R2b-4: a coarse display mesh (LOD), triangles only: no pick ids, vertices, edges or pick
   * table. Absent on the standard mesh, which picks and measurement read.
   */
  lod?: 'coarse';
  /**
   * U4: a failed body's shape before its own failed feature (this ID), triangles only (no pick
   * table). A reference display beside a partial result: never picked, measured or exported.
   */
  beforeFailure?: string;
  /**
   * The mean and Gauss curvature (1/mm, 1/mm²) at each node of `positions`, when requested
   * (R2a-4): from the faces' exact surfaces, NaN where a node has none. Display only.
   */
  curvature?: { mean: Float32Array; gauss: Float32Array };
  /**
   * PMI-4a: for each import with PMI the body's shape comes from, the imported faces, edges and
   * vertices it still has unchanged, by their index in `topology` (`CadPmiTracking`).
   */
  pmi?: CadPmiTracking[];
}
/**
 * The samples of one edge's continuity (R2a-4), or why it has none: the edge is not in the pick
 * table, lies beside one face only, is a seam inside one face, borders more than two faces, or a
 * sample could not be projected onto a face.
 */
export type CadContinuityResult = { samples: CadContinuitySample[] } | { code: string };
/**
 * The curvature comb of one edge's curve (R2a-4), or why it has none: the edge is not in the
 * pick table, is a point (a pole), or has no 3D curve.
 */
export type CadCombResult = { samples: CadCombSample[] } | { code: string };
/**
 * CR3d: the gap and flush samples between two bodies' border edges, or why there are none: an
 * edge is not in its pick table, is not a sheet's border (one face beside it), both are one
 * edge or of one body, or they never face each other.
 */
export type CadGapFlushResult = { samples: CadGapFlushSample[] } | { code: string };
/** CR3d: the two edges to measure between, each by its body and index in its pick table. */
export interface CadGapFlushEdges {
  a: { bodyId: string; edge: number };
  b: { bodyId: string; edge: number };
}
/**
 * CR4a: the distance (mm) from each point to the nearest of one body's faces, on their exact
 * trimmed surfaces (`points` are x, y, z in model space; `faces` by index in the body's pick
 * table).
 */
export interface CadFaceDistanceQuery {
  bodyId: string;
  faces: number[];
  points: Float64Array;
  /**
   * Moves each point first to its nearest point on these faces (exact, trimmed), and measures
   * from there: a display triangle's interior point taken onto its own body's surface (Codex on
   * #960).
   */
  via?: { bodyId: string; faces: number[] };
}
/** CR4a: one distance per point of the query, or why there are none (a body or face missing). */
export type CadFaceDistanceResult = { distances: Float64Array } | { code: string };
/** One body's node curvature, in the order of its mesh's nodes (`CadMesh.curvature`). */
export interface CadBodyCurvature {
  bodyId: string;
  mean: Float32Array;
  gauss: Float32Array;
}
/**
 * The active bodies' exact shapes as one normalized BRep compound (`BRepTools` text), their
 * bounds (mm) and each body's kind: the shape a building places as a part (R2c-U2). Each body's
 * appearance and number of faces, in the compound's order, let the building colour a mesh of the
 * compound body by body (a mesh's face indices count the compound's faces in that order).
 */
export interface CadBrepExport {
  bytes: Uint8Array;
  bounds: [Vec3, Vec3];
  kinds: CadBodyKind[];
  appearances: CadAppearance[];
  faces: number[];
}
/**
 * R3c-2a: one body's boundary as the analysis mesher takes it (fem-mesher `SurfaceMeshInput`):
 * world coordinates in mm (Float64), triangles wound outward and tagged with their face in the
 * topology table's order, and each edge's chain of points in the table's edge order (empty for a
 * degenerated edge), or why it could not be made.
 */
/** R3c-2a / R3d-2b: which body's analysis surface, and how fine. */
export interface CadAnalysisSurfaceRequest {
  bodyId: string;
  /** Chordal deflection of the kernel's triangulation (mm). */
  deflectionMm: number;
  angularDeflectionRad?: number;
  /** R3d-2b: the longest a surface triangle edge may be (mm); none keeps the kernel's triangles. */
  maxEdgeMm?: number;
  /**
   * R3e-3: the volume mesh's smallest size (mm). Given, surface triangles are also refined to a
   * size graded from the shape edges' own spacing, down to this, so the volume mesher (which keeps
   * the surface) gets no slivers to build on; absent, flips and smoothing only.
   */
  minEdgeMm?: number;
  /**
   * R3d-2b: smaller limits on some faces, by topology face index of the body (mesh.local). With a
   * preparation, each applies to the analysis faces its face became (the smallest wins).
   */
  faceSizes?: { face: number; maxEdgeMm: number }[];
  /**
   * CR5e-2: a smaller size around points (a spot weld's), whatever face they are on: `maxEdgeMm`
   * within `radiusMm` of a point, growing by the distance beyond it (the smallest wins).
   * `points` is x, y, z per point (mm).
   */
  pointSizes?: { points: number[]; radiusMm: number; maxEdgeMm: number };
  /**
   * R3c-2b: faces removed before meshing (`BRepAlgoAPI_Defeaturing`). Absent or removing nothing,
   * the analysis shape is the body itself.
   */
  preparation?: CadAnalysisPreparation;
  /**
   * R3e-3: raise `deflectionMm` to the body's smallest (`analysisDeflection.relativeMin` of its
   * bounds) instead of refusing it (`analysis-deflection`); the upper limit still refuses.
   */
  clampDeflection?: boolean;
  /**
   * R3i-2: `shell` triangulates the body's midsurface (a thicken, shell or extrude of uniform
   * thickness) instead of its boundary, with `shell.thicknessMm` and a history whose sides become
   * edges; the preparation must remove nothing. Absent or `solid`: the body's boundary.
   */
  idealisation?: 'solid' | 'shell';
  /**
   * CR5e (docs/cad/car-design.md, CR5の分け方): a sheet body's thickness (mm). With `shell`, a
   * sheet is its own midsurface: its faces and edges are the analysis shape's, one to one, at
   * this thickness. A sheet without it is refused (`midsurface-unsupported`); a solid ignores it.
   */
  sheetThicknessMm?: number;
}

/** docs/cad/r3-analysis.md, 形状準備; the document's `SimulationPreparation` with face indices. */
export interface CadAnalysisPreparation {
  /** Holes (concave cylinders closing a full turn) of a smaller diameter (mm); null keeps them. */
  removeHolesBelow: number | null;
  /** Cylinder, torus and sphere blends of a smaller radius (mm); null keeps them. */
  removeFilletsBelow: number | null;
  /** Faces removed explicitly, by topology face index of the body. */
  removeFaces: number[];
}

/**
 * What the preparation made of each face and edge of the body, in its topology table's order:
 * deleted, or the analysis-shape elements it became (the kernel's `IsDeleted` / `Modified`; an
 * untouched element is its own one image). simulation-core's `PreparationHistory`.
 */
export interface CadPreparationHistory {
  /**
   * Per body face, the analysis faces it became. R3i-2: on a midsurface a side of the wall is
   * `deleted` and lists the midsurface edges it runs along instead (`edges`), and the wall face
   * on the far side of the midsurface from its own outward normal is `reversed`.
   */
  faces: { deleted: boolean; images: number[]; edges?: number[]; reversed?: boolean }[];
  edges: { deleted: boolean; images: number[] }[];
  analysisFaces: number;
  analysisEdges: number;
  /** The body's faces the preparation removed, sorted. */
  removed: number[];
}

export interface CadAnalysisSurface {
  points: Float64Array;
  triangles: Uint32Array;
  faces: Uint32Array;
  shapeFaces: number;
  shapeEdges: number;
  edges: { offsets: Uint32Array; nodes: Uint32Array };
  /**
   * R3d-2a: curved mid-edge points, one per listed surface edge (`pairs`, two point indices each,
   * smaller first): on the shape edge's curve or the face's surface. Edges not listed are straight.
   */
  midpoints: { pairs: Uint32Array; points: Float64Array };
  /** R3c-2b: from the body's faces and edges to the analysis shape's (the surface's tags). */
  history: CadPreparationHistory;
  /**
   * R3e-2: exact measures of the analysis shape, for the post-application load checks
   * (docs/cad/r3-analysis.md, 荷重の適用の検査): per face its area (mm²) and its vector area
   * ∫ n dA with the outward normal (mm², x y z per face, from ½ ∮ r × dr round its oriented
   * boundary), per edge its length (mm). Indices are the surface's tags and edge chains.
   */
  measures: CadAnalysisMeasures;
  /**
   * R3e-2: the source body's topology table, in the order `history` indexes (before the
   * preparation), so a document's F1 targets resolve on exactly the shape the history describes.
   */
  bodyTopology: CadTopologyTable;
  /** R3i-2: a midsurface (`idealisation: 'shell'`) and the wall's thickness. */
  shell?: { thicknessMm: number };
}
export interface CadAnalysisMeasures {
  faceAreas: Float64Array;
  faceVectorAreas: Float64Array;
  edgeLengths: Float64Array;
}
export type CadAnalysisSurfaceResult =
  | { surface: CadAnalysisSurface }
  /** R3i-2: `detail` says why a midsurface was refused (`midsurface-unsupported`). */
  | { code: string; detail?: string };
/** R2b-5: an assembly's AP242 file, or why it was not written. */
export type CadStepAssemblyResult =
  | { status: 'ok'; step: Uint8Array }
  | { status: 'error'; code: string; elementId?: string; retryable: boolean };
/** How fine a render's meshes are: a share of each body's diagonal, and the largest angle. */
export interface CadRenderMeshQuality {
  relativeDeflection: number;
  angularDeflectionRad: number;
}
export type CadWorkerRequest =
  | { type: 'init'; build: CadKernelBuild }
  | {
      type: 'evaluate';
      requestId: string;
      generation: number;
      baseHash: string;
      candidateHash: string;
      document: CadDocument;
      /** Export triangulation (absolute linear deflection, mm); the display default otherwise. */
      deflectionMm?: number;
      /**
       * A render's finer triangulation, relative to each body's size like the display's (its
       * bounding-box diagonal times `relativeDeflection`), evaluated afresh like an export.
       */
      renderMesh?: CadRenderMeshQuality;
      /**
       * The Host approved this build as a read-only substitute for the document's build. The
       * result names this build and is marked `reference`.
       */
      reference?: true;
      /** Also write the active bodies as STEP (AP214, mm) from the exact shapes. */
      step?: true;
      /** Also write the active bodies as one normalized BRep (a building's part). */
      brep?: true;
      /** D2 asset bytes the document's imported features read, by `sha256:<hex>` (copied). */
      assets?: Record<string, Uint8Array>;
      /** R2b-2: references whose connector frames the result returns, in order. */
      connectors?: CadTopologyRef[];
      /** Also sample one edge's continuity (R2a-4); display only. */
      continuity?: { bodyId: string; edge: number };
      /** Also give the meshes their nodes' curvature (R2a-4); display only. */
      curvature?: true;
      /** Also sample one edge's curvature comb (R2a-4); display only. */
      comb?: { bodyId: string; edge: number };
      /** CR3d: also sample the gap and flush between two border edges; display only. */
      gapFlush?: CadGapFlushEdges;
      /** CR4a: also the exact distances from points to faces (bond candidates); display only. */
      faceDistances?: CadFaceDistanceQuery[];
      /** R2b-4: also each body's coarse display mesh (LOD); display only. */
      coarse?: true;
      /** R3c-2a: also one body's boundary for the analysis mesher, at its own deflection. */
      analysisSurface?: CadAnalysisSurfaceRequest;
      /**
       * CM-4 (P3): the evaluation may pause after about `ms` at a feature or mesh boundary with
       * `continued`; it goes on with `continue` and ends at any other request or a cancel.
       */
      slice?: { ms: number };
    }
  /** D2: read one STEP file into the normalized BRep and its preflight report. */
  | { type: 'import-step'; requestId: string; bytes: Uint8Array; options?: CadStepImportOptions }
  /** R2b-5: read one STEP assembly into its shapes' BReps and flattened instances. */
  | {
      type: 'import-step-assembly';
      requestId: string;
      bytes: Uint8Array;
      options?: CadStepImportOptions;
    }
  /**
   * R2b-5: write an assembly as STEP AP242 from its product plan and each shaped product's
   * BRep compound (`exportBrep`), by content hash.
   */
  | {
      type: 'step-assembly';
      requestId: string;
      plan: CadStepPlan;
      breps: Record<string, Uint8Array>;
    }
  | { type: 'cancel'; requestId: string }
  /** CM-4: the paused evaluation `requestId` goes on, as the next job. */
  | { type: 'continue'; requestId: string };
export type CadWorkerResponse =
  | { type: 'ready'; buildHash: string }
  | { type: 'init-failed'; code: string }
  | {
      type: 'result';
      requestId: string;
      generation: number;
      evaluation: CadEvaluation;
      meshes: CadMesh[];
      /** STEP file bytes, when requested and the evaluation succeeded. */
      step?: Uint8Array;
      /** PMI-4b/4c: what the STEP file carries of the bodies' PMI, when any body has PMI. */
      stepPmi?: CadStepPmiWritten;
      /** The BRep compound, when requested and the evaluation succeeded. */
      brep?: CadBrepExport;
      /** The edge's continuity samples, when requested and the evaluation succeeded. */
      continuity?: CadContinuityResult;
      /** The edge's curvature comb, when requested and the evaluation succeeded. */
      comb?: CadCombResult;
      /** CR3d: the gap and flush samples, when requested and the evaluation succeeded. */
      gapFlush?: CadGapFlushResult;
      /** CR4a: the distances, one result per query, when requested and the evaluation succeeded. */
      faceDistances?: CadFaceDistanceResult[];
      /** The analysis surface, when requested and the evaluation succeeded. */
      analysisSurface?: CadAnalysisSurfaceResult;
    }
  | { type: 'import-result'; requestId: string; result: CadStepImportResult }
  | { type: 'import-assembly-result'; requestId: string; result: CadStepAssemblyImportResult }
  | { type: 'step-assembly-result'; requestId: string; result: CadStepAssemblyResult }
  | { type: 'cancelled'; requestId: string }
  /** Sent before each feature and each body's mesh: the element the Worker works on now. */
  | { type: 'progress'; requestId: string; elementId: string }
  /**
   * CM-4 (P3): the evaluation paused after its slice; `done` of the `total` steps (features and
   * sketches in dependency order, then the meshed bodies) are done. It waits for `continue`.
   */
  | { type: 'continued'; requestId: string; done: number; total: number };

/** Initial evaluation output limits (docs/cad/model.md). Exceeding them is an explicit error. */
export const cadOutputLimits = Object.freeze({
  faces: 50_000,
  triangles: 500_000,
  bufferBytes: 64 * 1024 * 1024,
});
/**
 * The pick table's size as held in memory: its numbers as doubles and its names as UTF-16.
 * Names are bounded by the face limit and the name limits (cadTopologyLimits).
 */
export const topologyBytes = (t: CadTopologyTable) =>
  t.faces.reduce((n, f) => n + 32 + 2 * (f.name ?? []).reduce((c, s) => c + s.length, 0), 0) +
  t.edges.reduce(
    (n, e) =>
      n +
      8 * (e.faces.length + e.vertices.length + 4) +
      2 * (e.boundary ?? []).reduce((c, s) => c + s.length, 0),
    0,
  ) +
  24 * t.vertices.length;
/** PMI-4a: a mesh's PMI tracking as held in memory (its numbers as doubles). */
export const pmiTrackingBytes = (pmi: CadMesh['pmi']) =>
  (pmi ?? []).reduce(
    (n, t) =>
      n + 8 * (t.faces.length + t.edges.length + t.vertices.length) + 2 * t.featureId.length,
    0,
  );
export const meshBytes = (meshes: readonly CadMesh[]) =>
  meshes.reduce(
    (n, m) =>
      n +
      m.positions.byteLength +
      m.normals.byteLength +
      (m.uvs?.byteLength ?? 0) +
      m.indices.byteLength +
      m.faceIds.byteLength +
      m.vertices.byteLength +
      m.edges.byteLength +
      m.edgeIds.byteLength +
      (m.curvature ? m.curvature.mean.byteLength + m.curvature.gauss.byteLength : 0) +
      topologyBytes(m.topology) +
      pmiTrackingBytes(m.pmi),
    0,
  );
