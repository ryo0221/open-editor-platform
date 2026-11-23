import { canonicalEqual, clone, newId } from '@editor-platform/artifact-core';
import { immutableCommand, type EditorCommand } from '@editor-platform/editor-core';
import { inspectSlideDeck, validateSlideEdit, type Slide, type SlideContent } from './model';
import {
  defaultSlideHoldSeconds,
  defaultSlidePdfPageMode,
  type SlideEffect,
  type SlideEffectTrigger,
  type SlideEffectValue,
  type SlideFollowingTrigger,
  type SlidePdfPageMode,
  type SlideStep,
  type SlideTransition,
} from './motion';
import {
  assertEffectValue,
  assertTransition,
  holdMilliseconds,
  inspectSlideStep,
  isFollowingTrigger,
  maxSlideMotionInputBytes,
  rejectSlide,
  slideList,
  slideRecord,
  slideSetting,
} from './motion-format';
import {
  promoteFirstEffect,
  replaceSlidePage,
  replaceSlideSteps,
  withSlideExportSettings,
  withSlideHolds,
  withSlideMp4Settings,
} from './motion-edits';

type MotionReference = string | { alias: string };
type PageOperation = { slideId: string };
type StepOperation = PageOperation & { stepId: MotionReference };
type EffectOperation = StepOperation & { effectId: MotionReference };
type InsertsEffect = {
  beforeEffectId?: MotionReference;
  previousFirstTrigger?: SlideFollowingTrigger;
};
type MoveDestination =
  | ({ stepId: MotionReference } & InsertsEffect)
  | { newStep: { beforeStepId?: MotionReference; alias?: string } };

export type SlideProposableMotionOperation =
  | (PageOperation & {
      type: 'slide.step.insert';
      beforeStepId?: MotionReference;
      alias?: string;
      effects: { value: SlideEffectValue; alias?: string }[];
    })
  | (StepOperation & { type: 'slide.step.delete' })
  | (StepOperation & { type: 'slide.step.move'; beforeStepId?: MotionReference })
  | (StepOperation &
      InsertsEffect & {
        type: 'slide.effect.insert';
        value: SlideEffectValue;
        alias?: string;
      })
  | (EffectOperation & { type: 'slide.effect.update'; value: SlideEffectValue })
  | (EffectOperation & { type: 'slide.effect.delete' })
  | (EffectOperation & {
      type: 'slide.effect.move';
      destination: MoveDestination;
      trigger: SlideEffectTrigger;
    })
  | (PageOperation & { type: 'slide.transition.set'; transition: SlideTransition });

export type SlideMotionOperation =
  | SlideProposableMotionOperation
  | { type: 'slide.motion.batch'; operations: SlideProposableMotionOperation[] }
  | { type: 'slide.export.mp4.default-hold'; holdSeconds: number | null }
  | (PageOperation & {
      type: 'slide.export.mp4.state-hold';
      stepId?: string;
      holdSeconds: number | null;
    })
  | { type: 'slide.export.pdf.page-mode'; pageMode: SlidePdfPageMode | null };

type Apply = (deck: SlideContent) => SlideContent;
type EditSteps = (steps: SlideStep[], page: Slide) => SlideStep[];

function indexOf(items: readonly { id: string }[], id: string, kind: 'step' | 'effect') {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) rejectSlide(`missing-${kind}`, id);
  return index;
}

function beforeIndex(
  items: readonly { id: string }[],
  beforeId: string | undefined,
  kind: 'step' | 'effect',
) {
  return beforeId === undefined ? items.length : indexOf(items, beforeId, kind);
}

function requireId(value: unknown, path: string): string {
  if (typeof value !== 'string') rejectSlide('invalid-id', path);
  return value;
}

function requirePage(deck: SlideContent, slideId: string): Slide {
  return deck.slides.find((page) => page.id === slideId) ?? rejectSlide('missing-slide', slideId);
}

function editSteps(slideId: string, edit: EditSteps): Apply {
  return (deck) => {
    const page = requirePage(deck, slideId);
    const previous = page.steps ?? [];
    const steps = edit(previous, page);
    if (canonicalEqual(previous, steps)) return deck;

    // Structural rules hold between operations. Visibility and total limits
    // are checked after all the operations have produced their candidate.
    const unchanged = new Set(previous);
    const targets = new Map(page.objects.map((object) => [object.id, object]));
    for (const step of steps) {
      if (!unchanged.has(step)) inspectSlideStep(step, targets, new Set(), `${slideId}/${step.id}`);
    }
    return replaceSlideSteps(deck, page, steps);
  };
}

function editOneStep(steps: SlideStep[], index: number, effects: SlideEffect[]) {
  const next = [...steps];
  next.splice(index, 1, ...(effects.length ? [{ ...steps[index], effects }] : []));
  return next;
}

function insertEffect(
  effects: SlideEffect[],
  value: SlideEffect,
  beforeId: string | undefined,
  previousFirstTrigger: SlideFollowingTrigger | undefined,
): SlideEffect[] {
  const index = beforeIndex(effects, beforeId, 'effect');
  const next = [...effects];
  if (index === 0 && next.length) {
    if (!previousFirstTrigger) rejectSlide('invalid-trigger', value.id);
    next[0] = { ...next[0], trigger: previousFirstTrigger };
  } else if (previousFirstTrigger) rejectSlide('invalid-trigger', value.id);
  next.splice(index, 0, value);
  return next;
}

function removeEffect(effects: SlideEffect[], index: number): SlideEffect[] {
  return promoteFirstEffect(effects.filter((_, i) => i !== index));
}

const motionKeys = {
  'slide.step.insert': 'beforeStepId alias effects',
  'slide.step.delete': 'stepId',
  'slide.step.move': 'stepId beforeStepId',
  'slide.effect.insert': 'stepId beforeEffectId previousFirstTrigger alias value',
  'slide.effect.update': 'stepId effectId value',
  'slide.effect.delete': 'stepId effectId',
  'slide.effect.move': 'stepId effectId trigger destination',
  'slide.transition.set': 'transition',
} satisfies Record<SlideProposableMotionOperation['type'], string>;

function prepareMotion(
  input: unknown,
  inBatch: boolean,
  reserved: Set<string>,
  aliases: Map<string, string>,
): Apply {
  const type = slideRecord(input, 'operation').type;
  if (typeof type !== 'string' || !Object.hasOwn(motionKeys, type))
    rejectSlide('unsupported-motion-operation', 'operation');
  const kind = type as keyof typeof motionKeys;
  const op = slideSetting(input, `type slideId ${motionKeys[kind]}`, kind);
  const slideId = requireId(op.slideId, kind + '.slideId');

  const reference = (value: unknown, path: string) => {
    if (typeof value === 'string') return value;
    if (!inBatch) rejectSlide('invalid-id', path);
    const { alias } = slideSetting(value, 'alias', path);
    if (typeof alias !== 'string' || !aliases.has(alias)) rejectSlide('unknown-alias', path);
    return aliases.get(alias)!;
  };
  const position = (value: unknown, path: string) =>
    value === undefined ? undefined : reference(value, path);
  const reserve = (prefix: 'step' | 'effect', alias: unknown) => {
    const id = newId(prefix);
    if (reserved.has(id)) rejectSlide('duplicate-id', id);
    reserved.add(id);
    if (alias !== undefined) {
      if (!inBatch || typeof alias !== 'string' || !alias.length)
        rejectSlide('invalid-alias', kind);
      if (aliases.has(alias)) rejectSlide('duplicate-alias', alias);
      aliases.set(alias, id);
    }
    return id;
  };
  const placement = (values: Record<string, unknown>) => {
    const beforeId = position(values.beforeEffectId, kind + '.beforeEffectId');
    const previous = values.previousFirstTrigger;
    if (previous !== undefined && !isFollowingTrigger(previous))
      rejectSlide('invalid-trigger', kind + '.previousFirstTrigger');
    return { beforeId, previous };
  };

  if (kind === 'slide.transition.set') {
    assertTransition(op.transition, kind);
    const transition = clone(op.transition);
    return (deck) => {
      const page = requirePage(deck, slideId);
      if (transition.kind !== 'none') {
        if (canonicalEqual(page.transition, transition)) return deck;
        return replaceSlidePage(deck, { ...page, transition: clone(transition) });
      }
      if (page.transition === undefined) return deck;
      const { transition: _removed, ...rest } = page;
      return replaceSlidePage(deck, rest);
    };
  }

  if (kind === 'slide.step.insert') {
    const beforeId = position(op.beforeStepId, kind + '.beforeStepId');
    const id = reserve('step', op.alias);
    const effects = slideList(op.effects, kind + '.effects').map((entry, i) => {
      const path = `${kind}.effects[${i}]`;
      const { value, alias } = slideSetting(entry, 'value alias', path);
      assertEffectValue(value, path);
      return { ...value, id: reserve('effect', alias) };
    });
    return editSteps(slideId, (steps) => {
      const next = [...steps];
      next.splice(beforeIndex(steps, beforeId, 'step'), 0, { id, effects: clone(effects) });
      return next;
    });
  }

  const stepId = reference(op.stepId, kind + '.stepId');
  if (kind === 'slide.step.delete')
    return editSteps(slideId, (steps) => {
      const next = [...steps];
      next.splice(indexOfStep(steps, stepId), 1);
      return next;
    });

  if (kind === 'slide.step.move') {
    const beforeId = position(op.beforeStepId, kind + '.beforeStepId');
    if (beforeId === stepId) rejectSlide('self-position', stepId);
    return editSteps(slideId, (steps) => {
      const next = [...steps];
      const [step] = next.splice(indexOfStep(next, stepId), 1);
      next.splice(beforeIndex(next, beforeId, 'step'), 0, step);
      return next;
    });
  }

  if (kind === 'slide.effect.insert') {
    const { beforeId, previous } = placement(op);
    const { value } = op;
    assertEffectValue(value, kind);
    const effect = { ...value, id: reserve('effect', op.alias) };
    return editSteps(slideId, (steps) => {
      const step = indexOfStep(steps, stepId);
      return editOneStep(
        steps,
        step,
        insertEffect(steps[step].effects, { ...effect }, beforeId, previous),
      );
    });
  }

  const effectId = reference(op.effectId, kind + '.effectId');
  if (kind === 'slide.effect.move') {
    const { trigger, destination } = op;
    if (trigger !== 'on-click' && !isFollowingTrigger(trigger))
      rejectSlide('invalid-trigger', kind);
    const target = slideRecord(destination, kind + '.destination');
    if ('newStep' in target) {
      slideSetting(target, 'newStep', kind + '.destination');
      const newStep = slideSetting(target.newStep, 'beforeStepId alias', kind + '.newStep');
      const beforeId = position(newStep.beforeStepId, kind + '.newStep.beforeStepId');
      const id = reserve('step', newStep.alias);
      return editSteps(slideId, (steps) => {
        const source = indexOfStep(steps, stepId);
        const effects = steps[source].effects;
        const index = indexOf(effects, effectId, 'effect');
        const next = [...steps];
        const before = beforeIndex(next, beforeId, 'step');
        next.splice(before, 0, { id, effects: [{ ...effects[index], trigger }] });
        return editOneStep(next, source + Number(before <= source), removeEffect(effects, index));
      });
    }
    slideSetting(target, 'stepId beforeEffectId previousFirstTrigger', kind + '.destination');
    const targetId = reference(target.stepId, kind + '.destination.stepId');
    const { beforeId, previous } = placement(target);
    if (beforeId === effectId) rejectSlide('self-position', effectId);
    return editSteps(slideId, (steps) => {
      const source = indexOfStep(steps, stepId);
      const destination = indexOfStep(steps, targetId);
      const effects = steps[source].effects;
      const index = indexOf(effects, effectId, 'effect');
      const remaining = removeEffect(effects, index);
      const targetEffects = source === destination ? remaining : steps[destination].effects;
      const inserted = insertEffect(
        targetEffects,
        { ...effects[index], trigger },
        beforeId,
        previous,
      );
      const next = editOneStep(steps, destination, inserted);
      return source === destination ? next : editOneStep(next, source, remaining);
    });
  }

  if (kind === 'slide.effect.update') {
    const { value } = op;
    assertEffectValue(value, kind);
    const effect = { ...value, id: effectId };
    return editSteps(slideId, (steps) => {
      const step = indexOfStep(steps, stepId);
      const effects = [...steps[step].effects];
      effects[indexOf(effects, effectId, 'effect')] = { ...effect };
      return editOneStep(steps, step, effects);
    });
  }

  return editSteps(slideId, (steps) => {
    const step = indexOfStep(steps, stepId);
    const effects = steps[step].effects;
    return editOneStep(steps, step, removeEffect(effects, indexOf(effects, effectId, 'effect')));
  });
}

function indexOfStep(steps: SlideStep[], id: string) {
  return indexOf(steps, id, 'step');
}

function prepareExport(input: unknown, kind: string): Apply {
  if (kind === 'slide.export.pdf.page-mode') {
    const { pageMode } = slideSetting(input, 'type pageMode', kind);
    if (pageMode !== null && pageMode !== 'final' && pageMode !== 'steps')
      rejectSlide('invalid-page-mode', kind);
    return (deck) => {
      const { pdf, ...settings } = deck.exportSettings ?? {};
      if (pageMode === null) return pdf ? withSlideExportSettings(deck, settings) : deck;
      if (pageMode === (pdf?.pageMode ?? defaultSlidePdfPageMode)) return deck;
      return withSlideExportSettings(deck, { ...settings, pdf: { pageMode } });
    };
  }
  if (kind === 'slide.export.mp4.default-hold') {
    const { holdSeconds } = slideSetting(input, 'type holdSeconds', kind);
    if (holdSeconds !== null) holdMilliseconds(holdSeconds, kind);
    return (deck) => {
      const { defaultHoldSeconds: before, ...mp4 } = deck.exportSettings?.mp4 ?? {};
      if (holdSeconds === null)
        return before === undefined ? deck : withSlideMp4Settings(deck, mp4);
      if (holdSeconds === (before ?? defaultSlideHoldSeconds)) return deck;
      return withSlideMp4Settings(deck, { ...mp4, defaultHoldSeconds: holdSeconds as number });
    };
  }
  const {
    slideId: rawSlide,
    stepId: rawStep,
    holdSeconds,
  } = slideSetting(input, 'type slideId stepId holdSeconds', kind);
  const slideId = requireId(rawSlide, kind + '.slideId');
  const stepId = rawStep === undefined ? undefined : requireId(rawStep, kind + '.stepId');
  if (holdSeconds !== null) holdMilliseconds(holdSeconds, kind);
  return (deck) => {
    const page = requirePage(deck, slideId);
    if (stepId !== undefined) indexOfStep(page.steps ?? [], stepId);
    const holds = [...(deck.exportSettings?.mp4?.holds ?? [])];
    const index = holds.findIndex((hold) => hold.slideId === slideId && hold.stepId === stepId);
    if (holdSeconds === null) {
      if (index === -1) return deck;
      holds.splice(index, 1);
    } else {
      if (holds[index]?.holdSeconds === holdSeconds) return deck;
      const hold = {
        slideId,
        ...(stepId === undefined ? {} : { stepId }),
        holdSeconds: holdSeconds as number,
      };
      holds.splice(index === -1 ? holds.length : index, Number(index !== -1), hold);
    }
    return withSlideHolds(deck, holds);
  };
}

function sameMotion(before: SlideContent, after: SlideContent) {
  return (
    canonicalEqual(before.exportSettings, after.exportSettings) &&
    before.slides.every((page, i) => {
      const candidate = after.slides[i];
      return (
        page === candidate ||
        (canonicalEqual(page.steps ?? [], candidate.steps ?? []) &&
          canonicalEqual(page.transition, candidate.transition))
      );
    })
  );
}

/** Converts one user edit or ordered batch into an atomic local command.
 * IDs are reserved while preparing the command, before preview or execution. */
export function slideMotionCommand(input: SlideMotionOperation): EditorCommand<SlideContent> {
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    rejectSlide('invalid-operation', 'operation');
  }
  if (typeof json !== 'string') rejectSlide('invalid-operation', 'operation');
  if (
    json.length > maxSlideMotionInputBytes ||
    new TextEncoder().encode(json).byteLength > maxSlideMotionInputBytes
  )
    rejectSlide('motion-input-size-limit', 'operation');

  const type = requireId(slideRecord(input, 'operation').type, 'operation.type');
  const reserved = new Set<string>();
  const aliases = new Map<string, string>();
  let edits: Apply[];
  if (type === 'slide.motion.batch') {
    const batch = slideSetting(input, 'type operations', type);
    const operations = slideList(batch.operations, type);
    if (!operations.length) rejectSlide('empty-batch', type);
    edits = Array.from(operations, (op) => prepareMotion(op, true, reserved, aliases));
  } else if (
    type === 'slide.export.mp4.default-hold' ||
    type === 'slide.export.mp4.state-hold' ||
    type === 'slide.export.pdf.page-mode'
  ) {
    edits = [prepareExport(input, type)];
  } else {
    edits = [prepareMotion(input, false, reserved, aliases)];
  }

  return immutableCommand(type, 'Edit slide motion and settings', (deck) => {
    inspectSlideDeck(deck);
    if (reserved.size)
      for (const page of deck.slides) {
        const ids = [
          page.id,
          ...page.objects.map((object) => object.id),
          ...(page.steps ?? []).flatMap((step) => [
            step.id,
            ...step.effects.map((effect) => effect.id),
          ]),
        ];
        for (const id of ids) if (reserved.has(id)) rejectSlide('duplicate-id', id);
      }
    const candidate = edits.reduce((next, edit) => edit(next), deck);
    if (sameMotion(deck, candidate)) return deck;
    return validateSlideEdit({ ...candidate, schemaVersion: 3 });
  });
}

/** Preflight the native command against the draft about to be committed.
 * A missing result leaves the draft revision and both history stacks alone. */
export function prepareSlideMotionCommit(
  deck: SlideContent,
  command: EditorCommand<SlideContent>,
): EditorCommand<SlideContent> | undefined {
  return command.apply(deck) === deck ? undefined : command;
}
