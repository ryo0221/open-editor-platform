import { newId } from '@editor-platform/artifact-core';
import {
  CadCoordinator,
  type CadAdmission,
  cadContentHash,
  cadToleranceSetOf,
  cadSpotWeldLimits,
  type CadToleranceSet,
  type CadLoftSection,
  candidatesOf,
  duplicateClosureOf,
  elementName,
  formatTopoName,
  identityQuaternion,
  type Quaternion,
  selectFor,
  topologyRefOf,
  featureReferences,
  jointReferences,
  sketchReferences,
  sketchDefaultChains,
  sketchDefaultPath,
  sketchPath,
  sketchDefaultRegion,
  sketchFreedom,
  CadSketchError,
  parameterValues,
  type CadSketch,
  type CadSketchConstraint,
  type CadSketchPlane,
  type CadSketchRegion,
  type Length,
  isLiteralPosition,
  mm,
  position,
  cadLimits,
  type CadAppearance,
  type CadAssetRef,
  type CadTextures,
  cadAssetMediaTypes,
  cadImportToleranceMm,
  cadTolerance,
  cadTextureKind,
  type CadBody,
  type CadBodyEvaluation,
  type CadDocument,
  type CadTicket,
  type CadEvaluateRequest,
  type CadEvaluation,
  type CadFeature,
  type CadParameter,
  type CadGeometryState,
  type CadKernelPort,
  type CadCamera,
  type CadOperation,
  type CadProjection,
  type CadSession,
  type Position3,
  type CadTopoName,
  type CadTopologyRef,
  type CadCurveSource,
  type CadTrimTool,
  type CadReferenceBinding,
  type CadReferenceProblem,
  type CadPatternLayout,
  type CadCurveLayout,
  type Count,
  type CadDetailType,
  type Vec3,
  continuityReport,
  gapFlushReport,
  type CadGapFlushReport,
  type CadGapFlushSample,
  type CadProportions,
  type CadSpotWeld,
  type CadSpotWeldPoints,
  type CadContinuityReport,
  type CadContinuitySample,
  combScale,
  type CadCombSample,
  featureSketches,
  upstreamFeatures,
  cadRangeLimit,
  cadBodyPmi,
  cadPmiItemStates,
  readCadPmiAsset,
  type CadBodyPmi,
  type CadPmiItemState,
  type CadPmiTracking,
  type CadPmiAsset,
  type CadProfileKind,
} from '@editor-platform/cad-core';
import type { GeometryTextureRole } from '@editor-platform/geometry-core';
import {
  CadExportError,
  displayDeflectionMm,
  stepReport,
  type CadStepPmiWritten,
  pmiTrackingBytes,
  topologyBytes,
  writeGlb,
  writeStl,
  type CadBodyCurvature,
  type CadExportBody,
  type CadExportImage,
  type CadExportReport,
  type CadExportTextures,
  type CadMesh,
  type CadStepImportReport,
  type CadStepImportOptions,
  type CadStepImportResult,
  type CadStepPmiReport,
} from '@editor-platform/cad-kernel-occt';
import { describeAssemblyCode } from './assembly-messages';
import {
  addArc,
  addSpline,
  addOffset,
  addCircle,
  addConstraint,
  addLine,
  constraintTargets,
  movePoint,
  removeItem,
  setDimension,
  solveDraft,
  type SketchConstraintInput,
  type SketchPointInput,
} from './sketch-draft';

export type CadSelection =
  | { kind: 'body' | 'feature' | 'parameter'; id: string }
  /**
   * A face or edge of body `id` by its pick id, valid only on the meshes of `contentHash`
   * (pick ids are evaluation-scoped; docs/cad/r1-modeling.md, Pickと表示).
   */
  | { kind: 'face' | 'edge'; id: string; pick: number; contentHash: string }
  | null;
/** What the Inspector shows for a picked face or edge. */
export interface CadTopologyInfo {
  kind: 'face' | 'edge';
  bodyId: string;
  /** Null for a face no recipe names (an imported body's) or an edge of one. */
  name: CadTopoName | null;
  /** How many of the body's faces or edges carry this name, this one included. */
  sameName: number;
  /**
   * The neighbours' names a reference records to pick this one among them, or why it cannot
   * be referenced: `unnamed`, or `symmetric` when even all of its neighbours' names match.
   */
  select: { adjacent: CadTopoName[] } | 'unnamed' | 'symmetric' | undefined;
  /** Area in mm² for a face, length in mm for an edge. */
  size: number;
  /** A face's outward unit normal when the face is planar (mirror, draft). */
  normal?: Vec3;
}
export interface CadDiagnostic {
  code: string;
  severity: 'error' | 'warning';
  elementId?: string;
  message: string;
}
export interface CadSnapshot {
  content: CadDocument;
  contentHash: string;
  geometryState: CadGeometryState;
  evaluation: CadEvaluation | undefined;
  /** Why the current content has no shape, with the feature or body that caused it. */
  geometryFailure: string | undefined;
  /** The same failure for a Host or an assistant to read: code, part, operation and reason. */
  failureReport: CadFailureReport | undefined;
  /**
   * U4: what the failed current content still shows: the bodies outside the failure, and the
   * failed bodies drawn as their shape before the failure (display only).
   */
  partialFailure: { shown: number; before: { body: string; feature: string }[] } | undefined;
  /** The current content fails on broken references, which can be chosen again. */
  canRebindCurrent: boolean;
  /** Meshes of exactly the current content, or of an earlier content while re-evaluating. */
  meshes:
    | {
        contentHash: string;
        current: boolean;
        meshes: CadMesh[];
        /** The previewed choice of broken references: shown undimmed, never picked. */
        preview?: true;
      }
    | undefined;
  busy: boolean;
  /**
   * CM-4 (P3): how far the running evaluation got when it goes on in more than one job (features
   * and sketches in dependency order); undefined otherwise.
   */
  progress: { done: number; total: number } | undefined;
  /** CM-4: the running evaluation, an edit's or the current content's, can be stopped. */
  canStop: boolean;
  diagnostic: CadDiagnostic | undefined;
  selection: CadSelection;
  /** PMI-2: the PMI item of the selected body whose targets the view highlights. */
  pmiFocus: { bodyId: string; itemId: string } | undefined;
  /**
   * PMI-3b: the saved view of the selected body's PMI the viewport shows: its camera, and only
   * the PMI it shows.
   */
  pmiView: { bodyId: string; viewId: string; chosen: number } | undefined;
  /** The picked face or edge, read from the current meshes' pick table. */
  topology: CadTopologyInfo | undefined;
  canUndo: boolean;
  canRedo: boolean;
  /** The Host gives edit authority (history and migration stay possible on a reference display). */
  canEdit: boolean;
  /** No edits: the Host gives no edit authority, or the shape is a reference display. */
  readOnly: boolean;
  /**
   * The shape comes from a Host-approved newer build because the document's own build is not
   * available: a read-only reference whose match with the saved shape is not confirmed.
   */
  reference: { effectiveBuildHash: string } | undefined;
  /** An explicit migration to the Host's current build is possible (edit authority, other build). */
  canMigrate: boolean;
  /** A prepared migration waiting for the editor to adopt or cancel it. */
  migration: CadMigrationPreview | undefined;
  /** K2: the document's tolerance set (`standard` or `large`). */
  toleranceSet: CadToleranceSet | undefined;
  /** The tolerance set can be changed now (edit authority, nothing evaluating or prepared). */
  canChangeTolerance: boolean;
  /** Broken references being chosen again, with the preview of the current choice. */
  rebind: CadRebindView | undefined;
  /**
   * The previewed choice's content and evaluation while it is ready, so an assembly shows its
   * parts' versions and solved poses (R2b-2b) as the body meshes show its shapes.
   */
  rebindPreview: { content: CadDocument; evaluation: CadEvaluation } | undefined;
  /** Increments whenever an edit is rejected, so uncommitted fields can reset. */
  rejections: number;
  /**
   * D2 STEP import is offered: the Host keeps asset bytes, edits are allowed and the document's
   * exact build is shown (not a reference).
   */
  canImportStep: boolean;
  /** A read STEP file waiting for the editor to insert or cancel it (preflight report). */
  stepImport: CadStepImportPreview | undefined;
  /** Sketch mode: the drawing, which is no edit until it is finished. */
  sketch: CadSketchView | undefined;
  /** Sketch mode can start: edit authority, no reference display, nothing pending. */
  canSketch: boolean;
  /**
   * Edges collected from picks for a boundary surface, fill or loft section (R2a-2c), in the
   * order picked, each with its readable name and whether a face lies beside it on one side only.
   */
  collectedEdges: CadCollectedEdge[];
  /**
   * The continuity check of the picked edge (R2a-4): running, or its report. Only for the
   * current pick on the current content; display only, never part of the content.
   */
  continuity: CadContinuityView | undefined;
  /**
   * The curvature comb of the picked edge's curve (R2a-4), like `continuity`: for the current
   * pick on the current content only, display only.
   */
  comb: CadCombView | undefined;
  /**
   * The mean and Gauss curvature at the current content's display mesh nodes (R2a-4), computed
   * by the exact build on request. Display only; gone once the content changes.
   */
  curvature: CadCurvatureView | undefined;
  /**
   * CR3d: the gap and flush between two bodies' facing border edges: the first edge chosen, then
   * running or the samples and their report. For the current content only; display only.
   */
  gapFlush: CadGapFlushView | undefined;
  /** CR4e: the first flange of a new spot weld row, chosen on the current content. */
  weldStart: { bodyId: string; pick: number } | undefined;
  /** CR4e: each spot weld row's points as the current content's evaluation made them. */
  spotWelds: CadSpotWeldPoints[] | undefined;
}
/** CR3d: an edge by its body and pick number. */
export interface CadGapFlushEdge {
  bodyId: string;
  pick: number;
}
export type CadGapFlushView =
  | { from: CadGapFlushEdge; status: 'chosen' }
  | { from: CadGapFlushEdge; to: CadGapFlushEdge; status: 'running' }
  | {
      from: CadGapFlushEdge;
      to: CadGapFlushEdge;
      status: 'done';
      samples: CadGapFlushSample[];
      report: CadGapFlushReport;
    };
export type CadCombView =
  | { bodyId: string; pick: number; status: 'running' }
  | {
      bodyId: string;
      pick: number;
      status: 'done';
      samples: CadCombSample[];
      /** The comb scale (mm per 1/mm) at which the longest tooth is a fifth of the edge's size. */
      scale: number;
    };
export type CadCurvatureView =
  | { status: 'running' }
  | { status: 'done'; bodies: CadBodyCurvature[] };
export type CadContinuityView =
  | { bodyId: string; pick: number; status: 'running' }
  | { bodyId: string; pick: number; status: 'done'; report: CadContinuityReport };
export interface CadCollectedEdge {
  ref: CadTopologyRef;
  label: string;
  /** One face beside it (a free edge): a fill can meet that face G1. */
  free: boolean;
}
/**
 * Sketch mode (docs/cad/r1-modeling.md, Surface): the drawing as solved after every change, its
 * degrees of freedom, and the last change the solver refused with the elements it named.
 */
export interface CadSketchView {
  sketch: CadSketch;
  dof: number;
  /** A new sketch (Finish inserts it) or an existing one (Finish updates it). */
  isNew: boolean;
  /** The refused change: shown and highlighted, never applied. */
  problem?: { code: string; message: string; elements: string[] };
  /** The region the drawing closes, which Finish and extrude would sweep. */
  region: CadSketchRegion | undefined;
}
/**
 * The Host's immutable asset bytes (docs/cad/integration.md, asset closure). The content names
 * assets only by ref; this is where their bytes live.
 */
export interface CadAssetStore {
  /** Bytes the Host keeps for a ref's `sha256:<hex>`, if any. */
  get(sha256: string): Uint8Array | undefined;
  /**
   * Keeps the bytes durably before any content names them: the Host checks hash, size and
   * capacity, then stores them (unreferenced bytes may stay if a later step fails). Throws
   * with a message for the user when it cannot.
   */
  stage(assets: { ref: CadAssetRef; bytes: Uint8Array }[]): Promise<void>;
}
/** A STEP file read by the document's build, before it becomes one imported body. */
export interface CadStepImportPreview {
  fileName: string;
  report: CadStepImportReport;
  /** #820: the document's result limit; a body read less precisely can be placed, not machined. */
  resultLimitMm: number;
}
/**
 * #663: the image work a GLB's textures need, in the Host (the browser decodes and encodes
 * images). Each returns a PNG.
 */
export interface CadTextureImageTools {
  /**
   * glTF's metal/roughness image: green from the roughness map's green, blue from the metalness
   * map's blue (what the view reads of each), 255 for a map not given; the size of the first.
   */
  packMetallicRoughness(
    roughness?: CadExportImage,
    metalness?: CadExportImage,
  ): Promise<Uint8Array>;
  /** A DirectX normal map with its green flipped, as glTF's are OpenGL. */
  flipNormalGreen(normal: CadExportImage): Promise<Uint8Array>;
}
export interface CadControllerOptions {
  session: CadSession;
  kernel: CadKernelPort;
  canEdit(): boolean;
  permissionGeneration(): number;
  newId?: (prefix: string) => string;
  /** Called after an edit is applied to the session, e.g. so the Host persists its draft. */
  onApplied?(content: CadDocument): void;
  /** Re-evaluates exact content with an export triangulation (WorkerKernelPort.exportMeshes). */
  exportMeshes?(
    request: CadEvaluateRequest,
    deflectionMm: number,
  ): Promise<{ evaluation: CadEvaluation; meshes: CadMesh[] }>;
  /** #663: packs and converts texture images for GLB; without it such maps are left out. */
  textureImages?: CadTextureImageTools;
  /** Re-evaluates exact content and writes its active bodies as STEP (CatalogKernelPort.exportStep). */
  exportStep?(
    request: CadEvaluateRequest,
  ): Promise<{ evaluation: CadEvaluation; step?: Uint8Array; stepPmi?: CadStepPmiWritten }>;
  /**
   * Re-evaluates exact content and samples one edge's continuity, by its index in the body's
   * pick table (CatalogKernelPort.analyzeContinuity, R2a-4).
   */
  analyzeContinuity?(
    request: CadEvaluateRequest,
    edge: { bodyId: string; edge: number },
  ): Promise<{
    evaluation: CadEvaluation;
    continuity?: { samples: CadContinuitySample[] } | { code: string };
  }>;
  /** Re-evaluates exact content with each mesh node's curvature (CatalogKernelPort.analyzeCurvature). */
  analyzeCurvature?(
    request: CadEvaluateRequest,
  ): Promise<{ evaluation: CadEvaluation; curvature?: CadBodyCurvature[] }>;
  /** Re-evaluates exact content and samples one edge's comb (CatalogKernelPort.analyzeComb). */
  analyzeComb?(
    request: CadEvaluateRequest,
    edge: { bodyId: string; edge: number },
  ): Promise<{
    evaluation: CadEvaluation;
    comb?: { samples: CadCombSample[] } | { code: string };
  }>;
  /** CR3d: re-evaluates exact content and samples the gap and flush between two border edges. */
  analyzeGapFlush?(
    request: CadEvaluateRequest,
    edges: { a: { bodyId: string; edge: number }; b: { bodyId: string; edge: number } },
  ): Promise<{
    evaluation: CadEvaluation;
    gapFlush?: { samples: CadGapFlushSample[] } | { code: string };
  }>;
  /** The Host's current kernel build, the target of an explicit migration. */
  currentKernel?: { id: string; buildHash: string };
  /** D2: reads STEP with the document's exact build (CatalogKernelPort.importStep). */
  importStep?(
    profile: CadDocument['kernelProfile'],
    requestId: string,
    bytes: Uint8Array,
    options?: CadStepImportOptions,
  ): Promise<CadStepImportResult>;
  /** D2: the Host's asset bytes. Without it, documents with imported bodies cannot evaluate. */
  assets?: CadAssetStore;
  /** The Host's stored-size admission (CAD23); passed to the coordinator. */
  admission?: CadAdmission;
  /** Main-thread budget for retained meshes; a Host may make it smaller (CAD26). */
  budget?: { mainBytes?: number; mainEntries?: number };
}
/**
 * Session budgets (docs/cad/operations.md, Cacheの保持予算; CAD26): main-thread buffers of the
 * current, candidate and history meshes, and GPU buffers of what the viewport shows. The
 * Worker's own limits (64 MiB transferred, one kept evaluation) are enforced in the kernel.
 */
export const cadBudgets = Object.freeze({
  mainBytes: 128 * 1024 * 1024,
  mainEntries: 3,
  gpuBytes: 128 * 1024 * 1024,
});
/** Bytes of the buffers these meshes hold, each allocation counted once. */
/** Bytes of node curvature arrays, shared buffers once. */
function curvatureBytes(bodies: CadBodyCurvature[]): number {
  const buffers = new Set(bodies.flatMap((b) => [b.mean.buffer, b.gauss.buffer]));
  return [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
}
export function retainedBytes(meshes: Iterable<CadMesh>): number {
  const seen = new Set<ArrayBufferLike>();
  let bytes = 0;
  for (const m of meshes) {
    const buffers = [
      m.positions,
      m.normals,
      ...(m.uvs ? [m.uvs] : []),
      m.indices,
      m.faceIds,
      m.vertices,
      m.edges,
      m.edgeIds,
    ];
    for (const { buffer } of buffers)
      if (!seen.has(buffer)) {
        seen.add(buffer);
        bytes += buffer.byteLength;
      }
    bytes += topologyBytes(m.topology) + pmiTrackingBytes(m.pmi);
  }
  return bytes;
}
/**
 * PMI-2: the PMI a body carries, with its asset read from the Host's bytes. PMI-4a: past a
 * change of the shape, `items` says which are current (by the evaluation's `tracking`).
 */
export interface CadBodyPmiView {
  state: CadBodyPmi;
  asset?: CadPmiAsset;
  unreadable?: true;
  items?: ReadonlyMap<string, CadPmiItemState>;
  tracking?: CadPmiTracking;
}
/**
 * The new build's exact result for the current recipe, shown before the migration is adopted.
 * `shown` holds the metrics on screen before (a reference display), when there were any.
 */
/** R2b-2b: an edit prepared for its preview (`prepareEdit`). */
export type CadEditPreview =
  | { status: 'ready'; candidate: CadDocument; evaluation: CadEvaluation & { status: 'ok' } }
  | { status: 'broken'; candidate: CadDocument; evaluation: CadEvaluation & { status: 'error' } };
export interface CadMigrationPreview {
  fromBuildHash: string;
  toBuildHash: string;
  /** K2 (docs/cad/complex-models.md): a change of the tolerance set, on the same build. */
  tolerance?: { from: CadToleranceSet | undefined; to: CadToleranceSet };
  /** The shown shape's failure when it has nothing to compare with (K2). */
  shownCode?: string;
  bodies: { id: string; name: string; shown?: CadBodyEvaluation; next: CadBodyEvaluation }[];
}
/**
 * Choosing broken references again (r1-modeling.md, 分かれた要素の選び直し): an edit, or the current
 * content, failed because references of a feature are ambiguous or missing. Each choice is
 * evaluated as a preview; confirming applies the edit and the bindings as one edit.
 */
/** One feature's broken references being chosen again; `previous` is the feature before it. */
interface RebindState {
  edit: Exclude<CadOperation, { type: 'rebindReferences' | 'withSolvedPoses' }> | undefined;
  /** Bindings chosen in earlier rounds (a choice can break a later feature in turn). */
  earlier: CadReferenceBinding[];
  featureId: string;
  problems: CadReferenceProblem[];
  choices: number[];
  view: CadRebindView;
  ticket?: CadTicket;
  /** The ready preview's candidate and evaluation. */
  preview?: { content: CadDocument; evaluation: CadEvaluation };
  /** Bumped per preview; a late preview of an older choice is dropped. */
  round: number;
  /** The earlier feature whose choice broke this one's references, to go back to. */
  previous?: RebindState;
}
export interface CadRebindView {
  /** The failed feature's name, for the panel's title. */
  featureName: string;
  /** Whether an upstream edit is part of it (otherwise the current content is broken). */
  withEdit: boolean;
  problems: {
    path: (string | number)[];
    status: 'ambiguous' | 'missing';
    /** The stored reference's name. */
    name: CadTopoName | undefined;
    candidates: { hint: CadTopologyRef['hint']; selectable: boolean }[];
    /** Index into `candidates`, or -1 when none can be chosen. */
    choice: number;
  }[];
  /** The problem whose candidate was changed last (marked on the preview). */
  active: number;
  /** Whether an earlier feature's choice led here, and can be chosen again (`backRebind`). */
  canGoBack: boolean;
  /** `blocked`: a reference has no candidate that can be chosen. */
  status: 'evaluating' | 'ready' | 'failed' | 'blocked';
  /** Why the preview of the current choice failed. */
  message?: string;
  /** Content hash of the previewed choice, whose meshes the viewport shows. */
  previewHash?: string;
}
/** A mesh file of exactly the confirmed content, with what it keeps and loses. */
export interface CadMeshExport {
  bytes: Uint8Array;
  report: CadExportReport;
}

/** Standard STL triangulation (mm); the dialog also offers a finer one. */
export const stlDeflectionMm = 0.05;
const messages: Record<string, string> = {
  'multiple-solids':
    'この操作では、1つのbodyが1,024個を超える離れたsolidに分かれるため確定できません。patternの数を減らすか、bodyを分けてください。',
  'solids-touching':
    'この操作では、離れたsolidどうしが辺か頂点だけで接する形になるため確定できません。少し重ねるか、離してください。',
  'limit-solids':
    '表示中のbodyのsolidは、合わせて4,096個までです。patternの数を減らすか、いらないbodyを消してください。',
  'empty-result': 'この操作では形状が残りません。',
  'boolean-no-overlap':
    '工具のbodyが対象に重なっていないため、差し引けません（接するだけの形を含みます）。',
  'invalid-solid': 'この寸法では有効な形状を作れません。',
  'sheet-not-solid':
    '面だけのbody（surface）には体積がないため、この操作には使えません（Boolean・殻・抜き勾配・丸め・面取り・pattern・STLの書き出しなど）。',
  'body-kind': 'bodyの種類（solid・surface）が、作ったfeatureの結果と合いません。',
  'result-kind': '計算結果の形状の種類（solid・surface）が想定と違うため、確定できません。',
  'sheet-disconnected': '面がつながっていないため、1つのsurfaceにできません。',
  'invalid-sheet': 'この寸法では有効な面を作れません。',
  'surface-failed': 'この形と寸法では面を作れません。',
  'surface-path':
    'このスケッチの線と円弧は、1本につながった鎖（または1つの輪）になっていないため、面を作れません。',
  'boolean-failed': 'Booleanの計算に失敗しました。',
  'boolean-incomplete':
    'unionの計算結果から、入力したbodyの一部が抜け落ちたため確定できません。多数の部材の端が1点に集まると起きやすいです。部材の端を交点から少し離すか、unionをやめて別のbodyのままにしてください。',
  'result-tolerance':
    '計算結果の誤差が上限（0.0001 mm）を超えるため確定できません。曲面どうしが浅い角度で交わるBooleanや鏡写しで起きやすいです。交わり方を変えるか、Booleanをやめて別のbodyのままにしてください。',
  'output-limit': '表示できる形状の上限を超えています。',
  'pmi-invalid':
    '取り込んだPMIの記録が形状と合いません（存在しない面・辺・頂点を指しているなど）。STEPファイルを取り込み直してください。',
  'assembly-pmi-invalid':
    '組立のPMIの記録が読めません（記録にないcomponentや、部品の形に無い面を指しているなど）。STEPファイルを取り込み直してください。',
  'kernel-unavailable': '形状計算を開始できません。再計算を試してください。',
  'kernel-build-unavailable': 'この文書の計算に必要なkernelがありません。',
  'kernel-build-revoked': 'この文書のkernelは安全上の理由で使えなくなりました。',
  'kernel-reference-only':
    '参考表示の形状では編集・計測・書き出しはできません。現在のkernelへ移行してください。',
  'kernel-build-unchanged': 'この文書はすでに現在のkernelを使っています。',
  'expression-type':
    '式の単位が合いません（長さと角度の足し算、長さどうしの掛け算、長さのsinなど）。',
  'expression-division-by-zero': '式が0で割っています。',
  'expression-domain': '式の関数に使えない値です（負の数の平方根など）。',
  'expression-non-finite': '式の値が大きすぎて計算できません。',
  'parameter-cycle': 'parameterの式が循環しています（自分自身を参照しています）。',
  'parameter-dependency': 'このparameterの式が読むparameterが正しくありません。',
  'parameter-missing': '式が存在しないparameterを参照しています。',
  'count-range': 'countは1から1,000までの整数にしてください。',
  'limit-active-bodies':
    '表示中のbodyは64個までです。Booleanのtoolとして使ったbodyは数えません。いらないbodyを消すか、Booleanでまとめてください。',
  'limit-bodies': '文書のbodyは、Booleanで使ったものを含めて1,024個までです。',
  'limit-expression-nodes': '式が長すぎます（1式に256項目、文書全体で16,384項目まで）。',
  'limit-expression-depth': '式の入れ子が深すぎます（32段まで）。',
  'limit-parameter-depth': 'parameterの式のつながりが長すぎます（64段まで）。',
  timeout:
    '形状計算が時間内に終わりませんでした。大きなBooleanやpatternを小さく分けるか、要素の数を減らしてください。',
  'permission-denied': '編集権限がありません。',
  'permission-changed': '権限が変わったため、もう一度操作してください。',
  stale: '計算中に内容が変わったため、結果を採用しませんでした。',
  'delete-has-dependents': 'ほかの要素が使っているため削除できません。',
  'placement-bound': '位置がparameterに結び付いているため、直接移動できません。',
  'move-edge-on':
    '水平面をほぼ真横から見ているため、dragでは位置が定まりません。視点を傾けるか、Inspectorの座標で移動してください。',
  'export-no-shape': '出力できる形状がありません。',
  'export-busy': '形状を計算中です。計算が終わってから、もう一度操作してください。',
  'png-not-drawn':
    '形状を3D表示していないため、PNGは書き出せません（表示のメモリー上限か、3D表示を利用できない状態）。STEP・STL・GLBは書き出せます。',
  'export-mismatch': '出力用の計算結果が現在の形状と一致しないため、出力しませんでした。',
  'mesh-open': '三角形が閉じた形状にならないため、出力しませんでした。',
  'mesh-degenerate': '面積のない三角形ができたため、出力しませんでした。',
  'mesh-precision':
    '原点から遠い小さな形状で、STLの座標の精度（float32）では形が保てないため、出力しませんでした。',
  'mesh-empty': '出力できる三角形がありません。',
  'step-write-failed': 'STEPを書き出せませんでした。',
  'step-unsupported-build':
    'この文書のkernel buildはSTEPを書き出せません。「Migrate to current kernel」で現在のbuildへ移行してから書き出してください。',
  'export-timeout':
    '書き出しの三角形分割が時間内に終わりませんでした。大きなモデルではTriangulationを粗く（Coarse）してください。',
  'step-invalid': '書き出したSTEPが正しい形式ではないため、出力しませんでした。',
  superseded: '別の計算が始まったため、出力を中止しました。もう一度操作してください。',
  'asset-missing': '取り込んだ形状のデータがこのHostにないため、計算できません。',
  'asset-hash-mismatch': '取り込んだ形状のデータが記録と一致しないため、計算しませんでした。',
  'asset-unreadable': '取り込んだ形状のデータを読めませんでした。',
  'step-import-unavailable': 'このHostではSTEPを取り込めません（資産を保存できません）。',
  'step-too-large': 'STEP fileが大きすぎます（64 MiBまで）。',
  'step-export-too-large': '書き出すSTEP fileが大きすぎます（64 MiBまで）。',
  'memory-budget':
    'この形状のデータは、表示に使えるメモリーの上限を超えます。編集は入れていません。bodyや細部を減らしてください。',
  'native-too-large':
    'この編集を入れると、保存する文書（native file）が上限を超えます。編集は入れていません。',
  'native-size-unavailable':
    '保存する文書の大きさを確かめられなかったため、編集を入れませんでした。もう一度操作してください。',
  'step-unreadable': 'STEP fileとして読めませんでした。',
  'step-schema-unsupported':
    'このSTEPの規格（application protocol）には対応していません。AP203・AP214・AP242のどれかで保存してください。',
  'step-external-reference': '別のfileを参照するSTEPは取り込めません。',
  'step-pmi':
    '寸法・公差などの製品情報（PMI）を含むSTEPは、このkernelでは読めないため取り込めません。形状だけを書き出したSTEPを使ってください。',
  'step-pmi-partial':
    'このSTEPには寸法・公差などの製品情報（PMI）があり、取り込むとPMIは文書に残りません。内訳を確かめ、PMIなしで取り込むかを選んでください。',
  'step-assembly':
    'assembly（部品の組み合わせ）のSTEPは、空の文書に取り込むと部品を並べたassemblyになります。body を持つ文書には1つの部品のSTEPだけを取り込めます。',
  'step-unit-unknown': 'STEPの長さの単位が分からないため、取り込めません。',
  'step-no-solid': 'STEPにsolidも面（shell）もありません。',
  'step-multiple-solids': 'STEPに複数のsolidがあります。1つのsolidだけを取り込めます。',
  'step-not-single-solid':
    'STEPに、取り込むsolidまたは面のまとまりに属さない面・線があります。1つのsolidか、1つのつながった面のまとまりだけを取り込めます。',
  'step-multiple-shells':
    'STEPの面が複数のまとまりに分かれています。1つのつながった面のまとまりだけを取り込めます。',
  'step-invalid-sheet':
    'STEPの面のまとまりが有効な形状ではないため、取り込めません（自動修正はしません）。',
  'step-invalid-solid':
    'STEPのsolidが有効な形状ではないため、取り込めません（自動修正はしません）。',
  'step-tolerance-unsupported': `STEPの形状の許容誤差（tolerance）が${cadImportToleranceMm} mmより大きいため、取り込めません（自動修正はしません）。`,
  'input-tolerance':
    '取り込んだ形状の許容誤差（tolerance）が文書の上限より大きいため、この形状は配置・計測・書き出しだけに使えます。Booleanなどの加工には使えません。',
  'imported-tolerance': '取り込んだ形状の許容誤差の記録が不正です。',
  'step-coordinate-range': `STEPの形状が座標の上限（${cadRangeLimit('step-coordinate-range')}）を超えています。`,
  'coordinate-range': `座標が上限（${cadRangeLimit('coordinate-range')}）を超えています。原点の近くに置くか、値を小さくしてください。`,
  'dimension-range': `寸法は${cadRangeLimit('dimension-range')}の範囲にしてください。`,
  'step-import-unsupported-build':
    'この文書のkernel buildはSTEPを取り込めません。「Migrate to current kernel」で現在のbuildへ移行してから取り込んでください。',
  'step-import-timeout': 'STEPの読み込みが時間内に終わりませんでした。',
  'step-import-interrupted': 'STEPの読み込みが中断されました。もう一度取り込んでください。',
  'step-import-changed': '読み込んだ後に文書のkernelが変わったため、もう一度取り込んでください。',
  'asset-stage-failed': 'STEPのデータを保存できませんでした。',
  'texture-stage-failed': 'テクスチャの画像を保存できませんでした。',
  'texture-unavailable': 'このHostは画像を保存できないため、テクスチャを使えません。',
  'texture-empty': '使える画像がありません。',
  'texture-media-type': 'テクスチャはPNGかJPEGの画像だけ使えます。',
  'texture-stale':
    '画像を保存している間に文書が変わりました。もう一度テクスチャを追加してください。',
  cancelled: '計算を取り消しました。',
  'reference-ambiguous':
    '参照していた面・辺が分かれて、どれを指すか決まりません。候補から選び直してください。',
  'reference-missing': '参照していた面・辺が無くなりました。',
  'reference-unnamed': 'この面・辺は名前を持たない（取り込んだbodyの）ため、参照できません。',
  'reference-not-selectable': '同じ名前の面・辺が隣の名前まで同じで、この1つだけを参照できません。',
  'selection-stale': '選んだ面・辺は今の形状のものではありません。選び直してください。',
  'draft-neutral-not-planar': '抜き勾配の中立面には平らな面を選んでください。',
  'draft-neutral-plane': '傾ける面が中立面と交わらないため、抜き勾配を付けられません。',
  'draft-faces': '中立面の周りに傾ける面がありません。',
  'draft-failed': 'この角度では抜き勾配を付けられません。',
  'fillet-failed': 'この半径では丸められない辺があります。',
  'offset-failed':
    'この距離ではoffsetできません（曲率半径より大きい距離では面が裏返ります）。距離を小さくしてください。',
  'offset-distance': 'offsetの距離は0.01〜100 mmにしてください。',
  'offset-side': 'offsetの向きは表（法線の向き）か裏にしてください。',
  'offset-source': 'offsetするsheetを選んでください。',
  'panel-gap': 'panelの隙間は0.5〜10 mmにしてください。',
  'panel-source': 'panelを切り出すsheetを選んでください。',
  'trim-gap-tool': '隙間を付けたtrimには、sketchの閉じた線を使ってください。',
  'trim-chains': '一度に抜ける閉じた線は、道具の線と合わせて1〜32本です。',
  'trim-chains-shared': '同じsketchの要素を2つの閉じた線で使うことはできません。',
  'trim-chains-tool': '複数の閉じた線とifMissedは、sketchの線で切るtrimだけに使えます。',
  'trim-if-missed': 'ifMissedに使える値はskipだけです。',
  'trim-disconnected':
    '抜いた後の面が2つ以上に分かれます。分けている閉じた線を外すか、面の内側に収めてください。',
  'detail-panel': 'panelは、同じbodyのtrimと一緒に、trimの前の形から切り出してください。',
  'split-failed': 'この線ではsheetを分けられません。',
  'press-line-failed':
    'このプレスラインは作れません。深さを大きくするかRを小さくしてください（段の高さに対してRが大きすぎると丸められません）。',
  'press-line-depth': 'プレスラインの深さは0.1〜20 mmにしてください。',
  'press-line-side': 'ずらす側は、開いた線なら左か右、閉じた線なら内か外にしてください。',
  'press-line-toward': 'ずらす向きは表（法線の向き）か裏にしてください。',
  'flare-failed':
    'このフレアは作れません。線がアーチを囲んでsheetの縁から縁へ通っているか確かめ、高さを変えてみてください。',
  'flare-height': 'フレアの高さは1〜100 mmにしてください。',
  'flare-continuity': 'sheetとのつなぎはG1かG2にしてください。',
  'flare-chain-closed': 'フレアの線は開いた線にしてください（sheetの縁から縁へ）。',
  'flare-arch-not-free': 'アーチにはsheetの縁の辺を選んでください。',
  'flare-arch-side':
    'アーチが線のどちら側か決まりません。線がアーチを片側に分けているか確かめてください。',
  'flange-failed': 'このフランジは作れません。幅か角度を変えてみてください。',
  'profile-sweep-failed': 'この断面は経路に沿わせられません。経路と断面の向きを確かめてください。',
  'profile-sweep-tight':
    '経路の曲がりが断面より急です。曲がりのRを大きくするか、断面を小さくしてください。',
  'profile-up': '断面の向きは経路に直角な長さ1の向きにしてください。',
  'profile-up-curved':
    '向きを数値で決めるのは、まっすぐな経路だけです。曲がる経路では面の法線か面の中にしてください。',
  'profile-radius': '角のRが断面の辺に収まりません。Rを小さくしてください。',
  'profile-flange': 'ハットとZの断面にはフランジの幅（1 mm以上）が要ります。',
  'profile-kind': '断面の型はハット・Z・チャンネル・平板のどれかにしてください。',
  'profile-height': '断面の高さは1〜500 mmにしてください。',
  'profile-width': '断面の幅は1〜500 mmにしてください。',
  'profile-flange-range': 'フランジの幅は0〜200 mmにしてください。',
  'profile-radius-range': '角のRは0〜50 mmにしてください。',
  'spot-weld-no-start': '先に1枚目のフランジの面を選んでください。',
  'spot-weld-same-body': 'スポット溶接は別のbodyのフランジどうしで結んでください。',
  'spot-weld-unchanged': 'スポット溶接の値が変わっていません。',
  'proportions-unchanged': '比率の設定が変わっていません。',
  'proportions-body': '比率の設定に、今のbodyでないものがあります。',
  'proportions-body-twice': '1つのbodyを比率の2つの役に入れることはできません。',
  'proportions-ground': '地面の高さは±10,000,000 mm以内の数です。',
  'proportions-band': '目安は数で、下限は上限以下です。',
  'spot-weld-pitch': 'スポット溶接のピッチは10〜200 mmにしてください。',
  'spot-weld-end-distance': '端からの距離は0〜100 mmにしてください。',
  'spot-weld-gap': '許す離れは0.1〜20 mmにしてください。',
  'spot-weld-short':
    'フランジが短く、端からの距離の内側に点が置けません。端からの距離を小さくしてください。',
  'spot-weld-points':
    '点が多すぎます（1列1,000点、文書全体で8,000点まで）。ピッチを大きくしてください。',
  'spot-weld-face-missing': 'スポット溶接のフランジの面が見つかりません。結び直してください。',
  'spot-weld-face-ambiguous': 'スポット溶接のフランジの面が1つに決まりません。結び直してください。',
  'spot-weld-failed': 'このフランジにはスポット溶接の点を置けません。',
  'flange-width': 'フランジの幅は1〜200 mmにしてください。',
  'flange-angle': 'フランジの角度は0より大きく180°以下にしてください。',
  'flange-toward': 'フランジを立てる向きは表（法線の向き）か裏にしてください。',
  'flange-edge-not-free': 'フランジにはsheetの縁の辺（面が1つだけの辺）を選んでください。',
  'flange-self-intersects':
    'フランジが自分や他のフランジ、元のsheetと交わります。幅を狭くするか角度を変えてください。',
  'split-missed': '線がsheetのどの面も分けません（面に届かないか、面の途中で止まっています）。',
  'split-side-undetermined':
    '分けた面がどちら側か決まりません。線が面の縁をなぞっていないか確かめてください。',
  'fillet-free-edge': 'sheetの縁の辺は丸められません。2つの面の間の辺を選んでください。',
  'fillet-radii-end': '途中のRを使うときは、終点のRも入れてください。',
  'fillet-radii': '途中のRは1〜6点（両端を入れて2〜8点）にしてください。',
  'fillet-radii-at': '途中のRの位置は0より大きく1より小さく、順に大きくしてください。',
  'chamfer-failed': 'この距離では面取りできない辺があります。',
  'shell-failed':
    'この厚さでは殻にできません（OCCTのoffsetが面のつなぎ目を作れませんでした）。厚さか開ける面を変えてください。薄い外板は、曲面（sheet）を作ってThickenで厚みを付けると作れることがあります。',
  'tolerance-set-unchanged': 'この文書はすでにその許容差の組です。',
  'tolerance-set-unknown': '許容差の組は standard か large から選んでください。',
  'shell-multiple-solids':
    '離れた複数のsolidからなるbodyは殻にできません。殻にするsolidを別のbodyにしてください。',
  'pattern-no-overlap': '対象に重ならない写しがあるため、差し引けません。',
  'pattern-path': '曲線に沿うpatternの経路には、線と円弧だけを使ってください。',
  'pattern-align': 'patternの向きの指定が正しくありません。',
  'mirror-face-not-planar': '鏡写しの基準には平らな面を選んでください。',
  'sketch-face-not-planar': 'スケッチを置く面には平らな面を選んでください。',
  'sketch-redundant-constraint':
    'この拘束は他の拘束から既に決まっています（重複）。追加しませんでした。',
  'sketch-conflicting-constraint': 'この拘束は他の拘束と矛盾するため、追加しませんでした。',
  'sketch-not-converged': 'スケッチの拘束を満たす位置が見つかりません。変更しませんでした。',
  'sketch-self-intersection': 'スプラインが自分自身と交わっています。制御点を動かしてください。',
  'sketch-offset-chain':
    'offsetするには、端と端がつながった1本の鎖（線・円弧・開いたスプライン）か、円・閉じたスプライン1つを選んでください。',
  'sketch-offset-distance': 'offsetの距離は0.1〜200 mmにしてください（負の値で反対側）。',
  'sketch-offset-self-intersects':
    'この距離でずらすと、線が自分自身と交わるか要素が消えます。距離を小さくするか反対側にしてください。',
  'sketch-offset-fit':
    'ずらしたスプラインを制御点256個で0.01 mm以内に当てはめられません。距離を小さくするか、元のスプラインを分けてください。',
  'sketch-spline-poles': 'スプラインの制御点の数が範囲の外です（4〜256個、次数+1個以上）。',
  'sketch-spline-degree': 'スプラインの次数は2・3・5のどれかにしてください。',
  'sketch-degenerate':
    'スケッチの要素が潰れる（長さ・半径が0になる、円が重なる）ため、変更しませんでした。',
  'sketch-dimension-range': `寸法が範囲（${cadRangeLimit('sketch-dimension-range')}）の外です。変更しませんでした。`,
  'sketch-reference': 'スケッチの拘束が無い要素を指しています。',
  'sketch-solution-mismatch': 'スケッチの保存された位置が拘束を満たしていません。',
  'sketch-unavailable': '今はスケッチを始められません（編集中の操作を先に終えてください）。',
  'sketch-open': 'スケッチを終えるか取り消してから編集してください。',
  'sketch-no-region': '閉じた領域が無いため押し出せません。線・円弧をつないで輪を閉じてください。',
  'region-open': 'スケッチの領域が閉じていません。',
  'region-loop': 'スケッチの領域の輪が正しくつながっていません。',
  'region-element': '領域には作図線（construction）や点は使えません。',
  'region-overlap': 'スケッチの領域の輪どうしが重なっています。',
  'region-self-intersection': 'スケッチの領域の輪が自分と交差しています。',
  'region-hole-outside': '穴が外側の輪からはみ出しています。',
  'region-hole-nested': '穴の中に穴があります。',
  'section-region': '断面のsketchに閉じた領域がありません。',
  'section-holes': 'loft・sweepの断面には穴のない領域を使ってください。',
  'loft-sections': 'loftには2つ以上の断面が要ります。',
  'limit-loft-sections': 'loftの断面は32個までです。',
  'loft-same-sketch': 'loftの断面はそれぞれ別のsketch（別の平面）にしてください。',
  'derived-section-source': '派生断面は、同じloftのそれより前のsketchの断面から作ってください。',
  'derived-section-scale': '派生断面の倍率は0.001〜1000にしてください。',
  'loft-failed': 'この断面の組ではloftを作れません（同じ平面の断面、ねじれ・自己交差）。',
  'sweep-path': 'sweepの経路にするsketchが、線・円弧のつながった1本の開いた鎖になっていません。',
  'sweep-path-element': 'sweepの経路には線と円弧を1回ずつ使ってください。',
  'sweep-path-gap': 'sweepの経路の要素がつながっていません。',
  'sweep-path-closed': 'sweepの経路は閉じていない鎖にしてください。',
  'sweep-path-self-intersection': 'sweepの経路が自分と交差しています。',
  'sweep-same-sketch': 'sweepの断面と経路は別のsketchにしてください。',
  'sweep-failed': 'この経路ではsweepを作れません（断面より小さい半径で曲がる、自己交差する）。',
  'region-edge-failed': 'スケッチの領域の辺を作れません。',
  'region-face-failed': 'スケッチの領域から面を作れません。',
  'boolean-tools': 'Booleanのtoolの指定が正しくありません。',
  'loft-section-closure': '面のloftでは、開いた鎖と閉じた輪の断面を混ぜられません。',
  'loft-section-gap': 'loftの断面にした辺が1本の鎖につながっていません。',
  'boundary-curves': '境界曲面の曲線は3本か4本にしてください。',
  'boundary-curve':
    '境界の曲線には、端が2つある線・円弧・開いたspline、または結果の辺を1本ずつ使ってください。',
  'boundary-curve-duplicate': '同じ曲線を境界に2回使っています。',
  'boundary-open': '境界の曲線が、並べた順に端どうしでつながって閉じた輪になっていません。',
  'boundary-curve-unsupported':
    '境界曲面に使える参照した辺は線と円弧だけです。ほかの曲線の辺はfillで塞いでください。',
  'fill-boundary': 'fillの境界は3〜16本にしてください。',
  'fill-continuity': 'fillの境界のつながりはG0・G1・G2のどれかにしてください。',
  'fill-no-adjacent-face':
    'G1とG2は、隣に面が1枚だけある参照した辺にだけ使えます（sketchの曲線には隣の面がありません）。',
  'fill-g1-unreached':
    'fillをG1の辺の隣の面に0.1°以内で接するようにできません（直角に近い面など）。G0にするか境界を変えてください。',
  'fill-g2-unreached':
    'fillをG2の辺の隣の面と同じ曲率（差1%以内）にできません。G1にするか、境界や隣の面を変えてください。',
  'fill-failed': 'この境界ではfillを作れません。',
  'curve-network-curves': '曲線網の曲線は、縦・横とも2〜16本にしてください。',
  'two-view-curve':
    '2面の曲線には、側面の要素（side）と平面の要素（plan）を1つずつ指定してください。',
  'two-view-same-sketch': '2面の曲線の側面と平面は、別々のsketchの要素にしてください。',
  'two-view-plane':
    '2面の曲線の側面の要素はXZに平行な平面、平面の要素はXYに平行な平面のsketchに描いてください。',
  'two-view-not-monotonic':
    '2面の曲線の側面と平面の要素は、それぞれ前後（X）の一方向に進む線にしてください。折り返す線は2本に分けてください。',
  'two-view-no-overlap': '2面の曲線の側面と平面の要素が、前後（X）の同じ範囲にありません。',
  'two-view-fit':
    '2面の曲線を0.001 mm（曲線網では交わりの許容差の4分の1）以内の曲線にできません。急に曲がる所を滑らかにしてください。',
  'curve-network-tolerance': '曲線網の交わりの許容は0.0001〜1 mmにしてください。',
  'curve-network-gap':
    '曲線網の縦の曲線と横の曲線が許容の距離で交わっていません。示した2本が交わるように曲線を直すか、許容を広げてください。',
  'curve-network-order':
    '曲線網の曲線の並びが揃っていません。縦（横）の曲線は、横（縦）の曲線のどれとも同じ順に交わるように選んでください。',
  'curve-network-end':
    '曲線網の曲線の端が、外側の曲線との交点にありません。端の曲線で曲線網を閉じてください。',
  'curve-network-fit':
    '曲線網を許容の距離で通る面を作れません（制御点の数の上限）。曲線を減らすか、許容を広げてください。',
  'solid-not-sheet': 'trim・sew・thickenに使えるのはsurface body（面）だけです。',
  'trim-tool': 'trimの道具には、sketchの閉じた鎖・平面・別のsurface bodyのどれかを使ってください。',
  'trim-tool-open': 'trimに使うsketchの鎖は閉じた輪にしてください。',
  'trim-tool-self': 'trimの道具に、切る面そのものは使えません。',
  'trim-keep':
    'trimで残す側は、sketchの鎖なら内側（inside）か外側（outside）、平面・面なら表（front）か裏（back）にしてください。',
  'trim-normal': 'trimの平面の法線は長さ1の向きにしてください。',
  'trim-no-cut': 'trimの道具が面を切っていません。道具の位置や大きさを確かめてください。',
  'trim-side-undetermined':
    'trimの道具が面を切り抜けていないため、残す側を決められない片があります（道具が途中で終わる、面に接するだけ）。',
  'trim-empty': 'trimで残す側に面がありません。',
  'trim-failed': 'この道具では面をtrimできません。',
  'sew-tolerance': 'sewのつなぐ距離は0.000001〜0.0001 mmにしてください。',
  'sew-solid': 'sewでsolidにするかを指定してください。',
  'sew-same-input': 'sewに同じ面を2回入れています。',
  'sew-gap':
    'sewの許容差より大きい隙間があり、つながらない辺があります。面の端を合わせるか、許容差を見直してください（0.0001 mmまで）。',
  'sew-disconnected': 'sewする面どうしが離れていて、1つにつながりません。',
  'sew-not-closed': '面が閉じていないため、sewでsolidにできません。',
  'thicken-side': 'thickenの向きは表（front）・裏（back）・両側（both）にしてください。',
  'thicken-failed':
    'この厚さでは面に厚みを付けられません（面が角で折れている、厚さが曲がりの半径より大きく自分と交わる）。',
  'gap-flush-no-start': '先に1本目の縁を選んで「Gap from this edge」を押してください。',
  'gap-flush-same-body': '隙間と段差は、別のbodyの縁どうしで測ってください。',
  'gap-flush-edge-missing': '選んだ縁が今の形状に見つかりません。選び直してください。',
  'gap-flush-not-border':
    '隙間と段差は、面が片側にだけある縁（surface bodyの縁）で測ってください。',
  'gap-flush-apart': '2本の縁が向かい合う所がありません。向かい合う縁を選んでください。',
  'gap-flush-projection-failed': '1本目の縁を面の上に戻せなかったため、測れませんでした。',
  'gap-flush-mismatch': '計測の間に形状が変わったため、測り直してください。',
  'continuity-edge-missing': '選んだ辺が今の形状に見つかりません。選び直してください。',
  'continuity-free-edge': 'この辺には面が片側にしか無いため、つながりを調べられません。',
  'continuity-seam': 'この辺は1つの面の継ぎ目で、2つの面の間の辺ではありません。',
  'continuity-degenerate': 'この辺は点に縮んでいる（極）ため、つながりを調べられません。',
  'continuity-nonmanifold': 'この辺には3つ以上の面が付いているため、つながりを調べられません。',
  'continuity-projection-failed':
    '辺の標本点を両側の面に投影できず、つながりを調べられませんでした。',
  'curvature-edge-missing': '選んだ辺が今の形状に見つかりません。選び直してください。',
  'curvature-degenerate': 'この辺は点に縮んでいる（極）ため、曲率を示せません。',
  'curvature-no-curve': 'この辺には3Dの曲線が無いため、曲率を示せません。',
  'curvature-budget':
    '曲率の色は、表示に使えるメモリーの上限を超えるため示せません。表示するbodyを減らしてください。',
  'curvature-mismatch':
    '曲率を計算した形状が表示中の形状と一致しませんでした。もう一度表示してください。',
  'continuity-mismatch':
    'つながりを調べた形状が表示中の形状と一致しませんでした。もう一度調べてください。',
  'rebind-blocked':
    '無くなった参照があるため、この変更は確定できません。変更を取り消すか、参照しているfeatureを先に直してください。',
};
export function describeCode(code: string): string {
  const assembly = describeAssemblyCode(code);
  if (assembly) return assembly;
  const base = code.split(/[:@]/)[0];
  if (messages[base]) return messages[base];
  const duplicate =
    /^cad-invalid:duplicate-id@(\S+) \(ID "([^"]*)" is already used at (\S+)\)/.exec(code);
  if (duplicate)
    return `ID「${duplicate[2]}」が ${duplicate[3]} と ${duplicate[1]} で重複しています。body・feature・profile・parameter・named view の ID は文書の中で 1 つずつにしてください。`;
  if (code.startsWith('cad-invalid:')) {
    const reason = code.slice('cad-invalid:'.length).split('@')[0];
    if (messages[reason]) return messages[reason];
    if (reason.endsWith('-range')) return '値が許容範囲の外です。';
    return `この変更は確定できません（${reason}）。`;
  }
  if (base.startsWith('kernel-exception')) return kernelExceptionMessage(code);
  return `操作を確定できませんでした（${code}）。`;
}
/**
 * Known OCCT exceptions in plain words: the kernel's own text is not shown (integration.md,
 * 診断), only what the user can change.
 */
const kernelExceptions: [RegExp, string][] = [
  [
    /BRepFill.*(profiles are inconsistent|CompatibleWires|SameNumber)/,
    'loftの断面どうしを対応付けられません。隣り合う断面の形や大きさの差、間隔を小さくするか、断面の数を減らしてください（閉じたsplineの断面は始点の位置もそろえてください）。',
  ],
  [/BRepFill|ThruSections/, 'この断面の組ではloftを作れません。断面の形や間隔を見直してください。'],
  [/BRepAlgo|BOP|Boolean/, 'Booleanの計算に失敗しました。重なり方を少し変えてみてください。'],
];
function kernelExceptionMessage(code: string): string {
  for (const [pattern, text] of kernelExceptions) if (pattern.test(code)) return text;
  return 'この寸法では形状を作れません。';
}
/**
 * A geometry failure in a form a Host or an assistant can read (#589): the plain reason, the
 * kernel's own text apart, and the part and operation it happened in, by name and ID.
 */
export interface CadFailureReport {
  code: string;
  /** The plain reason shown to the user (describeCode). */
  message: string;
  retryable: boolean;
  /** `kernel-exception`: the kernel's exception type and text; kept out of `message`. */
  kernelReason?: string;
  /** The body (part) the failure belongs to: named directly, or the body built from the feature. */
  bodyId?: string;
  bodyName?: string;
  /** The operation that failed, its name and its type (extrude, boolean, fillet …). */
  featureId?: string;
  featureName?: string;
  operation?: string;
  sketchId?: string;
  sketchName?: string;
}
/** The active body built from `featureId` (a consumed one if no active body reads it). */
function bodyOfFeature(doc: CadDocument, featureId: string) {
  const reads = (b: CadDocument['bodies'][number]) =>
    upstreamFeatures(doc.features, [b.resultFeatureId]).has(featureId);
  return (
    doc.bodies.find((b) => b.state === 'active' && reads(b)) ?? doc.bodies.find((b) => reads(b))
  );
}
/** `failure` on `doc` as a report: what failed, where, and why. */
export function cadFailureReport(
  doc: CadDocument,
  failure: { code: string; featureId?: string; retryable?: boolean },
): CadFailureReport {
  const { code, featureId: elementId } = failure;
  const feature = doc.features.find((f) => f.id === elementId);
  const sketch = feature ? undefined : doc.sketches.find((s) => s.id === elementId);
  const body = feature
    ? bodyOfFeature(doc, feature.id)
    : sketch
      ? doc.features
          .filter((f) => featureSketches(f).includes(sketch.id))
          .map((f) => bodyOfFeature(doc, f.id))
          .find(Boolean)
      : doc.bodies.find((b) => b.id === elementId);
  const kernel = /^kernel-exception:(.+)$/s.exec(code)?.[1];
  return {
    code,
    message: describeCode(code),
    retryable: !!failure.retryable,
    ...(kernel ? { kernelReason: kernel } : {}),
    ...(body ? { bodyId: body.id, bodyName: body.name } : {}),
    ...(feature
      ? { featureId: feature.id, featureName: feature.name, operation: feature.type }
      : {}),
    ...(sketch ? { sketchId: sketch.id, sketchName: sketch.name } : {}),
  };
}
/** describeCode plus the part and the operation named by a kernel failure, found in `doc`. */
/**
 * CR3c: the closed chains a failed trim names (`trim-no-cut`, `trim-disconnected`), by number
 * and elements: "1番目（l1、l2、l3、l4）". Undefined for other failures.
 */
export function trimChains(
  doc: CadDocument,
  e: { code: string; featureId?: string; failedPaths?: (string | number)[][] },
): string | undefined {
  if (e.code !== 'trim-no-cut' && e.code !== 'trim-disconnected') return;
  const f = doc.features.find((x) => x.id === e.featureId);
  if (f?.type !== 'trim' || !('sketchId' in f.args.tool) || !e.failedPaths?.length) return;
  const all = [f.args.tool.elements, ...(f.args.chains ?? [])];
  const named = e.failedPaths.flatMap((p) => {
    const k = p[0] === 'tool' ? 0 : p[0] === 'chains' && typeof p[1] === 'number' ? p[1] + 1 : -1;
    return all[k] ? [`${k + 1}番目（${all[k].join('、')}）`] : [];
  });
  return named.length ? named.join('、') : undefined;
}
export function describeFailure(doc: CadDocument, code: string, elementId?: string): string {
  const r = cadFailureReport(doc, { code, featureId: elementId });
  const where = [
    r.bodyId !== undefined && `body「${r.bodyName}」（ID ${r.bodyId}）`,
    r.featureId !== undefined && `feature「${r.featureName}」（${r.operation}、ID ${r.featureId}）`,
    r.sketchId !== undefined && `sketch「${r.sketchName}」（ID ${r.sketchId}）`,
  ].filter(Boolean);
  return where.length ? `${r.message}原因：${where.join('の')}` : r.message;
}

/**
 * The state of one stored reference on the current evaluation (r1-modeling.md, Pickと表示):
 * `unknown` while the shape is recalculating, or when it failed at another feature first.
 */
export type CadReferenceState = 'resolved' | 'ambiguous' | 'missing' | 'unknown';
export interface CadReferenceRow {
  path: (string | number)[];
  ref: CadTopologyRef;
  state: CadReferenceState;
  /** Candidates an ambiguous reference could be chosen again among. */
  candidates: number;
}
/** Feature `f`'s references with their states on `evaluation` of `contentHash`. */
export function referenceRows(
  f: CadFeature,
  contentHash: string,
  evaluation: CadEvaluation | undefined,
): CadReferenceRow[] {
  const current = evaluation?.contentHash === contentHash ? evaluation : undefined;
  const problems =
    current?.status === 'error' && current.featureId === f.id ? current.references : undefined;
  return featureReferences(f).map(({ path, ref }) => {
    const problem = problems?.find((p) => JSON.stringify(p.path) === JSON.stringify(path));
    const state: CadReferenceState = problem
      ? problem.status
      : current?.status === 'ok' || problems
        ? 'resolved'
        : 'unknown';
    return { path, ref, state, candidates: problem?.candidates.length ?? 0 };
  });
}
/** Pick-table answers per mesh: a snapshot is built on every change, the mesh rarely changes. */
/**
 * Whether an export evaluation's bodies are the ones shown. OCCT does not reproduce volume and
 * area bit for bit across builds of the same content (a shell after a fillet differs in the
 * last digit), so numbers agree within a relative 1e-9; keys and body ids must match exactly.
 */
function sameBodies(
  a: Record<string, CadBodyEvaluation>,
  b: Record<string, CadBodyEvaluation>,
): boolean {
  const near = (x: number, y: number) =>
    Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
  const ids = Object.keys(a);
  if (ids.length !== Object.keys(b).length) return false;
  return ids.every((id) => {
    const x = a[id];
    const y = b[id];
    return (
      !!y &&
      x.kind === y.kind &&
      (x.kind === 'solid'
        ? y.kind === 'solid' && near(x.volumeMm3, y.volumeMm3)
        : y.kind === 'sheet' &&
          x.freeEdges === y.freeEdges &&
          near(x.freeEdgeLengthMm, y.freeEdgeLengthMm)) &&
      near(x.areaMm2, y.areaMm2) &&
      x.bounds.every((corner, i) => corner.every((v, k) => near(v, y.bounds[i][k])))
    );
  });
}

const topologyCache = new WeakMap<CadMesh, Map<string, CadTopologyInfo | undefined>>();
/** The picked face or edge in `meshes`' pick table, or undefined when it is not there. */
export function topologyInfo(
  meshes: readonly CadMesh[],
  selection: CadSelection,
): CadTopologyInfo | undefined {
  if (selection?.kind !== 'face' && selection?.kind !== 'edge') return undefined;
  const mesh = meshes.find((m) => m.bodyId === selection.id);
  if (!mesh) return undefined;
  const { kind } = selection;
  const key = `${kind}:${selection.pick}`;
  const cached = topologyCache.get(mesh);
  if (cached?.has(key)) return cached.get(key);
  const info = readTopology(mesh, kind, selection.pick);
  topologyCache.set(mesh, (cached ?? new Map()).set(key, info));
  return info;
}
function readTopology(
  mesh: CadMesh,
  kind: 'face' | 'edge',
  pick: number,
): CadTopologyInfo | undefined {
  const table = mesh.topology;
  const index = pick - 1 - (kind === 'face' ? mesh.faceBase : mesh.edgeBase);
  const element = kind === 'face' ? table.faces[index] : table.edges[index];
  if (!element) return undefined;
  const name = elementName(table, kind, index);
  let select: CadTopologyInfo['select'];
  if (!name) select = 'unnamed';
  else
    try {
      select = selectFor(table, kind, index);
    } catch {
      select = 'symmetric';
    }
  const normal = kind === 'face' ? planeNormal(mesh, pick) : undefined;
  return {
    kind,
    bodyId: mesh.bodyId,
    name,
    sameName: name ? candidatesOf(table, kind, name).length : 1,
    select,
    size: 'area' in element ? element.area : element.length,
    ...(normal ? { normal } : {}),
  };
}
/** The outward unit normal of face `pick` from its mesh normals, if they all agree (planar). */
function planeNormal(mesh: CadMesh, pick: number): Vec3 | undefined {
  const sum = [0, 0, 0];
  const seen: number[] = [];
  for (let t = 0; t < mesh.faceIds.length; t++) {
    if (mesh.faceIds[t] !== pick) continue;
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[3 * t + k]!;
      seen.push(v);
      for (let c = 0; c < 3; c++) sum[c]! += mesh.normals[3 * v + c]!;
    }
  }
  const length = Math.hypot(...sum);
  if (!seen.length || length === 0) return undefined;
  // Snapped to 1e-9 so an axis-aligned face gives the axis exactly.
  const snapped = sum.map((c) => Math.round((c / length) * 1e9) / 1e9 || 0);
  const n = snapped.map((c) => c / Math.hypot(...snapped)) as Vec3;
  const flat = seen.every(
    (v) => n.reduce((d, c, i) => d + c * mesh.normals[3 * v + i]!, 0) > 1 - 1e-6,
  );
  return flat ? n : undefined;
}

/**
 * React-free controller for the CAD Surface: owns the coordinator, selection, meshes and
 * diagnostics. Every edit goes through prepare → apply; nothing calls the session directly.
 */
export class CadController {
  readonly coordinator: CadCoordinator;
  private readonly listeners = new Set<() => void>();
  /** Retained meshes by content hash, least recently received first. */
  private readonly meshStore = new Map<string, CadMesh[]>();
  private lastMeshHash: string | undefined;
  /** Results whose meshes alone exceed the budget: never kept, and their edits are refused. */
  private readonly overBudget = new Set<string>();
  /** The current content's meshes were released for a candidate: shown again once it settles. */
  private releasedCurrent = false;
  private snapshot: CadSnapshot;
  private busy = false;
  /** An edit's evaluation is running: run(), prepareEdit() or prepareMigration() waiting on it. */
  private evaluatingEdit = false;
  private progress: { done: number; total: number } | undefined;
  private diagnostic: CadDiagnostic | undefined;
  private selection: CadSelection = null;
  private pmiFocus: { bodyId: string; itemId: string } | undefined;
  private pmiView: { bodyId: string; viewId: string; chosen: number } | undefined;
  /** How many times a saved view was chosen: choosing the same one again aims again. */
  private pmiViewChoices = 0;
  /** Parsed `pmi` assets by hash (null: the bytes are not an asset). */
  private readonly pmiAssets = new Map<string, CadPmiAsset | null>();
  private collected: CadCollectedEdge[] = [];
  /** The last continuity check, with the content and pick it was for. */
  private continuity: (CadContinuityView & { contentHash: string }) | undefined;
  /** The last comb, with the content and pick it was for. */
  private comb: (CadCombView & { contentHash: string }) | undefined;
  /** The last curvature, with the content it was for. */
  private curvature: (CadCurvatureView & { contentHash: string }) | undefined;
  /** CR3d: the gap and flush measurement, with the content it was for (and the first edge's index). */
  private gapFlush: (CadGapFlushView & { contentHash: string; fromEdge: number }) | undefined;
  private weldStart:
    | { bodyId: string; pick: number; contentHash: string; face: CadTopologyRef }
    | undefined;
  private rejections = 0;
  /** Latest run(); only its completion may clear `busy`. */
  private operation = 0;
  /** The Host is storing STEP assets: no save may run until the edit names them. */
  private staging = false;
  private migration: { ticket: CadTicket; preview: CadMigrationPreview } | undefined;
  /** R2b-2b: an edit prepared for its preview (a part version update), or why it broke joints. */
  private prepared:
    | { op: CadOperation; ticket: CadTicket }
    | {
        op: CadOperation;
        evaluation: CadEvaluation & { status: 'error' };
        candidate: CadDocument;
      }
    | undefined;
  private rebind: RebindState | undefined;
  private sketching: Omit<CadSketchView, 'region'> | undefined;
  /** Every ID the drawing has used: a removed one is never given to a new element. */
  private sketchIds = new Set<string>();
  /** The drawing whose Finish waits on choosing broken references: Cancel there returns to it. */
  private suspendedSketch: Omit<CadSketchView, 'region'> | undefined;
  private stepImport:
    | (Omit<CadStepImportPreview, 'resultLimitMm'> & {
        source: Uint8Array;
        brep: Uint8Array;
        /** PMI-2: the body's `pmi` asset, when the import kept PMI. */
        pmi?: Uint8Array;
        buildHash: string;
      })
    | undefined;
  constructor(private readonly options: CadControllerOptions) {
    this.coordinator = new CadCoordinator(options);
    this.snapshot = this.build();
  }
  private id(prefix: string) {
    return this.options.newId?.(prefix) ?? newId(prefix);
  }
  /** A fresh element ID, for operation data the Surface builds (a new polyline vertex). */
  newId(prefix: string) {
    return this.id(prefix);
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;
  /** Counts the edits started so far: a Host compares it around its own input flush. */
  get startedEdits() {
    return this.operation;
  }
  /** Whether the Host is storing STEP assets for an edit that does not name them yet. */
  get stagingAssets() {
    return this.staging;
  }
  private build(): CadSnapshot {
    const content = this.coordinator.content;
    const contentHash = cadContentHash(content);
    const own = this.meshStore.get(contentHash);
    const evaluation = this.coordinator.evaluation;
    const reference =
      evaluation?.status === 'ok' && evaluation.reference
        ? { effectiveBuildHash: evaluation.buildHash }
        : undefined;
    const target = this.options.currentKernel;
    const fallback = this.lastMeshHash && this.meshStore.get(this.lastMeshHash);
    const failure = this.coordinator.geometryFailure;
    const previewHash = this.rebind?.view.previewHash;
    const preview = previewHash ? this.meshStore.get(previewHash) : undefined;
    return {
      content,
      contentHash,
      geometryState: this.coordinator.geometryState,
      evaluation,
      geometryFailure: failure && describeFailure(content, failure.code, failure.featureId),
      failureReport: failure && cadFailureReport(content, failure),
      partialFailure:
        failure && own?.length
          ? {
              shown: Object.keys(failure.partial ?? {}).length,
              before: own.flatMap((m) =>
                m.beforeFailure
                  ? [
                      {
                        body: content.bodies.find((b) => b.id === m.bodyId)?.name ?? m.bodyId,
                        feature:
                          content.features.find((f) => f.id === m.beforeFailure)?.name ??
                          m.beforeFailure,
                      },
                    ]
                  : [],
              ),
            }
          : undefined,
      canRebindCurrent:
        this.options.canEdit() && !this.rebind && !!failure?.references?.length && !this.busy,
      meshes: preview
        ? { contentHash: previewHash!, current: false, meshes: preview, preview: true }
        : own
          ? { contentHash, current: true, meshes: own }
          : fallback
            ? { contentHash: this.lastMeshHash!, current: false, meshes: fallback }
            : undefined,
      busy: this.busy,
      progress: this.progress,
      canStop: this.evaluatingEdit || this.coordinator.geometryState === 'reevaluating',
      diagnostic: this.diagnostic,
      selection: this.selection,
      pmiFocus:
        this.pmiFocus &&
        this.selection?.kind === 'body' &&
        this.selection.id === this.pmiFocus.bodyId &&
        this.pmiItemCurrent(this.pmiFocus.bodyId, this.pmiFocus.itemId)
          ? this.pmiFocus
          : undefined,
      pmiView:
        this.pmiView &&
        this.selection?.kind === 'body' &&
        this.selection.id === this.pmiView.bodyId &&
        ['current', 'changed'].includes(cadBodyPmi(content, this.pmiView.bodyId).status)
          ? this.pmiView
          : undefined,
      topology: own ? topologyInfo(own, this.selection) : undefined,
      canUndo: this.options.session.canUndo && !this.sketching,
      canRedo: this.options.session.canRedo && !this.sketching,
      canEdit: this.options.canEdit(),
      readOnly: !this.options.canEdit() || !!reference,
      reference,
      canMigrate:
        this.options.canEdit() &&
        !!target &&
        target.buildHash !== content.kernelProfile.buildHash &&
        !this.busy &&
        !this.migration,
      migration: this.migration?.preview,
      toleranceSet: cadToleranceSetOf(content.kernelProfile),
      canChangeTolerance:
        this.options.canEdit() && !reference && !this.busy && !this.migration && !this.sketching,
      rebind: this.rebind?.view,
      rebindPreview: this.rebind?.view.previewHash ? this.rebind.preview : undefined,
      rejections: this.rejections,
      collectedEdges: this.collected,
      continuity: this.edgeView<CadContinuityView>(this.continuity, contentHash),
      comb: this.edgeView<CadCombView>(this.comb, contentHash),
      gapFlush:
        this.gapFlush?.contentHash === contentHash
          ? (({ contentHash: _, fromEdge: __, ...view }) => view as CadGapFlushView)(this.gapFlush)
          : undefined,
      weldStart:
        this.weldStart?.contentHash === contentHash
          ? { bodyId: this.weldStart.bodyId, pick: this.weldStart.pick }
          : undefined,
      spotWelds:
        evaluation?.status === 'ok' && evaluation.contentHash === contentHash
          ? evaluation.spotWelds
          : undefined,
      curvature:
        this.curvature?.contentHash === contentHash
          ? (({ contentHash: _, ...view }) => view)(this.curvature)
          : undefined,
      canImportStep:
        this.options.canEdit() &&
        !reference &&
        !!this.options.assets &&
        !!this.options.importStep &&
        !this.busy,
      stepImport: this.stepImport && {
        fileName: this.stepImport.fileName,
        report: this.stepImport.report,
        resultLimitMm: this.coordinator.content.kernelProfile.maxResultLinearToleranceMm,
      },
      sketch: this.sketching && {
        ...this.sketching,
        region: sketchDefaultRegion(this.sketching.sketch),
      },
      canSketch:
        this.options.canEdit() && !reference && !this.busy && !this.rebind && !this.sketching,
    };
  }
  private emit() {
    const content = this.coordinator.content;
    // Keep meshes for exactly the evaluations the coordinator retains (plus the latest arrival,
    // whose evaluation may not be cached yet), so a cached evaluation never lacks its mesh.
    const keep = new Set(this.coordinator.cachedContentHashes());
    for (const hash of this.meshStore.keys())
      if (!keep.has(hash) && hash !== this.lastMeshHash) this.meshStore.delete(hash);
    this.fitBudget(cadContentHash(content));
    // Drop a selection whose element no longer exists (Undo, delete).
    if (this.selection && !this.exists(content, this.selection)) this.selection = null;
    this.selectFailure(content);
    // Progress belongs to a running evaluation only.
    if (!this.evaluatingEdit && this.coordinator.geometryState !== 'reevaluating')
      this.progress = undefined;
    this.snapshot = this.build();
    for (const listener of this.listeners) listener();
  }
  /** The failure the part was last selected for; each new failure selects its part once. */
  private failureSelected: string | undefined;
  /** A new failure selects the part it happened in, so the Inspector shows it (#589). */
  private selectFailure(content: CadDocument) {
    const failure = this.coordinator.geometryFailure;
    const key = failure && `${failure.contentHash} ${failure.code} ${failure.featureId ?? ''}`;
    if (!failure || key === this.failureSelected) return;
    this.failureSelected = key;
    // A failure the document's tolerance set answers keeps the document settings in view.
    if (failure.code.split(/[:@]/)[0] === 'result-tolerance') return;
    const { bodyId, featureId } = cadFailureReport(content, failure);
    if (bodyId) this.selection = { kind: 'body', id: bodyId };
    else if (featureId) this.selection = { kind: 'feature', id: featureId };
  }
  private exists(doc: CadDocument, s: NonNullable<CadSelection>) {
    // A pick id names a face or edge of one evaluation only.
    if (s.kind === 'face' || s.kind === 'edge')
      return (
        s.contentHash === cadContentHash(doc) &&
        !!topologyInfo(this.meshStore.get(s.contentHash) ?? [], s)
      );
    const list =
      s.kind === 'body' ? doc.bodies : s.kind === 'feature' ? doc.features : doc.parameters;
    return list.some((x: { id: string }) => x.id === s.id);
  }
  private get budget() {
    return {
      mainBytes: this.options.budget?.mainBytes ?? cadBudgets.mainBytes,
      mainEntries: this.options.budget?.mainEntries ?? cadBudgets.mainEntries,
    };
  }
  /**
   * Bytes of every retained mesh and of the shown curvature's node arrays, shared buffers once
   * (tests and the Surface read it).
   */
  get retainedMeshBytes() {
    return retainedBytes([...this.meshStore.values()].flat()) + this.curvatureBytes;
  }
  private get curvatureBytes() {
    return this.curvature?.status === 'done' ? curvatureBytes(this.curvature.bodies) : 0;
  }
  /**
   * Keeps the retained meshes within the budget: history entries go first, least recently
   * received first, with their evaluations, so returning to them evaluates again. When the
   * current and the latest result alone do not fit (bytes or entries), the current display is
   * released; its content stays, and it is evaluated again once nothing is pending.
   */
  private fitBudget(current: string) {
    const { mainBytes, mainEntries } = this.budget;
    // Curvature for other content is never shown again: it goes first.
    if (this.curvature && this.curvature.contentHash !== current) this.curvature = undefined;
    const kept = new Set([current, this.lastMeshHash]);
    for (const hash of [...this.meshStore.keys()]) {
      if (this.meshStore.size <= mainEntries && this.retainedMeshBytes <= mainBytes) return;
      if (kept.has(hash)) continue;
      this.meshStore.delete(hash);
      this.coordinator.forget(hash);
    }
    // Then the curvature colours, which can be computed again, before the current display.
    if (this.retainedMeshBytes > mainBytes && this.curvatureBytes > 0) this.curvature = undefined;
    if (
      (this.retainedMeshBytes > mainBytes || this.meshStore.size > mainEntries) &&
      current !== this.lastMeshHash
    ) {
      this.meshStore.delete(current);
      this.coordinator.forget(current);
      this.releasedCurrent = true;
    }
  }
  /** Port callback (CM-4): the running evaluation goes on in another job, `done` of `total`. */
  receiveProgress = (done: number, total: number) => {
    if (!this.evaluatingEdit && this.coordinator.geometryState !== 'reevaluating') return;
    this.progress = { done, total };
    this.emit();
  };
  /**
   * Stops the running evaluation (CM-4): an edit's is not applied and its fields are reset; the
   * current content's reports `cancelled` until Recalculate. Content and history stay.
   */
  stopEvaluation() {
    if (!this.snapshot.canStop) return;
    if (this.evaluatingEdit) {
      // The run's late answer leaves the outcome to this stop.
      this.operation++;
      this.busy = this.evaluatingEdit = false;
      this.rejections++;
      this.fail('cancelled');
    }
    this.coordinator.stop();
    this.progress = undefined;
    this.emit();
    this.restoreReleased();
  }
  /** Port callback: meshes for one exact content hash (pruned with the evaluation cache). */
  receiveMeshes = (contentHash: string, meshes: CadMesh[]) => {
    if (retainedBytes(meshes) > this.budget.mainBytes) {
      // Larger than the whole budget: not kept. An edit to it is refused in run(); the content
      // on screen reports it.
      this.overBudget.add(contentHash);
      this.coordinator.forget(contentHash);
      if (contentHash === cadContentHash(this.coordinator.content)) this.fail('memory-budget');
      this.emit();
      return;
    }
    this.overBudget.delete(contentHash);
    this.meshStore.delete(contentHash);
    this.meshStore.set(contentHash, meshes);
    this.lastMeshHash = contentHash;
    this.emit();
  };
  select(selection: CadSelection) {
    this.selection = selection;
    if (selection?.kind !== 'body' || selection.id !== this.pmiFocus?.bodyId)
      this.pmiFocus = undefined;
    if (selection?.kind !== 'body' || selection.id !== this.pmiView?.bodyId)
      this.pmiView = undefined;
    this.emit();
  }
  /**
   * PMI-2: the PMI a body carries from an import, with its asset read from the Host's bytes.
   * `asset` is undefined while the Host has no bytes or when they are not a `pmi` asset.
   */
  bodyPmi(bodyId: string): CadBodyPmiView {
    const content = this.coordinator.content;
    const state = cadBodyPmi(content, bodyId);
    if (state.status === 'none') return { state };
    const ref = content.assets.find((a) => a.id === state.assetId);
    if (!ref) return { state, unreadable: true };
    let asset = this.pmiAssets.get(ref.sha256);
    if (asset === undefined) {
      const bytes = this.options.assets?.get(ref.sha256);
      if (!bytes) return { state, unreadable: true };
      asset = readCadPmiAsset(bytes) ?? null;
      this.pmiAssets.set(ref.sha256, asset);
    }
    if (!asset) return { state, unreadable: true };
    if (state.status === 'current') return { state, asset };
    // PMI-4a: past a change of the shape, each item by the current evaluation's tracking (none
    // while it is not there, or for a body whose PMI is not followed: all stale).
    const mesh =
      state.status === 'changed'
        ? this.meshStore
            .get(cadContentHash(content))
            ?.find((m) => m.bodyId === bodyId && !m.beforeFailure && !m.lod)
        : undefined;
    const tracking = mesh?.pmi?.find((t) => t.featureId === state.featureId);
    return {
      state,
      asset,
      items: this.pmiItemStates(asset, tracking),
      ...(tracking ? { tracking } : {}),
    };
  }
  /** Item states by asset and tracking: both stay the same objects while nothing changes. */
  private readonly pmiStates = new WeakMap<
    CadPmiAsset,
    { tracking: CadPmiTracking | undefined; items: Map<string, CadPmiItemState> }
  >();
  private pmiItemStates(asset: CadPmiAsset, tracking: CadPmiTracking | undefined) {
    const hit = this.pmiStates.get(asset);
    if (hit && hit.tracking === tracking) return hit.items;
    const items = cadPmiItemStates(asset, tracking);
    this.pmiStates.set(asset, { tracking, items });
    return items;
  }
  /** Whether a body's PMI item is current: its body's PMI is, or the item is on its own. */
  private pmiItemCurrent(bodyId: string, itemId: string) {
    const view = this.bodyPmi(bodyId);
    if (!view.asset) return false;
    if (view.state.status === 'current') return true;
    return view.items?.get(itemId)?.current === true;
  }
  /** PMI-2: highlights one PMI item's targets on the selected body (display only). */
  focusPmi(itemId: string | undefined) {
    const s = this.selection;
    this.pmiFocus = itemId && s?.kind === 'body' ? { bodyId: s.id, itemId } : undefined;
    this.emit();
  }
  /** PMI-3b: shows one saved view of the selected body's PMI, or all of it (display only). */
  showPmiView(viewId: string | undefined) {
    const s = this.selection;
    this.pmiView =
      viewId && s?.kind === 'body'
        ? { bodyId: s.id, viewId, chosen: ++this.pmiViewChoices }
        : undefined;
    this.emit();
  }
  /** An edge analysis for the current pick on the current content only. */
  private edgeView<V extends { bodyId: string; pick: number }>(
    c: (V & { contentHash: string }) | undefined,
    contentHash: string,
  ): V | undefined {
    const s = this.selection;
    if (!c || c.contentHash !== contentHash || s?.kind !== 'edge') return undefined;
    if (s.contentHash !== contentHash || s.id !== c.bodyId || s.pick !== c.pick) return undefined;
    const { contentHash: _, ...view } = c;
    return view as unknown as V;
  }
  /**
   * The shown exact evaluation an analysis (R2a-4) runs again, and its request; with `edge`, the
   * picked edge too. A refusal code when there is none: a reference display, a stale pick, an
   * evaluation still running.
   */
  private analysisTarget(edge: boolean) {
    const s = this.selection;
    const shown = this.snapshot;
    const content = this.coordinator.content;
    const contentHash = cadContentHash(content);
    const mesh =
      s?.kind === 'edge' && s.contentHash === contentHash
        ? this.meshStore.get(contentHash)?.find((m) => m.bodyId === s.id)
        : undefined;
    if (edge && (!s || s.kind !== 'edge' || !mesh)) return 'selection-stale';
    if (shown.reference) return 'kernel-reference-only';
    const evaluation = shown.evaluation;
    if (evaluation?.status !== 'ok' || shown.contentHash !== contentHash) return 'export-busy';
    return {
      contentHash,
      evaluation,
      request: {
        requestId: this.id('analysis'),
        generation: 0,
        baseHash: contentHash,
        candidateHash: contentHash,
        document: content,
      },
      pick:
        s?.kind === 'edge' && mesh
          ? { bodyId: s.id, pick: s.pick, edge: s.pick - 1 - mesh.edgeBase }
          : undefined,
    };
  }
  /** The pick an edge analysis was for is still picked, on the same content. */
  private stillPicked(at: { bodyId: string; pick: number; contentHash: string }) {
    const now = this.selection;
    return (
      now?.kind === 'edge' &&
      now.pick === at.pick &&
      now.id === at.bodyId &&
      now.contentHash === at.contentHash
    );
  }
  /**
   * Why an analysis evaluation cannot be shown with the display: it failed, or is not the shown
   * evaluation (another content, build or geometry). Undefined when it is the same.
   */
  private analysisRefusal(
    result: CadEvaluation,
    shown: Extract<CadEvaluation, { status: 'ok' }>,
    mismatch: string,
  ): [string, string?] | undefined {
    if (result.status !== 'ok') return [result.code, result.featureId];
    if (
      result.contentHash !== shown.contentHash ||
      result.buildHash !== shown.buildHash ||
      result.geometryDigest !== shown.geometryDigest
    )
      return [mismatch];
    return undefined;
  }
  /**
   * Samples the continuity of the picked edge between its two faces on the document's exact
   * build (R2a-4): G0, G1 and G2 at 65 points with the fixed tolerances. Shows the report; the
   * content does not change. Refuses on a reference display, a stale pick, and an edge without
   * two faces.
   */
  async checkContinuity(): Promise<CadContinuityReport | undefined> {
    const target = this.analysisTarget(true);
    if (typeof target === 'string') return this.refuse(target);
    if (!this.options.analyzeContinuity) return this.refuse('kernel-unavailable');
    const at = {
      bodyId: target.pick!.bodyId,
      pick: target.pick!.pick,
      contentHash: target.contentHash,
    };
    const mine: CadContinuityView & { contentHash: string } = { ...at, status: 'running' };
    this.continuity = mine;
    this.emit();
    const result = await this.options.analyzeContinuity(target.request, {
      bodyId: at.bodyId,
      edge: target.pick!.edge,
    });
    // A newer check replaced this one meanwhile, or the pick or content changed: its answer is
    // not shown.
    if (this.continuity !== mine) return undefined;
    this.continuity = undefined;
    if (!this.stillPicked(at)) return void this.emit();
    const refusal = this.analysisRefusal(
      result.evaluation,
      target.evaluation,
      'continuity-mismatch',
    );
    if (refusal) return this.refuse(...refusal);
    if (!result.continuity) return this.refuse('continuity-mismatch');
    if ('code' in result.continuity) return this.refuse(result.continuity.code);
    const report = continuityReport(result.continuity.samples);
    this.continuity = { ...at, status: 'done', report };
    this.emit();
    return report;
  }
  /**
   * The curvature comb of the picked edge's curve on the document's exact build (R2a-4): 129
   * samples of its curvature and the normal toward the centre. Display only, like continuity.
   */
  async sampleComb(): Promise<CadCombSample[] | undefined> {
    const target = this.analysisTarget(true);
    if (typeof target === 'string') return this.refuse(target);
    if (!this.options.analyzeComb) return this.refuse('kernel-unavailable');
    const at = {
      bodyId: target.pick!.bodyId,
      pick: target.pick!.pick,
      contentHash: target.contentHash,
    };
    const mine: CadCombView & { contentHash: string } = { ...at, status: 'running' };
    this.comb = mine;
    this.emit();
    const result = await this.options.analyzeComb(target.request, {
      bodyId: at.bodyId,
      edge: target.pick!.edge,
    });
    if (this.comb !== mine) return undefined;
    this.comb = undefined;
    if (!this.stillPicked(at)) return void this.emit();
    const refusal = this.analysisRefusal(
      result.evaluation,
      target.evaluation,
      'curvature-mismatch',
    );
    if (refusal) return this.refuse(...refusal);
    if (!result.comb) return this.refuse('curvature-mismatch');
    if ('code' in result.comb) return this.refuse(result.comb.code);
    const { samples } = result.comb;
    this.comb = { ...at, status: 'done', samples, scale: combScale(samples) };
    this.emit();
    return samples;
  }
  /**
   * CR3d: takes the picked edge (a sheet's border) as the first edge of a gap and flush
   * measurement; measuring from another body's edge follows with `measureGapFlush`.
   */
  chooseGapFlushEdge(): boolean {
    const target = this.analysisTarget(true);
    if (typeof target === 'string') return this.refuse(target) ?? false;
    const { bodyId, pick, edge } = target.pick!;
    this.gapFlush = {
      from: { bodyId, pick },
      status: 'chosen',
      contentHash: target.contentHash,
      fromEdge: edge,
    };
    this.emit();
    return true;
  }
  /**
   * CR3d: samples the gap and flush from the chosen first edge to the picked edge of another body
   * on the document's exact build: 50 points at equal distances along the first edge, the gap
   * across it in its face's tangent plane and the flush along its face's normal. Display only.
   */
  async measureGapFlush(): Promise<CadGapFlushReport | undefined> {
    const first = this.gapFlush;
    const target = this.analysisTarget(true);
    if (typeof target === 'string') return this.refuse(target);
    if (!first || first.contentHash !== target.contentHash)
      return this.refuse('gap-flush-no-start');
    if (!this.options.analyzeGapFlush) return this.refuse('kernel-unavailable');
    const to = { bodyId: target.pick!.bodyId, pick: target.pick!.pick };
    if (to.bodyId === first.from.bodyId) return this.refuse('gap-flush-same-body');
    const base = { from: first.from, contentHash: first.contentHash, fromEdge: first.fromEdge };
    const mine: NonNullable<typeof this.gapFlush> = { ...base, to, status: 'running' };
    this.gapFlush = mine;
    this.emit();
    const result = await this.options.analyzeGapFlush(target.request, {
      a: { bodyId: first.from.bodyId, edge: first.fromEdge },
      b: { bodyId: to.bodyId, edge: target.pick!.edge },
    });
    if (this.gapFlush !== mine) return undefined;
    // A refusal keeps the first edge, so another second edge can be tried.
    this.gapFlush = { ...base, status: 'chosen' };
    const refusal = this.analysisRefusal(
      result.evaluation,
      target.evaluation,
      'gap-flush-mismatch',
    );
    if (refusal) return this.refuse(...refusal);
    if (!result.gapFlush) return this.refuse('gap-flush-mismatch');
    if ('code' in result.gapFlush) return this.refuse(result.gapFlush.code);
    const { samples } = result.gapFlush;
    const report = gapFlushReport(samples);
    this.gapFlush = { ...base, to, status: 'done', samples, report };
    this.emit();
    return report;
  }
  /** CR3d: stops the gap and flush measurement and its display. */
  clearGapFlush() {
    this.gapFlush = undefined;
    this.emit();
  }
  /** Stops showing the comb (and drops a comb still being sampled). */
  hideComb() {
    this.comb = undefined;
    this.emit();
  }
  /**
   * The mean and Gauss curvature at every node of the shown meshes, from the faces' exact
   * surfaces on the document's build (R2a-4), for the curvature colours. Display only; it
   * applies to the content it was computed for.
   */
  async showCurvature(): Promise<CadBodyCurvature[] | undefined> {
    const target = this.analysisTarget(false);
    if (typeof target === 'string') return this.refuse(target);
    if (!this.options.analyzeCurvature) return this.refuse('kernel-unavailable');
    const mine: CadCurvatureView & { contentHash: string } = {
      contentHash: target.contentHash,
      status: 'running',
    };
    this.curvature = mine;
    this.emit();
    const result = await this.options.analyzeCurvature(target.request);
    if (this.curvature !== mine) return undefined;
    this.curvature = undefined;
    if (cadContentHash(this.coordinator.content) !== target.contentHash) return void this.emit();
    const refusal = this.analysisRefusal(
      result.evaluation,
      target.evaluation,
      'curvature-mismatch',
    );
    if (refusal) return this.refuse(...refusal);
    if (!result.curvature) return this.refuse('curvature-mismatch');
    // With the current meshes it must fit the Main budget; history makes room in emit().
    const shown = retainedBytes(this.meshStore.get(target.contentHash) ?? []);
    if (shown + curvatureBytes(result.curvature) > this.budget.mainBytes)
      return this.refuse('curvature-budget');
    this.curvature = { contentHash: target.contentHash, status: 'done', bodies: result.curvature };
    this.emit();
    return result.curvature;
  }
  /**
   * STL (millimetres, its own triangulation at the given deflection) or GLB (the display mesh,
   * whose deflection follows each body's size) of exactly the confirmed content when it is
   * called. An edit still evaluating does not stop it and may apply meanwhile: the file stays
   * pinned to the content hash it names (CAD21). Refuses when the export evaluation differs from
   * the shown one. Returns undefined after reporting why.
   */
  async exportMesh(
    format: 'stl' | 'glb',
    { deflectionMm = stlDeflectionMm }: { deflectionMm?: number } = {},
  ): Promise<CadMeshExport | undefined> {
    const refuse = (code: string, elementId?: string) => {
      this.fail(code, elementId);
      this.emit();
      return undefined;
    };
    const shown = this.snapshot;
    const evaluation = shown.evaluation;
    if (shown.reference) return refuse('kernel-reference-only');
    if (shown.content.components.length) return refuse('assembly-export-unsupported');
    if (shown.geometryState !== 'ready' || !shown.meshes?.current || evaluation?.status !== 'ok')
      return refuse('export-busy');
    const { content, contentHash } = shown;
    const active = content.bodies.filter((b) => b.state === 'active');
    if (!active.length) return refuse('export-no-shape');
    // STL describes a closed volume; a sheet has none (refused before evaluating again).
    const sheet = active.find((b) => b.kind === 'sheet');
    if (format === 'stl' && sheet) return refuse('sheet-not-solid', sheet.id);
    let meshes = shown.meshes.meshes;
    if (format === 'stl') {
      if (!this.options.exportMeshes) return refuse('kernel-unavailable');
      const exported = await this.options.exportMeshes(
        {
          requestId: this.id('export'),
          generation: 0,
          baseHash: contentHash,
          candidateHash: contentHash,
          document: content,
        },
        deflectionMm,
      );
      if (exported.evaluation.status !== 'ok')
        // A finer triangulation than the time allows is the file's choice, not the shape's.
        return refuse(
          exported.evaluation.code === 'timeout' ? 'export-timeout' : exported.evaluation.code,
        );
      // The exact shape must be the one shown: same content, same build, same body metrics.
      if (
        exported.evaluation.contentHash !== contentHash ||
        exported.evaluation.buildHash !== evaluation.buildHash ||
        !sameBodies(exported.evaluation.bodies, evaluation.bodies)
      )
        return refuse('export-mismatch');
      meshes = exported.meshes;
    }
    const byBody = new Map(meshes.map((m) => [m.bodyId, m]));
    const bodies = active.map((b) => ({
      name: b.name,
      kind: b.kind,
      appearance: b.appearance,
      mesh: byBody.get(b.id),
    }));
    if (bodies.some((b) => !b.mesh)) return refuse('export-mismatch');
    const losses: string[] = [];
    // One image object per asset, and one conversion per map, so a GLB embeds each image once.
    const images = new Map<string, CadExportImage | undefined>();
    const conversions = new Map<string, Promise<CadExportImage | undefined>>();
    if (format === 'glb')
      for (const body of bodies as CadExportBody[]) {
        const textures = await this.glbTextures(content, body, { images, conversions }, losses);
        if (textures) body.textures = textures;
      }
    const write = format === 'stl' ? writeStl : writeGlb;
    try {
      return write(
        bodies as Parameters<typeof write>[0],
        {
          sourceContentHash: contentHash,
          buildHash: evaluation.buildHash,
          // GLB: the coarsest body's display deflection bounds the chord error of the whole file.
          deflectionMm:
            format === 'stl'
              ? deflectionMm
              : Math.max(...active.map((b) => displayDeflectionMm(evaluation.bodies[b.id].bounds))),
        },
        losses,
      );
    } catch (error) {
      if (error instanceof CadExportError) return refuse(error.code, error.bodyName);
      throw error;
    }
  }
  /**
   * #663: a body's texture set as GLB writes it, from the content's image assets. The colour,
   * occlusion and an OpenGL normal map go as stored; roughness and metalness become glTF's one
   * metal/roughness image, and a DirectX normal map is flipped, by the Host's image tools. A map
   * whose image is missing or cannot be converted is left out and named in `losses`.
   */
  private async glbTextures(
    content: CadDocument,
    { name, appearance }: { name: string; appearance: CadAppearance },
    {
      images,
      conversions,
    }: {
      images: Map<string, CadExportImage | undefined>;
      conversions: Map<string, Promise<CadExportImage | undefined>>;
    },
    losses: string[],
  ): Promise<CadExportTextures | undefined> {
    const set = appearance.textures;
    if (!set) return undefined;
    const image = (role: GeometryTextureRole): CadExportImage | undefined => {
      const id = set.maps[role];
      if (!id) return undefined;
      const ref = content.assets.find((a) => a.id === id);
      if (ref && !images.has(ref.sha256)) {
        const bytes = this.options.assets?.get(ref.sha256);
        images.set(
          ref.sha256,
          bytes && {
            bytes,
            mediaType: ref.mediaType === 'image/png' ? 'image/png' : 'image/jpeg',
          },
        );
      }
      const found = ref && images.get(ref.sha256);
      if (!found) losses.push(`${name}: the ${role} map is not written, as its image is missing.`);
      return found;
    };
    const out: CadExportTextures = { sizeMm: set.sizeMm, rotationDeg: set.rotationDeg };
    const color = image('color');
    const occlusion = image('occlusion');
    if (color) out.color = color;
    if (occlusion) out.occlusion = occlusion;
    const tools = this.options.textureImages;
    /** The asset hash of a map, which names a conversion. */
    const shaOf = (role: GeometryTextureRole) =>
      content.assets.find((a) => a.id === set.maps[role])?.sha256 ?? '';
    /** A converted image, made once per export for the same maps (Codex). */
    const converted = async (
      key: string,
      what: string,
      run: (tools: CadTextureImageTools) => Promise<Uint8Array>,
    ): Promise<CadExportImage | undefined> => {
      let made = conversions.get(key);
      if (!made) {
        made = (async () => {
          try {
            if (tools) return { bytes: await run(tools), mediaType: 'image/png' as const };
          } catch {
            // Reported below, as when there are no tools.
          }
          return undefined;
        })();
        conversions.set(key, made);
      }
      const image = await made;
      if (!image) losses.push(`${name}: ${what} not written, as the image could not be converted.`);
      return image;
    };
    const normal = image('normal');
    if (normal) {
      const gl =
        set.normal === 'dx'
          ? await converted(`flip ${shaOf('normal')}`, 'the normal map is', (t) =>
              t.flipNormalGreen(normal),
            )
          : normal;
      if (gl) out.normal = gl;
    }
    const roughness = image('roughness');
    const metalness = image('metalness');
    if (roughness || metalness) {
      // One image for both reads its green as roughness and its blue as metalness, as the view.
      const packed =
        roughness && roughness === metalness
          ? roughness
          : await converted(
              `pack ${roughness ? shaOf('roughness') : ''} ${metalness ? shaOf('metalness') : ''}`,
              'the roughness and metalness maps are',
              (t) => t.packMetallicRoughness(roughness, metalness),
            );
      if (packed) out.metallicRoughness = packed;
    }
    return out;
  }
  /**
   * STEP (AP214, millimetres, exact solids, one root shape per active body) of exactly the
   * confirmed content when it is called,
   * written by the document's own build; an edit evaluating meanwhile does not change the file
   * (CAD21). Refuses on a reference display and when the export evaluation differs from the
   * shown one.
   */
  async exportStep(): Promise<CadMeshExport | undefined> {
    const refuse = (code: string, elementId?: string) => {
      this.fail(code, elementId);
      this.emit();
      return undefined;
    };
    const shown = this.snapshot;
    const evaluation = shown.evaluation;
    if (shown.reference) return refuse('kernel-reference-only');
    if (shown.content.components.length) return refuse('assembly-export-unsupported');
    if (shown.geometryState !== 'ready' || evaluation?.status !== 'ok')
      return refuse('export-busy');
    const { content, contentHash } = shown;
    const active = content.bodies.filter((b) => b.state === 'active');
    if (!active.length) return refuse('export-no-shape');
    // Several bodies go in one AP214 file, a root solid (or shell) each, without an assembly
    // structure (ST-88); an assembly writes AP242 through CadAssembly.
    if (!this.options.exportStep) return refuse('kernel-unavailable');
    const exported = await this.options.exportStep({
      requestId: this.id('export'),
      generation: 0,
      baseHash: contentHash,
      candidateHash: contentHash,
      document: content,
    });
    if (exported.evaluation.status !== 'ok')
      return refuse(exported.evaluation.code, exported.evaluation.featureId);
    if (
      exported.evaluation.contentHash !== contentHash ||
      exported.evaluation.buildHash !== evaluation.buildHash ||
      !sameBodies(exported.evaluation.bodies, evaluation.bodies) ||
      !exported.step
    )
      return refuse('export-mismatch');
    try {
      return {
        bytes: exported.step,
        report: stepReport(
          exported.step,
          active.length,
          { sourceContentHash: contentHash, buildHash: evaluation.buildHash },
          exported.stepPmi,
        ),
      };
    } catch (error) {
      if (error instanceof CadExportError) return refuse(error.code);
      throw error;
    }
  }
  /** The Host keeps asset bytes and a reader is wired: STEP import exists on this Surface. */
  get importAvailable() {
    return !!this.options.assets && !!this.options.importStep;
  }
  /**
   * D2: reads a STEP file with the document's exact build into the preflight report. Nothing
   * is stored and the content does not change until `adoptStepImport`.
   */
  async prepareStepImport(
    fileName: string,
    bytes: Uint8Array,
    /** R2b-5: reads the file as an assembly when the kernel's scan finds assembly usages. */
    options: {
      assembly?: () => Promise<unknown>;
      /** PMI-1: the user agreed to import the shape without the file's PMI. */
      pmi?: 'discard';
      /** PMI-1: the file has PMI the import would not keep; asks the user instead of failing. */
      onPmi?: (report: CadStepPmiReport) => void;
    } = {},
  ) {
    const refuse = (code: string, detail?: string) => {
      this.fail(code);
      if (detail && this.diagnostic) this.diagnostic.message += `（${detail}）`;
      this.emit();
      return undefined;
    };
    this.stepImport = undefined;
    if (!this.options.canEdit()) return refuse('permission-denied');
    if (this.snapshot.reference) return refuse('kernel-reference-only');
    if (!this.options.assets || !this.options.importStep) return refuse('step-import-unavailable');
    if (this.busy) return refuse('export-busy');
    const profile = this.coordinator.content.kernelProfile;
    const operation = ++this.operation;
    this.busy = true;
    this.diagnostic = undefined;
    this.emit();
    const result = await this.options.importStep(
      profile,
      this.id('import'),
      bytes,
      options.pmi ? { pmi: options.pmi } : {},
    );
    if (operation === this.operation) this.busy = false;
    if (result.status !== 'ok' && result.code === 'step-assembly' && options.assembly) {
      this.emit();
      await options.assembly();
      return undefined;
    }
    if (
      result.status !== 'ok' &&
      result.code === 'step-pmi-partial' &&
      result.pmi &&
      options.onPmi
    ) {
      this.emit();
      options.onPmi(result.pmi);
      return undefined;
    }
    if (result.status !== 'ok') return refuse(result.code, result.detail);
    this.stepImport = {
      fileName,
      report: result.report,
      source: bytes,
      brep: result.brep,
      ...(result.pmi ? { pmi: result.pmi } : {}),
      buildHash: profile.buildHash,
    };
    this.emit();
    return this.snapshot.stepImport;
  }
  /**
   * Stores the source STEP and the normalized BRep with the Host first, then inserts one
   * imported body as one edit (evaluated from the stored BRep like any other edit).
   */
  async adoptStepImport(): Promise<boolean> {
    const pending = this.stepImport;
    this.stepImport = undefined;
    if (!pending) return false;
    const refuse = (code: string, message?: string) => {
      this.fail(code);
      if (message && this.diagnostic) this.diagnostic.message = message;
      this.emit();
      return false;
    };
    const { assets } = this.options;
    if (!assets) return refuse('step-import-unavailable');
    if (!this.options.canEdit()) return refuse('permission-denied');
    const content = this.coordinator.content;
    // The importer named in the feature must be the build that evaluates the document.
    if (content.kernelProfile.buildHash !== pending.buildHash) return refuse('step-import-changed');
    const { report } = pending;
    const refFor = (kind: CadAssetRef['kind'], sha256: string, byteLength: number): CadAssetRef =>
      content.assets.find((a) => a.kind === kind && a.sha256 === sha256) ?? {
        id: this.id('asset'),
        kind,
        sha256,
        byteLength,
        mediaType: cadAssetMediaTypes[kind],
      };
    const source = refFor('source-step', report.source.sha256, report.source.byteLength);
    const brep = refFor('normalized-brep', report.brep.sha256, report.brep.byteLength);
    // PMI-2: the semantic PMI the import kept for the body.
    const pmi =
      report.pmiAsset && pending.pmi
        ? refFor('pmi', report.pmiAsset.sha256, report.pmiAsset.byteLength)
        : undefined;
    // Staging is pending input: Host save and version boundaries wait until the edit names the
    // stored bytes (or the staging fails), so no record is captured between the two.
    const operation = ++this.operation;
    this.busy = true;
    this.staging = true;
    this.emit();
    try {
      await assets.stage([
        { ref: source, bytes: pending.source },
        { ref: brep, bytes: pending.brep },
        ...(pmi && pending.pmi ? [{ ref: pmi, bytes: pending.pmi }] : []),
      ]);
    } catch (error) {
      this.staging = false;
      if (operation === this.operation) this.busy = false;
      const message = error instanceof Error ? error.message : String(error);
      return refuse('asset-stage-failed', `${describeCode('asset-stage-failed')}${message}`);
    }
    // The staging hold ends here; the insert below is a run() that holds busy on its own, and a
    // run refused before it starts (e.g. the Host turned read-only meanwhile) must not keep it.
    this.staging = false;
    if (operation === this.operation) this.busy = false;
    const id = this.id('imported');
    const name = [...pending.fileName].slice(0, 256).join('') || 'STEP';
    return this.run({
      type: 'insertImportedBody',
      assets: pmi ? [source, brep, pmi] : [source, brep],
      feature: {
        id,
        name,
        type: 'imported',
        inputFeatureIds: [],
        args: {
          kind: report.body.kind,
          sourceAssetId: source.id,
          brepAssetId: brep.id,
          importer: { id: content.kernelProfile.id, buildHash: pending.buildHash },
          sourceUnit: report.sourceUnit,
          scaleToMm: report.scaleToMm,
          // #820: a shape less precise than the standard limit keeps its tolerance as read.
          ...(report.maxToleranceMm > cadTolerance.maxResultLinearToleranceMm && {
            maxToleranceMm: report.maxToleranceMm,
          }),
          ...(pmi && { pmiAssetId: pmi.id }),
        },
      },
      body: this.newBody(id, name.replace(/\.(step|stp)$/i, '') || 'STEP'),
    });
  }
  /**
   * PMI-5b: keeps a document asset's bytes with the Host before an edit names it (an imported
   * assembly's `assembly-pmi`). Throws with a message for the user when it cannot.
   */
  async stageAssets(assets: { ref: CadAssetRef; bytes: Uint8Array }[]): Promise<void> {
    if (!this.options.assets) throw new Error(describeCode('step-import-unavailable'));
    await this.options.assets.stage(assets);
  }
  /** #662: the bytes the Host keeps for an asset's hash (texture images for the view). */
  assetBytes(sha256: string): Uint8Array | undefined {
    return this.options.assets?.get(sha256);
  }
  /** #662: texture sets need the Host to keep their images, as STEP import does. */
  get canTexture() {
    return !!this.options.assets;
  }
  /**
   * #662: puts a texture set on a body. The images are stored with the Host first (as STEP
   * import does), then one `setAppearance` names them. As in glTF the look's values multiply
   * the maps, so a colour map makes the colour white, a roughness or metalness map its value 1;
   * the library preset is dropped (the look is now the images').
   */
  async adoptTextures(
    bodyId: string,
    files: readonly { role: GeometryTextureRole; bytes: Uint8Array; mediaType: string }[],
    textures: Omit<CadTextures, 'maps'>,
  ): Promise<boolean> {
    const refuse = (code: string, message?: string) => {
      this.fail(code);
      if (message && this.diagnostic) this.diagnostic.message = message;
      this.emit();
      return false;
    };
    const { assets } = this.options;
    if (!assets) return refuse('texture-unavailable');
    if (!this.options.canEdit()) return refuse('permission-denied');
    if (!files.length) return refuse('texture-empty');
    const content = this.coordinator.content;
    const body = content.bodies.find((b) => b.id === bodyId);
    if (!body) return refuse('target-missing');
    const staged: { ref: CadAssetRef; bytes: Uint8Array }[] = [];
    const maps: CadTextures['maps'] = {};
    for (const file of files) {
      const kind = cadTextureKind(file.mediaType);
      if (!kind) return refuse('texture-media-type');
      const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', file.bytes as BufferSource),
      );
      const sha256 = `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`;
      const ref = content.assets.find((a) => a.kind === kind && a.sha256 === sha256) ??
        staged.find((a) => a.ref.kind === kind && a.ref.sha256 === sha256)?.ref ?? {
          id: this.id('asset'),
          kind,
          sha256,
          byteLength: file.bytes.byteLength,
          mediaType: cadAssetMediaTypes[kind],
        };
      if (!staged.some((a) => a.ref === ref)) staged.push({ ref, bytes: file.bytes });
      maps[file.role] = ref.id;
    }
    const operation = ++this.operation;
    this.busy = true;
    this.staging = true;
    this.emit();
    try {
      await assets.stage(staged);
    } catch (error) {
      this.staging = false;
      if (operation === this.operation) this.busy = false;
      const message = error instanceof Error ? error.message : String(error);
      return refuse('asset-stage-failed', `${describeCode('texture-stage-failed')}${message}`);
    }
    this.staging = false;
    if (operation === this.operation) this.busy = false;
    // Built on the content as it is now: an Undo or another edit while the images were stored
    // is kept, never overwritten by the look read before (Codex). New IDs must still be free.
    const now = this.coordinator.content;
    const current = now.bodies.find((b) => b.id === bodyId);
    if (!current) return refuse('target-missing');
    const held = new Set(now.assets.map((a) => a.id));
    for (const { ref } of staged)
      if (!content.assets.some((a) => a.id === ref.id) && held.has(ref.id))
        return refuse('texture-stale');
    const { material: _preset, ...look } = current.appearance;
    const appearance: CadAppearance = {
      ...look,
      ...(maps.color ? { color: '#ffffff' } : {}),
      ...(maps.roughness ? { roughness: 1 } : {}),
      ...(maps.metalness ? { metalness: 1 } : {}),
      textures: { ...textures, maps },
    };
    return this.run({
      type: 'setAppearance',
      bodyId,
      appearance,
      assets: staged.map((a) => a.ref).filter((r) => !held.has(r.id)),
    });
  }
  /** Discards the read file; nothing was stored. */
  cancelStepImport() {
    this.stepImport = undefined;
    this.emit();
  }
  /** Shows a Host refusal (e.g. an export guard), or another Surface part's, in the status line. */
  report(message: string, code = 'host-refused') {
    this.diagnostic = { code, severity: 'error', message };
    this.emit();
  }
  dismissDiagnostic() {
    this.diagnostic = undefined;
    this.emit();
  }
  private fail(code: string, elementId?: string, doc: CadDocument = this.coordinator.content) {
    this.diagnostic = {
      code,
      severity: 'error',
      elementId,
      message: describeFailure(doc, code, elementId),
    };
    this.rejections++;
  }
  /** Prepare, then apply in the same task as the last await. Returns whether it was applied. */
  async run(op: CadOperation): Promise<boolean> {
    // Any other edit supersedes a prepared migration (its ticket would be stale anyway).
    this.migration = undefined;
    this.dropPrepared();
    this.dropRebind();
    if (op.type !== 'insertImportedBody') this.stepImport = undefined;
    // Sketch mode holds the edit until it is finished (finishSketch leaves the mode first).
    if (this.sketching) {
      this.fail('sketch-open');
      this.emit();
      return false;
    }
    if (!this.options.canEdit()) {
      this.fail('permission-denied');
      this.emit();
      return false;
    }
    const operation = ++this.operation;
    this.busy = this.evaluatingEdit = true;
    this.progress = undefined;
    this.diagnostic = undefined;
    this.emit();
    const prepared = await this.coordinator.prepare(op);
    // A superseded run leaves `busy` to the newer one that is still pending.
    if (operation === this.operation) this.busy = this.evaluatingEdit = false;
    let applied = false;
    if (prepared.status === 'ready' && this.overBudget.has(cadContentHash(prepared.candidate))) {
      this.coordinator.cancel(prepared.ticket);
      this.fail('memory-budget');
    } else if (prepared.status === 'ready') {
      const result = this.coordinator.apply(prepared.ticket);
      applied = result.status === 'applied';
      if (result.status === 'rejected') this.fail(result.code);
      if (applied) this.options.onApplied?.(this.coordinator.content);
    } else if (prepared.status === 'geometry-error' && prepared.evaluation.references?.length) {
      // Broken references are chosen again on a preview instead of refusing outright.
      // The field keeps the pending value while its references are chosen (Cancel resets it).
      this.startRebind(op, prepared.evaluation, prepared.candidate);
    } else if (prepared.status === 'geometry-error') {
      this.fail(prepared.evaluation.code, prepared.evaluation.featureId, prepared.candidate);
      // A sew's gap names the input edges left apart (R2a-3).
      const gaps = prepared.evaluation.edges;
      const shown = this.diagnostic as CadDiagnostic | undefined;
      if (gaps?.length && shown)
        shown.message += ` 離れている辺：${gaps
          .map((g) => `${formatTopoName(g.name)}（${g.featureId}）`)
          .join('、')}`;
      // CR3c: a trim's chains that cut nothing or split the kept sheet are named.
      const chains = trimChains(prepared.candidate, prepared.evaluation);
      if (chains && shown) shown.message += ` 該当する閉じた線：${chains}`;
    } else if (prepared.status === 'rejected') this.fail(prepared.code);
    // A stale result superseded by a newer run leaves the outcome to it. Cancelled by history or
    // a Host sync instead, it resets the Inspector so no field keeps the cancelled value.
    else if (operation === this.operation) this.rejections++;
    this.emit();
    this.restoreReleased();
    return applied;
  }
  /** The current display was released for a candidate that did not apply: show it again. */
  private restoreReleased() {
    if (!this.releasedCurrent || this.busy) return;
    this.releasedCurrent = false;
    if (!this.coordinator.evaluation) void this.refresh();
  }
  /**
   * Starts choosing the references `evaluation` reports broken: of the edit `op` that failed, or
   * of the current content (`op` undefined). The first candidate that names can pick is chosen
   * for each and previewed.
   */
  private startRebind(
    op: CadOperation | undefined,
    evaluation: CadEvaluation & { status: 'error' },
    candidate: CadDocument,
    previous?: RebindState,
  ) {
    const problems = evaluation.references ?? [];
    const featureId = evaluation.featureId ?? problems[0]?.featureId ?? '';
    // The references are a feature's, or a sketch's attachment to a face.
    const feature = candidate.features.find((f) => f.id === featureId);
    const sketch = candidate.sketches.find((s) => s.id === featureId);
    // Or a joint's connectors (R2b-2b).
    const joint = candidate.joints.find((j) => j.id === featureId);
    // Poses are solved again after the choice: the edit is the one under them.
    const plain = op?.type === 'withSolvedPoses' ? op.edit : op;
    const edit = plain?.type === 'rebindReferences' ? plain.edit : plain;
    const earlier = plain?.type === 'rebindReferences' ? plain.bindings : [];
    const choices = problems.map((p) => p.candidates.findIndex((c) => !!c.ref));
    const refs = feature
      ? featureReferences(feature)
      : sketch
        ? sketchReferences(sketch)
        : joint
          ? jointReferences(joint)
          : [];
    this.rebind = {
      edit,
      earlier,
      featureId,
      problems,
      choices,
      round: 0,
      ...(previous ? { previous } : {}),
      view: {
        featureName: feature?.name ?? sketch?.name ?? joint?.name ?? featureId,
        withEdit: !!edit,
        problems: problems.map((p, i) => ({
          path: p.path,
          status: p.status,
          name: refs.find((r) => JSON.stringify(r.path) === JSON.stringify(p.path))?.ref.name,
          candidates: p.candidates.map((c) => ({ hint: c.hint, selectable: !!c.ref })),
          choice: choices[i]!,
        })),
        active: 0,
        canGoBack: !!previous,
        status: 'evaluating',
      },
    };
    this.diagnostic = undefined;
    void this.previewRebind();
  }
  /** The current content cannot be evaluated because of broken references: choose them again. */
  rebindCurrent() {
    const failure = this.coordinator.geometryFailure;
    if (!failure?.references?.length) return;
    if (!this.options.canEdit()) return void this.refuse('permission-denied');
    this.startRebind(undefined, failure, this.coordinator.content);
    this.emit();
  }
  /** Chooses candidate `candidate` for broken reference `problem` and previews it. */
  chooseRebind(problem: number, candidate: number) {
    const r = this.rebind;
    const c = r?.problems[problem]?.candidates[candidate];
    if (!r || !c?.ref) return;
    r.choices[problem] = candidate;
    r.view = {
      ...r.view,
      problems: r.view.problems.map((p, i) => (i === problem ? { ...p, choice: candidate } : p)),
      active: problem,
    };
    void this.previewRebind();
  }
  private rebindOperation(): Extract<CadOperation, { type: 'rebindReferences' }> | undefined {
    const r = this.rebind!;
    const chosen = r.problems.map((p, i) => ({
      featureId: p.featureId,
      path: p.path,
      ref: p.candidates[r.choices[i]!]?.ref,
    }));
    if (chosen.some((b) => !b.ref)) return undefined;
    const key = (b: { featureId: string; path: (string | number)[] }) =>
      JSON.stringify([b.featureId, b.path]);
    const now = new Set(chosen.map(key));
    return {
      type: 'rebindReferences',
      ...(r.edit ? { edit: r.edit } : {}),
      bindings: [
        ...r.earlier.filter((b) => !now.has(key(b))),
        ...(chosen as CadReferenceBinding[]),
      ],
    };
  }
  /** Evaluates the current choice; the viewport shows its meshes while it is open. */
  private async previewRebind() {
    const r = this.rebind;
    if (!r) return;
    if (r.ticket) this.coordinator.cancel(r.ticket);
    r.ticket = undefined;
    const round = ++r.round;
    const op = this.rebindOperation();
    if (!op) {
      r.view = { ...r.view, status: 'blocked', message: describeCode('rebind-blocked') };
      delete r.view.previewHash;
      this.emit();
      return;
    }
    r.view = { ...r.view, status: 'evaluating' };
    delete r.view.message;
    this.emit();
    const prepared = await this.coordinator.prepare(op);
    if (this.rebind !== r || round !== r.round) {
      if (prepared.status === 'ready') this.coordinator.cancel(prepared.ticket);
      // Its meshes may have released the current display after the choice was left.
      if (!this.rebind) this.restoreReleased();
      return;
    }
    if (prepared.status === 'ready' && this.overBudget.has(cadContentHash(prepared.candidate))) {
      // Its meshes could not be kept, so confirming it would leave nothing to show.
      this.coordinator.cancel(prepared.ticket);
      r.view = { ...r.view, status: 'failed', message: describeCode('memory-budget') };
      delete r.view.previewHash;
    } else if (prepared.status === 'ready') {
      r.ticket = prepared.ticket;
      r.preview = { content: prepared.candidate, evaluation: prepared.evaluation };
      r.view = { ...r.view, status: 'ready', previewHash: cadContentHash(prepared.candidate) };
    } else if (
      prepared.status === 'geometry-error' &&
      prepared.evaluation.references?.length &&
      prepared.evaluation.featureId !== r.featureId
    ) {
      // This choice is fine, but a later feature's references break in turn: choose those too,
      // keeping this one to go back to.
      this.startRebind(op, prepared.evaluation, prepared.candidate, r);
      return;
    } else {
      const code =
        prepared.status === 'geometry-error'
          ? prepared.evaluation.code
          : prepared.status === 'rejected'
            ? prepared.code
            : 'stale';
      r.view = { ...r.view, status: 'failed', message: describeCode(code) };
      delete r.view.previewHash;
    }
    this.emit();
  }
  /** Goes back to the earlier feature whose choice broke the current one, as it was chosen. */
  backRebind() {
    const r = this.rebind;
    if (!r?.previous) return;
    if (r.ticket) this.coordinator.cancel(r.ticket);
    const { ticket: _stale, ...previous } = r.previous;
    this.rebind = previous;
    void this.previewRebind();
  }
  /** Applies the previewed choice and its edit as one edit (one Undo). */
  confirmRebind(): boolean {
    const r = this.rebind;
    if (!r?.ticket || r.view.status !== 'ready') return false;
    this.rebind = undefined;
    const drawing = this.suspendedSketch;
    this.suspendedSketch = undefined;
    const result = this.coordinator.apply(r.ticket);
    const applied = result.status === 'applied';
    if (result.status === 'rejected') this.fail(result.code);
    // Nothing was stored: the drawing whose Finish waited on this choice comes back.
    if (!applied && drawing) this.sketching = drawing;
    if (applied) this.options.onApplied?.(this.coordinator.content);
    this.emit();
    if (!applied) this.restoreReleased();
    else if (!this.coordinator.evaluation) void this.refresh();
    return applied;
  }
  /** Leaves the references and the edit as they were; nothing is stored. */
  cancelRebind() {
    const drawing = this.suspendedSketch;
    this.dropRebind();
    if (drawing) this.sketching = drawing;
    this.emit();
    this.restoreReleased();
  }
  /** Leaves the choice (Cancel, another edit, history, a Host sync): its edit's field resets. */
  private dropRebind() {
    if (this.rebind?.ticket) this.coordinator.cancel(this.rebind.ticket);
    if (this.rebind?.edit) this.rejections++;
    this.rebind = undefined;
    this.suspendedSketch = undefined;
  }
  /**
   * Explicit kernel migration: one edit that names the Host's current build, evaluated exactly
   * by it before it is applied. Earlier versions keep their bytes, hash and build.
   */
  async prepareMigration(): Promise<CadMigrationPreview | undefined> {
    const target = this.options.currentKernel;
    if (!target) return this.refusePrepared('kernel-build-unavailable');
    return this.prepareProfile(
      { type: 'setKernelBuild', kernelId: target.id, buildHash: target.buildHash },
      {},
    );
  }
  /**
   * K2 (docs/cad/complex-models.md): one edit that changes the document's tolerance set. The
   * whole graph is evaluated with the new set and compared with the shown shape (validity, solids,
   * volume, bounds) before it is adopted. Never chosen because an evaluation failed.
   */
  async prepareToleranceSet(set: CadToleranceSet): Promise<CadMigrationPreview | undefined> {
    const from = cadToleranceSetOf(this.coordinator.content.kernelProfile);
    return this.prepareProfile({ type: 'setToleranceSet', set }, { tolerance: { from, to: set } });
  }
  private refusePrepared(code: string) {
    this.fail(code);
    this.emit();
    this.restoreReleased();
    return undefined;
  }
  /** Prepares a change of the kernel profile (build or tolerance set) for its preview. */
  private async prepareProfile(
    op: Extract<CadOperation, { type: 'setKernelBuild' | 'setToleranceSet' }>,
    extra: Pick<CadMigrationPreview, 'tolerance'>,
  ): Promise<CadMigrationPreview | undefined> {
    const refuse = (code: string) => this.refusePrepared(code);
    if (!this.options.canEdit()) return refuse('permission-denied');
    const before = this.coordinator.content;
    const shown = this.coordinator.evaluation;
    const operation = ++this.operation;
    this.busy = this.evaluatingEdit = true;
    this.progress = undefined;
    this.diagnostic = undefined;
    this.emit();
    const prepared = await this.coordinator.prepare(op);
    if (operation === this.operation) this.busy = this.evaluatingEdit = false;
    if (prepared.status !== 'ready') {
      if (prepared.status === 'geometry-error') return refuse(prepared.evaluation.code);
      if (prepared.status === 'rejected') return refuse(prepared.code);
      this.emit();
      this.restoreReleased();
      return undefined;
    }
    // Its meshes did not fit the budget: the migration is refused like an edit (CAD26).
    if (this.overBudget.has(cadContentHash(prepared.candidate))) {
      this.coordinator.cancel(prepared.ticket);
      return refuse('memory-budget');
    }
    const preview: CadMigrationPreview = {
      fromBuildHash: before.kernelProfile.buildHash,
      toBuildHash: prepared.candidate.kernelProfile.buildHash,
      ...extra,
      ...(shown?.status === 'error' ? { shownCode: shown.code } : {}),
      bodies: before.bodies
        .filter((b) => b.state === 'active')
        .map((b) => ({
          id: b.id,
          name: b.name,
          ...(shown?.status === 'ok' && shown.bodies[b.id] ? { shown: shown.bodies[b.id] } : {}),
          next: prepared.evaluation.bodies[b.id],
        })),
    };
    this.migration = { ticket: prepared.ticket, preview };
    this.emit();
    return preview;
  }
  /** Adopts the prepared migration as one edit; refused if anything changed since preparing. */
  adoptMigration(): boolean {
    const pending = this.migration;
    this.migration = undefined;
    this.dropPrepared();
    if (!pending) return false;
    const result = this.coordinator.apply(pending.ticket);
    const applied = result.status === 'applied';
    if (result.status === 'rejected') this.fail(result.code);
    if (applied) this.options.onApplied?.(this.coordinator.content);
    this.emit();
    if (!applied) this.restoreReleased();
    // A late result may have released the candidate's evaluation while the preview was open: the
    // adopted content is then evaluated again.
    else if (!this.coordinator.evaluation) void this.refresh();
    return applied;
  }
  /** Discards the prepared migration; content and history stay as they are. */
  cancelMigration() {
    if (this.migration) this.coordinator.cancel(this.migration.ticket);
    this.migration = undefined;
    this.emit();
    this.restoreReleased();
  }
  /**
   * Prepares `op` for a preview without applying it (R2b-2b, a part version update): `ready`
   * with its candidate and evaluation, `broken` when joints' connectors no longer resolve on it,
   * undefined when it was refused (the diagnostic says why) or superseded.
   */
  async prepareEdit(op: CadOperation): Promise<CadEditPreview | undefined> {
    const refuse = (code: string) => {
      this.fail(code);
      this.emit();
      this.restoreReleased();
      return undefined;
    };
    this.migration = undefined;
    this.dropPrepared();
    this.dropRebind();
    if (this.sketching) return refuse('sketch-open');
    if (!this.options.canEdit()) return refuse('permission-denied');
    const operation = ++this.operation;
    this.busy = this.evaluatingEdit = true;
    this.progress = undefined;
    this.diagnostic = undefined;
    this.emit();
    const prepared = await this.coordinator.prepare(op);
    if (operation === this.operation) this.busy = this.evaluatingEdit = false;
    if (operation !== this.operation) {
      if (prepared.status === 'ready') this.coordinator.cancel(prepared.ticket);
      return undefined;
    }
    if (prepared.status === 'ready') {
      if (this.overBudget.has(cadContentHash(prepared.candidate))) {
        this.coordinator.cancel(prepared.ticket);
        return refuse('memory-budget');
      }
      this.prepared = { op, ticket: prepared.ticket };
      this.emit();
      return {
        status: 'ready',
        candidate: prepared.candidate,
        evaluation: prepared.evaluation as CadEvaluation & { status: 'ok' },
      };
    }
    if (prepared.status === 'geometry-error' && prepared.evaluation.brokenJoints?.length) {
      this.prepared = { op, evaluation: prepared.evaluation, candidate: prepared.candidate };
      this.emit();
      this.restoreReleased();
      return { status: 'broken', candidate: prepared.candidate, evaluation: prepared.evaluation };
    }
    if (prepared.status === 'geometry-error') return refuse(prepared.evaluation.code);
    if (prepared.status === 'rejected') return refuse(prepared.code);
    this.emit();
    this.restoreReleased();
    return undefined;
  }
  /** Applies the prepared edit as one edit; refused if anything changed since preparing. */
  adoptEdit(): boolean {
    const pending = this.prepared;
    this.prepared = undefined;
    if (!pending || !('ticket' in pending)) return false;
    const result = this.coordinator.apply(pending.ticket);
    const applied = result.status === 'applied';
    if (result.status === 'rejected') this.fail(result.code);
    if (applied) this.options.onApplied?.(this.coordinator.content);
    this.emit();
    if (!applied) this.restoreReleased();
    else if (!this.coordinator.evaluation) void this.refresh();
    return applied;
  }
  /** The prepared edit broke joints: choose their connectors again, with it, as one edit. */
  rebindEdit(): boolean {
    const pending = this.prepared;
    if (!pending || 'ticket' in pending || !pending.evaluation.references?.length) return false;
    this.prepared = undefined;
    this.startRebind(pending.op, pending.evaluation, pending.candidate);
    this.emit();
    return true;
  }
  /** Whether an edit is still prepared (another edit, history or a sync drops it). */
  /** Current edit authority from the Host, read now (not the last snapshot's). */
  get editable() {
    return this.options.canEdit();
  }
  get editPrepared() {
    return !!this.prepared;
  }
  /** Discards the prepared edit; content and history stay as they are. */
  cancelEdit() {
    this.dropPrepared();
    this.emit();
    this.restoreReleased();
  }
  private dropPrepared() {
    if (this.prepared && 'ticket' in this.prepared) this.coordinator.cancel(this.prepared.ticket);
    this.prepared = undefined;
  }
  async undo() {
    if (this.sketching) return;
    if (!this.options.session.canUndo) return;
    if (!this.options.canEdit()) {
      this.fail('permission-denied');
      this.emit();
      return;
    }
    this.migration = undefined;
    this.dropPrepared();
    this.dropRebind();
    const done = this.coordinator.undo();
    this.emit();
    await done;
    this.emit();
    this.restoreReleased();
  }
  async redo() {
    if (this.sketching) return;
    if (!this.options.session.canRedo) return;
    if (!this.options.canEdit()) {
      this.fail('permission-denied');
      this.emit();
      return;
    }
    this.migration = undefined;
    this.dropPrepared();
    this.dropRebind();
    const done = this.coordinator.redo();
    this.emit();
    await done;
    this.emit();
    this.restoreReleased();
  }
  /** The Host's permission changed: rebuild the snapshot (read-only state) and notify. */
  accessChanged() {
    this.emit();
  }
  /** After the Host changed the session itself (Undo/Redo, restore): drop prepared work, re-evaluate. */
  sync() {
    this.migration = undefined;
    this.dropPrepared();
    this.dropRebind();
    this.coordinator.invalidate();
    return this.refresh();
  }
  /** `retry` (Recalculate) also re-evaluates a cached failure such as a timeout. */
  async refresh({ retry = false }: { retry?: boolean } = {}) {
    const done = this.coordinator.refresh({ retry });
    this.emit();
    await done;
    this.emit();
    // A late result of content no longer current may have released the current display.
    this.restoreReleased();
  }

  // Sketch mode (docs/cad/r1-modeling.md, Surface). The drawing is solved after each change and
  // becomes one edit only when it is finished; leaving the mode drops it.
  private startDrawing(sketch: CadSketch, isNew: boolean) {
    if (!this.snapshot.canSketch) return this.refuse('sketch-unavailable');
    this.select(null);
    this.diagnostic = undefined;
    // A stored sketch the solver now refuses (a satisfied but redundant constraint, say) opens as
    // it is with the refusal shown, so its constraints can be inspected and repaired.
    let dof: number, problem: CadSketchView['problem'];
    try {
      dof = solveDraft(sketch, this.params()).dof;
    } catch (error) {
      dof = sketchFreedom(sketch, this.params()).dof;
      problem = this.sketchProblem(error, sketch);
    }
    this.sketching = { sketch, dof, isNew, problem };
    this.sketchIds = new Set();
    this.emit();
    return true;
  }
  private params() {
    return parameterValues(this.coordinator.content);
  }
  /** A new sketch on a datum plane through the origin: `xy`, `xz` (seen from −Y) or `yz`. */
  startSketch(plane: 'xy' | 'xz' | 'yz') {
    const h = Math.SQRT1_2;
    const orientations: Record<typeof plane, Quaternion> = {
      xy: [0, 0, 0, 1],
      xz: [h, 0, 0, h],
      yz: [0.5, 0.5, 0.5, 0.5],
    };
    const orientation = orientations[plane];
    return this.startDrawing(this.emptySketch({ origin: position(0, 0, 0), orientation }), true);
  }
  /** A new sketch on the picked planar face (its frame follows the face). */
  startSketchOnPickedFace() {
    const p = this.picked('face');
    if (!p) return undefined;
    if (!topologyInfo([p.mesh], this.selection)?.normal)
      return this.refuse('sketch-face-not-planar');
    return this.startDrawing(this.emptySketch({ face: p.ref, offset: mm(0) }), true);
  }
  /** Opens a sketch of the document for editing. */
  editSketch(sketchId: string) {
    const sketch = this.coordinator.content.sketches.find((s) => s.id === sketchId);
    if (!sketch) return this.refuse('target-missing');
    return this.startDrawing(structuredClone(sketch), false);
  }
  private emptySketch(plane: CadSketchPlane): CadSketch {
    const names = new Set(this.coordinator.content.sketches.map((s) => s.name));
    let k = 1;
    while (names.has(`Sketch ${k}`)) k++;
    return {
      id: this.id('sketch'),
      name: `Sketch ${k}`,
      plane,
      entities: [],
      constraints: [],
      solved: {},
    };
  }
  /**
   * Applies one change to the drawing and solves it. A change the solver refuses leaves the
   * drawing as it was and is shown with the elements it names; returns whether it was taken.
   */
  private draw(change: (s: CadSketch) => CadSketch, named: (s: CadSketch) => string[] = () => []) {
    const current = this.sketching;
    if (!current) return false;
    let next: CadSketch | undefined;
    try {
      next = change(current.sketch);
      const { sketch, dof } = solveDraft(next, this.params());
      for (const x of [...current.sketch.entities, ...current.sketch.constraints])
        this.sketchIds.add(x.id);
      this.sketching = { ...current, sketch, dof, problem: undefined };
      this.emit();
      return true;
    } catch (error) {
      // A change refused before it gave a drawing names its elements on the current one.
      this.sketching = {
        ...current,
        problem: this.sketchProblem(error, next ?? current.sketch, named),
      };
      this.rejections++;
      this.emit();
      return false;
    }
  }
  /** A refusal of the solver, shown with the elements and constraint it names in `s`. */
  private sketchProblem(
    error: unknown,
    s: CadSketch | undefined,
    named: (s: CadSketch) => string[] = () => [],
  ): NonNullable<CadSketchView['problem']> {
    const code =
      error instanceof CadSketchError
        ? error.code
        : error instanceof Error
          ? error.message
          : String(error);
    const at = error instanceof CadSketchError ? error.at : undefined;
    const k =
      at?.startsWith('constraints[') && s ? s.constraints[Number(at.slice(12, -1))] : undefined;
    const e = at?.startsWith('entities[') && s ? s.entities[Number(at.slice(9, -1))] : undefined;
    return {
      code,
      message: describeCode(code),
      elements: k ? [k.id, ...constraintTargets(k)] : e ? [e.id] : s ? named(s) : [],
    };
  }
  /** Applies an addition; returns the new element's ID, or undefined when it was refused. */
  private add(change: (s: CadSketch) => { sketch: CadSketch; id: string }) {
    let id: string | undefined;
    const taken = this.draw((s) => {
      const added = change(s);
      id = added.id;
      return added.sketch;
    });
    return taken ? id : undefined;
  }
  sketchLine(a: SketchPointInput, b: SketchPointInput) {
    return this.add((s) => addLine(s, a, b, this.sketchIds));
  }
  sketchCircle(center: SketchPointInput, radius: number) {
    return this.add((s) => addCircle(s, center, radius, this.sketchIds));
  }
  sketchArc(
    center: SketchPointInput,
    start: SketchPointInput,
    end: SketchPointInput,
    clockwise: boolean,
  ) {
    return this.add((s) => addArc(s, center, start, end, clockwise, this.sketchIds));
  }
  /**
   * Adds a spline (R2a) on control points, degree 3 unless given; with `through`, the points are
   * on the curve and its control points are computed (SC-5).
   */
  sketchSpline(poles: SketchPointInput[], closed: boolean, degree: 2 | 3 | 5 = 3, through = false) {
    return this.add((s) => addSpline(s, poles, degree, closed, this.sketchIds, through));
  }
  /**
   * CR3a: adds the selected chain moved `distance` mm sideways (left of an open chain as its first
   * selected element runs, out of a closed one; negative: the other side) as new elements without
   * constraints. Returns their IDs, or undefined when refused (the selection stays highlighted).
   */
  sketchOffset(ids: string[], distance: number) {
    let added: string[] | undefined;
    const taken = this.draw(
      (s) => {
        const r = addOffset(s, ids, distance, this.sketchIds);
        added = r.ids;
        return r.sketch;
      },
      () => ids,
    );
    return taken ? added : undefined;
  }
  /** Adds a constraint; a redundant or conflicting one is refused and highlighted. */
  sketchConstrain(k: SketchConstraintInput) {
    return this.draw(
      (s) => addConstraint(s, k, this.sketchIds).sketch,
      () => constraintTargets({ ...k, id: '' } as CadSketchConstraint),
    );
  }
  /** Removes several elements and constraints as one change (Delete on the selection). */
  sketchRemoveAll(ids: string[]) {
    return this.draw((s) => ids.reduce((x, id) => removeItem(x, id), s));
  }
  sketchRemove(id: string) {
    return this.draw((s) => removeItem(s, id));
  }
  sketchDimension(id: string, value: Length) {
    return this.draw((s) => setDimension(s, id, value));
  }
  /** Drags a point: the drawing is solved again from there, its constraints kept. */
  sketchMove(pointId: string, at: [number, number]) {
    return this.draw((s) => movePoint(s, pointId, at));
  }
  /** Leaves Sketch mode without an edit (Escape). */
  cancelSketch() {
    if (!this.sketching) return;
    this.sketching = undefined;
    this.emit();
  }
  /**
   * Finishes the drawing as one edit: a new sketch is inserted (with `extrude`, swept `distance`
   * mm from the region it closes into a new body), an existing one updated. The mode stays open
   * when the edit is refused.
   */
  async finishSketch(extrude?: { distance: number }) {
    const view = this.snapshot.sketch;
    if (!view) return false;
    const { sketch } = view;
    let op: CadOperation;
    if (!view.isNew)
      op = {
        type: 'updateSketch',
        sketchId: sketch.id,
        plane: sketch.plane,
        entities: sketch.entities,
        constraints: sketch.constraints,
        solved: sketch.solved,
      };
    else if (extrude) {
      if (!view.region) return this.refuse('sketch-no-region') ?? false;
      const id = this.id('extrude');
      op = {
        type: 'insertFeatures',
        sketches: [sketch],
        features: [
          {
            id,
            name: 'Extrude',
            type: 'extrude',
            inputFeatureIds: [],
            args: {
              sketchId: sketch.id,
              region: view.region,
              distance: mm(extrude.distance),
              direction: 1,
            },
          },
        ],
        bodies: [this.newBody(id, sketch.name)],
      };
    } else op = { type: 'insertFeatures', sketches: [sketch], features: [] };
    const drawing = this.sketching;
    this.sketching = undefined;
    const applied = await this.run(op);
    // Broken references are chosen on the view first; Cancel there comes back to the drawing.
    if (!applied && this.rebind) this.suspendedSketch = drawing;
    else if (!applied && !this.sketching) this.sketching = drawing;
    this.emit();
    return applied;
  }

  // Operation builders. IDs are assigned here, once, before prepare (trusted layer).
  private newBody(sourceFeatureId: string, name: string) {
    const id = this.id('body');
    return {
      id,
      name,
      sourceFeatureId,
      placementFeatureId: this.id('placement'),
      appearance: { color: '#8aa1b8', opacity: 1 },
    };
  }
  /** Beside the evaluated bodies, so a new body does not land inside an existing one. */
  private nextOrigin(): Position3 {
    const evaluation = this.coordinator.evaluation;
    const bounds =
      evaluation?.status === 'ok'
        ? Object.values(evaluation.bodies).map((b) => b.bounds[1][0])
        : [];
    return position(bounds.length ? Math.ceil(Math.max(...bounds) / 10) * 10 + 10 : 0, 0, 0);
  }
  /** A new parameter with a default value, selected for editing in the Inspector. */
  async addParameter(type: CadParameter['type']) {
    const id = this.id('param');
    const label = { length: 'Length', angle: 'Angle', count: 'Count' }[type];
    const names = new Set(this.coordinator.content.parameters.map((p) => p.name));
    let k = 1;
    while (names.has(`${label} ${k}`)) k++;
    const value = { length: 10, angle: Math.PI / 2, count: 2 }[type];
    const applied = await this.run({
      type: 'insertFeatures',
      parameters: [{ id, name: `${label} ${k}`, type, value }],
      features: [],
    });
    if (applied) this.select({ kind: 'parameter', id });
    return applied;
  }
  addPrimitive(type: 'box' | 'cylinder' | 'sphere') {
    const id = this.id(type);
    const origin = this.nextOrigin();
    const orientation = identityQuaternion();
    const name = { box: 'Box', cylinder: 'Cylinder', sphere: 'Sphere' }[type];
    const feature: CadFeature =
      type === 'box'
        ? {
            id,
            name,
            type,
            inputFeatureIds: [],
            args: { size: [mm(30), mm(20), mm(10)], origin, orientation },
          }
        : type === 'cylinder'
          ? {
              id,
              name,
              type,
              inputFeatureIds: [],
              args: { radius: mm(10), height: mm(20), origin, orientation },
            }
          : { id, name, type, inputFeatureIds: [], args: { radius: mm(10), origin, orientation } };
    return this.run({
      type: 'insertFeatures',
      features: [feature],
      bodies: [this.newBody(id, name)],
    });
  }
  /**
   * WM1a: a standard involute spur gear (module 1 mm, 24 teeth, 20°, 5 mm wide, 5 mm bore) at the
   * next free spot; its teeth, module, windows and the rest are edited in the inspector.
   */
  addGear() {
    const id = this.id('gear');
    return this.run({
      type: 'insertFeatures',
      features: [
        {
          id,
          name: 'Gear',
          type: 'spurGear',
          inputFeatureIds: [],
          args: {
            module: mm(1),
            teeth: { literal: 24 },
            profile: 'involute',
            pressureAngle: { literalRad: (20 * Math.PI) / 180 },
            profileShift: 0,
            addendum: 1,
            dedendum: 1.25,
            faceWidth: mm(5),
            bore: mm(5),
            origin: this.nextOrigin(),
            orientation: identityQuaternion(),
          },
        },
      ],
      bodies: [this.newBody(id, 'Gear')],
    });
  }
  /** A width parameter, a rectangle profile and an extrusion: the parametric starting point. */
  addPlate() {
    const [w, profile, extrude] = [this.id('param'), this.id('profile'), this.id('extrude')];
    const n = this.coordinator.content.parameters.length;
    return this.run({
      type: 'insertFeatures',
      parameters: [{ id: w, name: n ? `Width ${n + 1}` : 'Width', type: 'length', value: 80 }],
      profiles: [
        {
          id: profile,
          name: 'Plate outline',
          plane: { origin: this.nextOrigin(), orientation: identityQuaternion() },
          shape: { type: 'rectangle', width: { parameterId: w }, height: mm(50) },
        },
      ],
      features: [
        {
          id: extrude,
          name: 'Plate',
          type: 'extrude',
          inputFeatureIds: [],
          args: { profileId: profile, distance: mm(5), direction: 1 },
        },
      ],
      bodies: [this.newBody(extrude, 'Plate')],
    });
  }
  /** A circle profile extruded: a disc of radius 15 mm and thickness 10 mm. */
  addDisc() {
    const [profile, extrude] = [this.id('profile'), this.id('extrude')];
    const [x, y, z] = this.nextOrigin().map((l) => ('literalMm' in l ? l.literalMm : 0));
    return this.run({
      type: 'insertFeatures',
      profiles: [
        {
          id: profile,
          name: 'Disc outline',
          // Centred one radius past the next free origin, so the disc starts there.
          plane: { origin: position(x + 15, y, z), orientation: identityQuaternion() },
          shape: { type: 'circle', radius: mm(15) },
        },
      ],
      features: [
        {
          id: extrude,
          name: 'Disc',
          type: 'extrude',
          inputFeatureIds: [],
          args: { profileId: profile, distance: mm(10), direction: 1 },
        },
      ],
      bodies: [this.newBody(extrude, 'Disc')],
    });
  }
  /** A closed polyline (an L, six vertices) extruded 10 mm. */
  addPrism() {
    const [profile, extrude] = [this.id('profile'), this.id('extrude')];
    const corners = [
      [0, 0],
      [40, 0],
      [40, 10],
      [10, 10],
      [10, 30],
      [0, 30],
    ];
    return this.run({
      type: 'insertFeatures',
      profiles: [
        {
          id: profile,
          name: 'Prism outline',
          plane: { origin: this.nextOrigin(), orientation: identityQuaternion() },
          shape: {
            type: 'polyline',
            vertices: corners.map(([u, v]) => ({ id: this.id('vertex'), u: mm(u), v: mm(v) })),
          },
        },
      ],
      features: [
        {
          id: extrude,
          name: 'Prism',
          type: 'extrude',
          inputFeatureIds: [],
          args: { profileId: profile, distance: mm(10), direction: 1 },
        },
      ],
      bodies: [this.newBody(extrude, 'Prism')],
    });
  }
  /**
   * A rectangle section (radii 10–15 mm, height 20 mm) in the XZ plane revolved a full turn
   * about a vertical axis 15 mm past the next free origin, so the ring starts there: F03's ring.
   */
  addRing() {
    const [profile, revolve] = [this.id('profile'), this.id('revolve')];
    const [x, y, z] = this.nextOrigin().map((l) => ('literalMm' in l ? l.literalMm : 0));
    return this.run({
      type: 'insertFeatures',
      profiles: [
        {
          id: profile,
          name: 'Ring section',
          // +90° about X maps plane u/v to world X/Z.
          plane: {
            origin: position(x + 25, y, z),
            orientation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
          },
          shape: { type: 'rectangle', width: mm(5), height: mm(20) },
        },
      ],
      features: [
        {
          id: revolve,
          name: 'Ring',
          type: 'revolve',
          inputFeatureIds: [],
          args: {
            profileId: profile,
            axisOrigin: [mm(-10), mm(0)],
            axisDirection: [0, 1],
            angle: { literalRad: 2 * Math.PI },
          },
        },
      ],
      bodies: [this.newBody(revolve, 'Ring')],
    });
  }
  /**
   * A loft through the closed regions of `sketchIds`, in that order, into a new body (R1e). Each
   * sketch's region is the one its drawing closes; one without, or with holes, is refused. With
   * `surface`, a sheet through the chain (open, or one loop) each sketch draws (R2a-2b), or a
   * chain of edges given in place of a sketch (R2a-2c).
   */
  async addLoft(
    sketchIds: (
      | string
      | { edges: CadTopologyRef[] }
      | { derivedFrom: number; offsetMm: number; scale: number }
    )[],
    ruled: boolean,
    surface = false,
  ) {
    const doc = this.coordinator.content;
    const sections: CadLoftSection[] = [];
    const chains = [];
    for (const id of sketchIds) {
      // K6: a section derived from an earlier one, moved along its normal and scaled.
      if (typeof id !== 'string' && 'derivedFrom' in id) {
        if (surface) return this.refuse('section-region') ?? false;
        sections.push({
          derivedFrom: id.derivedFrom,
          offset: [{ literalMm: 0 }, { literalMm: 0 }, { literalMm: id.offsetMm }],
          scale: { literal: id.scale },
          angle: { literalRad: 0 },
        });
        continue;
      }
      // A chain of edges of results is a section of a surface loft only (R2a-2c).
      if (typeof id !== 'string') {
        if (!surface) return this.refuse('section-region') ?? false;
        chains.push(id);
        continue;
      }
      const sketch = doc.sketches.find((s) => s.id === id);
      if (surface) {
        const elements = sketch && sketchDefaultPath(sketch, 'allow');
        if (!elements) return this.refuse('surface-path') ?? false;
        chains.push({ sketchId: id, elements });
        continue;
      }
      const region = sketch && sketchDefaultRegion(sketch);
      if (!region) return this.refuse('section-region') ?? false;
      sections.push({ sketchId: id, region });
    }
    const loft = this.id('loft');
    const applied = await this.run({
      type: 'insertFeatures',
      features: [
        surface
          ? {
              id: loft,
              name: 'Lofted surface',
              type: 'surfaceLoft',
              inputFeatureIds: [],
              args: { sections: chains, ruled },
            }
          : {
              id: loft,
              name: 'Loft',
              type: 'loft',
              inputFeatureIds: [],
              args: { sections, ruled },
            },
      ],
      bodies: [this.newBody(loft, surface ? 'Surface' : 'Loft')],
    });
    if (applied) {
      if (sketchIds.some((x) => typeof x !== 'string')) this.collected = [];
      this.select({ kind: 'feature', id: loft });
    }
    return applied;
  }
  /**
   * The closed region of `profileId` swept along the open chain `pathId` draws, into a new body
   * (R1e). With `surface`, a sheet: the profile sketch's chain (open, or one loop) swept (R2a-2b).
   */
  async addSweep(
    profileId: string,
    pathId: string,
    orientation: 'frenet' | 'fixed',
    surface = false,
  ) {
    const doc = this.coordinator.content;
    const profile = doc.sketches.find((s) => s.id === profileId);
    const path = doc.sketches.find((s) => s.id === pathId);
    const region = !surface && profile ? sketchDefaultRegion(profile) : undefined;
    const chain = surface && profile ? sketchDefaultPath(profile, 'allow') : undefined;
    if (surface ? !chain : !region)
      return this.refuse(surface ? 'surface-path' : 'section-region') ?? false;
    const elements = path && sketchDefaultPath(path);
    if (!elements) return this.refuse('sweep-path') ?? false;
    const sweep = this.id('sweep');
    const along = { sketchId: pathId, elements };
    const applied = await this.run({
      type: 'insertFeatures',
      features: [
        chain
          ? {
              id: sweep,
              name: 'Swept surface',
              type: 'surfaceSweep',
              inputFeatureIds: [],
              args: { profile: { sketchId: profileId, elements: chain }, path: along, orientation },
            }
          : {
              id: sweep,
              name: 'Sweep',
              type: 'sweep',
              inputFeatureIds: [],
              args: { profile: { sketchId: profileId, region: region! }, path: along, orientation },
            },
      ],
      bodies: [this.newBody(sweep, chain ? 'Surface' : 'Sweep')],
    });
    if (applied) this.select({ kind: 'feature', id: sweep });
    return applied;
  }
  /**
   * CR4d: a member: a section of `kind` (mm dimensions) swept along the open chain `pathId`
   * draws, into a new sheet body, its height along the sketch's normal or in its plane.
   */
  async addProfileSweep(
    pathId: string,
    profile: {
      kind: CadProfileKind;
      heightMm: number;
      widthMm: number;
      flangeMm: number;
      radiusMm: number;
    },
    up: 'normal' | 'inPlane',
    flip: boolean,
  ) {
    const path = this.coordinator.content.sketches.find((s) => s.id === pathId);
    const elements = path && sketchDefaultPath(path);
    if (!elements) return this.refuse('sweep-path') ?? false;
    const id = this.id('member');
    const applied = await this.run({
      type: 'insertFeatures',
      features: [
        {
          id,
          name: 'Member',
          type: 'profileSweep',
          inputFeatureIds: [],
          args: {
            path: { sketchId: pathId, elements },
            profile: {
              kind: profile.kind,
              height: mm(profile.heightMm),
              width: mm(profile.widthMm),
              flange: mm(profile.flangeMm),
              radius: mm(profile.radiusMm),
            },
            up,
            flip,
          },
        },
      ],
      bodies: [this.newBody(id, 'Member')],
    });
    if (applied) this.select({ kind: 'feature', id });
    return applied;
  }
  /**
   * Keeps the picked edge, as a reference on its body's result, for a boundary surface, fill or
   * loft section (R2a-2c). An edge already kept is not kept twice.
   */
  collectPickedEdge() {
    const p = this.picked('edge');
    if (!p) return false;
    const key = (r: CadTopologyRef) => JSON.stringify([r.featureId, r.name, r.select]);
    if (this.collected.some((c) => key(c.ref) === key(p.ref))) return true;
    this.collected = [
      ...this.collected,
      {
        ref: p.ref,
        label: `${formatTopoName(p.ref.name)} (${p.body.name})`,
        free: p.mesh.topology.edges[p.index]!.faces.length === 1,
      },
    ];
    this.emit();
    return true;
  }
  clearCollectedEdges() {
    this.collected = [];
    this.emit();
  }
  /**
   * A boundary surface (3 or 4 curves) or a fill (3 to 16, each `G0` or `G1` to the face beside
   * a referenced edge) through sketch curves and collected edges, in loop order, into a new
   * sheet body (R2a-2c). The collected edges are used up when it applies.
   */
  async addBoundary(
    kind: 'boundarySurface' | 'fill',
    curves: { curve: CadCurveSource; continuity?: 'G0' | 'G1' | 'G2' }[],
  ) {
    const id = this.id(kind === 'fill' ? 'fill' : 'boundary');
    const applied = await this.run({
      type: 'insertFeatures',
      features: [
        kind === 'fill'
          ? {
              id,
              name: 'Fill',
              type: 'fill',
              inputFeatureIds: [],
              args: {
                boundary: curves.map((c) => ({ curve: c.curve, continuity: c.continuity ?? 'G0' })),
              },
            }
          : {
              id,
              name: 'Boundary surface',
              type: 'boundarySurface',
              inputFeatureIds: [],
              args: { curves: curves.map((c) => c.curve) },
            },
      ],
      bodies: [this.newBody(id, 'Surface')],
    });
    if (applied) {
      if (curves.some((c) => 'edge' in c.curve)) this.collected = [];
      this.select({ kind: 'feature', id });
    }
    return applied;
  }
  /**
   * CR1d: a Gordon surface through `u` curves crossed by `v` curves (2–16 each, in order), each
   * pair meeting within `toleranceMm`, into a new sheet body. Collected edges are used up.
   */
  async addCurveNetwork(u: CadCurveSource[], v: CadCurveSource[], toleranceMm = 0.01) {
    const id = this.id('network');
    const applied = await this.run({
      type: 'insertFeatures',
      features: [
        {
          id,
          name: 'Curve network',
          type: 'curveNetwork',
          inputFeatureIds: [],
          args: { u, v, toleranceMm },
        },
      ],
      bodies: [this.newBody(id, 'Surface')],
    });
    if (applied) {
      if ([...u, ...v].some((c) => 'edge' in c)) this.collected = [];
      this.select({ kind: 'feature', id });
    }
    return applied;
  }
  /**
   * Trims sheet `body` with a sketch's closed chain cut along the sketch's normal, a plane, or
   * another sheet body, keeping the pieces on side `keep` (R2a-3).
   */
  trimBody(
    body: CadBody,
    tool: { sketchId: string } | { plane: { origin: Vec3; normal: Vec3 } } | { bodyId: string },
    keep: 'inside' | 'outside' | 'front' | 'back',
    ifMissed?: 'skip',
  ) {
    const doc = this.coordinator.content;
    let made: CadTrimTool;
    // CR3c: a sketch of several closed chains (a row of windows) cuts them all at once.
    let chains: string[][] | undefined;
    if ('sketchId' in tool) {
      const sketch = doc.sketches.find((s) => s.id === tool.sketchId);
      const one = sketch && sketchDefaultPath(sketch, 'allow');
      const all = one ? [one] : sketch && sketchDefaultChains(sketch);
      if (!all) return Promise.resolve(this.refuse('surface-path') ?? false);
      made = { sketchId: tool.sketchId, elements: all[0]! };
      if (all.length > 1) chains = all.slice(1);
    } else if ('plane' in tool)
      made = { plane: { origin: position(...tool.plane.origin), normal: tool.plane.normal } };
    else {
      const other = doc.bodies.find((b) => b.id === tool.bodyId && b.state === 'active');
      if (!other) return Promise.resolve(this.refuse('trim-tool') ?? false);
      made = { featureId: other.resultFeatureId };
    }
    return this.detail(body, 'trim', 'Trim', {
      tool: made,
      keep,
      ...(chains && { chains }),
      ...(ifMissed && 'sketchId' in made && { ifMissed }),
    });
  }
  /**
   * CR3b: cuts a panel out of sheet `body` along the closed chain sketch `sketchId` draws, in one
   * edit: the pieces `keep` of the chain (inside: a door in the skin) become a new sheet body,
   * the body keeps the other side, and `gapMm` (0.5–10 mm) lies between them, half on each side
   * of the chain.
   */
  async cutPanel(
    body: CadBody,
    sketchId: string,
    gapMm: number,
    keep: 'inside' | 'outside' = 'inside',
  ) {
    const sketch = this.coordinator.content.sketches.find((s) => s.id === sketchId);
    const elements = sketch && sketchDefaultPath(sketch, 'allow');
    if (!elements) return this.refuse('surface-path') ?? false;
    const tool = { sketchId, elements };
    const gap = mm(gapMm);
    const trimId = this.id('trim');
    const panelId = this.id('panel');
    const name = `${body.name} panel`;
    const applied = await this.run({
      type: 'detailBody',
      bodyId: body.id,
      placementFeatureId: this.id('placement'),
      feature: {
        id: trimId,
        name: 'Trim',
        type: 'trim',
        inputFeatureIds: [body.resultFeatureId],
        args: { tool, keep: keep === 'inside' ? 'outside' : 'inside', gap },
      },
      panel: {
        feature: {
          id: panelId,
          name,
          type: 'panel',
          inputFeatureIds: [],
          args: {
            source: { featureId: body.resultFeatureId },
            tool: { sketchId, elements: [...elements] },
            keep,
            gap,
          },
        },
        body: this.newBody(panelId, name),
      },
    });
    if (applied) this.select({ kind: 'feature', id: panelId });
    return applied;
  }
  /**
   * CR2a: divides sheet `body` along the chain sketch `sketchId` draws (open, or one loop), carried
   * along the sketch's normal, keeping every piece.
   */
  splitBody(body: CadBody, sketchId: string) {
    const sketch = this.coordinator.content.sketches.find((s) => s.id === sketchId);
    const elements = sketch && sketchDefaultPath(sketch, 'allow');
    if (!elements) return Promise.resolve(this.refuse('surface-path') ?? false);
    return this.detail(body, 'split', 'Split', { tool: { sketchId, elements } });
  }
  /**
   * CR6d: a round groove of `radiusMm` in solid `body` along the chain sketch `sketchId` draws,
   * carried along the sketch's normal onto the nearest faces.
   */
  groove(body: CadBody, sketchId: string, radiusMm: number) {
    const sketch = this.coordinator.content.sketches.find((s) => s.id === sketchId);
    const elements = sketch && sketchDefaultPath(sketch, 'allow');
    if (!elements) return Promise.resolve(this.refuse('surface-path') ?? false);
    return this.detail(body, 'groove', 'Groove', {
      tool: { sketchId, elements },
      radius: mm(radiusMm),
    });
  }
  /**
   * CR2c: a press line on sheet `body` along the chain sketch `sketchId` draws: the pieces on
   * `side` (`left` is the inside of a closed chain, `right` the outside) moved `depthMm` along
   * the sheet's normal (`front`) or against it (`back`), the step's borders rounded by
   * `radiusMm`.
   */
  pressLine(
    body: CadBody,
    sketchId: string,
    options: {
      side: 'left' | 'right';
      depthMm: number;
      toward: 'front' | 'back';
      radiusMm: number;
    },
  ) {
    const sketch = this.coordinator.content.sketches.find((s) => s.id === sketchId);
    const elements = sketch && sketchDefaultPath(sketch, 'allow');
    if (!elements) return Promise.resolve(this.refuse('surface-path') ?? false);
    const path = sketchPath(sketch, elements, 'allow');
    const closed = !('code' in path) && path.closed;
    const side = closed ? (options.side === 'left' ? 'inside' : 'outside') : options.side;
    return this.detail(body, 'pressLine', 'Press line', {
      tool: { sketchId, elements },
      side,
      depth: mm(options.depthMm),
      toward: options.toward,
      radius: mm(options.radiusMm),
    });
  }
  /**
   * Sews sheet bodies into `target`'s: joined where their edges lie within `toleranceMm`, a solid
   * when `solid` and they close (R2a-3). The other bodies are consumed.
   */
  async sewBodies(target: string, toolIds: string[], solid: boolean, toleranceMm = 0.0001) {
    const sewFeatureId = this.id('sew');
    const applied = await this.run({
      type: 'sewBodies',
      targetId: target,
      toolIds,
      toleranceMm,
      solid,
      sewFeatureId,
      placementFeatureId: this.id('placement'),
    });
    if (applied) this.select({ kind: 'feature', id: sewFeatureId });
    return applied;
  }
  /**
   * CR2b: a new sheet body, sheet `body` moved `distanceMm` along its normal (`front`) or against
   * it (`back`). The source body stays.
   */
  async offsetSurface(body: CadBody, distanceMm: number, side: 'front' | 'back') {
    const id = this.id('offset');
    const applied = await this.run({
      type: 'insertFeatures',
      features: [
        {
          id,
          name: `${body.name} offset`,
          type: 'offsetSurface',
          inputFeatureIds: [],
          args: { source: { featureId: body.resultFeatureId }, distance: mm(distanceMm), side },
        },
      ],
      bodies: [this.newBody(id, `${body.name} offset`)],
    });
    if (applied) this.select({ kind: 'feature', id });
    return applied;
  }
  /**
   * CR4b: a new body, `body` reflected in the plane through the origin normal to `axis` (a left
   * part's right copy across y = 0). The body stays; the copy follows it.
   */
  async mirrorCopy(body: CadBody, axis: 'x' | 'y' | 'z') {
    const id = this.id('mirror');
    // Within the name limit, however long the body's name.
    const name = `${Array.from(body.name)
      .slice(0, cadLimits.nameCodePoints - ' mirrored'.length)
      .join('')} mirrored`;
    const normal: [number, number, number] = [
      axis === 'x' ? 1 : 0,
      axis === 'y' ? 1 : 0,
      axis === 'z' ? 1 : 0,
    ];
    const applied = await this.run({
      type: 'insertFeatures',
      features: [
        {
          id,
          name,
          type: 'mirrorCopy',
          inputFeatureIds: [],
          args: {
            source: { featureId: body.resultFeatureId },
            plane: { origin: position(0, 0, 0), normal },
          },
        },
      ],
      bodies: [this.newBody(id, name)],
    });
    if (applied) this.select({ kind: 'feature', id });
    return applied;
  }
  /** A solid of sheet `body` `thicknessMm` thick towards its normal, away, or both (R2a-3). */
  thickenBody(body: CadBody, thicknessMm: number, side: 'front' | 'back' | 'both') {
    return this.detail(body, 'thicken', 'Thicken', { thickness: mm(thicknessMm), side });
  }
  /**
   * A sheet from the chain (open, or one loop) that `sketchId` draws: carried `distance` mm along
   * the sketch normal, or turned `angleRad` about the sketch's v axis (R2a-1).
   */
  async addSurface(
    sketchId: string,
    shape: { type: 'extrude'; distance: number } | { type: 'revolve'; angleRad: number },
  ) {
    const sketch = this.coordinator.content.sketches.find((s) => s.id === sketchId);
    const elements = sketch && sketchDefaultPath(sketch, 'allow');
    if (!elements) return this.refuse('surface-path') ?? false;
    const id = this.id('surface');
    const path = { sketchId, elements };
    const applied = await this.run({
      type: 'insertFeatures',
      features: [
        shape.type === 'extrude'
          ? {
              id,
              name: 'Extruded surface',
              type: 'extrudeSurface',
              inputFeatureIds: [],
              args: { path, distance: mm(shape.distance), direction: 1 },
            }
          : {
              id,
              name: 'Revolved surface',
              type: 'revolveSurface',
              inputFeatureIds: [],
              args: {
                path,
                axisOrigin: [mm(0), mm(0)],
                axisDirection: [0, 1],
                angle: { literalRad: shape.angleRad },
              },
            },
      ],
      bodies: [this.newBody(id, 'Surface')],
    });
    if (applied) this.select({ kind: 'feature', id });
    return applied;
  }
  /**
   * Copies an active body with its whole upstream closure (features, profiles, parameters and
   * consumed tools) under new IDs, in one edit, and selects the copy. It keeps the placement.
   */
  async duplicateBody(bodyId: string) {
    const doc = this.coordinator.content;
    let ids: string[];
    try {
      ({ ids } = duplicateClosureOf(doc, [bodyId]));
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      this.emit();
      return false;
    }
    const idMap = Object.fromEntries(ids.map((id) => [id, this.id('copy')]));
    const applied = await this.run({ type: 'duplicateClosure', bodyIds: [bodyId], idMap });
    if (applied) this.select({ kind: 'body', id: idMap[bodyId]! });
    return applied;
  }
  /** Saves the current camera and shown bodies as a named view (one edit). Returns its ID. */
  async saveView(
    view: { camera: CadCamera; projection: CadProjection },
    bodyIds: string[],
  ): Promise<string | undefined> {
    const id = this.id('view');
    const n = this.coordinator.content.namedViews.length;
    const applied = await this.run({
      type: 'saveNamedView',
      view: { id, name: `View ${n + 1}`, bodyIds, ...view },
    });
    return applied ? id : undefined;
  }
  /**
   * The picked face or edge as a reference on its body's current result, with the pick table
   * it was read from. Fails (status line) when it cannot be referenced.
   */
  private picked(kind: 'face' | 'edge') {
    const s = this.selection;
    const content = this.coordinator.content;
    // A pick id is valid only on the meshes of exactly the current content.
    const mesh =
      s?.kind === kind && s.contentHash === cadContentHash(content)
        ? this.meshStore.get(s.contentHash)?.find((m) => m.bodyId === s.id)
        : undefined;
    const body = content.bodies.find((b) => b.id === mesh?.bodyId && b.state === 'active');
    if (!s || s.kind !== kind || !mesh || !body) return this.refuse('selection-stale');
    const index = s.pick - 1 - (kind === 'face' ? mesh.faceBase : mesh.edgeBase);
    try {
      return {
        body,
        mesh,
        index,
        pick: s.pick,
        ref: topologyRefOf(mesh.topology, kind, index, body.resultFeatureId),
      };
    } catch (error) {
      return this.refuse(error instanceof Error ? error.message : String(error));
    }
  }
  private refuse(code: string, elementId?: string): undefined {
    this.fail(code, elementId);
    this.emit();
    return undefined;
  }
  /** Adds detail feature `args` of `type` on `body`'s result and selects it (one edit). */
  private async detail<T extends CadDetailType>(
    body: CadBody,
    type: T,
    name: string,
    args: Extract<CadFeature, { type: T }>['args'],
  ) {
    const id = this.id(type);
    const applied = await this.run({
      type: 'detailBody',
      bodyId: body.id,
      placementFeatureId: this.id('placement'),
      feature: {
        id,
        name,
        type,
        inputFeatureIds: [body.resultFeatureId],
        args,
      } as Extract<CadFeature, { type: CadDetailType }>,
    });
    if (applied) this.select({ kind: 'feature', id });
    return applied;
  }
  /**
   * A fillet or chamfer of the picked edge (r1-modeling.md, Surface). A fillet's radius may vary
   * (CR1e): from `sizeMm` at the edge's start to `endMm` at its end, through `points` between.
   */
  blendPickedEdge(
    type: 'fillet' | 'chamfer',
    sizeMm: number,
    vary?: { endMm: number; points?: { at: number; radiusMm: number }[] },
  ) {
    const p = this.picked('edge');
    if (!p) return Promise.resolve(false);
    if (type === 'chamfer')
      return this.detail(p.body, 'chamfer', 'Chamfer', { edges: [p.ref], distance: mm(sizeMm) });
    return this.detail(p.body, 'fillet', 'Fillet', {
      edges: [p.ref],
      radius: mm(sizeMm),
      ...(vary && { radiusEnd: mm(vary.endMm) }),
      ...(vary?.points?.length && {
        radii: vary.points.map((x) => ({ at: x.at, radius: mm(x.radiusMm) })),
      }),
    });
  }
  /**
   * CR2d: flares the picked free edge of a sheet (a wheel arch) out by `heightMm` along the
   * chain sketch `sketchId` draws, the fill joining the sheet G1 or G2 there.
   */
  flarePickedEdge(sketchId: string, heightMm: number, continuity: 'G1' | 'G2') {
    const p = this.picked('edge');
    if (!p) return Promise.resolve(false);
    const sketch = this.coordinator.content.sketches.find((s) => s.id === sketchId);
    const elements = sketch && sketchDefaultPath(sketch, 'allow');
    if (!elements) return Promise.resolve(this.refuse('surface-path') ?? false);
    return this.detail(p.body, 'flare', 'Flare', {
      tool: { sketchId, elements },
      arch: p.ref,
      height: mm(heightMm),
      continuity,
    });
  }
  /**
   * CR4c: a flange `widthMm` wide at `angleDeg` from the sheet, turned to its `toward` side, along
   * the picked free edge, or along every collected free edge of its body when the picked edge is
   * one of them.
   */
  async flangePickedEdge(widthMm: number, angleDeg: number, toward: 'front' | 'back') {
    const p = this.picked('edge');
    if (!p) return false;
    const key = (r: CadTopologyRef) => JSON.stringify([r.featureId, r.name, r.select]);
    const collected = this.collected
      .filter((c) => c.free && c.ref.featureId === p.ref.featureId)
      .map((c) => c.ref);
    const all = collected.some((r) => key(r) === key(p.ref));
    const applied = await this.detail(p.body, 'flange', 'Flange', {
      edges: all ? collected : [p.ref],
      width: mm(widthMm),
      angle: { literalRad: (angleDeg * Math.PI) / 180 },
      toward,
    });
    // The collected edges are used up, as by a fill.
    if (applied && all) this.clearCollectedEdges();
    return applied;
  }
  /**
   * CR4e: takes the picked face (a flange) as the first flange of a new spot weld row; the row
   * is made on another body's face with `weldToPickedFace`.
   */
  chooseWeldFlange(): boolean {
    const p = this.picked('face');
    if (!p) return false;
    this.weldStart = {
      bodyId: p.body.id,
      pick: p.pick,
      contentHash: cadContentHash(this.coordinator.content),
      face: p.ref,
    };
    this.emit();
    return true;
  }
  /** CR4e: forgets the chosen first flange. */
  clearWeldFlange() {
    this.weldStart = undefined;
    this.emit();
  }
  /**
   * CR4e: a spot weld row from the chosen first flange to the picked face of another body,
   * `pitchMm` apart and at least `endDistanceMm` from the first flange's ends.
   */
  async weldToPickedFace(
    pitchMm: number = cadSpotWeldLimits.defaultPitchMm,
    endDistanceMm: number = cadSpotWeldLimits.defaultEndDistanceMm,
    maxGapMm: number = cadSpotWeldLimits.defaultMaxGapMm,
  ): Promise<string | undefined> {
    const start = this.weldStart;
    const content = this.coordinator.content;
    if (!start || start.contentHash !== cadContentHash(content))
      return this.refuse('spot-weld-no-start');
    const p = this.picked('face');
    if (!p) return undefined;
    if (p.body.id === start.bodyId) return this.refuse('spot-weld-same-body');
    const id = this.id('welds');
    const n = (content.spotWelds?.length ?? 0) + 1;
    const applied = await this.run({
      type: 'setSpotWeld',
      weld: {
        id,
        name: `Spot welds ${n}`,
        flanges: [
          { bodyId: start.bodyId, face: start.face },
          { bodyId: p.body.id, face: p.ref },
        ],
        pitchMm,
        endDistanceMm,
        maxGapMm,
      },
    });
    if (!applied) return undefined;
    this.weldStart = undefined;
    this.emit();
    return id;
  }
  /** CR4e: changes a spot weld row's pitch, end distance or largest gap. */
  updateSpotWeld(
    id: string,
    change: Partial<Pick<CadSpotWeld, 'pitchMm' | 'endDistanceMm' | 'maxGapMm'>>,
  ) {
    const weld = this.coordinator.content.spotWelds?.find((w) => w.id === id);
    if (!weld) return Promise.resolve(this.refuse('target-missing', id) ?? false);
    return this.run({ type: 'setSpotWeld', weld: { ...weld, ...change } });
  }
  /** CR4e: removes a spot weld row. */
  /** CLF3: sets the car's proportion setup (roles, ground, bands), or removes it with null. */
  setProportions(proportions: CadProportions | null) {
    return this.run({ type: 'setProportions', proportions });
  }
  removeSpotWeld(id: string) {
    return this.run({ type: 'removeSpotWeld', id });
  }
  /** Hollows the picked face's body to `thicknessMm`, leaving that face open. */
  shellPickedFace(thicknessMm: number, side: 'inside' | 'outside' = 'inside') {
    const p = this.picked('face');
    if (!p) return Promise.resolve(false);
    return this.detail(p.body, 'shell', 'Shell', {
      openFaces: [p.ref],
      thickness: mm(thicknessMm),
      side,
    });
  }
  /**
   * Drafts the faces around the picked planar face by `angleDeg`, that face neutral and the pull
   * into the body (normal to it).
   */
  draftFromPickedFace(angleDeg: number) {
    const p = this.picked('face');
    if (!p) return Promise.resolve(false);
    const normal = planeNormal(p.mesh, p.pick);
    if (!normal) return Promise.resolve(this.refuse('draft-neutral-not-planar') ?? false);
    const table = p.mesh.topology;
    const around = new Set<number>();
    for (const e of table.edges)
      if (e.faces.includes(p.index)) for (const f of e.faces) if (f !== p.index) around.add(f);
    let faces: CadTopologyRef[];
    try {
      faces = [...around].map((f) => topologyRefOf(table, 'face', f, p.body.resultFeatureId));
    } catch (error) {
      return Promise.resolve(
        this.refuse(error instanceof Error ? error.message : String(error)) ?? false,
      );
    }
    if (!faces.length) return Promise.resolve(this.refuse('draft-faces') ?? false);
    return this.detail(p.body, 'draft', 'Draft', {
      faces,
      neutral: p.ref,
      angle: { literalRad: (angleDeg * Math.PI) / 180 },
      direction: normal.map((c) => -c || 0) as Vec3,
    });
  }
  /** Mirrors the picked face's body in that (planar) face, joined to the body or alone. */
  mirrorInPickedFace(union = true) {
    const p = this.picked('face');
    if (!p) return Promise.resolve(false);
    return this.detail(p.body, 'mirror', 'Mirror', { plane: { face: p.ref }, union });
  }
  /** `layout` copies of `toolId` Booleaned into `targetId` at once (one edit). */
  /**
   * `layout` may name a sketch for K5a: the copies follow the open chain its drawing makes (as a
   * sweep's path), refused with `sweep-path` when it makes none.
   */
  async pattern(
    targetId: string,
    toolId: string,
    mode: 'union' | 'cut',
    along: CadPatternLayout | { type: 'curve'; sketchId: string; count: Count; align: boolean },
  ) {
    let layout: CadPatternLayout | CadCurveLayout;
    if (along.type === 'curve') {
      const sketch = this.coordinator.content.sketches.find((s) => s.id === along.sketchId);
      const elements = sketch && sketchDefaultPath(sketch);
      if (!elements) return this.refuse('sweep-path') ?? false;
      const { sketchId, ...rest } = along;
      layout = { ...rest, path: { sketchId, elements } };
    } else layout = along;
    const patternFeatureId = this.id('pattern');
    const applied = await this.run({
      type: 'patternBodies',
      targetId,
      toolId,
      mode,
      layout,
      patternFeatureId,
      placementFeatureId: this.id('placement'),
    });
    if (applied) this.select({ kind: 'feature', id: patternFeatureId });
    return applied;
  }
  combine(targetId: string, toolId: string, mode: 'union' | 'cut' | 'common') {
    return this.run({
      type: 'booleanBodies',
      targetId,
      toolId,
      mode,
      booleanFeatureId: this.id('boolean'),
      placementFeatureId: this.id('placement'),
    });
  }
  moveBody(body: CadBody, translation: [number, number, number]) {
    const placement = this.coordinator.content.features.find((f) => f.id === body.resultFeatureId);
    const rotation =
      placement?.type === 'transform' ? placement.args.rotation : identityQuaternion();
    return this.run({
      type: 'transformBody',
      bodyId: body.id,
      translation: position(...translation),
      rotation,
    });
  }
  isMovable(body: CadBody) {
    const placement = this.coordinator.content.features.find((f) => f.id === body.resultFeatureId);
    return (
      body.state === 'active' &&
      placement?.type === 'transform' &&
      isLiteralPosition(placement.args.translation)
    );
  }
}
