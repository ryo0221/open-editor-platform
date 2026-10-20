import { largeConsumerAnimationEmbed } from '../../../tests/fixtures/animation-retention';
import { inspectPlayableAnimationEmbed } from '@editor-platform/animation-core/v2';
import { slideAnimationPoster } from './animation-poster';
import { readFileSync } from 'node:fs';
import { posterLimitAnimation } from '../../../tests/fixtures/animation-poster';
import { createPlayableAnimationEmbed } from '@editor-platform/animation-core/v2';
import { playableAnimationPoster } from '@editor-platform/animation-player/v2';
import { expect, expectTypeOf, it } from 'vitest';
import { contentHash, clone } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import {
  createAnimationEmbed,
  createRectangleAnimation,
  inspectAnimationEmbed,
} from '@editor-platform/animation-core';
import {
  createDeck,
  isDeck,
  hasSlideReuse,
  slideDiff,
  slideDrawing,
  exportSlideSvg,
  updateObject,
  patchObjects,
  copiedObjects,
  pasteObjects,
  arrangeObjects,
  duplicateSlide,
  makeSlideObject,
  insertObject,
  type SlideInsertType,
  type SlideObject,
  placeSlideAnimation,
  replaceSlideAnimation,
} from '@editor-platform/slide/model';
import { slideEditorCodec } from '@editor-platform/collaboration-adapters';
import { captureSlideExportSnapshot, prepareSlidePptx } from '@editor-platform/slide-export';
import { acceptsExport } from '@editor-platform/export-core';
import { selectTemplateContent } from '@editor-platform/templates';

it('rejects image-only patches on Animation targets atomically while keeping image and geometry edits', async () => {
  const content = createRectangleAnimation(),
    deck = createDeck(),
    page = deck.slides[0];
  const embed = createAnimationEmbed(
    {
      artifactId: 'source',
      versionId: 'v1',
      contentHash: await contentHash(content),
      compositionId: 'root',
    },
    content,
    'Motion',
  );
  page.objects.push({ ...makeSlideObject('image', 0), id: 'image', src: 'before.png' });
  const initial = placeSlideAnimation(page.id, embed, 'motion').apply(deck);
  const reference: NonNullable<SlideObject['reference']> = {
    schemaVersion: 1,
    mode: 'fixed',
    fit: 'contain',
    source: { artifactId: 'data', domain: 'data', target: { kind: 'chart', viewId: 'default' } },
    snapshot: {
      artifactId: 'data',
      domain: 'data',
      versionId: 'v1',
      revision: 1,
      contentHash: await contentHash({}),
      content: {},
      dependencies: [],
    },
  };
  for (const patch of [
    { src: 'after.png' },
    { crop: { x: 1, y: 2, scale: 2 } },
    { imageFit: 'fill' as const },
    { reference },
  ]) {
    const session = new EditorSession(initial);
    session.execute(updateObject(page.id, 'image', { opacity: 0.5 }));
    session.undo();
    const before = session.content,
      revision = session.revision;
    for (const cmd of [
      updateObject(page.id, 'motion', patch),
      patchObjects(page.id, ['image', 'motion'], patch),
    ]) {
      expect(() => session.execute(cmd)).toThrow(/画像専用/);
      expect(session.content).toEqual(before);
      expect(session.revision).toEqual(revision);
      expect(session.canUndo).toBe(false);
      expect(session.canRedo).toBe(true);
    }
  }
  const session = new EditorSession(initial);
  session.execute(updateObject(page.id, 'image', { src: 'after.png' }));
  session.execute(
    patchObjects(page.id, ['image'], { crop: { x: 1, y: 2, scale: 2 }, imageFit: 'fill' }),
  );
  session.execute(
    updateObject(page.id, 'motion', {
      bounds: { x: 1, y: 2, width: 300, height: 200 },
      src: undefined,
      reference: undefined,
    }),
  );
  session.execute(
    patchObjects(page.id, ['image', 'motion'], { opacity: 0.5, crop: undefined, imageFit: 'fit' }),
  );
  expect(isDeck(session.content)).toBe(true);
  expect(session.content.slides[0].objects.find((o) => o.id === 'motion')?.animation).toEqual(
    embed,
  );
  for (let i = 0; i < 4; i++) session.undo();
  expect(session.content).toEqual(initial);
  session.redo();
  expect(session.content.slides[0].objects[0].src).toBe('after.png');
});

it('guards all public Animation copy commands at count and byte limits in a plain session', async () => {
  for (const large of [false, true]) {
    const source = createRectangleAnimation();
    if (large)
      source.compositions[0].tracks.push({
        id: 'x',
        layerId: 'group',
        property: 'x',
        keys: Array.from({ length: 9000 }, (_, i) => ({
          id: `key-${i}`.padEnd(128, 'x'),
          tick: i,
          value: i,
          easing: { type: 'linear' as const },
        })),
      });
    const embed = createAnimationEmbed(
      {
        artifactId: 'source',
        versionId: 'v1',
        contentHash: await contentHash(source),
        compositionId: 'root',
      },
      source,
      'Motion',
    );
    const count = large ? Math.floor((8 * 1024 * 1024) / inspectAnimationEmbed(embed).bytes) : 16;
    expect(count).toBeLessThanOrEqual(16);
    const deck = createDeck(),
      page = deck.slides[0];
    const object = placeSlideAnimation(page.id, embed, 'motion').apply(deck).slides[0].objects[0];
    page.objects = Array.from({ length: count }, (_, i) => ({ ...object, id: `motion-${i}` }));
    expect(isDeck(deck)).toBe(true);
    const session = new EditorSession(deck),
      before = session.content,
      revision = session.revision;
    for (const copy of [
      pasteObjects(page.id, [object]),
      arrangeObjects(page.id, ['motion-0'], 'duplicate'),
      duplicateSlide(page.id),
    ]) {
      expect(() => session.execute(copy)).toThrow(/保持契約または上限/);
      expect(session.content).toEqual(before);
      expect(session.revision).toEqual(revision);
      expect(session.canUndo).toBe(false);
      expect(session.canRedo).toBe(false);
    }
  }
}, 30000);

it('rejects clipboard reuse collisions, malformed snapshots and contradictory retained pins atomically', async () => {
  const source = createRectangleAnimation(),
    deck = createDeck(),
    page = deck.slides[0];
  const embed = createAnimationEmbed(
    {
      artifactId: 'source',
      versionId: 'v1',
      contentHash: await contentHash(source),
      compositionId: 'root',
    },
    source,
    'Motion',
  );
  const animated = placeSlideAnimation(page.id, embed, 'motion').apply(deck),
    object = animated.slides[0].objects[0];
  const reuse = {
    ...deck,
    reuse: { schemaVersion: 1 as const, instances: [], closures: [], artifactMode: 'dark' },
  };
  source.compositions[0].layers[0].transform.x = 99;
  const conflicting = createAnimationEmbed(
    { ...embed.source, contentHash: await contentHash(source) },
    source,
    'Changed bytes',
  );
  for (const [initial, pasted] of [
    [reuse, object],
    [
      deck,
      {
        ...object,
        animation: { ...embed, source: { ...embed.source, contentHash: '0'.repeat(64) } },
      },
    ],
    [animated, { ...object, animation: conflicting }],
  ] as const) {
    expect(isDeck(initial)).toBe(true);
    const session = new EditorSession(initial),
      before = session.content,
      revision = session.revision;
    expect(() => session.execute(pasteObjects(page.id, [pasted]))).toThrow(/保持契約または上限/);
    expect(session.content).toEqual(before);
    expect(session.revision).toEqual(revision);
    expect(session.canUndo).toBe(false);
  }
});

it('keeps exact pins and reversible history for supported object and whole-slide copies', async () => {
  const source = createRectangleAnimation(),
    deck = createDeck(),
    page = deck.slides[0];
  const embed = createAnimationEmbed(
    {
      artifactId: 'source',
      versionId: 'v1',
      contentHash: await contentHash(source),
      compositionId: 'root',
    },
    source,
    'Motion',
  );
  const animated = placeSlideAnimation(page.id, embed, 'motion').apply(deck);
  for (const copy of [
    pasteObjects(page.id, animated.slides[0].objects),
    arrangeObjects(page.id, ['motion'], 'duplicate'),
    duplicateSlide(page.id),
  ]) {
    const session = new EditorSession(animated);
    session.execute(copy);
    const copied = session.content;
    expect(isDeck(copied)).toBe(true);
    const objects = copied.slides.flatMap((s) => s.objects);
    expect(objects).toHaveLength(2);
    expect(new Set(objects.map((o) => o.id)).size).toBe(2);
    expect(objects.every((o) => JSON.stringify(o.animation) === JSON.stringify(embed))).toBe(true);
    session.undo();
    expect(session.content).toEqual(animated);
    session.redo();
    expect(session.content).toEqual(copied);
  }
});

it('retains versions through source mutation, replacement, geometry, copy and Undo', async () => {
  const source = createRectangleAnimation(),
    hash = await contentHash(source);
  const old = createAnimationEmbed(
    { artifactId: 'source', versionId: 'v1', contentHash: hash, compositionId: 'root' },
    source,
    'Motion',
  );
  const deck = createDeck(),
    pageId = deck.slides[0].id,
    session = new EditorSession(deck);
  session.execute(placeSlideAnimation(pageId, old, 'animation'));
  expect(isDeck(session.content)).toBe(true);
  expect(slideDrawing(session.content.slides[0].objects[0]).kind).toBe('image');
  source.compositions[0].layers[0].transform.x = 120;
  expect(
    session.content.slides[0].objects[0].animation?.snapshot.compositions[0].layers[0].transform.x,
  ).toBe(0);
  const newer = createAnimationEmbed(
    { ...old.source, versionId: 'v2', contentHash: await contentHash(source) },
    source,
    'Motion',
  );
  session.execute(
    updateObject(pageId, 'animation', { bounds: { x: 20, y: 30, width: 400, height: 250 } }),
  );
  const before = clone(session.content);
  session.execute(replaceSlideAnimation(pageId, 'animation', old, newer));
  expect(session.content.slides[0].objects[0].bounds).toEqual(before.slides[0].objects[0].bounds);
  session.undo();
  expect(session.content).toEqual(before);
  session.redo();
  expect(session.content.slides[0].objects[0].animation?.source.versionId).toBe('v2');
  const copied = copiedObjects(session.content.slides[0], ['animation']);
  const pasted = pasteObjects(pageId, copied).apply(session.content);
  expect(isDeck(pasted)).toBe(true);
  expect(pasted.slides[0].objects[1].animation).toEqual(newer);
  expect(pasted.slides[0].objects[1].id).not.toBe('animation');
  expect(() => session.execute(replaceSlideAnimation(pageId, 'animation', old, old))).toThrow(
    /変更/,
  );
  expect(() => exportSlideSvg(session.content, session.content.slides[0])).toThrow(/未対応/);
  expect(slideEditorCodec.validate(session.content)).toBe(false);
  expect(() => selectTemplateContent('slide', session.content)).toThrow();
  const plan = await prepareSlidePptx(
    await captureSlideExportSnapshot(session.content, { kind: 'local-draft', artifactId: 'deck' }),
    {
      pageIds: 'all',
      includeHiddenSlides: false,
      includeNotes: false,
      fontProfileId: 'not-needed',
      fallback: 'element-png',
    },
    {},
  );
  expect(plan.report.diagnostics).toContainEqual(
    expect.objectContaining({ severity: 'error', message: expect.stringContaining('Animation') }),
  );
  expect(
    acceptsExport(plan.report, {
      planHash: plan.report.planHash,
      acceptedDiagnosticIds: plan.report.diagnostics.map((d) => d.id),
    }),
  ).toBe(false);
  for (const basis of [
    { kind: 'confirmed' as const, artifactId: 'deck', revision: 12 },
    { kind: 'saved-version' as const, artifactId: 'deck', versionId: 'saved-2' },
  ]) {
    const snapshot = await captureSlideExportSnapshot(session.content, basis);
    const refusal = await prepareSlidePptx(
      snapshot,
      {
        pageIds: 'all',
        includeHiddenSlides: false,
        includeNotes: false,
        fontProfileId: 'not-needed',
        fallback: 'element-png',
      },
      {},
    );
    expect(refusal.report.basis).toEqual(snapshot.basis);
    expect(refusal.report.planHash).not.toBe(plan.report.planHash);
    expect(refusal.report.diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'error' }),
    );
    expect(
      acceptsExport(refusal.report, {
        planHash: refusal.report.planHash,
        acceptedDiagnosticIds: refusal.report.diagnostics.map((d) => d.id),
      }),
    ).toBe(false);
  }
  expect(plan.report.basis).toEqual({
    kind: 'local-draft',
    artifactId: 'deck',
    contentHash: await contentHash(session.content),
  });
  const broken = clone(session.content);
  broken.slides[0].objects[0].animation!.snapshot.compositions[0].duration--;
  expect(isDeck(broken)).toBe(false);
  const overloaded = clone(session.content);
  overloaded.slides[0].objects = Array.from({ length: 17 }, (_, i) => ({
    ...clone(overloaded.slides[0].objects[0]),
    id: 'a' + i,
  }));
  expect(isDeck(overloaded)).toBe(false);
});

it('keeps Animation state out of generic single and multi-object updates in plain sessions', async () => {
  expectTypeOf<
    Extract<keyof Parameters<typeof updateObject>[2], 'type' | 'animation'>
  >().toEqualTypeOf<never>();
  expectTypeOf<
    Extract<keyof Parameters<typeof patchObjects>[2], 'type' | 'animation'>
  >().toEqualTypeOf<never>();
  const content = createRectangleAnimation();
  const embed = createAnimationEmbed(
    {
      artifactId: 'source',
      versionId: 'v1',
      contentHash: await contentHash(content),
      compositionId: 'root',
    },
    content,
    'Motion',
  );
  const deck = createDeck(),
    pageId = deck.slides[0].id;
  deck.slides[0].objects.push({ ...makeSlideObject('text', 0), id: 'static' });
  const animated = placeSlideAnimation(pageId, embed, 'motion').apply(deck);
  for (const [initial, target] of [
    [deck, 'static'],
    [animated, 'motion'],
  ] as const) {
    const session = new EditorSession(initial),
      before = session.content,
      revision = session.revision;
    for (const patch of [
      { animation: embed },
      { type: 'animation', animation: embed },
      { type: 'shape' },
      { animation: undefined },
    ]) {
      expect(() =>
        session.execute(Reflect.apply(updateObject, undefined, [pageId, target, patch])),
      ).toThrow(/専用コマンド/);
      expect(() =>
        session.execute(Reflect.apply(patchObjects, undefined, [pageId, [target], patch])),
      ).toThrow(/専用コマンド/);
      expect(session.content).toEqual(before);
      expect(session.revision).toEqual(revision);
      expect(session.canUndo).toBe(false);
    }
    session.execute(
      updateObject(pageId, target, { bounds: { x: 1, y: 2, width: 300, height: 200 } }),
    );
    session.execute(patchObjects(pageId, [target], { opacity: 0.5 }));
    expect(isDeck(session.content)).toBe(true);
    expect(session.content.slides[0].objects.find((o) => o.id === target)?.animation).toEqual(
      target === 'motion' ? embed : undefined,
    );
    session.undo();
    session.undo();
    expect(session.content).toEqual(before);
  }
});

it('refuses Animation placement into reuse-bearing decks without changing the session', async () => {
  const content = createRectangleAnimation(),
    animation = createAnimationEmbed(
      {
        artifactId: 'animation',
        versionId: 'v1',
        contentHash: await contentHash(content),
        compositionId: 'root',
      },
      content,
      'Motion',
    );
  const deck = createDeck();
  deck.reuse = { schemaVersion: 1, instances: [], closures: [], artifactMode: 'dark' };
  expect(isDeck(deck)).toBe(true);
  expect(hasSlideReuse(deck)).toBe(true);
  const session = new EditorSession(deck),
    before = session.content,
    revision = session.revision;
  expect(() =>
    session.execute(placeSlideAnimation(deck.slides[0].id, animation, 'motion')),
  ).toThrow(/未対応/);
  expect(session.content).toEqual(before);
  expect(session.revision).toEqual(revision);
  expect(session.canUndo).toBe(false);
  deck.reuse = { schemaVersion: 1, instances: [], closures: [] };
  expect(hasSlideReuse(deck)).toBe(false);
  expect(isDeck(placeSlideAnimation(deck.slides[0].id, animation, 'motion').apply(deck))).toBe(
    true,
  );
});

it('describes retained Animation identity and playback changes even when posters match', async () => {
  const content = createRectangleAnimation();
  content.compositions[0].layers.push({
    id: 'rect',
    type: 'rect',
    parentId: 'group',
    start: 0,
    end: 960000,
    width: 80,
    height: 80,
    fill: '#ff0000',
    transform: { ...content.compositions[0].layers[0].transform },
  });
  content.compositions[0].tracks.push({
    id: 'move',
    layerId: 'rect',
    property: 'x',
    keys: [
      { id: 'start', tick: 0, value: 0, easing: { type: 'linear' } },
      { id: 'end', tick: 960000, value: 100, easing: { type: 'hold' } },
    ],
  });
  const embed = createAnimationEmbed(
    {
      artifactId: 'source',
      versionId: 'v1',
      contentHash: await contentHash(content),
      compositionId: 'root',
    },
    content,
    'Motion',
  );
  const deck = createDeck(),
    before = placeSlideAnimation(deck.slides[0].id, embed, 'motion').apply(deck);
  const motion = clone(content);
  motion.compositions[0].tracks[0].keys[1].value = 300;
  const newer = createAnimationEmbed(
    { ...embed.source, versionId: 'v2', contentHash: await contentHash(motion) },
    motion,
    'Motion',
  );
  for (const replacement of [
    newer,
    { ...embed, source: { ...embed.source, artifactId: 'another-source', versionId: 'pin-v2' } },
    { ...embed, trigger: 'manual' as const },
    { ...embed, loop: true },
    { ...embed, posterTick: 1 },
  ]) {
    const after = replaceSlideAnimation(deck.slides[0].id, 'motion', embed, replacement).apply(
        before,
      ),
      change = slideDiff(before, after).changes;
    expect(change).toHaveLength(1);
    expect(change[0].before).not.toBe(change[0].after);
    expect(change[0].before).toContain('Source version: v1');
    expect(change[0].after).toContain(`Source content hash: ${replacement.source.contentHash}`);
    expect(change[0].after).toContain(`Composition: ${replacement.source.compositionId}`);
    expect(change[0].after).toContain(`Poster tick: ${replacement.posterTick} · Fit: contain`);
    expect(change[0].after).toContain(
      `Playback trigger: ${replacement.trigger} · Loop: ${replacement.loop}`,
    );
    if (replacement.posterTick === 0)
      expect(slideDrawing(before.slides[0].objects[0]).src).toBe(
        slideDrawing(after.slides[0].objects[0]).src,
      );
  }
});

it('requires retained Animation placement rather than generic constructors or discriminant patches', () => {
  expectTypeOf<Parameters<typeof makeSlideObject>[0]>().toEqualTypeOf<SlideInsertType>();
  expectTypeOf<Parameters<typeof insertObject>[1]>().toEqualTypeOf<SlideInsertType>();
  expectTypeOf<'animation'>().not.toMatchTypeOf<SlideInsertType>();
  expectTypeOf<'type' | 'animation'>().not.toMatchTypeOf<
    keyof NonNullable<Parameters<typeof insertObject>[2]>
  >();
  expect(() => Reflect.apply(makeSlideObject, undefined, ['animation', 0])).toThrow(
    /placeSlideAnimation/,
  );
  const session = new EditorSession(createDeck());
  const before = session.content,
    revision = session.revision,
    pageId = before.slides[0].id;
  expect(() =>
    session.execute(Reflect.apply(insertObject, undefined, [pageId, 'animation'])),
  ).toThrow(/placeSlideAnimation/);
  for (const patch of [{ type: 'animation' }, { animation: {} }])
    expect(() =>
      session.execute(Reflect.apply(insertObject, undefined, [pageId, 'shape', patch])),
    ).toThrow();
  expect(session.content).toEqual(before);
  expect(session.revision).toEqual(revision);
  expect(session.canUndo).toBe(false);
});

// Multi-MiB image fixtures: coverage instrumentation slows their byte loops several-fold.
it('keeps an admitted deck usable when its Animation poster exceeds the SVG output limit', async () => {
  const content = posterLimitAnimation(readFileSync('tests/fixtures/office/images/quadrants.png'));
  const embed = createPlayableAnimationEmbed(
    {
      artifactId: 'large-poster',
      versionId: 'v1',
      compositionId: 'root',
      contentHash: await contentHash(content),
    },
    content,
    'Large poster',
  );
  expect(() => playableAnimationPoster(embed)).toThrow('Animation SVG size limit');
  const original = createDeck();
  const placed = placeSlideAnimation(original.slides[0].id, embed, 'oversize').apply(original);
  expect(isDeck(placed)).toBe(true);
  const drawing = slideDrawing(placed.slides[0].objects[0]);
  expect(drawing.alt).toContain('Animation SVG size limit');
  expect(decodeURIComponent(drawing.src!)).toContain('Animation preview unavailable');
}, 30000);

it('revalidates mutable poster input instead of retaining a stale successful render', async () => {
  const content = createRectangleAnimation();
  const embed = createAnimationEmbed(
    {
      artifactId: 'mutable-poster',
      versionId: 'v1',
      compositionId: 'root',
      contentHash: await contentHash(content),
    },
    content,
    'Mutable poster',
  );
  const mutable = structuredClone(embed);
  expect(slideAnimationPoster(mutable).status).toBe('ready');
  mutable.snapshot.compositions[0].layers[0].transform.x += 100;
  expect(slideAnimationPoster(mutable)).toMatchObject({
    status: 'unavailable',
    message: expect.stringContaining('hash'),
  });
});

it('counts complete consumer input JSON toward the Slide retention budget', () => {
  const large = largeConsumerAnimationEmbed();
  expect(inspectPlayableAnimationEmbed(large).bytes).toBeLessThan(1024 * 1024);
  expect(new TextEncoder().encode(JSON.stringify(large)).byteLength).toBeGreaterThan(
    8 * 1024 * 1024,
  );
  const blank = createDeck();
  const record = structuredClone(
    placeSlideAnimation(blank.slides[0].id, { ...large, inputs: [] }, 'consumer').apply(blank),
  );
  record.slides[0].objects[0].animation = large;
  expect(isDeck(record)).toBe(false);
  record.slides[0].objects[0].animation = { ...large, inputs: large.inputs.slice(0, 180) };
  expect(isDeck(record)).toBe(true);
});
