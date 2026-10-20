import { canonicalEqual, canonicalJson, deepFreeze } from '@editor-platform/artifact-core';
import {
  immutableCommand,
  withCommandReads,
  type EditorCommand,
} from '@editor-platform/editor-core';
import {
  identityTransform,
  requireAnimation as check,
  type AnimationContentV1,
  type Transform,
} from '../model';
import { ownJson } from '../validate';
import { readAnimationV1 } from '../v1';
import { createAnimation2, readAnimation2, readFrozenAnimation2 } from './validate';
import type { AnimationContent2, Composition2, Layer2, Track2 } from './model';
import { referencedAnimationSources2 } from './source-retention';
import { animationSubtree2, animationLayerLocked2 } from './hierarchy';
import { assertAnimationProtected2 } from './protection';

// Preserve the public command entrypoints while keeping policy independent of execution.
export { animationSubtree2, animationLayerLocked2 } from './hierarchy';
export { assertAnimationProtected2 } from './protection';

export type AnimationAction2 =
  | { type: 'layer.insert'; compositionId: string; layer: Layer2 }
  | { type: 'layer.patch'; compositionId: string; id: string; patch: Record<string, unknown> }
  | { type: 'layer.remove'; compositionId: string; id: string }
  | { type: 'layer.reorder'; compositionId: string; ids: string[] }
  | { type: 'track.put'; compositionId: string; track: Track2 }
  | { type: 'track.remove'; compositionId: string; id: string }
  | {
      type: 'keys.move';
      compositionId: string;
      keys: { trackId: string; keyId: string }[];
      delta: number;
    }
  | { type: 'composition.duration'; compositionId: string; duration: number }
  | {
      type: 'content.set';
      field: 'assets' | 'publicInputs' | 'sources' | 'provenance';
      value: unknown;
    }
  | {
      type: 'structure.replace';
      compositions: Composition2[];
      publicInputs: AnimationContent2['publicInputs'];
    };
export interface AnimationCommand2 extends EditorCommand<AnimationContent2> {
  readonly animationActions2: readonly AnimationAction2[];
}
/** Authority and local commands both apply these exact data-only actions and validate the final source. */
export function applyAnimationActions2(
  input: unknown,
  actions: readonly AnimationAction2[],
): AnimationContent2 {
  return applyActions(input, actions, readAnimation2);
}
function applyActions(
  input: unknown,
  actions: readonly AnimationAction2[],
  read: (next: AnimationContent2) => AnimationContent2,
): AnimationContent2 {
  const before = readFrozenAnimation2(input),
    next = readAnimation2(before),
    owned = ownJson(actions) as AnimationAction2[];
  const removedImages = new Set<string>();
  check(Array.isArray(owned) && owned.length > 0 && owned.length <= 500, 'action-limit', 'actions');
  for (const action of owned) {
    check(action && typeof action === 'object', 'action', 'action');
    if (action.type === 'content.set') {
      check(
        ['assets', 'publicInputs', 'sources', 'provenance'].includes(action.field),
        'content-field',
        'action',
      );
      (next as unknown as Record<string, unknown>)[action.field] = action.value;
      continue;
    }
    if (action.type === 'structure.replace') {
      next.compositions = action.compositions;
      next.publicInputs = action.publicInputs;
      continue;
    }
    const c = next.compositions.find((c) => c.id === action.compositionId);
    check(c, 'missing-composition', action.compositionId);
    if (action.type === 'layer.insert') {
      check(!c.layers.some((l) => l.id === action.layer.id), 'duplicate-id', action.layer.id);
      if (action.layer.parentId)
        check(!animationLayerLocked2(c, action.layer.parentId), 'locked', action.layer.parentId);
      c.layers.push(action.layer);
    } else if (action.type === 'layer.patch') {
      const l = c.layers.find((l) => l.id === action.id);
      check(l, 'missing-layer', action.id);
      check(
        action.patch && typeof action.patch === 'object' && !Array.isArray(action.patch),
        'patch',
        action.id,
      );
      const unlocking =
        Object.keys(action.patch).length === 1 && Object.hasOwn(action.patch, 'locked');
      check(!animationLayerLocked2(c, l.id, !unlocking), 'locked', l.id);
      const allowed = [
        'name',
        'start',
        'end',
        'transform',
        'visible',
        'locked',
        'clipId',
        'maskOnly',
        'motion',
        'width',
        'height',
        'fill',
        'stroke',
        'strokeWidth',
        'path',
        'text',
        'runs',
        'fontAssetId',
        'fontSize',
        'lineHeight',
        'assetId',
        'time',
        'source',
      ];
      for (const [key, value] of Object.entries(action.patch)) {
        check(allowed.includes(key) && Object.hasOwn(l, key), 'layer-field', key);
        if (key === 'transform') {
          check(value && typeof value === 'object' && !Array.isArray(value), 'transform', l.id);
          l.transform = { ...l.transform, ...(value as Partial<Transform>) };
        } else (l as unknown as Record<string, unknown>)[key] = value;
      }
      if (
        l.type === 'text' &&
        Object.hasOwn(action.patch, 'text') &&
        !Object.hasOwn(action.patch, 'runs')
      )
        l.runs = [];
    } else if (action.type === 'layer.remove') {
      const ids = animationSubtree2(c, [action.id]);
      for (const id of ids) check(!animationLayerLocked2(c, id), 'locked', id);
      for (const layer of c.layers)
        if (ids.has(layer.id) && layer.type === 'image') removedImages.add(layer.assetId);
      c.layers = c.layers.filter((l) => !ids.has(l.id));
      c.tracks = c.tracks.filter((t) => !ids.has(t.layerId));
      next.publicInputs = next.publicInputs.filter(
        (i) => i.target.compositionId !== c.id || !ids.has(i.target.layerId),
      );
    } else if (action.type === 'layer.reorder') {
      check(
        Array.isArray(action.ids) &&
          action.ids.length === c.layers.length &&
          new Set(action.ids).size === c.layers.length &&
          action.ids.every((id) => c.layers.some((l) => l.id === id)),
        'layer-order',
        c.id,
      );
      // Moving a protected layer relative to any other layer is forbidden.
      const before = c.layers.map((l) => l.id);
      for (const l of c.layers)
        if (animationLayerLocked2(c, l.id))
          check(
            before.every(
              (id, index) =>
                id === l.id ||
                Math.sign(index - before.indexOf(l.id)) ===
                  Math.sign(action.ids.indexOf(id) - action.ids.indexOf(l.id)),
            ),
            'locked',
            l.id,
          );
      c.layers = action.ids.map((id) => c.layers.find((l) => l.id === id)!);
    } else if (action.type === 'track.put') {
      check(!animationLayerLocked2(c, action.track.layerId), 'locked', action.track.layerId);
      const i = c.tracks.findIndex((t) => t.id === action.track.id);
      if (i < 0) c.tracks.push(action.track);
      else {
        check(
          c.tracks[i].layerId === action.track.layerId &&
            c.tracks[i].property === action.track.property,
          'track-target-change',
          action.track.id,
        );
        c.tracks[i] = action.track;
      }
    } else if (action.type === 'track.remove') {
      const track = c.tracks.find((t) => t.id === action.id);
      check(track, 'missing-track', action.id);
      check(!animationLayerLocked2(c, track.layerId), 'locked', track.layerId);
      c.tracks = c.tracks.filter((t) => t !== track);
    } else if (action.type === 'keys.move') {
      check(
        Array.isArray(action.keys) &&
          action.keys.length > 0 &&
          action.keys.length <= 500 &&
          Number.isSafeInteger(action.delta),
        'key-move',
        'keys',
      );
      const seen = new Set<string>();
      for (const selected of action.keys) {
        const track = c.tracks.find((t) => t.id === selected.trackId),
          key = track?.keys.find((k) => k.id === selected.keyId);
        check(track && key && !seen.has(key.id), 'missing-key', selected.keyId);
        seen.add(key.id);
        check(!animationLayerLocked2(c, track.layerId), 'locked', track.layerId);
        key.tick += action.delta;
      }
      for (const track of c.tracks) track.keys.sort((a, b) => a.tick - b.tick);
    } else if (action.type === 'composition.duration') {
      check(!c.layers.some((l) => animationLayerLocked2(c, l.id)), 'locked', c.id);
      const previous = c.duration;
      c.duration = action.duration;
      // End-aligned layers follow the change; keys/trims past the new end reject atomically.
      for (const l of c.layers) if (l.end === previous) l.end = action.duration;
    } else check(false, 'unsupported-action', 'action');
  }
  // Prune after the complete batch, so a later insert can still reuse a provider.
  if (owned.some((action) => action.type === 'layer.remove'))
    next.sources = referencedAnimationSources2(next);
  // Only reclaim resources belonging to deleted image layers. Other uploaded
  // resources remain available, and later inserts in this batch may reuse them.
  const usedAssets = new Set(
    next.compositions.flatMap((c) =>
      c.layers.flatMap((layer) =>
        layer.type === 'image'
          ? [layer.assetId]
          : layer.type === 'text' && layer.fontAssetId
            ? [layer.fontAssetId]
            : [],
      ),
    ),
  );
  next.assets = next.assets.filter(
    (asset) => !removedImages.has(asset.id) || usedAssets.has(asset.id),
  );
  const validated = read(next);
  assertAnimationProtected2(before, validated);
  return validated;
}
export function animationCommand2(
  expected: unknown,
  actions: readonly AnimationAction2[],
  scope: { canEdit(): boolean },
  label = 'Edit Animation',
): AnimationCommand2 {
  const snapshot = readFrozenAnimation2(expected),
    owned = deepFreeze(ownJson(actions) as AnimationAction2[]);
  // Preparation proves the complete result; apply repeats live scope/base checks and
  // reuses that immutable result only for the identical admitted base.
  const prepared = applyActions(snapshot, owned, readFrozenAnimation2);
  const command = withCommandReads(
    immutableCommand<AnimationContent2>('animation2.edit', label, (current) => {
      check(scope.canEdit(), 'read-only', 'command');
      // An admitted immutable snapshot is its own proof of an unchanged base.
      const read = readFrozenAnimation2(current);
      check(read === snapshot || canonicalEqual(read, snapshot), 'stale', 'command');
      // Callers own the returned content; copying an admitted result skips revalidation.
      return read === snapshot ? readAnimation2(prepared) : applyAnimationActions2(read, owned);
    }),
    { content: ['*'] },
  );
  return Object.freeze({ ...command, animationActions2: owned });
}
export function upgradeAnimation2(input: unknown): AnimationContent2 {
  const old = readAnimationV1(input),
    next = createAnimation2();
  next.rootCompositionId = old.rootCompositionId;
  next.compositions = old.compositions.map((c) => ({
    ...c,
    name: c.id,
    layers: c.layers.map((l): Layer2 => {
      const common = {
        name: l.id,
        visible: true,
        locked: false,
        clipId: null,
        maskOnly: false,
        motion: null,
      };
      return l.type === 'rect'
        ? { ...l, ...common, stroke: '#00000000', strokeWidth: 0 }
        : { ...l, ...common };
    }),
  }));
  return readAnimation2(next);
}
export function upgradeAnimationCommand2(
  expected: AnimationContentV1,
  scope: { canEdit(): boolean },
): EditorCommand<AnimationContentV1 | AnimationContent2> {
  const base = canonicalJson(readAnimationV1(expected)),
    next = deepFreeze(upgradeAnimation2(expected));
  return withCommandReads(
    immutableCommand('animation.upgrade-2', 'Enable full 2D Animation', (current) => {
      check(scope.canEdit(), 'read-only', 'migration');
      check(canonicalJson(readAnimationV1(current)) === base, 'stale', 'migration');
      return next;
    }),
    { content: ['*'] },
  );
}
export function createAnimationLayer2(type: Layer2['type'], id: string, duration: number): Layer2 {
  const base = {
    id,
    name: type,
    parentId: null,
    start: 0,
    end: duration,
    transform: { ...identityTransform(), x: 80, y: 80 },
    visible: true,
    locked: false,
    clipId: null,
    maskOnly: false,
    motion: null,
  };
  if (type === 'rect')
    return {
      ...base,
      type,
      width: 120,
      height: 80,
      fill: '#818cf8',
      stroke: '#00000000',
      strokeWidth: 0,
    };
  if (type === 'path')
    return {
      ...base,
      type,
      path: [['M', 0, 60], ['C', 20, -20, 100, -20, 120, 60], ['L', 0, 60], ['Z']],
      fill: '#e87945',
      stroke: '#7c2d12',
      strokeWidth: 2,
    };
  if (type === 'text')
    return {
      ...base,
      type,
      text: 'Text',
      runs: [],
      width: 320,
      height: 120,
      fontAssetId: null,
      fontSize: 28,
      lineHeight: 1.3,
      fill: '#1e293b',
    };
  if (type === 'group') return { ...base, type };
  check(false, 'layer-requires-source', type);
}
