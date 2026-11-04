import { createFictionMap, validateFictionMap } from './admission';
import { unwrap } from './result';
import type { FictionMapContent, FictionMapFeature, FictionMapGeometry } from './types';
export type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
export const draft = () => structuredClone(createFictionMap()) as Mutable<FictionMapContent>;
export const layer = (id = 'l') => ({
  id,
  name: id,
  purpose: 'terrain' as const,
  visibleByDefault: true,
});
export const pointFeature = (
  id = 'p',
  geometry: FictionMapGeometry = { type: 'point', coordinates: [1, 2] },
): FictionMapFeature => ({ id, layerId: 'l', name: id, featureKind: 'landform', geometry });
export function native(
  features: readonly FictionMapFeature[] = [pointFeature()],
): FictionMapContent {
  return unwrap(validateFictionMap({ ...draft(), layers: [layer()], features }));
}
export const polygon = (n: number): FictionMapGeometry => {
  const p = Array.from(
    { length: n },
    (_, i) =>
      [100 + Math.cos((2 * Math.PI * i) / n), 100 + Math.sin((2 * Math.PI * i) / n)] as const,
  );
  return { type: 'polygon', outer: [...p, [...p[0]]] };
};
