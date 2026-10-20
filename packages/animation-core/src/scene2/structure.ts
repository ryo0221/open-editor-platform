import { canonicalJson } from '@editor-platform/artifact-core';
import { identityTransform, requireAnimation as check } from '../model';
import { ownJson } from '../validate';
import { readAnimation2 } from './validate';
import { animationCommand2, animationSubtree2 } from './commands';
import type { AnimationContent2, Composition2, Layer2 } from './model';
type Scope = { canEdit(): boolean };
/** Move a sibling subtree as one paint-order block, including groups stored after their children. */
export function animationLayerPaintOrder2(c: Composition2, id: string, direction: -1 | 1) {
  const layer = c.layers.find((l) => l.id === id);
  check(layer, 'missing-layer', id);
  const blocks = c.layers
    .filter((l) => l.parentId === layer.parentId)
    .map((sibling) => {
      const ids = animationSubtree2(c, [sibling.id]),
        painted = c.layers.filter((l) => ids.has(l.id) && l.type !== 'group' && !l.maskOnly);
      return {
        id: sibling.id,
        ids,
        drawable: painted.length > 0,
        index: Math.min(...(painted.length ? painted : [sibling]).map((l) => c.layers.indexOf(l))),
      };
    })
    .filter((block) => block.drawable || block.id === id)
    .sort((a, b) => a.index - b.index);
  const index = blocks.findIndex((b) => b.id === id),
    moving = blocks[index],
    neighbor = blocks[index + direction];
  if (!neighbor) return;
  const remaining = c.layers.filter((l) => !moving.ids.has(l.id));
  const neighbors = remaining.flatMap((l, i) => (neighbor.ids.has(l.id) ? [i] : []));
  const target = direction === 1 ? Math.max(...neighbors) + 1 : Math.min(...neighbors);
  remaining.splice(target, 0, ...c.layers.filter((l) => moving.ids.has(l.id)));
  return remaining.map((l) => l.id);
}
function composition(content: AnimationContent2, id: string) {
  const c = content.compositions.find((c) => c.id === id);
  check(c, 'missing-composition', id);
  return c;
}
function roots(c: Composition2, selected: readonly string[]) {
  check(selected.length > 0 && new Set(selected).size === selected.length, 'selection', 'layers');
  const selectedIds = new Set(selected);
  animationSubtree2(c, selected);
  return c.layers.filter((layer) => {
    if (!selectedIds.has(layer.id)) return false;
    let parent = layer.parentId;
    while (parent) {
      if (selectedIds.has(parent)) return false;
      parent = c.layers.find((l) => l.id === parent)!.parentId;
    }
    return true;
  });
}
export function inspectAnimationSelection2(
  input: unknown,
  compositionId: string,
  selected: readonly string[],
) {
  const content = readAnimation2(input),
    c = composition(content, compositionId),
    selectedRoots = roots(c, selected),
    ids = animationSubtree2(
      c,
      selectedRoots.map((l) => l.id),
    );
  return {
    roots: selectedRoots.map((l) => l.id),
    layers: c.layers.filter((l) => ids.has(l.id)).map((l) => l.id),
    tracks: c.tracks.filter((t) => ids.has(t.layerId)).map((t) => t.id),
    keys: c.tracks.filter((t) => ids.has(t.layerId)).flatMap((t) => t.keys.map((k) => k.id)),
    inputs: content.publicInputs
      .filter((i) => i.target.compositionId === c.id && ids.has(i.target.layerId))
      .map((i) => i.id),
  };
}
export function duplicateAnimationSelection2(
  expected: unknown,
  compositionId: string,
  selected: readonly string[],
  mapping: readonly { sourceId: string; id: string }[],
  scope: Scope,
) {
  const content = readAnimation2(expected),
    c = composition(content, compositionId),
    plan = inspectAnimationSelection2(content, c.id, selected),
    all = [...plan.layers, ...plan.tracks, ...plan.keys, ...plan.inputs];
  const owned = ownJson(mapping) as { sourceId: string; id: string }[];
  check(Array.isArray(owned) && owned.length === all.length, 'id-map', 'duplicate');
  const ids = new Map(owned.map((e) => [e.sourceId, e.id]));
  check(ids.size === all.length && all.every((id) => ids.has(id)), 'id-map', 'duplicate');
  const layers = new Set(plan.layers),
    rootIds = new Set(plan.roots);
  c.layers.push(
    ...c.layers
      .filter((l) => layers.has(l.id))
      .map((l) => ({
        ...l,
        id: ids.get(l.id)!,
        parentId: rootIds.has(l.id) ? l.parentId : l.parentId ? ids.get(l.parentId)! : null,
        clipId: l.clipId ? (ids.get(l.clipId) ?? l.clipId) : null,
      })),
  );
  c.tracks.push(
    ...c.tracks
      .filter((t) => layers.has(t.layerId))
      .map((t) => ({
        ...t,
        id: ids.get(t.id)!,
        layerId: ids.get(t.layerId)!,
        keys: t.keys.map((k) => ({ ...k, id: ids.get(k.id)! })),
      })),
  );
  content.publicInputs.push(
    ...content.publicInputs
      .filter((i) => plan.inputs.includes(i.id))
      .map((i) => ({
        ...i,
        id: ids.get(i.id)!,
        target: { ...i.target, layerId: ids.get(i.target.layerId)! },
      })),
  );
  return animationCommand2(
    expected,
    [
      {
        type: 'structure.replace',
        compositions: content.compositions,
        publicInputs: content.publicInputs,
      },
    ],
    scope,
    'Duplicate Animation layers',
  );
}

export function groupAnimationLayers2(
  expected: unknown,
  compositionId: string,
  selected: readonly string[],
  id: string,
  scope: Scope,
) {
  const content = readAnimation2(expected),
    c = composition(content, compositionId),
    selection = roots(c, selected);
  check(
    selection.length > 0 && selection.every((l) => l.parentId === selection[0].parentId),
    'group-parent',
    'selection',
  );
  const group: Layer2 = {
    id,
    name: 'Group',
    type: 'group',
    parentId: selection[0].parentId,
    start: 0,
    end: c.duration,
    transform: identityTransform(),
    visible: true,
    locked: false,
    clipId: null,
    maskOnly: false,
    motion: null,
  };
  const selectedIds = new Set(selection.map((l) => l.id));
  c.layers = c.layers.map((l) => (selectedIds.has(l.id) ? { ...l, parentId: id } : l));
  c.layers.push(group);
  return animationCommand2(
    expected,
    [
      {
        type: 'structure.replace',
        compositions: content.compositions,
        publicInputs: content.publicInputs,
      },
    ],
    scope,
    'Group Animation layers',
  );
}
export function nestAnimationLayers2(
  expected: unknown,
  compositionId: string,
  selected: readonly string[],
  ids: { compositionId: string; layerId: string },
  scope: Scope,
) {
  const content = readAnimation2(expected),
    c = composition(content, compositionId),
    selection = roots(c, selected),
    included = animationSubtree2(
      c,
      selection.map((l) => l.id),
    );
  check(
    selection.every((l) => l.parentId === selection[0].parentId),
    'nest-parent',
    'selection',
  );
  const selectedRoots = new Set(selection.map((l) => l.id)),
    positions = c.layers.flatMap((l, i) => (included.has(l.id) ? [i] : [])),
    first = Math.min(...positions),
    last = Math.max(...positions);
  check(
    c.layers.slice(first, last + 1).every((l) => included.has(l.id) || l.type === 'group'),
    'nest-paint-order',
    'selection',
  );
  for (const l of c.layers)
    if (l.clipId) check(included.has(l.id) === included.has(l.clipId), 'nest-cross-clip', l.id);
  const child: Composition2 = {
    ...c,
    id: ids.compositionId,
    name: 'Nested',
    layers: c.layers
      .filter((l) => included.has(l.id))
      .map((l) => ({ ...l, parentId: selectedRoots.has(l.id) ? null : l.parentId })),
    tracks: c.tracks.filter((t) => included.has(t.layerId)),
  };
  const nested: Layer2 = {
    id: ids.layerId,
    name: 'Nested',
    type: 'composition',
    parentId: selection[0].parentId,
    start: 0,
    end: c.duration,
    transform: identityTransform(),
    visible: true,
    locked: false,
    clipId: null,
    maskOnly: false,
    motion: null,
    source: { type: 'local', compositionId: child.id },
    time: {
      sourceIn: 0,
      sourceOut: c.duration,
      rate: { numerator: 1, denominator: 1 },
      after: 'hold',
    },
  };
  c.layers = c.layers.flatMap((l, i) => (i === first ? [nested] : included.has(l.id) ? [] : [l]));
  c.tracks = c.tracks.filter((t) => !included.has(t.layerId));
  content.compositions.push(child);
  content.publicInputs = content.publicInputs.map((i) =>
    i.target.compositionId === c.id && included.has(i.target.layerId)
      ? { ...i, target: { ...i.target, compositionId: child.id } }
      : i,
  );
  return animationCommand2(
    expected,
    [
      {
        type: 'structure.replace',
        compositions: content.compositions,
        publicInputs: content.publicInputs,
      },
    ],
    scope,
    'Nest Animation layers',
  );
}
export function unnestAnimationLayer2(
  expected: unknown,
  compositionId: string,
  layerId: string,
  scope: Scope,
) {
  const content = readAnimation2(expected),
    c = composition(content, compositionId),
    layer = c.layers.find((l) => l.id === layerId);
  check(layer?.type === 'composition' && layer.source.type === 'local', 'unnest-local', layerId);
  const childId = layer.source.compositionId,
    child = composition(content, childId);
  check(
    layer.start === 0 &&
      layer.end === c.duration &&
      layer.visible &&
      !layer.clipId &&
      !layer.motion &&
      !layer.maskOnly &&
      canonicalJson(layer.transform) === canonicalJson(identityTransform()) &&
      layer.time.sourceIn === 0 &&
      layer.time.sourceOut === child.duration &&
      layer.time.rate.numerator === layer.time.rate.denominator &&
      layer.time.after === 'hold' &&
      child.duration === c.duration,
    'unnest-transformed',
    'Reset placement/time before unnesting',
  );
  check(!c.tracks.some((t) => t.layerId === layer.id), 'unnest-tracks', layerId);
  check(
    content.compositions
      .flatMap((n) => n.layers)
      .filter(
        (l) =>
          l.type === 'composition' &&
          l.source.type === 'local' &&
          l.source.compositionId === childId,
      ).length === 1 && content.rootCompositionId !== childId,
    'unnest-shared-source',
    childId,
  );
  c.layers = c.layers.flatMap((l) =>
    l.id === layer.id
      ? child.layers.map((l) => ({ ...l, parentId: l.parentId ?? layer.parentId }))
      : [l],
  );
  c.tracks.push(...child.tracks);
  content.compositions = content.compositions.filter((n) => n !== child);
  content.publicInputs = content.publicInputs.map((i) =>
    i.target.compositionId === child.id
      ? { ...i, target: { ...i.target, compositionId: c.id } }
      : i,
  );
  return animationCommand2(
    expected,
    [
      {
        type: 'structure.replace',
        compositions: content.compositions,
        publicInputs: content.publicInputs,
      },
    ],
    scope,
    'Unnest Animation layers',
  );
}
