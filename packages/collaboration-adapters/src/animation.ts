import { canonicalEqual, canonicalJson, clone } from '@editor-platform/artifact-core';
import {
  readAnimation2,
  readFrozenAnimation2,
  assertAnimationProtected2,
  type AnimationContent2,
} from '@editor-platform/animation-core/v2';
import {
  fail,
  type Action,
  type DomainCodec,
  type Effect,
} from '@editor-platform/collaboration-core';
import {
  applyCanvasSteps,
  canvasEngineDocument,
  mapCanvasTextAnchor,
  rebaseCanvasTextInverse,
} from './canvas-text';
import { animationAuthorizationTargets } from './animation-targets';

type Record2 = Record<string, unknown>;
type Change = { path: string[]; value: unknown };
const roots = ['rootCompositionId', 'assets', 'publicInputs', 'sources', 'provenance'];
const compFields = ['name', 'width', 'height', 'duration', 'frameRate'];
const layerFields = [
  'name',
  'parentId',
  'start',
  'end',
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
  'source',
  'time',
];
const transforms = ['x', 'y', 'anchorX', 'anchorY', 'scaleX', 'scaleY', 'rotation', 'opacity'];
const equal = (a: unknown, b: unknown) => canonicalEqual(a ?? null, b ?? null);
const address = (path: string[]) => `animation:${canonicalJson(path)}`;
function validPath(p: string[]): boolean {
  if (!p.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 128)) return false;
  if (p.length === 1) return roots.includes(p[0]) || p[0] === '$order';
  if (p[0] !== 'compositions') return false;
  if (p.length === 2) return true;
  if (p.length === 3)
    return [...compFields, '$exists', '$order:layers', '$order:tracks'].includes(p[2]);
  if (!['layers', 'tracks'].includes(p[2])) return false;
  if (p.length === 4) return true;
  if (p[2] === 'layers')
    return (
      (p.length === 5 && [...layerFields, '$exists'].includes(p[4])) ||
      (p.length === 6 && p[4] === 'transform' && transforms.includes(p[5]))
    );
  if (p.length === 5) return ['layerId', 'property', '$exists', '$order:keys'].includes(p[4]);
  if (p[4] !== 'keys') return false;
  return (
    p.length === 6 || (p.length === 7 && ['tick', 'value', 'easing', '$exists'].includes(p[6]))
  );
}
function parse(key: string): string[] {
  if (!key.startsWith('animation:')) fail('schema-mismatch', 'Unknown Animation resource');
  let path: unknown;
  try {
    path = JSON.parse(key.slice(10));
  } catch {
    fail('schema-mismatch', 'Malformed Animation resource');
  }
  if (!Array.isArray(path) || !validPath(path)) fail('schema-mismatch', 'Unknown Animation path');
  return path;
}
function locate(
  content: AnimationContent2,
  p: string[],
): { list?: Record2[]; object?: Record2; field?: string; id?: string } {
  let object = content as unknown as Record2;
  for (let i = 0; i < p.length; ) {
    const name = p[i];
    if (name === '$order' || name.startsWith('$order:'))
      return { list: object[name === '$order' ? 'compositions' : name.slice(7)] as Record2[] };
    if (['compositions', 'layers', 'tracks', 'keys'].includes(name)) {
      const list = object[name] as Record2[] | undefined,
        id = p[i + 1];
      if (i + 2 === p.length) return { list, id };
      const child = list?.find((e) => e.id === id);
      if (!child) return {};
      object = child;
      i += 2;
    } else if (name === 'transform') {
      object = object.transform as Record2;
      i++;
    } else return { object, field: name };
  }
  return {};
}
function resource(content: AnimationContent2, p: string[]): unknown {
  if (p.at(-1) === '$exists') return resource(content, p.slice(0, -1)) !== null;
  const { list, id, object, field } = locate(content, p);
  if (list) return id ? (list.find((e) => e.id === id) ?? null) : list.map((e) => e.id);
  return object && field ? (object[field] ?? null) : null;
}
function write(content: AnimationContent2, change: Change) {
  const { list, id, object, field } = locate(content, change.path);
  if (list) {
    if (id) {
      const index = list.findIndex((e) => e.id === id);
      if (change.value === null) {
        if (index < 0) fail('target-deleted', 'Animation entity missing');
        list.splice(index, 1);
      } else {
        if (index >= 0) fail('unsupported-operation', 'Existing entities require field edits');
        if (
          !change.value ||
          typeof change.value !== 'object' ||
          (change.value as Record2).id !== id
        )
          fail('schema-mismatch', 'Animation entity ID must match its addressed identity');
        list.push(clone(change.value) as Record2);
      }
    } else {
      const order = change.value;
      if (
        !Array.isArray(order) ||
        order.length !== list.length ||
        new Set(order).size !== order.length ||
        order.some((id) => !list.some((e) => e.id === id))
      )
        fail('invalid-operation', 'Animation order must be a permutation');
      const next = order.map((id) => list.find((e) => e.id === id)!);
      list.splice(0, list.length, ...next);
    }
  } else if (object && field) object[field] = clone(change.value);
  else fail('target-deleted', 'Animation owner missing');
}
function differences(before: AnimationContent2, after: AnimationContent2): Change[] {
  // One keyed pass over both trees. Paths and their order match `resource()` reads.
  const changes: Change[] = [];
  const compare = (path: string[], a: unknown, b: unknown) => {
    if (equal(a, b)) return;
    changes.push({ path, value: clone(b ?? null) });
  };
  const ids = (list: Record2[]) => list.map((e) => e.id);
  const collection = (
    old: Record2[],
    next: Record2[],
    path: string[],
    fields: string[],
    children?: 'layers' | 'tracks' | 'keys',
  ) => {
    const olds = new Map(old.map((e) => [e.id as string, e])),
      nexts = new Map(next.map((e) => [e.id as string, e]));
    for (const id of new Set([...olds.keys(), ...nexts.keys()])) {
      const a = olds.get(id),
        b = nexts.get(id),
        p = [...path, id];
      if (!a || !b) {
        compare(p, a ?? null, b ?? null);
        continue;
      }
      for (const field of fields) compare([...p, field], a[field] ?? null, b[field] ?? null);
      if (path.at(-1) === 'layers') {
        const ta = a.transform as Record2,
          tb = b.transform as Record2;
        for (const field of transforms)
          compare([...p, 'transform', field], ta?.[field] ?? null, tb?.[field] ?? null);
      }
      if (children === 'layers') {
        collection(a.layers as Record2[], b.layers as Record2[], [...p, 'layers'], layerFields);
        collection(
          a.tracks as Record2[],
          b.tracks as Record2[],
          [...p, 'tracks'],
          ['layerId', 'property'],
          'keys',
        );
        compare([...p, '$order:layers'], ids(a.layers as Record2[]), ids(b.layers as Record2[]));
        compare([...p, '$order:tracks'], ids(a.tracks as Record2[]), ids(b.tracks as Record2[]));
      } else if (children === 'keys') {
        collection(
          a.keys as Record2[],
          b.keys as Record2[],
          [...p, 'keys'],
          ['tick', 'value', 'easing'],
        );
        compare([...p, '$order:keys'], ids(a.keys as Record2[]), ids(b.keys as Record2[]));
      }
    }
  };
  const rootsBefore = before as unknown as Record2,
    rootsAfter = after as unknown as Record2;
  for (const field of roots)
    compare([field], rootsBefore[field] ?? null, rootsAfter[field] ?? null);
  const compositionsBefore = before.compositions as unknown as Record2[],
    compositionsAfter = after.compositions as unknown as Record2[];
  collection(compositionsBefore, compositionsAfter, ['compositions'], compFields, 'layers');
  compare(['$order'], ids(compositionsBefore), ids(compositionsAfter));
  return changes;
}
export function animationPatchAction(
  before: AnimationContent2,
  after: AnimationContent2,
): Action | undefined {
  const changes = differences(before, readFrozenAnimation2(after));
  return changes.length
    ? { type: 'animation.patch', target: '*', payload: { changes } }
    : undefined;
}
/** Pure codec apply. The returned content is deep-frozen; copy it with
 * readAnimation2 before mutating it. */
function apply(
  content: AnimationContent2,
  action: Action,
  version: number,
  textVersions?: Record<string, number>,
): Effect<AnimationContent2> {
  const next = readAnimation2(content);
  if (action.type === 'canvas.text-steps') {
    const c = next.compositions.find((c) => c.layers.some((l) => l.id === action.target));
    if (!c) fail('target-deleted', 'Animation text missing');
    const effect = applyCanvasSteps(animationEditorCodec, next, action, textVersions);
    effect.content = readFrozenAnimation2(effect.content);
    assertAnimationProtected2(content, effect.content);
    const layerPath = ['compositions', c.id, 'layers', action.target],
      textPaths = ['text', 'runs'].map((field) => [...layerPath, field]);
    effect.targets = animationAuthorizationTargets(content, effect.content, textPaths);
    effect.invalidates = [address(layerPath), ...textPaths.map(address)];
    return effect;
  }
  if (action.type !== 'animation.patch')
    fail('unsupported-operation', 'Animation requires native domain or text preparation');
  const changes = action.payload.changes as Change[];
  if (
    Object.keys(action.payload).join(',') !== 'changes' ||
    !Array.isArray(changes) ||
    !changes.length ||
    changes.length > 10000
  )
    fail('schema-mismatch', 'Invalid Animation patch');
  const required = new Set<string>(),
    touched = new Set<string>(),
    invalidates = new Set<string>(),
    inverse: Change[] = [],
    seen = new Set<string>();
  for (const change of changes) {
    if (
      !change ||
      Object.keys(change).sort().join(',') !== 'path,value' ||
      !Array.isArray(change.path) ||
      !validPath(change.path) ||
      change.path.at(-1) === '$exists'
    )
      fail('schema-mismatch', 'Invalid Animation change');
    const p = change.path,
      key = address(p);
    if (
      p[0] === 'compositions' &&
      (p.length === 2 ||
        p.length === 4 ||
        (p.length === 6 && p[2] === 'tracks' && p[4] === 'keys')) &&
      change.value !== null &&
      resource(content, p) !== null
    )
      fail(
        'unsupported-operation',
        'Existing Animation entities require field changes; shared text requires native engine steps',
      );
    if (seen.has(key)) fail('schema-mismatch', 'Duplicate Animation change');
    seen.add(key);
    required.add(key);
    touched.add(key);
    inverse.unshift({ path: p, value: clone(resource(content, p)) });
    for (let length = 2; length < p.length; length += 2)
      if (['compositions', 'layers', 'tracks', 'keys'].includes(p[length - 2])) {
        required.add(address([...p.slice(0, length), '$exists']));
        invalidates.add(address(p.slice(0, length)));
      }
    if (p[0] === 'compositions') {
      const c = content.compositions.find((c) => c.id === p[1]);
      let layer =
        p[2] === 'layers'
          ? c?.layers.find((l) => l.id === p[3])
          : c?.layers.find((l) => l.id === c.tracks.find((t) => t.id === p[3])?.layerId);
      if (p[2] === 'tracks') {
        for (const field of ['layerId', 'property'])
          required.add(address(['compositions', p[1], 'tracks', p[3], field]));
        if (!layer && p.length === 4 && change.value && typeof change.value === 'object')
          layer = c?.layers.find((l) => l.id === (change.value as Record2).layerId);
      }
      if (p[2] === 'layers' && p.length === 5 && ['text', 'runs'].includes(p[4]))
        fail('unsupported-operation', 'Shared text requires native engine steps');
      required.add(address(['compositions', p[1], 'duration']));
      while (layer) {
        for (const f of ['locked', 'parentId'])
          required.add(address(['compositions', p[1], 'layers', layer.id, f]));
        if (p.length > 5 || p.at(-1) === 'parentId')
          for (const field of transforms)
            required.add(address(['compositions', p[1], 'layers', layer.id, 'transform', field]));
        layer = c?.layers.find((l) => l.id === layer!.parentId);
      }
    }
    if (!p.at(-1)!.startsWith('$order')) write(next, change);
  }
  for (const change of changes) if (change.path.at(-1)!.startsWith('$order')) write(next, change);
  const result = readFrozenAnimation2(next);
  const resultingTracks = new Map(
    result.compositions.map((c) => [c.id, new Map(c.tracks.map((t) => [t.id, t] as const))]),
  );
  for (const c of content.compositions)
    for (const track of c.tracks) {
      const current = resultingTracks.get(c.id)?.get(track.id);
      if (current && (current.layerId !== track.layerId || current.property !== track.property))
        fail('invalid-operation', 'An existing Animation track target is immutable');
    }
  const resultingLayers = new Map(
    result.compositions.flatMap((c) => c.layers.map((layer) => [layer.id, layer] as const)),
  );
  for (const layer of content.compositions.flatMap((c) => c.layers)) {
    const current = resultingLayers.get(layer.id);
    if (
      current &&
      (current.type !== layer.type ||
        (layer.type === 'text' &&
          current.type === 'text' &&
          (current.text !== layer.text || !equal(current.runs, layer.runs))))
    )
      fail(
        'unsupported-operation',
        'Existing Animation identities keep their type; shared text requires native engine steps',
      );
  }
  assertAnimationProtected2(content, result);
  return {
    content: result,
    required: [...required],
    touched: [...touched],
    invalidates: [...invalidates],
    targets: animationAuthorizationTargets(
      content,
      result,
      changes.map((change) => change.path),
    ),
    inverse: [{ type: 'animation.patch', target: '*', payload: { changes: inverse } }],
  };
}
export const animationEditorCodec: DomainCodec<AnimationContent2> = {
  domain: 'animation',
  validate(value): value is AnimationContent2 {
    try {
      readFrozenAnimation2(value);
      return true;
    } catch {
      return false;
    }
  },
  resource(content, key) {
    if (key.startsWith('entity:layers@')) {
      const match = /^entity:layers@([^:]+):([^/]+)\/(id|text|runs)$/.exec(key);
      if (!match) fail('schema-mismatch', 'Unknown Animation text resource');
      return (
        content.compositions
          .find((c) => c.id === decodeURIComponent(match[1]))
          ?.layers.find((l) => l.id === decodeURIComponent(match[2]))?.[match[3] as 'id'] ?? null
      );
    }
    return resource(content, parse(key));
  },
  apply,
  applyReadonly: apply,
  rebaseInverse: (event, later, current) =>
    rebaseCanvasTextInverse(animationEditorCodec, event, later, current),
  validateAnchor(content, anchor) {
    if (anchor.type === 'element')
      return content.compositions.some((c) => c.layers.some((l) => l.id === anchor.elementId));
    if (anchor.type !== 'canvas-text') return false;
    try {
      const doc = canvasEngineDocument(animationEditorCodec, content, anchor.elementId);
      return anchor.from >= 0 && anchor.to >= anchor.from && anchor.to <= doc.content.size;
    } catch {
      return false;
    }
  },
  mapAnchor(anchor, before, action, after) {
    if (
      action.type === 'animation.patch' &&
      (anchor.type === 'element' || anchor.type === 'canvas-text')
    ) {
      // Nest/Unnest relocate stable IDs. Only the completed patch can establish deletion.
      const completed = after ?? apply(before, action, 0).content;
      return animationEditorCodec.validateAnchor(completed, anchor)
        ? anchor
        : { ...anchor, orphan: true };
    }
    return mapCanvasTextAnchor(animationEditorCodec, anchor, before, action);
  },
};
