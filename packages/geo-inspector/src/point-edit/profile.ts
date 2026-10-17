import type { DeepReadonly, GeoDocument } from '@editor-platform/geo-core';

/** Trusted, per-open Host policy. Not a native flag, shared capability or storage API. */
export interface GeoPointEditProfile {
  readonly kind: 'retained-source-closure';
  /** Return true synchronously only for verified exact originals/pins for this content.
   * For history also guarantee closure for EVERY reachable Undo/Redo state.
   * Host must invalidate the scope when that guarantee can no longer be maintained. */
  check(content: DeepReadonly<GeoDocument>, intent: 'edit' | 'history'): boolean;
}
export function capturePointEditProfile(
  profile?: GeoPointEditProfile,
): GeoPointEditProfile | undefined {
  if (profile === undefined) return undefined;
  if (profile.kind !== 'retained-source-closure' || typeof profile.check !== 'function')
    throw new Error('GeoInvalidEditProfile');
  return Object.freeze({ kind: profile.kind, check: profile.check.bind(profile) });
}
export function assertSourceFree(content: GeoDocument) {
  if (content.sources.length || content.layers.some((l) => l.features.some((f) => f.sourceRef)))
    throw new Error('GeoSourceFreeProfileRequired');
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}
export function assertPointEditProfile(
  content: GeoDocument,
  profile?: GeoPointEditProfile,
  intent: 'edit' | 'history' = 'edit',
) {
  if (!profile) return assertSourceFree(content);
  if (profile.kind !== 'retained-source-closure' || typeof profile.check !== 'function')
    throw new Error('GeoInvalidEditProfile');
  const captured = structuredClone(content);
  freeze(captured);
  if (profile.check(captured, intent) !== true) throw new Error('GeoSourceClosureRequired');
}
/** Exact source/ref identity within one prepared edit; no new hash or persisted schema. */
export function sourceIdentity(content: DeepReadonly<GeoDocument>): string {
  return JSON.stringify([
    content.sources.map((s) => [
      s.id,
      s.pin.artifactId,
      s.pin.versionId,
      s.pin.contentHash,
      s.resourceId,
      s.bytesHash,
      s.format,
      s.adapterVersion,
      s.declaredCrs,
      s.axis,
      s.attribution,
    ]),
    content.layers.map((l) => [
      l.id,
      l.features.map((f) => [
        f.id,
        f.rowId,
        f.sourceRef ? [f.sourceRef.sourceId, f.sourceRef.externalId] : null,
      ]),
    ]),
  ]);
}
