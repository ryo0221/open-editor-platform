import { readFileSync } from 'node:fs';
import { EditorState } from 'prosemirror-state';
import { expect, it } from 'vitest';
import { Authority, initial, operation, type Principal } from '@editor-platform/collaboration-core';
import {
  createAnimation2,
  createAnimationLayer2,
  animationCommand2,
  encodeAnimationBase64,
  hashAnimationBytes2,
  type Layer2,
} from '@editor-platform/animation-core/v2';
import { animationEditorCodec as codec } from './animation';
import { prepareEditorCommand } from './editor-transactions';
import { canvasEngineDocument } from './canvas-text';
const A: Principal = { actorId: 'A', clientId: 'A', sessionId: 'A', writable: true, scopes: ['*'] };
it('rejects a raw root switch away from protected root content atomically', () => {
  const locked = fixture(),
    unlocked = structuredClone(locked);
  unlocked.compositions[0].layers[0].locked = false;
  const change = { path: ['rootCompositionId'], value: 'unrelated' };
  const raw = operation(codec, initial('animation', codec, unlocked), A, [
    { type: 'animation.patch', target: '*', payload: { changes: [change] } },
  ]);
  const authority = new Authority(codec, initial('animation', codec, locked));
  expect(authority.commit(A, raw).status).toBe('rejected');
  expect(authority.snapshot().content).toEqual(locked);
  expect(authority.snapshot().revision).toBe(0);
  const independent = structuredClone(unlocked);
  independent.compositions[3].layers[0].locked = true;
  const allowed = new Authority(codec, initial('animation', codec, independent));
  const permitted = operation(codec, allowed.snapshot(), A, [
    { type: 'animation.patch', target: '*', payload: { changes: [change] } },
  ]);
  expect(allowed.commit(A, permitted).status).toBe('accepted');
});
it.each(['child', 'grandchild'])(
  'protects root switches when %s has a reachable local lock',
  (id) => {
    const locked = fixture();
    locked.compositions[0].layers[0].locked = false;
    locked.compositions.find((c) => c.id === id)!.layers[0].locked = true;
    const unlocked = structuredClone(locked);
    unlocked.compositions.find((c) => c.id === id)!.layers[0].locked = false;
    const change = { path: ['rootCompositionId'], value: 'unrelated' };
    const raw = operation(codec, initial('animation', codec, unlocked), A, [
      { type: 'animation.patch', target: '*', payload: { changes: [change] } },
    ]);
    const authority = new Authority(codec, initial('animation', codec, locked));
    expect(authority.commit(A, raw).status).toBe('rejected');
    expect(authority.snapshot().content).toEqual(locked);
    expect(authority.snapshot().revision).toBe(0);
  },
);
function fixture() {
  const content = createAnimation2(),
    root = content.compositions[0];
  const instance = (id: string, target: string): Layer2 => ({
    ...createAnimationLayer2('group', id, root.duration),
    type: 'composition',
    source: { type: 'local', compositionId: target },
    time: {
      sourceIn: 0,
      sourceOut: root.duration,
      rate: { numerator: 1, denominator: 1 },
      after: 'hold',
    },
  });
  root.layers = [instance('locked-instance', 'child')];
  root.layers[0].locked = true;
  const child = {
      ...structuredClone(root),
      id: 'child',
      layers: [instance('nested-instance', 'grandchild')],
    },
    grandchild = {
      ...structuredClone(root),
      id: 'grandchild',
      layers: [createAnimationLayer2('rect', 'box', root.duration)],
    },
    unrelated = {
      ...structuredClone(root),
      id: 'unrelated',
      layers: [createAnimationLayer2('rect', 'other-box', root.duration)],
    };
  const bytes = readFileSync('tests/fixtures/office/images/quadrants.png');
  content.assets = [
    {
      id: 'picture',
      contentHash: hashAnimationBytes2(bytes),
      mediaType: 'image/png',
      base64: encodeAnimationBase64(bytes),
      attribution: 'Fixture image',
      license: 'Retained notice',
    },
  ];
  grandchild.layers.push({
    ...createAnimationLayer2('group', 'picture-layer', root.duration),
    type: 'image',
    assetId: 'picture',
    width: 100,
    height: 100,
  });
  grandchild.layers.push(createAnimationLayer2('text', 'caption', root.duration));
  grandchild.tracks = [
    {
      id: 'position',
      layerId: 'box',
      property: 'x',
      keys: [{ id: 'key', tick: 0, value: 100, easing: { type: 'hold' } }],
    },
  ];
  content.compositions.push(child, grandchild, unrelated);
  return content;
}
it('rejects edits throughout locked local composition source closures and permits unrelated selective Undo', () => {
  const locked = fixture(),
    unlocked = structuredClone(locked);
  const jpeg = readFileSync('tests/fixtures/office/images/quadrants.jpeg');
  unlocked.compositions[0].layers[0].locked = false;
  for (const change of [
    { path: ['compositions', 'grandchild', 'layers', 'box', 'transform', 'y'], value: 300 },
    {
      path: ['compositions', 'child', 'layers', 'inserted'],
      value: createAnimationLayer2('rect', 'inserted', 960000),
    },
    {
      path: ['compositions', 'grandchild', 'tracks', 'position', 'keys', 'key', 'value'],
      value: 200,
    },
    {
      path: ['publicInputs'],
      value: [
        {
          id: 'child-input',
          name: 'Child y',
          kind: 'number',
          default: 200,
          min: 0,
          max: 400,
          target: { compositionId: 'grandchild', layerId: 'box', property: 'y' },
        },
      ],
    },
    {
      path: ['assets'],
      value: locked.assets.map((asset) => ({ ...asset, attribution: 'Changed resource metadata' })),
    },
    {
      path: ['assets'],
      value: locked.assets.map((asset) => ({
        ...asset,
        mediaType: 'image/jpeg',
        base64: encodeAnimationBase64(jpeg),
        contentHash: hashAnimationBytes2(jpeg),
      })),
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
          compositionId: 'grandchild',
          id: 'box',
          patch: { transform: { y: 300 } },
        },
      ],
      { canEdit: () => true },
    ),
  ).toThrow('locked');
  const authority = new Authority(codec, initial('animation', codec, locked)),
    B = { ...A, actorId: 'B', clientId: 'B', sessionId: 'B' };
  const edit = (who: Principal, property: 'x' | 'y', value: number) =>
    prepareEditorCommand(
      codec,
      authority.snapshot(),
      who,
      animationCommand2(
        authority.snapshot().content,
        [
          {
            type: 'layer.patch',
            compositionId: 'unrelated',
            id: 'other-box',
            patch: { transform: { [property]: value } },
          },
        ],
        { canEdit: () => true },
      ),
    )!;
  const a = edit(A, 'x', 300);
  expect(authority.commit(A, a).status).toBe('accepted');
  expect(authority.commit(B, edit(B, 'y', 200)).status).toBe('accepted');
  expect(authority.undo(A, a.operationId).status).toBe('accepted');
  expect(authority.snapshot().content.compositions[3].layers[0].transform).toMatchObject({
    x: 80,
    y: 200,
  });
  expect(() =>
    animationCommand2(
      locked,
      [
        {
          type: 'content.set',
          field: 'assets',
          value: [...locked.assets, { ...locked.assets[0], id: 'unused-image' }],
        },
      ],
      { canEdit: () => true },
    ),
  ).not.toThrow();
});

it('applies the same locked source protection to native ProseMirror submissions', () => {
  const locked = fixture(),
    unlocked = structuredClone(locked);
  unlocked.compositions[0].layers[0].locked = false;
  const tr = EditorState.create({
    doc: canvasEngineDocument(codec, unlocked, 'caption'),
  }).tr.insertText('Changed ', 1);
  const raw = operation(codec, initial('animation', codec, unlocked), A, [
    {
      type: 'canvas.text-steps',
      target: 'caption',
      payload: { version: 0, steps: tr.steps.map((step) => step.toJSON()) },
    },
  ]);
  const authority = new Authority(codec, initial('animation', codec, locked));
  expect(authority.commit(A, raw).status).toBe('rejected');
  expect(authority.snapshot().content).toEqual(locked);
  expect(authority.snapshot().revision).toBe(0);
});

it('protects reverse local instances and their parent/clip/track dependencies without freezing unrelated child layers', () => {
  const locked = fixture();
  locked.compositions[0].layers[0].locked = false;
  locked.compositions[2].layers[0].locked = true;
  const original = structuredClone(locked),
    unlocked = structuredClone(locked);
  unlocked.compositions[2].layers[0].locked = false;
  for (const [compositionId, id] of [
    ['root', 'locked-instance'],
    ['child', 'nested-instance'],
  ]) {
    for (const field of ['transform', 'visible', 'end', 'time', 'remove']) {
      const authority = new Authority(codec, initial('animation', codec, locked));
      const value =
        field === 'transform'
          ? 300
          : field === 'visible'
            ? false
            : field === 'end'
              ? 480000
              : field === 'time'
                ? {
                    sourceIn: 0,
                    sourceOut: 480000,
                    rate: { numerator: 1, denominator: 1 },
                    after: 'hold',
                  }
                : null;
      const path = [
        'compositions',
        compositionId,
        'layers',
        id,
        ...(field === 'remove' ? [] : field === 'transform' ? ['transform', 'x'] : [field]),
      ];
      const raw = operation(codec, initial('animation', codec, unlocked), A, [
        { type: 'animation.patch', target: '*', payload: { changes: [{ path, value }] } },
      ]);
      expect(authority.commit(A, raw)).toMatchObject({
        status: 'rejected',
        code: 'invalid-operation',
      });
      expect(authority.snapshot().content).toEqual(original);
      expect(authority.snapshot().revision).toBe(0);
    }
  }
  const authority = new Authority(codec, initial('animation', codec, locked));
  const edit = animationCommand2(
    locked,
    [
      {
        type: 'layer.patch',
        compositionId: 'grandchild',
        id: 'picture-layer',
        patch: { transform: { y: 200 } },
      },
    ],
    { canEdit: () => true },
  );
  const op = prepareEditorCommand(codec, authority.snapshot(), A, edit)!;
  expect(authority.commit(A, op).status).toBe('accepted');
  expect(authority.undo(A, op.operationId).status).toBe('accepted');
  expect(authority.snapshot().content).toEqual(original);
});

it('protects reverse-instance parent, clip, track and public-input dependencies at the authority boundary', () => {
  const locked = fixture(),
    root = locked.compositions[0],
    instance = root.layers[0];
  instance.locked = false;
  locked.compositions[2].layers[0].locked = true;
  const parent = createAnimationLayer2('group', 'instance-parent', root.duration);
  const mask = createAnimationLayer2('rect', 'instance-mask', root.duration);
  mask.maskOnly = true;
  instance.parentId = parent.id;
  instance.clipId = mask.id;
  root.layers.unshift(parent, mask);
  root.tracks = [
    {
      id: 'instance-track',
      layerId: instance.id,
      property: 'x',
      keys: [{ id: 'instance-key', tick: 0, value: 80, easing: { type: 'hold' } }],
    },
  ];
  locked.publicInputs = [
    {
      id: 'instance-input',
      name: 'Instance y',
      kind: 'number',
      default: 80,
      min: 0,
      max: 400,
      target: { compositionId: root.id, layerId: instance.id, property: 'y' },
    },
  ];
  const unlocked = structuredClone(locked);
  unlocked.compositions[2].layers[0].locked = false;
  const changes = [
    { path: ['compositions', root.id, 'layers', parent.id, 'transform', 'x'], value: 300 },
    { path: ['compositions', root.id, 'layers', mask.id, 'width'], value: 300 },
    {
      path: ['compositions', root.id, 'tracks', 'instance-track', 'keys', 'instance-key', 'value'],
      value: 300,
    },
    {
      path: ['publicInputs'],
      value: locked.publicInputs.map((input) => ({ ...input, default: 300 })),
    },
    { path: ['compositions', root.id, 'layers', instance.id, 'parentId'], value: null },
    {
      path: ['compositions', root.id, 'layers', instance.id, 'source'],
      value: { type: 'local', compositionId: 'unrelated' },
    },
  ];
  for (const change of changes) {
    const raw = operation(codec, initial('animation', codec, unlocked), A, [
      { type: 'animation.patch', target: '*', payload: { changes: [change] } },
    ]);
    const authority = new Authority(codec, initial('animation', codec, locked));
    expect(authority.commit(A, raw)).toMatchObject({
      status: 'rejected',
      code: 'invalid-operation',
    });
    expect(authority.snapshot().revision).toBe(0);
    expect(authority.snapshot().content).toEqual(locked);
  }
  expect(() =>
    animationCommand2(
      locked,
      [{ type: 'layer.patch', compositionId: root.id, id: instance.id, patch: { visible: false } }],
      { canEdit: () => true },
    ),
  ).toThrowError(expect.objectContaining({ code: 'locked' }));
});
