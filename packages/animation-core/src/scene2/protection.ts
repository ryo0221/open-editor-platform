import { canonicalEqual } from '@editor-platform/artifact-core';
import { requireAnimation as check } from '../model';
import type { AnimationContent2, Composition2, Layer2 } from './model';
import { resolveComposition2 } from './source-resolution';

/** A local instance is a cross-composition parent of the locked artwork it renders.
 * Follow reverse references to a fixed point, including instances of instances.
 * This does not lock unrelated layers inside the referenced composition. */
function localLockDependents(content: AnimationContent2) {
  const compositions = new Set(
    content.compositions
      .filter((composition) => composition.layers.some((layer) => layer.locked))
      .map((composition) => composition.id),
  );
  const instances = new Set<Layer2>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const composition of content.compositions)
      for (const layer of composition.layers)
        if (
          layer.type === 'composition' &&
          layer.source.type === 'local' &&
          compositions.has(layer.source.compositionId)
        ) {
          instances.add(layer);
          if (!compositions.has(composition.id)) {
            compositions.add(composition.id);
            changed = true;
          }
        }
  }
  return { compositions, instances };
}

// Callers validate both snapshots before checking this shared local/authority policy.
/** Locked layers include inherited lock and the resources that determine their visible result. */
export function assertAnimationProtected2(before: AnimationContent2, after: AnimationContent2) {
  // Keyed lookups for this call only; callers may mutate their snapshots afterwards.
  const layerIndexes = new Map<Composition2, Map<string, Layer2>>();
  const layersById = (c: Composition2) => {
    let index = layerIndexes.get(c);
    if (!index) layerIndexes.set(c, (index = new Map(c.layers.map((l) => [l.id, l]))));
    return index;
  };
  /** Keyed equivalent of animationLayerLocked2. */
  const locked = (c: Composition2, id: string, includeSelf = true) => {
    const layers = layersById(c);
    let layer = layers.get(id);
    check(layer, 'missing-layer', id);
    if (!includeSelf) layer = layer.parentId ? layers.get(layer.parentId) : undefined;
    while (layer) {
      if (layer.locked) return true;
      layer = layer.parentId ? layers.get(layer.parentId) : undefined;
    }
    return false;
  };
  const dependents = localLockDependents(before);
  if (before.rootCompositionId !== after.rootCompositionId)
    check(!dependents.compositions.has(before.rootCompositionId), 'locked', 'rootCompositionId');
  const protectedCompositions = new Set<string>();
  const protectAsset = (layer: Layer2) => {
    const id =
      layer.type === 'image' ? layer.assetId : layer.type === 'text' ? layer.fontAssetId : null;
    if (id)
      check(
        canonicalEqual(
          before.assets.find((a) => a.id === id),
          after.assets.find((a) => a.id === id),
        ),
        'locked',
        layer.id,
      );
  };
  function protectSource(layer: Layer2) {
    if (layer.type !== 'composition') return;
    if (layer.source.type === 'exact') {
      // Retained source identities are immutable; compare the resolved owning
      // snapshot, including resources and its own nested dependency records.
      check(
        canonicalEqual(
          resolveComposition2(before, layer).content,
          resolveComposition2(after, layer).content,
        ),
        'locked',
        layer.id,
      );
      return;
    }
    const id = layer.source.compositionId;
    if (protectedCompositions.has(id)) return;
    protectedCompositions.add(id);
    const original = before.compositions.find((c) => c.id === id)!,
      updated = after.compositions.find((c) => c.id === id);
    // Every layer/order/track in a source can affect the locked instance. Local
    // sources remain editable when they are outside every protected closure.
    check(updated && canonicalEqual(original, updated), 'locked', layer.id);
    check(
      canonicalEqual(
        before.publicInputs.filter((i) => i.target.compositionId === id),
        after.publicInputs.filter((i) => i.target.compositionId === id),
      ),
      'locked',
      layer.id,
    );
    for (const child of original.layers) {
      protectAsset(child);
      protectSource(child);
    }
  }
  // An inserted/reparented node can change an old locked subtree without changing
  // any of its old layers. Inspect destination ancestry against the original lock.
  const compositionsBefore = new Map(before.compositions.map((c) => [c.id, c])),
    compositionsAfter = new Map(after.compositions.map((c) => [c.id, c]));
  for (const target of after.compositions) {
    const previous = compositionsBefore.get(target.id);
    if (!previous) continue;
    const previousLayers = layersById(previous),
      targetLayers = layersById(target);
    for (const layer of target.layers) {
      const old = previousLayers.get(layer.id);
      if (old?.parentId === layer.parentId) continue;
      let parent = layer.parentId;
      while (parent) {
        if (previousLayers.has(parent)) check(!locked(previous, parent), 'locked', parent);
        parent = targetLayers.get(parent)!.parentId;
      }
    }
  }
  for (const c of before.compositions) {
    const target = compositionsAfter.get(c.id),
      oldIndex = new Map(c.layers.map((l, i) => [l.id, i])),
      newIndex = new Map(target?.layers.map((l, i) => [l.id, i]));
    for (const layer of c.layers) {
      const isLocked = locked(c, layer.id);
      if (!isLocked && !dependents.instances.has(layer)) continue;
      const next = target && layersById(target).get(layer.id);
      check(target && next, 'locked', layer.id);
      const oldAt = oldIndex.get(layer.id)!,
        newAt = newIndex.get(layer.id)!;
      // New identities above protected artwork can cover it without modifying
      // an old node. The same final-state policy guards commands and wire patches.
      check(
        target.layers.every((l, i) => i <= newAt || oldIndex.has(l.id)),
        'locked',
        layer.id,
      );
      check(
        c.layers.every((l, i) => {
          const j = newIndex.get(l.id);
          return (
            j === undefined || l.id === layer.id || Math.sign(i - oldAt) === Math.sign(j - newAt)
          );
        }),
        'locked',
        layer.id,
      );
      const ownUnlock = layer.locked && !locked(c, layer.id, false) && !next.locked;
      check(
        canonicalEqual({ ...layer, locked: ownUnlock ? false : layer.locked }, next),
        'locked',
        layer.id,
      );
      check(
        c.duration === target.duration && c.width === target.width && c.height === target.height,
        'locked',
        layer.id,
      );
      // World geometry depends recursively on both parent and clip worlds.
      // Track/input changes on any of these nodes can alter a locked result too.
      const dependencies = new Set([layer.id]);
      for (const id of dependencies) {
        const dependency = layersById(c).get(id)!,
          updated = layersById(target).get(id);
        check(updated, 'locked', layer.id);
        if (id !== layer.id)
          check(
            canonicalEqual({ ...dependency, locked: updated.locked }, updated),
            'locked',
            layer.id,
          );
        if (dependency.parentId) dependencies.add(dependency.parentId);
        if (dependency.clipId) dependencies.add(dependency.clipId);
        // Reverse referrers protect their instance geometry/time, while the
        // child's own locked layers govern which source content is protected.
        if (id !== layer.id || isLocked) protectSource(dependency);
        check(
          canonicalEqual(
            c.tracks.filter((t) => t.layerId === id),
            target.tracks.filter((t) => t.layerId === id),
          ),
          'locked',
          layer.id,
        );
        check(
          canonicalEqual(
            before.publicInputs.filter(
              (i) => i.target.compositionId === c.id && i.target.layerId === id,
            ),
            after.publicInputs.filter(
              (i) => i.target.compositionId === c.id && i.target.layerId === id,
            ),
          ),
          'locked',
          layer.id,
        );
        protectAsset(dependency);
      }
    }
  }
}
