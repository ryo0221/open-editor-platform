import {
  defaultSlideHoldSeconds,
  slideMotionState,
  slidePlaybackPages,
  slideStepTiming,
  type Slide,
  type SlideContent,
  type SlideExportSettings,
  type SlidePdfPageMode,
  type SlideTransition,
} from './model';
import { holdMilliseconds } from './motion-format';

export const slidePdfMaxPages = 500;
export const slideMp4Limits = {
  fps: 30,
  width: 1920,
  height: 1080,
  frames: 18_000,
  bytes: 2 ** 30,
};

export type ExportPose = { page: Slide; step: number; elapsedMs?: number };
export const lastSlideStep = (page: Slide) => page.steps?.length ?? 0;

export function slidePdfPageCount(deck: SlideContent, mode: SlidePdfPageMode) {
  return slidePlaybackPages(deck).reduce(
    (total, { page }) => total + 1 + (mode === 'steps' ? lastSlideStep(page) : 0),
    0,
  );
}

export function slidePdfPoses(deck: SlideContent, mode: SlidePdfPageMode): ExportPose[] {
  const count = slidePdfPageCount(deck, mode);
  if (count < 1 || count > slidePdfMaxPages)
    throw Error('PDF は展開後 1〜500 ページの範囲で書き出せます。');
  return slidePlaybackPages(deck).flatMap(({ page }) => {
    const last = lastSlideStep(page);
    return mode === 'final'
      ? [{ page, step: last }]
      : Array.from({ length: last + 1 }, (_, step) => ({ page, step }));
  });
}

export function visiblePoseObjects(deck: SlideContent, pose: ExportPose) {
  const state = slideMotionState(deck, pose.page, pose.step, pose.elapsedMs);
  return pose.page.objects.filter((object) => state.get(object.id)?.visible);
}

type ActiveTransition = Exclude<SlideTransition, { kind: 'none' }>;
type VideoSegment = {
  pose: ExportPose;
  endMs: number;
} & (
  | { kind: 'hold' | 'step' }
  | { kind: 'transition'; from: ExportPose; transition: ActiveTransition }
);

export function planSlideMp4(deck: SlideContent, settings: SlideExportSettings['mp4']) {
  const defaultMs = holdMilliseconds(
    settings?.defaultHoldSeconds ?? defaultSlideHoldSeconds,
    'exportSettings.mp4.defaultHoldSeconds',
  );
  const holds = new Map<string, Map<string | undefined, number>>();
  for (const { slideId, stepId, holdSeconds } of settings?.holds ?? []) {
    const page = holds.get(slideId) ?? new Map();
    page.set(stepId, holdMilliseconds(holdSeconds, 'exportSettings.mp4.holds'));
    holds.set(slideId, page);
  }

  const segments: VideoSegment[] = [];
  let durationMs = 0;
  let previous: ExportPose | undefined;
  for (const { page, transition } of slidePlaybackPages(deck)) {
    const initial = { page, step: 0 };
    if (previous && transition && transition.kind !== 'none') {
      durationMs += transition.durationMs;
      segments.push({
        kind: 'transition',
        pose: initial,
        from: previous,
        transition,
        endMs: durationMs,
      });
    }
    const addHold = (pose: ExportPose, stepId?: string) => {
      const hold = holds.get(page.id)?.get(stepId) ?? defaultMs;
      if (!hold) return;
      durationMs += hold;
      segments.push({ kind: 'hold', pose, endMs: durationMs });
    };
    addHold(initial);
    for (const [index, step] of (page.steps ?? []).entries()) {
      const pose = { page, step: index + 1 };
      durationMs += slideStepTiming(step).durationMs;
      segments.push({ kind: 'step', pose, endMs: durationMs });
      addHold(pose, step.id);
    }
    previous = { page, step: lastSlideStep(page) };
  }

  const { fps, width: maxWidth, height: maxHeight } = slideMp4Limits;
  const scale = Math.min(1, maxWidth / deck.width, maxHeight / deck.height);
  const even = (value: number, max: number) => Math.floor(Math.min(value, max) / 2 + 1e-9) * 2;
  return {
    segments,
    durationMs,
    frames: Math.ceil((durationMs * fps) / 1000),
    width: even(deck.width * scale, maxWidth),
    height: even(deck.height * scale, maxHeight),
  };
}
export type SlideMp4Plan = ReturnType<typeof planSlideMp4>;

/** Each target's visibility changes at most once within a step. The first and last sampled
 * poses therefore identify all the objects drawn during the interval. */
export function sampledVideoPoses(plan: SlideMp4Plan): ExportPose[] {
  const { fps } = slideMp4Limits;
  let startMs = 0;
  return plan.segments.flatMap((segment) => {
    const start = startMs;
    startMs = segment.endMs;
    const first = Math.ceil((start * fps) / 1000);
    const last = Math.ceil((segment.endMs * fps) / 1000) - 1;
    if (first > last) return [];
    if (segment.kind === 'transition') return [segment.from, segment.pose];
    if (segment.kind === 'hold') return [segment.pose];
    return [...new Set([first, last])].map((frame) => ({
      ...segment.pose,
      elapsedMs: (frame * 1000 - start * fps) / fps,
    }));
  });
}

export function slideMp4Refusal({ frames, width, height }: SlideMp4Plan) {
  if (frames < 1 || frames > slideMp4Limits.frames)
    return 'MP4 は 1〜18,000 フレームの範囲で書き出せます。';
  if (width < 2 || height < 2)
    return '縦横比を保って偶数ピクセルに収められないため、MP4 を書き出せません。';
  return undefined;
}

/** Sample on one continuous 30 fps clock, without rounding each segment separately. */
export function slideMp4Frame(plan: SlideMp4Plan, frame: number) {
  const tick = frame * 1000;
  const { fps } = slideMp4Limits;
  let left = 0;
  let right = plan.segments.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (tick < plan.segments[middle].endMs * fps) right = middle;
    else left = middle + 1;
  }
  const segment = plan.segments[left];
  if (!segment) throw Error('MP4 frame is outside the timeline.');
  const startMs = plan.segments[left - 1]?.endMs ?? 0;
  return { segment, elapsedMs: (tick - startMs * fps) / fps };
}
