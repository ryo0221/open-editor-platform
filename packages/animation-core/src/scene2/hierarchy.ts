import { requireAnimation as check } from '../model';
import type { Composition2 } from './model';

export function animationSubtree2(composition: Composition2, rootIds: readonly string[]) {
  const ids = new Set(rootIds);
  check(
    rootIds.length > 0 && rootIds.every((id) => composition.layers.some((l) => l.id === id)),
    'missing-layer',
    'selection',
  );
  for (let changed = true; changed; ) {
    changed = false;
    for (const l of composition.layers)
      if (l.parentId && ids.has(l.parentId) && !ids.has(l.id)) {
        ids.add(l.id);
        changed = true;
      }
  }
  return ids;
}
export function animationLayerLocked2(c: Composition2, id: string, includeSelf = true) {
  let layer = c.layers.find((l) => l.id === id);
  check(layer, 'missing-layer', id);
  if (!includeSelf)
    layer = layer.parentId ? c.layers.find((l) => l.id === layer!.parentId) : undefined;
  while (layer) {
    if (layer.locked) return true;
    layer = layer.parentId ? c.layers.find((l) => l.id === layer!.parentId) : undefined;
  }
  return false;
}
