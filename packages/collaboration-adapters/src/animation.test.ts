import { expect, it } from 'vitest';
import { Transform } from 'prosemirror-transform';
import { canvasEngineDocument } from './canvas-text';
import {
  Authority,
  initial,
  localAdapter,
  FaultAdapter,
  operation,
  type Principal,
} from '@editor-platform/collaboration-core';
import {
  createAnimation2,
  createAnimationLayer2,
  animationCommand2,
  createPlayableAnimationEmbed,
  insertExactAnimation,
  type AnimationContent2,
  type AnimationAction2,
  encodeAnimationBase64,
  hashAnimationBytes2,
  nestAnimationLayers2,
  unnestAnimationLayer2,
} from '@editor-platform/animation-core/v2';
import { reuseHash } from '@editor-platform/reuse-core';
import { animationEditorCodec as codec } from './animation';
import { prepareEditorCommand } from './editor-transactions';
import { SharedEditorSession, type EditorHostAdapter } from './editor-session';
const A: Principal = { actorId: 'A', clientId: 'A', sessionId: 'A', writable: true, scopes: ['*'] };
const B: Principal = { ...A, actorId: 'B', clientId: 'B', sessionId: 'B' };
it.each([
  'fill',
  'size',
  'override',
  'old-override',
  'both-overrides',
  'font-add',
  'font-remove',
] as const)(
  'keeps native replacements consistent with local base styles in %s commands',
  (mode) => {
    const content = fixture(),
      c = content.compositions[0],
      original = c.layers.find((l) => l.id === 'text')!;
    if (original.type !== 'text') throw Error('Expected text fixture');
    original.runs = [
      {
        text: original.text,
        ...(mode === 'old-override' || mode === 'both-overrides'
          ? { style: { color: '#ff0000', fontSize: 42 } }
          : {}),
      },
    ];
    const bytes = new TextEncoder().encode('OTTO00000000'),
      font = {
        id: 'font',
        contentHash: hashAnimationBytes2(bytes),
        mediaType: 'font/otf' as const,
        base64: encodeAnimationBase64(bytes),
        attribution: 'Header fixture',
        license: 'Test',
      };
    if (mode === 'font-remove') {
      content.assets = [font];
      original.fontAssetId = font.id;
      original.text = '日本語';
      original.runs = [{ text: original.text }];
    }
    const text = mode === 'font-add' ? '日本語' : 'Changed',
      runs = [
        {
          text,
          ...(mode === 'override' || mode === 'both-overrides'
            ? { style: { color: original.fill, fontSize: original.fontSize } }
            : {}),
        },
      ];
    const patch = {
      text,
      runs,
      ...(mode !== 'size' ? { fill: '#ff0000' } : {}),
      ...(mode !== 'fill' ? { fontSize: 42 } : {}),
      ...(mode === 'override' || mode.startsWith('font-') ? { lineHeight: 1.7 } : {}),
      ...(mode === 'font-add'
        ? { fontAssetId: font.id }
        : mode === 'font-remove'
          ? { fontAssetId: null }
          : {}),
    };
    const actions: AnimationAction2[] = [];
    if (mode === 'font-add') actions.push({ type: 'content.set', field: 'assets', value: [font] });
    actions.push({ type: 'layer.patch', compositionId: c.id, id: 'text', patch });
    if (mode === 'font-remove') actions.push({ type: 'content.set', field: 'assets', value: [] });
    const command = animationCommand2(content, actions, { canEdit: () => true }),
      expected = command.apply(content),
      authority = new Authority(codec, initial('animation', codec, content)),
      op = prepareEditorCommand(codec, authority.snapshot(), A, command)!;
    expect(authority.commit(A, op).status).toBe('accepted');
    expect(authority.snapshot().content).toEqual(expected);
    const following = animationCommand2(
        expected,
        [
          {
            type: 'layer.patch',
            compositionId: c.id,
            id: 'text',
            patch: { fill: '#00ff00', fontSize: 56 },
          },
        ],
        { canEdit: () => true },
      ),
      future = new Authority(codec, initial('animation', codec, expected)),
      next = prepareEditorCommand(codec, future.snapshot(), B, following)!;
    expect(future.commit(B, next).status).toBe('accepted');
    expect(future.snapshot().content).toEqual(following.apply(expected));
    const peer = edit(authority, B, [
      { type: 'layer.patch', compositionId: c.id, id: 'box', patch: { transform: { y: 456 } } },
    ]);
    expect(authority.commit(B, peer).status).toBe('accepted');
    expect(authority.undo(A, op.operationId).status).toBe('accepted');
    expect(
      authority.snapshot().content.compositions[0].layers.find((l) => l.id === 'text'),
    ).toEqual(original);
    expect(authority.snapshot().content.assets).toEqual(content.assets);
    expect(
      authority.snapshot().content.compositions[0].layers.find((l) => l.id === 'box')!.transform.y,
    ).toBe(456);
  },
);

it('confirms a context-changing text command once and replays its native phases on both sessions', async () => {
  const content = fixture(),
    original = content.compositions[0].layers.find((l) => l.id === 'text')!;
  if (original.type !== 'text') throw Error('Expected text fixture');
  original.runs = [{ text: original.text, style: { color: '#ff0000', fontSize: 42 } }];
  const authority = new Authority(codec, initial('animation', codec, content));
  async function open(who: Principal) {
    const adapter = Object.assign(new FaultAdapter(localAdapter(authority, who)), {
        versions: async () => [],
        undo: async (id: string, redo?: boolean) => authority.undo(who, id, redo),
      }) as unknown as EditorHostAdapter<AnimationContent2>,
      session = new SharedEditorSession(codec, adapter);
    await session.open();
    session.text('text');
    return session;
  }
  const a = await open(A),
    b = await open(B);
  try {
    const command = animationCommand2(
      content,
      [
        {
          type: 'layer.patch',
          compositionId: 'root',
          id: 'text',
          patch: { text: 'Updated', runs: [{ text: 'Updated' }], fill: '#ff0000', fontSize: 42 },
        },
      ],
      { canEdit: () => true },
    );
    a.execute(command);
    await a.flush();
    await b.sync();
    expect(authority.snapshot().revision).toBe(1);
    expect(a.content).toEqual(command.apply(content));
    expect(b.content).toEqual(a.content);
    expect(b.text('text').state.doc.textContent).toBe('Updated');
    b.execute(
      animationCommand2(
        b.content,
        [
          {
            type: 'layer.patch',
            compositionId: 'root',
            id: 'box',
            patch: { transform: { y: 456 } },
          },
        ],
        { canEdit: () => true },
      ),
    );
    await b.flush();
    await a.sync();
    await a.history('undo');
    await b.sync();
    expect(b.content.compositions[0].layers.find((l) => l.id === 'text')).toEqual(original);
    expect(b.content.compositions[0].layers.find((l) => l.id === 'box')!.transform.y).toBe(456);
    expect(b.text('text').state.doc.textContent).toBe(original.text);
  } finally {
    a.close();
    b.close();
  }
});

it('requires the same ancestor grants for native text and preserves peer text through selective Undo', () => {
  const content = fixture(),
    c = content.compositions[0],
    outer = createAnimationLayer2('group', 'outer', c.duration),
    group = createAnimationLayer2('group', 'group', c.duration);
  group.parentId = outer.id;
  c.layers.find((l) => l.id === 'text')!.parentId = group.id;
  c.layers.push(group, outer);
  const authority = new Authority(codec, initial('animation', codec, content));
  const textOperation = (p: Principal, text: string) => {
    const base = authority.snapshot(),
      doc = canvasEngineDocument(codec, base.content, 'text'),
      tr = new Transform(doc);
    tr.insert(1, doc.type.schema.text(text));
    return operation(codec, base, p, [
      {
        type: 'canvas.text-steps',
        target: 'text',
        payload: { version: base.textVersions?.text ?? 0, steps: tr.steps.map((s) => s.toJSON()) },
      },
    ]);
  };
  for (const scopes of [['text'], ['text', 'group'], ['text', 'outer']]) {
    const p = { ...A, scopes },
      op = textOperation(p, 'Refused ');
    expect(authority.commit(p, op)).toMatchObject({ status: 'rejected', code: 'unauthorized' });
    expect(authority.snapshot().revision).toBe(0);
    expect(authority.snapshot().content).toEqual(content);
  }
  const p = { ...A, scopes: ['text', 'group', 'outer'] },
    own = textOperation(p, 'Alpha ');
  expect(authority.commit(p, own).status).toBe('accepted');
  const peer = textOperation(B, 'Beta ');
  expect(authority.commit(B, peer).status).toBe('accepted');
  expect(authority.undo(p, own.operationId).status).toBe('accepted');
  const text = authority.snapshot().content.compositions[0].layers.find((l) => l.id === 'text')!;
  expect(text.type === 'text' && text.text).toBe('Beta Text');
});

it('requires both composition grants when relocating a stable existing layer and preserves actor Undo', () => {
  const content = createAnimation2(),
    root = content.compositions[0];
  root.layers = [createAnimationLayer2('rect', 'box', root.duration)];
  content.compositions.push({
    ...structuredClone(root),
    id: 'destination',
    layers: [],
    tracks: [],
  });
  const box = root.layers.find((l) => l.id === 'box')!,
    changes = [
      { path: ['compositions', 'root', 'layers', 'box'], value: null },
      { path: ['compositions', 'destination', 'layers', 'box'], value: box },
    ];
  for (const scopes of [['box'], ['box', 'root'], ['box', 'destination']]) {
    const authority = new Authority(codec, initial('animation', codec, content)),
      p = { ...A, scopes };
    const op = operation(codec, authority.snapshot(), p, [
      { type: 'animation.patch', target: '*', payload: { changes } },
    ]);
    expect(authority.commit(p, op)).toMatchObject({ status: 'rejected', code: 'unauthorized' });
    expect(authority.snapshot().revision).toBe(0);
    expect(authority.snapshot().content).toEqual(content);
  }
  const authority = new Authority(codec, initial('animation', codec, content)),
    p = { ...A, scopes: ['box', 'root', 'destination'] },
    op = operation(codec, authority.snapshot(), p, [
      { type: 'animation.patch', target: '*', payload: { changes } },
    ]);
  expect(authority.commit(p, op).status).toBe('accepted');
  expect(authority.snapshot().content.compositions[1].layers[0].id).toBe('box');
  expect(authority.undo(p, op.operationId).status).toBe('accepted');
  expect(authority.snapshot().content).toEqual(content);
});
it('rejects a forged covering insertion at the authority boundary and permits a background with native Undo', () => {
  const content = createAnimation2(),
    c = content.compositions[0],
    locked = createAnimationLayer2('rect', 'protected', c.duration),
    inserted = createAnimationLayer2('rect', 'cover', c.duration);
  locked.locked = true;
  c.layers = [locked];
  if (inserted.type !== 'rect') throw Error('Expected rectangle fixture');
  inserted.width = c.width;
  inserted.height = c.height;
  const unlocked = structuredClone(content);
  unlocked.compositions[0].layers[0].locked = false;
  const authority = new Authority(codec, initial('animation', codec, content)),
    raw = operation(codec, initial('animation', codec, unlocked), A, [
      {
        type: 'animation.patch',
        target: '*',
        payload: {
          changes: [{ path: ['compositions', 'root', 'layers', inserted.id], value: inserted }],
        },
      },
    ]);
  expect(authority.commit(A, raw).status).toBe('rejected');
  expect(authority.snapshot().revision).toBe(0);
  expect(authority.snapshot().content).toEqual(content);
  const op = edit(authority, A, [
    {
      type: 'structure.replace',
      compositions: [{ ...c, layers: [inserted, locked] }],
      publicInputs: [],
    },
  ]);
  expect(authority.commit(A, op).status).toBe('accepted');
  expect(authority.undo(A, op.operationId).status).toBe('accepted');
  expect(authority.snapshot().content).toEqual(content);
});

it('keeps element and native-text presence attached through Nest, Unnest and actor Undo', () => {
  const content = fixture(),
    authority = new Authority(codec, initial('animation', codec, content)),
    c = { ...B, actorId: 'C', clientId: 'C', sessionId: 'C' };
  authority.presence(B, {
    name: 'B',
    color: '#0000ff',
    anchor: { type: 'element', elementId: 'text' },
  });
  authority.presence(c, {
    name: 'C',
    color: '#00ff00',
    anchor: { type: 'canvas-text', elementId: 'text', from: 1, to: 2 },
  });
  const nest = prepareEditorCommand(
    codec,
    authority.snapshot(),
    A,
    nestAnimationLayers2(
      content,
      'root',
      ['text'],
      { compositionId: 'nested', layerId: 'instance' },
      { canEdit: () => true },
    ),
  )!;
  expect(authority.commit(A, nest).status).toBe('accepted');
  for (const presence of authority.presenceList())
    expect(presence.anchor).not.toMatchObject({ orphan: true });
  const unnest = prepareEditorCommand(
    codec,
    authority.snapshot(),
    A,
    unnestAnimationLayer2(authority.snapshot().content, 'root', 'instance', {
      canEdit: () => true,
    }),
  )!;
  expect(authority.commit(A, unnest).status).toBe('accepted');
  for (const presence of authority.presenceList())
    expect(presence.anchor).not.toMatchObject({ orphan: true });
  expect(authority.undo(A, unnest.operationId).status).toBe('accepted');
  for (const presence of authority.presenceList())
    expect(presence.anchor).not.toMatchObject({ orphan: true });
  const removed = edit(authority, A, [
    { type: 'layer.remove', compositionId: 'nested', id: 'text' },
  ]);
  expect(authority.commit(A, removed).status).toBe('accepted');
  for (const presence of authority.presenceList())
    expect(presence.anchor).toMatchObject({ orphan: true });
});
it.each([false, true])(
  'requires descendant grants when changing inherited lock from %s',
  (locked) => {
    const content = fixture(),
      root = content.compositions[0],
      group = createAnimationLayer2('group', 'group', root.duration);
    group.locked = locked;
    root.layers.forEach((layer) => {
      layer.parentId = group.id;
    });
    root.layers.unshift(group);
    const authority = new Authority(codec, initial('animation', codec, content)),
      scoped = { ...A, scopes: [group.id] };
    const actions: AnimationAction2[] = [
      { type: 'layer.patch', compositionId: root.id, id: group.id, patch: { locked: !locked } },
    ];
    expect(authority.commit(scoped, edit(authority, scoped, actions))).toMatchObject({
      status: 'rejected',
      code: 'unauthorized',
    });
    expect(authority.snapshot().content).toEqual(content);
    expect(authority.snapshot().revision).toBe(0);
    const full = { ...A, scopes: ['group', 'box', 'text'] },
      op = edit(authority, full, actions);
    expect(authority.commit(full, op).status).toBe('accepted');
    expect(authority.undo(full, op.operationId).status).toBe('accepted');
    expect(authority.snapshot().content).toEqual(content);
  },
);
it.each(['new', 'retained', 'locked'] as const)(
  'orders font prerequisites and native text atomically with a %s font',
  (mode) => {
    const content = fixture(),
      c = content.compositions[0];
    const originalText = c.layers.find((l) => l.id === 'text');
    if (originalText?.type !== 'text') throw Error();
    originalText.runs = [{ text: originalText.text }];
    const bytes = new TextEncoder().encode('OTTO00000000');
    const font = {
      id: 'font',
      contentHash: hashAnimationBytes2(bytes),
      mediaType: 'font/otf' as const,
      base64: encodeAnimationBase64(bytes),
      attribution: 'Header fixture',
      license: 'Test',
    };
    const actions: AnimationAction2[] = [];
    if (mode === 'retained') {
      content.assets = [font];
      const clearing = createAnimationLayer2('text', 'clearing', c.duration);
      if (clearing.type !== 'text') throw Error();
      clearing.text = '日本語';
      clearing.runs = [{ text: clearing.text }];
      clearing.fontAssetId = font.id;
      c.layers.push(clearing);
      actions.push({
        type: 'layer.patch',
        compositionId: c.id,
        id: clearing.id,
        patch: { text: 'Plain', fontAssetId: null },
      });
    } else actions.push({ type: 'content.set', field: 'assets', value: [font] });
    actions.push({
      type: 'layer.patch',
      compositionId: c.id,
      id: 'text',
      patch: {
        text: '日本語',
        fontAssetId: font.id,
        ...(mode === 'locked' ? { locked: true } : {}),
      },
    });
    const authority = new Authority(codec, initial('animation', codec, content));
    const command = animationCommand2(content, actions, { canEdit: () => true });
    const local = command.apply(content);
    const op = prepareEditorCommand(codec, authority.snapshot(), A, command)!;
    const firstPatch = op.actions.findIndex((a) => a.type === 'animation.patch');
    expect(firstPatch).toBeLessThan(
      op.actions.findIndex((a) => a.type === 'canvas.text-steps' && a.target === 'text'),
    );
    if (mode === 'retained')
      expect(op.actions[0]).toMatchObject({ type: 'canvas.text-steps', target: 'clearing' });
    expect(authority.commit(A, op).status).toBe('accepted');
    expect(authority.snapshot().revision).toBe(1);
    const projected = authority.snapshot().content;
    expect(projected.compositions[0].layers.find((l) => l.id === 'text')).toMatchObject({
      text: '日本語',
      fontAssetId: font.id,
    });
    if (mode === 'retained')
      expect(projected.compositions[0].layers.find((l) => l.id === 'clearing')).toMatchObject({
        text: 'Plain',
        fontAssetId: null,
      });
    expect(projected.assets).toEqual(local.assets);
    const peer = edit(authority, B, [
      { type: 'layer.patch', compositionId: c.id, id: 'box', patch: { transform: { y: 456 } } },
    ]);
    expect(authority.commit(B, peer).status).toBe('accepted');
    const undo = authority.undo(A, op.operationId);
    expect(undo.status).toBe('accepted');
    const undone = authority.snapshot().content;
    expect(undone.assets).toEqual(content.assets);
    expect(undone.compositions[0].layers.filter((l) => l.type === 'text')).toEqual(
      c.layers.filter((l) => l.type === 'text'),
    );
    expect(undone.compositions[0].layers[0].transform.y).toBe(456);
    expect(authority.undo(A, undo.operationId, true).status).toBe('accepted');
    expect(
      authority.snapshot().content.compositions[0].layers.find((l) => l.id === 'text'),
    ).toMatchObject({ text: '日本語', fontAssetId: font.id });
  },
);
it('prunes a deleted exact provider atomically and restores its pin through actor Undo without losing a peer edit', () => {
  const source = createAnimation2();
  source.compositions[0].layers = [createAnimationLayer2('rect', 'source-box', 960000)];
  const embed = createPlayableAnimationEmbed(
    { artifactId: 'saved', versionId: 'v1', compositionId: 'root', contentHash: reuseHash(source) },
    source,
    'Saved',
  );
  if (embed.format !== 'animation-embed-2') throw Error();
  const original = fixture(),
    content = insertExactAnimation(original, 'root', embed, 'instance', {
      canEdit: () => true,
    }).apply(original);
  const authority = new Authority(codec, initial('animation', codec, content));
  const deletion = edit(authority, A, [
    { type: 'layer.remove', compositionId: 'root', id: 'instance' },
  ]);
  const peer = edit(authority, B, [
    { type: 'layer.patch', compositionId: 'root', id: 'box', patch: { transform: { y: 456 } } },
  ]);
  expect(authority.commit(A, deletion).status).toBe('accepted');
  expect(authority.snapshot().content.sources).toHaveLength(0);
  expect(authority.commit(B, peer).status).toBe('accepted');
  expect(authority.undo(A, deletion.operationId).status).toBe('accepted');
  expect(authority.snapshot().content.sources).toEqual(content.sources);
  expect(
    authority.snapshot().content.compositions[0].layers.find((l) => l.id === 'instance'),
  ).toEqual(content.compositions[0].layers.at(-1));
  expect(
    authority.snapshot().content.compositions[0].layers.find((l) => l.id === 'box')!.transform.y,
  ).toBe(456);
  expect(embed.snapshot).toEqual(source);
});
function fixture() {
  const content = createAnimation2();
  content.compositions[0].layers = [
    createAnimationLayer2('rect', 'box', 960000),
    createAnimationLayer2('text', 'text', 960000),
  ];
  content.compositions[0].tracks = [
    {
      id: 'track',
      layerId: 'box',
      property: 'x',
      keys: [
        { id: 'a', tick: 0, value: 0, easing: { type: 'linear' } },
        { id: 'b', tick: 960000, value: 300, easing: { type: 'hold' } },
      ],
    },
  ];
  return content;
}
function edit(
  authority: Authority<AnimationContent2>,
  who: Principal,
  actions: AnimationAction2[],
) {
  const base = authority.snapshot();
  return prepareEditorCommand(
    codec,
    base,
    who,
    animationCommand2(base.content, actions, { canEdit: () => true }),
  )!;
}
it('merges independent key edits, rejects same-field stale writes and preserves a peer through selective Undo', () => {
  const authority = new Authority(codec, initial('animation', codec, fixture()));
  const patch = (id: string, value: number): AnimationAction2[] => [
    {
      type: 'track.put',
      compositionId: 'root',
      track: {
        ...fixture().compositions[0].tracks[0],
        keys: fixture().compositions[0].tracks[0].keys.map((k) =>
          k.id === id ? { ...k, value } : k,
        ),
      },
    },
  ];
  const a = edit(authority, A, patch('a', 10)),
    b = edit(authority, B, patch('b', 400)),
    stale = edit(authority, B, patch('a', 99));
  expect(authority.commit(A, a).status).toBe('accepted');
  expect(authority.commit(B, b).status).toBe('accepted');
  expect(authority.commit(B, stale)).toMatchObject({
    status: 'rejected',
    code: 'stale-precondition',
  });
  expect(authority.undo(A, a.operationId).status).toBe('accepted');
  expect(authority.snapshot().content.compositions[0].tracks[0].keys.map((k) => k.value)).toEqual([
    0, 400,
  ]);
  expect(authority.commit(A, a)).toMatchObject({ status: 'accepted', revision: 1 });
  expect(authority.snapshot().revision).toBe(3);
  const geometry = edit(authority, A, [
    { type: 'layer.patch', compositionId: 'root', id: 'box', patch: { transform: { y: 123 } } },
  ]);
  expect(authority.commit(A, geometry).status).toBe('accepted');
  expect(authority.snapshot().content.compositions[0].layers[0].transform.y).toBe(123);
});
it('validates deletion/lock/expiry and refuses malformed patches atomically', () => {
  const authority = new Authority(codec, initial('animation', codec, fixture()));
  const a = edit(authority, A, [
    { type: 'layer.patch', compositionId: 'root', id: 'text', patch: { fill: '#ff0000' } },
  ]);
  expect(authority.commit({ ...A, writable: false }, a)).toMatchObject({
    status: 'rejected',
    code: 'unauthorized',
  });
  expect(authority.commit({ ...A, expiresAt: 0 }, a)).toMatchObject({
    status: 'rejected',
    code: 'unauthorized',
  });
  // A concurrent lock is a read dependency of every edit to that layer.
  const lock = edit(authority, B, [
    { type: 'layer.patch', compositionId: 'root', id: 'text', patch: { locked: true } },
  ]);
  expect(authority.commit(B, lock).status).toBe('accepted');
  expect(authority.commit(A, a)).toMatchObject({
    status: 'rejected',
    code: 'stale-precondition',
    keys: ['animation:["compositions","root","layers","text","locked"]'],
  });
  // Covering locked artwork depends on no field of the locked layer, so only the
  // authority's own lock policy can reject this raw patch from an unlocked basis.
  const cover = {
    type: 'animation.patch',
    target: '*',
    payload: {
      changes: [
        {
          path: ['compositions', 'root', 'layers', 'cover'],
          value: createAnimationLayer2('rect', 'cover', 960000),
        },
      ],
    },
  };
  const unlocked = new Authority(codec, initial('animation', codec, fixture())),
    raw = operation(codec, unlocked.snapshot(), A, [cover]);
  expect(
    authority.commit(A, { ...raw, baseRevision: authority.snapshot().revision }),
  ).toMatchObject({ status: 'rejected', code: 'invalid-operation', message: 'locked: text' });
  expect(unlocked.commit(A, raw).status).toBe('accepted');
  const before = authority.snapshot();
  expect(() =>
    operation(codec, before, A, [
      {
        type: 'animation.patch',
        target: '*',
        payload: {
          changes: [{ path: ['compositions', 'root', 'layers', 'box', '__proto__'], value: {} }],
        },
      },
    ]),
  ).toThrow(expect.objectContaining({ code: 'schema-mismatch' }));
  expect(authority.snapshot()).toEqual(before);
});
it('uses native text steps and rebases A Undo through B text, including lost acknowledgement recovery', async () => {
  const authority = new Authority(codec, initial('animation', codec, fixture()));
  async function session(who: Principal) {
    const base = localAdapter(authority, who),
      faults = new FaultAdapter(base);
    const adapter = Object.assign(faults, {
      versions: async () => [],
      undo: async (id: string, redo?: boolean) => authority.undo(who, id, redo),
    }) as unknown as EditorHostAdapter<AnimationContent2>;
    const session = new SharedEditorSession(codec, adapter);
    await session.open();
    return { session, faults };
  }
  const a = await session(A),
    b = await session(B);
  try {
    const engine = a.session.text('text');
    engine.dispatch(engine.state.tr.insertText('Alpha ', 1));
    await a.session.flush();
    await b.session.sync();
    const peer = b.session.text('text');
    peer.dispatch(peer.state.tr.insertText('Beta ', 1));
    await b.session.flush();
    await a.session.sync();
    await a.session.history('undo');
    const layer = authority.snapshot().content.compositions[0].layers.find((l) => l.id === 'text')!;
    expect(layer.type === 'text' && layer.text).toContain('Beta ');
    expect(layer.type === 'text' && layer.text).not.toContain('Alpha ');
    await a.session.sync();
    a.faults.dropAck = true;
    const live = a.session.text('text');
    live.dispatch(live.state.tr.insertText('Retained ', 1));
    await a.session.flush();
    const checkpoint = a.session.checkpoint(),
      restored = new SharedEditorSession(codec, a.session.adapter);
    a.session.suspend(() => {});
    restored.resume(checkpoint);
    a.faults.dropAck = false;
    await restored.open();
    await restored.flush();
    const recovered = authority
      .snapshot()
      .content.compositions[0].layers.find((l) => l.id === 'text')!;
    expect(recovered.type === 'text' && recovered.text.match(/Retained /g)).toHaveLength(1);
    restored.close();
  } finally {
    a.session.suspend(() => {});
    b.session.close();
  }
});
it('restores structural insertion in one Undo without a second history stack', () => {
  const authority = new Authority(codec, initial('animation', codec, fixture()));
  const a = edit(authority, A, [
    {
      type: 'layer.insert',
      compositionId: 'root',
      layer: createAnimationLayer2('rect', 'extra', 960000),
    },
  ]);
  expect(authority.commit(A, a).status).toBe('accepted');
  expect(authority.undo(A, a.operationId).status).toBe('accepted');
  expect(authority.snapshot().content).toEqual(fixture());
});
it('enforces scoped permissions for insertions and root resources and refuses forged entity identities', () => {
  const authority = new Authority(codec, initial('animation', codec, fixture())),
    scoped = { ...A, scopes: ['text'] };
  const insert = edit(authority, scoped, [
    {
      type: 'layer.insert',
      compositionId: 'root',
      layer: createAnimationLayer2('rect', 'extra', 960000),
    },
  ]);
  expect(authority.commit(scoped, insert)).toMatchObject({
    status: 'rejected',
    code: 'unauthorized',
  });
  const input = edit(authority, scoped, [
    {
      type: 'content.set',
      field: 'publicInputs',
      value: [
        {
          id: 'caption',
          name: 'Caption',
          kind: 'text',
          default: 'Text',
          min: 0,
          max: 0,
          target: { compositionId: 'root', layerId: 'text', property: 'text' },
        },
      ],
    },
  ]);
  expect(authority.commit(scoped, input)).toMatchObject({
    status: 'rejected',
    code: 'unauthorized',
  });
  expect(() =>
    operation(codec, authority.snapshot(), A, [
      {
        type: 'animation.patch',
        target: '*',
        payload: {
          changes: [
            {
              path: ['compositions', 'root', 'layers', 'advertised'],
              value: createAnimationLayer2('rect', 'different', 960000),
            },
          ],
        },
      },
    ]),
  ).toThrow('identity');
});

it('refuses whole existing entity replacements that would bypass the shared text engine', () => {
  const content = fixture(),
    authority = new Authority(codec, initial('animation', codec, content));
  const text = content.compositions[0].layers.find((l) => l.id === 'text')!;
  const relocated = { ...structuredClone(content.compositions[0]), id: 'moved' };
  const relocatedText = relocated.layers.find((layer) => layer.type === 'text')!;
  if (relocatedText.type === 'text') relocatedText.text = 'Forged while moving';
  expect(() =>
    operation(codec, authority.snapshot(), A, [
      {
        type: 'animation.patch',
        target: '*',
        payload: {
          changes: [
            { path: ['rootCompositionId'], value: 'moved' },
            { path: ['compositions', 'root'], value: null },
            { path: ['compositions', 'moved'], value: relocated },
          ],
        },
      },
    ]),
  ).toThrow('native engine steps');
  for (const change of [
    {
      path: ['compositions', 'root', 'layers', 'text'],
      value: { ...text, text: 'Forged snapshot' },
    },
    { path: ['compositions', 'root'], value: content.compositions[0] },
  ])
    expect(() =>
      operation(codec, authority.snapshot(), A, [
        { type: 'animation.patch', target: '*', payload: { changes: [change] } },
      ]),
    ).toThrow('native engine steps');
});

it('authority rejects forged insertion and reparenting into an originally locked subtree atomically', () => {
  const locked = createAnimation2(),
    c = locked.compositions[0];
  const group = createAnimationLayer2('group', 'locked-group', c.duration);
  group.locked = true;
  c.layers = [group, createAnimationLayer2('rect', 'outside', c.duration)];
  const unlocked = structuredClone(locked);
  unlocked.compositions[0].layers[0].locked = false;
  const inserted = createAnimationLayer2('rect', 'new-child', c.duration);
  inserted.parentId = group.id;
  for (const change of [
    { path: ['compositions', 'root', 'layers', inserted.id], value: inserted },
    { path: ['compositions', 'root', 'layers', 'outside', 'parentId'], value: group.id },
  ]) {
    const authority = new Authority(codec, initial('animation', codec, locked));
    const raw = operation(codec, initial('animation', codec, unlocked), A, [
      { type: 'animation.patch', target: '*', payload: { changes: [change] } },
    ]);
    expect(authority.commit(A, raw).status).toBe('rejected');
    expect(authority.snapshot().content).toEqual(locked);
    expect(authority.snapshot().revision).toBe(0);
  }
});

it('protects transitive clip geometry, ancestors, tracks and inputs at the authority boundary', () => {
  const locked = createAnimation2(),
    c = locked.compositions[0];
  const box = createAnimationLayer2('rect', 'locked-box', c.duration),
    mask = createAnimationLayer2('path', 'mask', c.duration),
    parent = createAnimationLayer2('group', 'mask-parent', c.duration),
    outer = createAnimationLayer2('rect', 'outer-mask', c.duration);
  box.locked = true;
  box.clipId = mask.id;
  mask.parentId = parent.id;
  mask.maskOnly = true;
  parent.clipId = outer.id;
  outer.maskOnly = true;
  c.layers = [box, mask, parent, outer, createAnimationLayer2('rect', 'unrelated', c.duration)];
  c.tracks = [
    {
      id: 'mask-track',
      layerId: parent.id,
      property: 'x',
      keys: [{ id: 'mask-key', tick: 0, value: 0, easing: { type: 'hold' } }],
    },
  ];
  const unlocked = structuredClone(locked);
  unlocked.compositions[0].layers[0].locked = false;
  for (const change of [
    {
      path: ['compositions', 'root', 'layers', mask.id, 'path'],
      value: [
        ['M', 0, 0],
        ['L', 20, 20],
      ],
    },
    { path: ['compositions', 'root', 'layers', mask.id, 'transform', 'x'], value: 123 },
    { path: ['compositions', 'root', 'layers', parent.id, 'transform', 'y'], value: 123 },
    { path: ['compositions', 'root', 'layers', outer.id, 'width'], value: 123 },
    {
      path: ['compositions', 'root', 'tracks', 'mask-track', 'keys', 'mask-key', 'value'],
      value: 123,
    },
    {
      path: ['publicInputs'],
      value: [
        {
          id: 'mask-input',
          name: 'Mask width',
          kind: 'number',
          default: 123,
          min: 0,
          max: 1000,
          target: { compositionId: 'root', layerId: outer.id, property: 'y' },
        },
      ],
    },
  ]) {
    const authority = new Authority(codec, initial('animation', codec, locked));
    const raw = operation(codec, initial('animation', codec, unlocked), A, [
      { type: 'animation.patch', target: '*', payload: { changes: [change] } },
    ]);
    expect(authority.commit(A, raw).status).toBe('rejected');
    expect(authority.snapshot().content).toEqual(locked);
    expect(authority.snapshot().revision).toBe(0);
  }
  expect(() =>
    animationCommand2(
      locked,
      [
        {
          type: 'layer.patch',
          compositionId: 'root',
          id: mask.id,
          patch: { transform: { x: 123 } },
        },
      ],
      { canEdit: () => true },
    ),
  ).toThrow('locked');
  const authority = new Authority(codec, initial('animation', codec, locked));
  const a = edit(authority, A, [
    {
      type: 'layer.patch',
      compositionId: 'root',
      id: 'unrelated',
      patch: { transform: { x: 123 } },
    },
  ]);
  expect(authority.commit(A, a).status).toBe('accepted');
  const b = edit(authority, B, [
    {
      type: 'layer.patch',
      compositionId: 'root',
      id: 'unrelated',
      patch: { transform: { y: 456 } },
    },
  ]);
  expect(authority.commit(B, b).status).toBe('accepted');
  expect(authority.undo(A, a.operationId).status).toBe('accepted');
  expect(authority.snapshot().content.compositions[0].layers[4].transform).toMatchObject({
    x: 80,
    y: 456,
  });
});

it('authorizes layer-order changes against every layer as well as the composition', () => {
  const content = fixture();
  const scoped = { ...A, scopes: ['root'] };
  const authority = new Authority(codec, initial('animation', codec, content));
  const action = {
    type: 'animation.patch',
    target: '*',
    payload: {
      changes: [{ path: ['compositions', 'root', '$order:layers'], value: ['text', 'box'] }],
    },
  };
  const raw = operation(codec, authority.snapshot(), scoped, [action]);
  expect(authority.commit(scoped, raw)).toMatchObject({ status: 'rejected', code: 'unauthorized' });
  expect(authority.snapshot().content).toEqual(content);
  expect(authority.snapshot().revision).toBe(0);
  expect(
    authority.commit(scoped, { ...raw, operationId: crypto.randomUUID(), targets: ['root'] }),
  ).toMatchObject({ status: 'rejected', code: 'protocol-error' });
  const complete = { ...A, scopes: ['root', 'text', 'box'] };
  const allowed = operation(codec, authority.snapshot(), complete, [action]);
  expect(authority.commit(complete, allowed).status).toBe('accepted');
  expect(authority.undo(complete, allowed.operationId).status).toBe('accepted');
  expect(authority.snapshot().content).toEqual(content);
});

it('requires grants for the rendered descendants of a group edit and retains selective Undo', () => {
  const content = fixture(),
    root = content.compositions[0];
  const group = createAnimationLayer2('group', 'group', root.duration);
  root.layers.forEach((layer) => {
    layer.parentId = group.id;
  });
  root.layers.unshift(group);
  const scoped = { ...A, scopes: [group.id] };
  const metadata = new Authority(codec, initial('animation', codec, content));
  expect(
    metadata.commit(
      scoped,
      edit(metadata, scoped, [
        {
          type: 'layer.patch',
          compositionId: root.id,
          id: group.id,
          patch: { name: 'Renamed group' },
        },
      ]),
    ).status,
  ).toBe('accepted');
  for (const patch of [{ transform: { x: 200 } }, { visible: false }, { end: 480000 }]) {
    const authority = new Authority(codec, initial('animation', codec, content));
    const op = edit(authority, scoped, [
      { type: 'layer.patch', compositionId: root.id, id: group.id, patch },
    ]);
    expect(authority.commit(scoped, op)).toMatchObject({
      status: 'rejected',
      code: 'unauthorized',
    });
    expect(authority.snapshot().content).toEqual(content);
    expect(authority.snapshot().revision).toBe(0);
  }
  const authority = new Authority(codec, initial('animation', codec, content));
  const full = { ...A, scopes: [group.id, 'box', 'text'] };
  const a = edit(authority, full, [
    { type: 'layer.patch', compositionId: root.id, id: group.id, patch: { transform: { x: 200 } } },
  ]);
  expect(authority.commit(full, a).status).toBe('accepted');
  expect(
    authority.commit(
      B,
      edit(authority, B, [
        {
          type: 'layer.patch',
          compositionId: root.id,
          id: 'text',
          patch: { transform: { y: 300 } },
        },
      ]),
    ).status,
  ).toBe('accepted');
  expect(authority.undo(full, a.operationId).status).toBe('accepted');
  expect(
    authority.snapshot().content.compositions[0].layers.find((layer) => layer.id === group.id)!
      .transform.x,
  ).toBe(group.transform.x);
  expect(
    authority.snapshot().content.compositions[0].layers.find((layer) => layer.id === 'text')!
      .transform.y,
  ).toBe(300);
});

it('checks inherited track, mask and local-instance effects at the authority boundary', () => {
  const content = fixture(),
    root = content.compositions[0],
    group = createAnimationLayer2('group', 'group', root.duration);
  root.layers.find((l) => l.id === 'text')!.parentId = group.id;
  root.layers.push(group);
  root.tracks.push({
    id: 'group-x',
    layerId: group.id,
    property: 'x',
    keys: [{ id: 'group-key', tick: 0, value: 0, easing: { type: 'hold' } }],
  });
  const mask = createAnimationLayer2('rect', 'mask', root.duration);
  root.layers.push(mask);
  root.layers.find((l) => l.id === 'box')!.clipId = mask.id;
  content.compositions.push({
    ...structuredClone(root),
    id: 'child',
    layers: [createAnimationLayer2('rect', 'child-box', root.duration)],
    tracks: [],
  });
  root.layers.push({
    ...createAnimationLayer2('group', 'instance', root.duration),
    type: 'composition',
    source: { type: 'local', compositionId: 'child' },
    time: {
      sourceIn: 0,
      sourceOut: root.duration,
      rate: { numerator: 1, denominator: 1 },
      after: 'hold',
    },
  });
  for (const [scope, path, value] of [
    ['group', ['compositions', root.id, 'tracks', 'group-x', 'keys', 'group-key', 'value'], 20],
    ['mask', ['compositions', root.id, 'layers', 'mask', 'width'], 200],
    ['instance', ['compositions', root.id, 'layers', 'instance', 'visible'], false],
  ] as const) {
    const authority = new Authority(codec, initial('animation', codec, content)),
      principal = { ...A, scopes: [scope] };
    const op = operation(codec, authority.snapshot(), principal, [
      { type: 'animation.patch', target: '*', payload: { changes: [{ path: [...path], value }] } },
    ]);
    expect(authority.commit(principal, op)).toMatchObject({
      status: 'rejected',
      code: 'unauthorized',
    });
    expect(authority.snapshot().content).toEqual(content);
    expect(authority.snapshot().revision).toBe(0);
    expect(
      authority.commit(principal, { ...op, operationId: crypto.randomUUID(), targets: [scope] }),
    ).toMatchObject({ status: 'rejected', code: 'protocol-error' });
  }
});
