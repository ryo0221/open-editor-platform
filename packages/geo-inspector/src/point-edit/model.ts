import {
  assertPointEditProfile,
  capturePointEditProfile,
  sourceIdentity,
  type GeoPointEditProfile,
} from './profile';
export { assertSourceFree } from './profile';
export type { GeoPointEditProfile } from './profile';
import { sameLocalRevision } from '@editor-platform/editor-core';
import type { LocalDraftRevision } from '@editor-platform/editor-core';
import type { LocalReadSnapshot } from '@editor-platform/extension-contract/draft2';
import type { PreparedSurfaceCommand } from '@editor-platform/extension-contract/controlled-surface';
import {
  assertGeo,
  geoEditorCommand,
  type Budgets,
  type ExecutionContext,
  type GeoDocument,
  type Scalar,
} from '@editor-platform/geo-core';
import { preparePointScene } from '../point-map';
import { capturePointDraft, capturePointTarget } from './draft-boundary';
export interface PointTarget {
  layerId: string;
  featureId: string;
  fieldId: string;
}
export interface PointDraft {
  baseRevision: Readonly<LocalDraftRevision>;
  target: PointTarget;
  longitude: string;
  latitude: string;
  scalar: string;
  scalarNull: boolean;
}
export function pointTarget(content: GeoDocument, input: PointTarget) {
  const target = capturePointTarget(input);
  const layer = content.layers.find((l) => l.id === target.layerId),
    feature = layer?.features.find((f) => f.id === target.featureId),
    field = layer?.fields.find((f) => f.id === target.fieldId);
  if (!layer || !feature || !field) throw new Error('GeoTargetMissing');
  return { layer, feature, field };
}
export function editablePoint(
  content: GeoDocument,
  target: PointTarget,
  profile?: GeoPointEditProfile,
) {
  assertPointEditProfile(content, profile);
  const found = pointTarget(content, target);
  if (found.feature.geometry?.type !== 'Point') throw new Error('GeoPointOnly');
  if (preparePointScene(found.layer).status !== 'ready') throw new Error('GeoLocalPointRange');
  return found;
}
export function draftFor(snapshot: LocalReadSnapshot<GeoDocument>, input: PointTarget): PointDraft {
  const target = capturePointTarget(input);
  const { feature } = pointTarget(snapshot.content, target),
    g = feature.geometry,
    value = feature.values[target.fieldId];
  return {
    baseRevision: { ...snapshot.revision },
    target: { ...target },
    longitude: g?.type === 'Point' ? String(g.coordinates[0]) : '',
    latitude: g?.type === 'Point' ? String(g.coordinates[1]) : '',
    scalar: value === null ? '' : String(value),
    scalarNull: value === null,
  };
}
function numberInput(value: string): number {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    !/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(value.trim())
  )
    throw new Error('GeoInvalidNumber');
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('GeoInvalidNumber');
  return number;
}
/** Exact pinned draft.2 data limits also apply to controller view envelopes.
 * Check the proposed complete view before native commit; do not relax shared limits. */
function assertViewCapacity(snapshot: LocalReadSnapshot<GeoDocument>, next: GeoDocument) {
  const view = {
    state: 'open',
    snapshot: {
      ...snapshot,
      content: next,
      revision: { ...snapshot.revision, sequence: snapshot.revision.sequence + 1 },
    },
    canEdit: true,
    canSave: false,
    saving: false,
    lastOperation: { state: 'unchanged' },
  };
  let nodes = 0;
  const visit = (v: unknown, depth: number) => {
    if (++nodes > 4096 || depth > 24) throw new Error('GeoControlledCapacity');
    if (v && typeof v === 'object') for (const value of Object.values(v)) visit(value, depth + 1);
  };
  visit(view, 0);
  if (new TextEncoder().encode(JSON.stringify(view)).length > 65536)
    throw new Error('GeoControlledCapacity');
}
/** Pure preparation plus execution-time revalidation. Trusted adapter supplies current authority. */
export function preparePointEdit(
  snapshot: LocalReadSnapshot<GeoDocument>,
  input: unknown,
  current: () => ExecutionContext,
  budgets: Budgets,
  checkCapacity?: (snapshot: LocalReadSnapshot<GeoDocument>, next: GeoDocument) => void,
  profile?: GeoPointEditProfile,
): PreparedSurfaceCommand<GeoDocument> {
  const draft = capturePointDraft(input);
  const editProfile = capturePointEditProfile(profile);
  assertGeo(snapshot.content, budgets);
  if (!sameLocalRevision(snapshot.revision, draft.baseRevision)) throw new Error('GeoStaleBuffer');
  const { feature, field } = editablePoint(snapshot.content, draft.target, editProfile);
  const pinnedSources = sourceIdentity(snapshot.content);
  const longitude = numberInput(draft.longitude),
    latitude = numberInput(draft.latitude);
  if (typeof draft.scalar !== 'string' || typeof draft.scalarNull !== 'boolean')
    throw new Error('GeoInvalidScalar');
  let value: Scalar = null;
  if (!draft.scalarNull) {
    if (field.type === 'number') value = numberInput(draft.scalar);
    else if (field.type === 'boolean') {
      if (draft.scalar !== 'true' && draft.scalar !== 'false') throw new Error('GeoInvalidBoolean');
      value = draft.scalar === 'true';
    } else value = draft.scalar;
  }
  const target = draft.target;
  const geo = geoEditorCommand(
    {
      expectedRevision: { ...draft.baseRevision },
      actions: [
        {
          type: 'replaceGeometry',
          layerId: target.layerId,
          featureId: target.featureId,
          geometry: { type: 'Point', coordinates: [longitude, latitude] },
        },
        {
          type: 'setAttribute',
          layerId: target.layerId,
          featureId: target.featureId,
          fieldId: target.fieldId,
          value,
        },
      ],
    },
    current,
  );
  const apply = (content: GeoDocument) => {
    assertGeo(content, budgets);
    if (editProfile && sourceIdentity(content) !== pinnedSources)
      throw new Error('GeoSourcePinsChanged');
    editablePoint(content, target, editProfile);
    const next = geo.apply(content); // Existing single atomic Geo batch and fresh authority/revision.
    assertViewCapacity(snapshot, next);
    checkCapacity?.(snapshot, next);
    if (editProfile && sourceIdentity(next) !== pinnedSources)
      throw new Error('GeoSourcePinsChanged');
    editablePoint(next, target, editProfile); // Same display rule for UI and non-UI; never hide moved points.
    return next;
  };
  const next = apply(snapshot.content); // Pure preview; validates even no-op and all rejection cases.
  const old = feature.geometry!;
  const changed =
    old.type !== 'Point' ||
    old.coordinates[0] !== longitude ||
    old.coordinates[1] !== latitude ||
    feature.values[target.fieldId] !==
      next.layers
        .find((l) => l.id === target.layerId)!
        .features.find((f) => f.id === target.featureId)!.values[target.fieldId];
  return { baseRevision: { ...snapshot.revision }, command: changed ? { ...geo, apply } : null };
}
