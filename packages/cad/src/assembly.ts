/**
 * R2b-1 assembly in the Surface (docs/cad/r2b-assembly.md): the Host's part-source capability
 * and closure store, the part meshes shared by every instance, and the edits that place parts.
 * React-free; the Surface reads it beside the controller.
 */
import {
  assemblyStepPlan,
  assertCad,
  bomCsv,
  bomRows,
  cadAssemblyLimits,
  cadAssetMediaTypes,
  cadContentHash,
  cadLimits,
  expandAssembly,
  identityQuaternion,
  occurrenceAccess,
  mm,
  componentCopies,
  parameterValues,
  stepPose,
  parseCopyStep,
  posesDiffer,
  position,
  rotateVector,
  solvePlacement,
  stepComponent,
  stepImportPlan,
  type CadAssemblyPort,
  type CadAssetRef,
  type CadBodyEvaluation,
  type CadBomMode,
  type CadComponent,
  type CadComponentPlacement,
  type CadComponentPattern,
  type CadDocument,
  type CadEvaluateRequest,
  type CadEvaluation,
  type CadJointType,
  type CadJointValueKey,
  type CadOperation,
  type CadPartDef,
  type CadPatternLayout,
  type CadVersionEvaluation,
  type CadPartProgress,
  type CadPartState,
  type CadSolvedPose,
  type CadStepPlan,
  type Position3,
  type Quaternion,
  type Vec3,
} from '@editor-platform/cad-core';
import {
  assemblyStepReport,
  CadExportError,
  type CadBrepExport,
  type CadMesh,
  type CadStepAssemblyImportReport,
  type CadStepAssemblyImportResult,
  type CadStepAssemblyResult,
} from '@editor-platform/cad-kernel-occt';
import { describeAssemblyCode } from './assembly-messages';
import {
  cadBudgets,
  describeCode,
  retainedBytes,
  type CadController,
  type CadMeshExport,
} from './controller';
import {
  connectorFromPick,
  dragMotion,
  jointMoveFrames,
  jointMoves,
  newJoint,
  originChoice,
  type CadConnectorChoice,
} from './joint-authoring';
import {
  moveJointDrag,
  releasedJointValues,
  startJointDrag,
  type CadJointDrag,
} from './joint-drag';
import { editedJointValues, jointFields } from './joint-values';
import type { CadConnectorPick, CadJointDragTool } from './viewport';
import {
  editedPlacement,
  mirroredPlacement,
  placementFields,
  type CadMirrorPlane,
} from './placement';

const suffix = ' pattern';
/** A new pattern's name: its seed's, shortened so the suffix fits the name limit. */
export const patternName = (seed: string) =>
  [...seed].slice(0, cadLimits.nameCodePoints - suffix.length).join('') + suffix;

export { describeAssemblyCode };

/** One saved version a Host offers for insertion. Drafts are never offered. */
export interface CadPartVersionInfo {
  versionId: string;
  label: string;
  contentHash: string;
}
export interface CadPartCandidate {
  artifactId: string;
  name: string;
  versions: CadPartVersionInfo[];
}
/** A saved version as the Host confirmed it, with the closure it needs itself. */
export interface CadPartVersionRead {
  content: CadDocument;
  contentHash: string;
  /** Versions the content places (nested sub-assemblies), each once. */
  closure: CadDocument[];
  /** Asset bytes the content and its closure name. */
  assets: { ref: CadAssetRef; bytes: Uint8Array }[];
}
/**
 * Host capability for parts (docs/cad/r2b-assembly.md, 部品の参照先とHost capability), shaped
 * like ReferenceHost: the Host lists and reads confirmed versions and decides access.
 */
export interface CadPartSourceHost {
  list(): Promise<CadPartCandidate[]>;
  readVersion(
    artifactId: string,
    versionId: string,
    signal?: AbortSignal,
  ): Promise<CadPartVersionRead>;
  /** A saved version's short name for people (such as `v2`), shown instead of its ID. */
  versionLabel?(artifactId: string, versionId: string): string | undefined;
  /** Only for showing that a newer version exists; never taken in by itself. */
  latestVersion?(
    artifactId: string,
  ): { versionId: string; contentHash: string; label?: string } | undefined;
  subscribe?(notify: () => void): () => void;
  /** Current read access; checked before a retained version is shown. */
  checkAccess(artifactId: string): boolean;
  /** Opens the part's Artifact, where it is edited and a new version saved. */
  open?(artifactId: string, versionId: string): void;
}
/**
 * The Host's retained closure (R2b-U3): versions by content hash, kept in the saved record and
 * its native file. `stage` stores versions and their asset bytes before an edit names them.
 */
export interface CadPartStore {
  get(contentHash: string): CadDocument | undefined;
  stage(versions: CadDocument[], assets: { ref: CadAssetRef; bytes: Uint8Array }[]): Promise<void>;
}

/** A component's display state, the worst over its part and the parts nested in it. */
export type CadComponentState = CadPartState | 'pending';
const rank: Record<CadComponentState, number> = {
  available: 0,
  pending: 1,
  substitute: 2,
  failed: 3,
  unavailable: 4,
};
/**
 * R2b-4: an evaluation's versions, with those it left pending that the port has evaluated
 * since (`later`).
 */
export function evaluatedVersions(
  evaluation: CadEvaluation | undefined,
  later?: (hash: string) => CadVersionEvaluation | undefined,
) {
  const assembly = evaluation?.status === 'ok' ? evaluation.assembly : undefined;
  if (!assembly?.pending?.length || !later) return assembly?.versions;
  const versions = { ...assembly.versions };
  for (const hash of assembly.pending) {
    const v = later(hash);
    if (v) versions[hash] = v;
  }
  return versions;
}
/** Each direct component's state on `evaluation` (pending while it is not evaluated). */
export function componentStates(
  content: CadDocument,
  evaluation: CadEvaluation | undefined,
  lookup: (hash: string) => CadDocument | undefined,
  /** Current read access: a revoked part is unavailable even with a cached result. */
  access: (artifactId: string) => boolean = () => true,
  /** R2b-4: pending versions evaluated since (`evaluatedVersions`). */
  later?: (hash: string) => CadVersionEvaluation | undefined,
) {
  const versions = evaluatedVersions(evaluation, later);
  const states = new Map<string, { state: CadComponentState; code?: string }>();
  const { occurrences } = expandAssembly(content, lookup);
  const allowed = occurrenceAccess(occurrences, access);
  for (const [i, o] of occurrences.entries()) {
    const v = versions?.[o.part.source.contentHash];
    const next = !allowed[i]
      ? { state: 'unavailable' as const, code: 'part-access-revoked' }
      : v
        ? { state: v.state as CadComponentState, code: v.code }
        : { state: 'pending' as const };
    const id = o.path[0]!;
    const was = states.get(id);
    if (!was || rank[next.state] > rank[was.state]) states.set(id, next);
  }
  return states;
}

/** The 8 corners of a box moved by a pose, as world bounds. */
function poseBounds([lo, hi]: [Vec3, Vec3], pose: CadSolvedPose): [Vec3, Vec3] {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const corner: Vec3 = [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]];
    const r = rotateVector(pose.rotation, corner);
    for (let k = 0; k < 3; k++) {
      const v = r[k]! + pose.translationMm[k]!;
      min[k] = Math.min(min[k]!, v);
      max[k] = Math.max(max[k]!, v);
    }
  }
  return [min, max];
}
const union = (a: [Vec3, Vec3] | undefined, b: [Vec3, Vec3]): [Vec3, Vec3] =>
  a
    ? [
        a[0].map((v, k) => Math.min(v, b[0][k]!)) as Vec3,
        a[1].map((v, k) => Math.max(v, b[1][k]!)) as Vec3,
      ]
    : b;

const unionAll = (bodies: Record<string, CadBodyEvaluation> | undefined) => {
  let bounds: [Vec3, Vec3] | undefined;
  for (const b of Object.values(bodies ?? {})) bounds = union(bounds, b.bounds);
  return bounds;
};

export interface CadAssemblySnapshot {
  /** Increments when part meshes arrive or are released. */
  meshes: number;
  /** An insert is reading, evaluating and storing a version. */
  inserting: boolean;
  /**
   * Versions whose standard meshes the main-thread budget could not keep: drawn with their
   * coarse meshes when kept (R2b-4, LOD), else as boxes (「簡略表示」).
   */
  simplified: ReadonlySet<string>;
  /** Inserting parts is offered: edit authority, a part source and a closure store. */
  canInsert: boolean;
  /** The selected direct component (Surface state, never content). */
  selected: string | undefined;
  /** Placement fields typed and not applied, by component (Surface state, never content). */
  drafts: ReadonlyMap<string, CadPlacementDraft>;
  /** The selected joint (R2b-2), never at once with a component. */
  selectedJoint: string | undefined;
  /** The selected component pattern (R2b-3), never at once with a component or joint. */
  selectedPattern: string | undefined;
  /** Joint value fields typed and not applied, by joint (Surface state, never content). */
  jointDrafts: ReadonlyMap<string, CadPlacementDraft>;
  /** A part version update being previewed (R2b-2b, Surface state, never content). */
  update: CadPartUpdateView | undefined;
  /** A joint being made (R2b-2c, Surface state, never content). */
  creating: CadJointCreation | undefined;
  /** A joint's values while its drag is under way (R2b-2c), shown in its Inspector. */
  dragging: { jointId: string; values: Partial<Record<CadJointValueKey, number>> } | undefined;
  /**
   * R2b-4: the current content's versions still evaluating after its result (「部品 n / N を計算
   * 中」); measurement waits for them.
   */
  progress: CadPartProgress | undefined;
  /** R2b-5: a STEP assembly read and not yet placed (Surface state, never content). */
  stepImport: CadStepAssemblyImportPreview | undefined;
}
/** R2b-5: what a read STEP assembly becomes, before anything is stored. */
export interface CadStepAssemblyImportPreview {
  fileName: string;
  report: CadStepAssemblyImportReport;
  /** Imported parts (distinct shapes) and components (flattened instances). */
  parts: number;
  components: number;
  skipped: string[];
}
/**
 * R2b-2c: a joint being made. Pick the parent's connector, then the child's (a face, edge or
 * vertex, or an origin), choose the type; each choice is previewed as the candidate edit, and
 * Apply adopts it as one edit.
 */
export interface CadJointCreation {
  step: 'parent' | 'child' | 'type';
  parent?: CadConnectorChoice;
  child?: CadConnectorChoice;
  type: CadJointType;
  flip: boolean;
  status: 'idle' | 'preparing' | 'ready' | 'broken' | 'refused';
  /** The candidate with the joint, and its evaluation, while a preview is shown. */
  preview?: { content: CadDocument; evaluation: CadEvaluation };
  /** Why the preview broke or was refused. */
  message?: string;
  jointId: string;
}
/** Size and volume of one version's bodies, for an update's preview. */
export interface CadVersionSummary {
  sizeMm: Vec3;
  /** Undefined when a body is a sheet. */
  volumeMm3?: number;
}
/** R2b-2b: what a part version update changes, before it is adopted as one edit. */
export interface CadPartUpdateView {
  parts: {
    partId: string;
    name: string;
    from: string;
    to: string;
    fromSummary?: CadVersionSummary;
    toSummary?: CadVersionSummary;
  }[];
  status: 'preparing' | 'ready' | 'broken';
  /** Direct components the update moves (joint children following the new version). */
  moved: string[];
  /** Joints whose connectors no longer resolve on the new versions, the first one's code. */
  broken: { jointId: string; name: string }[];
  code?: string;
  /** The first broken joint's connectors can be chosen again with the update, as one edit. */
  canChoose: boolean;
}
/** A placement entry not yet applied: the fields, and the fields as shown when it began. */
export interface CadPlacementDraft {
  fields: string[];
  shown: string[];
}
export interface CadAssemblyOptions {
  controller: CadController;
  port: CadAssemblyPort;
  source?: CadPartSourceHost;
  store?: CadPartStore;
  /** Main-thread bytes for part meshes beside the editor's own (CAD26 budget). */
  mainBytes?: number;
  /** R2b-5: a version's active bodies as one BRep, from its exact build (CatalogKernelPort). */
  exportBrep?(request: CadEvaluateRequest): Promise<{
    evaluation: CadEvaluation;
    brep?: CadBrepExport;
  }>;
  /** R2b-5: reads a STEP assembly with the document's exact build (CatalogKernelPort). */
  importStepAssembly?(
    profile: CadDocument['kernelProfile'],
    requestId: string,
    bytes: Uint8Array,
  ): Promise<CadStepAssemblyImportResult>;
  /** R2b-5: the assembly's STEP AP242 from its plan and the products' BReps. */
  exportAssemblyStep?(
    profile: CadDocument['kernelProfile'],
    requestId: string,
    plan: CadStepPlan,
    breps: ReadonlyMap<string, Uint8Array>,
  ): Promise<CadStepAssemblyResult>;
}

/**
 * Part meshes by version content hash, shared by every instance, and the assembly edits. Only
 * versions the current content reaches keep their meshes; one shown again is evaluated again.
 */
export class CadAssembly {
  private readonly meshStore = new Map<string, CadMesh[]>();
  /** R2b-4 (LOD): each version's coarse display meshes, kept beside (or without) the standard. */
  private readonly coarseStore = new Map<string, CadMesh[]>();
  private readonly simplified = new Set<string>();
  /** Content and part pairs already evaluated again for released meshes. */
  private readonly retried = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private inserting = false;
  private stepImport:
    | {
        fileName: string;
        bytes: Uint8Array;
        buildHash: string;
        result: Extract<CadStepAssemblyImportResult, { status: 'ok' }>;
      }
    | undefined;
  private selected: string | undefined;
  private readonly drafts = new Map<string, CadPlacementDraft>();
  private selectedJoint: string | undefined;
  private selectedPattern: string | undefined;
  private readonly jointDrafts = new Map<string, CadPlacementDraft>();
  private update: CadPartUpdateView | undefined;
  /** Bumped per update preparation and on cancel: a late step of an older one stops. */
  private updateRun = 0;
  private creating: CadJointCreation | undefined;
  /** Bumped per joint preview and on cancel, like `updateRun`. */
  private jointRun = 0;
  private dragging: CadAssemblySnapshot['dragging'];
  /** Contents evaluated again since the last access change for a part reported revoked. */
  private readonly rechecked = new Set<string>();
  private snapshot: CadAssemblySnapshot;
  private readonly unsubscribe: () => void;
  private readonly unsubscribePort: () => void;
  private readonly unsubscribeSource: (() => void) | undefined;
  /** R2b-4: how large a world box shows on screen (px), from the viewport; 0 out of view. */
  private screenSize: ((bounds: [Vec3, Vec3]) => number) | undefined;
  /** The assembly build the part meshes were evaluated with (R2b-U6). */
  private meshBuild: string;
  constructor(private readonly options: CadAssemblyOptions) {
    this.meshBuild = options.controller.getSnapshot().content.kernelProfile.buildHash;
    this.snapshot = this.build(0);
    this.unsubscribe = options.controller.subscribe(() => this.settle());
    // A pending version evaluated (or failed) changes what is drawn and listed.
    this.unsubscribePort = options.port.subscribe(() => this.emit(true));
    options.port.order = (hashes) => this.order(hashes);
    this.unsubscribeSource = options.source?.subscribe?.(() => this.accessChanged());
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;
  private build(meshes: number): CadAssemblySnapshot {
    const { controller, source, store } = this.options;
    const s = controller.getSnapshot();
    return {
      meshes,
      inserting: this.inserting,
      simplified: new Set(this.simplified),
      canInsert: !!source && !!store && !s.readOnly && !s.busy && !this.inserting,
      selected: s.content.components.some((c) => c.id === this.selected)
        ? this.selected
        : undefined,
      drafts: new Map(this.drafts),
      selectedJoint: s.content.joints.some((j) => j.id === this.selectedJoint)
        ? this.selectedJoint
        : undefined,
      jointDrafts: new Map(this.jointDrafts),
      selectedPattern: s.content.componentPatterns.some((p) => p.id === this.selectedPattern)
        ? this.selectedPattern
        : undefined,
      update: this.update,
      creating: this.creating,
      dragging: this.dragging,
      progress: this.partsLeft(),
      stepImport: this.stepImport && {
        fileName: this.stepImport.fileName,
        report: this.stepImport.result.report,
        parts: this.stepImport.result.read.shapes.length,
        components: this.stepImport.result.read.instances.length,
        skipped: this.stepImport.result.read.skipped,
      },
    };
  }
  /**
   * The current content's versions evaluated so far, while some it left pending are not: the
   * port evaluates them after the result (R2b-4).
   */
  private partsLeft(): CadPartProgress | undefined {
    const s = this.options.controller.getSnapshot();
    const assembly =
      s.evaluation?.status === 'ok' && s.evaluation.contentHash === s.contentHash
        ? s.evaluation.assembly
        : undefined;
    const pending = assembly?.pending ?? [];
    const left = pending.filter((h) => !this.options.port.version(h)).length;
    if (!left) return undefined;
    const total = Object.keys(assembly!.versions).length + pending.length;
    return { contentHash: s.contentHash, done: total - left, total };
  }
  /** An evaluation's versions with its pending ones the port has evaluated since. */
  versions(evaluation: CadEvaluation | undefined) {
    return evaluatedVersions(evaluation, this.later);
  }
  later = (hash: string) => this.options.port.version(hash);
  /** R2b-4: the viewport's measure of a world box on screen, for the order parts evaluate in. */
  setScreenSize(size: ((bounds: [Vec3, Vec3]) => number) | undefined) {
    this.screenSize = size;
  }
  /**
   * The order pending versions evaluate in: the largest on screen first (over every instance,
   * from its hint bounds at its pose), those out of view last.
   */
  private order(hashes: string[]) {
    const largest = this.onScreen(hashes);
    if (!largest) return hashes;
    return [...hashes].sort((a, b) => (largest.get(b) ?? 0) - (largest.get(a) ?? 0));
  }
  /** Each version's largest instance on screen (px), or undefined without a viewport. */
  private onScreen(hashes: Iterable<string>) {
    const size = this.screenSize;
    if (!size) return undefined;
    const wanted = new Set(hashes);
    const largest = new Map<string, number>();
    const { content } = this.options.controller.getSnapshot();
    for (const o of expandAssembly(content, this.lookup).occurrences) {
      const hash = o.part.source.contentHash;
      if (!wanted.has(hash)) continue;
      const px = size(poseBounds(o.part.hint.boundsMm, o.pose));
      largest.set(hash, Math.max(largest.get(hash) ?? 0, px));
    }
    return largest;
  }
  private emit(meshesChanged = false) {
    this.snapshot = this.build(this.snapshot.meshes + (meshesChanged ? 1 : 0));
    for (const l of this.listeners) l();
  }
  /**
   * Selects a direct component (or none); a body selection is cleared with it. A pattern copy's
   * step (a picked copy) selects its pattern.
   */
  select(componentId: string | undefined) {
    const copy = componentId === undefined ? undefined : parseCopyStep(componentId);
    if (copy) return this.selectPattern(copy.patternId);
    this.selected = componentId;
    this.selectedJoint = this.selectedPattern = undefined;
    if (componentId) this.options.controller.select(null);
    else this.emit();
  }
  /** Selects a joint (or none); a component or body selection is cleared with it. */
  selectJoint(jointId: string | undefined) {
    this.selectedJoint = jointId;
    this.selected = this.selectedPattern = undefined;
    if (jointId) this.options.controller.select(null);
    else this.emit();
  }
  /** Selects a component pattern (or none), like a component. */
  selectPattern(patternId: string | undefined) {
    this.selectedPattern = patternId;
    this.selected = this.selectedJoint = undefined;
    if (patternId) this.options.controller.select(null);
    else this.emit();
  }
  private readonly checked = new Map<string, { doc: CadDocument; ok: boolean }>();
  /**
   * A retained version by content hash, for display and expansion. Content that does not hash
   * to the name reads as missing: it never places anything (the port reports the mismatch).
   */
  lookup = (hash: string) => {
    const doc = this.options.store?.get(hash);
    if (!doc) return undefined;
    let check = this.checked.get(hash);
    if (check?.doc !== doc) {
      check = { doc, ok: cadContentHash(doc) === hash };
      this.checked.set(hash, check);
    }
    return check.ok ? doc : undefined;
  };
  /** Current read access to a part's Artifact, checked again wherever a part is shown. */
  access = (artifactId: string) => this.options.source?.checkAccess(artifactId) ?? true;
  meshes(hash: string) {
    return this.meshStore.get(hash);
  }
  /** R2b-4 (LOD): a version's coarse display meshes, if its job made and the budget kept them. */
  coarseMeshes(hash: string) {
    return this.coarseStore.get(hash);
  }
  get source() {
    return this.options.source;
  }
  /**
   * Port callback: meshes of one part job (ownership of the buffers moves here), kept within
   * the main-thread budget (`fit`). Coarse display meshes (R2b-4, LOD) are kept apart.
   */
  receive(contentHash: string, meshes: CadMesh[]) {
    this.meshStore.delete(contentHash);
    this.coarseStore.delete(contentHash);
    // Recovered: a later eviction of the same part may be recovered again.
    for (const key of this.retried) if (key.endsWith(` ${contentHash}`)) this.retried.delete(key);
    this.fit({
      hash: contentHash,
      standard: meshes.filter((m) => m.lod !== 'coarse'),
      coarse: meshes.filter((m) => m.lod === 'coarse'),
    });
    this.emit(true);
  }
  /**
   * Keeps part meshes within what the main-thread budget leaves beside the editor's own meshes
   * (docs/cad/r2b-assembly.md, 予算): versions the current content does not reach go first,
   * least recently received first. An incoming version that still does not fit keeps its coarse
   * meshes only, or none; when the editor's share grew, the reached versions smallest on screen
   * lose their standard meshes first, then their coarse ones. Such a version is simplified
   * (drawn coarse, or as a box). Returns whether anything was released.
   */
  private fit(incoming?: { hash: string; standard: CadMesh[]; coarse: CadMesh[] }) {
    const budget =
      (this.options.mainBytes ?? cadBudgets.mainBytes) - this.options.controller.retainedMeshBytes;
    let extra = incoming ? retainedBytes([...incoming.standard, ...incoming.coarse]) : 0;
    const held = () =>
      retainedBytes([...this.meshStore.values(), ...this.coarseStore.values()].flat());
    const over = () => held() + extra > budget;
    const reached = expandAssembly(
      this.options.controller.getSnapshot().content,
      this.lookup,
    ).versions;
    let released = false;
    for (const hash of new Set([...this.meshStore.keys(), ...this.coarseStore.keys()])) {
      if (!over()) break;
      if (reached.has(hash)) continue;
      this.meshStore.delete(hash);
      this.coarseStore.delete(hash);
      this.options.port.forget(hash);
      released = true;
    }
    if (incoming) {
      const { hash, standard, coarse } = incoming;
      // A version without bodies of its own (a sub-assembly) holds nothing: it is never reduced.
      if (!over() || !standard.length) {
        this.simplified.delete(hash);
        this.meshStore.set(hash, standard);
        if (coarse.length) this.coarseStore.set(hash, coarse);
        return released;
      }
      this.simplified.add(hash);
      extra = retainedBytes(coarse);
      if (coarse.length && !over()) this.coarseStore.set(hash, coarse);
      return released;
    }
    // Smallest on screen first; without a viewport, the most recently received first.
    const sizes = this.onScreen(reached.keys());
    const smallest = (hashes: Iterable<string>) => {
      const list = [...hashes].reverse();
      return sizes ? list.sort((a, b) => (sizes.get(a) ?? 0) - (sizes.get(b) ?? 0)) : list;
    };
    for (const hash of smallest(this.meshStore.keys())) {
      if (!over()) break;
      if (!this.meshStore.get(hash)!.length) continue;
      this.meshStore.delete(hash);
      this.simplified.add(hash);
      released = true;
    }
    for (const hash of smallest(this.coarseStore.keys())) {
      if (!over()) break;
      this.coarseStore.delete(hash);
      this.simplified.add(hash);
      released = true;
    }
    return released;
  }
  /**
   * The Host's access changed: a revoked part's meshes and result go, and the content is
   * evaluated again, where the port reports it as `part-access-revoked`.
   */
  private accessChanged() {
    this.rechecked.clear();
    const s = this.options.controller.getSnapshot();
    const versions = this.versions(s.evaluation);
    const occurrences = expandAssembly(s.content, this.lookup).occurrences;
    const allowed = occurrenceAccess(occurrences, this.access);
    const revoked = occurrences.filter((_, i) => !allowed[i]);
    for (const o of revoked) {
      const hash = o.part.source.contentHash;
      this.meshStore.delete(hash);
      this.coarseStore.delete(hash);
      this.options.port.forget(hash);
    }
    // Restored access: an evaluation that reported the part revoked is evaluated again too.
    const restored = occurrences.some(
      (o, i) => allowed[i] && versions?.[o.part.source.contentHash]?.code === 'part-access-revoked',
    );
    if (revoked.length || restored) {
      this.options.controller.coordinator.forget(s.contentHash);
      void this.options.controller.refresh();
    }
    this.emit(true);
  }
  /**
   * After the controller changed: a reached version shown as available whose meshes were
   * released (Undo to an earlier content after they were evicted) is evaluated again through the
   * coordinator, where only the forgotten parts are new kernel jobs. Once per content and part.
   */
  private settle() {
    const s = this.options.controller.getSnapshot();
    // A migrated assembly evaluates its parts with the new build: earlier meshes do not apply.
    let meshesChanged = false;
    if (s.content.kernelProfile.buildHash !== this.meshBuild) {
      this.meshBuild = s.content.kernelProfile.buildHash;
      this.meshStore.clear();
      this.coarseStore.clear();
      this.simplified.clear();
      this.retried.clear();
      meshesChanged = true;
    }
    // The editor's own meshes may have grown into the shared budget.
    if (this.fit()) meshesChanged = true;
    // A body, feature or face selected in the editor replaces the component selection.
    if (s.selection) {
      this.selected = undefined;
      this.selectedJoint = undefined;
      this.selectedPattern = undefined;
    }
    // An entry is kept across selection changes and other edits; it is dropped only when its
    // component goes or its stored placement changes under it (Undo, a parameter).
    for (const [id, draft] of this.drafts) {
      const pose = s.content.solvedPoses[id];
      const placement = s.content.components.find((c) => c.id === id)?.placement;
      if (!pose || placementFields(pose, placement, s.content).some((v, i) => v !== draft.shown[i]))
        this.drafts.delete(id);
    }
    // A prepared update goes with any other edit, history or a sync (its ticket is gone).
    if (this.update && this.update.status !== 'preparing' && !this.options.controller.editPrepared)
      this.update = undefined;
    // So does a joint's preview; the choices stay, unless a component they name went.
    const c = this.creating;
    if (c) {
      const gone = [c.parent?.connector.componentPath[0], c.child?.componentId].some(
        (id) => id !== undefined && !stepComponent(s.content, id),
      );
      if (gone || s.readOnly) {
        // A preview still being prepared is dropped with it; a prepared one is cancelled.
        this.jointRun++;
        this.creating = undefined;
        if (c.status === 'ready' || c.status === 'broken')
          queueMicrotask(() => {
            const { controller } = this.options;
            if (!this.creating && !this.update && controller.editPrepared) controller.cancelEdit();
          });
      } else if (
        (c.status === 'ready' || c.status === 'broken') &&
        !this.options.controller.editPrepared
      )
        this.creating = { ...c, status: 'idle', preview: undefined };
    }
    for (const [id, draft] of this.jointDrafts) {
      const joint = s.content.joints.find((j) => j.id === id);
      const shown = joint && jointFields(joint, s.content);
      if (
        !shown ||
        shown.length !== draft.shown.length ||
        shown.some((v, i) => v !== draft.shown[i])
      )
        this.jointDrafts.delete(id);
    }
    const versions = this.versions(s.evaluation);
    // History returned to a result whose pending versions were left: they evaluate again.
    if (s.evaluation?.status === 'ok' && s.evaluation.contentHash === s.contentHash && !s.busy)
      this.options.port.resume(s.content, s.evaluation);
    const missing = versions
      ? [...expandAssembly(s.content, this.lookup).versions.keys()].filter(
          (hash) =>
            (versions[hash]?.state === 'available' || versions[hash]?.state === 'substitute') &&
            !this.meshStore.has(hash) &&
            !this.simplified.has(hash) &&
            !this.retried.has(`${s.contentHash} ${hash}`),
        )
      : [];
    // A retained evaluation from before an access change (history returning to it) may still
    // report a part revoked that is readable now: it is evaluated again, once per access change.
    const occurrences = versions ? expandAssembly(s.content, this.lookup).occurrences : [];
    const allowed = occurrenceAccess(occurrences, this.access);
    const stale =
      !this.rechecked.has(s.contentHash) &&
      occurrences.some(
        (o, i) =>
          allowed[i] && versions?.[o.part.source.contentHash]?.code === 'part-access-revoked',
      );
    if ((missing.length || stale) && !s.busy) {
      for (const hash of missing) {
        this.retried.add(`${s.contentHash} ${hash}`);
        this.options.port.forget(hash);
      }
      if (stale) this.rechecked.add(s.contentHash);
      this.options.controller.coordinator.forget(s.contentHash);
      void this.options.controller.refresh();
    }
    this.emit(meshesChanged);
  }
  /**
   * Tries the parts that failed for a passing reason again. The assembly's result is otherwise
   * ready, so the controller would not evaluate it again by itself; only those parts are new
   * kernel jobs (the others are cached).
   */
  retryParts() {
    const s = this.options.controller.getSnapshot();
    const versions = this.versions(s.evaluation);
    if (!versions || !Object.values(versions).some((v) => v.retryable) || s.busy) return false;
    this.options.controller.coordinator.forget(s.contentHash);
    void this.options.controller.refresh();
    return true;
  }
  private refuse(code: string) {
    this.options.controller.report(describeCode(code));
    return false;
  }
  /**
   * Inserts a saved version as a new component. The version (and what it places) must name the
   * assembly's build exactly (R2b-U6); it is evaluated first for its bounds, then stored in the
   * closure, and only then named by the edit. By default it goes beside what the document shows
   * (past its +X side, so it is never hidden inside it, ST-86); `origin` or a placement put it
   * there instead.
   */
  async insert(
    artifactId: string,
    versionId: string,
    name: string,
    at: 'beside' | 'origin' | CadComponentPlacement = 'beside',
  ): Promise<boolean> {
    const { controller, source, store } = this.options;
    if (this.inserting) return this.refuse('part-insert-busy');
    if (!source || !store) return this.refuse('part-source-unavailable');
    if (controller.getSnapshot().readOnly) return this.refuse('permission-denied');
    if (!source.checkAccess(artifactId)) return this.refuse('part-access-revoked');
    this.inserting = true;
    this.emit();
    try {
      const content = controller.getSnapshot().content;
      const checked = await this.readChecked(artifactId, versionId, content);
      if (typeof checked === 'string') return this.refuse(checked);
      const { read, hash, reach, lookup } = checked;
      if (!read.content.components.length && !read.content.bodies.some((b) => b.state === 'active'))
        return this.refuse('part-empty');
      const existing = content.parts.find(
        (p) =>
          p.source.kind === 'version' &&
          p.source.artifactId === artifactId &&
          p.source.versionId === versionId,
      );
      const evaluated = await this.evaluateRead(checked, content, `cad-insert-${hash}`);
      if (typeof evaluated === 'string') return this.refuse(evaluated);
      const { bounds } = evaluated;
      const def: CadPartDef = existing ?? {
        id: controller.newId('part'),
        name,
        source: { kind: 'version', artifactId, versionId, contentHash: hash },
        hint: { boundsMm: bounds },
      };
      const count = content.components.filter((c) => c.partId === def.id).length;
      const component = {
        id: controller.newId('component'),
        name: `${def.name} ${count + 1}`,
        partId: def.id,
        placement:
          typeof at === 'object'
            ? at
            : {
                translation: at === 'beside' ? this.besidePosition(bounds) : position(0, 0, 0),
                rotation: identityQuaternion(),
              },
        bom: 'include' as const,
      };
      // Limits through the nested versions, before anything is stored.
      const candidate: CadDocument = {
        ...content,
        parts: existing ? content.parts : [...content.parts, def],
        components: [...content.components, component],
        solvedPoses: {
          ...content.solvedPoses,
          [component.id]: solvePlacement(component.placement, parameterValues(content)),
        },
      };
      const limit = expandAssembly(candidate, lookup).limit;
      if (limit) return this.refuse(limit);
      if (candidate.components.length > cadAssemblyLimits.components)
        return this.refuse('limit-components');
      try {
        await store.stage([read.content, ...reach.versions.values()], []);
      } catch (e) {
        return this.refuse(e instanceof Error && e.message ? e.message : 'part-stage-failed');
      }
      const applied = await controller.run({
        type: 'insertComponents',
        parts: existing ? [] : [def],
        components: [component],
      });
      if (applied) this.selected = component.id;
      return applied;
    } finally {
      this.inserting = false;
      this.emit();
    }
  }
  /**
   * R2b-5: reads a STEP assembly with the document's exact build into its preview. Only an empty
   * document takes one: the import makes it the new assembly (R2b-U7). Nothing is stored and the
   * content does not change until `adoptStepImport`.
   */
  async prepareStepImport(fileName: string, bytes: Uint8Array): Promise<boolean> {
    const { controller, store, importStepAssembly } = this.options;
    this.stepImport = undefined;
    const s = controller.getSnapshot();
    if (s.readOnly) return this.refuse('permission-denied');
    if (s.reference) return this.refuse('kernel-reference-only');
    if (!store || !importStepAssembly || !controller.importAvailable)
      return this.refuse('step-import-unavailable');
    if (this.inserting || s.busy) return this.refuse('part-insert-busy');
    const { content } = s;
    if (content.features.length || content.bodies.length || content.components.length)
      return this.refuse('step-assembly-not-empty');
    this.inserting = true;
    this.emit();
    try {
      const result = await importStepAssembly(
        content.kernelProfile,
        controller.newId('import'),
        bytes,
      );
      if (result.status !== 'ok') {
        controller.report(
          `${describeCode(result.code)}${result.detail ? `（${result.detail}）` : ''}`,
          result.code,
        );
        return false;
      }
      if (result.read.shapes.length > cadAssemblyLimits.parts) return this.refuse('limit-parts');
      this.stepImport = {
        fileName,
        bytes,
        buildHash: content.kernelProfile.buildHash,
        result,
      };
      return true;
    } finally {
      this.inserting = false;
      this.emit();
    }
  }
  /**
   * Stores the source STEP, each shape's BRep and its part document first, then places every
   * instance as a fixed component of an imported part in one edit.
   */
  async adoptStepImport(): Promise<boolean> {
    const pending = this.stepImport;
    this.stepImport = undefined;
    this.emit();
    if (!pending) return false;
    const { controller, store } = this.options;
    const s = controller.getSnapshot();
    if (s.readOnly) return this.refuse('permission-denied');
    if (!store) return this.refuse('step-import-unavailable');
    const { content } = s;
    if (content.kernelProfile.buildHash !== pending.buildHash)
      return this.refuse('step-import-changed');
    if (content.features.length || content.bodies.length || content.components.length)
      return this.refuse('step-assembly-not-empty');
    const { read, report, breps } = pending.result;
    const ref = (kind: CadAssetRef['kind'], sha256: string, byteLength: number): CadAssetRef => ({
      id: kind === 'source-step' ? 'source' : 'brep',
      kind,
      sha256,
      byteLength,
      mediaType: cadAssetMediaTypes[kind],
    });
    const source = ref('source-step', report.source.sha256, report.source.byteLength);
    const brepRefs = read.shapes.map((x) =>
      ref('normalized-brep', x.brep.sha256, x.brep.byteLength),
    );
    const plan = stepImportPlan(
      content.kernelProfile,
      read,
      { source, breps: brepRefs },
      { sourceUnit: report.sourceUnit, scaleToMm: report.scaleToMm },
      (prefix) => controller.newId(prefix),
    );
    if (plan.status !== 'ok') return this.refuse(plan.code);
    this.inserting = true;
    this.emit();
    try {
      // Each asset once by hash: equal shapes of different products share their BRep.
      const assets = [{ ref: source, bytes: pending.bytes }];
      brepRefs.forEach((r, i) => {
        if (!assets.some((a) => a.ref.sha256 === r.sha256))
          assets.push({ ref: r, bytes: breps[i]! });
      });
      try {
        await store.stage(plan.versions, assets);
      } catch (e) {
        return this.refuse(e instanceof Error && e.message ? e.message : 'part-stage-failed');
      }
      // An edit or a build change may have landed while the Host stored the files.
      const now = controller.getSnapshot();
      if (now.readOnly) return this.refuse('permission-denied');
      if (now.content.kernelProfile.buildHash !== pending.buildHash)
        return this.refuse('step-import-changed');
      if (now.content.features.length || now.content.bodies.length || now.content.components.length)
        return this.refuse('step-assembly-not-empty');
      return await controller.run({
        type: 'insertComponents',
        parts: plan.parts,
        components: plan.components,
      });
    } finally {
      this.inserting = false;
      this.emit();
    }
  }
  /** Discards the read file; nothing was stored. */
  cancelStepImport() {
    this.stepImport = undefined;
    this.emit();
  }
  /**
   * Reads a saved version from the Host and checks it as an insert or update takes it: valid
   * content with the hash it is named by, its whole closure, and the assembly's build (R2b-U6).
   */
  private async readChecked(artifactId: string, versionId: string, content: CadDocument) {
    const { source, store } = this.options;
    if (!source || !store) return 'part-source-unavailable';
    if (!source.checkAccess(artifactId)) return 'part-access-revoked';
    let read: CadPartVersionRead;
    try {
      read = await source.readVersion(artifactId, versionId);
      assertCad(read.content);
      read.closure.forEach((d) => assertCad(d));
    } catch {
      return 'part-invalid';
    }
    const hash = cadContentHash(read.content);
    if (hash !== read.contentHash) return 'part-source-mismatch';
    const nested = new Map(read.closure.map((d) => [cadContentHash(d), d]));
    const lookup = (h: string) => (h === hash ? read.content : (nested.get(h) ?? store.get(h)));
    const reach = expandAssembly(read.content, lookup);
    if (reach.missing.size) return 'part-source-missing';
    const build = content.kernelProfile.buildHash;
    if ([read.content, ...reach.versions.values()].some((d) => d.kernelProfile.buildHash !== build))
      return 'part-build-mismatch';
    return { read, hash, reach, lookup };
  }
  /** Stages a checked version's asset bytes and evaluates it: its bounds and summary. */
  private async evaluateRead(
    { read, hash, reach }: Exclude<Awaited<ReturnType<CadAssembly['readChecked']>>, string>,
    content: CadDocument,
    requestId: string,
  ) {
    // An imported body's BRep is read from the asset store: its bytes go there first.
    if (read.assets.length)
      try {
        await this.options.store!.stage([], read.assets);
      } catch (e) {
        return e instanceof Error && e.message ? e.message : 'part-stage-failed';
      }
    const own = await this.options.port.evaluateVersion(read.content, content.kernelProfile, {
      requestId,
      hash,
    });
    if (own.state !== 'available') return own.code ?? 'part-invalid';
    let bounds: [Vec3, Vec3] | undefined;
    for (const b of Object.values(own.bodies ?? {})) bounds = union(bounds, b.bounds);
    for (const o of reach.occurrences)
      bounds = union(bounds, poseBounds(o.part.hint.boundsMm, o.pose));
    return {
      bounds:
        bounds ??
        ([
          [0, 0, 0],
          [0, 0, 0],
        ] as [Vec3, Vec3]),
    };
  }
  /**
   * A version's size and total solid volume, its nested parts included: each placed body counts
   * once per occurrence. The volume is left out when any body is a sheet or a nested part cannot
   * be evaluated or read here; an unreadable part (or one inside an unreadable sub-assembly) is
   * never evaluated and counts by its stored bounds.
   */
  private async summary(
    doc: CadDocument,
    hash: string,
    lookup: (hash: string) => CadDocument | undefined,
    content: CadDocument,
    requestId: string,
  ): Promise<CadVersionSummary | undefined> {
    const evaluate = (d: CadDocument, h: string) =>
      this.options.port.evaluateVersion(d, content.kernelProfile, { requestId, hash: h });
    const own = await evaluate(doc, hash);
    if (own.state !== 'available') return undefined;
    let bounds = unionAll(own.bodies);
    let volume: number | undefined = 0;
    const add = (bodies: Record<string, CadBodyEvaluation> | undefined) => {
      for (const b of Object.values(bodies ?? {}))
        volume = b.kind === 'solid' && volume !== undefined ? volume + b.volumeMm3 : undefined;
    };
    add(own.bodies);
    const { occurrences } = expandAssembly(doc, lookup);
    const allowed = occurrenceAccess(occurrences, this.access);
    for (const [i, o] of occurrences.entries()) {
      const inner = o.content;
      // A sub-assembly without bodies of its own is drawn by its parts, listed after it.
      if (allowed[i] && inner && !inner.bodies.some((b) => b.state === 'active')) continue;
      // A part that cannot be read now counts by its stored bounds only, and leaves the volume out.
      const e = allowed[i] && inner ? await evaluate(inner, o.part.source.contentHash) : undefined;
      const placed = e?.state === 'available' ? unionAll(e.bodies) : undefined;
      bounds = union(bounds, poseBounds(placed ?? o.part.hint.boundsMm, o.pose));
      if (e?.state === 'available') add(e.bodies);
      else volume = undefined;
    }
    const [lo, hi] = bounds ?? [
      [0, 0, 0],
      [0, 0, 0],
    ];
    return {
      sizeMm: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]],
      ...(volume === undefined ? {} : { volumeMm3: volume }),
    };
  }
  /**
   * A placed version's name for people: the Host's label (`v2`), else a shortened ID. The IDs
   * themselves stay in the content, the BOM CSV and the STEP file.
   */
  versionLabel(artifactId: string, versionId: string): string {
    return (
      this.options.source?.versionLabel?.(artifactId, versionId) ??
      `version ${versionId.length > 16 ? `${versionId.slice(0, 16)}…` : versionId}`
    );
  }
  /** The Host's newest saved version of a part's Artifact, when it is not the one placed. */
  newerVersion(partId: string) {
    const part = this.options.controller.getSnapshot().content.parts.find((p) => p.id === partId);
    const latest =
      part?.source.kind === 'version' &&
      this.options.source?.latestVersion?.(part.source.artifactId);
    return latest && latest.contentHash !== part!.source.contentHash ? latest : undefined;
  }
  /**
   * Prepares parts to take other saved versions of their Artifacts, all in one edit (R2b-2b):
   * each version is read, checked, evaluated and kept in the closure, then the edit is prepared
   * and previewed. Joints it breaks are listed; the first one's connectors can be chosen again
   * with it (`chooseUpdate`). Nothing is stored until `applyUpdate`.
   */
  async prepareUpdate(targets: { partId: string; versionId: string; label?: string }[]) {
    const { controller, store } = this.options;
    if (this.inserting || this.update?.status === 'preparing' || this.creating)
      return this.refuse('part-insert-busy');
    if (controller.getSnapshot().readOnly) return this.refuse('permission-denied');
    const content = controller.getSnapshot().content;
    // Only saved versions have other versions; a part imported into this document has none.
    const parts = targets.map((t) => {
      const part = content.parts.find((p) => p.id === t.partId);
      return {
        t,
        part: part?.source.kind === 'version' ? { ...part, source: part.source } : undefined,
      };
    });
    if (!targets.length || parts.some((x) => !x.part)) return this.refuse('target-missing');
    const run = ++this.updateRun;
    this.update = {
      parts: parts.map(({ t, part }) => ({
        partId: t.partId,
        name: part!.name,
        from: part!.source.versionId,
        to: t.label ?? t.versionId,
      })),
      status: 'preparing',
      moved: [],
      broken: [],
      canChoose: false,
    };
    this.emit();
    const stop = (code: string) => {
      if (run !== this.updateRun) return false;
      this.update = undefined;
      return this.refuse(code);
    };
    const replaced: Extract<CadOperation, { type: 'replacePartSources' }>['parts'] = [];
    const staged: CadDocument[] = [];
    const view = this.update.parts;
    for (const [i, { t, part }] of parts.entries()) {
      const checked = await this.readChecked(part!.source.artifactId, t.versionId, content);
      if (typeof checked === 'string') return stop(checked);
      if (run !== this.updateRun) return false;
      const evaluated = await this.evaluateRead(checked, content, `cad-update-${checked.hash}`);
      if (typeof evaluated === 'string') return stop(evaluated);
      const shown = this.lookup(part!.source.contentHash);
      const from =
        shown &&
        (await this.summary(
          shown,
          part!.source.contentHash,
          this.lookup,
          content,
          `cad-update-${part!.source.contentHash}`,
        ));
      const to = await this.summary(
        checked.read.content,
        checked.hash,
        checked.lookup,
        content,
        `cad-update-${checked.hash}`,
      );
      if (run !== this.updateRun) return false;
      view[i] = {
        ...view[i]!,
        ...(to ? { toSummary: to } : {}),
        ...(from ? { fromSummary: from } : {}),
      };
      replaced.push({
        partId: t.partId,
        source: {
          kind: 'version',
          artifactId: part!.source.artifactId,
          versionId: t.versionId,
          contentHash: checked.hash,
        },
        hint: { boundsMm: evaluated.bounds },
      });
      staged.push(checked.read.content, ...checked.reach.versions.values());
    }
    if (run !== this.updateRun) return false;
    try {
      await store!.stage(staged, []);
    } catch (e) {
      return stop(e instanceof Error && e.message ? e.message : 'part-stage-failed');
    }
    if (run !== this.updateRun) return false;
    const prepared = await controller.prepareEdit({ type: 'replacePartSources', parts: replaced });
    if (run !== this.updateRun) {
      // Cancelled meanwhile: its prepared edit goes too, unless a newer update is under way.
      if (prepared && !this.update) controller.cancelEdit();
      return false;
    }
    if (!prepared) {
      // Refused (the editor's diagnostic says why) or superseded by another edit.
      this.update = undefined;
      this.emit();
      return false;
    }
    if (prepared.status === 'ready') {
      const poses = prepared.candidate.solvedPoses;
      this.update = {
        ...this.update,
        parts: view,
        status: 'ready',
        moved: content.components
          .filter((c) => {
            const a = content.solvedPoses[c.id];
            const b = poses[c.id];
            return !!a && !!b && posesDiffer(a, b);
          })
          .map((c) => c.name),
      };
    } else {
      const names = new Map(prepared.candidate.joints.map((j) => [j.id, j.name]));
      this.update = {
        ...this.update,
        parts: view,
        status: 'broken',
        broken: (prepared.evaluation.brokenJoints ?? []).map((id) => ({
          jointId: id,
          name: names.get(id) ?? id,
        })),
        code: prepared.evaluation.code,
        canChoose: !!prepared.evaluation.references?.length,
      };
    }
    this.emit();
    return true;
  }
  /** Adopts the previewed update as one edit (one Undo). */
  applyUpdate() {
    this.update = undefined;
    return this.options.controller.adoptEdit();
  }
  /** Chooses the broken joints' connectors again, with the update, as one edit. */
  chooseUpdate() {
    this.update = undefined;
    return this.options.controller.rebindEdit();
  }
  /** Leaves every part on its version; nothing is stored. */
  cancelUpdate() {
    this.updateRun++;
    this.update = undefined;
    this.emit();
    this.options.controller.cancelEdit();
  }
  /** Starts making a joint: the parent's connector is picked first. */
  startJoint() {
    const s = this.options.controller.getSnapshot();
    if (s.readOnly) return this.refuse('permission-denied');
    if (this.inserting || this.update) return this.refuse('part-insert-busy');
    this.jointRun++;
    this.creating = {
      step: 'parent',
      type: 'revolute',
      flip: false,
      status: 'idle',
      jointId: this.options.controller.newId('joint'),
    };
    this.selected = this.selectedJoint = this.selectedPattern = undefined;
    this.emit();
    return true;
  }
  /** Takes a viewport pick as the connector the current step asks for. */
  pickConnector(pick: CadConnectorPick | null) {
    const c = this.creating;
    if (!c || c.step === 'type' || !pick) return false;
    const content = this.options.controller.getSnapshot().content;
    const choice = connectorFromPick(content, this.lookup, pick, c.step);
    return this.choose(choice);
  }
  /** An origin for the current step: a part's, or for a parent with none this document's. */
  useOrigin(componentId: string | undefined) {
    const c = this.creating;
    if (!c || c.step === 'type') return false;
    const content = this.options.controller.getSnapshot().content;
    return this.choose(originChoice(content, componentId, c.step));
  }
  private choose(choice: CadConnectorChoice | string) {
    const c = this.creating!;
    if (typeof choice === 'string') return this.refuse(choice);
    if (c.step === 'parent') {
      this.creating = { ...c, parent: choice, step: 'child' };
      this.emit();
      return true;
    }
    // A component cannot move along its own connector (nor along one of its copies).
    const on = c.parent!.connector.componentPath[0];
    if (
      on !== undefined &&
      choice.componentId ===
        stepComponent(this.options.controller.getSnapshot().content, on)?.component.id
    )
      return this.refuse('joint-child-is-parent');
    this.creating = { ...c, child: choice, step: 'type' };
    void this.previewJoint();
    return true;
  }
  /** Picks a side's connector again (the child's goes with the parent's). */
  pickAgain(side: 'parent' | 'child') {
    const c = this.creating;
    if (!c) return;
    this.jointRun++;
    if (this.options.controller.editPrepared) this.options.controller.cancelEdit();
    this.creating = {
      ...c,
      step: side,
      ...(side === 'parent' ? { parent: undefined } : {}),
      child: undefined,
      status: 'idle',
      preview: undefined,
      message: undefined,
    };
    this.emit();
  }
  setJointType(type: CadJointType) {
    const c = this.creating;
    if (!c || c.type === type) return;
    this.creating = { ...c, type };
    if (c.step === 'type') void this.previewJoint();
    else this.emit();
  }
  /** Reverses the child connector's z, so it lies face to face with the parent's. */
  setJointFlip(flip: boolean) {
    const c = this.creating;
    if (!c || c.flip === flip) return;
    this.creating = { ...c, flip };
    if (c.step === 'type') void this.previewJoint();
    else this.emit();
  }
  /** Prepares the joint as the candidate edit: its poses solved, shown before Apply. */
  private async previewJoint() {
    const c = this.creating;
    if (!c?.parent || !c.child) return false;
    const { controller } = this.options;
    const run = ++this.jointRun;
    const content = controller.getSnapshot().content;
    const joint = newJoint(content, c.jointId, c.parent, c.child, c.type, c.flip);
    this.creating = { ...c, status: 'preparing', preview: undefined, message: undefined };
    this.emit();
    const prepared = await controller.prepareEdit({ type: 'insertJoint', joint });
    if (run !== this.jointRun) {
      if (prepared && this.creating?.status !== 'preparing') controller.cancelEdit();
      return false;
    }
    const now = this.creating!;
    if (!prepared) {
      // Refused (validation, or a part that cannot be read): the editor's diagnostic says why.
      const message = controller.getSnapshot().diagnostic?.message;
      this.creating = { ...now, status: 'refused', ...(message ? { message } : {}) };
    } else
      this.creating = {
        ...now,
        status: prepared.status,
        preview: { content: prepared.candidate, evaluation: prepared.evaluation },
        ...(prepared.status === 'broken'
          ? { message: describeAssemblyCode(prepared.evaluation.code) ?? prepared.evaluation.code }
          : {}),
      };
    this.emit();
    return true;
  }
  /** Adopts the previewed joint as one edit (one Undo) and selects it. */
  applyJoint() {
    const c = this.creating;
    if (c?.status !== 'ready') return false;
    this.creating = undefined;
    const applied = this.options.controller.adoptEdit();
    if (applied) this.selectedJoint = c.jointId;
    this.emit();
    return applied;
  }
  /** Stops making the joint; nothing is stored. */
  cancelJoint() {
    if (!this.creating) return;
    this.jointRun++;
    this.creating = undefined;
    this.emit();
    if (this.options.controller.editPrepared) this.options.controller.cancelEdit();
  }
  /**
   * The viewport's drag of the selected joint's value (R2b-2c), when it can be dragged here:
   * solved on the current evaluation, and the content editable.
   */
  jointDragTool(): CadJointDragTool | undefined {
    const { controller } = this.options;
    const s = controller.getSnapshot();
    const joint = s.content.joints.find((j) => j.id === this.snapshot.selectedJoint);
    const evaluated = s.evaluation?.status === 'ok' ? s.evaluation : undefined;
    if (!joint || s.readOnly || this.creating || !evaluated || evaluated.reference)
      return undefined;
    const solution = evaluated.assembly?.joints?.[joint.id];
    const shown = evaluated.assembly?.poses?.[joint.child.componentId];
    if (solution?.status !== 'solved' || !shown) return undefined;
    const content = s.content;
    let drag: CadJointDrag | undefined;
    let values: Partial<Record<CadJointValueKey, number>> | undefined;
    return {
      moves: jointMoves(content, joint),
      frames: jointMoveFrames(content, joint),
      start: (ray, grab, alternate) => {
        if (controller.getSnapshot().busy) return 'joint-drag-busy';
        if (controller.getSnapshot().content !== content) return 'joint-drag-changed';
        const started = startJointDrag(content, joint, solution, ray, grab, alternate);
        if (started.status !== 'ok') return `joint-drag-${started.status}`;
        drag = started.drag;
        values = undefined;
        return undefined;
      },
      move: (ray) => {
        const next = drag && moveJointDrag(drag, ray);
        if (!next) return undefined;
        values = next;
        this.dragging = { jointId: joint.id, values: next };
        this.emit();
        return dragMotion(joint, solution, shown, next);
      },
      end: async (commit) => {
        const released = commit && drag && values ? releasedJointValues(drag, values) : undefined;
        drag = undefined;
        this.dragging = undefined;
        // Undo (or another edit) during the drag: its values were read from other content.
        if (released && controller.getSnapshot().content !== content) {
          this.emit();
          return this.refuse('joint-drag-changed');
        }
        // A drag that moved replaces values typed and not applied; a click keeps them.
        if (released) this.jointDrafts.delete(joint.id);
        this.emit();
        if (!released) return false;
        return controller.run({ type: 'setJointValues', jointId: joint.id, values: released });
      },
      onRefused: (reason) => void this.refuse(reason),
    };
  }
  /**
   * Where a part with these bounds goes beside what the document shows: its -X side a gap past
   * the shown +X side (own bodies and every placed part and pattern copy by its stored bounds), Y and Z at 0. An
   * empty document places it at the origin.
   */
  private besidePosition([lo, hi]: [Vec3, Vec3]): Position3 {
    const { content, evaluation } = this.options.controller.getSnapshot();
    let shown = unionAll(evaluation?.status === 'ok' ? evaluation.bodies : undefined);
    const params = parameterValues(content);
    const copies = componentCopies(content, params);
    for (const c of content.components) {
      const part = content.parts.find((p) => p.id === c.partId);
      if (!part) continue;
      for (const step of [c.id, ...(copies.get(c.id) ?? []).map((k) => k.step)]) {
        const pose = stepPose(content, content.solvedPoses, step, params);
        if (pose) shown = union(shown, poseBounds(part.hint.boundsMm, pose));
      }
    }
    if (!shown) return position(0, 0, 0);
    const gap = Math.max(10, (hi[0] - lo[0]) / 2);
    return position(Math.round(shown[1][0] + gap - lo[0]), 0, 0);
  }
  /** Moves a fixed component to a position (literal or bound) and orientation (one edit). */
  place(componentId: string, translation: Position3 | Vec3, rotation: Quaternion) {
    return this.options.controller.run({
      type: 'setComponentPlacement',
      componentId,
      placement: {
        translation: translation.map((v) => (typeof v === 'number' ? mm(v) : v)) as Position3,
        rotation,
      },
    });
  }
  /**
   * A new component of the same part on the other side of a plane through the origin, turned
   * half a turn (`mirroredPlacement`); it is selected. One edit. A joint's child has no
   * placement to mirror.
   */
  async duplicateMirrored(componentId: string, plane: CadMirrorPlane): Promise<boolean> {
    const { controller } = this.options;
    if (controller.getSnapshot().readOnly) return this.refuse('permission-denied');
    const content = controller.getSnapshot().content;
    const seed = content.components.find((c) => c.id === componentId);
    const def = seed && content.parts.find((p) => p.id === seed.partId);
    if (!seed || !def) return this.refuse('component-unplaced');
    if (!seed.placement) return this.refuse('component-mirror-joint');
    if (content.components.length + 1 > cadAssemblyLimits.components)
      return this.refuse('limit-components');
    const count = content.components.filter((c) => c.partId === def.id).length;
    const component: CadComponent = {
      id: controller.newId('component'),
      name: `${def.name} ${count + 1}`,
      partId: def.id,
      placement: mirroredPlacement(seed.placement, plane),
      bom: seed.bom,
    };
    const applied = await controller.run({
      type: 'insertComponents',
      parts: [],
      components: [component],
    });
    if (applied) {
      this.selected = component.id;
      this.emit();
    }
    return applied;
  }
  /** Keeps (or, unchanged from what was shown, drops) a component's placement entry. */
  setDraft(componentId: string, draft: CadPlacementDraft | undefined) {
    if (!draft || draft.fields.every((v, i) => v === draft.shown[i]))
      this.drafts.delete(componentId);
    else this.drafts.set(componentId, draft);
    this.emit();
  }
  /** Applies a placement entry as one edit. It is dropped first: a refused one is not kept. */
  applyDraft(componentId: string) {
    const draft = this.drafts.get(componentId);
    const pose = this.pose(componentId);
    if (!draft || !pose) return Promise.resolve(false);
    this.drafts.delete(componentId);
    this.emit();
    const doc = this.options.controller.getSnapshot().content;
    const placement = doc.components.find((c) => c.id === componentId)?.placement;
    let edited;
    try {
      edited = editedPlacement(pose, draft.shown, draft.fields, doc, placement);
    } catch (e) {
      this.options.controller.report((e as Error).message);
      return Promise.resolve(false);
    }
    return this.place(componentId, ...edited);
  }
  /**
   * The bill of materials (R2b-3) from the content and its retained closure, never stored. A
   * part this Surface cannot read now shows its stored name only.
   */
  bom(mode: CadBomMode) {
    return bomRows(this.options.controller.getSnapshot().content, this.lookup, mode, this.access);
  }
  /** The BOM as CSV: the content and its hash do not change (like PNG). */
  bomCsv(mode: CadBomMode) {
    return bomCsv(this.bom(mode));
  }
  /**
   * R2b-5: STEP AP242 of the confirmed assembly when it is called (docs/cad/r2b-assembly.md,
   * STEP AP242): every reached part must be evaluated and available, each shaped version is
   * written once from its exact shapes (one export job per version), then the products and
   * instances. `name` names the root product. Refuses with a diagnostic, else the file.
   */
  async exportStep(name: string): Promise<CadMeshExport | undefined> {
    const { controller } = this.options;
    const refuse = (code: string) => {
      controller.report(describeCode(code), code);
      return undefined;
    };
    const shown = controller.getSnapshot();
    const { content, contentHash, evaluation } = shown;
    if (shown.reference) return refuse('kernel-reference-only');
    if (shown.geometryState !== 'ready' || evaluation?.status !== 'ok' || shown.busy)
      return refuse('export-busy');
    // Stored poses that do not match their joints are not the assembly's placement (R2b-U5).
    if (evaluation.assembly?.poseMismatch?.length) return refuse('assembly-pose-mismatch');
    if (this.partsLeft()) return refuse('step-parts-pending');
    if (!this.options.exportBrep || !this.options.exportAssemblyStep)
      return refuse('kernel-unavailable');
    // Every placed part as it is shown: evaluated, readable and of this build (R2b-U6).
    const versions = this.versions(evaluation);
    const { occurrences } = expandAssembly(content, this.lookup);
    const allowed = occurrenceAccess(occurrences, this.access);
    if (
      occurrences.some(
        (o, i) => !allowed[i] || versions?.[o.part.source.contentHash]?.state !== 'available',
      )
    )
      return refuse('step-part-unavailable');
    const planned = assemblyStepPlan(content, contentHash, this.lookup, name);
    if (planned.status !== 'ok') return refuse(planned.code);
    const { plan } = planned;
    const breps = new Map<string, Uint8Array>();
    for (const product of plan.products) {
      const hash = product.shape?.contentHash;
      if (!hash || breps.has(hash)) continue;
      const document = hash === contentHash ? content : this.lookup(hash);
      if (!document) return refuse('step-part-missing');
      const exported = await this.options.exportBrep({
        requestId: controller.newId('export'),
        generation: 0,
        baseHash: hash,
        candidateHash: hash,
        document,
      });
      if (exported.evaluation.status !== 'ok') return refuse(exported.evaluation.code);
      if (
        exported.evaluation.contentHash !== hash ||
        exported.evaluation.buildHash !== evaluation.buildHash ||
        !exported.brep
      )
        return refuse('export-mismatch');
      breps.set(hash, exported.brep.bytes);
    }
    const written = await this.options.exportAssemblyStep(
      content.kernelProfile,
      controller.newId('export'),
      plan,
      breps,
    );
    if (written.status !== 'ok') return refuse(written.code);
    try {
      return {
        bytes: written.step,
        report: assemblyStepReport(written.step, plan, {
          sourceContentHash: contentHash,
          buildHash: evaluation.buildHash,
        }),
      };
    } catch (error) {
      if (error instanceof CadExportError) return refuse(error.code);
      throw error;
    }
  }
  /** Counts a component (and what it places) in the BOM, or leaves it out (one edit). */
  setComponentBom(componentId: string, bom: CadComponent['bom']) {
    return this.options.controller.run({ type: 'setComponentBom', componentId, bom });
  }
  /**
   * Copies of a component in a row or a circle (R2b-3), as one edit that selects the pattern.
   * `count` includes the component itself.
   */
  async insertPattern(seedComponentId: string, layout: CadPatternLayout) {
    const { controller } = this.options;
    const seed = controller.getSnapshot().content.components.find((c) => c.id === seedComponentId);
    if (!seed) return false;
    const pattern: CadComponentPattern = {
      id: controller.newId('pattern'),
      name: patternName(seed.name),
      seedComponentId,
      layout,
    };
    const applied = await controller.run({ type: 'insertComponentPattern', pattern });
    if (applied) this.selectPattern(pattern.id);
    return applied;
  }
  /** A pattern's layout replaced (one edit); the joints on its copies follow in the same edit. */
  updatePattern(pattern: CadComponentPattern) {
    return this.options.controller.run({ type: 'updateComponentPattern', pattern });
  }
  /** Removes a pattern: its seed stays. Refused while a joint hangs from one of its copies. */
  removePattern(patternId: string) {
    return this.options.controller.run({
      type: 'deleteClosure',
      ids: [patternId],
      cascade: false,
    });
  }
  /** Removes a component; its part definition goes with its last component. */
  remove(componentId: string) {
    return this.options.controller.run({
      type: 'deleteClosure',
      ids: [componentId],
      cascade: false,
    });
  }
  /** Keeps (or, unchanged from what was shown, drops) a joint's value entry. */
  setJointDraft(jointId: string, draft: CadPlacementDraft | undefined) {
    if (!draft || draft.fields.every((v, i) => v === draft.shown[i]))
      this.jointDrafts.delete(jointId);
    else this.jointDrafts.set(jointId, draft);
    this.emit();
  }
  /** Applies a joint's value entry as one edit (its subtree is solved in the same edit). */
  applyJointDraft(jointId: string) {
    const draft = this.jointDrafts.get(jointId);
    const joint = this.options.controller
      .getSnapshot()
      .content.joints.find((j) => j.id === jointId);
    if (!draft || !joint) return Promise.resolve(false);
    this.jointDrafts.delete(jointId);
    this.emit();
    return this.options.controller.run({
      type: 'setJointValues',
      jointId,
      values: editedJointValues(joint, draft.shown, draft.fields),
    });
  }
  /** Deletes a joint: its child stays where it stands, fixed there. */
  removeJoint(jointId: string) {
    return this.options.controller.run({ type: 'deleteClosure', ids: [jointId], cascade: false });
  }
  /** Adopts the poses the joints solve to, after stored ones were found not to match (one edit). */
  solvePoses() {
    return this.options.controller.run({ type: 'solveAssemblyPoses' });
  }
  /** World pose of a direct component as stored (for the Inspector). */
  pose(componentId: string) {
    return this.options.controller.getSnapshot().content.solvedPoses[componentId];
  }
  dispose() {
    this.unsubscribe();
    this.unsubscribePort();
    this.options.port.order = undefined;
    this.unsubscribeSource?.();
    this.meshStore.clear();
    this.coarseStore.clear();
  }
}
