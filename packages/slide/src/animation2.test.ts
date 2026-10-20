import { expect, it } from 'vitest';
import { reuseHash } from '@editor-platform/reuse-core';
import {
  createAnimation2,
  createAnimationLayer2,
  createPlayableAnimationEmbed,
  inspectPlayableAnimationEmbed,
  adoptPlayableAnimationEmbed,
} from '@editor-platform/animation-core/v2';
import { Authority, initial, type Principal } from '@editor-platform/collaboration-core';
import { slideEditorCodec, prepareEditorCommand } from '@editor-platform/collaboration-adapters';
import {
  createDeck,
  placeSlideAnimation,
  replaceSlideAnimation,
  updateObject,
  slideDiff,
  isDeck,
} from './model';

it.each(['retained', 'nested', 'root-retained'] as const)(
  'rejects contradictory immutable identities across deck objects (%s)',
  (mode) => {
    const leaf = createAnimation2(),
      changed = createAnimation2();
    changed.compositions[0].name = 'Changed immutable version';
    const ref = (content: typeof leaf, artifactId: string) => ({
      artifactId,
      versionId: 'v1',
      compositionId: 'root',
      contentHash: reuseHash(content),
    });
    function wrap(content: typeof leaf, owner: string) {
      const root = createAnimation2();
      root.sources = [{ ref: ref(content, 'shared'), content }];
      if (mode === 'nested') {
        const outer = createAnimation2();
        outer.sources = [{ ref: ref(root, owner + '-middle'), content: root }];
        return outer;
      }
      return root;
    }
    const first = mode === 'root-retained' ? leaf : wrap(leaf, 'first'),
      second = wrap(changed, 'second'),
      embedA = createPlayableAnimationEmbed(
        ref(first, mode === 'root-retained' ? 'shared' : 'first'),
        first,
        'First',
      ),
      embedB = createPlayableAnimationEmbed(ref(second, 'second'), second, 'Second'),
      deck = createDeck(),
      page = deck.slides[0];
    page.objects = [];
    const placed = placeSlideAnimation(page.id, embedA, 'first-object').apply(deck),
      bytes = JSON.stringify(placed),
      imported = structuredClone(placed);
    imported.slides.push({
      ...structuredClone(imported.slides[0]),
      id: 'other-page',
      objects: [
        {
          ...structuredClone(imported.slides[0].objects[0]),
          id: 'second-object',
          animation: embedB,
        },
      ],
    });
    expect(inspectPlayableAnimationEmbed(embedB).embed).toEqual(embedB);
    expect(isDeck(imported)).toBe(false);
    expect(() => placeSlideAnimation(page.id, embedB, 'second-object').apply(placed)).toThrow(
      /アニメーション/,
    );
    expect(JSON.stringify(placed)).toBe(bytes);
    imported.slides[1].objects[0].animation = embedA;
    expect(isDeck(imported)).toBe(true);
  },
);
function fixture() {
  const c = createAnimation2();
  c.compositions[0].layers = [createAnimationLayer2('text', 'caption', 960000)];
  c.publicInputs = [
    {
      id: 'caption-input',
      name: 'Caption',
      kind: 'text',
      default: 'Default',
      min: 0,
      max: 0,
      target: { compositionId: 'root', layerId: 'caption', property: 'text' },
    },
  ];
  return c;
}
const source = (content: ReturnType<typeof fixture>, versionId: string) => ({
  artifactId: 'source',
  versionId,
  contentHash: reuseHash(content),
  compositionId: 'root',
});
it('retains consumer inputs and exact old bytes through source updates and selective adoption Undo while preserving peer placement', () => {
  const old = fixture(),
    oldRef = source(old, 'v1'),
    created = createPlayableAnimationEmbed(oldRef, old, 'Title');
  if (created.format !== 'animation-embed-2') throw Error();
  const current = inspectPlayableAnimationEmbed({
    ...created,
    inputs: [{ inputId: 'caption-input', value: 'Consumer' }],
  }).embed;
  const next = structuredClone(old);
  next.publicInputs[0].default = 'Changed default';
  next.compositions[0].layers[0].transform.y = 200;
  const adopted = adoptPlayableAnimationEmbed(current, source(next, 'v2'), next);
  expect(adopted.format === 'animation-embed-2' && adopted.inputs).toEqual([
    { inputId: 'caption-input', value: 'Consumer' },
  ]);
  expect(current.source).toEqual(oldRef);
  expect(current.snapshot).toEqual(old);
  const deck = createDeck(),
    page = deck.slides[0];
  page.objects = [];
  const embedded = placeSlideAnimation(page.id, current, 'animation').apply(deck);
  const authority = new Authority(slideEditorCodec, initial('slide', slideEditorCodec, embedded)),
    A: Principal = { actorId: 'A', clientId: 'A', sessionId: 'A', writable: true, scopes: ['*'] },
    B = { ...A, actorId: 'B', clientId: 'B', sessionId: 'B' };
  const a = prepareEditorCommand(
    slideEditorCodec,
    authority.snapshot(),
    A,
    replaceSlideAnimation(page.id, 'animation', current, adopted),
  )!;
  const b = prepareEditorCommand(
    slideEditorCodec,
    authority.snapshot(),
    B,
    updateObject(page.id, 'animation', { bounds: { x: 400, y: 80, width: 200, height: 120 } }),
  )!;
  expect(authority.commit(A, a).status).toBe('accepted');
  expect(authority.commit(B, b).status).toBe('accepted');
  expect(authority.undo(A, a.operationId).status).toBe('accepted');
  const object = authority.snapshot().content.slides[0].objects[0];
  expect(object.animation).toEqual(current);
  expect(object.bounds.x).toBe(400);
  const changed = replaceSlideAnimation(
    page.id,
    'animation',
    current,
    inspectPlayableAnimationEmbed({
      ...current,
      inputs: [{ inputId: 'caption-input', value: 'Different' }],
    }).embed,
  ).apply(embedded);
  expect(
    slideDiff(embedded, changed).changes.some((change) => change.after?.includes('Different')),
  ).toBe(true);
});
it('refuses removed or incompatible public input declarations rather than resetting consumer overrides', () => {
  const content = fixture(),
    embed = createPlayableAnimationEmbed(source(content, 'v1'), content, 'Title');
  if (embed.format !== 'animation-embed-2') throw Error();
  const current = { ...embed, inputs: [{ inputId: 'caption-input', value: 'Consumer' }] };
  content.publicInputs = [];
  expect(() => adoptPlayableAnimationEmbed(current, source(content, 'v2'), content)).toThrow(
    'unknown-input',
  );
});
it.each(['color', 'text'] as const)(
  'refuses a %s override when its declaration changes kind',
  (kind) => {
    const old = fixture();
    old.publicInputs[0] = {
      ...old.publicInputs[0],
      kind,
      default: '#ff0000',
      target: {
        compositionId: 'root',
        layerId: 'caption',
        property: kind === 'color' ? 'fill' : 'text',
      },
    };
    const embed = createPlayableAnimationEmbed(source(old, 'v1'), old, 'Title');
    if (embed.format !== 'animation-embed-2') throw Error();
    const current = { ...embed, inputs: [{ inputId: 'caption-input', value: '#ff0000' }] };
    const bytes = JSON.stringify(current),
      candidate = structuredClone(old);
    candidate.publicInputs[0].kind = kind === 'color' ? 'text' : 'color';
    candidate.publicInputs[0].target.property = kind === 'color' ? 'text' : 'fill';
    expect(() => adoptPlayableAnimationEmbed(current, source(candidate, 'v2'), candidate)).toThrow(
      'input-adoption-conflict',
    );
    expect(JSON.stringify(current)).toBe(bytes);
    candidate.publicInputs = structuredClone(old.publicInputs);
    candidate.publicInputs[0].default = '#00ff00';
    const accepted = adoptPlayableAnimationEmbed(current, source(candidate, 'v2'), candidate);
    expect(accepted.format === 'animation-embed-2' && accepted.inputs).toEqual(current.inputs);
  },
);
it('retains only consumer inputs reachable through the selected local composition closure on new writes', () => {
  const content = fixture();
  for (const id of ['child', 'other']) {
    content.compositions.push({
      ...structuredClone(content.compositions[0]),
      id,
      layers: [createAnimationLayer2('text', `${id}-caption`, 960000)],
    });
    content.publicInputs.push({
      ...content.publicInputs[0],
      id: `${id}-input`,
      name: id,
      target: { compositionId: id, layerId: `${id}-caption`, property: 'text' },
    });
  }
  content.compositions[0].layers.push({
    ...createAnimationLayer2('group', 'child-instance', 960000),
    type: 'composition',
    source: { type: 'local', compositionId: 'child' },
    time: { sourceIn: 0, sourceOut: 960000, rate: { numerator: 1, denominator: 1 }, after: 'hold' },
  });
  const created = createPlayableAnimationEmbed(source(content, 'v1'), content, 'Multiple');
  if (created.format !== 'animation-embed-2') throw Error();
  const current = {
    ...created,
    inputs: [
      { inputId: 'caption-input', value: 'Root' },
      { inputId: 'child-input', value: 'Child' },
      { inputId: 'other-input', value: 'Ignored legacy value' },
    ],
  };
  const bytes = JSON.stringify(current);
  expect(inspectPlayableAnimationEmbed(current).embed).toEqual(current);
  const deck = createDeck(),
    placed = placeSlideAnimation(deck.slides[0].id, current, 'instance').apply(deck);
  const result = placed.slides[0].objects.find((o) => o.id === 'instance')!.animation!;
  expect(result.format === 'animation-embed-2' && result.inputs.map((v) => v.inputId)).toEqual([
    'caption-input',
    'child-input',
  ]);
  const candidate = structuredClone(content);
  candidate.publicInputs[0].kind = 'color';
  candidate.publicInputs[0].default = '#ff0000';
  candidate.publicInputs[0].target.property = 'fill';
  const adopted = adoptPlayableAnimationEmbed(
    current,
    { ...source(candidate, 'v2'), compositionId: 'child' },
    candidate,
  );
  expect(adopted.format === 'animation-embed-2' && adopted.inputs).toEqual([
    { inputId: 'child-input', value: 'Child' },
  ]);
  expect(JSON.stringify(current)).toBe(bytes);
  expect(result.snapshot).toEqual(content);
});
