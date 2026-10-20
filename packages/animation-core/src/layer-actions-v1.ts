import { canonicalJson, deepFreeze } from '@editor-platform/artifact-core';
import { immutableCommand, withCommandReads } from '@editor-platform/editor-core';
import { requireAnimation as check, type AnimationContent, type AnimationContentV1 } from './model';
import type { AnimationEditScope } from './commands';
import { ownJson } from './validate';
import { readAnimationV1 } from './v1';

export interface AnimationLayerSubtreeV1 {
  readonly layerIds: readonly string[];
  readonly trackIds: readonly string[];
  readonly keyIds: readonly string[];
}

function subtree(content: AnimationContentV1, compositionId: string, layerId: string) {
  const composition = content.compositions.find((c) => c.id === compositionId);
  check(composition, 'missing-composition', compositionId);
  check(
    composition.layers.some((l) => l.id === layerId),
    'missing-layer',
    layerId,
  );
  const included = new Set([layerId]);
  // Native paint order need not be parent-first or contiguous.
  for (let changed = true; changed; ) {
    changed = false;
    for (const layer of composition.layers)
      if (layer.parentId !== null && included.has(layer.parentId) && !included.has(layer.id)) {
        included.add(layer.id);
        changed = true;
      }
  }
  const layers = composition.layers.filter((l) => included.has(l.id));
  const tracks = composition.tracks.filter((t) => included.has(t.layerId));
  return { composition, layers, tracks };
}

/** Exact deletion/duplication scope, including descendant tracks and keys, in native order. */
export function inspectAnimationLayerSubtreeV1(
  input: unknown,
  compositionId: string,
  layerId: string,
): AnimationLayerSubtreeV1 {
  const { layers, tracks } = subtree(readAnimationV1(input), compositionId, layerId);
  return deepFreeze({
    layerIds: layers.map((l) => l.id),
    trackIds: tracks.map((t) => t.id),
    keyIds: tracks.flatMap((t) => t.keys.map((k) => k.id)),
  });
}

function edit(
  expected: unknown,
  scope: AnimationEditScope,
  name: string,
  change: (content: AnimationContentV1) => void,
) {
  const base = canonicalJson(readAnimationV1(expected));
  return withCommandReads(
    immutableCommand<AnimationContent>(name, name, (current) => {
      check(scope.canEdit(), 'read-only', 'command');
      const next = readAnimationV1(current);
      check(canonicalJson(next) === base, 'stale', 'command');
      change(next);
      return readAnimationV1(next);
    }),
    { content: ['*'] },
  );
}

/** One local transaction removes the selected layer, every descendant and their tracks. */
export function removeAnimationLayerV1(
  expected: unknown,
  compositionId: string,
  layerId: string,
  scope: AnimationEditScope,
) {
  return edit(expected, scope, 'animation.remove-layer', (content) => {
    const { composition, layers, tracks } = subtree(content, compositionId, layerId);
    const layerIds = new Set(layers.map((l) => l.id));
    const trackIds = new Set(tracks.map((t) => t.id));
    composition.layers = composition.layers.filter((l) => !layerIds.has(l.id));
    composition.tracks = composition.tracks.filter((t) => !trackIds.has(t.id));
  });
}

/** Host supplies one fresh ID per copied layer/track/key. Copies append in original paint order. */
export function duplicateAnimationLayerV1(
  expected: unknown,
  compositionId: string,
  layerId: string,
  newIds: readonly { sourceId: string; id: string }[],
  scope: AnimationEditScope,
) {
  const owned = ownJson(newIds);
  check(Array.isArray(owned), 'layer-id-map', layerId);
  const ids = new Map<string, string>();
  for (const item of owned) {
    check(
      item &&
        typeof item === 'object' &&
        Object.keys(item).sort().join(',') === 'id,sourceId' &&
        typeof item.sourceId === 'string' &&
        typeof item.id === 'string' &&
        !ids.has(item.sourceId),
      'layer-id-map',
      layerId,
    );
    ids.set(item.sourceId, item.id);
  }
  return edit(expected, scope, 'animation.duplicate-layer', (content) => {
    const { composition, layers, tracks } = subtree(content, compositionId, layerId);
    const sourceIds = [
      ...layers.map((l) => l.id),
      ...tracks.flatMap((t) => [t.id, ...t.keys.map((k) => k.id)]),
    ];
    check(
      ids.size === sourceIds.length && sourceIds.every((id) => ids.has(id)),
      'layer-id-map',
      layerId,
    );
    composition.layers.push(
      ...layers.map((layer) => ({
        ...layer,
        id: ids.get(layer.id)!,
        parentId:
          layer.id === layerId || layer.parentId === null
            ? layer.parentId
            : ids.get(layer.parentId)!,
      })),
    );
    composition.tracks.push(
      ...tracks.map((track) => ({
        ...track,
        id: ids.get(track.id)!,
        layerId: ids.get(track.layerId)!,
        keys: track.keys.map((key) => ({ ...key, id: ids.get(key.id)! })),
      })),
    );
    // The native validator enforces global ID uniqueness and aggregate limits atomically.
  });
}
