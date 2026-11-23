import { hierarchyPaintOrder, rotatedBounds } from '@editor-platform/editor-core';
import type { Slide, SlideContent, SlideObject } from './model';

export const slideMotionDirections = ['left', 'right', 'up', 'down'] as const;
export type SlideMotionDirection = (typeof slideMotionDirections)[number];
export type SlideFollowingTrigger = 'with-previous' | 'after-previous';
export type SlideEffectTrigger = 'on-click' | SlideFollowingTrigger;
export type SlideEffectPhase = 'enter' | 'exit' | 'emphasis';

export type SlideEffectValue = {
  targetId: string;
  trigger: SlideEffectTrigger;
  delayMs: number;
  durationMs: number;
} & (
  | { phase: 'enter' | 'exit'; effect: 'fade' | 'zoom'; direction?: never }
  | { phase: 'enter'; effect: 'slide-in'; direction: SlideMotionDirection }
  | { phase: 'exit'; effect: 'slide-out'; direction: SlideMotionDirection }
  | { phase: 'emphasis'; effect: 'zoom'; direction?: never }
);
export type SlideEffect = SlideEffectValue & { id: string };
export interface SlideStep {
  id: string;
  effects: SlideEffect[];
}
export type SlideTransition =
  | { kind: 'none' }
  | { kind: 'fade'; durationMs: number }
  | { kind: 'push'; durationMs: number; direction: SlideMotionDirection };

export interface SlideStateHold {
  slideId: string;
  stepId?: string;
  holdSeconds: number;
}
export type SlidePdfPageMode = 'final' | 'steps';
export interface SlideExportSettings {
  mp4?: { defaultHoldSeconds?: number; holds?: SlideStateHold[] };
  pdf?: { pageMode: SlidePdfPageMode };
}
export const defaultSlideHoldSeconds = 1;
export const defaultSlidePdfPageMode = 'final';

export function slideStepTiming(step: SlideStep) {
  let startMs = 0;
  let endMs = 0;
  let durationMs = 0;
  const effects = step.effects.map((effect) => {
    startMs = (effect.trigger === 'after-previous' ? endMs : startMs) + effect.delayMs;
    endMs = startMs + effect.durationMs;
    durationMs = Math.max(durationMs, endMs);
    return { effect, startMs, endMs };
  });
  return { effects, durationMs };
}

export function initiallyHiddenByMotion(steps: readonly SlideStep[]): Set<string> {
  const seen = new Set<string>();
  const hidden = new Set<string>();
  for (const step of steps)
    for (const effect of step.effects) {
      if (effect.phase === 'emphasis' || seen.has(effect.targetId)) continue;
      seen.add(effect.targetId);
      if (effect.phase === 'enter') hidden.add(effect.targetId);
    }
  return hidden;
}

export interface SlideObjectMotionState {
  visible: boolean;
  /** Multiplier for the object's authored opacity. */
  opacity: number;
  offsetX: number;
  offsetY: number;
  /** Scale about the center of the object's placement bounds. */
  scale: number;
}

const steadyState = (visible: boolean): SlideObjectMotionState => ({
  visible,
  opacity: 1,
  offsetX: 0,
  offsetY: 0,
  scale: 1,
});

/** Samples a single effect, including the pose immediately before an exit disappears. */
export function slideEffectPose(
  deck: Pick<SlideContent, 'width' | 'height'>,
  object: SlideObject,
  effect: SlideEffect,
  progress: number,
): SlideObjectMotionState {
  const state = steadyState(true);
  const amount = effect.phase === 'enter' ? progress : 1 - progress;
  if (effect.effect === 'fade') state.opacity = amount;
  else if (effect.effect === 'zoom') {
    state.scale = effect.phase === 'emphasis' ? 1 + 0.2 * (1 - Math.abs(2 * progress - 1)) : amount;
  } else {
    const { x, y, width, height } = rotatedBounds(object.bounds, object.rotation);
    const sign = effect.phase === 'enter' ? -1 : 1;
    const remaining = 1 - amount;
    switch (effect.direction) {
      case 'left':
        state.offsetX = -sign * remaining * Math.max(0, sign === 1 ? x + width : deck.width - x);
        break;
      case 'right':
        state.offsetX = sign * remaining * Math.max(0, sign === 1 ? deck.width - x : x + width);
        break;
      case 'up':
        state.offsetY = -sign * remaining * Math.max(0, sign === 1 ? y + height : deck.height - y);
        break;
      case 'down':
        state.offsetY = sign * remaining * Math.max(0, sign === 1 ? deck.height - y : y + height);
        break;
    }
  }
  return state;
}

/** Shared playback snapshot for a validated page. Step 0 is the initial pose,
 * and omitting elapsedMs samples the completed pose of the requested step. */
export function slideMotionState(
  deck: Pick<SlideContent, 'width' | 'height'>,
  page: Slide,
  stepNumber: number,
  elapsedMs = Infinity,
): ReadonlyMap<string, SlideObjectMotionState> {
  const steps = page.steps ?? [];
  if (!Number.isInteger(stepNumber) || stepNumber < 0 || stepNumber > steps.length)
    throw new Error('invalid-step-number');
  if (elapsedMs < 0 || (elapsedMs !== Infinity && !Number.isFinite(elapsedMs)))
    throw new Error('invalid-elapsed-time');

  const hidden = initiallyHiddenByMotion(steps);
  for (const step of steps.slice(0, Math.max(0, stepNumber - 1)))
    for (const effect of step.effects) {
      if (effect.phase === 'exit') hidden.add(effect.targetId);
      else hidden.delete(effect.targetId);
    }

  const current = stepNumber === 0 ? [] : slideStepTiming(steps[stepNumber - 1]).effects;
  const active = new Map(current.map((entry) => [entry.effect.targetId, entry]));
  return new Map(
    hierarchyPaintOrder(page.objects, (object) => object.groupId).map((object) => {
      const entry = active.get(object.id);
      let state = steadyState(!object.hidden && !hidden.has(object.id));
      if (!object.hidden && entry && elapsedMs >= entry.startMs) {
        state =
          elapsedMs >= entry.endMs
            ? steadyState(entry.effect.phase !== 'exit')
            : slideEffectPose(
                deck,
                object,
                entry.effect,
                (elapsedMs - entry.startMs) / entry.effect.durationMs,
              );
      }
      return [object.id, state];
    }),
  );
}

export function slidePlaybackPages(deck: SlideContent) {
  return deck.slides
    .filter((page) => !page.hidden)
    .map((page, index) => ({
      page,
      transition: index === 0 ? undefined : page.transition,
    }));
}

export function slideMotionTransform(object: SlideObject, pose: SlideObjectMotionState) {
  const { x, y, width, height } = object.bounds;
  const cx = x + width / 2;
  const cy = y + height / 2;
  return `translate(${pose.offsetX} ${pose.offsetY}) translate(${cx} ${cy}) scale(${pose.scale}) translate(${-cx} ${-cy})`;
}

export function slideTransitionLayers(
  { width, height }: Pick<SlideContent, 'width' | 'height'>,
  transition: SlideTransition | undefined,
  progress: number,
) {
  const push = transition?.kind === 'push' ? transition.direction : undefined;
  const dx = push === 'left' ? -width : push === 'right' ? width : 0;
  const dy = push === 'up' ? -height : push === 'down' ? height : 0;
  return {
    outgoing: { x: dx * progress, y: dy * progress, opacity: 1 },
    incoming: {
      x: dx * (progress - 1),
      y: dy * (progress - 1),
      opacity: transition?.kind === 'fade' ? progress : 1,
    },
  };
}
