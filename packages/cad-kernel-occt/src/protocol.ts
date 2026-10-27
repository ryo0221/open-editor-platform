import type { KernelBuild } from '@editor-platform/geometry-kernel-occt';
import type {
  CadAppearance,
  CadBodyKind,
  CadCombSample,
  CadContinuitySample,
  CadDocument,
  CadEvaluation,
  CadStepPlan,
  CadTopologyRef,
  CadTopologyTable,
  Vec3,
} from '@editor-platform/cad-core';
import type { CadStepAssemblyImportResult } from './step-assembly-import';
import type { CadStepImportResult } from './step-import';

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
/** R2b-5: an assembly's AP242 file, or why it was not written. */
export type CadStepAssemblyResult =
  | { status: 'ok'; step: Uint8Array }
  | { status: 'error'; code: string; elementId?: string; retryable: boolean };
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
      /** R2b-4: also each body's coarse display mesh (LOD); display only. */
      coarse?: true;
      /**
       * CM-4 (P3): the evaluation may pause after about `ms` at a feature or mesh boundary with
       * `continued`; it goes on with `continue` and ends at any other request or a cancel.
       */
      slice?: { ms: number };
    }
  /** D2: read one STEP file into the normalized BRep and its preflight report. */
  | { type: 'import-step'; requestId: string; bytes: Uint8Array }
  /** R2b-5: read one STEP assembly into its shapes' BReps and flattened instances. */
  | { type: 'import-step-assembly'; requestId: string; bytes: Uint8Array }
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
      /** The BRep compound, when requested and the evaluation succeeded. */
      brep?: CadBrepExport;
      /** The edge's continuity samples, when requested and the evaluation succeeded. */
      continuity?: CadContinuityResult;
      /** The edge's curvature comb, when requested and the evaluation succeeded. */
      comb?: CadCombResult;
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
export const meshBytes = (meshes: readonly CadMesh[]) =>
  meshes.reduce(
    (n, m) =>
      n +
      m.positions.byteLength +
      m.normals.byteLength +
      m.indices.byteLength +
      m.faceIds.byteLength +
      m.vertices.byteLength +
      m.edges.byteLength +
      m.edgeIds.byteLength +
      (m.curvature ? m.curvature.mean.byteLength + m.curvature.gauss.byteLength : 0) +
      topologyBytes(m.topology),
    0,
  );
