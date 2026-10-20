import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { EditorSession } from '@editor-platform/editor-core';
import { reuseHash } from '@editor-platform/reuse-core';
import { createAnimation2 } from './validate';
import { animationCommand2, createAnimationLayer2 } from './commands';
import {
  animationLayerPaintOrder2,
  nestAnimationLayers2,
  unnestAnimationLayer2,
} from './structure';
import { evaluateAnimation2, prepareAnimation2, pointOnAnimationPath2 } from './evaluate';
import {
  createPlayableAnimationEmbed,
  createPreparedAnimationEmbed2,
  inspectPlayableAnimationEmbed,
  type AnimationEmbed2,
} from './embedding';
import { insertExactAnimation, adoptExactAnimation } from './references';
import { encodeAnimationBase64, hashAnimationBytes2 } from './assets';

it('rejects an embed root version that conflicts with its retained closure without rewriting either source', () => {
  const retained = createAnimation2(),
    root = createAnimation2(),
    nestedRef = {
      artifactId: 'A',
      versionId: 'V',
      contentHash: reuseHash(retained),
      compositionId: 'root',
    };
  root.sources.push({ ref: nestedRef, content: retained });
  const prepared = prepareAnimation2(root),
    ref = { ...nestedRef, contentHash: prepared.contentHash },
    before = JSON.stringify(root);
  expect(() => createPlayableAnimationEmbed(ref, root, 'Conflicting root')).toThrow(
    'version-conflict',
  );
  expect(() => createPreparedAnimationEmbed2(ref, prepared, 'Conflicting prepared root')).toThrow(
    'version-conflict',
  );
  const valid = createPreparedAnimationEmbed2(
    { ...ref, artifactId: 'B' },
    prepared,
    'Different version',
  );
  expect(() => inspectPlayableAnimationEmbed({ ...valid, source: ref })).toThrow(
    'version-conflict',
  );
  expect(JSON.stringify(root)).toBe(before);
});
it('refuses appended artwork above a protected layer while permitting an atomic background insertion', () => {
  const content = createAnimation2(),
    c = content.compositions[0],
    locked = createAnimationLayer2('rect', 'protected', c.duration),
    inserted = createAnimationLayer2('rect', 'new', c.duration);
  locked.locked = true;
  c.layers = [locked];
  if (inserted.type !== 'rect') throw Error('Expected rectangle fixture');
  inserted.width = c.width;
  inserted.height = c.height;
  expect(() =>
    animationCommand2(content, [{ type: 'layer.insert', compositionId: c.id, layer: inserted }], {
      canEdit: () => true,
    }),
  ).toThrow('locked');
  const next = animationCommand2(
    content,
    [
      {
        type: 'structure.replace',
        compositions: [{ ...c, layers: [inserted, locked] }],
        publicInputs: [],
      },
    ],
    { canEdit: () => true },
  ).apply(content);
  expect(next.compositions[0].layers.map((l) => l.id)).toEqual(['new', 'protected']);
  expect(next.compositions[0].layers[1]).toEqual(locked);
});

it('creates shared prepared embeds while enforcing source identity, fields and token ownership', () => {
  const content = createAnimation2(),
    prepared = prepareAnimation2(content),
    source = {
      artifactId: 'saved',
      versionId: 'v1',
      contentHash: prepared.contentHash,
      compositionId: 'root',
    };
  const first = createPreparedAnimationEmbed2(source, prepared, 'First'),
    second = createPreparedAnimationEmbed2(source, prepared, 'Second');
  expect(first.snapshot).toBe(second.snapshot);
  expect(inspectPlayableAnimationEmbed(first)).toMatchObject({ kind: 'scene2', prepared });
  expect(inspectPlayableAnimationEmbed(first).prepared).toBe(prepared);
  expect(first).toEqual(createPlayableAnimationEmbed(source, content, 'First'));
  expect(() =>
    createPreparedAnimationEmbed2(
      { ...source, contentHash: '0'.repeat(64) },
      prepared,
      'Wrong hash',
    ),
  ).toThrow('animation-source-hash-mismatch');
  expect(() =>
    createPreparedAnimationEmbed2({ ...source, compositionId: 'missing' }, prepared, 'Missing'),
  ).toThrow('animation-poster-tick');
  expect(() => createPreparedAnimationEmbed2(source, prepared, 'x'.repeat(201))).toThrow(
    'animation-label',
  );
  expect(() => createPreparedAnimationEmbed2(source, { ...prepared }, 'Forged')).toThrow(
    'unprepared',
  );
  content.compositions[0].name = 'Caller mutation';
  expect(first.snapshot.compositions[0].name).not.toBe('Caller mutation');
});

it('moves nested paint blocks while preserving siblings, native Undo and protected-order rejection', () => {
  const content = createAnimation2(),
    c = content.compositions[0];
  const layer = (type: 'group' | 'rect', id: string, parentId: string | null = null) => ({
    ...createAnimationLayer2(type, id, c.duration),
    parentId,
  });
  c.layers = [
    layer('rect', 'a', 'g'),
    layer('group', 'h'),
    layer('rect', 'd', 'h'),
    layer('group', 'g'),
    layer('group', 'nested', 'g'),
    layer('rect', 'c', 'nested'),
    layer('rect', 'b', 'g'),
    layer('rect', 'e', 'h'),
    layer('rect', 'outside'),
  ];
  const ids = animationLayerPaintOrder2(c, 'g', 1)!,
    session = new EditorSession(content);
  session.execute(
    animationCommand2(content, [{ type: 'layer.reorder', compositionId: c.id, ids }], {
      canEdit: () => true,
    }),
  );
  expect(
    evaluateAnimation2(prepareAnimation2(session.content), c.id, 0).items.map((i) => i.id),
  ).toEqual(['d', 'e', 'a', 'c', 'b', 'outside']);
  session.undo();
  expect(session.content).toEqual(content);
  const locked = structuredClone(content);
  locked.compositions[0].layers.find((l) => l.id === 'd')!.locked = true;
  expect(() =>
    animationCommand2(locked, [{ type: 'layer.reorder', compositionId: c.id, ids }], {
      canEdit: () => true,
    }),
  ).toThrow('locked');
  expect(locked.compositions[0].layers.map((l) => l.id)).toEqual(c.layers.map((l) => l.id));
});
it('uses drawable descendants rather than mask-only records to locate a group paint block', () => {
  const content = createAnimation2(),
    c = content.compositions[0];
  const mask = createAnimationLayer2('rect', 'mask', c.duration),
    group = createAnimationLayer2('group', 'group', c.duration),
    child = createAnimationLayer2('rect', 'child', c.duration);
  mask.maskOnly = true;
  mask.parentId = child.parentId = group.id;
  const siblingMask = createAnimationLayer2('rect', 'sibling-mask', c.duration);
  siblingMask.maskOnly = true;
  c.layers = [
    mask,
    createAnimationLayer2('rect', 'behind', c.duration),
    group,
    child,
    siblingMask,
    createAnimationLayer2('rect', 'front', c.duration),
  ];
  const order = animationLayerPaintOrder2(c, group.id, 1)!;
  const next = animationCommand2(
    content,
    [{ type: 'layer.reorder', compositionId: c.id, ids: order }],
    { canEdit: () => true },
  ).apply(content);
  expect(evaluateAnimation2(prepareAnimation2(next), c.id, 0).items.map((i) => i.id)).toEqual([
    'behind',
    'front',
    'child',
  ]);
});

it('reuses nested exact providers for direct insertion and adoption without duplicating bytes', () => {
  const bytes = new Uint8Array(1536 * 1024);
  bytes.set(readFileSync('tests/fixtures/office/images/quadrants.png'));
  const child = createAnimation2();
  child.assets = [
    {
      id: 'picture',
      contentHash: hashAnimationBytes2(bytes),
      mediaType: 'image/png',
      base64: encodeAnimationBase64(bytes),
      attribution: 'Fixture',
      license: 'Notice',
    },
  ];
  child.compositions[0].layers = [
    {
      ...createAnimationLayer2('group', 'image', 960000),
      type: 'image',
      width: 100,
      height: 100,
      assetId: 'picture',
    },
  ];
  const embed = createPlayableAnimationEmbed(
    { artifactId: 'B', versionId: 'v1', compositionId: 'root', contentHash: reuseHash(child) },
    child,
    'B',
  );
  if (embed.format !== 'animation-embed-2') throw Error();
  const parent = insertExactAnimation(createAnimation2(), 'root', embed, 'nested', {
    canEdit: () => true,
  }).apply(createAnimation2());
  const parentBytes = bytes.slice();
  parentBytes[parentBytes.length - 1] = 7;
  parent.assets = [
    {
      ...child.assets[0],
      id: 'parent-picture',
      contentHash: hashAnimationBytes2(parentBytes),
      base64: encodeAnimationBase64(parentBytes),
    },
  ];
  parent.compositions[0].layers.push({
    ...createAnimationLayer2('group', 'parent-image', 960000),
    type: 'image',
    width: 100,
    height: 100,
    assetId: 'parent-picture',
  });
  const a = createPlayableAnimationEmbed(
    { artifactId: 'A', versionId: 'v1', compositionId: 'root', contentHash: reuseHash(parent) },
    parent,
    'A',
  );
  if (a.format !== 'animation-embed-2') throw Error();
  const owner = insertExactAnimation(createAnimation2(), 'root', a, 'outer', {
      canEdit: () => true,
    }).apply(createAnimation2()),
    session = new EditorSession(owner);
  const retained = JSON.stringify(owner.sources);
  session.execute(insertExactAnimation(owner, 'root', embed, 'direct', { canEdit: () => true }));
  expect(session.content.sources).toHaveLength(1);
  expect(JSON.stringify(session.content.sources)).toBe(retained);
  expect(evaluateAnimation2(prepareAnimation2(session.content), 'root', 0).items).toHaveLength(3);
  session.execute(
    adoptExactAnimation(session.content, 'root', 'outer', embed, { canEdit: () => true }),
  );
  expect(session.content.sources).toHaveLength(1);
  expect(JSON.stringify(session.content.sources)).toBe(retained);
  session.undo();
  session.undo();
  expect(session.content).toEqual(owner);
  expect(embed.snapshot).toEqual(child);
}, 30000);

it('reclaims only deleted images no longer referenced after the complete native action batch', () => {
  const content = createAnimation2(),
    c = content.compositions[0];
  const bytes = new Uint8Array(1536 * 1024);
  bytes.set(readFileSync('tests/fixtures/office/images/quadrants.png'));
  content.assets = [0, 1].map((i) => {
    const data = bytes.slice();
    data[data.length - 1] = i;
    return {
      id: `picture-${i}`,
      contentHash: hashAnimationBytes2(data),
      mediaType: 'image/png' as const,
      base64: encodeAnimationBase64(data),
      attribution: 'Fixture',
      license: 'Notice',
    };
  });
  const image = (id: string, assetId: string) => ({
    ...createAnimationLayer2('group', id, c.duration),
    type: 'image' as const,
    width: 100,
    height: 100,
    assetId,
  });
  c.layers = [image('image-0', 'picture-0'), image('image-1', 'picture-1')];
  const session = new EditorSession(content);
  session.execute(
    animationCommand2(
      session.content,
      [{ type: 'layer.remove', compositionId: c.id, id: 'image-0' }],
      { canEdit: () => true },
    ),
  );
  expect(session.content.assets.map((a) => a.id)).toEqual(['picture-1']);
  session.undo();
  expect(session.content).toEqual(content);
  session.redo();
  expect(session.content.assets.map((a) => a.id)).toEqual(['picture-1']);
  const kept = animationCommand2(
    content,
    [
      { type: 'layer.remove', compositionId: c.id, id: 'image-0' },
      { type: 'layer.insert', compositionId: c.id, layer: image('replacement', 'picture-0') },
    ],
    { canEdit: () => true },
  ).apply(content);
  expect(kept.assets).toEqual(content.assets);
  const shared = structuredClone(content);
  shared.compositions.push({
    ...structuredClone(c),
    id: 'other',
    layers: [image('other-image', 'picture-0')],
  });
  const next = animationCommand2(
    shared,
    [{ type: 'layer.remove', compositionId: c.id, id: 'image-0' }],
    { canEdit: () => true },
  ).apply(shared);
  expect(next.assets).toEqual(shared.assets);
  session.execute(
    animationCommand2(
      session.content,
      [{ type: 'layer.remove', compositionId: c.id, id: 'image-1' }],
      { canEdit: () => true },
    ),
  );
  expect(session.content.assets).toEqual([]);
  const third = { ...content.assets[0], id: 'picture-2' };
  const restored = animationCommand2(
    session.content,
    [
      { type: 'content.set', field: 'assets', value: [third] },
      { type: 'layer.insert', compositionId: c.id, layer: image('image-2', third.id) },
    ],
    { canEdit: () => true },
  ).apply(session.content);
  expect(restored.assets).toEqual([third]);
}, 30000);

it.each(['loop', 'hide'] as const)(
  'refuses unnest with %s terminal mapping without changing history',
  (after) => {
    const content = createAnimation2();
    content.compositions[0].layers = [createAnimationLayer2('rect', 'box', 960000)];
    const nested = nestAnimationLayers2(
      content,
      'root',
      ['box'],
      { compositionId: 'child', layerId: 'instance' },
      { canEdit: () => true },
    ).apply(content);
    const layer = nested.compositions[0].layers[0];
    if (layer.type !== 'composition') throw Error();
    layer.time.after = after;
    const session = new EditorSession(nested);
    expect(() =>
      session.execute(unnestAnimationLayer2(nested, 'root', 'instance', { canEdit: () => true })),
    ).toThrow('unnest');
    expect(session.content).toEqual(nested);
    expect(session.canUndo).toBe(false);
    layer.time.after = 'hold';
    const next = unnestAnimationLayer2(nested, 'root', 'instance', { canEdit: () => true }).apply(
      nested,
    );
    const pose = (source: typeof next) =>
      evaluateAnimation2(prepareAnimation2(source), 'root', 960000).items.map((item) => [
        item.matrix,
        item.opacity,
      ]);
    expect(pose(next)).toEqual(pose(nested));
  },
);

it.each([
  {
    path: [
      ['M', 0, 0],
      ['Q', 100, 100, 100, 100],
    ],
  },
  {
    path: [
      ['M', 0, 0],
      ['C', 20, 40, 100, 100, 100, 100],
    ],
  },
] as const)('preserves the limiting Bezier endpoint tangent', ({ path }) => {
  const owned = structuredClone(path) as unknown as Parameters<typeof pointOnAnimationPath2>[0];
  expect(pointOnAnimationPath2(owned, 1).rotation).toBeCloseTo(
    pointOnAnimationPath2(owned, 1 - 1e-7).rotation,
    4,
  );
});

it('prunes only unused exact versions before aggregate validation and preserves Undo and shared pins', () => {
  const bytes = new Uint8Array(1536 * 1024);
  bytes.set(readFileSync('tests/fixtures/office/images/quadrants.png'));
  const source = createAnimation2();
  source.assets = [
    {
      id: 'picture',
      contentHash: hashAnimationBytes2(bytes),
      mediaType: 'image/png',
      base64: encodeAnimationBase64(bytes),
      attribution: 'Fixture',
      license: 'Retained notice',
    },
  ];
  source.compositions[0].layers = [
    {
      ...createAnimationLayer2('group', 'image', 960000),
      type: 'image',
      width: 100,
      height: 100,
      assetId: 'picture',
    },
  ];
  const embed = (versionId: string) =>
    createPlayableAnimationEmbed(
      { artifactId: 'source', versionId, contentHash: reuseHash(source), compositionId: 'root' },
      source,
      versionId,
    ) as AnimationEmbed2;
  const session = new EditorSession(createAnimation2()),
    v1 = embed('v1'),
    v2 = embed('v2'),
    v3 = embed('v3');
  session.execute(
    insertExactAnimation(session.content, 'root', v1, 'first', { canEdit: () => true }),
  );
  session.execute(
    insertExactAnimation(session.content, 'root', v1, 'second', { canEdit: () => true }),
  );
  session.execute(
    adoptExactAnimation(session.content, 'root', 'first', v2, { canEdit: () => true }),
  );
  expect(session.content.sources.map((s) => s.ref.versionId)).toEqual(['v1', 'v2']);
  session.execute(
    adoptExactAnimation(session.content, 'root', 'second', v2, { canEdit: () => true }),
  );
  expect(session.content.sources.map((s) => s.ref.versionId)).toEqual(['v2']);
  session.execute(
    adoptExactAnimation(session.content, 'root', 'first', v3, { canEdit: () => true }),
  );
  expect(session.content.sources.map((s) => s.ref.versionId)).toEqual(['v2', 'v3']);
  session.undo();
  expect(session.content.sources.map((s) => s.ref.versionId)).toEqual(['v2']);
  const remove = (id: string) =>
    session.execute(
      animationCommand2(session.content, [{ type: 'layer.remove', compositionId: 'root', id }], {
        canEdit: () => true,
      }),
    );
  remove('first');
  expect(session.content.sources.map((s) => s.ref.versionId)).toEqual(['v2']);
  remove('second');
  expect(session.content.sources).toHaveLength(0);
  session.execute(
    insertExactAnimation(session.content, 'root', v3, 'replacement', { canEdit: () => true }),
  );
  expect(session.content.sources.map((s) => s.ref.versionId)).toEqual(['v3']);
  session.undo();
  session.undo();
  expect(session.content.sources.map((s) => s.ref.versionId)).toEqual(['v2']);
  expect(session.content.compositions[0].layers.map((l) => l.id)).toEqual(['second']);
  expect(v1.snapshot).toEqual(source);
}, 30000);
it('retains a nested provider for another exact layer and prunes only after the complete action batch', () => {
  const scope = { canEdit: () => true },
    leaf = createAnimation2();
  leaf.compositions[0].layers = [createAnimationLayer2('rect', 'leaf-box', 960000)];
  const embed = (content: typeof leaf, artifactId: string) =>
    createPlayableAnimationEmbed(
      { artifactId, versionId: 'v1', contentHash: reuseHash(content), compositionId: 'root' },
      content,
      artifactId,
    ) as AnimationEmbed2;
  const initial = createAnimation2(),
    middle = insertExactAnimation(
      initial,
      'root',
      embed(leaf, 'leaf'),
      'leaf-instance',
      scope,
    ).apply(initial);
  const owner = insertExactAnimation(
    initial,
    'root',
    embed(middle, 'middle'),
    'outer',
    scope,
  ).apply(initial);
  const direct = { ...structuredClone(middle.compositions[0].layers[0]), id: 'direct' };
  const both = animationCommand2(
    owner,
    [{ type: 'layer.insert', compositionId: 'root', layer: direct }],
    scope,
  ).apply(owner);
  const kept = animationCommand2(
    both,
    [{ type: 'layer.remove', compositionId: 'root', id: 'outer' }],
    scope,
  ).apply(both);
  expect(kept.sources).toEqual(owner.sources);
  expect(evaluateAnimation2(prepareAnimation2(kept), 'root', 0).items).toHaveLength(1);
  const batch = animationCommand2(
    kept,
    [
      { type: 'layer.remove', compositionId: 'root', id: 'direct' },
      { type: 'layer.insert', compositionId: 'root', layer: { ...direct, id: 'replacement' } },
    ],
    scope,
  ).apply(kept);
  expect(batch.sources).toEqual(owner.sources);
  const empty = animationCommand2(
    batch,
    [{ type: 'layer.remove', compositionId: 'root', id: 'replacement' }],
    scope,
  ).apply(batch);
  expect(empty.sources).toHaveLength(0);
  expect(owner.sources[0].content).toEqual(middle);
});

it('keeps end-aligned layers sequential across repeated duration actions and one native Undo', () => {
  const content = createAnimation2(),
    c = content.compositions[0];
  c.duration = 100;
  c.layers = [
    createAnimationLayer2('rect', 'aligned', 100),
    createAnimationLayer2('rect', 'trimmed', 60),
  ];
  const first = { type: 'composition.duration' as const, compositionId: c.id, duration: 200 };
  const second = { ...first, duration: 300 };
  const scope = { canEdit: () => true };
  const separate = animationCommand2(content, [first], scope).apply(content);
  const expected = animationCommand2(separate, [second], scope).apply(separate);
  const session = new EditorSession(content);
  session.execute(animationCommand2(content, [first, second], scope));
  expect(session.content).toEqual(expected);
  expect(session.content.compositions[0].layers.map((layer) => layer.end)).toEqual([300, 60]);
  session.undo();
  expect(session.content).toEqual(content);
});
