import { commitVersion, createArtifact, updateDraft } from '@editor-platform/artifact-core';
import { EditorSession } from '@editor-platform/editor-core';
import { describe, expect, it } from 'vitest';
import {
  addSlide,
  arrangeObjects,
  createDeck,
  deleteObjects,
  deleteSlide,
  duplicateSlide,
  inspectSlideDeck,
  isDeck,
  makeSlideObject,
  migrateDeck,
  prepareSlideMotionCommit,
  slideMotionCommand,
  slideMotionState,
  slidePlaybackPages,
  slideStepTiming,
  type SlideContent,
  type SlideEffectValue,
  type SlideMotionOperation,
} from './model';

function deckWithObjects() {
  const deck = createDeck();
  deck.slides[0] = {
    ...deck.slides[0],
    id: 'page',
    objects: ['a', 'b', 'c'].map((id, i) => ({ ...makeSlideObject('shape', i), id })),
  };
  return deck;
}

function fade(targetId: string, trigger: SlideEffectValue['trigger'] = 'on-click') {
  return {
    targetId,
    trigger,
    phase: 'enter' as const,
    effect: 'fade' as const,
    delayMs: 0,
    durationMs: 100,
  };
}

function edit(deck: SlideContent, operation: SlideMotionOperation) {
  return slideMotionCommand(operation).apply(deck);
}

function insertStep(deck: SlideContent, ...values: SlideEffectValue[]) {
  return edit(deck, {
    type: 'slide.step.insert',
    slideId: 'page',
    effects: values.map((value) => ({ value })),
  });
}

function setHold(deck: SlideContent, holdSeconds: number | null, stepId?: string) {
  return edit(deck, { type: 'slide.export.mp4.state-hold', slideId: 'page', stepId, holdSeconds });
}

describe('v3 motion commands', () => {
  it.each([1, 2] as const)(
    'upgrades only the changed v%s draft, with repeatable IDs and Undo/Redo',
    async (schemaVersion) => {
      const legacy = { ...deckWithObjects(), schemaVersion };
      const artifact = await commitVersion(createArtifact('slide', 'Legacy', legacy), null, null);
      const session = new EditorSession<SlideContent>(legacy);
      const insert = slideMotionCommand({
        type: 'slide.step.insert',
        slideId: 'page',
        effects: [{ value: fade('a') }],
      });
      const expected = insert.apply(legacy);
      session.execute(insert);
      const current = session.content;
      const step = current.slides[0].steps![0];
      expect(step.id).toMatch(/^step_[\da-f-]{36}$/);
      expect(step.effects[0].id).toMatch(/^effect_[\da-f-]{36}$/);
      expect(current).toEqual(expected);
      expect(current.schemaVersion).toBe(3);
      expect(current.slides[0].objects).toEqual(legacy.slides[0].objects);
      expect(isDeck(JSON.parse(JSON.stringify(current)))).toBe(true);
      expect(migrateDeck(current)).toBe(current);
      expect(() => insert.apply(current)).toThrow('duplicate-id');
      const saved = updateDraft<SlideContent>(artifact, current);
      expect(saved.versions).toEqual(artifact.versions);
      expect(saved.versions[0].content).toEqual(legacy);
      expect(session.undo()).toEqual(legacy);
      expect(session.redo()).toEqual(current);
    },
  );

  it('keeps step IDs and holds while moving steps and rejects a broken visibility sequence', () => {
    let deck = insertStep(deckWithObjects(), fade('a'));
    deck = insertStep(deck, { ...fade('a'), phase: 'exit' });
    deck = insertStep(deck, fade('a'));
    const [enter, exit, reenter] = deck.slides[0].steps!;
    deck = setHold(deck, 2, reenter.id);
    const session = new EditorSession(deck);
    expect(() =>
      session.execute(
        slideMotionCommand({
          type: 'slide.step.delete',
          slideId: 'page',
          stepId: exit.id,
        }),
      ),
    ).toThrow('invalid-visibility');
    expect(() =>
      session.execute(
        slideMotionCommand({
          type: 'slide.step.move',
          slideId: 'page',
          stepId: exit.id,
        }),
      ),
    ).toThrow('invalid-visibility');
    expect(session.content).toEqual(deck);
    expect(session.canUndo).toBe(false);

    const movable = insertStep(deck, fade('b'));
    const last = movable.slides[0].steps![3];
    const moved = edit(movable, {
      type: 'slide.step.move',
      slideId: 'page',
      stepId: last.id,
      beforeStepId: enter.id,
    });
    expect(moved.slides[0].steps!.map(({ id }) => id)).toEqual([
      last.id,
      enter.id,
      exit.id,
      reenter.id,
    ]);
    expect(moved.exportSettings).toEqual(movable.exportSettings);
    expect(
      edit(moved, { type: 'slide.step.delete', slideId: 'page', stepId: reenter.id })
        .exportSettings,
    ).toBeUndefined();
  });

  it('makes first-effect trigger changes and removes holds in the same Undo entry', () => {
    const legacy = deckWithObjects();
    let deck = insertStep(legacy, fade('a'), fade('b', 'after-previous'));
    const [step] = deck.slides[0].steps!;
    const [first, second] = step.effects;
    deck = setHold(deck, 2.125, step.id);
    const session = new EditorSession(deck);
    session.execute(
      slideMotionCommand({
        type: 'slide.effect.insert',
        slideId: 'page',
        stepId: step.id,
        beforeEffectId: first.id,
        previousFirstTrigger: 'with-previous',
        value: fade('c'),
      }),
    );
    const inserted = session.content.slides[0].steps![0].effects;
    expect(inserted.map(({ targetId, trigger }) => [targetId, trigger])).toEqual([
      ['c', 'on-click'],
      ['a', 'with-previous'],
      ['b', 'after-previous'],
    ]);
    expect(session.undo()).toEqual(deck);
    session.execute(
      slideMotionCommand({
        type: 'slide.effect.update',
        slideId: 'page',
        stepId: step.id,
        effectId: second.id,
        value: { ...fade('b', 'with-previous'), durationMs: 707 },
      }),
    );
    expect(session.content.slides[0].steps![0].effects[1]).toMatchObject({
      id: second.id,
      durationMs: 707,
      trigger: 'with-previous',
    });
    session.execute(
      slideMotionCommand({
        type: 'slide.effect.delete',
        slideId: 'page',
        stepId: step.id,
        effectId: first.id,
      }),
    );
    const promoted = session.content;
    expect(promoted.slides[0].steps![0].effects).toMatchObject([
      { id: second.id, trigger: 'on-click' },
    ]);
    expect(promoted.exportSettings).toEqual(deck.exportSettings);
    session.execute(
      slideMotionCommand({
        type: 'slide.effect.delete',
        slideId: 'page',
        stepId: step.id,
        effectId: second.id,
      }),
    );
    expect(session.content.slides[0].steps).toBeUndefined();
    expect(session.content.exportSettings).toBeUndefined();
    expect(session.undo()).toEqual(promoted);
  });

  it('moves an effect within a step, into a new step, and into another step without changing its ID', () => {
    let deck = insertStep(deckWithObjects(), fade('a'), fade('b', 'with-previous'));
    const [step] = deck.slides[0].steps!;
    const [first, second] = step.effects;
    deck = setHold(deck, 4, step.id);
    const within = edit(deck, {
      type: 'slide.effect.move',
      slideId: 'page',
      stepId: step.id,
      effectId: second.id,
      trigger: 'on-click',
      destination: {
        stepId: step.id,
        beforeEffectId: first.id,
        previousFirstTrigger: 'after-previous',
      },
    });
    expect(within.slides[0].steps![0]).toMatchObject({
      id: step.id,
      effects: [
        { id: second.id, trigger: 'on-click' },
        { id: first.id, trigger: 'after-previous' },
      ],
    });
    expect(within.exportSettings).toEqual(deck.exportSettings);
    let split = edit(within, {
      type: 'slide.effect.move',
      slideId: 'page',
      stepId: step.id,
      effectId: second.id,
      trigger: 'on-click',
      destination: { newStep: { beforeStepId: step.id } },
    });
    const [newStep, existing] = split.slides[0].steps!;
    expect(newStep.effects[0].id).toBe(second.id);
    expect(newStep.id).not.toBe(step.id);
    expect(existing.effects[0].trigger).toBe('on-click');
    split = setHold(split, 3, newStep.id);
    const joined = edit(split, {
      type: 'slide.effect.move',
      slideId: 'page',
      stepId: newStep.id,
      effectId: second.id,
      trigger: 'with-previous',
      destination: { stepId: step.id },
    });
    expect(joined.slides[0].steps!.map(({ id }) => id)).toEqual([step.id]);
    expect(joined.slides[0].steps![0].effects[1].id).toBe(second.id);
    expect(joined.exportSettings).toEqual(deck.exportSettings);
  });

  it('keeps defaults implicit, stores explicit state holds, and clears settings independently', () => {
    const original = deckWithObjects();
    const session = new EditorSession(original);
    for (const op of [
      { type: 'slide.transition.set', slideId: 'page', transition: { kind: 'none' } },
      { type: 'slide.export.pdf.page-mode', pageMode: 'final' },
      { type: 'slide.export.mp4.default-hold', holdSeconds: 1 },
      { type: 'slide.export.mp4.state-hold', slideId: 'page', holdSeconds: null },
    ] as const) {
      const command = slideMotionCommand(op);
      const prepared = prepareSlideMotionCommit(session.content, command);
      expect(prepared).toBeUndefined();
      if (prepared) session.execute(prepared);
    }
    expect(session.content).toEqual(original);
    expect(session.canUndo).toBe(false);

    let deck = setHold(original, 1);
    deck = edit(deck, { type: 'slide.export.mp4.default-hold', holdSeconds: 0.009 });
    deck = edit(deck, { type: 'slide.export.pdf.page-mode', pageMode: 'steps' });
    deck = edit(deck, {
      type: 'slide.transition.set',
      slideId: 'page',
      transition: { kind: 'push', direction: 'left', durationMs: 3000 },
    });
    expect(inspectSlideDeck(deck)).toMatchObject({ defaultHold: 9, pageMode: 'steps' });
    expect(inspectSlideDeck(deck).overrides.get('page')?.get(undefined)).toBe(1000);
    expect(slidePlaybackPages(deck)[0].transition).toBeUndefined();
    expect(deck.slides[0].transition?.kind).toBe('push');

    deck = edit(deck, { type: 'slide.export.mp4.default-hold', holdSeconds: null });
    expect(inspectSlideDeck(deck).defaultHold).toBe(1000);
    deck = setHold(deck, null);
    deck = edit(deck, { type: 'slide.export.pdf.page-mode', pageMode: null });
    deck = edit(deck, {
      type: 'slide.transition.set',
      slideId: 'page',
      transition: { kind: 'none' },
    });
    expect(deck.exportSettings).toBeUndefined();
    expect(deck.slides[0].transition).toBeUndefined();
    expect(deck.schemaVersion).toBe(3);
  });

  it('rejects malformed settings and keeps Redo when an edit fails', () => {
    const deck = insertStep(deckWithObjects(), fade('a'));
    const [step] = deck.slides[0].steps!;
    const session = new EditorSession(deck);
    session.execute(slideMotionCommand({ type: 'slide.export.pdf.page-mode', pageMode: 'steps' }));
    const future = session.content;
    session.undo();
    const before = session.revision;

    for (const [op, reason] of [
      [
        {
          type: 'slide.effect.insert',
          slideId: 'page',
          stepId: step.id,
          value: fade('a', 'after-previous'),
        },
        'repeated-target',
      ],
      [
        {
          type: 'slide.effect.insert',
          slideId: 'page',
          stepId: step.id,
          beforeEffectId: step.effects[0].id,
          value: fade('b'),
        },
        'invalid-trigger',
      ],
      [
        { type: 'slide.step.move', slideId: 'page', stepId: step.id, beforeStepId: step.id },
        'self-position',
      ],
      [
        {
          type: 'slide.transition.set',
          slideId: 'page',
          transition: { kind: 'fade', durationMs: 10, direction: 'up' },
        },
        'invalid-direction',
      ],
      [{ type: 'slide.export.mp4.default-hold', holdSeconds: 0.0001 }, 'invalid-hold'],
      [
        { type: 'slide.export.mp4.state-hold', slideId: 'page', stepId: 'missing', holdSeconds: 0 },
        'missing-step',
      ],
      [{ type: 'slide.export.pdf.page-mode', pageMode: 'final', clear: true }, 'invalid-setting'],
    ] as const) {
      expect(() => session.execute(slideMotionCommand(op as SlideMotionOperation))).toThrow(reason);
      expect(session.content).toEqual(deck);
      expect(session.revision).toEqual(before);
    }
    expect(
      prepareSlideMotionCommit(
        session.content,
        slideMotionCommand({
          type: 'slide.export.pdf.page-mode',
          pageMode: 'final',
        }),
      ),
    ).toBeUndefined();
    expect(session.redo()).toEqual(future);
  });
});

describe('atomic motion batches', () => {
  it('resolves earlier aliases and checks visibility after the final edit', () => {
    const deck = insertStep(insertStep(deckWithObjects(), fade('a')), {
      ...fade('a'),
      phase: 'exit',
    });
    const [enter, exit] = deck.slides[0].steps!;
    const session = new EditorSession(deck);
    // This operation temporarily produces two consecutive enters. The next edit
    // changes the new lead effect to an exit, restoring the valid sequence.
    const batch = slideMotionCommand({
      type: 'slide.motion.batch',
      operations: [
        {
          type: 'slide.step.insert',
          slideId: 'page',
          beforeStepId: exit.id,
          alias: 'step',
          effects: [{ alias: 'effect', value: fade('a') }],
        },
        {
          type: 'slide.effect.update',
          slideId: 'page',
          stepId: { alias: 'step' },
          effectId: { alias: 'effect' },
          value: { ...fade('a'), phase: 'exit' },
        },
        {
          type: 'slide.effect.update',
          slideId: 'page',
          stepId: exit.id,
          effectId: exit.effects[0].id,
          value: fade('a'),
        },
        {
          type: 'slide.transition.set',
          slideId: 'page',
          transition: { kind: 'fade', durationMs: 100 },
        },
      ],
    });
    const preview = batch.apply(deck);
    session.execute(batch);
    expect(session.content).toEqual(preview);
    expect(preview.slides[0].steps!.map(({ id }) => id)).toEqual([
      enter.id,
      preview.slides[0].steps![1].id,
      exit.id,
    ]);
    expect(session.undo()).toEqual(deck);
    expect(session.canUndo).toBe(false);
    expect(session.redo()).toEqual(preview);
  });

  it('rejects unsupported operations, unknown and duplicate aliases, and intermediate structural errors', () => {
    const deck = deckWithObjects();
    const insert = {
      type: 'slide.step.insert',
      slideId: 'page',
      alias: 'step',
      effects: [{ value: fade('a') }],
    } as const;
    for (const [operations, reason] of [
      [[], 'empty-batch'],
      [[{ type: 'slide.motion.batch', operations: [] }], 'unsupported-motion-operation'],
      [[{ type: 'slide.export.pdf.page-mode', pageMode: 'steps' }], 'unsupported-motion-operation'],
      [
        [{ type: 'slide.step.delete', slideId: 'page', stepId: { alias: 'step' } }, insert],
        'unknown-alias',
      ],
      [[insert, insert], 'duplicate-alias'],
      [
        [
          insert,
          {
            type: 'slide.effect.insert',
            slideId: 'page',
            stepId: { alias: 'step' },
            value: fade('a', 'after-previous'),
          },
        ],
        'repeated-target',
      ],
      [
        [insert, { type: 'slide.step.insert', slideId: 'page', effects: [{ value: fade('a') }] }],
        'invalid-visibility',
      ],
    ] as const) {
      const session = new EditorSession(deck);
      expect(() =>
        session.execute(
          slideMotionCommand({
            type: 'slide.motion.batch',
            operations,
          } as unknown as SlideMotionOperation),
        ),
      ).toThrow(reason);
      expect(session.content).toEqual(deck);
      expect(session.canUndo).toBe(false);
    }
  });

  it('applies count limits to the final candidate and preserves a no-op batch as legacy', () => {
    const deck = deckWithObjects();
    const page = deck.slides[0];
    const operations = Array.from({ length: 101 }, (_, i) => ({
      type: 'slide.step.insert' as const,
      slideId: page.id,
      alias: `step${i}`,
      effects: [{ value: { ...fade('a'), phase: 'emphasis', effect: 'zoom' } as const }],
    }));
    expect(() => edit(deck, { type: 'slide.motion.batch', operations })).toThrow('too-many-steps');
    expect(
      edit(deck, {
        type: 'slide.motion.batch',
        operations: [
          ...operations,
          { type: 'slide.step.delete', slideId: page.id, stepId: { alias: 'step100' } },
        ],
      }).slides[0].steps,
    ).toHaveLength(100);
    const noChange = slideMotionCommand({
      type: 'slide.motion.batch',
      operations: operations.flatMap((op) => [
        op,
        { type: 'slide.step.delete', slideId: page.id, stepId: { alias: op.alias } } as const,
      ]),
    });
    expect(noChange.apply(deck)).toBe(deck);
  });
});

describe('motion-aware deletion and duplication', () => {
  it.each(['direct', 'arrange'] as const)(
    'removes grouped children and affected holds via %s deletion',
    (entry) => {
      const before = deckWithObjects();
      const page = before.slides[0];
      page.objects.push({ ...makeSlideObject('group', 0), id: 'group' });
      page.objects[0].groupId = page.objects[2].groupId = 'group';
      let deck = insertStep(before, fade('a'), fade('b', 'after-previous'));
      deck = insertStep(deck, fade('c'));
      const [kept, removed] = deck.slides[0].steps!;
      deck = setHold(setHold(deck, 2, kept.id), 3, removed.id);
      const session = new EditorSession(deck);
      const command =
        entry === 'direct'
          ? deleteObjects('page', ['group'])
          : arrangeObjects('page', ['group'], 'delete');
      session.execute(command);
      expect(session.content.slides[0].objects.map(({ id }) => id)).toEqual(['b']);
      expect(session.content.slides[0].steps).toMatchObject([
        { id: kept.id, effects: [{ targetId: 'b', trigger: 'on-click' }] },
      ]);
      expect(session.content.exportSettings?.mp4?.holds).toEqual([
        { slideId: 'page', stepId: kept.id, holdSeconds: 2 },
      ]);
      expect(session.undo()).toEqual(deck);
    },
  );

  it('remaps whole-page duplicates, preserves original object effects, and cleans up deleted page holds', () => {
    let deck = insertStep(addSlide().apply(deckWithObjects()), fade('a'));
    const [step] = deck.slides[0].steps!;
    deck = setHold(setHold(deck, 0), 2, step.id);
    deck = edit(deck, {
      type: 'slide.transition.set',
      slideId: 'page',
      transition: { kind: 'fade', durationMs: 700 },
    });
    const duplicate = duplicateSlide('page');
    const copied = duplicate.apply(deck);
    const [original, page] = copied.slides;
    const [copyStep] = page.steps!;
    expect(duplicate.apply(deck)).toEqual(copied);
    expect(page.transition).toEqual(original.transition);
    expect(copyStep.id).not.toBe(step.id);
    expect(copyStep.effects[0].id).not.toBe(step.effects[0].id);
    expect(copyStep.effects[0].targetId).toBe(page.objects[0].id);
    const holds = inspectSlideDeck(copied).overrides;
    expect(holds.get(page.id)?.get(undefined)).toBe(0);
    expect(holds.get(page.id)?.get(copyStep.id)).toBe(2000);
    const objectsOnly = arrangeObjects('page', ['a'], 'duplicate').apply(deck);
    expect(objectsOnly.slides[0].objects).toHaveLength(4);
    expect(objectsOnly.slides[0].steps).toEqual(original.steps);
    const session = new EditorSession(copied);
    session.execute(deleteSlide(page.id));
    expect(session.content).toEqual(deck);
    expect(session.undo()).toEqual(copied);
  });

  it('refuses stale targets and corrupted inputs atomically', () => {
    const deck = insertStep(deckWithObjects(), fade('a'));
    expect(() => deleteObjects('page', ['missing']).apply(deck)).toThrow('missing-target');
    expect(() => arrangeObjects('page', ['missing'], 'duplicate').apply(deck)).toThrow(
      'missing-target',
    );
    expect(() => duplicateSlide('missing').apply(deck)).toThrow('missing-slide');
    expect(() => duplicateSlide('page', 'a').apply(deck)).toThrow('Slide ID already exists');
    const broken = structuredClone(deck);
    broken.slides[0].steps![0].effects[0].targetId = 'missing';
    expect(() => deleteSlide('page').apply(broken)).toThrow('missing-target');
  });
});

describe('shared motion sampling', () => {
  it('samples initial, partial and completed states and honors authored hidden objects', () => {
    const original = deckWithObjects();
    original.slides[0].objects[2].hidden = true;
    let deck = insertStep(
      original,
      { ...fade('a'), delayMs: 100, durationMs: 900 },
      { ...fade('b', 'with-previous'), phase: 'emphasis', effect: 'zoom', delayMs: 50 },
      {
        ...fade('c', 'after-previous'),
        phase: 'exit',
        effect: 'slide-out',
        direction: 'down',
        delayMs: 100,
        durationMs: 200,
      },
    );
    deck = insertStep(deck, {
      ...fade('a'),
      phase: 'exit',
      effect: 'slide-out',
      direction: 'left',
    });
    const page = deck.slides[0];
    expect(slideStepTiming(page.steps![0])).toMatchObject({
      durationMs: 1000,
      effects: [
        { startMs: 100, endMs: 1000 },
        { startMs: 150, endMs: 250 },
        { startMs: 350, endMs: 550 },
      ],
    });
    expect(slideMotionState(deck, page, 0).get('a')?.visible).toBe(false);
    expect(slideMotionState(deck, page, 1, 99).get('a')?.visible).toBe(false);
    expect(slideMotionState(deck, page, 1, 200).get('b')?.scale).toBeCloseTo(1.2);
    const intermediate = slideMotionState(deck, page, 1, 550);
    expect(intermediate.get('a')).toMatchObject({ visible: true, opacity: 0.5 });
    expect(intermediate.get('c')?.visible).toBe(false);
    expect(slideMotionState(deck, page, 1).get('a')).toMatchObject({ visible: true, opacity: 1 });
    const { x, width } = page.objects[0].bounds;
    expect(slideMotionState(deck, page, 2, 50).get('a')).toMatchObject({
      visible: true,
      offsetX: -(x + width) / 2,
    });
    expect(slideMotionState(deck, page, 2).get('a')?.visible).toBe(false);
  });
});
