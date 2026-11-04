import { deepFreeze } from '@editor-platform/artifact-core';
import { isOwnedContent } from './admission';
import { copyData, requestBudget } from './input';
import { translateCoordinates } from './geometry';
import { checkCoordinate, contains, finite, pointsOf, record, text } from './schema';
import { attempt, fail } from './result';
import type {
  FictionMapChange,
  FictionMapContent,
  FictionMapCoordinateSpace,
  FictionMapFeature,
  FictionMapGeometry,
  FictionMapLayer,
  FictionMapNamedView,
  FictionMapPrecision,
  FictionMapResult,
} from './types';

function build(make: () => FictionMapChange): FictionMapResult<FictionMapChange> {
  return attempt('input', () => deepFreeze(copyData(make(), requestBudget) as FictionMapChange));
}
function selected(content: FictionMapContent, ids: readonly string[]): FictionMapFeature[] {
  if (!isOwnedContent(content)) fail('invalid-data', '/content');
  const input = copyData(ids, requestBudget);
  if (!Array.isArray(input)) fail('invalid-field', '/ids');
  const seen = new Set<string>();
  return input.map((v, i) => {
    const id = text(v, '/ids/' + i);
    if (seen.has(id)) fail('duplicate-id', '/ids/' + i, { id });
    seen.add(id);
    const f = content.features.find((f) => f.id === id);
    if (!f) fail('missing-feature', '/ids/' + i, { id });
    return f;
  });
}
export function createFeature(feature: FictionMapFeature): FictionMapResult<FictionMapChange> {
  return build(() => ({ create: [feature] }));
}
export function deleteFeatures(ids: readonly string[]): FictionMapResult<FictionMapChange> {
  return build(() => ({ delete: ids }));
}
type Metadata = Pick<
  FictionMapFeature,
  'name' | 'description' | 'category' | 'style' | 'worldEntityRef'
>;
export interface FictionMapMetadataPatch {
  readonly set?: Partial<Metadata>;
  readonly clear?: readonly ('description' | 'category' | 'style' | 'worldEntityRef')[];
}
export function updateFeatureMetadata(
  content: FictionMapContent,
  id: string,
  input: FictionMapMetadataPatch,
): FictionMapResult<FictionMapChange> {
  return build(() => {
    const [feature] = selected(content, [id]),
      p = record(copyData(input, requestBudget), '/patch', [], ['set', 'clear']);
    const set = Object.hasOwn(p, 'set')
      ? record(
          p.set,
          '/patch/set',
          [],
          ['name', 'description', 'category', 'style', 'worldEntityRef'],
        )
      : {};
    const clear = Object.hasOwn(p, 'clear') ? p.clear : [];
    if (!Array.isArray(clear)) fail('invalid-field', '/patch/clear');
    const fields = new Set<string>();
    const next = { ...feature, ...set };
    clear.forEach((k, i) => {
      if (
        typeof k !== 'string' ||
        !['description', 'category', 'style', 'worldEntityRef'].includes(k) ||
        fields.has(k) ||
        Object.hasOwn(set, k)
      )
        fail('invalid-field', '/patch/clear/' + i);
      fields.add(k);
      Reflect.deleteProperty(next, k);
    });
    return { update: [next] };
  });
}
export function moveFeaturesToLayer(
  content: FictionMapContent,
  ids: readonly string[],
  layerId: string,
): FictionMapResult<FictionMapChange> {
  return build(() => ({ update: selected(content, ids).map((f) => ({ ...f, layerId })) }));
}
export function translateFeatures(
  content: FictionMapContent,
  ids: readonly string[],
  dx: number,
  dy: number,
): FictionMapResult<FictionMapChange> {
  return build(() => {
    finite(dx, '/dx');
    finite(dy, '/dy');
    return {
      update: selected(content, ids).map((f) => {
        const geometry = translateCoordinates(f.geometry, dx, dy);
        for (const [i, p] of pointsOf(geometry).entries()) {
          checkCoordinate(p[0], `/geometry/${i}/0`);
          checkCoordinate(p[1], `/geometry/${i}/1`);
          if (!contains(content.coordinateSpace.bounds, p))
            fail('coordinate-out-of-range', `/geometry/${i}`);
        }
        return { ...f, geometry };
      }),
    };
  });
}
export function replaceGeometry(
  content: FictionMapContent,
  id: string,
  geometry: FictionMapGeometry,
  featureKind?: FictionMapFeature['featureKind'],
): FictionMapResult<FictionMapChange> {
  return build(() => ({
    update: selected(content, [id]).map((f) => ({
      ...f,
      geometry,
      ...(featureKind ? { featureKind } : {}),
    })),
  }));
}
export const replaceLayers = (layers: readonly FictionMapLayer[]) => build(() => ({ layers }));
export const replaceNamedViews = (namedViews: readonly FictionMapNamedView[]) =>
  build(() => ({ namedViews }));
export const setCoordinateSpace = (coordinateSpace: FictionMapCoordinateSpace) =>
  build(() => ({ coordinateSpace }));
export const setPrecision = (precision: FictionMapPrecision) => build(() => ({ precision }));
