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
export type GeoAction =
  | { type: 'addFeature'; layerId: string; feature: Feature }
  | { type: 'deleteFeature'; layerId: string; featureId: string }
  | { type: 'replaceGeometry'; layerId: string; featureId: string; geometry: Geometry | null }
  | { type: 'setAttribute'; layerId: string; featureId: string; fieldId: string; value: Scalar }
  | { type: 'importLayer'; layer: VectorLayer; source: SourceSnapshot };
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
const editable = (g: Geometry | null) =>
  g === null || g.type === 'Point' || g.type === 'LineString';
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
    if (a.type === 'importLayer') {
      next.layers.push(structuredClone(a.layer));
      next.sources.push(structuredClone(a.source));
      continue;
    }
    const layer = next.layers.find((l) => l.id === a.layerId);
    if (!layer) throw new Error('missing-layer');
    if (a.type === 'addFeature') {
      if (!editable(a.feature.geometry)) throw new Error('geometry-readonly-topology-pending');
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
        if (!editable(feature.geometry) || !editable(a.geometry))
          throw new Error('geometry-readonly-topology-pending');
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
