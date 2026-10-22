import { newId } from '@editor-platform/artifact-core';
import {
  CadCoordinator,
  cadContentHash,
  identityQuaternion,
  isLiteralPosition,
  mm,
  position,
  type CadBody,
  type CadDocument,
  type CadEvaluation,
  type CadFeature,
  type CadGeometryState,
  type CadKernelPort,
  type CadOperation,
  type CadSession,
  type Position3,
} from '@editor-platform/cad-core';
import type { CadMesh } from '@editor-platform/cad-kernel-occt';

export type CadSelection = { kind: 'body' | 'feature' | 'parameter'; id: string } | null;
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
  /** Meshes of exactly the current content, or of an earlier content while re-evaluating. */
  meshes: { contentHash: string; current: boolean; meshes: CadMesh[] } | undefined;
  busy: boolean;
  diagnostic: CadDiagnostic | undefined;
  selection: CadSelection;
  canUndo: boolean;
  canRedo: boolean;
  readOnly: boolean;
  /** Increments whenever an edit is rejected, so uncommitted fields can reset. */
  rejections: number;
}
export interface CadControllerOptions {
  session: CadSession;
  kernel: CadKernelPort;
  canEdit(): boolean;
  permissionGeneration(): number;
  newId?: (prefix: string) => string;
  /** Called after an edit is applied to the session, e.g. so the Host persists its draft. */
  onApplied?(content: CadDocument): void;
}

const messages: Record<string, string> = {
  'multiple-solids': 'この操作では形状が複数に分かれるため確定できません。',
  'empty-result': 'この操作では形状が残りません。',
  'invalid-solid': 'この寸法では有効な形状を作れません。',
  'boolean-failed': 'Booleanの計算に失敗しました。',
  'result-tolerance': '計算精度の上限を超えるため確定できません。',
  'output-limit': '表示できる形状の上限を超えています。',
  'kernel-unavailable': '形状計算を開始できません。再計算を試してください。',
  'kernel-build-unavailable': 'この文書の計算に必要なkernelがありません。',
  timeout: '形状計算が時間内に終わりませんでした。',
  'permission-denied': '編集権限がありません。',
  'permission-changed': '権限が変わったため、もう一度操作してください。',
  stale: '計算中に内容が変わったため、結果を採用しませんでした。',
  'delete-has-dependents': 'ほかの要素が使っているため削除できません。',
  'placement-bound': '位置がparameterに結び付いているため、直接移動できません。',
};
export function describeCode(code: string): string {
  const base = code.split(/[:@]/)[0];
  if (messages[base]) return messages[base];
  if (code.startsWith('cad-invalid:')) {
    const reason = code.slice('cad-invalid:'.length).split('@')[0];
    if (reason.endsWith('-range')) return '値が許容範囲の外です。';
    return `この変更は確定できません（${reason}）。`;
  }
  if (base.startsWith('kernel-exception')) return 'この寸法では形状を作れません。';
  return `操作を確定できませんでした（${code}）。`;
}

/**
 * React-free controller for the CAD Surface: owns the coordinator, selection, meshes and
 * diagnostics. Every edit goes through prepare → apply; nothing calls the session directly.
 */
export class CadController {
  readonly coordinator: CadCoordinator;
  private readonly listeners = new Set<() => void>();
  private readonly meshStore = new Map<string, CadMesh[]>();
  private lastMeshHash: string | undefined;
  private snapshot: CadSnapshot;
  private busy = false;
  private diagnostic: CadDiagnostic | undefined;
  private selection: CadSelection = null;
  private rejections = 0;
  /** Latest run(); only its completion may clear `busy`. */
  private operation = 0;
  constructor(private readonly options: CadControllerOptions) {
    this.coordinator = new CadCoordinator(options);
    this.snapshot = this.build();
  }
  private id(prefix: string) {
    return this.options.newId?.(prefix) ?? newId(prefix);
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;
  private build(): CadSnapshot {
    const content = this.coordinator.content;
    const contentHash = cadContentHash(content);
    const own = this.meshStore.get(contentHash);
    const fallback = this.lastMeshHash && this.meshStore.get(this.lastMeshHash);
    return {
      content,
      contentHash,
      geometryState: this.coordinator.geometryState,
      evaluation: this.coordinator.evaluation,
      meshes: own
        ? { contentHash, current: true, meshes: own }
        : fallback
          ? { contentHash: this.lastMeshHash!, current: false, meshes: fallback }
          : undefined,
      busy: this.busy,
      diagnostic: this.diagnostic,
      selection: this.selection,
      canUndo: this.options.session.canUndo,
      canRedo: this.options.session.canRedo,
      readOnly: !this.options.canEdit(),
      rejections: this.rejections,
    };
  }
  private emit() {
    const content = this.coordinator.content;
    // Keep meshes for exactly the evaluations the coordinator retains (plus the latest arrival,
    // whose evaluation may not be cached yet), so a cached evaluation never lacks its mesh.
    const keep = new Set(this.coordinator.cachedContentHashes());
    for (const hash of this.meshStore.keys())
      if (!keep.has(hash) && hash !== this.lastMeshHash) this.meshStore.delete(hash);
    // Drop a selection whose element no longer exists (Undo, delete).
    if (this.selection && !this.exists(content, this.selection)) this.selection = null;
    this.snapshot = this.build();
    for (const listener of this.listeners) listener();
  }
  private exists(doc: CadDocument, s: NonNullable<CadSelection>) {
    const list =
      s.kind === 'body' ? doc.bodies : s.kind === 'feature' ? doc.features : doc.parameters;
    return list.some((x: { id: string }) => x.id === s.id);
  }
  /** Port callback: meshes for one exact content hash (pruned with the evaluation cache). */
  receiveMeshes = (contentHash: string, meshes: CadMesh[]) => {
    this.meshStore.set(contentHash, meshes);
    this.lastMeshHash = contentHash;
    this.emit();
  };
  select(selection: CadSelection) {
    this.selection = selection;
    this.emit();
  }
  /** Shows a Host refusal (e.g. an export guard) in the status line. */
  report(message: string) {
    this.diagnostic = { code: 'host-refused', severity: 'error', message };
    this.emit();
  }
  dismissDiagnostic() {
    this.diagnostic = undefined;
    this.emit();
  }
  private fail(code: string, elementId?: string) {
    this.diagnostic = { code, severity: 'error', elementId, message: describeCode(code) };
    this.rejections++;
  }
  /** Prepare, then apply in the same task as the last await. Returns whether it was applied. */
  async run(op: CadOperation): Promise<boolean> {
    if (!this.options.canEdit()) {
      this.fail('permission-denied');
      this.emit();
      return false;
    }
    const operation = ++this.operation;
    this.busy = true;
    this.diagnostic = undefined;
    this.emit();
    const prepared = await this.coordinator.prepare(op);
    // A superseded run leaves `busy` to the newer one that is still pending.
    if (operation === this.operation) this.busy = false;
    let applied = false;
    if (prepared.status === 'ready') {
      const result = this.coordinator.apply(prepared.ticket);
      applied = result.status === 'applied';
      if (result.status === 'rejected') this.fail(result.code);
      if (applied) this.options.onApplied?.(this.coordinator.content);
    } else if (prepared.status === 'geometry-error')
      this.fail(prepared.evaluation.code, prepared.evaluation.featureId);
    else if (prepared.status === 'rejected') this.fail(prepared.code);
    // A stale result superseded by a newer run leaves the outcome to it. Cancelled by history or
    // a Host sync instead, it resets the Inspector so no field keeps the cancelled value.
    else if (operation === this.operation) this.rejections++;
    this.emit();
    return applied;
  }
  async undo() {
    if (!this.options.session.canUndo) return;
    if (!this.options.canEdit()) {
      this.fail('permission-denied');
      this.emit();
      return;
    }
    const done = this.coordinator.undo();
    this.emit();
    await done;
    this.emit();
  }
  async redo() {
    if (!this.options.session.canRedo) return;
    if (!this.options.canEdit()) {
      this.fail('permission-denied');
      this.emit();
      return;
    }
    const done = this.coordinator.redo();
    this.emit();
    await done;
    this.emit();
  }
  /** The Host's permission changed: rebuild the snapshot (read-only state) and notify. */
  accessChanged() {
    this.emit();
  }
  /** After the Host changed the session itself (Undo/Redo, restore): drop prepared work, re-evaluate. */
  sync() {
    this.coordinator.invalidate();
    return this.refresh();
  }
  /** `retry` (Recalculate) also re-evaluates a cached failure such as a timeout. */
  async refresh({ retry = false }: { retry?: boolean } = {}) {
    const done = this.coordinator.refresh({ retry });
    this.emit();
    await done;
    this.emit();
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
