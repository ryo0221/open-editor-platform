import { describe, expect, it } from 'vitest';
import { reuseHash } from '@editor-platform/reuse-core';
import { EditorSession } from '@editor-platform/editor-core';
import { createRectangleAnimation } from '../embedding';
import { createAnimation2, readAnimation2 } from './validate';
import { animationCommand2, createAnimationLayer2, upgradeAnimationCommand2 } from './commands';
import {
  evaluateAnimation2,
  prepareAnimation2,
  pointOnAnimationPath2,
  nestedTick2,
  interpolateColor2,
} from './evaluate';
import { decodeAnimationBase64, encodeAnimationBase64, hashAnimationBytes2 } from './assets';
import type { AnimationContent2, Layer2 } from './model';

function fixture() {
  const c = createAnimation2(),
    root = c.compositions[0];
  root.layers = [
    createAnimationLayer2('rect', 'box', root.duration),
    createAnimationLayer2('text', 'label', root.duration),
    createAnimationLayer2('path', 'mask', root.duration),
  ];
  root.layers[2].maskOnly = true;
  root.layers[0].clipId = 'mask';
  root.layers[0].motion = {
    path: [
      ['M', 0, 0],
      ['C', 0, 100, 100, 100, 100, 0],
    ],
    start: 0,
    end: root.duration,
    orient: true,
  };
  root.tracks = [
    {
      id: 'fade',
      layerId: 'box',
      property: 'opacity',
      keys: [
        { id: 'start', tick: 0, value: 0, easing: { type: 'linear' } },
        { id: 'end', tick: root.duration, value: 1, easing: { type: 'hold' } },
      ],
    },
  ];
  c.publicInputs = [
    {
      id: 'caption',
      name: 'Caption',
      kind: 'text',
      default: 'Title',
      min: 0,
      max: 0,
      target: { compositionId: 'root', layerId: 'label', property: 'text' },
    },
  ];
  return c;
}
it('has a deterministic owned scene for random/reverse seek, inherited clip, motion and public inputs', () => {
  const content = fixture(),
    source = prepareAnimation2(content),
    before = JSON.stringify(content);
  const scene = evaluateAnimation2(source, 'root', 480000, [
    { inputId: 'caption', value: 'New title' },
  ]);
  expect(scene.items.map((i) => i.id)).toEqual(['box', 'label']);
  expect(scene.items[0].matrix[4]).toBeCloseTo(130);
  expect(scene.items[0].matrix[5]).toBeCloseTo(155);
  expect(scene.items[0].opacity).toBe(0.5);
  expect(scene.items[0].clips).toHaveLength(1);
  expect((scene.items[1].layer as Extract<Layer2, { type: 'text' }>).text).toBe('New title');
  for (const tick of [960000, 0, 16000, 8000, 700001, 480000])
    evaluateAnimation2(source, 'root', tick);
  expect(
    evaluateAnimation2(source, 'root', 480000, [{ inputId: 'caption', value: 'New title' }]),
  ).toEqual(scene);
  content.compositions[0].layers[0].transform.x = 999;
  expect(evaluateAnimation2(source, 'root', 480000).items[0].matrix[4]).toBeCloseTo(130);
  expect(before).not.toBe(JSON.stringify(content));
});
it('uses explicit schema 2 nested terminal, loop and hide semantics with exact rational mapping', () => {
  const time = {
    sourceIn: 10,
    sourceOut: 30,
    rate: { numerator: 2, denominator: 3 },
    after: 'hold' as const,
  };
  expect(nestedTick2(29, time)).toBe(29);
  expect(nestedTick2(30, time)).toBe(30);
  expect(nestedTick2(33, { ...time, after: 'loop' })).toBe(12);
  expect(nestedTick2(30, { ...time, after: 'hide' })).toBeNull();
});
it('retains exact portable source bytes and refuses forged/missing/cyclic closure', () => {
  const child = fixture(),
    content = createAnimation2(),
    ref = {
      artifactId: 'source',
      versionId: 'v1',
      compositionId: 'root',
      contentHash: reuseHash(child),
    };
  content.sources = [{ ref, content: child }];
  content.compositions[0].layers = [
    {
      ...createAnimationLayer2('group', 'nested', 960000),
      type: 'composition',
      source: { type: 'exact', ref },
      time: {
        sourceIn: 0,
        sourceOut: 960000,
        rate: { numerator: 1, denominator: 1 },
        after: 'hold',
      },
    },
  ];
  expect(
    evaluateAnimation2(prepareAnimation2(content), 'root', 480000).items[0].instancePath,
  ).toEqual(['root', 'nested', 'box']);
  const forged = structuredClone(content);
  forged.sources[0].content.compositions[0].width++;
  expect(() => readAnimation2(forged)).toThrow('source-hash');
  const missing = structuredClone(content);
  missing.sources = [];
  expect(() => readAnimation2(missing)).toThrow('missing-source');
  const cyclic = createAnimation2();
  cyclic.compositions[0].layers = [
    {
      ...createAnimationLayer2('group', 'loop', 960000),
      type: 'composition',
      source: { type: 'local', compositionId: 'root' },
      time: {
        sourceIn: 0,
        sourceOut: 960000,
        rate: { numerator: 1, denominator: 1 },
        after: 'hold',
      },
    },
  ];
  expect(() => readAnimation2(cyclic)).toThrow('composition-cycle');
});
it('interpolates premultiplied linear-light colors and samples cubic motion endpoints', () => {
  expect(interpolateColor2('#000000', '#ffffff', 0.5)).toBe('#bcbcbcff');
  expect(interpolateColor2('#ff000000', '#0000ffff', 0.5)).toBe('#0000ff80');
  const path: Extract<Layer2, { type: 'path' }>['path'] = [
    ['M', 0, 0],
    ['C', 0, 100, 100, 100, 100, 0],
  ];
  expect(pointOnAnimationPath2(path, 0.5)).toMatchObject({ x: 50, y: 75, rotation: 0 });
  expect(pointOnAnimationPath2(path, 1).x).toBe(100);
});
for (const mutate of [
  (c: AnimationContent2) => {
    c.compositions[0].layers[2].clipId = 'box';
  },
  (c: AnimationContent2) => {
    c.compositions[0].tracks.push({
      id: 'position',
      layerId: 'box',
      property: 'x',
      keys: [{ id: 'position-key', tick: 0, value: 1, easing: { type: 'hold' } }],
    });
  },
  (c: AnimationContent2) => {
    c.publicInputs[0].target = { compositionId: 'root', layerId: 'box', property: 'opacity' };
    c.publicInputs[0].kind = 'number';
    c.publicInputs[0].default = 0.5;
  },
  (c: AnimationContent2) => {
    c.compositions[0].layers[0].parentId = 'label';
  },
  (c: AnimationContent2) => {
    (c.compositions[0].layers[1] as Extract<Layer2, { type: 'text' }>).fontAssetId = 'missing';
  },
  (c: AnimationContent2) => {
    c.compositions[0].frameRate.numerator = 29;
  },
])
  it('rejects inconsistent graph, property ownership, resources and frame grids', () => {
    const c = fixture();
    mutate(c);
    expect(() => readAnimation2(c)).toThrow();
  });
it('uses one guarded existing history operation for bulk key moves and refuses duplicate times atomically', () => {
  const content = fixture();
  content.compositions[0].tracks[0].keys[1].tick = 480000;
  const s = new EditorSession(content),
    scope = { canEdit: () => true };
  s.execute(
    animationCommand2(
      content,
      [
        {
          type: 'keys.move',
          compositionId: 'root',
          keys: [
            { trackId: 'fade', keyId: 'start' },
            { trackId: 'fade', keyId: 'end' },
          ],
          delta: 8000,
        },
      ],
      scope,
    ),
  );
  expect(s.content.compositions[0].tracks[0].keys.map((k) => k.tick)).toEqual([8000, 488000]);
  const moved = s.content;
  expect(() =>
    animationCommand2(
      moved,
      [
        {
          type: 'keys.move',
          compositionId: 'root',
          keys: [{ trackId: 'fade', keyId: 'end' }],
          delta: -480000,
        },
      ],
      scope,
    ),
  ).toThrow('key-time');
  expect(s.content).toEqual(moved);
  s.undo();
  expect(s.content).toEqual(content);
  expect(s.canUndo).toBe(false);
  s.redo();
  expect(s.content).toEqual(moved);
});
it('guards permission/stale/locked actions and keeps failed transactions out of history', () => {
  const content = fixture(),
    s = new EditorSession(content);
  let allowed = true;
  const command = animationCommand2(
    content,
    [{ type: 'layer.patch', compositionId: 'root', id: 'label', patch: { text: 'Edited' } }],
    { canEdit: () => allowed },
  );
  allowed = false;
  expect(() => s.execute(command)).toThrow('read-only');
  expect(s.canUndo).toBe(false);
  allowed = true;
  s.execute(command);
  expect(() => s.execute(command)).toThrow('stale');
  s.undo();
  expect(s.content).toEqual(content);
  s.redo();
  const locked = fixture();
  locked.compositions[0].layers[1].locked = true;
  expect(() =>
    animationCommand2(
      locked,
      [{ type: 'layer.patch', compositionId: 'root', id: 'label', patch: { text: 'No' } }],
      { canEdit: () => true },
    ),
  ).toThrow('locked');
});
it('upgrades only a draft through normal Undo without changing the original schema 1 source', () => {
  const old = createRectangleAnimation(),
    before = JSON.stringify(old),
    s = new EditorSession<ReturnType<typeof createRectangleAnimation> | AnimationContent2>(old);
  s.execute(upgradeAnimationCommand2(old, { canEdit: () => true }));
  expect(s.content.schemaVersion).toBe(2);
  s.undo();
  expect(s.content).toEqual(old);
  s.redo();
  expect(JSON.stringify(old)).toBe(before);
});
describe('base64', () => {
  for (const length of [0, 1, 2, 3, 4, 10000])
    it(`owns canonical bytes at length ${length}`, () => {
      const bytes = Uint8Array.from({ length }, (_, i) => i % 256);
      const encoded = encodeAnimationBase64(bytes);
      expect(decodeAnimationBase64(encoded)).toEqual(bytes);
      expect(hashAnimationBytes2(bytes)).toHaveLength(64);
    });
  for (const value of ['AA=A', 'AB==', 'AAB=', 'AAAA=', 'data:image/png;base64,AAAA'])
    it('refuses noncanonical or URL payloads', () =>
      expect(() => decodeAnimationBase64(value)).toThrow());
});

it('refuses expanded text and vector workloads before a scene or output is created', () => {
  const text = createAnimation2(),
    c = text.compositions[0];
  c.layers = Array.from({ length: 11 }, (_, i) => ({
    ...createAnimationLayer2('text', 'text-' + i, c.duration),
    type: 'text' as const,
    text: 'A'.repeat(20000),
    runs: [],
    width: 100,
    height: 100,
    fontSize: 16,
    lineHeight: 1.3,
    fill: '#000000',
    fontAssetId: null,
  }));
  expect(() => prepareAnimation2(text)).toThrow('expansion');
  const vector = createAnimation2(),
    root = vector.compositions[0];
  const shape = createAnimationLayer2('path', 'shape', root.duration);
  if (shape.type !== 'path') throw Error();
  shape.path = [
    ['M', 0, 0],
    ...Array.from({ length: 499 }, () => ['L', 1, 1] as ['L', number, number]),
  ];
  vector.compositions.push({ ...structuredClone(root), id: 'child', layers: [shape] });
  root.layers = Array.from({ length: 401 }, (_, i) => ({
    ...createAnimationLayer2('group', 'nested-' + i, root.duration),
    type: 'composition' as const,
    source: { type: 'local' as const, compositionId: 'child' },
    time: {
      sourceIn: 0,
      sourceOut: root.duration,
      rate: { numerator: 1, denominator: 1 },
      after: 'hold' as const,
    },
  }));
  expect(() => prepareAnimation2(vector)).toThrow('expansion');
});
it('requires each exact source to retain its own closure rather than borrow a sibling source', () => {
  const child = createAnimation2(),
    parent = createAnimation2(),
    root = createAnimation2();
  const childRef = {
    artifactId: 'child',
    versionId: 'v1',
    compositionId: 'root',
    contentHash: reuseHash(child),
  };
  parent.compositions[0].layers = [
    {
      ...createAnimationLayer2('group', 'nested', 960000),
      type: 'composition',
      source: { type: 'exact', ref: childRef },
      time: {
        sourceIn: 0,
        sourceOut: 960000,
        rate: { numerator: 1, denominator: 1 },
        after: 'hold',
      },
    },
  ];
  root.sources = [
    { ref: childRef, content: child },
    { ref: { ...childRef, artifactId: 'parent', contentHash: reuseHash(parent) }, content: parent },
  ];
  expect(() => readAnimation2(root)).toThrow('missing-source');
});
it('bounds clip graph expansion even when its dependency depth is small', () => {
  const content = createAnimation2(),
    c = content.compositions[0];
  for (let i = 0; i < 8; i++) {
    const mask = createAnimationLayer2('path', 'mask-' + i, c.duration),
      group = createAnimationLayer2('group', 'group-' + i, c.duration);
    if (i) {
      mask.parentId = 'group-' + (i - 1);
      group.parentId = mask.parentId;
    }
    group.clipId = mask.id;
    c.layers.push(mask, group);
  }
  expect(() => prepareAnimation2(content)).toThrow('clip-expansion');
});
