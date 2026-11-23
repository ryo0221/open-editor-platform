import type { Slide, SlideContent } from './model';
import type { SlideEffect, SlideExportSettings, SlideStateHold, SlideStep } from './motion';

export function withSlideExportSettings(
  deck: SlideContent,
  settings: SlideExportSettings,
): SlideContent {
  if (settings.mp4 || settings.pdf) return { ...deck, exportSettings: settings };
  const { exportSettings: _removed, ...rest } = deck;
  return rest;
}

export function withSlideMp4Settings(
  deck: SlideContent,
  mp4: NonNullable<SlideExportSettings['mp4']>,
): SlideContent {
  const { mp4: _removed, ...settings } = deck.exportSettings ?? {};
  return withSlideExportSettings(
    deck,
    mp4.defaultHoldSeconds !== undefined || mp4.holds?.length ? { ...settings, mp4 } : settings,
  );
}

export function withSlideHolds(deck: SlideContent, holds: SlideStateHold[]): SlideContent {
  const { holds: _removed, ...mp4 } = deck.exportSettings?.mp4 ?? {};
  return withSlideMp4Settings(deck, holds.length ? { ...mp4, holds } : mp4);
}

export function removeSlideHolds(
  deck: SlideContent,
  remove: (hold: SlideStateHold) => boolean,
): SlideContent {
  const holds = deck.exportSettings?.mp4?.holds;
  if (!holds?.length) return deck;
  const remaining = holds.filter((hold) => !remove(hold));
  return remaining.length === holds.length ? deck : withSlideHolds(deck, remaining);
}

export function replaceSlidePage(deck: SlideContent, page: Slide): SlideContent {
  return {
    ...deck,
    slides: deck.slides.map((existing) => (existing.id === page.id ? page : existing)),
  };
}

export function replaceSlideSteps(
  deck: SlideContent,
  page: Slide,
  steps: SlideStep[],
): SlideContent {
  const { steps: original, ...rest } = page;
  const retained = new Set(steps.map(({ id }) => id));
  const removed = new Set(original?.filter(({ id }) => !retained.has(id)).map(({ id }) => id));
  return removeSlideHolds(
    replaceSlidePage(deck, steps.length || original?.length === 0 ? { ...rest, steps } : rest),
    (hold) => hold.slideId === page.id && hold.stepId !== undefined && removed.has(hold.stepId),
  );
}

export function promoteFirstEffect(effects: SlideEffect[]): SlideEffect[] {
  const [first, ...rest] = effects;
  return first && first.trigger !== 'on-click'
    ? [{ ...first, trigger: 'on-click' }, ...rest]
    : effects;
}
