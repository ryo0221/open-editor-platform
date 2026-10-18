import type {
  Budgets,
  Feature,
  GeoDocument,
  Geometry,
  Scalar,
  SourceSnapshot,
  VectorLayer,
} from './model';
import { assertGeo, id, record } from './validation';
import { checkedJson } from './json-boundary';
import { assertEditableGeometry } from './geometry';
import type { GeoWorkspace } from './workspace-model';
export type GeoAction =
  | { type: 'addFeature'; layerId: string; feature: Feature }
  | { type: 'deleteFeature'; layerId: string; featureId: string }
  | { type: 'replaceGeometry'; layerId: string; featureId: string; geometry: Geometry | null }
  | { type: 'setAttribute'; layerId: string; featureId: string; fieldId: string; value: Scalar }
  | { type: 'importLayer'; layer: VectorLayer; source: SourceSnapshot }
  | { type: 'createLayer'; layer: VectorLayer }
  | { type: 'retainSource'; source: SourceSnapshot }
  | { type: 'refreshLayer'; layer: VectorLayer }
  | { type: 'setWorkspace'; workspace: GeoWorkspace }
  | { type: 'deleteLayer'; layerId: string };
export interface Revision {
  kind?: 'local-draft';
  sessionId: string;
  sequence: number;
}
export interface GeoCommand {
  expectedRevision: Revision;
  actions: GeoAction[];
}
export interface ExecutionContext {
  revision: Revision;
  canEdit: boolean;
  budgets: Budgets;
}
/** Runs before any payload property read, branch or clone at every command entrypoint. */
function assertCommand(command: unknown, budgets: Budgets): asserts command is GeoCommand {
  checkedJson(command, budgets, true);
  const keys = (value: Record<string, unknown>, required: string[]) =>
    Object.keys(value).length === required.length && required.every((k) => Object.hasOwn(value, k));
  const bad = () => {
    throw new Error('command-schema');
  };
  if (
    !record(command) ||
    !keys(command, ['expectedRevision', 'actions']) ||
    !record(command.expectedRevision) ||
    (!keys(command.expectedRevision, ['sessionId', 'sequence']) &&
      !(
        keys(command.expectedRevision, ['kind', 'sessionId', 'sequence']) &&
        command.expectedRevision.kind === 'local-draft'
      )) ||
    !id(command.expectedRevision.sessionId) ||
    !Number.isSafeInteger(command.expectedRevision.sequence) ||
    (command.expectedRevision.sequence as number) < 0 ||
    !Array.isArray(command.actions)
  )
    return bad();
  for (const action of command.actions) {
    if (!record(action)) return bad();
    switch (action.type) {
      case 'deleteLayer':
        if (!keys(action, ['type', 'layerId']) || !id(action.layerId)) return bad();
        break;
      case 'setWorkspace':
        if (!keys(action, ['type', 'workspace']) || !record(action.workspace)) return bad();
        break;
      case 'createLayer':
      case 'refreshLayer':
        if (!keys(action, ['type', 'layer']) || !record(action.layer)) return bad();
        break;
      case 'retainSource':
        if (!keys(action, ['type', 'source']) || !record(action.source)) return bad();
        break;
      case 'importLayer':
        if (
          !keys(action, ['type', 'layer', 'source']) ||
          !record(action.layer) ||
          !record(action.source)
        )
          return bad();
        break;
      case 'addFeature':
        if (
          !keys(action, ['type', 'layerId', 'feature']) ||
          !id(action.layerId) ||
          !record(action.feature) ||
          !(action.feature.geometry === null || record(action.feature.geometry))
        )
          return bad();
        break;
      case 'replaceGeometry':
        if (
          !keys(action, ['type', 'layerId', 'featureId', 'geometry']) ||
          !id(action.layerId) ||
          !id(action.featureId) ||
          !(action.geometry === null || record(action.geometry))
        )
          return bad();
        break;
      case 'deleteFeature':
        if (
          !keys(action, ['type', 'layerId', 'featureId']) ||
          !id(action.layerId) ||
          !id(action.featureId)
        )
          return bad();
        break;
      case 'setAttribute':
        if (
          !keys(action, ['type', 'layerId', 'featureId', 'fieldId', 'value']) ||
          !id(action.layerId) ||
          !id(action.featureId) ||
          !id(action.fieldId) ||
          !(action.value === null || ['string', 'number', 'boolean'].includes(typeof action.value))
        )
          return bad();
        break;
      default:
        throw new Error('unsupported-command');
    }
  }
}
/** Pure application. Caller supplies fresh trusted authority/revision, never payload authority. */
export function applyGeoCommand(
  content: GeoDocument,
  command: GeoCommand,
  context: ExecutionContext,
): GeoDocument {
  if (!context.canEdit) throw new Error('permission-denied');
  assertCommand(command, context.budgets);
  if (
    command.expectedRevision.sessionId !== context.revision.sessionId ||
    command.expectedRevision.sequence !== context.revision.sequence
  )
    throw new Error('stale-revision');
  assertGeo(content, context.budgets);
  const next = structuredClone(content);
  for (const a of command.actions) {
    if (a.type === 'deleteLayer') {
      if (!next.layers.some((l) => l.id === a.layerId)) throw Error('missing-layer');
      next.layers = next.layers.filter((l) => l.id !== a.layerId);
      continue;
    }
    if (a.type === 'setWorkspace') {
      next.workspace = structuredClone(a.workspace);
      continue;
    }
    if (a.type === 'retainSource') {
      next.sources.push(structuredClone(a.source));
      continue;
    }
    if (a.type === 'createLayer') {
      if (a.layer.features.some((f) => f.sourceRef)) throw Error('manual-layer-source-ref');
      for (const f of a.layer.features) assertEditableGeometry(f.geometry);
      next.layers.push(structuredClone(a.layer));
      continue;
    }
    if (a.type === 'refreshLayer') {
      const index = next.layers.findIndex((l) => l.id === a.layer.id);
      if (index < 0) throw Error('missing-layer');
      if (a.layer.features.some((f) => !f.sourceRef)) throw Error('refresh-source-required');
      next.layers[index] = structuredClone(a.layer);
      continue;
    }
    if (a.type === 'importLayer') {
      next.layers.push(structuredClone(a.layer));
      next.sources.push(structuredClone(a.source));
      continue;
    }
    const layer = next.layers.find((l) => l.id === a.layerId);
    if (!layer) throw new Error('missing-layer');
    if (a.type === 'addFeature') {
      assertEditableGeometry(a.feature.geometry);
      layer.features.push(structuredClone(a.feature));
      continue;
    }
    const index = layer.features.findIndex((f) => f.id === a.featureId);
    if (index < 0) throw new Error('missing-feature');
    const feature = layer.features[index];
    switch (a.type) {
      case 'deleteFeature':
        layer.features.splice(index, 1);
        break;
      case 'replaceGeometry':
        assertEditableGeometry(feature.geometry);
        assertEditableGeometry(a.geometry);
        feature.geometry = structuredClone(a.geometry);
        break;
      case 'setAttribute':
        if (!layer.fields.some((f) => f.id === a.fieldId)) throw new Error('missing-field');
        feature.values[a.fieldId] = a.value;
        break;
      default:
        throw new Error('unsupported-command');
    }
  }
  assertGeo(next, context.budgets);
  return next;
}
/** Structurally matches editor-core EditorCommand; no separate Undo stack. */
export function geoEditorCommand(command: GeoCommand, current: () => ExecutionContext) {
  // current is trusted Host state; budgets are checked now and again on execution.
  assertCommand(command, current().budgets);
  const prepared = structuredClone(command);
  return {
    type: 'geo.atomic',
    label: 'Edit geography',
    readonlyInput: true as const,
    apply: (content: GeoDocument) => applyGeoCommand(content, prepared, current()),
  };
}
