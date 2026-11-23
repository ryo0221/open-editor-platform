import type { Slide, SlideContent } from './model';
import {
  defaultSlideHoldSeconds,
  defaultSlidePdfPageMode,
  initiallyHiddenByMotion,
  slideMotionDirections,
  slideStepTiming,
  type SlideEffectValue,
  type SlideFollowingTrigger,
  type SlidePdfPageMode,
  type SlideStep,
  type SlideTransition,
} from './motion';

export const maxSlideMotionInputBytes = 128 * 1024 * 1024;
export const maxNativeSlideBytes = 64 * 1024 * 1024;

export function rejectSlide(reason: string, path: string): never {
  throw new Error(`${reason} at ${path}`);
}

export function slideRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    rejectSlide('invalid-setting', path);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) rejectSlide('invalid-setting', path);
  return value as Record<string, unknown>;
}

export function slideSetting(value: unknown, keys: string, path: string) {
  const record = slideRecord(value, path);
  const permitted = keys.split(' ');
  if (Object.keys(record).some((key) => !permitted.includes(key)))
    rejectSlide('invalid-setting', path);
  return record;
}

export function slideList(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) rejectSlide('invalid-list', path);
  return value;
}

function integerIn(value: unknown, min: number, max: number, reason: string, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    rejectSlide(reason, path);
  return value;
}

function checkId(value: unknown, prefix: 'step' | 'effect', taken: Set<string>, path: string) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    typeof value !== 'string' ||
    !value.startsWith(prefix + '_') ||
    !uuid.test(value.slice(prefix.length + 1))
  )
    rejectSlide('invalid-id', path);
  if (taken.has(value)) rejectSlide('duplicate-id', path);
  taken.add(value);
}

const phaseEffects = new Map<string, string[]>([
  ['enter', ['fade', 'slide-in', 'zoom']],
  ['exit', ['fade', 'slide-out', 'zoom']],
  ['emphasis', ['zoom']],
]);

function checkDirection(value: unknown, required: boolean, path: string) {
  if (
    required ? !slideMotionDirections.some((direction) => value === direction) : value !== undefined
  )
    rejectSlide('invalid-direction', path);
}

export const isFollowingTrigger = (value: unknown): value is SlideFollowingTrigger =>
  value === 'with-previous' || value === 'after-previous';

export function assertEffectValue(value: unknown, path: string): asserts value is SlideEffectValue {
  const effect = slideSetting(
    value,
    'targetId phase effect direction trigger delayMs durationMs',
    path,
  );
  if (typeof effect.targetId !== 'string') rejectSlide('missing-target', path);
  if (
    typeof effect.phase !== 'string' ||
    typeof effect.effect !== 'string' ||
    !phaseEffects.get(effect.phase)?.includes(effect.effect)
  )
    rejectSlide('invalid-effect', path);
  checkDirection(
    effect.direction,
    effect.effect === 'slide-in' || effect.effect === 'slide-out',
    path,
  );
  if (effect.trigger !== 'on-click' && !isFollowingTrigger(effect.trigger))
    rejectSlide('invalid-trigger', path);
  integerIn(effect.delayMs, 0, 10_000, 'invalid-delay', path);
  integerIn(effect.durationMs, 1, 10_000, 'invalid-duration', path);
}

export function assertTransition(value: unknown, path: string): asserts value is SlideTransition {
  const transition = slideSetting(value, 'kind durationMs direction', path);
  if (transition.kind === 'none') {
    slideSetting(transition, 'kind', path);
    return;
  }
  if (transition.kind !== 'fade' && transition.kind !== 'push')
    rejectSlide('invalid-transition', path);
  checkDirection(transition.direction, transition.kind === 'push', path);
  if (transition.kind === 'fade') slideSetting(transition, 'kind durationMs', path);
  integerIn(transition.durationMs, 1, 3000, 'invalid-duration', path);
}

export function holdMilliseconds(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 60)
    rejectSlide('invalid-hold', path);
  const milliseconds = Math.round(value * 1000);
  if (milliseconds / 1000 !== value) rejectSlide('invalid-hold', path);
  return milliseconds;
}

export function inspectSlideStep(
  step: unknown,
  targets: ReadonlyMap<string, Slide['objects'][number]>,
  taken: Set<string>,
  path: string,
  remainingEffects = Infinity,
): asserts step is SlideStep {
  const { id, effects } = slideSetting(step, 'id effects', path);
  checkId(id, 'step', taken, path);
  const list = slideList(effects, path + '.effects');
  if (!list.length) rejectSlide('empty-step', path);
  if (list.length > remainingEffects) rejectSlide('too-many-effects', path);
  const usedTargets = new Set<string>();
  for (const [i, entry] of list.entries()) {
    const effectPath = `${path}.effects[${i}]`;
    const { id, ...value } = slideSetting(
      entry,
      'id targetId phase effect direction trigger delayMs durationMs',
      effectPath,
    );
    checkId(id, 'effect', taken, effectPath);
    assertEffectValue(value, effectPath);
    const target = targets.get(value.targetId);
    if (!target) rejectSlide('missing-target', effectPath);
    if (target.type === 'group') rejectSlide('unsupported-target', effectPath);
    if (usedTargets.has(target.id)) rejectSlide('repeated-target', effectPath);
    usedTargets.add(target.id);
    if ((i === 0) !== (value.trigger === 'on-click')) rejectSlide('invalid-trigger', effectPath);
  }
}

export function inspectSlideMotion(deck: SlideContent) {
  const current = deck.schemaVersion === 3;
  if (
    !current &&
    ('exportSettings' in deck ||
      deck.slides.some((page) => 'steps' in page || 'transition' in page))
  )
    rejectSlide('old-version-with-settings', 'content');

  const taken = new Set(
    deck.slides.flatMap((page) => [page.id, ...page.objects.map((object) => object.id)]),
  );
  const pages = new Map<
    string,
    { hidden?: boolean; steps: Map<string, number>; transition: number }
  >();
  let deckCount = 0;
  for (const [i, page] of deck.slides.entries()) {
    const path = `slides[${i}]`;
    const steps = new Map<string, number>();
    if (page.transition !== undefined) assertTransition(page.transition, path + '.transition');
    const list = page.steps === undefined ? [] : slideList(page.steps, path + '.steps');
    if (list.length > 100) rejectSlide('too-many-steps', path);
    if (list.length) {
      const targets = new Map(page.objects.map((object) => [object.id, object]));
      const ordered: SlideStep[] = [];
      let pageCount = 0;
      for (const [j, step] of list.entries()) {
        inspectSlideStep(step, targets, taken, `${path}.steps[${j}]`, 100 - pageCount);
        pageCount += step.effects.length;
        ordered.push(step);
        steps.set(step.id, slideStepTiming(step).durationMs);
      }
      deckCount += pageCount;
      if (deckCount > 1000) rejectSlide('too-many-effects', 'slides');
      const hidden = initiallyHiddenByMotion(ordered);
      for (const [j, step] of ordered.entries())
        for (const [k, effect] of step.effects.entries()) {
          if ((effect.phase === 'enter') !== hidden.has(effect.targetId))
            rejectSlide('invalid-visibility', `${path}.steps[${j}].effects[${k}]`);
          if (effect.phase === 'exit') hidden.add(effect.targetId);
          else hidden.delete(effect.targetId);
        }
    }
    pages.set(page.id, {
      hidden: page.hidden,
      steps,
      transition:
        page.transition && page.transition.kind !== 'none' ? page.transition.durationMs : 0,
    });
  }

  const settings = slideSetting(
    deck.exportSettings === undefined ? {} : deck.exportSettings,
    'mp4 pdf',
    'exportSettings',
  );
  const mp4 = slideSetting(
    settings.mp4 === undefined ? {} : settings.mp4,
    'defaultHoldSeconds holds',
    'exportSettings.mp4',
  );
  const defaultHold = holdMilliseconds(
    mp4.defaultHoldSeconds === undefined ? defaultSlideHoldSeconds : mp4.defaultHoldSeconds,
    'exportSettings.mp4.defaultHoldSeconds',
  );
  const overrides = new Map<string, Map<string | undefined, number>>();
  const holds = mp4.holds === undefined ? [] : slideList(mp4.holds, 'exportSettings.mp4.holds');
  for (const [i, entry] of holds.entries()) {
    const path = `exportSettings.mp4.holds[${i}]`;
    const { slideId, stepId, holdSeconds } = slideSetting(
      entry,
      'slideId stepId holdSeconds',
      path,
    );
    if (typeof slideId !== 'string') rejectSlide('missing-slide', path);
    const page = pages.get(slideId);
    if (!page) rejectSlide('missing-slide', path);
    if (stepId !== undefined && (typeof stepId !== 'string' || !page.steps.has(stepId)))
      rejectSlide('missing-step', path);
    const pageHolds = overrides.get(slideId) ?? new Map<string | undefined, number>();
    if (pageHolds.has(stepId)) rejectSlide('duplicate-hold', path);
    pageHolds.set(stepId, holdMilliseconds(holdSeconds, path));
    overrides.set(slideId, pageHolds);
  }
  const pdf =
    settings.pdf === undefined
      ? { pageMode: defaultSlidePdfPageMode }
      : slideSetting(settings.pdf, 'pageMode', 'exportSettings.pdf');
  if (pdf.pageMode !== 'final' && pdf.pageMode !== 'steps')
    rejectSlide('invalid-page-mode', 'exportSettings.pdf');
  return { pages, defaultHold, overrides, pageMode: pdf.pageMode as SlidePdfPageMode };
}
