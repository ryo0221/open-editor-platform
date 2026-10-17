import { id } from '@editor-platform/geo-core';
import type { PointDraft, PointTarget } from './model';
/** Provisional input-work bound, independent of unchanged native/view budgets. */
export const POINT_INPUT_LIMITS = Object.freeze({
  numericCodeUnits: 128,
  scalarCodeUnits: 4096,
  jsonUtf8Bytes: 8192,
});
const boundedId = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 128 && id(value);
/** In-process data guard, like geo-core: not a sandbox for Proxy traps or modified intrinsics.
 * Fixed shapes contain no arrays. Never read input properties, spread, clone or stringify it.
 */
function ownData(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error('GeoDraftData');
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== names.length ||
    keys.some((key) => typeof key !== 'string' || !names.includes(key))
  )
    throw new Error('GeoDraftShape');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
      throw new Error('GeoDraftData');
    result[key] = descriptor.value;
  }
  return result;
}
export function capturePointTarget(input: unknown): Readonly<PointTarget> {
  const value = ownData(input, ['layerId', 'featureId', 'fieldId']);
  if (!boundedId(value.layerId) || !boundedId(value.featureId) || !boundedId(value.fieldId))
    throw new Error('GeoDraftTarget');
  return Object.freeze({
    layerId: value.layerId,
    featureId: value.featureId,
    fieldId: value.fieldId,
  });
}
/** Detaches all fixed-shape input into owned, frozen scalar records before semantic decisions. */
export function capturePointDraft(input: unknown): Readonly<PointDraft> {
  const value = ownData(input, [
    'baseRevision',
    'target',
    'longitude',
    'latitude',
    'scalar',
    'scalarNull',
  ]);
  const revision = ownData(value.baseRevision, ['kind', 'sessionId', 'sequence']);
  if (
    revision.kind !== 'local-draft' ||
    !boundedId(revision.sessionId) ||
    typeof revision.sequence !== 'number' ||
    !Number.isSafeInteger(revision.sequence) ||
    revision.sequence < 0
  )
    throw new Error('GeoDraftRevision');
  const target = capturePointTarget(value.target);
  if (
    typeof value.longitude !== 'string' ||
    typeof value.latitude !== 'string' ||
    typeof value.scalar !== 'string' ||
    typeof value.scalarNull !== 'boolean'
  )
    throw new Error('GeoDraftScalar');
  if (
    value.longitude.length > POINT_INPUT_LIMITS.numericCodeUnits ||
    value.latitude.length > POINT_INPUT_LIMITS.numericCodeUnits ||
    value.scalar.length > POINT_INPUT_LIMITS.scalarCodeUnits
  )
    throw new Error('GeoDraftTextLimit');
  const result = Object.freeze({
    baseRevision: Object.freeze({
      kind: 'local-draft' as const,
      sessionId: revision.sessionId,
      sequence: revision.sequence,
    }),
    target,
    longitude: value.longitude,
    latitude: value.latitude,
    scalar: value.scalar,
    scalarNull: value.scalarNull,
  });
  // Only bounded, owned data is serialized. No input hooks/getters or numeric parsing.
  if (new TextEncoder().encode(JSON.stringify(result)).length > POINT_INPUT_LIMITS.jsonUtf8Bytes)
    throw new Error('GeoDraftByteLimit');
  return result;
}
